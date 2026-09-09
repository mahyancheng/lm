/**
 * @frontier/contracts — modifiers.ts
 *
 * World modifiers are the *only* mechanism by which the World Director LLM can
 * change reality. A modifier is a bounded, decaying, time-limited arithmetic
 * operation on a registered target path.
 *
 * Two shapes exist and the distinction matters:
 *
 * - `WorldModifierProposalSchema` — what the LLM produces. It contains only the
 *   fields a model can reasonably decide: target, operation, value, decay and
 *   duration. It is LLM-facing (all fields required, no records, no transforms).
 * - `WorldModifierSchema` — what the engine stores after validation. It adds the
 *   fields only the engine may assign: id, source, the quarter it was applied
 *   and how many quarters remain.
 *
 * If you are writing prompt code, use the proposal schema. If you are writing
 * engine or persistence code, use the full schema.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import { TargetOperationSchema, WORLD_TARGET_PATH_LIST } from './world';

export { TargetOperationSchema as ModifierOperationSchema, TARGET_OPERATIONS as MODIFIER_OPERATIONS } from './world';
export type { TargetOperation as ModifierOperation } from './world';

/* -------------------------------------------------------------------------- */
/*  Decay                                                                      */
/* -------------------------------------------------------------------------- */

export const MODIFIER_DECAY_MODES = ['none', 'linear', 'exponential'] as const;

export const ModifierDecaySchema = z
  .enum(MODIFIER_DECAY_MODES)
  .describe(
    'How the modifier fades. "none" holds full strength for its whole duration then vanishes (use for step changes such as a new rule). "linear" fades evenly to zero across durationQuarters (use for supply shocks). "exponential" hits hardest immediately then decays quickly (use for sentiment and panic).',
  );
export type ModifierDecay = z.infer<typeof ModifierDecaySchema>;

/**
 * Multiplier applied to a modifier's nominal value in a given quarter of its
 * life. Implemented in `@frontier/simulation`; declared here so every package
 * agrees on the contract. Must be pure and deterministic.
 *
 * `elapsedQuarters` is 0 on the quarter the modifier is first applied.
 */
export type DecayFactorFn = (decay: ModifierDecay, elapsedQuarters: number, durationQuarters: number) => number;

/* -------------------------------------------------------------------------- */
/*  Target                                                                     */
/* -------------------------------------------------------------------------- */

const TARGET_SAMPLE = WORLD_TARGET_PATH_LIST.slice(0, 8).join(', ');

export const ModifierTargetSchema = z
  .string()
  .min(3)
  .max(160)
  .describe(
    `Dotted path of the world variable to change. Must be one of the registered world paths (for example: ${TARGET_SAMPLE}, ...), or a pattern path of the form "sector.<sectorId>.sentiment" / "sector.<sectorId>.multiple" / "sector.<sectorId>.demand", or "company.<companyId>.<metric>" where metric is one of reputationPublic, reputationDeveloper, reputationEnterprise, reputationGovernment, reputationInvestor, demandMultiplier, costMultiplier, attritionRate, valuationSentiment. Any other path is rejected outright and the whole proposal is discarded.`,
  );

/* -------------------------------------------------------------------------- */
/*  Proposal shape (LLM-facing)                                                */
/* -------------------------------------------------------------------------- */

export const WorldModifierProposalSchema = z
  .object({
    target: ModifierTargetSchema,
    operation: TargetOperationSchema,
    value: z
      .number()
      .min(-100)
      .max(100)
      .describe(
        'The operand. For "add" on a 0..1 variable, a meaningful shift is 0.02 to 0.15 and the sign carries the direction; on a 0..100 span such as a reputation, whole points are meaningful (-5 to -20 for a serious scandal). For "multiply" on a price or supply index, 0.84 means a 16% fall and 1.24 a 24% rise. For "set", the literal new value. Magnitude is capped by the impact budget, scaled to the target path\'s span; anything larger is clamped and logged.',
      ),
    decay: ModifierDecaySchema,
    durationQuarters: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe('How many quarters the modifier remains in force, from 1 (a single quarter) to 12 (three years). Structural changes should still expire; permanence is expressed by repeated events, not by an eternal modifier.'),
    reason: z
      .string()
      .min(3)
      .max(240)
      .describe('One sentence explaining the causal link between the event and this specific variable. Shown to players in the Quarter Resolution report.'),
  })
  .describe('A single proposed change to one world variable. Produced by the World Director; validated and clamped before it touches state.');
export type WorldModifierProposal = z.infer<typeof WorldModifierProposalSchema>;

/* -------------------------------------------------------------------------- */
/*  Stored shape (engine-facing)                                               */
/* -------------------------------------------------------------------------- */

export const MODIFIER_SOURCES = ['gm', 'event', 'system'] as const;

export const ModifierSourceSchema = z
  .enum(MODIFIER_SOURCES)
  .describe(
    'Where the modifier came from. "gm" is a World Director proposal that passed validation, "event" is a deterministic consequence attached to an event family template, "system" is an engine-authored correction such as a mean-reversion or a policy response.',
  );
export type ModifierSource = z.infer<typeof ModifierSourceSchema>;

export const WorldModifierSchema = z
  .object({
    id: z.string().min(1).describe('Deterministic modifier id, e.g. "mod_q7_compute_supply_1".'),
    source: ModifierSourceSchema,
    target: ModifierTargetSchema,
    operation: TargetOperationSchema,
    value: z.number().min(-100).max(100).describe('The operand, after impact-budget clamping (the budget cap scales with the target path\'s span, so a 0..100 path may legally carry a whole-point operand).'),
    decay: ModifierDecaySchema,
    durationQuarters: z.number().int().min(1).max(12).describe('Total lifetime in quarters, as validated.'),
    remainingQuarters: z
      .number()
      .int()
      .min(0)
      .max(12)
      .describe('Quarters of life left, counted down at the end of each resolution. 0 means the modifier expires this quarter and is removed.'),
    appliedAtQuarter: QuarterIndexSchema.describe('Quarter index at which the modifier first took effect.'),
    originEventId: z.string().nullable().describe('World event that produced this modifier, or null for system modifiers.'),
    reason: z.string().max(240).describe('Player-visible causal explanation.'),
  })
  .describe('A validated world modifier as stored by the engine.');
export type WorldModifier = z.infer<typeof WorldModifierSchema>;

/**
 * A modifier currently in force, with the derived per-quarter figures the
 * resolver needs. `effectiveValue` already has the decay factor applied.
 */
export const ActiveModifierSchema = WorldModifierSchema.extend({
  elapsedQuarters: z.number().int().min(0).max(12).describe('Quarters since appliedAtQuarter. 0 in the quarter it was created.'),
  effectiveValue: z
    .number()
    .describe('The operand for this quarter after the decay factor is applied. For "multiply" operations the decayed value tends toward 1.0, not 0.'),
  lastAppliedQuarter: QuarterIndexSchema.nullable().describe('Last quarter in which this modifier was actually applied, or null if never.'),
  exhausted: z.boolean().describe('True once remainingQuarters reaches 0; the engine removes exhausted modifiers during decayModifiers.'),
}).describe('A world modifier in force during the current quarter, with decay resolved.');
export type ActiveModifier = z.infer<typeof ActiveModifierSchema>;

/* -------------------------------------------------------------------------- */
/*  Impact budget                                                              */
/* -------------------------------------------------------------------------- */

export const ImpactBudgetSchema = z
  .object({
    maxTotalSeverity: z
      .number()
      .min(0)
      .max(5)
      .describe('Sum of event severities permitted in one quarter. Exceeding it causes the lowest-priority candidate events to be dropped before the World Director is asked.'),
    maxSingleModifierMagnitude: z
      .number()
      .min(0)
      .max(2)
      .describe('Largest permitted effect from one modifier. For "add" it caps |value|. For "multiply" it caps |value - 1|, so 0.35 permits 0.65x through 1.35x.'),
    maxModifiersPerEvent: z.number().int().min(1).max(12).describe('How many modifiers one event may carry. Keeps a single event from rewriting the whole world.'),
    maxEventsPerQuarter: z.number().int().min(0).max(8).describe('How many world events may fire in one quarter, including cascades.'),
  })
  .describe('The numeric ceiling on how much the World Director may change in one quarter. The model is free to be imaginative about what happens; it is not free to decide how much everything moves.');
export type ImpactBudget = z.infer<typeof ImpactBudgetSchema>;

/**
 * Default impact budget. A quiet quarter should be genuinely quiet: these values
 * allow at most three events with a combined severity of 1.5, and no single
 * variable may move more than 35% in one step.
 */
export const DEFAULT_IMPACT_BUDGET: ImpactBudget = {
  maxTotalSeverity: 1.5,
  maxSingleModifierMagnitude: 0.35,
  maxModifiersPerEvent: 6,
  maxEventsPerQuarter: 3,
};

/** Difficulty-scaled budgets. Higher difficulty means a more volatile world. */
export const IMPACT_BUDGET_BY_DIFFICULTY = {
  sandbox: { maxTotalSeverity: 0.9, maxSingleModifierMagnitude: 0.2, maxModifiersPerEvent: 4, maxEventsPerQuarter: 2 },
  standard: DEFAULT_IMPACT_BUDGET,
  hard: { maxTotalSeverity: 2.2, maxSingleModifierMagnitude: 0.45, maxModifiersPerEvent: 7, maxEventsPerQuarter: 4 },
  brutal: { maxTotalSeverity: 3.0, maxSingleModifierMagnitude: 0.6, maxModifiersPerEvent: 8, maxEventsPerQuarter: 5 },
} as const satisfies Record<string, ImpactBudget>;

/* -------------------------------------------------------------------------- */
/*  Validation reporting                                                       */
/* -------------------------------------------------------------------------- */

export const MODIFIER_REJECTION_REASONS = [
  'unknown_target_path',
  'unknown_entity',
  'operation_not_permitted',
  'magnitude_exceeds_budget',
  'duration_out_of_range',
  'too_many_modifiers',
  'contradicts_active_modifier',
  'targets_reference_market',
] as const;

export const ModifierRejectionReasonSchema = z.enum(MODIFIER_REJECTION_REASONS).describe('Why a proposed modifier was refused.');
export type ModifierRejectionReason = z.infer<typeof ModifierRejectionReasonSchema>;

export const ModifierValidationResultSchema = z
  .object({
    accepted: z.array(WorldModifierSchema).describe('Modifiers that passed validation, already clamped and id-assigned.'),
    rejected: z
      .array(
        z.object({
          proposal: WorldModifierProposalSchema,
          reason: ModifierRejectionReasonSchema,
          detail: z.string(),
        }),
      )
      .describe('Proposals that were refused, with the reason recorded for the ledger.'),
    clampedCount: z.number().int().min(0).describe('How many accepted modifiers had their value reduced to fit the impact budget or path bounds.'),
    severityUsed: unitInterval('Fraction of the quarter severity budget consumed by the accepted set.'),
  })
  .describe('Outcome of validating a World Director proposal against the impact budget and target registry.');
export type ModifierValidationResult = z.infer<typeof ModifierValidationResultSchema>;

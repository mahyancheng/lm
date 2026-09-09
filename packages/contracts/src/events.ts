/**
 * @frontier/contracts — events.ts
 *
 * World events, event families and the World Director's proposal envelope.
 *
 * The pipeline is deliberately engine-first:
 *
 *   world state -> hazard calculation -> eligibility, cooldown, contradiction
 *   -> severity budget -> candidate skeletons -> WORLD DIRECTOR (LLM)
 *   -> contextualised event + proposed modifiers -> validator -> canonical world
 *
 * The model is never asked "what random thing happens this quarter?". The
 * deterministic engine decides *whether* and *roughly what*; the model decides
 * how it reads, what it is called and which variables it plausibly moves.
 */

import { z } from 'zod';
import { CalendarYearSchema, QuarterIndexSchema, unitInterval } from './ids';
import { WorldModifierProposalSchema } from './modifiers';

/* -------------------------------------------------------------------------- */
/*  Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const WORLD_EVENT_TYPES = [
  'compute_supply_shock',
  'compute_demand_shock',
  'energy_price_shock',
  'grid_constraint',
  'fab_disruption',
  'macro_shift',
  'credit_event',
  'capital_market_shift',
  'fund_collapse',
  'ipo_window_change',
  'regulatory_action',
  'export_control',
  'antitrust_investigation',
  'copyright_ruling',
  'safety_incident',
  'model_breakthrough',
  'open_source_release',
  'benchmark_result',
  'research_disappointment',
  'talent_shock',
  'labour_action',
  'immigration_change',
  'data_licensing_shift',
  'privacy_enforcement',
  'procurement_programme',
  'grant_programme',
  'defence_mobilisation',
  'geopolitical_escalation',
  'sanctions_change',
  'trade_dispute',
  'cyber_incident',
  'infrastructure_outage',
  'supply_chain_disruption',
  'media_cycle',
  'public_backlash',
  'litigation',
  'standards_change',
  'corporate_scandal',
  'consolidation_wave',
  'other',
] as const;

export const WorldEventTypeSchema = z
  .enum(WORLD_EVENT_TYPES)
  .describe('Mechanical category of a world event. Determines which subsystems inspect it and how the UI groups it. Use "other" only when nothing else fits.');
export type WorldEventType = z.infer<typeof WorldEventTypeSchema>;

export const EVENT_VISIBILITIES = ['public', 'sector', 'private'] as const;

export const EventVisibilitySchema = z
  .enum(EVENT_VISIBILITIES)
  .describe(
    'Who learns about the event when it fires. "public" reaches every participant and the press immediately. "sector" reaches only companies operating in the affected sector. "private" is known to the engine and the directly affected company only, and reaches the market only if it later leaks.',
  );
export type EventVisibility = z.infer<typeof EventVisibilitySchema>;

export const EVENT_CATEGORIES = [
  'compute',
  'energy',
  'macro',
  'capital',
  'regulation',
  'geopolitics',
  'technology',
  'talent',
  'data',
  'government',
  'media',
  'corporate',
] as const;

export const EventCategorySchema = z.enum(EVENT_CATEGORIES).describe('Broad domain the event family belongs to. Used for cooldown grouping and UI filtering.');
export type EventCategory = z.infer<typeof EventCategorySchema>;

/* -------------------------------------------------------------------------- */
/*  World event                                                                */
/* -------------------------------------------------------------------------- */

export const WorldEventSchema = z
  .object({
    id: z.string().min(1).describe('Deterministic event id, e.g. "wev_pkg_disruption_q7".'),
    familyId: z.string().min(1).describe('Event family this instance belongs to. Governs cooldowns and follow-on hazards.'),
    type: WorldEventTypeSchema,
    titleKey: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9_]+$/)
      .describe('Stable snake_case key identifying this specific happening, e.g. "advanced_packaging_disruption". Used for localisation and de-duplication; never shown raw to players.'),
    title: z.string().min(3).max(120).describe('Headline as a player reads it, e.g. "Advanced packaging capacity disrupted".'),
    description: z.string().min(20).max(1200).describe('Two to four sentences of in-world reporting. States what happened and who it affects; never states what a specific player should do about it.'),
    severity: unitInterval('How consequential the event is. 0.1 is a footnote, 0.5 reshapes a quarter, 0.9 reshapes the session.'),
    visibility: EventVisibilitySchema,
    durationQuarters: z.number().int().min(1).max(12).describe('How many quarters the event is considered active for narrative and follow-on purposes. Modifier lifetimes are set independently.'),
    causalParentId: z
      .string()
      .nullable()
      .describe('Id of the event that made this one more likely, or null when this event is a root cause. A war raising the odds of an energy shortage creates a parent-child chain, not three unrelated shocks.'),
    quarter: QuarterIndexSchema.describe('Quarter in which the event fired.'),
    affectedSectorIds: z.array(z.string()).describe('Sectors materially affected. Empty for economy-wide events.'),
    affectedCompanyIds: z.array(z.string()).describe('Specific companies named by the event. Usually empty; populated for scandals, outages and litigation.'),
  })
  .describe('A world event instance that actually fired in a specific quarter.');
export type WorldEvent = z.infer<typeof WorldEventSchema>;

/* -------------------------------------------------------------------------- */
/*  Event families                                                             */
/* -------------------------------------------------------------------------- */

export const PRECONDITION_OPERATORS = ['gt', 'lt'] as const;

export const PreconditionOperatorSchema = z
  .enum(PRECONDITION_OPERATORS)
  .describe('Comparison used by an event precondition: "gt" means the world value must be strictly greater than value, "lt" strictly less.');
export type PreconditionOperator = z.infer<typeof PreconditionOperatorSchema>;

export const EventPreconditionSchema = z
  .object({
    path: z.string().min(3).describe('World target path to inspect, e.g. "world.compute.acceleratorSupply".'),
    op: PreconditionOperatorSchema,
    value: z.number().describe('Threshold the world value is compared against.'),
  })
  .describe('A data-expressed condition hook. Conditions are data, not code, so a family can be authored in seed data and evaluated deterministically.');
export type EventPrecondition = z.infer<typeof EventPreconditionSchema>;

export const FollowOnHazardSchema = z
  .object({
    familyId: z.string().min(1).describe('Family whose hazard is raised when this family fires.'),
    hazardDelta: z
      .number()
      .min(-1)
      .max(1)
      .describe('Additive change to that family\'s hazard, before decay. A war raising energy-shock hazard by 0.25 makes it likelier without guaranteeing it.'),
    decayQuarters: z.number().int().min(1).max(16).describe('How many quarters the raised hazard takes to return to baseline.'),
  })
  .describe('A causal cascade link. Follow-on hazards are how one root cause produces several correlated events over time instead of three unrelated random shocks.');
export type FollowOnHazard = z.infer<typeof FollowOnHazardSchema>;

export const EventFamilySchema = z
  .object({
    id: z.string().min(1).describe('Family id, e.g. "fam_compute_supply".'),
    label: z.string().min(3).max(80).describe('Short human label for designers and logs.'),
    description: z.string().max(600).describe('What kind of happenings belong to this family.'),
    category: EventCategorySchema,
    allowedTypes: z.array(WorldEventTypeSchema).min(1).describe('Event types an instance of this family may take.'),
    baseHazard: unitInterval('Per-quarter probability of this family firing when all preconditions hold and no cooldown applies.'),
    preconditions: z.array(EventPreconditionSchema).describe('All must hold for the family to be eligible. An empty list means always eligible.'),
    followOnHazards: z.array(FollowOnHazardSchema).describe('Hazard changes applied to other families when this one fires.'),
    cooldownQuarters: z.number().int().min(0).max(24).describe('Quarters this family is ineligible after firing.'),
    incompatibleFamilyIds: z.array(z.string()).describe('Families that may not fire in the same quarter as this one, because the two would contradict each other.'),
    severityRange: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
      .describe('Inclusive [minimum, maximum] severity an instance may take. The engine draws severity inside this range using the seeded RNG before the model is consulted.'),
    defaultVisibility: EventVisibilitySchema,
    defaultDurationQuarters: z.number().int().min(1).max(12).describe('Fallback duration when the World Director does not override it.'),
    weight: z.number().min(0).max(10).describe('Relative selection weight among eligible families. 1.0 is neutral.'),
  })
  .describe('A template describing a class of world happenings: how likely it is, when it is eligible, what it makes more likely next, and how long it must wait before recurring.');
export type EventFamily = z.infer<typeof EventFamilySchema>;

/** Per-family running hazard state. Internal; stored on the session. */
export const EventHazardStateSchema = z
  .object({
    familyId: z.string().min(1),
    baseHazard: unitInterval('The family baseline hazard.'),
    currentHazard: unitInterval('Baseline plus any un-decayed follow-on deltas. This is what the engine actually rolls against.'),
    cooldownRemaining: z.number().int().min(0).max(24).describe('Quarters left before the family is eligible again.'),
    lastFiredQuarter: QuarterIndexSchema.nullable().describe('Quarter this family last fired, or null.'),
    pendingDeltas: z
      .array(
        z.object({
          amount: z.number().min(-1).max(1),
          remainingQuarters: z.number().int().min(0).max(16),
          sourceEventId: z.string().nullable(),
        }),
      )
      .describe('Active follow-on hazard boosts still decaying.'),
  })
  .describe('Mutable hazard state for one event family.');
export type EventHazardState = z.infer<typeof EventHazardStateSchema>;

/** Hazard state keyed by family id. Internal state — records permitted. */
export const EventHazardMapSchema = z.record(z.string(), EventHazardStateSchema).describe('Event hazard state keyed by family id.');
export type EventHazardMap = z.infer<typeof EventHazardMapSchema>;

/* -------------------------------------------------------------------------- */
/*  World Director proposal (LLM-facing)                                       */
/* -------------------------------------------------------------------------- */

/**
 * The event portion of a World Director proposal. The model contextualises a
 * candidate skeleton: it names the happening and writes the copy. It does not
 * choose the id, the quarter or the family — those come from the engine.
 */
export const GmProposedEventSchema = z
  .object({
    candidateId: z
      .string()
      .min(1)
      .describe('Id of the candidate skeleton this proposal contextualises, copied verbatim from the input. Use "novel" only when inventing an event the engine did not suggest.'),
    familyId: z.string().min(1).describe('Event family id, copied from the candidate skeleton. For a novel event, the closest existing family id.'),
    type: WorldEventTypeSchema,
    titleKey: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9_]+$/)
      .describe('Stable snake_case key for this happening, e.g. "advanced_packaging_disruption". Lower case letters, digits and underscores only.'),
    title: z.string().min(3).max(120).describe('Player-facing headline.'),
    description: z
      .string()
      .min(20)
      .max(1200)
      .describe('Two to four sentences of in-world reporting: what happened, where, and who is exposed. Do not narrate any player\'s outcome, do not state share price moves, and do not promise future events.'),
    severity: unitInterval('Consequence of the event. Stay within the severity band given in the candidate skeleton; values outside it will be clamped.'),
    visibility: EventVisibilitySchema,
    durationQuarters: z.number().int().min(1).max(12).describe('How long this event is considered active.'),
    causalParentId: z.string().nullable().describe('Id of the recent event this one follows from, or null if it is a root cause.'),
    affectedSectorIds: z.array(z.string()).describe('Sector ids materially affected. Use ids from the sector list supplied in the input; empty for economy-wide events.'),
  })
  .describe('The contextualised event the World Director proposes.');
export type GmProposedEvent = z.infer<typeof GmProposedEventSchema>;

/**
 * The exact structure the World Director LLM returns.
 *
 * LLM-facing: every field is required, categorical fields are enums, nothing is
 * a record and nothing transforms. `modifiers` uses the proposal shape — the
 * engine assigns ids, sources and lifetimes after validation.
 */
export const GmEventProposalSchema = z
  .object({
    event: GmProposedEventSchema,
    modifiers: z
      .array(WorldModifierProposalSchema)
      .max(12)
      .describe(
        'The world variables this event moves, and by how much. Prefer two to five modifiers that trace a believable causal chain over a long list of small nudges. Every target must be a legal registered path. Note for engine authors: this is WorldModifierProposal, not the stored WorldModifier — id, source, appliedAtQuarter and remainingQuarters are assigned by the engine after validation.',
      ),
    rationale: z
      .string()
      .min(20)
      .max(800)
      .describe('Your reasoning, for the designer log and the Quarter Resolution report: why this event now, why these variables, why this magnitude. Not shown as in-world text.'),
    confidence: unitInterval('How well this proposal fits the current world state. Low confidence proposals may be dropped by the engine in favour of a quieter quarter.'),
  })
  .describe('A complete World Director proposal for one event: what happens, which world variables move, and why. The engine validates every target and clamps every magnitude before anything becomes real.');
export type GmEventProposal = z.infer<typeof GmEventProposalSchema>;

/** The World Director may return several proposals in one call, up to the event budget. */
export const GmProposalBatchSchema = z
  .object({
    proposals: z
      .array(GmEventProposalSchema)
      .max(8)
      .describe('One entry per event you wish to fire this quarter. Return an empty array for a deliberately quiet quarter — a stable economic quarter containing no material shock is a legitimate and often correct answer.'),
    quarterSummary: z.string().min(10).max(600).describe('One paragraph describing the mood of the quarter, used as the headline of the news screen.'),
  })
  .describe('The World Director response envelope for one quarter.');
export type GmProposalBatch = z.infer<typeof GmProposalBatchSchema>;

/* -------------------------------------------------------------------------- */
/*  Frontier Map belief shifts carried by events                               */
/* -------------------------------------------------------------------------- */

export const TechBeliefShiftSchema = z
  .object({
    nodeId: z.string().min(1).describe('Frontier Map node whose public confidence moves.'),
    confidenceDelta: z
      .number()
      .min(-0.5)
      .max(0.5)
      .describe('Change in public confidence for that node, -0.5..0.5. Power costs soaring should lower confidence in huge dense models and raise it for efficient sparse inference.'),
    windowShiftYears: z
      .number()
      .int()
      .min(-5)
      .max(5)
      .describe('Shift of the estimated arrival window in years. Negative pulls the expected date earlier.'),
    reason: z.string().min(5).max(240).describe('One sentence linking the event to the belief change.'),
  })
  .describe('A change to what the world believes about the technological future, caused by an event.');
export type TechBeliefShift = z.infer<typeof TechBeliefShiftSchema>;

/** Convenience: the estimated-window tuple used across the Frontier Map. */
export const EstimatedWindowSchema = z
  .tuple([CalendarYearSchema, CalendarYearSchema])
  .describe('[earliestYear, latestYear] window in which a technology is currently expected to arrive.');
export type EstimatedWindow = z.infer<typeof EstimatedWindowSchema>;

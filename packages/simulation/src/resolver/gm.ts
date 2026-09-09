/**
 * @frontier/simulation — resolver/gm.ts
 *
 * The gate between the World Director and reality.
 *
 * The model has already been told what the engine drew: which families fired,
 * how severe they may be, which variables are plausibly in scope. What comes
 * back is a *proposal*. This module is where a proposal stops being text and
 * becomes a bounded, clamped, budgeted set of changes — or is dropped.
 *
 * Two jobs:
 *
 * 1. **Clamp to the impact budget.** Severity into the candidate's band, count
 *    into `maxEventsPerQuarter`, total severity into `maxTotalSeverity`,
 *    modifiers into `maxModifiersPerEvent`, and every operand into
 *    `maxSingleModifierMagnitude` and the target registry's own bounds. The
 *    model is free to be imaginative about *what* happens; it is not free to
 *    decide *how much* everything moves.
 *
 * 2. **Materialise a fallback.** `gmProposal` may be null — a timeout, a rate
 *    limit, a disabled gateway. An outage is a degraded quarter, never a
 *    blocked one. The engine falls back to the candidate skeletons at their
 *    drawn severity. Note what the fallback does *not* do: it does not invent
 *    modifier magnitudes. Deciding how far a variable moves is the event
 *    family's business, and the family templates live in the economy subsystem;
 *    when that subsystem offers `materialiseCandidate` the resolver uses it, and
 *    when it does not the events still fire, with the family's own consequences
 *    and no editorial from the resolver.
 */

import type {
  EconomySubsystem,
  GmEventProposal,
  GmProposalBatch,
  ImpactBudget,
  ResolverContext,
  SessionState,
  WorldEventCandidate,
  WorldModifierProposal,
} from '@frontier/contracts';
import { IMPACT_BUDGET_BY_DIFFICULTY, getTargetPathSpec, slugify } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

/** The impact budget in force for a session, scaled by its difficulty. */
export function impactBudgetFor(draft: SessionState): ImpactBudget {
  return IMPACT_BUDGET_BY_DIFFICULTY[draft.config.difficulty];
}

/* -------------------------------------------------------------------------- */
/*  Clamping                                                                   */
/* -------------------------------------------------------------------------- */

/** Why one proposal or modifier did not survive validation. */
export interface GmRejection {
  readonly candidateId: string;
  readonly target: string | null;
  readonly reason: string;
}

/** The result of putting a World Director batch through the budget. */
export interface ClampedGmBatch {
  readonly batch: GmProposalBatch;
  readonly rejections: GmRejection[];
  readonly clampedCount: number;
  readonly severityUsed: number;
}

/**
 * Clamp a World Director batch into the impact budget and the target registry.
 *
 * Deterministic in its ordering: proposals are considered in descending
 * confidence, then by candidate id, so the same batch always survives the same
 * way regardless of the order the model happened to emit them in.
 */
export function clampGmBatch(
  batch: GmProposalBatch,
  candidates: readonly WorldEventCandidate[],
  budget: ImpactBudget,
): ClampedGmBatch {
  const byCandidate = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const rejections: GmRejection[] = [];
  let clampedCount = 0;
  let severityUsed = 0;

  const ordered = [...batch.proposals].sort((a, b) =>
    a.confidence !== b.confidence
      ? b.confidence - a.confidence
      : a.event.candidateId < b.event.candidateId
        ? -1
        : a.event.candidateId > b.event.candidateId
          ? 1
          : compare(a.event.titleKey, b.event.titleKey),
  );

  const kept: GmEventProposal[] = [];
  for (const proposal of ordered) {
    if (kept.length >= budget.maxEventsPerQuarter) {
      rejections.push({
        candidateId: proposal.event.candidateId,
        target: null,
        reason: `The quarter already carries ${budget.maxEventsPerQuarter} events, which is this difficulty's ceiling.`,
      });
      continue;
    }

    const candidate = byCandidate.get(proposal.event.candidateId) ?? null;
    let severity = proposal.event.severity;
    let durationQuarters = proposal.event.durationQuarters;

    if (candidate !== null) {
      const [low, high] = candidate.severityBand;
      const min = Math.min(low, high);
      const max = Math.max(low, high);
      if (severity < min || severity > max) {
        severity = Math.min(max, Math.max(min, severity));
        clampedCount += 1;
      }
      if (durationQuarters > candidate.maxDurationQuarters) {
        durationQuarters = candidate.maxDurationQuarters;
        clampedCount += 1;
      }
    }

    if (severityUsed + severity > budget.maxTotalSeverity) {
      const remaining = Math.max(0, budget.maxTotalSeverity - severityUsed);
      if (remaining <= 0.01) {
        rejections.push({
          candidateId: proposal.event.candidateId,
          target: null,
          reason: `The quarter's severity budget of ${budget.maxTotalSeverity} is spent.`,
        });
        continue;
      }
      severity = remaining;
      clampedCount += 1;
    }
    severityUsed += severity;

    const modifiers: WorldModifierProposal[] = [];
    for (const modifier of proposal.modifiers) {
      if (modifiers.length >= budget.maxModifiersPerEvent) {
        rejections.push({
          candidateId: proposal.event.candidateId,
          target: modifier.target,
          reason: `One event may carry at most ${budget.maxModifiersPerEvent} modifiers.`,
        });
        continue;
      }
      const spec = getTargetPathSpec(modifier.target);
      if (spec === null) {
        rejections.push({ candidateId: proposal.event.candidateId, target: modifier.target, reason: 'Unknown target path.' });
        continue;
      }
      if (!spec.operations.includes(modifier.operation)) {
        rejections.push({
          candidateId: proposal.event.candidateId,
          target: modifier.target,
          reason: `Operation "${modifier.operation}" is not permitted on ${modifier.target}.`,
        });
        continue;
      }
      const capped = capMagnitude(modifier, budget.maxSingleModifierMagnitude);
      if (capped.clamped) clampedCount += 1;
      modifiers.push(capped.modifier);
    }

    kept.push({
      ...proposal,
      event: { ...proposal.event, severity, durationQuarters },
      modifiers,
    });
  }

  return {
    batch: { proposals: kept, quarterSummary: batch.quarterSummary },
    rejections,
    clampedCount,
    severityUsed,
  };
}

/** Cap an operand: `|value|` for add, `|value - 1|` for multiply. */
function capMagnitude(modifier: WorldModifierProposal, maxMagnitude: number): { modifier: WorldModifierProposal; clamped: boolean } {
  if (modifier.operation === 'multiply') {
    const delta = modifier.value - 1;
    if (Math.abs(delta) <= maxMagnitude) return { modifier, clamped: false };
    const value = 1 + Math.sign(delta) * maxMagnitude;
    return { modifier: { ...modifier, value }, clamped: true };
  }
  if (Math.abs(modifier.value) <= maxMagnitude) return { modifier, clamped: false };
  return { modifier: { ...modifier, value: Math.sign(modifier.value) * maxMagnitude }, clamped: true };
}

/* -------------------------------------------------------------------------- */
/*  Fallback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An economy subsystem that can turn a candidate into a real event on its own.
 *
 * Optional by design: the resolver detects it rather than requiring it, so a
 * stub economy in a test — and any future economy build — remains a valid
 * `EconomySubsystem`.
 */
export interface CandidateMaterialiser {
  materialiseCandidate(draft: SessionState, candidate: WorldEventCandidate, ctx: ResolverContext): unknown;
}

/** True when this economy can materialise candidates without a model. */
export function canMaterialise(economy: EconomySubsystem): economy is EconomySubsystem & CandidateMaterialiser {
  return typeof (economy as Partial<CandidateMaterialiser>).materialiseCandidate === 'function';
}

/**
 * Build a deterministic proposal batch from the drawn candidates.
 *
 * Used when there is no World Director output and the economy cannot materialise
 * candidates itself. The events fire at the severity the engine drew, described
 * plainly. No modifiers are attached: their magnitudes belong to the event
 * family, and the resolver does not invent world changes.
 */
export function buildFallbackBatch(candidates: readonly WorldEventCandidate[], budget: ImpactBudget): GmProposalBatch {
  const proposals: GmEventProposal[] = [];
  let severityUsed = 0;

  for (const candidate of candidates) {
    if (proposals.length >= budget.maxEventsPerQuarter) break;
    const [low, high] = candidate.severityBand;
    const severity = Math.min(Math.max(candidate.suggestedSeverity, Math.min(low, high)), Math.max(low, high));
    if (severityUsed + severity > budget.maxTotalSeverity) break;
    severityUsed += severity;

    const type = candidate.allowedTypes[0] ?? 'other';
    const titleKey = safeTitleKey(candidate.familyLabel, candidate.candidateId);
    proposals.push({
      event: {
        candidateId: candidate.candidateId,
        familyId: candidate.familyId,
        type,
        titleKey,
        title: clip(candidate.familyLabel, 120),
        description: clip(
          `${candidate.familyLabel} developed this quarter at a severity of ${severity.toFixed(2)}. Reporting is thin: the conditions behind it are visible in the ${
            candidate.affectedSectorIds.length > 0 ? candidate.affectedSectorIds.join(', ') : 'wider economy'
          }, and the industry is reading the consequences as they arrive.`,
          1200,
        ),
        severity,
        visibility: candidate.defaultVisibility,
        durationQuarters: Math.max(1, Math.min(candidate.maxDurationQuarters, 2)),
        causalParentId: candidate.causalParentId,
        affectedSectorIds: [...candidate.affectedSectorIds],
      },
      modifiers: [],
      rationale:
        'Deterministic fallback: no World Director output was available for this quarter, so the drawn candidate fires with its own family consequences and no editorial.',
      confidence: 0.5,
    });
  }

  return {
    proposals,
    quarterSummary:
      proposals.length === 0
        ? 'A quiet quarter. The hazard engine drew nothing material and no narrative was written over it.'
        : `The quarter was shaped by ${proposals.length} development(s) drawn by the hazard engine and reported without commentary.`,
  };
}

/** `titleKey` must match `^[a-z0-9_]+$` and be at least three characters. */
function safeTitleKey(label: string, fallback: string): string {
  const slug = slugify(label) || slugify(fallback);
  const padded = slug.length >= 3 ? slug : `${slug}_ev`;
  return padded.slice(0, 80);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

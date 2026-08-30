/**
 * @frontier/simulation — economy
 *
 * The world-economy subsystem: macro drift, the hazard engine, world modifiers,
 * World Director integration and information reveal.
 *
 * Everything here obeys the subsystem contract in `@frontier/contracts/engine`:
 * deterministic, a mutator of a draft, and an emitter. Nothing economically
 * material happens without a `ctx.emit()` behind it, and every line written to
 * the Quarter Resolution report references at least one emitted event, so the
 * screen is a rendering of the ledger rather than narrative invention.
 *
 * Phase order inside the world phase, as the resolver runs it:
 *
 * ```text
 * updateMacro            the world's own dynamics
 * computeEventCandidates hazard draw → candidate skeletons
 *   (World Director, or materialiseCandidate when there is none)
 * applyGmProposals       validated events and modifiers become real
 * applyModifiers         every active modifier applies to its path
 * revealInformation      who learns what
 * decayModifiers         decay, expiry, event ageing
 * ```
 */

import type {
  EconomySubsystem,
  GmProposalBatch,
  LedgerVisibility,
  ResolverContext,
  SessionState,
  WorldEvent,
  WorldEventCandidate,
  WorldEventType,
  WorldModifier,
} from '@frontier/contracts';
import { WORLD_EVENT_TYPES, makeId } from '@frontier/contracts';
import { driftWorld, selectDominantNarrative, type DriftChange } from './macro';
import {
  budgetFor,
  drawCandidates,
  ensureHazardStates,
  materialiseCandidate as buildMaterialisation,
  registerFiring,
  tickHazardStates,
  type MaterialisedEvent,
} from './hazards';
import { eventFamilyById } from './eventFamilies';
import { applyActiveModifiers, decayActiveModifiers, toActiveModifier, validateModifierProposals } from './modifiers';
import { clamp, clamp01, pctLabel, pointLabel, round } from './util';

export { EVENT_FAMILIES, EVENT_FAMILY_DEFINITIONS, eventFamilyById, TOTAL_BASE_HAZARD } from './eventFamilies';
export type { EventFamilyDefinition, ModifierTemplate, CompanyScopeRule } from './eventFamilies';
export { decayFactor, effectiveOperand } from './decay';
export { WORLD_DRIFT_SPECS, driftWorld, selectDominantNarrative } from './macro';
export type { DriftChange } from './macro';
/**
 * The pure builder behind the subsystem's `materialiseCandidate`: it produces the
 * event and its template modifiers without touching the draft, for callers that
 * want to inspect the fallback before committing it.
 */
export { materialiseCandidate as buildMaterialisedEvent } from './hazards';
export {
  budgetFor,
  clampOperandToBudget,
  currentHazard,
  drawCandidates,
  ensureHazardStates,
  magnitudeCap,
  preconditionHolds,
  registerFiring,
  selectCompanySubject,
  tickHazardStates,
} from './hazards';
export type { CandidateDraw, FamilyDrawDiagnostic, MaterialisedEvent } from './hazards';
export { applyActiveModifiers, decayActiveModifiers, sortModifiers, toActiveModifier, validateModifierProposals } from './modifiers';
export type { ModifierApplication } from './modifiers';
export {
  buildTargetPathScope,
  commitCompanyMetrics,
  companyTransientMetrics,
  NEUTRAL_TRANSIENT,
  TRANSIENT_COMPANY_METRICS,
} from './scope';
export type { MutableTargetPathScope, TransientCompanyMetric } from './scope';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const LEDGER_VISIBILITY_BY_EVENT: Record<string, LedgerVisibility> = {
  public: 'public',
  sector: 'sector',
  private: 'private',
};

/** How many of the largest drift movements make it into the report. */
const DRIFT_REPORT_LINES = 3;

/** Below this normalised movement a drift line is noise, not news. */
const DRIFT_REPORT_THRESHOLD = 0.02;

const isIndexPath = (path: string): boolean => {
  const spec = path.split('.');
  const tail = spec[spec.length - 1] ?? '';
  return ['spotPrice', 'reservedPrice', 'electricityPrice', 'inferenceCost', 'licensingCost', 'salaryPressure', 'sectorMultiples', 'multiple'].includes(tail);
};

const driftLabel = (change: DriftChange): string =>
  isIndexPath(change.path) ? pctLabel(change.before, change.after) : pointLabel(change.before, change.after);

/** Coerce a proposed event type into one the family actually permits. */
function coerceType(proposed: string, allowed: readonly WorldEventType[]): WorldEventType {
  const known = (WORLD_EVENT_TYPES as readonly string[]).includes(proposed) ? (proposed as WorldEventType) : null;
  if (known !== null && allowed.includes(known)) return known;
  return allowed[0] ?? 'other';
}

/* -------------------------------------------------------------------------- */
/*  Subsystem                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The economy subsystem plus the deterministic fallback the resolver needs when
 * no World Director proposal is available.
 */
export interface EconomySubsystemImpl extends EconomySubsystem {
  /**
   * Turn a drawn candidate into a real event with its family's template
   * modifiers, at the drawn severity, with no model in the loop. Returns null
   * when the candidate names a family this build does not know.
   */
  materialiseCandidate(draft: SessionState, candidate: WorldEventCandidate, ctx: ResolverContext): MaterialisedEvent | null;
}

export function createEconomySubsystem(): EconomySubsystemImpl {
  /* ------------------------------ macro drift ----------------------------- */

  function updateMacro(draft: SessionState, ctx: ResolverContext): void {
    const rng = ctx.rng.fork(`macro_q${ctx.quarter}`);
    const narrativeBefore = draft.world.media.dominantNarrative;
    const changes = driftWorld(draft.world, rng);
    draft.world.media.dominantNarrative = selectDominantNarrative(draft.world, narrativeBefore);

    const reported = changes.filter((change) => Math.abs(change.normalisedDelta) >= DRIFT_REPORT_THRESHOLD).slice(0, DRIFT_REPORT_LINES);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'world_event_applied',
      actorId: null,
      targetId: 'world',
      payload: {
        kind: 'macro_drift',
        narrativeBefore,
        narrativeAfter: draft.world.media.dominantNarrative,
        changes: changes.map((change) => ({
          path: change.path,
          before: round(change.before, 6),
          after: round(change.after, 6),
          normalisedDelta: round(change.normalisedDelta, 6),
        })),
      },
      visibility: 'public',
    });

    for (const change of reported) {
      ctx.log({
        phase: 'world_events',
        text: `${change.label} moved from ${round(change.before, 4)} to ${round(change.after, 4)} on the quarter's own dynamics.`,
        deltaLabel: driftLabel(change),
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: null,
      });
    }

    if (draft.world.media.dominantNarrative !== narrativeBefore) {
      ctx.log({
        phase: 'world_events',
        text: `The dominant press narrative shifted from ${narrativeBefore} to ${draft.world.media.dominantNarrative}.`,
        deltaLabel: null,
        refEventIds: [eventId],
        tone: draft.world.media.dominantNarrative === 'neutral' ? 'neutral' : 'warning',
        subjectId: null,
      });
    }
  }

  /* --------------------------- candidate drawing -------------------------- */

  function computeEventCandidates(draft: SessionState, ctx: ResolverContext): WorldEventCandidate[] {
    tickHazardStates(draft);
    const budget = budgetFor(draft);
    const draw = drawCandidates(draft, ctx.quarter, ctx.rng, budget);

    for (const candidate of draw.candidates) {
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'world_event_generated',
        actorId: null,
        targetId: candidate.candidateId,
        payload: {
          familyId: candidate.familyId,
          familyLabel: candidate.familyLabel,
          suggestedSeverity: candidate.suggestedSeverity,
          severityBand: candidate.severityBand,
          causalParentId: candidate.causalParentId,
          hazard: round(draft.eventHazards[candidate.familyId]?.currentHazard ?? 0, 4),
          severityBudget: budget.maxTotalSeverity,
          severityUsed: draw.severityUsed,
        },
        // A candidate is not yet a happening: it becomes public when the event
        // it produces does.
        visibility: 'private',
      });
      ctx.log({
        phase: 'world_events',
        text: `Hazard engine drew a candidate in family "${candidate.familyLabel}" at severity ${candidate.suggestedSeverity}.`,
        deltaLabel: `${draw.candidates.length}/${budget.maxEventsPerQuarter}`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: null,
      });
    }

    return draw.candidates;
  }

  /* ------------------------------ commitment ------------------------------ */

  /** Push an event and its modifiers into the draft and record the firing. */
  function commitEvent(draft: SessionState, event: WorldEvent, modifiers: readonly WorldModifier[], ctx: ResolverContext): string {
    draft.activeEvents = [...draft.activeEvents.filter((existing) => existing.id !== event.id), event];
    for (const modifier of modifiers) {
      draft.activeModifiers = [
        ...draft.activeModifiers.filter((existing) => existing.id !== modifier.id),
        toActiveModifier(modifier, ctx.quarter),
      ];
    }
    registerFiring(draft, event.familyId, event.id, ctx.quarter);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'world_event_applied',
      actorId: null,
      targetId: event.id,
      payload: {
        kind: 'world_event',
        familyId: event.familyId,
        type: event.type,
        titleKey: event.titleKey,
        severity: event.severity,
        visibility: event.visibility,
        durationQuarters: event.durationQuarters,
        causalParentId: event.causalParentId,
        affectedSectorIds: event.affectedSectorIds,
        affectedCompanyIds: event.affectedCompanyIds,
        modifierIds: modifiers.map((modifier) => modifier.id),
      },
      visibility: LEDGER_VISIBILITY_BY_EVENT[event.visibility] ?? 'public',
    });

    ctx.log({
      phase: 'world_events',
      text: `${event.title}${event.causalParentId === null ? '' : ' (a consequence of an earlier event)'}.`,
      deltaLabel: `sev ${round(event.severity, 2)}`,
      refEventIds: [eventId],
      tone: event.severity >= 0.5 ? 'warning' : 'neutral',
      subjectId: event.affectedCompanyIds[0] ?? null,
    });

    return eventId;
  }

  function materialiseCandidate(draft: SessionState, candidate: WorldEventCandidate, ctx: ResolverContext): MaterialisedEvent | null {
    const built = buildMaterialisation(draft, candidate, ctx);
    if (built === null) return null;
    commitEvent(draft, built.event, built.modifiers, ctx);
    return built;
  }

  /* --------------------------- World Director ----------------------------- */

  function applyGmProposals(
    draft: SessionState,
    batch: GmProposalBatch,
    candidates: readonly WorldEventCandidate[],
    ctx: ResolverContext,
  ): void {
    ensureHazardStates(draft);
    const budget = budgetFor(draft);
    const byCandidateId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const used = new Set<string>();
    let severityUsed = 0;
    let eventsFired = 0;

    for (const proposal of batch.proposals) {
      if (eventsFired >= budget.maxEventsPerQuarter) break;

      const candidate = byCandidateId.get(proposal.event.candidateId) ?? null;
      const familyId = candidate?.familyId ?? proposal.event.familyId;
      const def = eventFamilyById(familyId);
      if (def === null) {
        ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'modifier_rejected',
          actorId: null,
          targetId: proposal.event.candidateId,
          payload: { reason: 'unknown_family', familyId, titleKey: proposal.event.titleKey },
          visibility: 'private',
        });
        continue;
      }
      if (used.has(familyId)) continue;

      const band = candidate?.severityBand ?? def.family.severityRange;
      const severity = clamp01(clamp(proposal.event.severity, Math.min(band[0], band[1]), Math.max(band[0], band[1])));
      if (severityUsed + severity > budget.maxTotalSeverity) continue;

      const allowed = candidate?.allowedTypes ?? def.family.allowedTypes;
      const maxDuration = candidate?.maxDurationQuarters ?? def.family.defaultDurationQuarters;
      const eventId = makeId('wev', draft.sessionId, ctx.quarter, familyId);
      const sectorIds = new Set(Object.keys(draft.sectors));

      const event: WorldEvent = {
        id: eventId,
        familyId,
        type: coerceType(proposal.event.type, allowed),
        titleKey: proposal.event.titleKey,
        title: proposal.event.title,
        description: proposal.event.description,
        severity,
        visibility: proposal.event.visibility,
        durationQuarters: clamp(Math.trunc(proposal.event.durationQuarters), 1, Math.max(1, Math.trunc(maxDuration))),
        causalParentId: proposal.event.causalParentId ?? candidate?.causalParentId ?? null,
        quarter: ctx.quarter,
        affectedSectorIds: proposal.event.affectedSectorIds.filter((id) => sectorIds.has(id)),
        affectedCompanyIds: [],
      };

      const validation = validateModifierProposals(draft, proposal.modifiers, {
        budget,
        quarter: ctx.quarter,
        originEventId: eventId,
        idPrefixParts: [`q${ctx.quarter}`, familyId],
        source: 'gm',
        severityFraction: budget.maxTotalSeverity > 0 ? (severityUsed + severity) / budget.maxTotalSeverity : 0,
      });

      // A World Director proposal with no usable modifier is still an event, but
      // the family template supplies the consequences so the quarter is not
      // merely a headline.
      const fallback =
        validation.accepted.length === 0 ? buildMaterialisation(draft, candidate ?? candidateFromFamily(draft, def.family.id, severity, ctx.quarter), ctx) : null;
      const modifiers = validation.accepted.length > 0 ? validation.accepted : fallback?.modifiers ?? [];
      if (fallback !== null) {
        event.affectedCompanyIds = fallback.event.affectedCompanyIds;
      }

      for (const rejection of validation.rejected) {
        const rejectedId = ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'modifier_rejected',
          actorId: null,
          targetId: rejection.proposal.target,
          payload: {
            reason: rejection.reason,
            detail: rejection.detail,
            operation: rejection.proposal.operation,
            value: rejection.proposal.value,
            eventId,
          },
          visibility: 'private',
        });
        ctx.log({
          phase: 'gm_modifiers',
          text: `A proposed change to ${rejection.proposal.target} was refused: ${rejection.detail}`.slice(0, 300),
          deltaLabel: null,
          refEventIds: [rejectedId],
          tone: 'warning',
          subjectId: null,
        });
      }

      commitEvent(draft, event, modifiers, ctx);
      used.add(familyId);
      severityUsed += severity;
      eventsFired += 1;
    }
  }

  /** A synthetic candidate for a novel proposal, so the fallback path still works. */
  function candidateFromFamily(draft: SessionState, familyId: string, severity: number, quarter: number): WorldEventCandidate {
    const def = eventFamilyById(familyId);
    const family = def?.family;
    return {
      candidateId: makeId('cand', draft.sessionId, quarter, familyId),
      familyId,
      familyLabel: family?.label ?? familyId,
      allowedTypes: family === undefined ? ['other'] : [...family.allowedTypes],
      severityBand: family === undefined ? [0, 1] : [family.severityRange[0], family.severityRange[1]],
      suggestedSeverity: severity,
      defaultVisibility: family?.defaultVisibility ?? 'public',
      maxDurationQuarters: clamp(family?.defaultDurationQuarters ?? 4, 1, 12),
      causalParentId: null,
      suggestedTargetPaths: def === null ? [] : [...def.suggestedTargetPaths],
      relevantWorldReadings: [],
      affectedSectorIds: def === null ? [] : [...def.affectedSectorIds],
    };
  }

  /* ------------------------------- modifiers ------------------------------ */

  function applyModifiers(draft: SessionState, ctx: ResolverContext): void {
    for (const application of applyActiveModifiers(draft, ctx.quarter)) {
      const { modifier, result, operand, factor } = application;
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: result.applied ? 'modifier_applied' : 'modifier_rejected',
        actorId: null,
        targetId: modifier.target,
        payload: {
          modifierId: modifier.id,
          source: modifier.source,
          operation: modifier.operation,
          nominalValue: modifier.value,
          effectiveValue: round(operand, 6),
          decay: modifier.decay,
          decayFactor: round(factor, 6),
          remainingQuarters: modifier.remainingQuarters,
          before: round(result.before, 6),
          after: round(result.after, 6),
          clamped: result.clamped,
          reason: result.reason ?? modifier.reason,
          originEventId: modifier.originEventId,
        },
        visibility: 'public',
      });

      const moved = Math.abs(result.after - result.before) > 1e-9;
      if (!result.applied || moved) {
        ctx.log({
          phase: 'gm_modifiers',
          text: (result.applied
            ? `${modifier.reason} (${modifier.target} ${round(result.before, 4)} → ${round(result.after, 4)}${result.clamped ? ', clamped to bounds' : ''})`
            : `Modifier ${modifier.id} could not be applied: ${result.reason ?? 'unknown reason'}.`
          ).slice(0, 300),
          deltaLabel: result.applied ? (modifier.operation === 'multiply' ? pctLabel(result.before, result.after) : pointLabel(result.before, result.after)) : null,
          refEventIds: [eventId],
          tone: result.applied ? (result.after >= result.before ? 'positive' : 'negative') : 'warning',
          subjectId: modifier.target.startsWith('company.') ? modifier.target.split('.')[1] ?? null : null,
        });
      }
    }
  }

  function decayModifiers(draft: SessionState, ctx: ResolverContext): void {
    for (const expired of decayActiveModifiers(draft, ctx.quarter)) {
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'modifier_expired',
        actorId: null,
        targetId: expired.target,
        payload: {
          modifierId: expired.id,
          source: expired.source,
          appliedAtQuarter: expired.appliedAtQuarter,
          durationQuarters: expired.durationQuarters,
          originEventId: expired.originEventId,
        },
        visibility: 'public',
      });
      ctx.log({
        phase: 'gm_modifiers',
        text: `The effect on ${expired.target} has run its course and no longer applies.`,
        deltaLabel: null,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: null,
      });
    }

    // Age out events whose narrative window has closed. The ledger keeps them
    // forever; live state does not need to.
    draft.activeEvents = draft.activeEvents.filter((event) => ctx.quarter - event.quarter < event.durationQuarters);
  }

  /* --------------------------- information reveal ------------------------- */

  function revealInformation(draft: SessionState, ctx: ResolverContext): void {
    for (const event of draft.activeEvents) {
      if (event.quarter !== ctx.quarter) continue;
      const visibility = LEDGER_VISIBILITY_BY_EVENT[event.visibility] ?? 'public';
      const audience =
        event.visibility === 'public'
          ? 'every participant and the press'
          : event.visibility === 'sector'
            ? `companies in ${event.affectedSectorIds.join(', ') || 'the affected sector'}`
            : 'the directly affected company only';

      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'information_revealed',
        actorId: null,
        targetId: event.id,
        payload: {
          worldEventId: event.id,
          familyId: event.familyId,
          visibility: event.visibility,
          audience,
          severity: event.severity,
          affectedSectorIds: event.affectedSectorIds,
          affectedCompanyIds: event.affectedCompanyIds,
        },
        visibility,
      });

      ctx.log({
        phase: 'information_reveal',
        text: `${event.title} reached ${audience}.`.slice(0, 300),
        deltaLabel: null,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: event.affectedCompanyIds[0] ?? null,
      });
    }
  }

  return {
    updateMacro,
    computeEventCandidates,
    applyModifiers,
    decayModifiers,
    applyGmProposals,
    revealInformation,
    materialiseCandidate,
  };
}

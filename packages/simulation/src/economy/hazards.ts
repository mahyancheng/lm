/**
 * @frontier/simulation — economy/hazards.ts
 *
 * The deterministic hazard engine: the part of the world that decides *whether*
 * and *roughly what*, before any model is consulted.
 *
 * ```text
 * for each family:
 *     eligible = all preconditions hold
 *              ∧ cooldownRemaining == 0
 *              ∧ no already-drawn family in incompatibleFamilyIds
 *     hazard   = baseHazard + Σ(pendingDeltas still decaying)
 *     fires    = rng.next() < hazard
 *
 * draw severity uniformly inside severityRange, biased by hazard headroom
 * rank drawn families by weight × severity
 * truncate to ImpactBudget.maxEventsPerQuarter
 * truncate again once Σseverity would exceed ImpactBudget.maxTotalSeverity
 * → WorldEventCandidate[]
 * ```
 *
 * Hazard bookkeeping is ticked once per quarter at the top of the draw: cooldowns
 * count down and pending follow-on deltas lose a quarter of life. A delta pushed
 * later in the same quarter therefore survives intact into the next one, which is
 * what makes a cascade read as a consequence rather than as a coincidence.
 */

import type {
  EventHazardState,
  EventPrecondition,
  ImpactBudget,
  ResolverContext,
  SeededRng,
  SessionState,
  TargetPathScope,
  WorldEvent,
  WorldEventCandidate,
  WorldEventType,
  WorldModifier,
} from '@frontier/contracts';
import { IMPACT_BUDGET_BY_DIFFICULTY, getTargetPathSpec, makeId, slugify } from '@frontier/contracts';
import { EVENT_FAMILY_DEFINITIONS, eventFamilyById, type EventFamilyDefinition } from './eventFamilies';
import { buildTargetPathScope } from './scope';
import { clamp, clamp01, lerp, round, weightedPick } from './util';
import { resolveTargetPath } from '../targetPaths';

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

/** The impact budget for a session, from its difficulty. */
export function budgetFor(state: SessionState): ImpactBudget {
  const table: Record<string, ImpactBudget | undefined> = IMPACT_BUDGET_BY_DIFFICULTY;
  return table[state.config.difficulty] ?? IMPACT_BUDGET_BY_DIFFICULTY.standard;
}

/**
 * The largest operand one modifier may carry on a given path.
 *
 * `ImpactBudget.maxSingleModifierMagnitude` is written for normalised 0..1
 * variables: it caps `|value|` for `add` and `|value - 1|` for `multiply`. A
 * reputation is a 0..100 score, so the additive cap is scaled by the path's own
 * span — 0.35 of a 100-point range is 35 points, not 0.35 of a point. Paths whose
 * span is 1 or less keep the literal cap.
 */
export function magnitudeCap(path: string, operation: 'add' | 'multiply' | 'set', budget: ImpactBudget): number {
  if (operation === 'multiply') return budget.maxSingleModifierMagnitude;
  const spec = getTargetPathSpec(path);
  const span = spec === null ? 1 : Math.max(1, spec.max - spec.min);
  return budget.maxSingleModifierMagnitude * span;
}

/** Clamp an operand to the impact budget. Returns the value and whether it moved. */
export function clampOperandToBudget(
  path: string,
  operation: 'add' | 'multiply' | 'set',
  value: number,
  budget: ImpactBudget,
): { value: number; clamped: boolean } {
  if (!Number.isFinite(value)) return { value: operation === 'multiply' ? 1 : 0, clamped: true };
  const cap = magnitudeCap(path, operation, budget);
  if (operation === 'multiply') {
    const bounded = clamp(value, 1 - cap, 1 + cap);
    return { value: bounded, clamped: bounded !== value };
  }
  const bounded = clamp(value, -cap, cap);
  return { value: bounded, clamped: bounded !== value };
}

/* -------------------------------------------------------------------------- */
/*  Hazard state                                                               */
/* -------------------------------------------------------------------------- */

/** Create any missing per-family hazard state. Idempotent. */
export function ensureHazardStates(draft: SessionState): void {
  for (const def of EVENT_FAMILY_DEFINITIONS) {
    const existing = draft.eventHazards[def.family.id];
    if (existing !== undefined) continue;
    draft.eventHazards[def.family.id] = {
      familyId: def.family.id,
      baseHazard: def.family.baseHazard,
      currentHazard: def.family.baseHazard,
      cooldownRemaining: 0,
      lastFiredQuarter: null,
      pendingDeltas: [],
    };
  }
}

/** `baseHazard + Σ pendingDeltas`, clamped into 0..1. */
export function currentHazard(state: EventHazardState): number {
  let total = state.baseHazard;
  for (const delta of state.pendingDeltas) {
    if (delta.remainingQuarters > 0) total += delta.amount;
  }
  return clamp01(total);
}

/**
 * Advance hazard bookkeeping into the quarter being resolved: decrement
 * cooldowns, age pending deltas, drop the exhausted ones and recompute
 * `currentHazard`.
 */
export function tickHazardStates(draft: SessionState): void {
  ensureHazardStates(draft);
  for (const def of EVENT_FAMILY_DEFINITIONS) {
    const state = draft.eventHazards[def.family.id];
    if (state === undefined) continue;
    state.baseHazard = def.family.baseHazard;
    state.cooldownRemaining = Math.max(0, state.cooldownRemaining - 1);
    state.pendingDeltas = state.pendingDeltas
      .map((delta) => ({ ...delta, remainingQuarters: Math.max(0, delta.remainingQuarters - 1) }))
      .filter((delta) => delta.remainingQuarters > 0);
    state.currentHazard = currentHazard(state);
  }
}

/** Evaluate one data-expressed precondition against the world. */
export function preconditionHolds(scope: TargetPathScope, condition: EventPrecondition): boolean {
  const value = resolveTargetPath(scope, condition.path);
  if (value === null) return false;
  return condition.op === 'gt' ? value > condition.value : value < condition.value;
}

/** Why a family was not drawn this quarter. Diagnostics only; never an input. */
export interface FamilyDrawDiagnostic {
  readonly familyId: string;
  readonly hazard: number;
  readonly eligible: boolean;
  readonly reason: string;
  readonly roll: number | null;
  readonly fired: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Candidate drawing                                                          */
/* -------------------------------------------------------------------------- */

interface DrawnFamily {
  readonly def: EventFamilyDefinition;
  readonly severity: number;
  readonly hazard: number;
  readonly roll: number;
}

export interface CandidateDraw {
  readonly candidates: WorldEventCandidate[];
  readonly diagnostics: FamilyDrawDiagnostic[];
  readonly severityUsed: number;
}

/**
 * The recent event that raised this family's hazard, if any. Largest
 * contributing delta wins; ties break on the event id so the choice is stable.
 */
function causalParentFor(state: EventHazardState): string | null {
  let best: { id: string; amount: number } | null = null;
  for (const delta of state.pendingDeltas) {
    if (delta.sourceEventId === null || delta.remainingQuarters <= 0 || delta.amount <= 0) continue;
    if (best === null || delta.amount > best.amount || (delta.amount === best.amount && delta.sourceEventId < best.id)) {
      best = { id: delta.sourceEventId, amount: delta.amount };
    }
  }
  return best === null ? null : best.id;
}

/**
 * Run the whole draw for one quarter.
 *
 * The RNG stream is forked per quarter so the sequence is stable whether or not
 * the caller has drawn from the subsystem stream elsewhere first.
 */
export function drawCandidates(draft: SessionState, quarter: number, rngIn: SeededRng, budget: ImpactBudget): CandidateDraw {
  const rng = rngIn.fork(`hazard_q${quarter}`);
  const scope = buildTargetPathScope(draft);
  const diagnostics: FamilyDrawDiagnostic[] = [];
  const fired: DrawnFamily[] = [];

  for (const def of EVENT_FAMILY_DEFINITIONS) {
    const state = draft.eventHazards[def.family.id];
    if (state === undefined) continue;
    const hazard = currentHazard(state);

    if (state.cooldownRemaining > 0) {
      diagnostics.push({ familyId: def.family.id, hazard, eligible: false, reason: `cooldown ${state.cooldownRemaining}`, roll: null, fired: false });
      continue;
    }
    const failing = def.family.preconditions.find((condition) => !preconditionHolds(scope, condition));
    if (failing !== undefined) {
      diagnostics.push({
        familyId: def.family.id,
        hazard,
        eligible: false,
        reason: `precondition ${failing.path} ${failing.op} ${failing.value}`,
        roll: null,
        fired: false,
      });
      continue;
    }

    const roll = rng.next();
    if (roll >= hazard) {
      diagnostics.push({ familyId: def.family.id, hazard, eligible: true, reason: 'did not fire', roll, fired: false });
      continue;
    }

    // Severity is uniform inside the family's range, biased upward by how far
    // the hazard has been pushed above its baseline: a family fired by a cascade
    // lands harder than the same family firing out of nowhere.
    const headroom = clamp01((hazard - state.baseHazard) / Math.max(state.baseHazard, 0.02));
    const uniform = clamp01(rng.next());
    const biased = Math.pow(uniform, 1 / (1 + headroom));
    const [minSeverity, maxSeverity] = def.family.severityRange;
    const severity = clamp01(round(lerp(minSeverity, maxSeverity, biased), 4));

    diagnostics.push({ familyId: def.family.id, hazard, eligible: true, reason: 'fired', roll, fired: true });
    fired.push({ def, severity, hazard, roll });
  }

  // Rank by weight × severity; ties break on family id so the order is stable.
  const ranked = fired.slice().sort((a, b) => {
    const scoreDiff = b.def.family.weight * b.severity - a.def.family.weight * a.severity;
    if (scoreDiff !== 0) return scoreDiff;
    return a.def.family.id < b.def.family.id ? -1 : a.def.family.id > b.def.family.id ? 1 : 0;
  });

  const accepted: DrawnFamily[] = [];
  let severityUsed = 0;
  for (const entry of ranked) {
    if (accepted.length >= budget.maxEventsPerQuarter) break;
    const contradicts = accepted.some(
      (other) =>
        other.def.family.incompatibleFamilyIds.includes(entry.def.family.id) || entry.def.family.incompatibleFamilyIds.includes(other.def.family.id),
    );
    if (contradicts) continue;
    if (severityUsed + entry.severity > budget.maxTotalSeverity) continue;
    accepted.push(entry);
    severityUsed += entry.severity;
  }

  const sectorIds = new Set(Object.keys(draft.sectors));
  const candidates: WorldEventCandidate[] = accepted.map((entry) => {
    const state = draft.eventHazards[entry.def.family.id];
    const readings = entry.def.suggestedTargetPaths
      .map((path) => {
        const value = resolveTargetPath(scope, path);
        if (value === null) return null;
        return { path, value: round(value, 5), label: getTargetPathSpec(path)?.description ?? path };
      })
      .filter((reading): reading is { path: string; value: number; label: string } => reading !== null);

    return {
      candidateId: makeId('cand', draft.sessionId, quarter, entry.def.family.id),
      familyId: entry.def.family.id,
      familyLabel: entry.def.family.label,
      allowedTypes: [...entry.def.family.allowedTypes],
      severityBand: [entry.def.family.severityRange[0], entry.def.family.severityRange[1]],
      suggestedSeverity: entry.severity,
      defaultVisibility: entry.def.family.defaultVisibility,
      maxDurationQuarters: clamp(entry.def.family.defaultDurationQuarters, 1, 12),
      causalParentId: state === undefined ? null : causalParentFor(state),
      suggestedTargetPaths: [...entry.def.suggestedTargetPaths],
      relevantWorldReadings: readings,
      affectedSectorIds: entry.def.affectedSectorIds.filter((id) => sectorIds.has(id)),
    };
  });

  return { candidates, diagnostics, severityUsed: round(severityUsed, 4) };
}

/* -------------------------------------------------------------------------- */
/*  Firing consequences                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Record that a family fired: start its cooldown and push its follow-on hazards
 * onto the families it makes more likely. A family raises the *probability* of
 * related families; it never forces them.
 */
export function registerFiring(draft: SessionState, familyId: string, eventId: string, quarter: number): void {
  const def = eventFamilyById(familyId);
  if (def === null) return;
  ensureHazardStates(draft);

  const own = draft.eventHazards[familyId];
  if (own !== undefined) {
    own.cooldownRemaining = clamp(def.family.cooldownQuarters, 0, 24);
    own.lastFiredQuarter = quarter;
    own.currentHazard = currentHazard(own);
  }

  for (const followOn of def.family.followOnHazards) {
    const target = draft.eventHazards[followOn.familyId];
    if (target === undefined) continue;
    target.pendingDeltas = [
      ...target.pendingDeltas,
      {
        amount: clamp(followOn.hazardDelta, -1, 1),
        remainingQuarters: clamp(followOn.decayQuarters, 0, 16),
        sourceEventId: eventId,
      },
    ];
    target.currentHazard = currentHazard(target);
  }
}

/* -------------------------------------------------------------------------- */
/*  Company-scoped subjects                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the company a company-scoped family lands on.
 *
 * `concentration` weights by scale and acquisitiveness — the family that punishes
 * a consolidation strategy should find the consolidator. `incident` weights by
 * exposure: thin operations headcount against serving load, stretched compute
 * utilisation and weak public standing. The event that results is public; the
 * reason the company was selected never is.
 */
export function selectCompanySubject(draft: SessionState, rule: 'concentration' | 'incident', rng: SeededRng): string | null {
  const active = draft.companies.filter((company) => company.isActive);
  if (active.length === 0) return null;

  const metricsById = new Map(draft.companyMetrics.map((metric) => [metric.companyId, metric]));
  const entries = active.map((company) => {
    const metrics = metricsById.get(company.id);
    if (rule === 'concentration') {
      const scale = Math.log10(Math.max(1e6, metrics?.enterpriseValueUsd ?? metrics?.marketCapUsd ?? company.financials.revenueQuarterly * 8 + 1e6));
      const subsidiaries = draft.companies.filter((other) => other.parentCompanyId === company.id).length;
      return { item: company.id, weight: Math.max(0.01, scale - 5) * (1 + 0.5 * subsidiaries) };
    }
    const headcount =
      company.employees.engineers + company.employees.researchers + company.employees.sales + company.employees.ops + company.employees.execs;
    const opsShare = headcount > 0 ? company.employees.ops / headcount : 0;
    const thinOps = clamp01(0.18 - opsShare) / 0.18;
    const stretched = clamp01(company.compute.computeUtilisation);
    const weakStanding = clamp01(1 - company.reputation.public / 100);
    return { item: company.id, weight: 0.05 + 0.5 * thinOps + 0.3 * stretched + 0.2 * weakStanding };
  });

  return weightedPick(rng, entries);
}

/* -------------------------------------------------------------------------- */
/*  Deterministic materialisation (the no-LLM path)                            */
/* -------------------------------------------------------------------------- */

export interface MaterialisedEvent {
  readonly event: WorldEvent;
  readonly modifiers: WorldModifier[];
  /** Company the event names, when the family is company-scoped. */
  readonly subjectCompanyId: string | null;
  /** True when the family fired in its negative direction (bidirectional families only). */
  readonly negativeDirection: boolean;
}

/** Flip a template operand for a bidirectional family firing the other way. */
function flipOperand(operation: 'add' | 'multiply' | 'set', value: number): number {
  if (operation === 'multiply') return value === 0 ? 1 : 1 / value;
  return -value;
}

/**
 * Turn a candidate into a real event and its default modifiers, with no model in
 * the loop.
 *
 * This is the failure-mode path from `docs/SIMULATION.md` §10: when the World
 * Director is unavailable the quarter still has weather, it just has less
 * character. It is also the reference implementation of what a family's template
 * consequences mean, and it is fully deterministic given the state and the seed.
 */
export function materialiseCandidate(draft: SessionState, candidate: WorldEventCandidate, ctx: ResolverContext): MaterialisedEvent | null {
  const def = eventFamilyById(candidate.familyId);
  if (def === null) return null;

  const rng = ctx.rng.fork(`materialise_${candidate.candidateId}`);
  const budget = budgetFor(draft);
  const [bandMin, bandMax] = candidate.severityBand;
  const severity = clamp(candidate.suggestedSeverity, Math.min(bandMin, bandMax), Math.max(bandMin, bandMax));
  const position = bandMax > bandMin ? (severity - bandMin) / (bandMax - bandMin) : 0;

  const negativeDirection = def.bidirectional ? rng.next() < 0.5 : false;
  const subjectCompanyId = def.companyScope === 'none' ? null : selectCompanySubject(draft, def.companyScope, rng);
  const subjectCompany = subjectCompanyId === null ? null : draft.companies.find((company) => company.id === subjectCompanyId) ?? null;

  const firstType: WorldEventType = candidate.allowedTypes[0] ?? 'other';
  const eventId = makeId('wev', draft.sessionId, ctx.quarter, def.family.id);
  const directionText = def.bidirectional ? (negativeDirection ? ' The move is to the downside.' : ' The move is to the upside.') : '';
  const subjectText = subjectCompany === null ? '' : ` ${subjectCompany.name} is named directly.`;
  const sectorText = candidate.affectedSectorIds.length > 0 ? ` Sectors in scope: ${candidate.affectedSectorIds.join(', ')}.` : '';

  const event: WorldEvent = {
    id: eventId,
    familyId: def.family.id,
    type: firstType,
    titleKey: slugify(def.family.label) || 'world_event',
    title: def.family.label.slice(0, 120),
    description: `${def.family.description}${directionText}${subjectText}${sectorText}`.slice(0, 1200),
    severity,
    visibility: candidate.defaultVisibility,
    durationQuarters: clamp(candidate.maxDurationQuarters, 1, 12),
    causalParentId: candidate.causalParentId,
    quarter: ctx.quarter,
    affectedSectorIds: [...candidate.affectedSectorIds],
    affectedCompanyIds: subjectCompanyId === null ? [] : [subjectCompanyId],
  };

  const modifiers: WorldModifier[] = [];
  for (const template of def.modifierTemplates) {
    if (modifiers.length >= budget.maxModifiersPerEvent) break;
    if (template.target.includes('{companyId}')) {
      if (subjectCompanyId === null) continue;
    }
    const target = template.target.replace('{companyId}', subjectCompanyId ?? '');
    const rawValue = lerp(template.low, template.high, position);
    const directed = negativeDirection ? flipOperand(template.operation, rawValue) : rawValue;
    const { value } = clampOperandToBudget(target, template.operation, directed, budget);
    modifiers.push({
      id: makeId('mod', `q${ctx.quarter}`, def.family.id, modifiers.length),
      source: 'event',
      target,
      operation: template.operation,
      value: round(value, 6),
      decay: template.decay,
      durationQuarters: clamp(template.durationQuarters, 1, 12),
      remainingQuarters: clamp(template.durationQuarters, 1, 12),
      appliedAtQuarter: ctx.quarter,
      originEventId: eventId,
      reason: template.reason.slice(0, 240),
    });
  }

  return { event, modifiers, subjectCompanyId, negativeDirection };
}

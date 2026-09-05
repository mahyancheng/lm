/**
 * @frontier/simulation — markets/beliefs.ts
 *
 * What the market thinks, and the only legal ways for it to change its mind.
 *
 * **The truth-versus-belief boundary is enforced here by construction.** This
 * module reads exactly four things:
 *
 * 1. `disclosures` — the public information set;
 * 2. `activeEvents` whose visibility has actually reached the public;
 * 3. `world.media.institutionalTrust` — how far an unattributed claim travels;
 * 4. `characters[].connectionLevel` — the public standing of a named source.
 *
 * It never reads `companies`, `researchProjects`, `governmentContracts` or any
 * other canonical private state. A model programme that is two quarters late and
 * 31% over budget moves the share price only when the information set changes,
 * through disclosure, leak, rumour or results that contradict prior guidance.
 * That gap is the game.
 *
 * ```text
 * weight = credibility × sourceStanding × topicRelevance × institutionalTrust adj
 * belief = clamp01(belief × (1 − weight) + asserted × weight)
 * ```
 */

import type {
  MarketBelief,
  MarketBeliefTopic,
  PublicDisclosure,
  SessionState,
  WorldEvent,
} from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { clamp01, round } from '../economy/util';

/* -------------------------------------------------------------------------- */
/*  Topic metadata                                                             */
/* -------------------------------------------------------------------------- */

export interface TopicMeta {
  /** True when believing the topic is bad news for the subject. */
  readonly adverse: boolean;
  /** Where an unrefreshed belief drifts back to. */
  readonly baseRate: number;
  /** Fractional return per unit of belief change. Consumed by the pricing model. */
  readonly priceImpact: number;
}

export const TOPIC_META: Record<MarketBeliefTopic, TopicMeta> = {
  model_delay: { adverse: true, baseRate: 0.2, priceImpact: -0.18 },
  model_success: { adverse: false, baseRate: 0.3, priceImpact: 0.15 },
  revenue_beat: { adverse: false, baseRate: 0.3, priceImpact: 0.14 },
  revenue_miss: { adverse: true, baseRate: 0.2, priceImpact: -0.16 },
  margin_pressure: { adverse: true, baseRate: 0.25, priceImpact: -0.1 },
  contract_win: { adverse: false, baseRate: 0.25, priceImpact: 0.12 },
  contract_loss: { adverse: true, baseRate: 0.2, priceImpact: -0.1 },
  fundraise_needed: { adverse: true, baseRate: 0.25, priceImpact: -0.12 },
  acquisition_target: { adverse: false, baseRate: 0.15, priceImpact: 0.2 },
  acquisition_acquirer: { adverse: false, baseRate: 0.15, priceImpact: -0.05 },
  regulatory_action: { adverse: true, baseRate: 0.2, priceImpact: -0.1 },
  leadership_change: { adverse: true, baseRate: 0.15, priceImpact: -0.06 },
  safety_incident: { adverse: true, baseRate: 0.12, priceImpact: -0.15 },
  accounting_concern: { adverse: true, baseRate: 0.1, priceImpact: -0.22 },
  talent_exodus: { adverse: true, baseRate: 0.18, priceImpact: -0.09 },
};

/** How much of a belief one disclosure may ever move. Nothing is ever certain. */
const MAX_UPDATE_WEIGHT = 0.85;

/** Speed at which an unrefreshed belief returns to its base rate. */
const BELIEF_DECAY = 0.12;

/** Which world event types move which belief, and how hard. */
const EVENT_TOPIC_MAP: Record<string, { topic: MarketBeliefTopic; direction: 1 | -1 }> = {
  regulatory_action: { topic: 'regulatory_action', direction: 1 },
  export_control: { topic: 'regulatory_action', direction: 1 },
  antitrust_investigation: { topic: 'regulatory_action', direction: 1 },
  copyright_ruling: { topic: 'regulatory_action', direction: 1 },
  privacy_enforcement: { topic: 'regulatory_action', direction: 1 },
  standards_change: { topic: 'regulatory_action', direction: 1 },
  safety_incident: { topic: 'safety_incident', direction: 1 },
  cyber_incident: { topic: 'safety_incident', direction: 1 },
  corporate_scandal: { topic: 'safety_incident', direction: 1 },
  model_breakthrough: { topic: 'model_success', direction: 1 },
  benchmark_result: { topic: 'model_success', direction: 1 },
  open_source_release: { topic: 'margin_pressure', direction: 1 },
  research_disappointment: { topic: 'model_delay', direction: 1 },
  fund_collapse: { topic: 'fundraise_needed', direction: 1 },
  credit_event: { topic: 'fundraise_needed', direction: 1 },
  ipo_window_change: { topic: 'fundraise_needed', direction: -1 },
  consolidation_wave: { topic: 'acquisition_target', direction: 1 },
  talent_shock: { topic: 'talent_exodus', direction: 1 },
  procurement_programme: { topic: 'contract_win', direction: 1 },
  defence_mobilisation: { topic: 'contract_win', direction: 1 },
};

/* -------------------------------------------------------------------------- */
/*  Update                                                                     */
/* -------------------------------------------------------------------------- */

export interface BeliefChange {
  readonly belief: MarketBelief;
  readonly before: number;
  readonly after: number;
  readonly weight: number;
  readonly source: 'disclosure' | 'public_event' | 'reversion';
  readonly evidenceId: string | null;
}

/**
 * The probability a disclosure asserts for its topic.
 *
 * An explicit `probability` metric wins. Otherwise the kind decides: an
 * unattributed leak or rumour alleges the thing is true; a company on the record
 * denies an adverse topic and affirms a favourable one; an analyst note lands in
 * between.
 */
export function assertedProbability(disclosure: PublicDisclosure, topic: MarketBeliefTopic): number {
  const explicit = disclosure.metrics['probability'] ?? disclosure.metrics['assertedProbability'];
  if (explicit !== undefined && Number.isFinite(explicit)) return clamp01(explicit);
  const meta = TOPIC_META[topic];
  switch (disclosure.kind) {
    case 'leak':
    case 'rumour':
      return 0.8;
    case 'analyst_note':
      return meta.adverse ? 0.55 : 0.5;
    case 'guidance':
    case 'earnings':
    case 'press_release':
    case 'regulatory_filing':
      return meta.adverse ? 0.12 : 0.75;
    default:
      return 0.5;
  }
}

/** Public standing of the source, 0..1. Anonymous sources sit mid-scale. */
function sourceStanding(state: SessionState, disclosure: PublicDisclosure): number {
  if (disclosure.sourceCharacterId === null) return 0.7;
  const character = state.characters.find((candidate) => candidate.id === disclosure.sourceCharacterId);
  if (character === undefined) return 0.7;
  return clamp01(0.6 + 0.4 * (character.connectionLevel / 100));
}

/**
 * Low institutional trust makes rumours travel further than corrections — which
 * is `world.media.institutionalTrust` doing exactly what it says on the tin.
 */
function trustAdjustment(state: SessionState, disclosure: PublicDisclosure): number {
  const trust = clamp01(state.world.media.institutionalTrust);
  const unattributed = disclosure.kind === 'leak' || disclosure.kind === 'rumour';
  return unattributed ? 1.15 - 0.3 * trust : 0.85 + 0.3 * trust;
}

function findOrCreateBelief(
  state: SessionState,
  subjectId: string,
  subjectKind: MarketBelief['subjectKind'],
  topic: MarketBeliefTopic,
  quarter: number,
): MarketBelief {
  const existing = state.beliefs.find((belief) => belief.subjectId === subjectId && belief.topic === topic);
  if (existing !== undefined) return existing;
  const created: MarketBelief = {
    id: makeId('blf', subjectId, topic),
    subjectId,
    subjectKind,
    topic,
    probability: TOPIC_META[topic].baseRate,
    priorProbability: TOPIC_META[topic].baseRate,
    lastUpdatedQuarter: quarter,
    evidenceDisclosureIds: [],
  };
  state.beliefs = [...state.beliefs, created];
  return created;
}

function moveBelief(belief: MarketBelief, asserted: number, weight: number, quarter: number, evidenceId: string | null): { before: number; after: number } {
  const before = clamp01(belief.probability);
  const w = clamp01(weight);
  const after = clamp01(before * (1 - w) + clamp01(asserted) * w);
  belief.priorProbability = before;
  belief.probability = round(after, 6);
  belief.lastUpdatedQuarter = quarter;
  if (evidenceId !== null) {
    belief.evidenceDisclosureIds = [evidenceId, ...belief.evidenceDisclosureIds.filter((id) => id !== evidenceId)].slice(0, 8);
  }
  return { before, after: belief.probability };
}

/** Events the public actually learned about this quarter. */
function publicEventsThisQuarter(state: SessionState, quarter: number): WorldEvent[] {
  return state.activeEvents.filter((event) => event.quarter === quarter && (event.visibility === 'public' || event.visibility === 'sector'));
}

/**
 * Move every belief in response to this quarter's public information.
 *
 * Mutates `state.beliefs` and returns one record per material move, so the
 * caller can emit `belief_updated` and put the big ones in the report.
 */
export function runBeliefUpdate(state: SessionState, quarter: number): BeliefChange[] {
  const changes: BeliefChange[] = [];
  const touched = new Set<string>();

  const disclosures = state.disclosures
    .filter((disclosure) => disclosure.quarter === quarter && disclosure.beliefTopic !== null)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const disclosure of disclosures) {
    const topic = disclosure.beliefTopic;
    if (topic === null) continue;
    const subjectId = disclosure.companyId ?? 'world';
    const subjectKind: MarketBelief['subjectKind'] = disclosure.companyId === null ? 'world' : 'company';
    const belief = findOrCreateBelief(state, subjectId, subjectKind, topic, quarter);

    const weight = clamp01(clamp01(disclosure.credibility) * sourceStanding(state, disclosure) * trustAdjustment(state, disclosure)) * MAX_UPDATE_WEIGHT;
    const { before, after } = moveBelief(belief, assertedProbability(disclosure, topic), weight, quarter, disclosure.id);
    touched.add(belief.id);
    if (Math.abs(after - before) > 1e-6) {
      changes.push({ belief, before, after, weight: round(weight, 4), source: 'disclosure', evidenceId: disclosure.id });
    }
  }

  for (const event of publicEventsThisQuarter(state, quarter)) {
    const mapping = EVENT_TOPIC_MAP[event.type];
    if (mapping === undefined) continue;
    const subjects: { id: string; kind: MarketBelief['subjectKind'] }[] =
      event.affectedCompanyIds.length > 0
        ? event.affectedCompanyIds.map((id) => ({ id, kind: 'company' as const }))
        : [{ id: 'world', kind: 'world' as const }];

    for (const subject of subjects) {
      const belief = findOrCreateBelief(state, subject.id, subject.kind, mapping.topic, quarter);
      const weight = clamp01(0.2 + 0.45 * event.severity);
      const asserted = mapping.direction === 1 ? clamp01(0.5 + 0.5 * event.severity) : clamp01(0.5 - 0.5 * event.severity);
      const { before, after } = moveBelief(belief, asserted, weight, quarter, null);
      touched.add(belief.id);
      if (Math.abs(after - before) > 1e-6) {
        changes.push({ belief, before, after, weight: round(weight, 4), source: 'public_event', evidenceId: event.id });
      }
    }
  }

  // Anything nobody corroborated this quarter drifts back toward its base rate.
  // An uncorroborated rumour fades; it does not become permanent knowledge.
  for (const belief of state.beliefs) {
    if (touched.has(belief.id)) continue;
    const meta = TOPIC_META[belief.topic];
    if (meta === undefined) continue;
    const before = clamp01(belief.probability);
    const after = round(clamp01(before + BELIEF_DECAY * (meta.baseRate - before)), 6);
    if (Math.abs(after - before) <= 1e-6) continue;
    belief.priorProbability = before;
    belief.probability = after;
    belief.lastUpdatedQuarter = quarter;
    changes.push({ belief, before, after, weight: BELIEF_DECAY, source: 'reversion', evidenceId: null });
  }

  return changes;
}

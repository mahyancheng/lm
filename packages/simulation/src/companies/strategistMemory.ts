/**
 * @frontier/simulation — companies/strategistMemory.ts
 *
 * The engine writes what a company remembers.
 *
 * A rival's personality does not need a model transcript that lives for forty
 * quarters and is silently compacted by somebody else's summariser. It needs
 * three bounded facts, and the engine already knows all three:
 *
 * - **Grudges** — who has wronged this company, why, and how much it still
 *   rankles. Every one of them traces to something that actually happened: a
 *   memory the relationships subsystem stored (a poaching approach, a lost
 *   competition, a broken deal, a public attack, a boardroom betrayal, a deal
 *   turned down) or a ledger row written this quarter (predatory pricing into
 *   this company's segment, a supply line closed to it, a stake crossing a
 *   disclosure threshold, an activist letter). A grudge is never model output.
 * - **Attempts** — what this company tried and what the world did with it: the
 *   validator's refusals and reductions, and the shortfalls the resolver wrote
 *   as partial fills. Asked for forty engineers, got six.
 * - **A standing strategy** — one sentence derived from the archetype policy
 *   and the posture, rewritten only when the posture actually changes.
 *
 * ## Why the engine and not the model
 *
 * Determinism. This is a pure function of the committed quarters: the same
 * recorded decisions and the same seed reconstruct the same memory byte for
 * byte, so a replayed save carries the same rival personalities it had the
 * first time. It also costs nothing — no tokens, no wall clock, and no
 * behaviour that changes when the model is unavailable.
 *
 * ## What is derived rather than duplicated
 *
 * The relationships subsystem is already the record of how people feel:
 * `draft.memories` says what happened between two characters and
 * `draft.relationships` says what it did to them. Grudges are *derived* from
 * those and never contradict them — the trigger is a memory dated this quarter,
 * and the intensity is scaled by the hostility that memory's owner already
 * carries toward the counterparty's chief executive. Nothing here writes a
 * memory or moves a relationship: this module reads that record and projects it
 * onto the company, one quarter behind nothing.
 *
 * The four ledger triggers are the additions: predation, supply cut-offs,
 * stake-building and activist campaigns move companies rather than people, and
 * the relationships subsystem stores nothing for any of them.
 *
 * ## Bounds
 *
 * Six grudges, eight attempts, three attempts recorded per quarter, and a
 * standing strategy of at most 240 characters. Both arrays are trimmed
 * oldest-first, so a forty-quarter campaign cannot grow this and no compaction
 * step is ever needed.
 *
 * Determinism note: no RNG, no clock, no `Math.random`. Companies are walked in
 * array order, ledger rows in sequence order, and every tie breaks on an id.
 */

import type {
  Company,
  Memory,
  MemoryKind,
  ResolverContext,
  SessionState,
  SimEvent,
  StrategistAttempt,
  StrategistGrudge,
  StrategistMemory,
} from '@frontier/contracts';
import {
  MAX_ATTEMPT_OUTCOME_CHARS,
  MAX_ATTEMPT_WHAT_CHARS,
  MAX_GRUDGE_REASON_CHARS,
  MAX_STANDING_STRATEGY_CHARS,
  MAX_STRATEGIST_ATTEMPTS,
  MAX_STRATEGIST_GRUDGES,
  MEMORY_RECALL_THRESHOLD,
} from '@frontier/contracts';
import { effectivePolicy } from './archetypes';
import { activeCompanies, clamp, emitEvent } from './util';
import { ceoOf } from '../relationships/relations';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Points a grudge loses every quarter it is not repeated.
 *
 * Four points a quarter means a single slight at the standard intensity is
 * spent within two years and a repeated one never is — which is the whole
 * behaviour being bought: a company that was wronged once eventually lets it
 * go, and a company that is wronged every quarter does not.
 */
export const GRUDGE_DECAY_PER_QUARTER = 4;

/** Attempts recorded in one quarter, so one bad quarter cannot flush the record. */
export const MAX_ATTEMPTS_PER_QUARTER = 3;

/**
 * What each trigger is worth at neutral hostility, before the reinforcement of
 * a repeat. A betrayal outweighs a rejected term sheet by design.
 */
export const GRUDGE_BASE_INTENSITY = {
  betrayal: 45,
  deal_broken: 40,
  supply_cut_off: 35,
  poach: 30,
  board_vote: 30,
  activist_letter: 30,
  predatory_pricing: 30,
  contract_loss: 25,
  public_attack: 25,
  stake_built: 20,
  negotiation: 15,
} as const;

export type GrudgeCause = keyof typeof GRUDGE_BASE_INTENSITY;

/** Memory kinds that become a grudge when the memory is a negative one. */
const MEMORY_CAUSES: Partial<Record<MemoryKind, GrudgeCause>> = {
  betrayal: 'betrayal',
  deal_broken: 'deal_broken',
  poach: 'poach',
  board_vote: 'board_vote',
  contract_loss: 'contract_loss',
  public_attack: 'public_attack',
  negotiation: 'negotiation',
};

/* -------------------------------------------------------------------------- */
/*  Result                                                                     */
/* -------------------------------------------------------------------------- */

/** What one pass wrote, for the report, the tests and nothing else. */
export interface StrategistMemoryUpdate {
  readonly companiesWritten: number;
  readonly grudgesOpened: number;
  readonly grudgesReinforced: number;
  readonly grudgesForgotten: number;
  readonly grudgesTrimmed: number;
  readonly attemptsRecorded: number;
  readonly attemptsTrimmed: number;
  readonly strategiesRestated: number;
}

/* -------------------------------------------------------------------------- */
/*  The standing strategy                                                      */
/* -------------------------------------------------------------------------- */

const ARCHETYPE_LABEL: Record<Company['archetype'], string> = {
  frontier_lab: 'A frontier lab',
  enterprise_ai: 'An enterprise software company',
  consumer_ai: 'A consumer company',
  infrastructure: 'An infrastructure builder',
  chip_maker: 'A chip maker',
  cloud: 'A capacity operator',
  data: 'A data business',
  defence_ai: 'A defence supplier',
};

const POSTURE_CLAUSE: Record<Company['posture'], string> = {
  aggressive_growth: 'spending ahead of revenue to take the share now',
  balanced: 'growing without breaking the margin',
  efficiency: 'protecting the margin before anything else',
  research_first: 'putting the frontier ahead of the quarter',
  land_grab: 'buying share with price and worrying about margin later',
  consolidation: 'buying what would take years to build',
  defensive: 'holding the accounts we already have',
  survival: 'preserving cash and staying alive',
};

const COMP_BAND_CLAUSE: Record<string, string> = {
  below_market: 'below market',
  market: 'at market',
  above_market: 'above market',
  top_of_market: 'at the top of the market',
};

/**
 * The sentence a company would give if asked what it is doing.
 *
 * Pure and derived: the same archetype and posture always produce the same
 * sentence, which is exactly what makes "rewrite only when the posture changes"
 * a comparison rather than a stored flag.
 */
export function standingStrategyFor(company: Company): string {
  const policy = effectivePolicy(company.archetype, company.posture);
  const government =
    policy.governmentAppetite >= 0.6
      ? 'we bid on every programme we are cleared for'
      : policy.governmentAppetite >= 0.3
        ? 'we take public work when it fits'
        : 'we leave procurement alone';
  const marketing = Math.round(policy.marketingRevenueShare * 100);
  const research = Math.round(policy.rdRevenueShare * 100);
  const role = policy.hiringPriority[0] ?? 'engineers';
  const pay = COMP_BAND_CLAUSE[policy.compBand] ?? 'at market';
  const sentence =
    `${ARCHETYPE_LABEL[company.archetype]} ${POSTURE_CLAUSE[company.posture]}. ` +
    `${marketing}% of revenue behind demand, ${research}% behind research, ${role} hired first and paid ${pay}, and ${government}.`;
  return sentence.slice(0, MAX_STANDING_STRATEGY_CHARS);
}

/* -------------------------------------------------------------------------- */
/*  Reading the quarter's ledger                                               */
/* -------------------------------------------------------------------------- */

/** One thing that happened to a company this quarter, before it becomes a grudge. */
interface Trigger {
  readonly againstId: string;
  readonly cause: GrudgeCause;
  readonly reason: string;
  /** Ledger sequence or memory position, to break ties in a stable order. */
  readonly order: number;
}

/**
 * One attempt a row describes, with the rank that decides which of a bad
 * quarter's rows earn its three slots: a shortfall (0) says more about what the
 * world will actually give this company than a refusal (1) does.
 */
interface RankedAttempt {
  readonly attempt: StrategistAttempt;
  readonly rank: 0 | 1;
  readonly order: number;
}

/** What the quarter's ledger says was done to whom, indexed once for every company. */
interface LedgerIndex {
  /** Companies whose pricing was flagged predatory this quarter. */
  readonly predators: ReadonlySet<string>;
  /** Victim company id -> triggers written against it. */
  readonly against: ReadonlyMap<string, Trigger[]>;
  /** Company id -> the attempts its own rows describe, shortfalls first. */
  readonly attempts: ReadonlyMap<string, RankedAttempt[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A plain-language reading of an action type, for an attempt nobody labelled. */
function phrase(intentType: string): string {
  return intentType.replace(/_/g, ' ');
}

/**
 * Walk this quarter's ledger once and index everything the memory needs.
 *
 * `events` is the recorder's row list for the quarter in emission order, which
 * is the order a replay produces, so every bucket below is deterministic.
 */
function indexLedger(draft: SessionState, quarter: number, events: readonly SimEvent[]): LedgerIndex {
  const predators = new Set<string>();
  const against = new Map<string, Trigger[]>();
  const attempts = new Map<string, RankedAttempt[]>();
  const companyIds = new Set(draft.companies.map((company) => company.id));

  events.forEach((event, order) => {
    if (event.quarter !== quarter) return;
    const payload = event.payload;

    switch (event.type) {
      case 'predatory_pricing_flagged': {
        const predator = text(payload.companyId, event.actorId ?? '');
        if (predator.length > 0) predators.add(predator);
        break;
      }

      // A supplier closing a line to a named buyer. The row is a staging row on
      // `cost_recognised` (it moves no money on its own), and the buyer is the
      // target, so the grudge lands on exactly the company that lost the input.
      case 'cost_recognised': {
        if (payload.kind !== 'supply_terms_changed') break;
        const supplier = event.actorId;
        const buyer = text(payload.buyerCompanyId, event.targetId ?? '');
        if (supplier === null || buyer.length === 0 || supplier === buyer) break;
        const supplierName = draft.companies.find((company) => company.id === supplier)?.name ?? supplier;
        push(against, buyer, {
          againstId: supplier,
          cause: 'supply_cut_off',
          reason: `${supplierName} closed a supply line to us and gave us a quarter's notice.`,
          order,
        });
        break;
      }

      // Somebody building a position in us.
      case 'ownership_threshold_crossed': {
        const holder = event.actorId;
        const target = event.targetId;
        if (holder === null || target === null || holder === target) break;
        if (!companyIds.has(target)) break;
        // A parent moving in its own subsidiary is not a slight against it.
        if (draft.companies.find((company) => company.id === target)?.parentCompanyId === holder) break;
        const holderName = draft.companies.find((company) => company.id === holder)?.name ?? holder;
        const threshold = text(payload.threshold, 'a disclosure').replace(/_/g, ' ');
        const decisive = payload.grantsControl === true;
        push(against, target, {
          againstId: holder,
          cause: 'stake_built',
          reason: decisive
            ? `${holderName} took a controlling stake in us.`
            : `${holderName} crossed the ${threshold} threshold in our stock.`,
          order,
        });
        break;
      }

      case 'activist_campaign_opened': {
        const entity = event.actorId;
        const target = text(payload.targetCompanyId, event.targetId ?? '');
        if (entity === null || target.length === 0) break;
        const demands = Array.isArray(payload.demands)
          ? payload.demands.filter((demand): demand is string => typeof demand === 'string').join(' and ').replace(/_/g, ' ')
          : '';
        const name = draft.capitalEntities?.find((candidate) => candidate.id === entity)?.name ?? entity;
        push(against, target, {
          againstId: entity,
          cause: 'activist_letter',
          reason: `${name} wrote to our board demanding ${demands.length > 0 ? demands : 'changes'}.`,
          order,
        });
        break;
      }

      // What we asked for against what the world gave us.
      case 'information_revealed': {
        if (payload.kind !== 'partial_fill' || event.actorId === null) break;
        const asked = number(payload.asked);
        const got = number(payload.got);
        if (asked === null || got === null) break;
        const unit = text(payload.unit, 'units');
        push(attempts, event.actorId, {
          rank: 0,
          order,
          attempt: {
            quarter,
            what: `${phrase(text(payload.actionType, 'an instruction'))}: ${Math.round(asked)} ${unit}`.slice(0, MAX_ATTEMPT_WHAT_CHARS),
            outcome: `${Math.round(got)} of ${Math.round(asked)} ${unit} arrived. ${text(payload.reason, 'No reason recorded.')}`.slice(0, MAX_ATTEMPT_OUTCOME_CHARS),
          },
        });
        break;
      }

      // What the validator did with an instruction. Accepted actions are not
      // recorded: eight slots are worth more spent on what did not go to plan.
      case 'action_rejected':
      case 'action_clamped': {
        if (event.actorId === null) break;
        const intentType = text(payload.intentType, '');
        if (intentType.length === 0) break;
        const reasons = Array.isArray(payload.reasons)
          ? payload.reasons.filter((reason): reason is string => typeof reason === 'string')
          : [];
        const refused = event.type === 'action_rejected';
        push(attempts, event.actorId, {
          rank: 1,
          order,
          attempt: {
            quarter,
            what: phrase(intentType).slice(0, MAX_ATTEMPT_WHAT_CHARS),
            outcome: `${refused ? 'Refused' : 'Reduced'}: ${reasons[0] ?? 'no reason recorded'}`.slice(0, MAX_ATTEMPT_OUTCOME_CHARS),
          },
        });
        break;
      }

      default:
        break;
    }
  });

  return { predators, against, attempts };
}

/* -------------------------------------------------------------------------- */
/*  Reading what people already remember                                       */
/* -------------------------------------------------------------------------- */

/** The company a memory's subject belongs to, or null when it is nobody's. */
function subjectCompanyId(draft: SessionState, memory: Memory): string | null {
  if (draft.companies.some((company) => company.id === memory.aboutId)) return memory.aboutId;
  const character = draft.characters.find((candidate) => candidate.id === memory.aboutId);
  return character?.companyId ?? null;
}

/**
 * Grudges the relationships subsystem already justified: a negative memory the
 * chief executive stored *this quarter* about another company or its people.
 *
 * Dated this quarter deliberately. The memory itself decays on its own schedule
 * in `relationships/memory.ts`; a grudge decays on its own here. Re-reading the
 * whole memory table every quarter would apply both, and a betrayal would rot
 * at a rate nobody chose.
 */
function memoryTriggers(draft: SessionState, quarter: number, company: Company): Trigger[] {
  const ceo = ceoOf(draft, company.id);
  if (ceo === null) return [];
  const triggers: Trigger[] = [];

  draft.memories.forEach((memory, order) => {
    if (memory.quarter !== quarter || memory.ownerCharacterId !== ceo) return;
    if (memory.sentiment >= 0 || memory.strength < MEMORY_RECALL_THRESHOLD) return;
    const cause = MEMORY_CAUSES[memory.kind];
    if (cause === undefined) return;
    const againstId = subjectCompanyId(draft, memory);
    if (againstId === null || againstId === company.id) return;
    triggers.push({ againstId, cause, reason: memory.summary.slice(0, MAX_GRUDGE_REASON_CHARS), order });
  });

  return triggers;
}

/**
 * How hostile this company's chief executive already is toward the other side.
 *
 * The relationships subsystem is the record; this reads it rather than keeping a
 * second one. Zero when the two have never met, which is the neutral case for a
 * grudge against a company nobody here has ever spoken to.
 */
function hostilityToward(draft: SessionState, company: Company, againstId: string): number {
  const from = ceoOf(draft, company.id);
  if (from === null) return 0;
  const to = draft.companies.some((candidate) => candidate.id === againstId) ? ceoOf(draft, againstId) : againstId;
  if (to === null) return 0;
  const relationship = draft.relationships.find((candidate) => candidate.fromId === from && candidate.toId === to);
  return relationship?.hostility ?? 0;
}

/* -------------------------------------------------------------------------- */
/*  The writer                                                                 */
/* -------------------------------------------------------------------------- */

/** An empty memory, for a company nothing has happened to yet. */
function emptyMemory(quarter: number, company: Company): StrategistMemory {
  return { standingStrategy: standingStrategyFor(company), standingStrategyQuarter: quarter, grudges: [], attempts: [] };
}

/**
 * One trigger per counterparty — the strongest cause it gave this company this
 * quarter — returned in ledger order so two runs write the same grudges in the
 * same sequence.
 */
function strongestPerCounterparty(triggers: readonly Trigger[]): Trigger[] {
  const best = new Map<string, Trigger>();
  for (const trigger of triggers) {
    const held = best.get(trigger.againstId);
    if (held === undefined || GRUDGE_BASE_INTENSITY[trigger.cause] > GRUDGE_BASE_INTENSITY[held.cause]) {
      best.set(trigger.againstId, trigger);
    }
  }
  return [...best.values()].sort((a, b) => a.order - b.order || (a.againstId < b.againstId ? -1 : 1));
}

/**
 * Write every active company's bounded memory from the quarter that just
 * happened.
 *
 * Runs in `leaderboard_update`, after every economic phase and after
 * `relationship_update`, so the ledger is complete but for the commit and the
 * snapshot and the memories this quarter's events produced are all stored.
 *
 * `events` is the quarter's ledger rows in emission order. Nothing is read from
 * a plan, a proposal or a model: an instruction that was refused is remembered
 * as refused, and a slight is remembered only if a row says it happened.
 */
export function updateStrategistMemory(draft: SessionState, ctx: ResolverContext, events: readonly SimEvent[]): StrategistMemoryUpdate {
  const quarter = ctx.quarter;
  const ledger = indexLedger(draft, quarter, events);

  let companiesWritten = 0;
  let grudgesOpened = 0;
  let grudgesReinforced = 0;
  let grudgesForgotten = 0;
  let grudgesTrimmed = 0;
  let attemptsRecorded = 0;
  let attemptsTrimmed = 0;
  let strategiesRestated = 0;

  for (const company of activeCompanies(draft)) {
    const held = company.strategistMemory ?? emptyMemory(quarter, company);

    /* --- the standing strategy: only when the posture actually moved ------- */
    const strategy = standingStrategyFor(company);
    const restated = strategy !== held.standingStrategy;
    if (restated) strategiesRestated += 1;

    /* --- grudges: decay first, so a repeat is a rise on a fallen number ---- */
    const decayed = held.grudges.map((grudge) => ({
      ...grudge,
      intensity: Math.max(0, grudge.intensity - GRUDGE_DECAY_PER_QUARTER),
    }));

    const triggers = strongestPerCounterparty([
      ...memoryTriggers(draft, quarter, company),
      ...predationTriggers(draft, ledger, company),
      ...(ledger.against.get(company.id) ?? []).filter((trigger) => trigger.againstId !== company.id),
    ]);

    const grudges: StrategistGrudge[] = [...decayed];
    for (const trigger of triggers) {
      const base = intensityFor(trigger.cause, hostilityToward(draft, company, trigger.againstId));
      // Clipped here rather than at each trigger, so no reason a source writes
      // can produce a memory its own schema would refuse.
      const reason = trigger.reason.slice(0, MAX_GRUDGE_REASON_CHARS);
      const index = grudges.findIndex((grudge) => grudge.companyId === trigger.againstId);
      if (index === -1) {
        grudges.push({ companyId: trigger.againstId, reason, quarter, intensity: base });
        grudgesOpened += 1;
        continue;
      }
      const standing = grudges[index]!;
      grudges[index] = {
        companyId: trigger.againstId,
        reason,
        quarter,
        // A repeat raises the standing number by half of what a fresh one is
        // worth, and never leaves it below what a fresh one would have been.
        intensity: Math.min(100, Math.max(standing.intensity + Math.round(base / 2), base)),
      };
      grudgesReinforced += 1;
    }

    const remembered = grudges.filter((grudge) => grudge.intensity > 0);
    grudgesForgotten += grudges.length - remembered.length;
    // Oldest first, so the trim below drops the least recently repeated.
    remembered.sort((a, b) => a.quarter - b.quarter || a.intensity - b.intensity || (a.companyId < b.companyId ? -1 : 1));
    const keptGrudges = remembered.slice(Math.max(0, remembered.length - MAX_STRATEGIST_GRUDGES));
    grudgesTrimmed += remembered.length - keptGrudges.length;

    /* --- attempts: this quarter's shortfalls and refusals ------------------ */
    const fresh = (ledger.attempts.get(company.id) ?? [])
      .slice()
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, MAX_ATTEMPTS_PER_QUARTER)
      // Back into the order the quarter wrote them, so the record reads as the
      // quarter happened rather than as this ranking sorted it.
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.attempt);
    attemptsRecorded += fresh.length;
    const attempts: StrategistAttempt[] = [...held.attempts, ...fresh];
    const keptAttempts = attempts.slice(Math.max(0, attempts.length - MAX_STRATEGIST_ATTEMPTS));
    attemptsTrimmed += attempts.length - keptAttempts.length;

    const next: StrategistMemory = {
      standingStrategy: strategy,
      standingStrategyQuarter: restated ? quarter : held.standingStrategyQuarter,
      grudges: keptGrudges,
      attempts: keptAttempts,
    };

    // Every active company carries one: the memory is the record, and a rival
    // with nothing against anybody still has a standing strategy. Written only
    // when something in it actually moved, so a quiet quarter rewrites nothing.
    if (company.strategistMemory !== undefined && same(company.strategistMemory, next)) continue;

    company.strategistMemory = next;
    companiesWritten += 1;

    if (triggers.length > 0 || fresh.length > 0) {
      // A staging row: it carries a `kind`, moves no money and books nothing.
      // What a company privately concluded is company business, never public.
      emitEvent(
        draft,
        ctx,
        'information_revealed',
        company.id,
        null,
        {
          kind: 'strategist_memory',
          grudges: next.grudges.map((grudge) => ({ companyId: grudge.companyId, intensity: grudge.intensity, quarter: grudge.quarter })),
          attemptsRecorded: fresh.length,
          grudgesOpened: triggers.length,
        },
        'company',
      );
    }
  }

  return {
    companiesWritten,
    grudgesOpened,
    grudgesReinforced,
    grudgesForgotten,
    grudgesTrimmed,
    attemptsRecorded,
    attemptsTrimmed,
    strategiesRestated,
  };
}

/**
 * Predation this company was on the receiving end of.
 *
 * Two records have to agree before a grudge is written: a
 * `predatory_pricing_flagged` row saying that company priced below cost this
 * quarter, and the economy report's own rival-pressure row saying this company
 * is the one that lost demand to it. Either alone would write a grudge for
 * something that did not happen to this company.
 */
function predationTriggers(draft: SessionState, ledger: LedgerIndex, company: Company): Trigger[] {
  const pressure = draft.economyReport?.rivalPressure ?? [];
  const triggers: Trigger[] = [];
  pressure.forEach((row, order) => {
    if (row.companyId !== company.id || row.pressurePct < 1) return;
    for (const predatorId of row.fromCompanyIds) {
      if (predatorId === company.id || !ledger.predators.has(predatorId)) continue;
      const name = draft.companies.find((candidate) => candidate.id === predatorId)?.name ?? predatorId;
      triggers.push({
        againstId: predatorId,
        cause: 'predatory_pricing',
        reason: `${name} priced below cost into our ${row.segment.replace(/_/g, ' ')} segment and took ${row.pressurePct}% of our growth.`,
        order,
      });
    }
  });
  return triggers;
}

/** A trigger's intensity, raised by hostility the two already carry. Whole points. */
function intensityFor(cause: GrudgeCause, hostility: number): number {
  const base = GRUDGE_BASE_INTENSITY[cause];
  return Math.round(clamp(base * (1 + clamp(hostility, 0, 100) / 200), 0, 100));
}

/** True when two memories are the same in every field, so nothing is rewritten. */
function same(a: StrategistMemory, b: StrategistMemory): boolean {
  if (a.standingStrategy !== b.standingStrategy || a.standingStrategyQuarter !== b.standingStrategyQuarter) return false;
  if (a.grudges.length !== b.grudges.length || a.attempts.length !== b.attempts.length) return false;
  for (let i = 0; i < a.grudges.length; i += 1) {
    const left = a.grudges[i]!;
    const right = b.grudges[i]!;
    if (left.companyId !== right.companyId || left.intensity !== right.intensity || left.quarter !== right.quarter || left.reason !== right.reason) return false;
  }
  for (let i = 0; i < a.attempts.length; i += 1) {
    const left = a.attempts[i]!;
    const right = b.attempts[i]!;
    if (left.quarter !== right.quarter || left.what !== right.what || left.outcome !== right.outcome) return false;
  }
  return true;
}

/**
 * @frontier/simulation — relationships/relations.ts
 *
 * The single choke point through which every subsystem changes how one
 * character feels about another.
 *
 * The division of labour is deliberate and load-bearing:
 *
 * - Government, boards and social **record what happened** by storing a
 *   `Memory` (`rememberEvent`). They never move a relationship directly.
 * - `relationship_update` (phase 15) converts this quarter's memories into
 *   bounded movements on `trust`, `respect`, `hostility` and `dependence`.
 *
 * One conversion table means one place to reason about balance, one place to
 * bound the per-quarter movement, and no possibility of two phases each
 * applying "the same" consequence.
 */

import type { Character, Company, Memory, MemoryKind, Relationship, ResolverContext, SessionState } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { bipolar, clamp, emitEvent, round, score } from './util';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How fast each kind of memory fades, per quarter.
 *
 * Betrayals and broken deals sit near zero by contract: "Memories are what make
 * an NPC say 'you supported us in the regulatory hearing' three years later",
 * and the inverse — a betrayal is never quietly forgotten.
 */
export const MEMORY_DECAY_RATES: Record<MemoryKind, number> = {
  betrayal: 0.01,
  deal_broken: 0.02,
  poach: 0.05,
  public_attack: 0.05,
  contract_loss: 0.06,
  investment: 0.06,
  contract_win: 0.07,
  deal_kept: 0.08,
  board_vote: 0.09,
  introduction: 0.1,
  public_support: 0.1,
  favour: 0.12,
  negotiation: 0.14,
  personal: 0.15,
  media_moment: 0.18,
  meeting: 0.2,
};

/** How a stranger regards a stranger before anything has happened between them. */
export const NEUTRAL_RELATIONSHIP = { trust: 45, respect: 45, hostility: 8, dependence: 5 } as const;

/** Largest movement one memory may cause on one dimension. */
export const MAX_SINGLE_DELTA = 9;

/** Largest movement all of a quarter's memories may cause on one dimension. */
export const MAX_QUARTER_DELTA = 15;

/* -------------------------------------------------------------------------- */
/*  Lookups                                                                    */
/* -------------------------------------------------------------------------- */

export function characterById(draft: SessionState, id: string): Character | null {
  return draft.characters.find((c) => c.id === id) ?? null;
}

export function companyById(draft: SessionState, id: string): Company | null {
  return draft.companies.find((c) => c.id === id) ?? null;
}

/** The character currently serving as chief executive of a company, if any. */
export function ceoOf(draft: SessionState, companyId: string): string | null {
  const company = companyById(draft, companyId);
  if (company === null) return null;
  if (company.ceoCharacterId !== null) return company.ceoCharacterId;
  const employed = draft.characters.find((c) => c.companyId === companyId && c.role === 'founder_ceo' && c.isActive);
  return employed?.id ?? null;
}

/**
 * The person a memory is really about.
 *
 * Memories are stored about characters *and* about companies ("Nexus took two
 * of my researchers"). A feeling, though, always attaches to a person, so a
 * company subject resolves to whoever is running it.
 */
export function subjectCharacterId(draft: SessionState, aboutId: string): string | null {
  if (characterById(draft, aboutId) !== null) return aboutId;
  return ceoOf(draft, aboutId);
}

/** Find a directional relationship, or null when the two have no history. */
export function findRelationship(draft: SessionState, fromId: string, toId: string): Relationship | null {
  return draft.relationships.find((r) => r.fromId === fromId && r.toId === toId) ?? null;
}

/** Find or create a directional relationship at the neutral defaults. */
export function ensureRelationship(draft: SessionState, fromId: string, toId: string): Relationship {
  const existing = findRelationship(draft, fromId, toId);
  if (existing !== null) return existing;
  const created: Relationship = {
    fromId,
    toId,
    trust: NEUTRAL_RELATIONSHIP.trust,
    respect: NEUTRAL_RELATIONSHIP.respect,
    hostility: NEUTRAL_RELATIONSHIP.hostility,
    dependence: NEUTRAL_RELATIONSHIP.dependence,
    lastInteractionQuarter: null,
    interactionCount: 0,
  };
  draft.relationships.push(created);
  return created;
}

/* -------------------------------------------------------------------------- */
/*  Memory to relationship                                                     */
/* -------------------------------------------------------------------------- */

export interface RelationshipDelta {
  readonly trust: number;
  readonly respect: number;
  readonly hostility: number;
  readonly dependence: number;
}

export const ZERO_DELTA: RelationshipDelta = { trust: 0, respect: 0, hostility: 0, dependence: 0 };

export function addDelta(a: RelationshipDelta, b: RelationshipDelta): RelationshipDelta {
  return {
    trust: a.trust + b.trust,
    respect: a.respect + b.respect,
    hostility: a.hostility + b.hostility,
    dependence: a.dependence + b.dependence,
  };
}

/**
 * Per-kind magnitudes at full sentiment, for the positive and the negative
 * reading of the same kind of event. A memory's actual movement is this table
 * scaled by `|sentiment|`, so a mildly annoying meeting barely registers and a
 * furious one lands.
 */
const MEMORY_EFFECTS: Record<MemoryKind, { positive: RelationshipDelta; negative: RelationshipDelta }> = {
  betrayal: {
    positive: { trust: 2, respect: 1, hostility: -1, dependence: 0 },
    negative: { trust: -9, respect: -2, hostility: 8, dependence: 0 },
  },
  deal_broken: {
    positive: { trust: 2, respect: 0, hostility: -1, dependence: 0 },
    negative: { trust: -8, respect: -2, hostility: 6, dependence: -2 },
  },
  deal_kept: {
    positive: { trust: 5, respect: 2, hostility: -2, dependence: 2 },
    negative: { trust: -3, respect: -1, hostility: 2, dependence: 0 },
  },
  favour: {
    positive: { trust: 4, respect: 1, hostility: -2, dependence: 2 },
    negative: { trust: -2, respect: -1, hostility: 2, dependence: 0 },
  },
  poach: {
    positive: { trust: 1, respect: 2, hostility: -1, dependence: 0 },
    // Taking someone's people is read as competence and as an act of war.
    negative: { trust: -3, respect: 3, hostility: 7, dependence: 0 },
  },
  public_attack: {
    positive: { trust: 0, respect: 1, hostility: -1, dependence: 0 },
    negative: { trust: -3, respect: -1, hostility: 8, dependence: 0 },
  },
  public_support: {
    positive: { trust: 4, respect: 2, hostility: -4, dependence: 1 },
    negative: { trust: -1, respect: 0, hostility: 1, dependence: 0 },
  },
  negotiation: {
    positive: { trust: 3, respect: 2, hostility: -2, dependence: 1 },
    negative: { trust: -3, respect: -1, hostility: 3, dependence: 0 },
  },
  meeting: {
    positive: { trust: 2, respect: 1, hostility: -1, dependence: 0 },
    negative: { trust: -1, respect: -1, hostility: 1, dependence: 0 },
  },
  introduction: {
    positive: { trust: 3, respect: 2, hostility: -1, dependence: 4 },
    negative: { trust: -2, respect: -2, hostility: 2, dependence: 0 },
  },
  investment: {
    positive: { trust: 4, respect: 3, hostility: -1, dependence: 6 },
    negative: { trust: -3, respect: -2, hostility: 3, dependence: 3 },
  },
  board_vote: {
    positive: { trust: 5, respect: 2, hostility: -3, dependence: 1 },
    negative: { trust: -6, respect: -1, hostility: 5, dependence: 0 },
  },
  contract_win: {
    positive: { trust: 1, respect: 4, hostility: -1, dependence: 1 },
    negative: { trust: -1, respect: 2, hostility: 3, dependence: 0 },
  },
  contract_loss: {
    positive: { trust: 0, respect: 1, hostility: 0, dependence: 0 },
    negative: { trust: -1, respect: 3, hostility: 4, dependence: 0 },
  },
  media_moment: {
    positive: { trust: 1, respect: 2, hostility: -1, dependence: 0 },
    negative: { trust: -2, respect: -2, hostility: 3, dependence: 0 },
  },
  personal: {
    positive: { trust: 3, respect: 1, hostility: -2, dependence: 1 },
    negative: { trust: -3, respect: -1, hostility: 3, dependence: 0 },
  },
};

/** The bounded movement one memory implies, before per-quarter aggregation. */
export function memoryEffect(kind: MemoryKind, sentiment: number, strength = 1): RelationshipDelta {
  const table = MEMORY_EFFECTS[kind];
  const s = bipolar(sentiment);
  const base = s >= 0 ? table.positive : table.negative;
  const scale = Math.abs(s) * clamp(strength, 0, 1);
  const cap = (v: number): number => clamp(v * scale, -MAX_SINGLE_DELTA, MAX_SINGLE_DELTA);
  return { trust: cap(base.trust), respect: cap(base.respect), hostility: cap(base.hostility), dependence: cap(base.dependence) };
}

/**
 * Apply a delta to a relationship, capped per quarter and clamped to 0..100.
 * Returns the movement actually applied, so the caller can decide whether the
 * change is worth a ledger row.
 */
export function applyRelationshipDelta(rel: Relationship, delta: RelationshipDelta, quarter: number): RelationshipDelta {
  const cap = (v: number): number => clamp(v, -MAX_QUARTER_DELTA, MAX_QUARTER_DELTA);
  const before = { trust: rel.trust, respect: rel.respect, hostility: rel.hostility, dependence: rel.dependence };
  rel.trust = score(rel.trust + cap(delta.trust));
  rel.respect = score(rel.respect + cap(delta.respect));
  rel.hostility = score(rel.hostility + cap(delta.hostility));
  rel.dependence = score(rel.dependence + cap(delta.dependence));
  rel.lastInteractionQuarter = quarter;
  rel.interactionCount += 1;
  return {
    trust: round(rel.trust - before.trust, 4),
    respect: round(rel.respect - before.respect, 4),
    hostility: round(rel.hostility - before.hostility, 4),
    dependence: round(rel.dependence - before.dependence, 4),
  };
}

/* -------------------------------------------------------------------------- */
/*  Storing memories                                                           */
/* -------------------------------------------------------------------------- */

export interface RememberInput {
  /** Who remembers it. */
  readonly ownerCharacterId: string;
  /** Who or what it is about: a character id or a company id. */
  readonly aboutId: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly sentiment: number;
  /**
   * A stable key for a one-shot happening (a specific contract, a specific
   * deal). When present the memory is written at most once for that key, so a
   * standing fact does not produce a fresh memory every quarter.
   */
  readonly stableKey?: string;
  /** Override the kind's default decay rate. */
  readonly decayRate?: number;
}

/**
 * Store a memory with an engine-assigned id and the decay rate its kind
 * deserves. Returns null when a memory with the same stable key already exists.
 *
 * This is the only way a subsystem records that something happened between two
 * people. The relationship consequence follows in `relationship_update`.
 */
export function rememberEvent(draft: SessionState, ctx: ResolverContext, input: RememberInput): Memory | null {
  const owner = characterById(draft, input.ownerCharacterId);
  if (owner === null || !owner.isActive) return null;
  if (input.ownerCharacterId === input.aboutId) return null;

  const base =
    input.stableKey === undefined
      ? makeId('mem', draft.sessionId, ctx.quarter, input.ownerCharacterId, input.kind, input.aboutId)
      : makeId('mem', draft.sessionId, input.ownerCharacterId, input.kind, input.stableKey);

  const taken = new Set(draft.memories.map((m) => m.id));
  if (input.stableKey !== undefined && taken.has(base)) return null;
  let id = base;
  let suffix = 1;
  while (taken.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }

  const memory: Memory = {
    id,
    ownerCharacterId: input.ownerCharacterId,
    aboutId: input.aboutId,
    quarter: ctx.quarter,
    kind: input.kind,
    summary: input.summary.slice(0, 300),
    sentiment: bipolar(input.sentiment),
    decayRate: clamp(input.decayRate ?? MEMORY_DECAY_RATES[input.kind], 0, 1),
    strength: 1,
  };
  draft.memories.push(memory);

  emitEvent(
    draft,
    ctx,
    'memory_stored',
    input.ownerCharacterId,
    input.aboutId,
    { memoryId: id, kind: memory.kind, sentiment: memory.sentiment, decayRate: memory.decayRate, summary: memory.summary },
    // What one character privately concluded about another is not public
    // information, and must never become market information by accident.
    'private',
  );
  return memory;
}

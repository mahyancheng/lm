/**
 * @frontier/simulation — relationships/access.ts
 *
 * The access rule, enforced server-side.
 *
 * ```text
 * gap = | connectionLevel(a) - connectionLevel(b) |
 * gap <= 10  ->  either party may initiate
 * gap >  10  ->  only the higher-connection actor may initiate, downward
 * ```
 *
 * `canInitiateContact` in `@frontier/contracts` is the pure form of that rule
 * and is used here verbatim rather than reimplemented. Everything this module
 * adds is the second half of the design: the gap is a routing problem, not a
 * wall. A stored `AccessOverride` bypasses it, and several overrides are
 * *structural* — two directors on one board, two companies in one consortium,
 * two parties to a live negotiation — and are therefore derived from state
 * rather than stored, so they appear and disappear with the position itself.
 */

import type { AccessDecision, AccessOverride, AccessOverrideKind, SessionState } from '@frontier/contracts';
import { CONNECTION_GAP_RULE, canInitiateContact, makeId } from '@frontier/contracts';
import { characterById } from './relations';

/* -------------------------------------------------------------------------- */
/*  Stored overrides                                                           */
/* -------------------------------------------------------------------------- */

/** True when a stored override is in force in `quarter`. */
export function overrideIsLive(override: AccessOverride, quarter: number): boolean {
  if (override.grantedQuarter > quarter) return false;
  if (override.isPermanent || override.expiresQuarter === null) return true;
  return override.expiresQuarter >= quarter;
}

/** The live stored override permitting `a` to reach `b`, or null. */
export function storedOverride(draft: SessionState, a: string, b: string): AccessOverride | null {
  return draft.accessOverrides.find((o) => o.fromId === a && o.toId === b && overrideIsLive(o, draft.quarter)) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Structural overrides                                                       */
/* -------------------------------------------------------------------------- */

export interface StructuralOverride {
  readonly kind: AccessOverrideKind;
  readonly reason: string;
}

const companyOf = (draft: SessionState, characterId: string): string | null => characterById(draft, characterId)?.companyId ?? null;

/** Every company a character is connected to: employer plus board seats. */
function affiliations(draft: SessionState, characterId: string): Set<string> {
  const out = new Set<string>();
  const employer = companyOf(draft, characterId);
  if (employer !== null) out.add(employer);
  for (const board of draft.boards) {
    if (board.directors.some((d) => d.characterId === characterId)) out.add(board.companyId);
  }
  return out;
}

/** Holder ids on a company's cap table that represent an outside investor. */
function investorHolders(draft: SessionState, companyId: string): Set<string> {
  const table = draft.capTables.find((t) => t.companyId === companyId);
  const out = new Set<string>();
  if (table === undefined) return out;
  for (const holding of table.holdings) {
    if (holding.holderKind === 'public_float') continue;
    out.add(holding.holderId);
  }
  return out;
}

function intersects<T>(a: Set<T>, b: Set<T>): T | null {
  for (const value of a) {
    if (b.has(value)) return value;
  }
  return null;
}

/**
 * The structural bypass, if any, that lets `a` reach `b` regardless of the gap.
 * Derived from state, in a fixed order so the reason a player is shown is
 * stable across runs.
 */
export function structuralOverride(draft: SessionState, a: string, b: string): StructuralOverride | null {
  // A shared board seat. Two directors of one company can always speak.
  const sharedBoard = draft.boards.find(
    (board) => board.directors.some((d) => d.characterId === a) && board.directors.some((d) => d.characterId === b),
  );
  if (sharedBoard !== undefined) {
    return { kind: 'shared_board', reason: `You both sit on the board of ${sharedBoard.companyId}.` };
  }

  const aCompanies = affiliations(draft, a);
  const bCompanies = affiliations(draft, b);

  // A common investor on both cap tables.
  for (const aCompany of aCompanies) {
    for (const bCompany of bCompanies) {
      if (aCompany === bCompany) continue;
      const shared = intersects(investorHolders(draft, aCompany), investorHolders(draft, bCompany));
      if (shared !== null) return { kind: 'shared_investor', reason: `${shared} holds stock in both companies.` };
    }
  }

  // A joint government bid, live or awarded.
  for (const bid of draft.governmentBids) {
    if (bid.status === 'withdrawn' || bid.status === 'lost' || bid.status === 'disqualified') continue;
    const team = new Set<string>([bid.bidderCompanyId, ...bid.consortiumMemberIds, ...bid.subcontractors.map((s) => s.companyId)]);
    if (intersects(aCompanies, team) !== null && intersects(bCompanies, team) !== null) {
      return { kind: 'consortium', reason: `You are bidding together on ${bid.opportunityId}.` };
    }
  }
  for (const contract of draft.governmentContracts) {
    if (contract.status === 'terminated') continue;
    const team = new Set<string>([contract.primeCompanyId, ...contract.consortiumMemberIds, ...contract.subcontractors.map((s) => s.companyId)]);
    if (intersects(aCompanies, team) !== null && intersects(bCompanies, team) !== null) {
      return { kind: 'consortium', reason: `You are delivering ${contract.id} together.` };
    }
  }

  // A live transaction between the two of them.
  for (const deal of draft.deals) {
    if (deal.status !== 'proposed' && deal.status !== 'accepted') continue;
    const parties = new Set<string>([deal.proposerId, deal.counterpartyId]);
    const aParty = parties.has(a) || intersects(aCompanies, parties) !== null;
    const bParty = parties.has(b) || intersects(bCompanies, parties) !== null;
    if (aParty && bParty) return { kind: 'negotiation', reason: 'You are parties to a live deal.' };
  }

  // The press. A journalist reaches the subject of their story, and the subject
  // reaches the journalist, whether either wants it or not.
  const aChar = characterById(draft, a);
  const bChar = characterById(draft, b);
  const recent = draft.mediaStories.filter((s) => s.quarter >= draft.quarter - 1);
  for (const story of recent) {
    const journalist = story.authorCharacterId;
    if (journalist === null) continue;
    const subjects = new Set<string>([...story.subjectCharacterIds]);
    for (const companyId of story.subjectCompanyIds) {
      for (const character of draft.characters) {
        if (character.companyId === companyId) subjects.add(character.id);
      }
    }
    if ((journalist === a && subjects.has(b)) || (journalist === b && subjects.has(a))) {
      return { kind: 'media', reason: `A live story puts you both in the same room: "${story.headline}".` };
    }
  }
  if (aChar?.role === 'journalist' && bChar !== null && recent.some((s) => s.subjectCharacterIds.includes(b))) {
    return { kind: 'media', reason: 'The press is covering you this quarter.' };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  The decision                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether character `a` may open a conversation with character `b`.
 * Pure and deterministic; the resolver, the API route and Supabase RLS each
 * restate this rule independently.
 */
export function checkAccess(draft: SessionState, a: string, b: string): AccessDecision {
  const from = characterById(draft, a);
  const to = characterById(draft, b);
  if (from === null || to === null) {
    return { allowed: false, reason: 'One of these people is not in this session.', overrideId: null, gap: 0 };
  }
  if (a === b) {
    return { allowed: true, reason: 'A character may always talk to themselves.', overrideId: null, gap: 0 };
  }
  if (!to.isActive) {
    return { allowed: false, reason: `${to.name} has left the industry.`, overrideId: null, gap: 0 };
  }

  const gap = Math.abs(from.connectionLevel - to.connectionLevel);

  if (canInitiateContact(from.connectionLevel, to.connectionLevel)) {
    const reason =
      gap <= CONNECTION_GAP_RULE.symmetricGap
        ? `Your connection levels are within ${CONNECTION_GAP_RULE.symmetricGap} points (${Math.round(from.connectionLevel)} against ${Math.round(to.connectionLevel)}), so either of you may open a channel.`
        : `You out-rank ${to.name} on connection level (${Math.round(from.connectionLevel)} against ${Math.round(to.connectionLevel)}), and contact downward is always permitted.`;
    return { allowed: true, reason, overrideId: null, gap };
  }

  const stored = storedOverride(draft, a, b);
  if (stored !== null) {
    return {
      allowed: true,
      reason: `${stored.reason} (${stored.kind.replace(/_/g, ' ')})`,
      overrideId: stored.id,
      gap,
    };
  }

  const structural = structuralOverride(draft, a, b);
  if (structural !== null) {
    return {
      allowed: true,
      reason: structural.reason,
      // Structural overrides are derived, not stored. The id is deterministic
      // so the interface can key on it and the caller may persist it verbatim.
      overrideId: makeId('ovr', structural.kind, a, b),
      gap,
    };
  }

  return {
    allowed: false,
    reason: `${to.name} is ${Math.round(gap)} connection points above you. Build a relationship with someone in between and earn an introduction.`,
    overrideId: null,
    gap,
  };
}

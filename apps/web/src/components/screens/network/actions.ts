/**
 * What a founder can actually do to one person, and through whom.
 *
 * The screen used to offer exactly one move — `request_introduction` — and only
 * to the people the access rule refused. In world 2 that is eleven of
 * forty-two; the other thirty-one were reachable and had no button at all. This
 * module is the missing half: every reachable person carries the typed actions
 * their role makes sensible, and every blocked person carries the route in.
 *
 * Two rules hold everything here together:
 *
 * - **Nothing in this file decides anything.** An offer is a *proposal to the
 *   validator*; the drawer renders the validator's verdict beside every button
 *   and the engine is still the only thing that says yes. Availability here is
 *   about whether the move is *coherent* for this person (you do not lobby a
 *   regulator or poach a journalist), never about whether it will be allowed.
 * - **Every derivation is deterministic.** The intermediary an introduction
 *   picks is the highest-connection broker with a stable id tie-break, so the
 *   same session offers the same route on every render and in every test.
 */

import type { Character, DealProposalDraft, SessionState } from '@frontier/contracts';
import type { IconName } from '@/components/ui';
import type { DirectoryEntry } from './directory';

/* -------------------------------------------------------------------------- */
/*  The route in                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The brokers for one blocked person, best first.
 *
 * "Best" is the highest connection level, because standing is what an
 * intermediary spends: a person with more of it is more likely to be able to
 * make the call at all. Ties break on id — total and stable, so two renders of
 * the same session never disagree about who is offered first.
 */
export function viaOptions(directory: readonly DirectoryEntry[], entry: DirectoryEntry): Character[] {
  const byId = new Map(directory.map((row) => [row.character.id, row.character] as const));
  return entry.brokerIds
    .map((id) => byId.get(id))
    .filter((character): character is Character => character !== undefined)
    .sort((a, b) => (b.connectionLevel - a.connectionLevel) || a.id.localeCompare(b.id));
}

/** The intermediary the screen offers by default, or null when there is no route. */
export function bestVia(directory: readonly DirectoryEntry[], entry: DirectoryEntry): Character | null {
  return viaOptions(directory, entry)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  What is on offer                                                           */
/* -------------------------------------------------------------------------- */

/** Every move the drawer can put in front of a founder. */
export type PersonActionKind =
  | 'talk'
  | 'request_introduction'
  | 'poach_executive'
  | 'lobby_director'
  | 'meet_regulator'
  | 'propose_deal';

export interface PersonActionOffer {
  readonly kind: PersonActionKind;
  readonly label: string;
  readonly icon: IconName;
  /** What happens if this is queued, in the player's own terms. */
  readonly blurb: string;
}

/** The state of the player's own affairs that decides which moves are coherent. */
export interface OfferContext {
  readonly selfId: string;
  readonly ownCompanyId: string;
  /** Directors of the player's own board — the only people `lobby_director` accepts. */
  readonly ownBoardDirectorIds: ReadonlySet<string>;
  /** True when a matter is tabled or drafted, which lobbying requires. */
  readonly hasOpenBoardMatter: boolean;
}

/** People whose day job is running something, and can therefore be hired away. */
const POACHABLE_ROLES: ReadonlySet<Character['role']> = new Set(['executive', 'researcher', 'founder_ceo']);

/**
 * The moves that make sense for this person, in the order they should be read.
 *
 * Reachability decides the first entry and nothing else: a reachable person
 * opens with a conversation, a blocked one with the route in. Everything after
 * that is the person's role, which does not change with access — a regulator is
 * still a regulator when you cannot reach them, and the button says so by
 * carrying the validator's refusal rather than by vanishing.
 */
export function offersFor(entry: DirectoryEntry, ctx: OfferContext): PersonActionOffer[] {
  const offers: PersonActionOffer[] = [];
  const reachable = entry.decision.allowed;
  const name = entry.character.name.split(' ')[0] ?? entry.character.name;

  if (reachable) {
    offers.push({
      kind: 'talk',
      label: 'Talk',
      icon: 'chat',
      blurb: `Open a conversation. ${name} answers from their traits, their memory of you and the numbers on record — not from how the message is phrased.`,
    });
  } else if (entry.brokerIds.length > 0) {
    offers.push({
      kind: 'request_introduction',
      label: 'Ask for an introduction',
      icon: 'handshake',
      blurb: 'Your intermediary spends their own standing on this. They decide during next quarter\'s relationship phase; a granted introduction opens a channel for four quarters.',
    });
  }

  if (ctx.ownBoardDirectorIds.has(entry.character.id)) {
    offers.push({
      kind: 'lobby_director',
      label: 'Lobby before the vote',
      icon: 'boardTable',
      blurb: ctx.hasOpenBoardMatter
        ? 'A conversation before the vote produces a conditional commitment the engine later checks against the real terms. It never edits the support score.'
        : 'Nothing is tabled. A director can only be lobbied on a matter before the board.',
    });
  }

  if (entry.character.role === 'regulator' || entry.character.role === 'official') {
    offers.push({
      kind: 'meet_regulator',
      label: 'Request a meeting',
      icon: 'capitol',
      blurb: 'Builds or spends institutional standing next quarter. Concessions offered are remembered and expected to be honoured; a meeting never guarantees a rule change.',
    });
  }

  if (POACHABLE_ROLES.has(entry.character.role) && entry.character.companyId !== null && entry.character.companyId !== ctx.ownCompanyId) {
    offers.push({
      kind: 'poach_executive',
      label: 'Approach about a role',
      icon: 'briefcase',
      blurb: 'Their employer finds out either way and remembers it. A private approach needs reach; a public one applies pressure and starts a fight.',
    });
  }

  if (reachable && entry.character.id !== ctx.selfId) {
    offers.push({
      kind: 'propose_deal',
      label: 'Send terms',
      icon: 'stamp',
      blurb: 'A recorded, non-binding offer to open a negotiation. Nothing binds until they accept, and the Deal Room is where obligations are written.',
    });
  }

  return offers;
}

/* -------------------------------------------------------------------------- */
/*  Intents                                                                    */
/* -------------------------------------------------------------------------- */

/** Quarters an opening offer stays live before it lapses unanswered. */
export const OFFER_LIFETIME_QUARTERS = 2;

/**
 * A letter of intent: a counterparty, a summary and nothing else.
 *
 * Deliberately empty of obligations. Writing terms is the Deal Room's job and
 * it does it with a builder; what this screen is for is *opening the file* with
 * somebody you have just established you can reach.
 */
export function openingDealDraft(target: Character, quarter: number, summary: string): DealProposalDraft {
  return {
    counterpartyId: target.id,
    counterpartyKind: 'character',
    gives: [],
    gets: [],
    confidentiality: 'private',
    expiresQuarter: quarter + OFFER_LIFETIME_QUARTERS,
    binding: false,
    intentStatements: [],
    summary,
  };
}

/* -------------------------------------------------------------------------- */
/*  When there is no route at all                                              */
/* -------------------------------------------------------------------------- */

export interface ConnectionLever {
  readonly label: string;
  readonly icon: IconName;
  readonly href: string;
  readonly weightPct: number;
  readonly how: string;
}

/**
 * The ten inputs of `connection.ts`, as things a founder can go and do.
 *
 * The weights are the engine's own, rounded to whole percentage points, and the
 * order is descending by weight, so the top of the list is genuinely the
 * fastest way up rather than the easiest thing to say. This is what the screen
 * shows instead of a dead end.
 */
export const CONNECTION_LEVERS: readonly ConnectionLever[] = [
  {
    label: 'Company significance',
    icon: 'building',
    href: '/command-centre',
    weightPct: 16,
    how: 'The enterprise value of what you run. Growing the company is the largest single input.',
  },
  {
    label: 'Founder reputation',
    icon: 'gauge',
    href: '/company',
    weightPct: 12,
    how: 'Public, investor and enterprise reputation, blended. Shipping and keeping guidance moves it.',
  },
  {
    label: 'Mutual relationships',
    icon: 'network',
    href: '/network',
    weightPct: 12,
    how: 'Your best five two-way relationships, weighted by how powerful the other person is. Three people known well beats thirty known slightly.',
  },
  {
    label: 'Personal wealth',
    icon: 'coins',
    href: '/capital',
    weightPct: 12,
    how: 'What your own stake is worth. It follows the company rather than leading it.',
  },
  {
    label: 'Board positions',
    icon: 'boardTable',
    href: '/boardroom',
    weightPct: 10,
    how: 'Seats you actually hold. A seat is also a standing override: two directors of one board can always speak.',
  },
  {
    label: 'Investor relationships',
    icon: 'briefcase',
    href: '/street',
    weightPct: 10,
    how: 'Depth and quality of ties to investors, in both directions. A shared investor is also a route to everyone else on their book.',
  },
  {
    label: 'Government credibility',
    icon: 'capitol',
    href: '/government',
    weightPct: 9,
    how: 'Past performance on contracts and standing with agencies. Winning work is what moves it.',
  },
  {
    label: 'Media influence',
    icon: 'newspaper',
    href: '/news',
    weightPct: 8,
    how: 'How often the press names you, and how prominently. A live story is also a temporary channel to the journalist writing it.',
  },
  {
    label: 'Prior exits',
    icon: 'ledger',
    href: '/financials',
    weightPct: 6,
    how: 'Wealth your current company does not explain. It accrues over a career, not over a quarter.',
  },
  {
    label: 'Public following',
    icon: 'chat',
    href: '/social',
    weightPct: 5,
    how: 'Account credibility across networks. The smallest of the ten inputs: this game is emphatically not follower count.',
  },
];

/* -------------------------------------------------------------------------- */
/*  Dialogue                                                                   */
/* -------------------------------------------------------------------------- */

/** One turn on screen. `speakerId` is the founder's id or the character's. */
export interface DialogueTurn {
  readonly speakerId: string;
  readonly text: string;
}

/**
 * The deterministic reply, for when no model is available.
 *
 * `@frontier/llm` is server-only and its `fallbackCharacterReply` cannot enter
 * a client bundle, so the register table is restated here in the same shape:
 * relationship-derived, trait-derived, carrying no commitment and inventing no
 * number. `failure_mode` is an engine invariant — the conversation has to
 * continue with the model switched off.
 */
export function offlineReply(character: Character, inboundTrust: number | null, inboundHostility: number | null, topic: string): string {
  const opening =
    inboundTrust === null
      ? 'We have not worked together before, so I will be brief.'
      : (inboundHostility ?? 0) >= 60
        ? 'I will be short about this.'
        : inboundTrust >= 70
          ? 'Good to hear from you.'
          : inboundTrust <= 30
            ? 'I will keep this narrow for now.'
            : 'Understood.';

  const traits = character.stableTraits;
  const stance =
    traits.financialConservatism >= 70
      ? 'My first question is always what it costs and what happens if it does not work.'
      : traits.riskTolerance >= 70
        ? 'I am willing to take a position on this if the case is coherent.'
        : traits.technicalOrientation >= 70
          ? 'I would want to see the evidence rather than the framing.'
          : 'I would want to understand the shape of it before I take a view.';

  const closing =
    inboundTrust === null
      ? 'Put the specifics in writing and I will look at them properly.'
      : (inboundHostility ?? 0) >= 60
        ? 'I am not going to commit to anything on this today.'
        : inboundTrust >= 70
          ? 'Send me the numbers and we can go through them properly.'
          : 'Let me come back to you on it.';

  return `${opening} On ${topic}: ${stance} ${closing}`;
}

/**
 * Facts a character may argue from: public, verified, already formatted.
 *
 * Kept to the two figures both parties can see anyway — the standing the ledger
 * publishes and the seats they hold — because a fact list is a licence to use a
 * number, and a private number handed to an NPC's agent would leak it.
 */
export function publicFactsFor(session: SessionState, character: Character): { readonly label: string; readonly value: string }[] {
  return [
    { label: `${character.name} connection level`, value: String(Math.round(character.connectionLevel)) },
    { label: `${character.name} board seats`, value: String(character.boardSeatCount) },
    { label: 'Quarter', value: String(session.quarter) },
  ];
}

/**
 * @frontier/simulation — social/npcPosts.ts
 *
 * The world talks back.
 *
 * Until this module existed, `socialPosts` only ever grew from player actions,
 * so every network in the game was empty except the player's own. A living
 * industry does not work that way: a launch, a raise, an award, a lost
 * competition, a bad quarter on the tape and a rival's public attack all produce
 * somebody saying something in public, and the answer to a public attack is a
 * public answer.
 *
 * Three rules govern everything here.
 *
 * **The engine writes the words, and the words carry no authority.** Template
 * text is chosen deterministically — the character's traits pick a voice, the
 * seeded stream picks a variant within it — and the typed `intent` is what the
 * engine actually acts on. A model may later replace the prose of a handful of
 * these posts (`social_author`); it cannot change the intent, the target or a
 * single number, because reach, sentiment, press pickup and hostility are all
 * computed downstream in `reach.ts` from the typed post.
 *
 * **It is bounded.** A quarter produces at most `npcPostBudget(companyCount)`
 * posts world-wide and at most `MAX_NPC_REPLIES_PER_QUARTER` replies, one post
 * per character, chosen by salience. `POST_HISTORY_QUARTERS` then rolls the
 * window forward. A phone runs the whole engine, so the feed is a stream, not an
 * archive.
 *
 * **World 1 is frozen.** `npcPostingEnabled` gates every path in this file on
 * world version 2. World-version-1 saves record only their inputs and are
 * replayed through this same engine, so a world-1 quarter that suddenly grew
 * eleven posts would replay to reputations, prices and stories the player never
 * saw. The frozen world stays silent; the multi-sector world talks.
 */

import type {
  Character,
  Company,
  NetworkArchetype,
  PostIntent,
  ResolverContext,
  SeededRng,
  SessionState,
  SocialPost,
  WorldEventType,
} from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { ceoOf } from '../relationships/relations';
import { ensureAccount } from './accounts';
import { characterById, clamp, companyById, round } from './util';

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/** Fewest NPC posts a quarter may produce, however small the world. */
export const MIN_NPC_POSTS_PER_QUARTER = 6;

/** Most NPC posts a quarter may produce, however large the world. */
export const MAX_NPC_POSTS_PER_QUARTER = 15;

/** Most replies a quarter may produce, on top of the post budget. */
export const MAX_NPC_REPLIES_PER_QUARTER = 5;

/** Quarterly return past which a listed company's founder says something. */
export const PRICE_MOVE_THRESHOLD = 0.08;

/** Hostility, on the 0..100 scale, past which an aggressive founder goes public. */
export const HOSTILITY_ATTACK_THRESHOLD = 55;

/** Aggressiveness, on the 0..100 scale, at which a character attacks rather than defends. */
export const AGGRESSION_ATTACK_THRESHOLD = 60;

/** Quarters an author waits before going after the same rival in public again. */
export const ATTACK_COOLDOWN_QUARTERS = 2;

/** Severity past which a company named by a bad event apologises rather than defends. */
export const APOLOGY_SEVERITY = 0.6;

/** How many companies react to an event that names their sector but not them. */
export const SECTOR_REACTIONS_PER_EVENT = 2;

/**
 * How many posts a world of this size produces per quarter.
 *
 * Roughly three posts for every five companies, floored and capped: six in the
 * seven-company frozen world, fifteen across the twenty-five of world 2. The
 * cap is what keeps the feed readable and the state small as the economy grows.
 */
export function npcPostBudget(companyCount: number): number {
  const scaled = Math.round(Math.max(0, companyCount) * 0.6);
  return clamp(scaled, MIN_NPC_POSTS_PER_QUARTER, MAX_NPC_POSTS_PER_QUARTER);
}

/**
 * Whether the engine may author posts in this session.
 *
 * World version 1 is frozen: its saves replay through this engine, and posts it
 * never had would move reputations, prices and press coverage the player never
 * saw. See the module header.
 */
export function npcPostingEnabled(draft: SessionState): boolean {
  return draft.config.worldVersion >= 2;
}

/* -------------------------------------------------------------------------- */
/*  Voice and templates                                                        */
/* -------------------------------------------------------------------------- */

/** Which register a character writes in. Derived from traits, never drawn. */
export type Voice = 'blunt' | 'measured' | 'evangelical';

export type NpcTemplateKey =
  | 'event_react'
  | 'event_defend'
  | 'event_apologise'
  | 'product_launch'
  | 'funding_round'
  | 'contract_win'
  | 'contract_loss'
  | 'price_up'
  | 'price_down'
  | 'attack_rival'
  | 'press_teaser'
  | 'programme_notice'
  | 'reply_defend'
  | 'reply_counter';

/**
 * The character's voice, from their stable traits.
 *
 * Traits do not change over a session, so a character's register never drifts:
 * the same founder sounds like the same person in quarter forty as in quarter
 * one, which is what makes a templated feed read as a cast rather than as a
 * random-line generator.
 */
export function voiceOf(character: Character): Voice {
  const traits = character.stableTraits;
  if (traits.aggressiveness >= 65) return 'blunt';
  if (traits.statusSensitivity >= 65 && traits.technicalOrientation < 75) return 'evangelical';
  return 'measured';
}

/** Fields a template may interpolate. Every one is filled from committed state. */
interface TemplateFields {
  /** The author's own company, or their name when they have none. */
  readonly company: string;
  /** What the post is about: an event title, a product, a programme, a headline. */
  readonly subject: string;
  /** The other party: a rival, an agency, a journalist's subject. */
  readonly rival: string;
  /** One already-formatted, whole-number figure. */
  readonly figure: string;
}

const TEMPLATES: Record<NpcTemplateKey, Record<Voice, readonly string[]>> = {
  event_react: {
    blunt: [
      'Everyone in this sector saw {subject} coming. We planned for it. Most did not.',
      '{subject}. We are not going to pretend this is fine, and we are not going to slow down either.',
    ],
    measured: [
      '{subject}. At {company} we are reading it as a change in operating conditions, not a change in the plan.',
      'On {subject}: the second-order effects matter more than the headline. We are watching demand, not sentiment.',
    ],
    evangelical: [
      '{subject}. Moments like this are exactly when {company} does its best work.',
      'The industry is going to remember {subject}. {company} intends to be on the right side of it.',
    ],
  },
  event_defend: {
    blunt: [
      'We have seen the reporting on {subject}. Most of it is wrong, and we will say precisely how within the week.',
      '{subject}: nobody at {company} is hiding. Ask us the specific question and we will give you the specific answer.',
    ],
    measured: [
      'On {subject}: {company} is dealing with it directly, and we will publish what we find rather than summarise it.',
      '{subject} is real and we are treating it as such. Customers have been contacted; nothing is being minimised.',
    ],
    evangelical: [
      '{subject} does not change what {company} is building or who we are building it for.',
      'We will come out of {subject} a better company. That is not spin, it is the plan.',
    ],
  },
  event_apologise: {
    blunt: [
      '{subject}. This was ours. We got it wrong, and I am not going to dress that up.',
      'On {subject}: my responsibility. The fix is under way and the account of what happened will be public.',
    ],
    measured: [
      'We are sorry. {subject} should not have happened at {company}, and the review will be published in full.',
      '{subject}: an apology first, then the detail. Affected customers hear from us before anybody reads about it.',
    ],
    evangelical: [
      'We let people down with {subject}. {company} will earn that trust back the slow way.',
      'I am sorry for {subject}. We will be judged on what we do next, not on this statement.',
    ],
  },
  product_launch: {
    blunt: [
      '{subject} is live. No waitlist, no keynote. Go and use it.',
      'Shipped: {subject}. Benchmarks are in the docs, complaints to me directly.',
    ],
    measured: [
      '{company} has released {subject} to every customer today. Evaluations first, announcement second.',
      '{subject} is available from now. We would rather it was judged in production than in a demo.',
    ],
    evangelical: [
      'Today {company} ships {subject}. This is the one we have been waiting to show you.',
      '{subject} is here. Two years of work from a team that deserves the whole credit.',
    ],
  },
  funding_round: {
    blunt: [
      'We raised {figure}. It buys time and compute, nothing else. Back to work.',
      '{figure} in. Anyone treating a raise as an achievement has already lost.',
    ],
    measured: [
      '{company} has closed {figure}. The money funds capacity and hiring against commitments we have already made.',
      'We raised {figure} to do what we said we would do, on the timeline we said we would do it.',
    ],
    evangelical: [
      'Thrilled: {company} has raised {figure} to build the thing we keep telling you about.',
      '{figure} raised, and a team that earned every dollar of it. This is the beginning.',
    ],
  },
  contract_win: {
    blunt: [
      'We won {subject}. Now we have to deliver it, which is the part nobody posts about.',
      '{subject} is ours, worth {figure}. Congratulations to everybody who wrote the compliance annexes.',
    ],
    measured: [
      '{company} has been awarded {subject}, worth {figure}. Delivery starts immediately.',
      'We are pleased to be selected for {subject}. Public work carries public obligations and we take them seriously.',
    ],
    evangelical: [
      '{company} has won {subject} at {figure}. A real vote of confidence in this team.',
      'Proud to say {subject} is going to be built by {company}.',
    ],
  },
  contract_loss: {
    blunt: [
      'We lost {subject}. The evaluation was what it was; we will bid the next one harder.',
      'Not ours: {subject}. I would rather lose on price than win on a promise we cannot keep.',
    ],
    measured: [
      '{company} was not selected for {subject}. We will ask for the debrief and act on it.',
      'On {subject}: a competitive process, and we came second. That is information, not a verdict.',
    ],
    evangelical: [
      '{subject} did not go our way. It does not change what {company} is here to do.',
      'We missed {subject}. The team will be back for the next one, and it will be better.',
    ],
  },
  price_up: {
    blunt: [
      'The tape moved {figure} this quarter. It will move the other way one day and we will not comment on that either.',
      'Up {figure}. Nobody here is running the company off a share price.',
    ],
    measured: [
      '{company} is up {figure} on the quarter. The business behind it changed less than the number did.',
      'A {figure} quarter for the stock. Our attention is on retention and margin, which moved less.',
    ],
    evangelical: [
      '{figure} on the quarter, and we are only getting started at {company}.',
      'The market is finally seeing what {company} has been building: up {figure}.',
    ],
  },
  price_down: {
    blunt: [
      'Down {figure}. I am not going to explain a share price to you; ask me about the business.',
      '{figure} off the quarter. The plan did not change on Tuesday and it has not changed today.',
    ],
    measured: [
      '{company} is down {figure} this quarter. The operating numbers we publish are the ones that matter.',
      'A {figure} move against us. We are managing the company for the next three years, not the next three weeks.',
    ],
    evangelical: [
      '{figure} down and I have never been more certain about {company}.',
      'Short-term noise: {figure}. Long-term, nothing about what {company} is building has changed.',
    ],
  },
  attack_rival: {
    blunt: [
      '{rival} sells a story. Ask them for the numbers behind it and watch what happens.',
      'Everything {rival} announced this quarter, we shipped. One of us is talking and one of us is delivering.',
    ],
    measured: [
      'I would take {rival}\'s claims more seriously if any of them survived a serious evaluation.',
      'A polite note to {rival}: publish the methodology. Customers can tell the difference.',
    ],
    evangelical: [
      'While {rival} runs its campaign, {company} is busy with customers who actually use the thing.',
      'Choose the company that shows its work. {rival} still has not.',
    ],
  },
  press_teaser: {
    blunt: [
      'My story is up: {subject}. People said things on the record they will regret by Friday.',
      '{subject}. Read it before the statements start arriving.',
    ],
    measured: [
      'New from me: {subject}. Documents and two sources, both named.',
      'Published: {subject}. Comment was sought from everybody involved.',
    ],
    evangelical: [
      'The piece I have wanted to write for months is out: {subject}.',
      '{subject}. This one matters more than the week\'s numbers do.',
    ],
  },
  programme_notice: {
    blunt: [
      '{subject} is open, ceiling {figure}. Read the requirements before you call me about them.',
      'Bids open on {subject}. {figure} ceiling, and the evaluation weights are published for a reason.',
    ],
    measured: [
      '{rival} has opened {subject}, with a ceiling of {figure}. The requirements and weights are public from today.',
      '{subject} is now open to bidders. Ceiling {figure}; the evaluation is on published criteria only.',
    ],
    evangelical: [
      'A programme worth {figure}: {subject} opens today, and we want serious proposals.',
      '{subject} is open. This is how {rival} intends to buy for the next decade.',
    ],
  },
  reply_defend: {
    blunt: [
      '{rival} knows better than that. Our numbers are published; theirs are not.',
      'Answering {rival} directly: no. The rest of the detail is in the filings.',
    ],
    measured: [
      '{rival} has this wrong, and {company} will set out why with figures rather than adjectives.',
      'We have read what {rival} said. Our customers have the data; they can judge it themselves.',
    ],
    evangelical: [
      '{company} has been called worse by better. Judge us on the product.',
      'I would rather answer {rival} with next quarter\'s results than with a thread.',
    ],
  },
  reply_counter: {
    blunt: [
      '{rival} wants to do this in public? Fine. Start with their retention numbers.',
      'Rich, coming from {rival}. We can both publish our churn today if they like.',
    ],
    measured: [
      'Since {rival} raised it: {company} will publish the comparison in full, and it will not flatter them.',
      'If {rival} wants a public argument about quality, we accept, on the evaluation of their choosing.',
    ],
    evangelical: [
      '{rival} is talking about {company} because customers keep choosing us. Long may it continue.',
      'We will take that from {rival} as the compliment it is, and keep shipping.',
    ],
  },
};

/** Interpolate one template, choosing the variant deterministically. */
export function renderNpcText(key: NpcTemplateKey, voice: Voice, rng: SeededRng, fields: TemplateFields): string {
  const variants = TEMPLATES[key][voice];
  const chosen = variants[rng.int(0, Math.max(0, variants.length - 1))] ?? variants[0] ?? '';
  return chosen
    .replace(/\{company\}/g, fields.company)
    .replace(/\{subject\}/g, fields.subject)
    .replace(/\{rival\}/g, fields.rival)
    .replace(/\{figure\}/g, fields.figure)
    .slice(0, 560);
}

/* -------------------------------------------------------------------------- */
/*  Candidates                                                                 */
/* -------------------------------------------------------------------------- */

/** One thing somebody might say this quarter, and how much it deserves the airtime. */
export interface NpcPostCandidate {
  readonly key: NpcTemplateKey;
  readonly authorCharacterId: string;
  readonly companyId: string | null;
  readonly network: NetworkArchetype;
  readonly intent: PostIntent;
  readonly targetCompanyId: string | null;
  /** 0..1. The budget takes the highest, and ties break on ids. */
  readonly salience: number;
  readonly fields: TemplateFields;
}

/** Events a company named by them answers for rather than comments on. */
const BAD_EVENT_TYPES: ReadonlySet<WorldEventType> = new Set<WorldEventType>([
  'safety_incident',
  'cyber_incident',
  'corporate_scandal',
  'public_backlash',
  'regulatory_action',
  'antitrust_investigation',
  'privacy_enforcement',
  'litigation',
  'copyright_ruling',
  'infrastructure_outage',
  'research_disappointment',
  'labour_action',
]);

/** Sectors whose customers are businesses; their founders post to the professional network. */
const PROFESSIONAL_SECTORS: ReadonlySet<string> = new Set(['manufacturing', 'energy', 'logistics']);

const emptyFields = (company: string): TemplateFields => ({ company, subject: '', rival: '', figure: '' });

/** Who speaks for a company: its chief executive, or its senior non-player executive. */
export function spokespersonFor(draft: SessionState, company: Company): Character | null {
  const ceoId = ceoOf(draft, company.id);
  const ceo = ceoId === null ? null : characterById(draft, ceoId);
  if (ceo !== null && ceo.isActive && !ceo.isPlayer) return ceo;

  const employed = draft.characters
    .filter((c) => c.companyId === company.id && c.isActive && !c.isPlayer && (c.role === 'founder_ceo' || c.role === 'executive'))
    .sort((a, b) => b.connectionLevel - a.connectionLevel || a.id.localeCompare(b.id));
  return employed[0] ?? null;
}

/** Which network a given intent lands on for a given author. */
function networkFor(author: Character, company: Company | null, intent: PostIntent): NetworkArchetype {
  if (intent === 'hype' && company !== null && company.isPublic) return 'finance';
  if (intent === 'announce' && author.stableTraits.technicalOrientation >= 80) return 'technical_forum';
  if (company !== null && PROFESSIONAL_SECTORS.has(company.sectorId)) return 'professional';
  return 'fast_feed';
}

/**
 * Everything anybody in the world has reason to say this quarter.
 *
 * Reads committed state only — the social phase runs after government, capital,
 * products and the market, so an award, a raise, a launch and a price move are
 * all already in the draft. Nothing here draws from the random stream: the
 * candidate set is a pure function of the state.
 */
export function collectNpcPostCandidates(draft: SessionState, quarter: number): NpcPostCandidate[] {
  const candidates: NpcPostCandidate[] = [];
  const companies = draft.companies.filter((company) => company.isActive).sort((a, b) => a.id.localeCompare(b.id));

  const add = (candidate: NpcPostCandidate): void => {
    candidates.push({ ...candidate, salience: round(clamp(candidate.salience, 0, 1), 4) });
  };

  /* --- world events ------------------------------------------------------- */
  const events = draft.activeEvents
    .filter((event) => event.quarter === quarter && event.visibility !== 'private')
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const event of events) {
    const named = companies.filter((company) => event.affectedCompanyIds.includes(company.id));
    const inSector = companies
      .filter((company) => !event.affectedCompanyIds.includes(company.id) && event.affectedSectorIds.includes(company.sectorId))
      .sort((a, b) => b.reputation.public - a.reputation.public || a.id.localeCompare(b.id))
      .slice(0, SECTOR_REACTIONS_PER_EVENT);

    for (const company of named) {
      const author = spokespersonFor(draft, company);
      if (author === null) continue;
      const bad = BAD_EVENT_TYPES.has(event.type);
      const key: NpcTemplateKey = !bad ? 'event_react' : event.severity >= APOLOGY_SEVERITY ? 'event_apologise' : 'event_defend';
      const intent: PostIntent = key === 'event_react' ? 'announce' : key === 'event_apologise' ? 'apologise' : 'defend';
      add({
        key,
        authorCharacterId: author.id,
        companyId: company.id,
        network: networkFor(author, company, intent),
        intent,
        targetCompanyId: null,
        salience: 0.55 + 0.4 * event.severity,
        fields: { ...emptyFields(company.name), subject: event.title },
      });
    }

    for (const company of inSector) {
      const author = spokespersonFor(draft, company);
      if (author === null) continue;
      add({
        key: 'event_react',
        authorCharacterId: author.id,
        companyId: company.id,
        network: networkFor(author, company, 'announce'),
        intent: 'announce',
        targetCompanyId: null,
        salience: 0.28 + 0.3 * event.severity,
        fields: { ...emptyFields(company.name), subject: event.title },
      });
    }
  }

  /* --- launches, raises, awards, losses ----------------------------------- */
  for (const company of companies) {
    const author = spokespersonFor(draft, company);
    if (author === null) continue;

    // Quarter zero is the opening position, not a launch event: every scenario
    // seeds its companies with products already live, and fifteen founders all
    // announcing the product they have been selling for years is not news.
    const launched = quarter <= 0
      ? undefined
      : company.products.filter((product) => product.isActive && product.launchedQuarter === quarter).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (launched !== undefined) {
      add({
        key: 'product_launch',
        authorCharacterId: author.id,
        companyId: company.id,
        network: networkFor(author, company, 'announce'),
        intent: 'announce',
        targetCompanyId: null,
        salience: 0.5 + 0.3 * launched.qualityScore,
        fields: { ...emptyFields(company.name), subject: launched.name },
      });
    }
  }

  const rounds = draft.fundingRounds
    .filter((round_) => round_.closedQuarter === quarter && round_.status === 'closed')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const raise of rounds) {
    const company = companyById(draft, raise.companyId);
    if (company === null || !company.isActive) continue;
    const author = spokespersonFor(draft, company);
    if (author === null) continue;
    add({
      key: 'funding_round',
      authorCharacterId: author.id,
      companyId: company.id,
      network: networkFor(author, company, 'announce'),
      intent: 'announce',
      targetCompanyId: null,
      salience: 0.5 + clamp(raise.amount / 2_000_000_000, 0, 0.3),
      fields: { ...emptyFields(company.name), figure: formatMoney(raise.amount) },
    });
  }

  const awarded = draft.governmentContracts
    .filter((contract) => contract.awardedQuarter === quarter)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const contract of awarded) {
    const opportunity = draft.procurementOpportunities.find((entry) => entry.id === contract.opportunityId) ?? null;
    const programme = opportunity?.programme ?? 'a public programme';

    const winner = companyById(draft, contract.primeCompanyId);
    if (winner !== null && winner.isActive) {
      const author = spokespersonFor(draft, winner);
      if (author !== null) {
        add({
          key: 'contract_win',
          authorCharacterId: author.id,
          companyId: winner.id,
          network: networkFor(author, winner, 'announce'),
          intent: 'announce',
          targetCompanyId: null,
          salience: 0.6 + clamp(contract.totalValueUsd / 5_000_000_000, 0, 0.25),
          fields: { ...emptyFields(winner.name), subject: programme, figure: formatMoney(contract.totalValueUsd) },
        });
      }
    }

    const losers = draft.governmentBids
      .filter((bid) => bid.opportunityId === contract.opportunityId && bid.status === 'lost')
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const bid of losers) {
      const loser = companyById(draft, bid.bidderCompanyId);
      if (loser === null || !loser.isActive) continue;
      const author = spokespersonFor(draft, loser);
      if (author === null) continue;
      add({
        key: 'contract_loss',
        authorCharacterId: author.id,
        companyId: loser.id,
        network: networkFor(author, loser, 'defend'),
        intent: 'defend',
        targetCompanyId: null,
        salience: 0.32 + clamp(contract.totalValueUsd / 10_000_000_000, 0, 0.15),
        fields: { ...emptyFields(loser.name), subject: programme },
      });
    }
  }

  /* --- the tape ----------------------------------------------------------- */
  const quotes = draft.quotes.filter((quote) => quote.quarter === quarter).sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
  for (const quote of quotes) {
    if (Math.abs(quote.return) < PRICE_MOVE_THRESHOLD) continue;
    const instrument = draft.marketInstruments.find((entry) => entry.id === quote.instrumentId) ?? null;
    if (instrument === null || instrument.isReference || instrument.companyId === null) continue;
    const company = companyById(draft, instrument.companyId);
    if (company === null || !company.isActive) continue;
    const author = spokespersonFor(draft, company);
    if (author === null) continue;

    const up = quote.return > 0;
    const intent: PostIntent = up ? 'hype' : 'defend';
    add({
      key: up ? 'price_up' : 'price_down',
      authorCharacterId: author.id,
      companyId: company.id,
      network: networkFor(author, company, intent),
      intent,
      targetCompanyId: null,
      salience: 0.28 + clamp(Math.abs(quote.return), 0, 0.35),
      fields: { ...emptyFields(company.name), figure: formatPct(Math.abs(quote.return)) },
    });
  }

  /* --- hostility ---------------------------------------------------------- */
  for (const company of companies) {
    const author = spokespersonFor(draft, company);
    if (author === null || author.stableTraits.aggressiveness < AGGRESSION_ATTACK_THRESHOLD) continue;

    const grudges = draft.relationships
      .filter((edge) => edge.fromId === author.id && edge.hostility >= HOSTILITY_ATTACK_THRESHOLD)
      .sort((a, b) => b.hostility - a.hostility || a.toId.localeCompare(b.toId));
    for (const grudge of grudges) {
      const other = characterById(draft, grudge.toId);
      if (other === null || !other.isActive || other.companyId === null || other.companyId === company.id) continue;
      const rival = companyById(draft, other.companyId);
      if (rival === null || !rival.isActive) continue;
      // A grudge lasts for quarters, so without a cooldown the same founder
      // makes the same jab at the same rival every quarter for a decade. Say it
      // once, then let it sit.
      const saidRecently = draft.socialPosts.some(
        (post) =>
          post.authorCharacterId === author.id &&
          post.intent === 'attack' &&
          post.targetCompanyId === rival.id &&
          post.quarter >= quarter - ATTACK_COOLDOWN_QUARTERS,
      );
      if (saidRecently) break;
      add({
        key: 'attack_rival',
        authorCharacterId: author.id,
        companyId: company.id,
        network: 'fast_feed',
        intent: 'attack',
        targetCompanyId: rival.id,
        salience: 0.22 + clamp(grudge.hostility / 300, 0, 0.3),
        fields: { ...emptyFields(company.name), rival: rival.name },
      });
      break;
    }
  }

  /* --- the press ---------------------------------------------------------- */
  const journalists = draft.characters
    .filter((character) => character.role === 'journalist' && character.isActive && !character.isPlayer)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const journalist of journalists) {
    const story = draft.mediaStories
      .filter((entry) => entry.authorCharacterId === journalist.id && entry.quarter === quarter - 1)
      .sort((a, b) => b.prominence - a.prominence || a.id.localeCompare(b.id))[0];
    if (story === undefined) continue;
    add({
      key: 'press_teaser',
      authorCharacterId: journalist.id,
      companyId: null,
      network: 'fast_feed',
      intent: 'announce',
      targetCompanyId: null,
      salience: 0.24 + 0.4 * story.prominence,
      fields: { ...emptyFields(journalist.name), subject: story.headline },
    });
  }

  /* --- public buyers ------------------------------------------------------ */
  const opened = draft.procurementOpportunities
    .filter((opportunity) => opportunity.openQuarter === quarter && opportunity.visibility === 'public')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const opportunity of opened) {
    const agency = draft.agencies.find((entry) => entry.id === opportunity.agencyId) ?? null;
    if (agency === null) continue;
    const official = agency.contactCharacterIds
      .map((id) => characterById(draft, id))
      .find((character): character is Character => character !== null && character.isActive && !character.isPlayer && (character.role === 'official' || character.role === 'regulator'));
    if (official === undefined) continue;
    add({
      key: 'programme_notice',
      authorCharacterId: official.id,
      companyId: null,
      network: 'professional',
      intent: 'announce',
      targetCompanyId: null,
      salience: 0.3 + clamp(opportunity.maxValue / 5_000_000_000, 0, 0.2),
      fields: { company: agency.shortName, subject: opportunity.programme, rival: agency.shortName, figure: formatMoney(opportunity.maxValue) },
    });
  }

  return candidates;
}

/**
 * Cut the candidate set down to the quarter's budget.
 *
 * Highest salience first, one post per character — a founder with a launch, a
 * raise and a grudge in the same quarter says the loudest of the three — and
 * every tie broken on ids so the same state always chooses the same posts.
 * The result is returned in publication order (author, then template), which is
 * the order the seeded stream is drawn in.
 */
export function selectNpcPostCandidates(candidates: readonly NpcPostCandidate[], budget: number): NpcPostCandidate[] {
  const ranked = [...candidates].sort(
    (a, b) => b.salience - a.salience || a.authorCharacterId.localeCompare(b.authorCharacterId) || a.key.localeCompare(b.key),
  );
  const spoken = new Set<string>();
  const chosen: NpcPostCandidate[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= budget) break;
    if (spoken.has(candidate.authorCharacterId)) continue;
    spoken.add(candidate.authorCharacterId);
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.authorCharacterId.localeCompare(b.authorCharacterId) || a.key.localeCompare(b.key));
}

/* -------------------------------------------------------------------------- */
/*  Publication                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Publish this quarter's NPC posts.
 *
 * Called at the top of `propagatePosts`, so the posts it creates are propagated
 * by the same code, in the same pass, as anything a player submitted: reach,
 * engagement, sentiment, press pickup and disclosures are all computed
 * downstream and none of them are supplied here.
 */
export function generateNpcPosts(draft: SessionState, ctx: ResolverContext): SocialPost[] {
  if (!npcPostingEnabled(draft)) return [];

  const rng = ctx.rng.fork(`npc_posts_q${ctx.quarter}`);
  const chosen = selectNpcPostCandidates(collectNpcPostCandidates(draft, ctx.quarter), npcPostBudget(draft.companies.length));
  const created: SocialPost[] = [];

  for (const candidate of chosen) {
    const author = characterById(draft, candidate.authorCharacterId);
    if (author === null || !author.isActive || author.isPlayer) continue;
    // One voice, one post: a character the player already spoke as, or who has
    // already said something this quarter, is not given a second turn.
    if (draft.socialPosts.some((post) => post.quarter === ctx.quarter && post.authorCharacterId === author.id)) continue;

    const account = ensureAccount(draft, author.id, candidate.network);
    if (account === null) continue;

    const id = makeId('pst', 'npc', draft.sessionId, ctx.quarter, author.id, candidate.key);
    if (draft.socialPosts.some((post) => post.id === id)) continue;

    const post: SocialPost = {
      id,
      accountId: account.id,
      quarter: ctx.quarter,
      authorCharacterId: author.id,
      network: candidate.network,
      text: renderNpcText(candidate.key, voiceOf(author), rng, candidate.fields),
      intent: candidate.intent,
      targetCompanyId: candidate.targetCompanyId,
      engagement: null,
      isAiGenerated: true,
      reportedCount: 0,
      replyToPostId: null,
    };
    draft.socialPosts.push(post);
    created.push(post);
  }

  return created;
}

/**
 * Answer the quarter's public attacks.
 *
 * A post aimed at a company draws a reply from whoever speaks for that company,
 * in the same quarter and on the same network, carrying `replyToPostId` so the
 * two read as a thread. Who answers and how is decided by traits: an aggressive
 * chief executive counter-attacks, everybody else defends.
 *
 * A player's character is never made to reply — the engine does not put words in
 * a human's mouth — and a reply never itself draws a reply, so a thread is two
 * posts deep and the quarter cannot cascade.
 */
export function generateNpcReplies(draft: SessionState, ctx: ResolverContext): SocialPost[] {
  if (!npcPostingEnabled(draft)) return [];

  const rng = ctx.rng.fork(`npc_replies_q${ctx.quarter}`);
  const parents = draft.socialPosts
    .filter((post) => post.quarter === ctx.quarter && post.replyToPostId === null && post.targetCompanyId !== null && post.engagement !== null)
    .sort((a, b) => (b.engagement?.reach ?? 0) - (a.engagement?.reach ?? 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_NPC_REPLIES_PER_QUARTER);

  const created: SocialPost[] = [];
  for (const parent of parents) {
    if (parent.targetCompanyId === null) continue;
    if (draft.socialPosts.some((post) => post.replyToPostId === parent.id)) continue;

    const target = companyById(draft, parent.targetCompanyId);
    if (target === null || !target.isActive) continue;
    const responder = spokespersonFor(draft, target);
    if (responder === null || responder.id === parent.authorCharacterId) continue;

    const account = ensureAccount(draft, responder.id, parent.network);
    if (account === null) continue;

    const id = makeId('pst', 'rep', parent.id, responder.id);
    if (draft.socialPosts.some((post) => post.id === id)) continue;

    const provoked = parent.intent === 'attack' || parent.intent === 'leak';
    const counter = provoked && responder.stableTraits.aggressiveness >= AGGRESSION_ATTACK_THRESHOLD;
    const accuser = characterById(draft, parent.authorCharacterId);
    const accuserCompany = accuser?.companyId === null || accuser?.companyId === undefined ? null : companyById(draft, accuser.companyId);

    const reply: SocialPost = {
      id,
      accountId: account.id,
      quarter: ctx.quarter,
      authorCharacterId: responder.id,
      network: parent.network,
      text: renderNpcText(counter ? 'reply_counter' : 'reply_defend', voiceOf(responder), rng, {
        company: target.name,
        subject: '',
        rival: accuserCompany?.name ?? accuser?.name ?? 'the claim',
        figure: '',
      }),
      intent: counter ? 'attack' : 'defend',
      // A reply is aimed back at whoever made the claim, so the hostility it
      // creates lands on the right company rather than nowhere.
      targetCompanyId: accuserCompany?.id ?? null,
      engagement: null,
      isAiGenerated: true,
      reportedCount: 0,
      replyToPostId: parent.id,
    };
    draft.socialPosts.push(reply);
    created.push(reply);
  }

  return created;
}

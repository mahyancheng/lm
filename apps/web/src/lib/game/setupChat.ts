/**
 * The new-game conversation, deterministically.
 *
 * A founder starts a company by talking to the Chief of Staff: they tap chips
 * (a sector, a region, a background) or they type "a robotics startup in East
 * Asia, call it Kestrel Dynamics". Both paths produce the same thing — a
 * `SetupProposal` — and `newGameSetupFromProposal` turns that into the
 * `NewGameSetup` the scenario builder is handed.
 *
 * ## Two readers, one of them always
 *
 * Free text is read twice. This module's keyword parser runs on **every**
 * message, model or no model; the setup-interpreter role runs only when a live
 * model is configured, and its answer is merged *underneath* this one — it may
 * fill slots the keywords left open, never overwrite a slot the keywords
 * matched. Two consequences, both deliberate:
 *
 * - The whole flow works offline. No model is a slower conversation with more
 *   direct questions, not a broken screen.
 * - A slot the player stated in so many words cannot be reinterpreted. "Call it
 *   Kestrel Dynamics" is not a matter of opinion.
 *
 * ## Nothing here is guessed
 *
 * A word that could mean two sectors ("something physical", "Asia") establishes
 * neither: the slot stays null, lands in `missing`, and the next question asks
 * for it. Filling a slot the founder did not choose is the one failure that
 * matters on this screen — they live in that world for the rest of the game.
 *
 * ## Not game state
 *
 * Nothing in this module writes anything. The proposal is a value the page
 * holds until the player taps Found; `newGameSetupFromProposal` re-validates it
 * through `NewGameSetupSchema` and the engine builds the world from the result.
 */

import type { BackgroundId, NewGameSetup, Region, Sector, SetupProposal, SetupSlot } from '@frontier/contracts';
import {
  ALL_BACKGROUNDS,
  CURRENT_WORLD_VERSION,
  REGIONS,
  REGION_META,
  SECTORS,
  SECTOR_META,
  SETUP_SLOTS,
  SetupProposalSchema,
  backgroundById,
  backgroundsForSector,
  isRegion,
  isSector,
  missingSetupSlots,
  newGameSetupFromProposal,
  regionsBySectorAffinity,
  sectorForBackground,
} from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The longest a company or founder name may be, mirroring `NewGameSetupSchema`. */
export const SETUP_NAME_MAX = 40;

/** Nothing established, nothing read. Every conversation starts here. */
export const EMPTY_SETUP_PROPOSAL: SetupProposal = SetupProposalSchema.parse({
  confidence: 0,
  missing: [...SETUP_SLOTS],
});

/**
 * The order the conversation asks in: the world first, then the company.
 *
 * Sector before region because region is priced *against* a sector — the
 * affinity ordering of the region chips depends on it — and the two names last
 * because naming a company you have not decided on is the hardest question in
 * the list.
 */
export const SETUP_ASK_ORDER: readonly SetupSlot[] = ['sector', 'region', 'backgroundId', 'companyName', 'founderName'];

/**
 * How sure a reading is, by how it was established.
 *
 * A tap is not a reading at all, so it is 1. A keyword match on an enumerated
 * value is strong: the word "robotics" means one thing. A name lifted out of a
 * sentence is the weakest of the three, because the pattern that caught it can
 * also catch a phrase that is not a name — which is what `looksLikeName` is
 * for, and why anything it rejects establishes nothing.
 */
export const SETUP_CONFIDENCE = {
  chosen: 1,
  keyword: 0.8,
  name: 0.6,
} as const;

/** Below this the interface asks the player to confirm rather than acting on the reading. */
export const SETUP_CONFIRM_BELOW = 0.4;

/* -------------------------------------------------------------------------- */
/*  Keyword tables                                                             */
/* -------------------------------------------------------------------------- */

interface Phrase<T> {
  readonly value: T;
  readonly text: string;
}

/**
 * Build a phrase table from `{ value: [words] }`, longest phrase first.
 *
 * Ordering matters for the match rule below: the *longest* matching phrase
 * wins, so "warehouse robotics" beats "warehouse" and "latin america" beats
 * "america" without either table having to know the other exists.
 */
function phrases<T extends string>(source: Readonly<Record<T, readonly string[]>>): readonly Phrase<T>[] {
  const list: Phrase<T>[] = [];
  for (const [value, words] of Object.entries(source) as [T, readonly string[]][]) {
    for (const text of words) list.push({ value, text });
  }
  return list.sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1));
}

/**
 * What a founder calls each sector.
 *
 * Deliberately absent: "tech", "hardware on its own", "physical" — each covers
 * three of these six, and a word that names three sectors names none.
 */
const SECTOR_PHRASES = phrases<Sector>({
  ai: [
    'ai', 'a i', 'artificial intelligence', 'machine learning', 'llm', 'llms', 'language model', 'language models',
    'foundation model', 'foundation models', 'frontier model', 'frontier models', 'frontier lab', 'model lab',
    'agents', 'software', 'saas', 'enterprise software', 'inference',
  ],
  robotics: [
    'robot', 'robots', 'robotic', 'robotics', 'humanoid', 'humanoids', 'automation', 'autonomy', 'autonomous',
    'drone', 'drones', 'cobot', 'cobots', 'warehouse robotics', 'robot fleet',
  ],
  manufacturing: [
    'manufacturing', 'manufacture', 'manufacturer', 'manufacturers', 'factory', 'factories', 'fab', 'fabs',
    'foundry', 'assembly line', 'industrial', 'machining', 'components', 'precision components', 'plant',
    'contract manufacturer', 'production line', 'semiconductors',
  ],
  energy: [
    'energy', 'power', 'grid', 'solar', 'wind', 'nuclear', 'renewable', 'renewables', 'battery', 'batteries',
    'electricity', 'utility', 'utilities', 'generation', 'power plant', 'turbines',
  ],
  logistics: [
    'logistics', 'freight', 'shipping', 'trucking', 'trucks', 'warehouse', 'warehousing', 'delivery', 'deliveries',
    'supply chain', 'last mile', 'courier', 'fulfilment', 'fulfillment', 'haulage', 'distribution',
  ],
  consumer: [
    'consumer', 'consumers', 'retail', 'retailer', 'brand', 'brands', 'dtc', 'direct to consumer', 'ecommerce',
    'e commerce', 'shopper', 'shoppers', 'marketplace', 'subscription', 'apparel', 'grocery',
  ],
});

/**
 * Where a founder says they are.
 *
 * "Asia" on its own is deliberately absent: it names two of these six, so it
 * establishes neither and the interface asks. "US" on its own is absent for a
 * different reason — it is a pronoun as often as a country.
 */
const REGION_PHRASES = phrases<Region>({
  north_america: [
    'north america', 'north american', 'united states', 'usa', 'america', 'american', 'canada', 'canadian',
    'california', 'silicon valley', 'san francisco', 'bay area', 'new york', 'seattle', 'austin', 'boston', 'toronto',
  ],
  europe: [
    'europe', 'european', 'eu', 'uk', 'united kingdom', 'britain', 'british', 'london', 'germany', 'german',
    'berlin', 'munich', 'france', 'french', 'paris', 'netherlands', 'amsterdam', 'nordic', 'sweden', 'stockholm',
    'ireland', 'dublin', 'switzerland', 'zurich', 'spain', 'italy', 'milan',
  ],
  east_asia: [
    'east asia', 'east asian', 'china', 'chinese', 'japan', 'japanese', 'korea', 'korean', 'taiwan', 'taiwanese',
    'tokyo', 'osaka', 'shenzhen', 'shanghai', 'beijing', 'seoul', 'taipei', 'hong kong', 'singapore',
  ],
  south_asia: [
    'south asia', 'south asian', 'india', 'indian', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad',
    'chennai', 'pune', 'pakistan', 'karachi', 'sri lanka', 'bangladesh', 'dhaka',
  ],
  middle_east: [
    'middle east', 'middle eastern', 'gulf', 'uae', 'emirates', 'dubai', 'abu dhabi', 'saudi', 'saudi arabia',
    'riyadh', 'qatar', 'doha', 'israel', 'tel aviv', 'kuwait', 'oman', 'bahrain',
  ],
  latin_america: [
    'latin america', 'latin american', 'latam', 'south america', 'brazil', 'brazilian', 'sao paulo', 'mexico',
    'mexico city', 'mexican', 'chile', 'santiago', 'argentina', 'buenos aires', 'colombia', 'bogota', 'peru',
  ],
});

/**
 * The backgrounds, by their own label and id.
 *
 * Derived rather than transcribed: a background added to the contracts is
 * matchable here the same day, and a label edited there cannot leave a stale
 * copy behind.
 */
const BACKGROUND_PHRASES: readonly Phrase<BackgroundId>[] = (() => {
  const list: Phrase<BackgroundId>[] = [];
  for (const background of ALL_BACKGROUNDS) {
    list.push({ value: background.id, text: background.label.toLowerCase() });
    const fromId = background.id.replace(/_/g, ' ');
    if (fromId !== background.label.toLowerCase()) list.push({ value: background.id, text: fromId });
  }
  return list.sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1));
})();

/* -------------------------------------------------------------------------- */
/*  Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** Punctuation and case removed, so "East-Asia," and "east asia" match the same phrase. */
function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * The one value a message names, or null when it names none — or two.
 *
 * The longest matching phrase wins, which resolves the overlaps between tables
 * ("warehouse robotics" over "warehouse") and inside them ("latin america" over
 * "america"). Two *different* values matching at that same longest length is
 * ambiguity, and ambiguity establishes nothing.
 */
function matchOne<T extends string>(haystack: string, table: readonly Phrase<T>[]): T | null {
  let best: T | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const phrase of table) {
    if (phrase.text.length < bestLength) break;
    if (!haystack.includes(` ${phrase.text} `)) continue;
    if (best === null) {
      best = phrase.value;
      bestLength = phrase.text.length;
    } else if (phrase.text.length === bestLength && phrase.value !== best) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

/* -------------------------------------------------------------------------- */
/*  Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Words that mean the capture is a description, not a name.
 *
 * "I'm building a robotics company" matches the same pattern as "I'm Rae
 * Fontaine", and the difference between them is entirely in what follows. A
 * capture containing any of these is refused, which costs a founder called
 * "The Want" nothing they cannot fix by tapping the chip.
 */
const NOT_A_NAME = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'building', 'build', 'starting', 'start', 'started', 'making', 'make',
  'going', 'doing', 'looking', 'interested', 'want', 'wants', 'wanted', 'thinking', 'hoping', 'trying', 'keen',
  'planning', 'founding', 'here', 'ready', 'new', 'not', 'sure', 'just', 'really', 'very', 'somebody', 'someone',
  'working', 'work', 'from', 'with', 'that', 'this', 'who', 'what', 'about', 'idea', 'company', 'business',
  'startup', 'firm', 'my', 'your', 'our', 'their', 'his', 'her', 'its',
]);

/** Where a captured name ends: a conjunction, a preposition, a dash. */
const NAME_TAIL = /\s+(?:and|in|for|with|based|out of|working|building|that|which|then)\b.*$/i;

/**
 * Is this capture a name a person would answer to?
 *
 * Four words at most, forty characters at most (the schema's own ceiling), and
 * no word from `NOT_A_NAME`. Everything else is left for the chip or the next
 * question, because a company called "building a robotics company" is worse
 * than one more question.
 */
export function looksLikeName(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > SETUP_NAME_MAX) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  return !words.some((word) => NOT_A_NAME.has(word.toLowerCase().replace(/[^a-z']/gi, '')));
}

/** Trim a capture down to the name inside it, or null when there is not one. */
function cleanName(capture: string | undefined): string | null {
  if (capture === undefined) return null;
  const cut = capture.replace(NAME_TAIL, '').replace(/["'“”‘’.,;:!?]+$/g, '').replace(/^["'“”‘’]+/g, '').trim();
  return looksLikeName(cut) ? cut : null;
}

/** How a founder gives the company's name. Ordered: the first match wins. */
const COMPANY_PATTERNS: readonly RegExp[] = [
  /\bcall (?:it|the company|the firm|us) ([^.,;:!?\n]{1,60})/i,
  /\bname (?:it|the company|the firm|us) ([^.,;:!?\n]{1,60})/i,
  /\b(?:company|firm|it)(?:'s| is| will be)? (?:called|named) ([^.,;:!?\n]{1,60})/i,
  /\bcompany name(?: is)? ([^.,;:!?\n]{1,60})/i,
  /\b(?:called|named) ([^.,;:!?\n]{1,60})/i,
];

/** How a founder gives their own name. `call me` is here, `call it` is above. */
const FOUNDER_PATTERNS: readonly RegExp[] = [
  /\bmy name(?:'s| is)? ([^.,;:!?\n]{1,60})/i,
  /\bcall me ([^.,;:!?\n]{1,60})/i,
  /\b(?:i'm|i am|im) ([^.,;:!?\n]{1,60})/i,
  /\bfounder(?:'s name)?(?: is)? ([^.,;:!?\n]{1,60})/i,
  /\bplaying as ([^.,;:!?\n]{1,60})/i,
  /\bthis is ([^.,;:!?\n]{1,60})/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found === null) continue;
    const name = cleanName(found[1]);
    if (name !== null) return name;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Proposals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Repair a proposal's internal contradictions and derive `missing`.
 *
 * Three rules, in this order:
 *
 * 1. A name that is blank or over the schema's ceiling is not a name.
 * 2. A background with no sector beside it **establishes** the sector — picking
 *    the Humanoid Lab is a way of saying robotics.
 * 3. A background belonging to some *other* sector is dropped, because the
 *    sector the player named last is what they meant and the interface should
 *    ask for a background again rather than substitute one silently.
 *
 * `missing` is always derived, never carried: it is the field the next question
 * is asked from, and a stale one asks for something already answered.
 */
export function normaliseSetupProposal(proposal: SetupProposal): SetupProposal {
  const companyName = proposal.companyName === null ? null : trimmedName(proposal.companyName);
  const founderName = proposal.founderName === null ? null : trimmedName(proposal.founderName);

  const background = proposal.backgroundId === null ? undefined : backgroundById(proposal.backgroundId);
  const sector: Sector | null =
    proposal.sector ?? (proposal.backgroundId === null ? null : sectorForBackground(proposal.backgroundId));
  const backgroundId =
    background === undefined || (sector !== null && background.sector !== sector) ? null : background.id;

  const next: SetupProposal = { ...proposal, companyName, founderName, sector, backgroundId, missing: [] };
  return { ...next, missing: [...missingSetupSlots(next)] };
}

function trimmedName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > SETUP_NAME_MAX ? null : trimmed;
}

/**
 * Merge two readings of the same conversation, `preferred` winning every slot
 * it filled.
 *
 * Used twice, and the argument order carries the whole policy both times:
 * `merge(thisMessage, established)` lets a founder change their mind, and
 * `merge(keywords, model)` lets the model fill only what the keywords left
 * open.
 *
 * The confidence that comes out is the *lowest* of the readings that actually
 * contributed a slot, so one loose name capture drags the whole proposal below
 * the confirmation threshold rather than hiding behind four confident chips.
 */
export function mergeSetupProposals(preferred: SetupProposal, fallback: SetupProposal): SetupProposal {
  const merged: SetupProposal = {
    companyName: preferred.companyName ?? fallback.companyName,
    founderName: preferred.founderName ?? fallback.founderName,
    sector: preferred.sector ?? fallback.sector,
    region: preferred.region ?? fallback.region,
    backgroundId: preferred.backgroundId ?? fallback.backgroundId,
    confidence: 0,
    missing: [],
  };

  const confidences: number[] = [];
  if (filledCount(preferred) > 0) confidences.push(preferred.confidence);
  if (contributes(fallback, preferred)) confidences.push(fallback.confidence);
  const confidence = confidences.length === 0 ? 0 : Math.min(...confidences);

  return normaliseSetupProposal({ ...merged, confidence });
}

/** How many of the five slots a proposal has established. */
function filledCount(proposal: SetupProposal): number {
  return SETUP_SLOTS.length - missingSetupSlots(proposal).length;
}

/** Does `fallback` supply anything `preferred` left open? */
function contributes(fallback: SetupProposal, preferred: SetupProposal): boolean {
  return (
    (preferred.companyName === null && fallback.companyName !== null) ||
    (preferred.founderName === null && fallback.founderName !== null) ||
    (preferred.sector === null && fallback.sector !== null) ||
    (preferred.region === null && fallback.region !== null) ||
    (preferred.backgroundId === null && fallback.backgroundId !== null)
  );
}

/**
 * Read one typed message, on top of what the conversation already established.
 *
 * Pure and total: same text, same proposal, every time, and never a throw. The
 * newest statement wins — a founder who says "actually, energy" gets energy,
 * and the background that belonged to the old sector is dropped by
 * `normaliseSetupProposal` rather than quietly carried into the new one.
 */
export function parseSetupMessage(message: string, established: SetupProposal = EMPTY_SETUP_PROPOSAL): SetupProposal {
  const haystack = normalise(message);

  const sector = matchOne(haystack, SECTOR_PHRASES);
  const region = matchOne(haystack, REGION_PHRASES);
  const backgroundId = matchOne(haystack, BACKGROUND_PHRASES);
  const companyName = firstMatch(message, COMPANY_PATTERNS);
  const founderName = firstMatch(message, FOUNDER_PATTERNS);

  const enums = [sector, region, backgroundId].filter((value) => value !== null).length;
  const names = [companyName, founderName].filter((value) => value !== null).length;
  const confidence =
    enums + names === 0 ? 0 : names > 0 ? SETUP_CONFIDENCE.name : SETUP_CONFIDENCE.keyword;

  const reading = normaliseSetupProposal({
    companyName,
    founderName,
    sector,
    region,
    backgroundId,
    confidence,
    missing: [],
  });

  return mergeSetupProposals(reading, established);
}

/**
 * Record an explicit choice: a chip tap, or a name typed into a labelled field.
 *
 * A tap is certain, so it establishes the first slot at full confidence — but
 * it cannot *raise* a proposal that already contains a loosely-read name.
 * Confidence describes the least certain thing in the proposal, and a tap on
 * the sector says nothing about whether the name was read correctly.
 *
 * Total in its `value`: a value that is not one of the enumerated ids leaves
 * the proposal exactly as it was, so a stale chip can never establish a sector
 * the world does not have.
 */
export function applySetupChoice(proposal: SetupProposal, slot: SetupSlot, value: string): SetupProposal {
  const confidence = proposal.confidence === 0 ? SETUP_CONFIDENCE.chosen : proposal.confidence;
  const chosen: SetupProposal = { ...proposal, confidence };
  switch (slot) {
    case 'sector':
      // A new sector invalidates a background from the old one; the normaliser
      // drops it, and the conversation asks again.
      return isSector(value) ? normaliseSetupProposal({ ...chosen, sector: value }) : proposal;
    case 'region':
      return isRegion(value) ? normaliseSetupProposal({ ...chosen, region: value }) : proposal;
    case 'backgroundId': {
      const background = backgroundById(value);
      return background === undefined ? proposal : normaliseSetupProposal({ ...chosen, backgroundId: background.id });
    }
    case 'companyName':
      return normaliseSetupProposal({ ...chosen, companyName: value });
    case 'founderName':
      return normaliseSetupProposal({ ...chosen, founderName: value });
  }
}

/**
 * Unset one slot, so the conversation asks for it again.
 *
 * Clearing the sector clears the background with it: a background *is* a
 * sector, so leaving it behind would re-establish the very thing the player
 * just took back.
 */
export function clearSetupSlot(proposal: SetupProposal, slot: SetupSlot): SetupProposal {
  switch (slot) {
    case 'sector':
      return normaliseSetupProposal({ ...proposal, sector: null, backgroundId: null });
    case 'region':
      return normaliseSetupProposal({ ...proposal, region: null });
    case 'backgroundId':
      return normaliseSetupProposal({ ...proposal, backgroundId: null });
    case 'companyName':
      return normaliseSetupProposal({ ...proposal, companyName: null });
    case 'founderName':
      return normaliseSetupProposal({ ...proposal, founderName: null });
  }
}

/** The next thing to ask for, in `SETUP_ASK_ORDER`, or null when the world is ready to build. */
export function nextSetupSlot(proposal: SetupProposal): SetupSlot | null {
  const missing = new Set(missingSetupSlots(proposal));
  return SETUP_ASK_ORDER.find((slot) => missing.has(slot)) ?? null;
}

/**
 * The setup this proposal builds, or null when it is not ready.
 *
 * Always at `CURRENT_WORLD_VERSION`: a game founded through this conversation
 * is a world-2 game. World 1 is reachable only by replaying a save that was
 * made in it.
 */
export function setupFromProposal(proposal: SetupProposal): NewGameSetup | null {
  return newGameSetupFromProposal(proposal, CURRENT_WORLD_VERSION);
}

/* -------------------------------------------------------------------------- */
/*  What the Chief of Staff says                                               */
/* -------------------------------------------------------------------------- */

/** The opening line, before the founder has said anything. */
export const SETUP_OPENING =
  'Before we open the doors — where do we begin? Tap one of these, or just tell me what you have in mind and I will read it back to you.';

/** Free-text openings that show the conversation understands more than the chips do. */
export const SETUP_EXAMPLES: readonly string[] = [
  'A robotics startup in East Asia, call it Kestrel Dynamics.',
  'Grid-scale energy in the Middle East. I am Rae Fontaine.',
  'Something in freight out of South Asia, bootstrapped.',
];

const QUESTIONS: Readonly<Record<SetupSlot, string>> = {
  sector: 'Which part of the economy are we in?',
  region: 'And where in the world? Talent, power and government money all cost different things in different places.',
  backgroundId: 'What shape does the company start in?',
  companyName: 'What is the company called?',
  founderName: 'And who am I working for — what should I call you?',
};

/** The question for one slot. */
export function setupQuestion(slot: SetupSlot): string {
  return QUESTIONS[slot];
}

/** What the conversation just learned, as one sentence, or null when nothing changed. */
export function setupAcknowledgement(before: SetupProposal, after: SetupProposal): string | null {
  const learned: string[] = [];
  if (after.sector !== null && after.sector !== before.sector) learned.push(SECTOR_META[after.sector].label);
  if (after.region !== null && after.region !== before.region) learned.push(REGION_META[after.region].label);
  if (after.backgroundId !== null && after.backgroundId !== before.backgroundId) {
    learned.push(backgroundById(after.backgroundId)?.label ?? after.backgroundId);
  }
  if (after.companyName !== null && after.companyName !== before.companyName) learned.push(after.companyName);
  if (after.founderName !== null && after.founderName !== before.founderName) learned.push(after.founderName);
  if (learned.length === 0) return null;
  return `${learned.join(' · ')}.`;
}

/**
 * The whole company in one sentence, for the confirmation step.
 *
 * Only ever called on a complete proposal; the fallbacks exist so the type is
 * total rather than because they should ever be reached.
 */
export function setupSummaryLine(proposal: SetupProposal): string {
  const company = proposal.companyName ?? 'The company';
  const founder = proposal.founderName ?? 'you';
  const sector = proposal.sector === null ? 'the economy' : SECTOR_META[proposal.sector].label;
  const region = proposal.region === null ? 'somewhere' : REGION_META[proposal.region].label;
  const background = proposal.backgroundId === null ? null : backgroundById(proposal.backgroundId)?.label;
  const shape = background === null || background === undefined ? '' : ` It starts as a ${background}.`;
  return `${company}, founded by ${founder}: ${sector} in ${region}.${shape}`;
}

/* -------------------------------------------------------------------------- */
/*  What the founder can tap                                                   */
/* -------------------------------------------------------------------------- */

/** One quick reply: the value it establishes, and how to draw it. */
export interface SetupQuickReply {
  readonly slot: SetupSlot;
  readonly value: string;
  /** Icon name from the app's set; the caller checks it against `ICON_NAMES`. */
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
  /** What the player is taken to have said, so the transcript reads like a conversation. */
  readonly says: string;
}

/**
 * The chips for one slot.
 *
 * Region chips are ordered by how well the region suits the chosen sector
 * rather than alphabetically, so the first thing a thumb reaches is the answer
 * the world would give. Names have no chips: nothing here may invent a name for
 * a company somebody is about to spend a campaign inside.
 */
export function setupQuickReplies(slot: SetupSlot, proposal: SetupProposal): readonly SetupQuickReply[] {
  switch (slot) {
    case 'sector':
      return SECTORS.map((sector) => ({
        slot,
        value: sector,
        icon: SECTOR_META[sector].icon,
        label: SECTOR_META[sector].label,
        hint: SECTOR_META[sector].tagline,
        says: SECTOR_META[sector].label,
      }));
    case 'region': {
      const ordered = proposal.sector === null ? REGIONS : regionsBySectorAffinity(proposal.sector);
      return ordered.map((region) => ({
        slot,
        value: region,
        icon: REGION_META[region].icon,
        label: REGION_META[region].label,
        hint: REGION_META[region].tagline,
        says: REGION_META[region].label,
      }));
    }
    case 'backgroundId': {
      const sector = proposal.sector;
      if (sector === null) return [];
      return backgroundsForSector(sector).map((background) => ({
        slot,
        value: background.id,
        icon: background.icon,
        label: background.label,
        hint: background.tagline,
        says: background.label,
      }));
    }
    case 'companyName':
    case 'founderName':
      return [];
  }
}

/** One established slot, as an editable chip. */
export interface SetupUnderstood {
  readonly slot: SetupSlot;
  readonly label: string;
  readonly value: string;
  readonly icon: string;
}

/** What the conversation understands so far, in ask order, for the editable strip. */
export function setupUnderstood(proposal: SetupProposal): readonly SetupUnderstood[] {
  const rows: SetupUnderstood[] = [];
  if (proposal.sector !== null) {
    rows.push({ slot: 'sector', label: 'Sector', value: SECTOR_META[proposal.sector].label, icon: SECTOR_META[proposal.sector].icon });
  }
  if (proposal.region !== null) {
    rows.push({ slot: 'region', label: 'Region', value: REGION_META[proposal.region].label, icon: REGION_META[proposal.region].icon });
  }
  if (proposal.backgroundId !== null) {
    const background = backgroundById(proposal.backgroundId);
    rows.push({ slot: 'backgroundId', label: 'Start', value: background?.label ?? proposal.backgroundId, icon: background?.icon ?? 'briefcase' });
  }
  if (proposal.companyName !== null) rows.push({ slot: 'companyName', label: 'Company', value: proposal.companyName, icon: 'building' });
  if (proposal.founderName !== null) rows.push({ slot: 'founderName', label: 'Founder', value: proposal.founderName, icon: 'people' });
  return rows;
}

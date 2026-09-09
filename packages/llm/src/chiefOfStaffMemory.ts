/**
 * @frontier/llm — chiefOfStaffMemory.ts
 *
 * The Chief of Staff's memory of one thread.
 *
 * A Chief of Staff conversation is supposed to last a whole campaign — forty
 * quarters, hundreds of turns. Two things are already in play and neither is
 * enough on its own:
 *
 * - The **Claude session** is resumed by conversation key, so the model has its
 *   own transcript. That transcript is disposable: a credential change, a
 *   restart or a compaction takes it, and this package never holds it.
 * - The **client transcript** lives in the tab and carries the last few turns.
 *   It goes when the tab does.
 *
 * So the durable half is here: a *compact, bounded* memory keyed by the same
 * conversation key the session store uses. Two things go in it — a one-line
 * summary of each recent exchange, and the founder's **standing preferences**,
 * the things they said once and expect remembered ("never lay anyone off
 * without asking me twice"). Each entry records the quarter it came from, so a
 * two-year-old instruction is not read as a live one.
 *
 * Everything in this module is pure. Bounding is by dropping the oldest, which
 * is what makes a forty-quarter thread fit in a prompt and in a save.
 */

import {
  COS_MEMORY_EXCHANGES,
  COS_MEMORY_PREFERENCES,
  ChiefOfStaffMemorySchema,
  EMPTY_CHIEF_OF_STAFF_MEMORY,
  type ChiefOfStaffMemory,
} from '@frontier/contracts';

/** The longest one remembered line may be. Matches the contract's own cap. */
const EXCHANGE_CHARS = 240;
const PREFERENCE_CHARS = 200;

/** Trim to a length the schema accepts, without cutting mid-word where possible. */
function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Keep the last `count` entries, oldest first. */
function lastN<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  return items.length <= count ? [...items] : items.slice(items.length - count);
}

/* -------------------------------------------------------------------------- */
/*  Standing preferences                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Phrases that mark a sentence as a standing instruction rather than a
 * one-quarter one.
 *
 * Deliberately narrow. A false positive here means the founder is quoted back
 * an instruction they did not mean to make permanent, which is worse than
 * missing one — they can always say it again.
 */
const PREFERENCE_MARKERS: readonly string[] = [
  'always ',
  'never ',
  'from now on',
  'going forward',
  'in future',
  'in the future',
  'i prefer',
  'i want you to',
  'remember that',
  'as a rule',
  'by default',
  'don\'t ever',
  'do not ever',
];

/** Split a message into sentences. Deterministic; punctuation only, no parsing. */
function sentencesOf(message: string): string[] {
  return message
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The standing preference in a message, or null.
 *
 * The first sentence carrying a marker wins, so a message that states one
 * preference and then asks a question records the preference and not the
 * question.
 */
export function standingPreferenceOf(message: string): string | null {
  for (const sentence of sentencesOf(message)) {
    const lower = sentence.toLowerCase();
    if (PREFERENCE_MARKERS.some((marker) => lower.includes(marker))) return clip(sentence, PREFERENCE_CHARS);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Remembering                                                                */
/* -------------------------------------------------------------------------- */

export interface ExchangeToRemember {
  readonly quarter: number;
  /** What the founder typed, verbatim. Clipped here, never before. */
  readonly founderSaid: string;
  /** What the Chief of Staff replied. The `reply` field, not the summary. */
  readonly chiefReplied: string;
}

/**
 * Fold one exchange into the memory.
 *
 * Bounded on both axes by dropping the oldest. A preference restated in a later
 * quarter replaces the earlier statement of it rather than accumulating beside
 * it — a founder who says "never do that" twice has one preference, not two —
 * and the *later* quarter is the one recorded, because that is when they last
 * meant it.
 *
 * Pure: the argument is never mutated.
 */
export function rememberExchange(memory: ChiefOfStaffMemory, exchange: ExchangeToRemember): ChiefOfStaffMemory {
  const founderSaid = clip(exchange.founderSaid, EXCHANGE_CHARS);
  const chiefReplied = clip(exchange.chiefReplied, EXCHANGE_CHARS);
  // An empty half is not an exchange worth a slot in a bounded window.
  const exchanges =
    founderSaid.length === 0 || chiefReplied.length === 0
      ? [...memory.exchanges]
      : lastN([...memory.exchanges, { quarter: exchange.quarter, founderSaid, chiefReplied }], COS_MEMORY_EXCHANGES);

  const stated = standingPreferenceOf(exchange.founderSaid);
  if (stated === null) return { exchanges, preferences: [...memory.preferences] };

  const key = stated.toLowerCase();
  const kept = memory.preferences.filter((entry) => entry.text.toLowerCase() !== key);
  const preferences = lastN([...kept, { quarter: exchange.quarter, text: stated }], COS_MEMORY_PREFERENCES);
  return { exchanges, preferences };
}

/** Parse a stored memory, falling back to an empty one. Never throws. */
export function readMemory(value: unknown): ChiefOfStaffMemory {
  const parsed = ChiefOfStaffMemorySchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_CHIEF_OF_STAFF_MEMORY;
}

/**
 * Drop everything the founder said more than `windowQuarters` ago.
 *
 * Not applied automatically: a standing preference is supposed to outlive the
 * quarter it was stated in, and there is no correct universal age for one. A
 * caller that wants a shorter horizon asks for it.
 */
export function forgetBefore(memory: ChiefOfStaffMemory, quarter: number): ChiefOfStaffMemory {
  return {
    exchanges: memory.exchanges.filter((entry) => entry.quarter >= quarter),
    preferences: memory.preferences.filter((entry) => entry.quarter >= quarter),
  };
}

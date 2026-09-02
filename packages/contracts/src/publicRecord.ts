/**
 * @frontier/contracts — publicRecord.ts
 *
 * One feed, not five panels.
 *
 * A world event, a press story, a public disclosure, a post and a reply are five
 * different rows in five different tables, and to a reader they are all the same
 * thing: something that became public this quarter. `PublicRecordItem` is that
 * one thing. The engine projects the five tables into a single reverse-
 * chronological list, already redacted to what one seat may see, and the client
 * renders it without knowing which table any item came from.
 *
 * Three rules the shape enforces:
 *
 * - **It is a projection, never a store.** Nothing here is canonical. Every
 *   field is derived from state the engine already committed, so a feed item can
 *   never disagree with the ledger it was built from.
 * - **Redaction happens before the shape exists.** An item a player may not see
 *   is absent, not blurred. There is no visibility field to get wrong later.
 * - **Consequence is a figure, not a claim.** `whyItMatters` is computed from the
 *   ledger and the modifiers an item produced, in whole numbers, and is null
 *   whenever the item did nothing to the reader. A feed that claims everything
 *   matters says nothing.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import { NetworkArchetypeSchema, PostIntentSchema } from './social';

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                      */
/* -------------------------------------------------------------------------- */

export const PUBLIC_RECORD_KINDS = ['event', 'story', 'disclosure', 'post', 'reply'] as const;

export const PublicRecordKindSchema = z
  .enum(PUBLIC_RECORD_KINDS)
  .describe(
    'Which table the item came from. "event" is a world event, "story" press coverage, "disclosure" a press release, rumour or leak that reached the market, "post" somebody speaking for themselves, and "reply" a post answering another post.',
  );
export type PublicRecordKind = z.infer<typeof PublicRecordKindSchema>;

/* -------------------------------------------------------------------------- */
/*  Attribution                                                                */
/* -------------------------------------------------------------------------- */

export const PublicRecordActorSchema = z
  .object({
    characterId: z.string().nullable().describe('The person who said it, or null when nobody in particular did.'),
    companyId: z.string().nullable().describe('The company it is attributed to, or null.'),
    name: z.string().min(1).max(120).describe('Display name for the byline: a person, a company, or the wire.'),
    isAi: z
      .boolean()
      .describe('True when an AI-controlled character or the engine authored it. NPC-authored material must be visibly labelled as AI-generated wherever it appears.'),
  })
  .describe('Who a feed item is from. Never a role label alone: the feed is universal, so a byline is a name.');
export type PublicRecordActor = z.infer<typeof PublicRecordActorSchema>;

/* -------------------------------------------------------------------------- */
/*  Causal links                                                               */
/* -------------------------------------------------------------------------- */

export const PublicRecordLinksSchema = z
  .object({
    causalParentId: z.string().nullable().describe('The world event that made this one likelier, or null when it is a root cause.'),
    sourceEventId: z.string().nullable().describe('The world event this item reports on, or null.'),
    sourcePostIds: z.array(z.string()).describe('Posts that triggered the coverage, for a story. Empty otherwise.'),
    replyToPostId: z.string().nullable().describe('The post this item answers, or null. A thread is a chain of these.'),
  })
  .describe('What this item follows from. The feed groups a thread and traces a cascade with these and nothing else.');
export type PublicRecordLinks = z.infer<typeof PublicRecordLinksSchema>;

/* -------------------------------------------------------------------------- */
/*  The item                                                                   */
/* -------------------------------------------------------------------------- */

export const PublicRecordItemSchema = z
  .object({
    id: z.string().min(1).describe('The id of the underlying row: an event, story, disclosure or post id. Stable across projections, so a client may key on it.'),
    quarter: QuarterIndexSchema.describe('Quarter the item became public.'),
    kind: PublicRecordKindSchema,
    who: PublicRecordActorSchema,
    sectorIds: z.array(z.string()).describe('Sectors the item concerns. Empty for economy-wide items.'),
    companyIds: z.array(z.string()).describe('Companies the item names. Empty when it names none.'),
    headline: z.string().min(1).max(200).describe('One line, already written for a reader.'),
    body: z.string().max(1500).describe('The item as published. Empty when the headline is the whole of it.'),
    tone: z.number().min(-1).max(1).describe('Sentiment toward the subject, -1 (hostile) to +1 (favourable). 0 is neutral reporting.'),
    weight: unitInterval('How much attention this item commands, 0..1. Severity for an event, prominence for a story, credibility for a disclosure, reach for a post. The feed sorts on it within a quarter.'),
    links: PublicRecordLinksSchema,
    ledgerEventIds: z.array(z.string()).describe('The sim_event ids that explain this item. Empty when the caller supplied no ledger; never a summary of one.'),
    whyItMatters: z
      .string()
      .max(160)
      .nullable()
      .describe('A one-line, whole-number consequence for the reader, computed from the ledger — "your consumer demand -6% this quarter", "aimed at you: hostility +8" — or null when the item did nothing to them.'),
    network: NetworkArchetypeSchema.nullable().describe('The network a post or reply was published on, or null for an item that is not a post.'),
    intent: PostIntentSchema.nullable().describe('The typed intent of a post or reply, which is what the engine acted on. Null for an item that is not a post.'),
    reach: z.number().min(0).nullable().describe('People reached, for items that have a measured audience. Null when the item has none.'),
  })
  .describe(
    'One item in the universal public record: everything that became public this quarter, in one reverse-chronological list, redacted to one seat. A projection of committed state — never a store, never authored by a model.',
  );
export type PublicRecordItem = z.infer<typeof PublicRecordItemSchema>;

/**
 * The feed's ordering, stated once so the engine and any client that re-sorts
 * agree: newest quarter first, heaviest first within a quarter, then by id so
 * two items of identical weight never swap places between two runs.
 */
export function comparePublicRecordItems(a: PublicRecordItem, b: PublicRecordItem): number {
  if (a.quarter !== b.quarter) return b.quarter - a.quarter;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.id.localeCompare(b.id);
}

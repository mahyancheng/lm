/**
 * @frontier/contracts
 *
 * The single source of truth for every type, zod schema and engine interface in
 * Frontier Capital. The simulation engine, the LLM gateway and the Next.js app
 * are all written against what is defined here.
 *
 * ## The one architectural rule
 *
 * > LLMs are allowed to think, propose, negotiate, communicate and reinterpret
 * > the future; only the simulation engine is allowed to make reality.
 *
 * This package is where that rule is made mechanical. LLM output never writes
 * state: every model result is a *proposal* parsed by a schema in here, then
 * bounds-checked by the engine before any mutation.
 *
 * ## Two families of schema
 *
 * **LLM-facing** schemas are the ones a model is asked to produce. They obey a
 * strict subset so they survive Anthropic structured outputs intact:
 * - every field required — `.nullable()` instead of `.optional()`
 * - explicit `z.enum` for every categorical value
 * - `z.number()` with `.describe()` documenting bounds and units
 * - no `z.record`, no `.transform`
 * - `z.discriminatedUnion` is fine and is used heavily
 *
 * Bounds are expressed twice on purpose: once as `.min()`/`.max()` so this
 * package validates locally whatever the provider does with the constraint
 * keyword, and once in prose inside `.describe()` so the model can read them.
 *
 * They are: `GmEventProposalSchema`, `GmProposalBatchSchema`,
 * `WorldModifierProposalSchema`, `NpcActionBundleSchema`, `ActionIntentSchema`,
 * `ChiefOfStaffInterpretationSchema`, `InnovationProposalSchema`,
 * `ConditionalCommitmentSchema`, `CharacterReplySchema`, `MemoryDraftSchema`,
 * `SocialPostDraftSchema`, `GovernmentBidSchema`, `DealProposalDraftSchema`,
 * `DealObligationSchema`, `DealExtractionSchema` and `NarratorOutputSchema`.
 *
 * **Internal/state** schemas describe canonical state and engine output. They
 * use optionals, records and defaults freely, and are never handed to a model.
 *
 * ## Module map
 *
 * | Module        | Contains                                                    |
 * |---------------|-------------------------------------------------------------|
 * | `ids`         | Id aliases, scalar builders, quarter arithmetic             |
 * | `sectors`     | The six economic sectors, six regions, and the supply graph |
 * | `world`       | Twelve world domains, sectors, the modifier target registry |
 * | `modifiers`   | World modifiers, decay, the impact budget                   |
 * | `events`      | World events, families, hazards, the GM proposal envelope   |
 * | `company`     | Companies, products, people, compute, financials            |
 * | `ownership`   | Share classes, securities, holdings, cap tables, rounds     |
 * | `markets`     | Instruments, quotes, anchors, beliefs, return decomposition |
 * | `governance`  | Boards, directors, proposals, votes, commitments            |
 * | `government`  | Agencies, opportunities, bids, contracts, past performance  |
 * | `tech`        | The Frontier Map: nodes, edges, projects, innovation        |
 * | `people`      | Characters, relationships, memory, connection hierarchy     |
 * | `social`      | Networks, accounts, posts, engagement, media stories        |
 * | `publicRecord`| The one universal feed: events, stories, disclosures, posts |
 * | `deals`       | Structured agreements, binding and non-binding              |
 * | `actions`     | Every quarterly action, validation, NPC bundles             |
 * | `sim`         | The ledger, resolution phases, reports, leaderboards        |
 * | `session`     | The canonical root aggregate and player projections         |
 * | `llm`         | Per-role input and output contracts, run logging, fallbacks |
 * | `engine`      | The subsystem interfaces the simulation package implements  |
 */

export * from './ids';
export * from './sectors';
export * from './world';
export * from './modifiers';
export * from './events';
export * from './company';
export * from './ownership';
export * from './markets';
export * from './governance';
export * from './government';
export * from './tech';
export * from './people';
export * from './social';
export * from './publicRecord';
export * from './deals';
export * from './actions';
export * from './sim';
export * from './session';
export * from './llm';
export * from './engine';

/**
 * Version of this contract surface. Bump the minor when adding a schema, the
 * major when changing the shape of an existing one. `AgentRunRecord.schemaVersion`
 * records this so an old logged model output can always be interpreted.
 */
export const CONTRACTS_VERSION = '1.2.0';

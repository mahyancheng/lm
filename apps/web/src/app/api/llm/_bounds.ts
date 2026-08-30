/**
 * Hard ceilings on every free-text and array field an LLM route accepts.
 *
 * The contracts schemas describe what a role *means*; they deliberately do not
 * describe how much of it one HTTP request may carry. That is a deployment
 * concern, and it belongs here — at the network edge, in front of the
 * operator's Claude subscription.
 *
 * Without these, a single POST is an amplifier: `companyBriefing` and
 * `worldBriefing` go into the prompt whole, `conversationHistory` is mapped in
 * full, and none of them is bounded by the contract. Two megabyte strings and
 * five thousand history turns compose into a multi-megabyte prompt on somebody
 * else's bill.
 *
 * Each bounded schema is the contract schema plus a `superRefine`, so the
 * inferred type is unchanged and the role still receives exactly what it
 * expects. An over-long field is a 400 naming the field, not a truncation:
 * silently dropping half a briefing would make the model answer a question
 * nobody asked.
 */

import { z } from 'zod';
import {
  CharacterUtteranceContextSchema,
  ChiefOfStaffInputSchema,
  InnovationInterpreterInputSchema,
  NpcStrategistInputSchema,
  ResolutionReportSchema,
  SocialAuthorInputSchema,
  WorldDirectorInputSchema,
} from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  The numbers                                                                */
/* -------------------------------------------------------------------------- */

export const LLM_INPUT_LIMITS = {
  /** One thing a person typed. */
  message: 4_000,
  /** A composed prose dossier about a company or the world. */
  briefing: 20_000,
  /** Turns of conversation history a request may carry. */
  historyTurns: 40,
  /** One turn of that history. */
  historyText: 4_000,
  /** Entries in a list of facts, decisions, constraints, signals. */
  listEntries: 40,
  /** One entry of such a list. */
  listText: 1_000,
  /** Candidate events, digest readings, sector rows the World Director is given. */
  worldEntries: 60,
  /** Target paths the World Director may be shown. */
  targetPaths: 400,
  /** Committed ledger lines the narrator may be asked to render. */
  reportLines: 500,
} as const;

/* -------------------------------------------------------------------------- */
/*  Checking helpers                                                           */
/* -------------------------------------------------------------------------- */

type Ctx = z.RefinementCtx;
type Path = (string | number)[];

function tooLong(ctx: Ctx, path: Path, actual: number, limit: number, unit: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `is ${actual} ${unit}; this endpoint accepts at most ${limit}`,
  });
}

/** Bound one string. */
function chars(ctx: Ctx, path: Path, value: string, limit: number): void {
  if (value.length > limit) tooLong(ctx, path, value.length, limit, 'characters');
}

/** Bound a list's length, then optionally each entry's own text. */
function entries<T>(ctx: Ctx, path: Path, list: readonly T[], limit: number, each?: (item: T, at: Path) => void): void {
  if (list.length > limit) {
    tooLong(ctx, path, list.length, limit, 'entries');
    return;
  }
  if (each === undefined) return;
  list.forEach((item, index) => each(item, [...path, index]));
}

/** Bound a list of plain strings. */
function stringEntries(ctx: Ctx, path: Path, list: readonly string[], limit: number, textLimit: number): void {
  entries(ctx, path, list, limit, (item, at) => chars(ctx, at, item, textLimit));
}

/* -------------------------------------------------------------------------- */
/*  Bounded role inputs                                                        */
/* -------------------------------------------------------------------------- */

const L = LLM_INPUT_LIMITS;

export const BoundedChiefOfStaffInputSchema = ChiefOfStaffInputSchema.superRefine((value, ctx) => {
  chars(ctx, ['playerMessage'], value.playerMessage, L.message);
  chars(ctx, ['companyBriefing'], value.companyBriefing, L.briefing);
  chars(ctx, ['worldBriefing'], value.worldBriefing, L.briefing);
  stringEntries(ctx, ['openDecisions'], value.openDecisions, L.listEntries, L.listText);
  entries(ctx, ['currentBudgets'], value.currentBudgets, L.listEntries, (item, at) => chars(ctx, [...at, 'label'], item.label, L.listText));
  entries(ctx, ['conversationHistory'], value.conversationHistory, L.historyTurns, (item, at) =>
    chars(ctx, [...at, 'text'], item.text, L.historyText),
  );
});

export const BoundedNpcStrategistInputSchema = NpcStrategistInputSchema.superRefine((value, ctx) => {
  chars(ctx, ['companyBriefing'], value.companyBriefing, L.briefing);
  chars(ctx, ['worldBriefing'], value.worldBriefing, L.briefing);
  chars(ctx, ['rivalBriefing'], value.rivalBriefing, L.briefing);
  chars(ctx, ['priorStrategySummary'], value.priorStrategySummary, L.message);
  stringEntries(ctx, ['constraints'], value.constraints, L.listEntries, L.listText);
  entries(ctx, ['openOpportunities'], value.openOpportunities, L.listEntries, (item, at) => chars(ctx, [...at, 'programme'], item.programme, L.listText));
  entries(ctx, ['incomingDeals'], value.incomingDeals, L.listEntries, (item, at) => chars(ctx, [...at, 'summary'], item.summary, L.listText));
});

export const BoundedCharacterContextSchema = CharacterUtteranceContextSchema.superRefine((value, ctx) => {
  chars(ctx, ['accessBasis'], value.accessBasis, L.listText);
  if (value.pendingProposalSummary !== null) chars(ctx, ['pendingProposalSummary'], value.pendingProposalSummary, L.message);
  entries(ctx, ['gameFacts'], value.gameFacts, L.listEntries);
  entries(ctx, ['memories'], value.memories, L.listEntries, (item, at) => chars(ctx, [...at, 'summary'], item.summary, L.listText));
  entries(ctx, ['conversationHistory'], value.conversationHistory, L.historyTurns, (item, at) => chars(ctx, [...at, 'text'], item.text, L.historyText));
});

export const BoundedWorldDirectorInputSchema = WorldDirectorInputSchema.superRefine((value, ctx) => {
  chars(ctx, ['worldSummary'], value.worldSummary, L.briefing);
  chars(ctx, ['styleGuidance'], value.styleGuidance, L.listText);
  entries(ctx, ['worldDigest'], value.worldDigest, L.worldEntries);
  entries(ctx, ['sectorSummary'], value.sectorSummary, L.worldEntries);
  entries(ctx, ['eventCandidates'], value.eventCandidates, L.worldEntries);
  entries(ctx, ['recentEvents'], value.recentEvents, L.worldEntries);
  entries(ctx, ['activeModifierSummaries'], value.activeModifierSummaries, L.worldEntries, (item, at) => chars(ctx, [...at, 'reason'], item.reason, L.listText));
  stringEntries(ctx, ['legalTargetPaths'], value.legalTargetPaths, L.targetPaths, 200);
  stringEntries(ctx, ['knownSectorIds'], value.knownSectorIds, L.worldEntries, 200);
});

export const BoundedInnovationInputSchema = InnovationInterpreterInputSchema.superRefine((value, ctx) => {
  chars(ctx, ['playerIdea'], value.playerIdea, L.message);
  chars(ctx, ['worldContext'], value.worldContext, L.briefing);
  entries(ctx, ['existingNodes'], value.existingNodes, L.targetPaths);
  entries(ctx, ['companyCapabilities'], value.companyCapabilities, L.listEntries);
});

export const BoundedSocialAuthorInputSchema = SocialAuthorInputSchema.superRefine((value, ctx) => {
  chars(ctx, ['authorBriefing'], value.authorBriefing, L.briefing);
  chars(ctx, ['situation'], value.situation, L.message);
  stringEntries(ctx, ['constraints'], value.constraints, L.listEntries, L.listText);
  entries(ctx, ['audienceMix'], value.audienceMix, L.listEntries);
});

/**
 * The narrator is handed a whole committed report, so the bound is on the total
 * number of ledger lines across phases rather than on any one phase.
 */
export const BoundedResolutionReportSchema = ResolutionReportSchema.superRefine((value, ctx) => {
  const total = value.phases.reduce((sum, phase) => sum + phase.lines.length, 0);
  if (total > L.reportLines) tooLong(ctx, ['phases'], total, L.reportLines, 'committed lines');
  value.phases.forEach((phase, phaseIndex) =>
    phase.lines.forEach((line, lineIndex) => chars(ctx, ['phases', phaseIndex, 'lines', lineIndex, 'text'], line.text, L.listText)),
  );
});

/* -------------------------------------------------------------------------- */
/*  Conversation parts                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a client may say about which conversation a turn belongs to.
 *
 * Note what is *not* here: a conversation key. The key is derived server-side
 * in `_identity.ts` from these parts plus the verified principal, because a key
 * a caller can choose is a key that reaches somebody else's transcript.
 */
export const ConversationPartsSchema = z.object({
  gameSessionId: z.string().min(1).max(200),
  playerId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
});

export type ConversationPartsBody = z.infer<typeof ConversationPartsSchema>;

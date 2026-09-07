/** Pi-local canonical game files. This is server-only and opt-in via GAME_SESSION_DIR. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActionIntentSchema, type ActionIntent, type ActionValidationResult, type SessionState, type SubmittedAction } from '@frontier/contracts';
import type { SaveFile } from '@/lib/game/saveFile';
import { inspectSaveValue } from '@/lib/game/saveFile';
import { upgradeSaveFileAtLoad } from '@/lib/game/saveUpgrade';
import { buildSubmittedActionForCompany, createSession, getEngine } from '@/lib/game/engine';
import { automaticResearchReview, dueResearchReviews } from '@/lib/game/autonomousResearch';
import { buildNpcStrategistInput, buildWorldDirectorInput } from '@/lib/game/briefings';
import { strategistPriority } from '@frontier/simulation';
import type { GmProposalBatch } from '@frontier/contracts';
import type { NpcBundleInput } from '@frontier/simulation';

export const GAME_SESSION_DIR_ENV = 'GAME_SESSION_DIR';
const COMPANY_COMMAND_TYPES = new Set<ActionIntent['type']>(['propose_deal', 'accept_deal', 'reject_deal', 'cancel_deal', 'submit_board_proposal']);

type StoredDialogue = { readonly companyId?: string; readonly quarter?: number; readonly playerText: string; readonly replyText: string; readonly output?: import('@frontier/contracts').CharacterReply | { readonly text: string; readonly commands: readonly never[] }; readonly receipts: readonly import('@frontier/contracts').ConversationReceipt[]; readonly fallbackUsed: boolean };
type Receipt = { readonly fingerprint: string; readonly commandId: string; readonly revision: number; readonly action: SubmittedAction | null; readonly status: 'queued' | 'rejected'; readonly dialogue?: StoredDialogue };
type ResolutionEnvelope = { readonly requestId: string; readonly outcome: import('@frontier/contracts').QuarterResolutionOutcome };
type StoredGame = { readonly version: 1; readonly ownerId: string; readonly revision: number; readonly file: SaveFile; readonly receipts: readonly Receipt[]; readonly resolutions?: readonly ResolutionEnvelope[] };
export type CommandResult = { readonly status: 'queued' | 'duplicate' | 'stale' | 'forbidden' | 'rejected' | 'session_not_registered'; readonly revision: number | null; readonly queuedAction: SubmittedAction | null; readonly validation: ActionValidationResult | null };
export interface CanonicalPlanner { planWorld(state: SessionState, ownerId: string): Promise<GmProposalBatch | null>; planNpc(state: SessionState, companyId: string, ownerId: string): Promise<NpcBundleInput | null>;
  reviewResearch(input: import('@frontier/contracts').InnovationInterpreterInput): Promise<import('@frontier/contracts').InnovationProposal | null>; }
export type RegistrationResult = { readonly ok: boolean; readonly sessionId: string | null; readonly revision: number | null; readonly reason: string | null };
/** Server-only canonical dialogue loader. Never expose this state to a client. */
export function loadCanonicalCompanyDialogue(sessionId: string, ownerId: string, companyId: string, root = authorityRoot()): { readonly state: SessionState; readonly revision: number; readonly queuedActions: readonly SubmittedAction[] } | null {
  if (root === null || !validId(sessionId) || !validId(companyId)) return null;
  let stored = readGame(root, sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, sessionId, stored);
  if (stored === null || stored === undefined || stored.ownerId !== ownerId) return null;
  const state = replay(stored.file);
  const company = state?.companies.find((candidate) => candidate.id === companyId);
  return state !== null && company !== undefined && company.isActive && company.controllerPlayerId === null ? { state, revision: stored.revision, queuedActions: stored.file.queue } : null;
}

/** Read-only turn replay check. It runs before any model call or command submission. */
export function canonicalDialogueTurn(sessionId: string, ownerId: string, turnId: string, playerText: string, root = authorityRoot()): { readonly status: 'missing' } | { readonly status: 'conflict' } | ({ readonly status: 'complete' } & StoredDialogue & { readonly revision: number }) {
  if (!root || !validId(sessionId) || !validId(turnId)) return { status: 'missing' };
  let stored = readGame(root, sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, sessionId, stored);
  if (stored === null || stored === undefined || stored.ownerId !== ownerId) return { status: 'missing' };
  const receipt = stored.receipts.find((candidate) => candidate.commandId === `dialogue_${turnId}`);
  if (receipt === undefined) return { status: 'missing' };
  if (receipt.dialogue === undefined || receipt.dialogue.playerText !== playerText) return { status: 'conflict' };
  return { status: 'complete', ...receipt.dialogue, revision: stored.revision };
}

/** Append one receipt-backed company conversation turn to canonical state. */
export async function appendCanonicalDialogueTurn(input: { readonly sessionId: string; readonly ownerId: string; readonly companyId: string; readonly turnId: string; readonly playerCompanyId: string; readonly playerCharacterId: string; readonly playerText: string; readonly replyText: string; readonly output?: import('@frontier/contracts').CharacterReply | { readonly text: string; readonly commands: readonly never[] }; readonly receipts?: readonly import('@frontier/contracts').ConversationReceipt[]; readonly fallbackUsed?: boolean }, root = authorityRoot()): Promise<number | null> { return locked(input.sessionId, async () => {
  if (!root || !validId(input.sessionId) || !validId(input.companyId) || !validId(input.turnId)) return null;
  let stored = readGame(root, input.sessionId); if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, input.sessionId, stored); if (stored === null || stored === undefined || stored.ownerId !== input.ownerId) return null;
  const state = replay(stored.file); if (state === null) return null;
  const ceo = state.companies.find((company) => company.id === input.companyId)?.ceoCharacterId; if (!ceo) return null;
  const id = `npc:${state.sessionId}:${input.playerCompanyId}:${input.playerCharacterId}:${ceo}`;
  const prior = (state.conversationThreads ?? []).find((thread) => thread.id === id);
  // Exact turn idempotency is encoded as a paired turn marker in the first text line.
  if (stored.receipts.some((receipt) => receipt.commandId === `dialogue_${input.turnId}`)) return stored.revision;
  const playerTurn = { turnId: input.turnId, speakerId: input.playerCharacterId, text: input.playerText, quarter: state.quarter, targetCompanyId: input.companyId };
  const proposedCommands = input.output?.commands?.slice(0, 2) ?? [];
  const replyTurn = { turnId: input.turnId, speakerId: ceo, text: input.replyText, quarter: state.quarter, targetCompanyId: input.companyId, ...(proposedCommands.length === 0 ? {} : { proposedCommands }), ...(input.receipts === undefined ? {} : { receipts: input.receipts.slice(0, 2) }) };
  const thread = prior === undefined ? { id, sessionId: state.sessionId, playerCompanyId: input.playerCompanyId, playerCharacterId: input.playerCharacterId, targetCharacterId: ceo, targetCompanyId: input.companyId, turns: [playerTurn, replyTurn], nextTurnSequence: 2, lastMessageQuarter: state.quarter } : { ...prior, turns: [...prior.turns, playerTurn, replyTurn].slice(-30), nextTurnSequence: prior.nextTurnSequence + 2, lastMessageQuarter: state.quarter };
  const threads = prior === undefined ? [...(state.conversationThreads ?? []), thread] : (state.conversationThreads ?? []).map((candidate) => candidate.id === id ? thread : candidate);
  const nextState = { ...state, conversationThreads: threads.slice(-80) };
  const file = { ...stored.file, checkpoint: { quarter: nextState.quarter, state: nextState }, savedQuarter: nextState.quarter };
  const revision = stored.revision + 1; const dialogueReceipt: Receipt = { fingerprint: fingerprint({ turnId: input.turnId, text: input.playerText, reply: input.replyText }), commandId: `dialogue_${input.turnId}`, revision, action: null, status: 'queued', dialogue: { companyId: input.companyId, quarter: state.quarter, playerText: input.playerText, replyText: input.replyText, ...(input.output === undefined ? {} : { output: input.output }), receipts: input.receipts ?? [], fallbackUsed: input.fallbackUsed ?? false } }; return writeGame(root, input.sessionId, { ...stored, revision, file, receipts: [...stored.receipts, dialogueReceipt] }) ? revision : null;
}); }

/** Resolve an exact server-persisted CEO draft. Client requests name the draft;
 * they never carry editable terms across the authority boundary. */
export function canonicalCompanyDialogueProposal(input: { readonly sessionId: string; readonly ownerId: string; readonly companyId: string; readonly turnId: string; readonly proposalIndex: number }, root = authorityRoot()): { readonly status: 'ready'; readonly revision: number; readonly command: ActionIntent } | { readonly status: 'missing' | 'forbidden' | 'stale' } {
  if (!root || !validId(input.sessionId) || !validId(input.companyId) || !validId(input.turnId) || !Number.isInteger(input.proposalIndex) || input.proposalIndex < 0 || input.proposalIndex > 1) return { status: 'missing' };
  let stored = readGame(root, input.sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, input.sessionId, stored);
  if (stored === null) return { status: 'missing' };
  if (stored === undefined || stored.ownerId !== input.ownerId) return { status: 'forbidden' };
  const receipt = stored.receipts.find((candidate) => candidate.commandId === `dialogue_${input.turnId}`);
  const dialogue = receipt?.dialogue;
  if (dialogue === undefined || dialogue.companyId !== input.companyId) return { status: 'stale' };
  const candidate = dialogue.output?.commands?.[input.proposalIndex];
  const command = ActionIntentSchema.safeParse(candidate);
  if (!command.success || !COMPANY_COMMAND_TYPES.has(command.data.type)) return { status: 'forbidden' };
  // A network retry may arrive after resolution advanced the quarter. Let the
  // command service return its exact idempotent receipt; never revalidate it as
  // a new action in the later quarter.
  const priorCommand = stored.receipts.find((entry) => entry.commandId === `dialogue_${input.turnId}_${input.proposalIndex}`);
  if (priorCommand !== undefined && priorCommand.fingerprint === fingerprint(command.data)) return { status: 'ready', revision: stored.revision, command: command.data };
  const state = replay(stored.file);
  if (state === null || dialogue.quarter !== state.quarter) return { status: 'stale' };
  const company = state.companies.find((entry) => entry.id === input.companyId);
  if (company === undefined || !company.isActive || company.controllerPlayerId !== null) return { status: 'forbidden' };
  return { status: 'ready', revision: stored.revision, command: command.data };
}

/** Attach the authoritative queue outcome to both durable representations of
 * the CEO turn so reloads show the draft and its result together. */
export async function recordCompanyDialogueProposalReceipt(input: { readonly sessionId: string; readonly ownerId: string; readonly companyId: string; readonly turnId: string; readonly proposalIndex: number; readonly receipt: import('@frontier/contracts').ConversationReceipt }, root = authorityRoot()): Promise<number | null> { return locked(input.sessionId, async () => {
  if (!root || !validId(input.sessionId) || !validId(input.companyId) || !validId(input.turnId)) return null;
  let stored = readGame(root, input.sessionId); if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, input.sessionId, stored);
  if (stored === null || stored === undefined || stored.ownerId !== input.ownerId) return null;
  const dialogueIndex = stored.receipts.findIndex((entry) => entry.commandId === `dialogue_${input.turnId}` && entry.dialogue?.companyId === input.companyId);
  const state = replay(stored.file); if (dialogueIndex < 0 || state === null) return null;
  const dialogueReceipt = stored.receipts[dialogueIndex]!; const dialogue = dialogueReceipt.dialogue!;
  const linkedReceipt = { ...input.receipt, proposalIndex: input.proposalIndex };
  const receipts = [...dialogue.receipts.filter((entry) => entry.proposalIndex !== input.proposalIndex), linkedReceipt].slice(-2);
  const authorityReceipts = stored.receipts.map((entry, index) => index === dialogueIndex ? { ...entry, dialogue: { ...dialogue, receipts } } : entry);
  const threads = (state.conversationThreads ?? []).map((thread) => thread.targetCompanyId !== input.companyId ? thread : { ...thread, turns: thread.turns.map((turn) => turn.turnId === input.turnId && turn.speakerId === thread.targetCharacterId ? { ...turn, receipts } : turn) });
  const nextState = { ...state, conversationThreads: threads };
  const file = { ...stored.file, checkpoint: { quarter: nextState.quarter, state: nextState }, savedQuarter: nextState.quarter };
  const revision = stored.revision + 1;
  return writeGame(root, input.sessionId, { ...stored, revision, file, receipts: authorityReceipts }) ? revision : null;
}); }

const gameLocks = new Map<string, Promise<void>>();
const fingerprint = (value: unknown): string => JSON.stringify(value);
const resolutionFingerprint = (actions: readonly SubmittedAction[]): string => fingerprint([...new Map(actions.map((action) => [action.actionId, action])).values()]);
async function locked<T>(sessionId: string, task: () => Promise<T>): Promise<T> { const previous = gameLocks.get(sessionId) ?? Promise.resolve(); let release!: () => void; const mine = new Promise<void>((resolve) => { release = resolve; }); const tail = previous.then(() => mine); gameLocks.set(sessionId, tail); await previous; try { return await task(); } finally { release(); if (gameLocks.get(sessionId) === tail) gameLocks.delete(sessionId); } }
const validId = (value: string): boolean => /^[A-Za-z0-9:_-]{1,200}$/.test(value);
export function authorityRoot(env: Readonly<Record<string, string | undefined>> = process.env): string | null { const value = env[GAME_SESSION_DIR_ENV]?.trim(); return value && value.length > 0 ? value : null; }
function gamePath(root: string, sessionId: string): string { return join(root, `${sessionId}.json`); }
/** `null` means absent; `undefined` means corrupt and must fail closed. */
function readGame(root: string, sessionId: string): StoredGame | null | undefined {
  const file = gamePath(root, sessionId);
  if (!existsSync(file)) return null;
  try { const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredGame>; return value.version === 1 && typeof value.ownerId === 'string' && Number.isInteger(value.revision) && value.file !== undefined && Array.isArray(value.receipts) ? value as StoredGame : undefined; } catch { return undefined; }
}
function writeGame(root: string, sessionId: string, value: StoredGame): boolean {
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); const target = gamePath(root, sessionId); const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, target); return true; } catch { return false; }
}
/** Upgrade an eligible old checkpoint and atomically replace the canonical file once. */
function upgradeCanonicalStoredGame(root: string, sessionId: string, stored: StoredGame): StoredGame | null {
  // Replay the original checkpoint/log first. The compatibility state must not
  // be visible to historical recorded quarter resolution.
  const current = replay(stored.file);
  if (current === null) return null;
  const upgraded = upgradeSaveFileAtLoad(stored.file, current);
  if (!upgraded.changed) return stored;
  const next: StoredGame = { ...stored, revision: stored.revision + 1, file: upgraded.file };
  return writeGame(root, sessionId, next) ? next : null;
}

function replay(file: SaveFile): SessionState | null {
  try {
    let state = file.checkpoint?.state ?? createSession({ seed: file.seed, difficulty: file.difficulty, autoExecuteRoutine: file.autoExecuteRoutine, setup: file.setup ?? undefined });
    for (const record of file.log.filter((entry) => entry.quarter >= state.quarter)) { const outcome = getEngine().resolver.resolveQuarter(state, [...record.actions], record.gmProposal, [...record.npcBundles]); if (!outcome.committed) return null; state = outcome.nextState; }
    return state;
  } catch { return null; }
}

/** One-time import. Later browser saves are intentionally refused until canonical resolve/merge exists. */
export function registerGame(fileValue: unknown, ownerId: string, root = authorityRoot()): RegistrationResult {
  if (!root || !validId(ownerId)) return { ok: false, sessionId: null, revision: null, reason: 'authority_disabled' };
  const inspected = inspectSaveValue(fileValue); const parsedFile = inspected.file; const state = parsedFile === null ? null : replay(parsedFile); const file = parsedFile === null || state === null ? null : upgradeSaveFileAtLoad(parsedFile, state).file;
  if (inspected.status !== 'ok' || file === null || state === null || !validId(state.sessionId)) return { ok: false, sessionId: null, revision: null, reason: 'invalid_save' };
  const prior = readGame(root, state.sessionId);
  if (prior === undefined) return { ok: false, sessionId: state.sessionId, revision: null, reason: 'corrupt_server_record' };
  if (prior !== null) return { ok: false, sessionId: state.sessionId, revision: prior.revision, reason: prior.ownerId === ownerId ? 'already_registered' : 'forbidden' };
  return writeGame(root, state.sessionId, { version: 1, ownerId, revision: 1, file, receipts: [], resolutions: [] })
    ? { ok: true, sessionId: state.sessionId, revision: 1, reason: null }
    : { ok: false, sessionId: state.sessionId, revision: null, reason: 'write_failed' };
}

/** Server-agent-only operation: appends exactly one authority-scoped NPC command. */
export async function submitCompanyCommand(input: { readonly sessionId: string; readonly ownerId: string; readonly expectedRevision: number; readonly conversationId: string; readonly commandId: string; readonly command: unknown }, root = authorityRoot()): Promise<CommandResult> { return locked(input.sessionId, async () => {
  if (!root || !validId(input.sessionId) || !validId(input.commandId)) return { status: 'session_not_registered', revision: null, queuedAction: null, validation: null };
  let stored = readGame(root, input.sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, input.sessionId, stored);
  if (stored === null) return { status: 'session_not_registered', revision: null, queuedAction: null, validation: null };
  if (stored === undefined || stored.ownerId !== input.ownerId) return { status: 'forbidden', revision: null, queuedAction: null, validation: null };
  const duplicate = stored.receipts.find((receipt) => receipt.commandId === input.commandId);
  if (duplicate !== undefined) return duplicate.fingerprint === fingerprint(input.command) ? { status: 'duplicate', revision: stored.revision, queuedAction: duplicate.action, validation: null } : { status: 'forbidden', revision: stored.revision, queuedAction: null, validation: null };
  if (stored.revision !== input.expectedRevision) return { status: 'stale', revision: stored.revision, queuedAction: null, validation: null };
  const state = replay(stored.file); const parsed = ActionIntentSchema.safeParse(input.command);
  if (state === null || !parsed.success || !COMPANY_COMMAND_TYPES.has(parsed.data.type)) return { status: 'forbidden', revision: stored.revision, queuedAction: null, validation: null };
  const company = state.companies.find((candidate) => candidate.id === input.conversationId);
  const ceoId = company?.ceoCharacterId ?? state.characters.find((candidate) => candidate.companyId === company?.id)?.id ?? null;
  if (company === undefined || !company.isActive || company.controllerPlayerId !== null || ceoId === null) return { status: 'forbidden', revision: stored.revision, queuedAction: null, validation: null };
  const sequence = Math.max(-1, ...stored.file.queue.map((action) => action.sequence)) + 1;
  const action: SubmittedAction = { actionId: `cmd_${input.commandId}`, sessionId: state.sessionId, quarter: state.quarter, sequence, actorPlayerId: null, actorCompanyId: company.id, actorCharacterId: ceoId, origin: 'npc_strategist', intent: parsed.data, confirmedByHuman: false };
  const validation = getEngine().validator.validateBatch(state, [action])[0] ?? null;
  const accepted = validation !== null && validation.status !== 'rejected';
  const effective = accepted && validation.status === 'clamped' && validation.clampedAction !== null ? { ...action, intent: validation.clampedAction } : accepted ? action : null;
  const nextRevision = stored.revision + 1;
  const receipt: Receipt = { fingerprint: fingerprint(input.command), commandId: input.commandId, revision: nextRevision, action: effective, status: accepted ? 'queued' : 'rejected' };
  const next: StoredGame = { ...stored, revision: nextRevision, file: effective === null ? stored.file : { ...stored.file, queue: [...stored.file.queue, effective] }, receipts: [...stored.receipts, receipt] };
  if (!writeGame(root, input.sessionId, next)) return { status: 'rejected', revision: stored.revision, queuedAction: null, validation };
  return { status: accepted ? 'queued' : 'rejected', revision: nextRevision, queuedAction: effective, validation };
});
}

/** Resolves one canonical quarter exactly once. Caller supplies only player actions; NPC queued actions already live in the server file. */
export async function resolveCanonicalQuarter(input: { readonly sessionId: string; readonly ownerId: string; readonly expectedRevision: number; readonly requestId: string; readonly playerActions: readonly SubmittedAction[] }, planner: CanonicalPlanner | null = null, root = authorityRoot()): Promise<{ readonly status: 'resolved' | 'duplicate' | 'stale' | 'forbidden' | 'missing'; readonly revision: number | null; readonly file: SaveFile | null; readonly outcome: import('@frontier/contracts').QuarterResolutionOutcome | null }> {
  return locked(input.sessionId, async () => {
  if (!root || !validId(input.sessionId) || !validId(input.requestId)) return { status: 'missing', revision: null, file: null, outcome: null };
  let stored = readGame(root, input.sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, input.sessionId, stored);
  if (stored === null) return { status: 'missing', revision: null, file: null, outcome: null };
  if (stored === undefined || stored.ownerId !== input.ownerId) return { status: 'forbidden', revision: null, file: null, outcome: null };
  const resolutionReceipt = stored.receipts.find((entry) => entry.commandId === `resolve_${input.requestId}`);
  if (resolutionReceipt !== undefined) {
    if (resolutionReceipt.fingerprint !== resolutionFingerprint(input.playerActions)) return { status: 'forbidden', revision: stored.revision, file: stored.file, outcome: null };
    const duplicate = stored.resolutions?.find((entry) => entry.requestId === input.requestId);
    return { status: 'duplicate', revision: stored.revision, file: stored.file, outcome: duplicate?.outcome ?? null };
  }
  if (stored.revision !== input.expectedRevision) return { status: 'stale', revision: stored.revision, file: stored.file, outcome: stored.resolutions?.find((entry) => entry.requestId === input.requestId)?.outcome ?? null };
  const state = replay(stored.file); if (state === null) return { status: 'forbidden', revision: stored.revision, file: null, outcome: null };
  const player = state.players[0]; const playerCompanyId = player?.companyId ?? ''; const playerCharacterId = player?.characterId ?? null;
  // Company authority (founder, controlled subsidiary, or qualifying shareholder) is the
  // deterministic validator's job. The server only authenticates the human identity.
  if (!playerCharacterId || input.playerActions.some((action) => action.actorPlayerId !== player?.playerId || action.actorCharacterId !== playerCharacterId || action.sessionId !== state.sessionId || action.quarter !== state.quarter)) return { status: 'forbidden', revision: stored.revision, file: null, outcome: null };
  try {
    const researchActions: SubmittedAction[] = [];
    if (planner !== null && player !== undefined) for (const project of dueResearchReviews(state, player.playerId, [...stored.file.queue, ...input.playerActions], 2)) { const review = await automaticResearchReview(state, project.id, planner.reviewResearch); if (review !== null) researchActions.push(buildSubmittedActionForCompany(state, { type: 'propose_innovation', proposal: review }, Math.max(-1, ...stored.file.queue.map((a) => a.sequence), ...input.playerActions.map((a) => a.sequence), ...researchActions.map((a) => a.sequence)) + 1, project.companyId, { origin: 'research_agent', confirmedByHuman: false })); }
    const gmProposal = planner === null ? null : await planner.planWorld(state, input.ownerId).catch(() => null);
    const npcBundles: NpcBundleInput[] = [];
    if (planner !== null) for (const companyId of strategistPriority(state, playerCompanyId, Number.POSITIVE_INFINITY)) { const bundle = await planner.planNpc(state, companyId, input.ownerId).catch(() => null); if (bundle !== null) npcBundles.push(bundle); }
    const byId = new Map<string, SubmittedAction>(); for (const action of stored.file.queue) byId.set(action.actionId, action); for (const action of [...input.playerActions, ...researchActions]) { const prior = byId.get(action.actionId); if (prior !== undefined && fingerprint(prior) !== fingerprint(action)) return { status: 'forbidden', revision: stored.revision, file: null, outcome: null }; byId.set(action.actionId, action); } const actions = [...byId.values()];
    const outcome = getEngine().resolver.resolveQuarter(state, actions, gmProposal, npcBundles);
    if (!outcome.committed) return { status: 'forbidden', revision: stored.revision, file: null, outcome: null };
    const record = { quarter: state.quarter, actions, gmProposal, npcBundles, socialTexts: [] };
    const file: SaveFile = { ...stored.file, log: [...stored.file.log, record], checkpoint: { quarter: outcome.nextState.quarter, state: outcome.nextState }, savedQuarter: outcome.nextState.quarter, queue: [], savedAtIso: new Date().toISOString() };
    const nextRevision = stored.revision + 1; const receipt: Receipt = { fingerprint: resolutionFingerprint(input.playerActions), commandId: `resolve_${input.requestId}`, revision: nextRevision, action: null, status: 'queued' };
    if (!writeGame(root, input.sessionId, { ...stored, revision: nextRevision, file, receipts: [...stored.receipts, receipt], resolutions: [...(stored.resolutions ?? []), { requestId: input.requestId, outcome }].slice(-4) })) return { status: 'forbidden', revision: stored.revision, file: null, outcome: null };
    return { status: 'resolved', revision: nextRevision, file, outcome };
  } catch { return { status: 'forbidden', revision: stored.revision, file: null, outcome: null }; }
});
}

export function canonicalDialogueState(sessionId: string, ownerId: string, companyId: string, root = authorityRoot()): { readonly state: SessionState; readonly revision: number } | null {
  if (!root || !validId(sessionId)) return null; let stored = readGame(root, sessionId); if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, sessionId, stored); if (stored === null || stored === undefined || stored.ownerId !== ownerId) return null; const state = replay(stored.file); const company = state?.companies.find((candidate) => candidate.id === companyId); return state !== null && company !== undefined && company.isActive ? { state, revision: stored.revision } : null;
}

/** Owner-bound reload handoff; no foreign session metadata is exposed. */
export function canonicalSessionFile(sessionId: string, ownerId: string, root = authorityRoot()): { readonly ok: true; readonly revision: number; readonly file: SaveFile } | null {
  if (!root || !validId(sessionId)) return null;
  let stored = readGame(root, sessionId);
  if (stored !== null && stored !== undefined) stored = upgradeCanonicalStoredGame(root, sessionId, stored);
  return stored !== null && stored !== undefined && stored.ownerId === ownerId ? { ok: true, revision: stored.revision, file: stored.file } : null;
}

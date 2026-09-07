import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InnovationProposal, ResearchProject } from '@frontier/contracts';
import { buildSaveFile } from '@/lib/game/saveFile';
import { createSession, PLAYER_ID } from '@/lib/game/engine';
import { appendCanonicalDialogueTurn, canonicalSessionFile, registerGame, resolveCanonicalQuarter, submitCompanyCommand } from './sessionAuthority';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function root(): string { const value = mkdtempSync(join(tmpdir(), 'frontier-canonical-agency-')); roots.push(value); return value; }

function fixture() {
  const setup = { companyName: 'Canonical Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const };
  const session = createSession({ seed: 8124, setup });
  return { session, file: buildSaveFile({ seed: 8124, difficulty: 'standard', autoExecuteRoutine: false, setup, log: [], queue: [], session }) };
}
function playerAction(session: ReturnType<typeof createSession>) {
  const companyId = session.players[0]!.companyId;
  const characterId = session.characters.find((character) => character.companyId === companyId && character.role === 'founder_ceo')!.id;
  return { actionId: 'advance_after_dialogue', sessionId: session.sessionId, quarter: session.quarter, sequence: 0, actorPlayerId: PLAYER_ID, actorCompanyId: companyId, actorCharacterId: characterId, origin: 'player_ui' as const, confirmedByHuman: true, intent: { type: 'set_research_budget' as const, budgetUsd: 1 } };
}

describe('canonical company agency integration', () => {
  it('persists receipt-backed company dialogue in one thread across reload and the next canonical quarter', async () => {
    const r = root(); const { session, file } = fixture(); const ownerId = 'owner_a';
    const rival = session.companies.find((company) => company.controllerPlayerId === null && company.isActive)!;
    const player = session.players[0]!;
    const registration = registerGame(file, ownerId, r);
    const command = { type: 'submit_board_proposal' as const, kind: 'annual_plan' as const, title: 'Operating plan', summary: 'Approve the operating plan.', amountUsd: null, targetCompanyId: null, stockComponentPct: null };
    const staged = await submitCompanyCommand({ sessionId: session.sessionId, ownerId, expectedRevision: registration.revision!, conversationId: rival.id, commandId: 'dialogue_turn_one_0', command }, r);
    expect(staged.status).toBe('queued');
    const firstRevision = await appendCanonicalDialogueTurn({ sessionId: session.sessionId, ownerId, companyId: rival.id, turnId: 'turn_one', playerCompanyId: player.companyId, playerCharacterId: player.characterId, playerText: 'Please bring your operating plan to the board.', replyText: 'I have staged the plan for review.', receipts: [{ status: staged.status, revision: staged.revision, intent: staged.queuedAction?.intent ?? null, reason: null }] }, r);
    expect(firstRevision).toBe(staged.revision! + 1);
    const secondRevision = await appendCanonicalDialogueTurn({ sessionId: session.sessionId, ownerId, companyId: rival.id, turnId: 'turn_two', playerCompanyId: player.companyId, playerCharacterId: player.characterId, playerText: 'What is the next step?', replyText: 'The board must decide on the exact plan.', receipts: [{ status: 'rejected', revision: firstRevision, intent: null, reason: 'No further command was staged.' }] }, r);
    expect(secondRevision).toBe(firstRevision! + 1);
    // A retry never duplicates the player/NPC pair or receipts.
    expect(await appendCanonicalDialogueTurn({ sessionId: session.sessionId, ownerId, companyId: rival.id, turnId: 'turn_two', playerCompanyId: player.companyId, playerCharacterId: player.characterId, playerText: 'What is the next step?', replyText: 'The board must decide on the exact plan.' }, r)).toBe(secondRevision);
    const reloaded = canonicalSessionFile(session.sessionId, ownerId, r)!;
    const thread = reloaded.file.checkpoint!.state.conversationThreads!.find((entry) => entry.targetCompanyId === rival.id)!;
    expect(thread.turns).toHaveLength(4);
    expect(thread.turns[1]!.receipts?.[0]).toMatchObject({ status: 'queued', intent: command });
    expect(thread.turns[3]!.receipts?.[0]?.status).toBe('rejected');
    const resolved = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId, expectedRevision: reloaded.revision, requestId: 'after_dialogue', playerActions: [playerAction(session)] }, null, r);
    expect(resolved.status).toBe('resolved');
    const afterQuarter = resolved.file!.checkpoint!.state;
    expect(afterQuarter.quarter).toBe(session.quarter + 1);
    expect(afterQuarter.conversationThreads?.find((entry) => entry.id === thread.id)?.turns).toHaveLength(4);
  });

  it('records a valid autonomous research review as a replayable research-agent action', async () => {
    const r = root(); const { session, file } = fixture(); const ownerId = 'owner_a'; const player = session.players[0]!;
    const company = session.companies.find((entry) => entry.id === player.companyId)!;
    const project: ResearchProject = { id: 'rsp_canonical_review', companyId: company.id, targetNodeId: session.techGraph.nodes[0]!.id, budgetQuarterly: 0, computeAllocated: 0, talentAllocated: 0, progress: 0, internalConfidence: 0.5, quartersElapsed: 1, expectedQuarters: 1, isSecret: true, status: 'paused', cumulativeSpendUsd: 10_000, setbacks: 0, startedQuarter: 0, experiment: { mandate: { autonomous: true, spendingLimitUsd: 50_000, question: 'Can agents coordinate?', method: 'Evaluate candidates independently.', budgetUsd: 10_000, computeUnits: 10, researchersAssigned: 1, reviewAfterQuarters: 1 }, round: 1, roundQuarters: 1, awaitingReview: true, lastRunQuarter: 0, cashSpentLastRun: 10_000, computeUsedLastRun: 10, computeUsed: 10, researcherQuarters: 1, findings: [] } };
    session.researchProjects.push(project);
    const save = { ...file, checkpoint: { quarter: session.quarter, state: session } };
    const registration = registerGame(save, ownerId, r);
    const review: InnovationProposal = { nodeType: 'player_hypothesis', title: 'Canonical review', summary: 'A bounded review found a measurable result.', novelty: 0.5, plausibility: 0.7, requiredCapabilities: [], estimatedCost: 10_000, estimatedQuarters: 1, dependencies: [], initialVisibility: 'company_private', rationale: 'Continue with a controlled follow-up.', experimentReview: { projectId: project.id, round: 1, elapsedQuarters: 1, outcome: 'unexpected', observation: 'The held-out evaluation produced a measurable result.', interpretation: 'The result supports a narrower follow-up.', nextDirections: ['Change the evaluation population and repeat.'], capabilityGains: [], hypotheses: [], recommendation: 'continue', nextMethod: 'Change the evaluation population and repeat.' } };
    const planner = { planWorld: async () => null, planNpc: async () => null, reviewResearch: async () => review };
    const outcome = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId, expectedRevision: registration.revision!, requestId: 'research_review', playerActions: [playerAction(session)] }, planner, r);
    expect(outcome.status).toBe('resolved');
    const record = outcome.file!.log[0]!;
    expect(record.actions).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'research_agent', intent: expect.objectContaining({ type: 'propose_innovation', proposal: expect.objectContaining({ experimentReview: expect.objectContaining({ projectId: project.id }) }) }) })]));
    expect(outcome.file!.checkpoint!.state.quarter).toBe(session.quarter + 1);
    expect(outcome.file!.checkpoint!.state.researchProjects.find((entry) => entry.id === project.id)?.experiment?.findings).toHaveLength(1);
  });
});

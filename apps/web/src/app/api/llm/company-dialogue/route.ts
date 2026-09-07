import { z } from 'zod';
import { NextResponse } from 'next/server';
import type { CharacterReply, CharacterUtteranceContext, ConversationReceipt } from '@frontier/contracts';
import { admit, gateway, parseBody, runRole } from '../_gateway';
import { buildCompanyDialogueContext } from './context';
import { appendCanonicalDialogueTurn, canonicalDialogueTurn, loadCanonicalCompanyDialogue, submitCompanyCommand } from '@/lib/game/server/sessionAuthority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const BodySchema = z.object({ sessionId: z.string().min(1).max(200), companyId: z.string().min(1).max(200), turnId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), message: z.string().trim().min(1).max(600) });
const chunks = (value: string, size = 116): string[] => Array.from({ length: Math.ceil(value.length / size) }, (_, index) => value.slice(index * size, (index + 1) * size));
function receiptFacts(receipts: readonly ConversationReceipt[]): CharacterUtteranceContext['gameFacts'] { return receipts.flatMap((receipt, index) => chunks(JSON.stringify(receipt)).map((value, part) => ({ label: `PERSISTED RECEIPT ${index + 1}.${part + 1}`, value }))); }
function truthfulFallback(receipts: readonly ConversationReceipt[]): string {
  if (receipts.length === 0) return 'No company action was submitted or committed in this exchange.';
  return receipts.map((receipt) => receipt.status === 'queued' || receipt.status === 'duplicate' ? `The requested action is ${receipt.status === 'queued' ? 'queued for simulation validation and resolution' : 'already queued'}; it is not yet signed, approved, or completed.` : `The requested action was not queued (${receipt.status}${receipt.reason ? `: ${receipt.reason}` : ''}); no agreement was signed.`).join(' ');
}

export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request); if (!admission.ok) return admission.response;
  const parsed = await parseBody(request, BodySchema); if (!parsed.ok) return admission.admission.finish(parsed.response);
  const { sessionId, companyId, turnId, message } = parsed.value;
  const prior = canonicalDialogueTurn(sessionId, admission.admission.principal.id, turnId, message);
  if (prior.status === 'conflict') return admission.admission.finish(NextResponse.json({ error: 'turn_id_conflict' }, { status: 409 }));
  if (prior.status === 'complete') return admission.admission.finish(NextResponse.json({ output: prior.output ?? { text: prior.replyText, commands: [] }, fallbackUsed: prior.fallbackUsed, receipts: prior.receipts, revision: prior.revision }));
  const canonical = loadCanonicalCompanyDialogue(sessionId, admission.admission.principal.id, companyId);
  const built = canonical && buildCompanyDialogueContext(canonical, companyId, admission.admission.principal.id, message);
  if (!canonical || !built) return admission.admission.finish(NextResponse.json({ error: 'canonical_company_unavailable' }, { status: 409 }));
  const companyKey = admission.admission.conversationKey('npc', { gameSessionId: sessionId, playerId: companyId, conversationId: companyId });
  return admission.admission.finish(await runRole(async () => {
    const proposed = await gateway().roles.companyDialogue.converse(built.context, companyKey, { sessionId, quarter: canonical.state.quarter });
    const receipts: ConversationReceipt[] = [];
    for (const [index, command] of (proposed.output?.commands ?? []).entries()) {
      const receipt = await submitCompanyCommand({ sessionId, ownerId: admission.admission.principal.id, expectedRevision: canonical.revision + index, conversationId: companyId, commandId: `dialogue_${turnId}_${index}`, command });
      receipts.push({ status: receipt.status, revision: receipt.revision, intent: receipt.queuedAction?.intent ?? null, reason: receipt.validation?.reasons.join(' ') ?? (receipt.status === 'queued' || receipt.status === 'duplicate' ? null : receipt.status) });
    }
    const refreshed = loadCanonicalCompanyDialogue(sessionId, admission.admission.principal.id, companyId);
    const refreshedBuilt = refreshed && buildCompanyDialogueContext(refreshed, companyId, admission.admission.principal.id, message);
    let replyText = truthfulFallback(receipts); let continuationFallback = true;
    if (refreshed && refreshedBuilt) {
      const continuation: CharacterUtteranceContext = { ...refreshedBuilt.context, topic: 'Give the final reply to the player. Persisted receipts are authoritative. Describe queued actions as pending resolution and rejected or stale actions as no action. Issue no commands.', gameFacts: [...refreshedBuilt.context.gameFacts, ...receiptFacts(receipts), { label: 'Continuation rule', value: 'Wording only. No commands. Never claim queued means signed, approved, accepted, reserved, or delivered.' }] };
      const final = await gateway().roles.companyDialogue.converse(continuation, companyKey, { sessionId, quarter: refreshed.state.quarter });
      if (final.output?.text && !final.fallbackUsed) { replyText = final.output.text; continuationFallback = false; }
    }
    const claimsCompletedAction = /\b(?:is|was|has been|we have|i have|i)\s+(?:signed|accepted|approved|reserved|delivered|completed)\b/i.test(replyText);
    if (claimsCompletedAction && receipts.some((receipt) => receipt.status !== 'duplicate')) replyText = truthfulFallback(receipts);
    const fallbackUsed = proposed.fallbackUsed || continuationFallback;
    const output: CharacterReply | { text: string; commands: never[] } = proposed.output === null ? { text: replyText, commands: [] } : { ...proposed.output, text: replyText, commands: [] };
    const revision = await appendCanonicalDialogueTurn({ sessionId, ownerId: admission.admission.principal.id, companyId, turnId, playerCompanyId: built.playerCompanyId, playerCharacterId: built.playerCharacterId, playerText: message, replyText, output, receipts, fallbackUsed });
    return { output, fallbackUsed, receipts, revision };
  }));
}

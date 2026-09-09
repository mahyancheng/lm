import { z } from 'zod';
import { NextResponse } from 'next/server';
import type { CharacterReply } from '@frontier/contracts';
import { admit, gateway, parseBody, fallback, transportAvailable } from '../_gateway';
import { companyDialogueDraft } from '@/lib/game/server/companyDialogueDraft';
import { buildCompanyDialogueContext } from './context';
import { appendCanonicalDialogueTurn, canonicalDialogueTurn, loadCanonicalCompanyDialogue } from '@/lib/game/server/sessionAuthority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const BodySchema = z.object({ sessionId: z.string().min(1).max(200), companyId: z.string().min(1).max(200), turnId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), message: z.string().trim().min(1).max(600) });
const draftFallback = 'I have put concrete terms below for your review. Nothing is queued, signed, or binding until you queue the proposal for quarter resolution.';

export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request); if (!admission.ok) return admission.response;
  const parsed = await parseBody(request, BodySchema); if (!parsed.ok) return admission.admission.finish(parsed.response);
  const { sessionId, companyId, turnId, message } = parsed.value;
  const prior = canonicalDialogueTurn(sessionId, admission.admission.principal.id, turnId, message);
  if (prior.status === 'conflict') return admission.admission.finish(NextResponse.json({ error: 'turn_id_conflict' }, { status: 409 }));
  if (prior.status === 'complete') return admission.admission.finish(NextResponse.json({ turnId, output: prior.output ?? { text: prior.replyText, commands: [] }, fallbackUsed: prior.fallbackUsed, receipts: prior.receipts, revision: prior.revision }));
  const canonical = loadCanonicalCompanyDialogue(sessionId, admission.admission.principal.id, companyId);
  const built = canonical && buildCompanyDialogueContext(canonical, companyId, admission.admission.principal.id, message);
  if (!canonical || !built) return admission.admission.finish(NextResponse.json({ error: 'canonical_company_unavailable' }, { status: 409 }));
  const companyKey = admission.admission.conversationKey('npc', { gameSessionId: sessionId, playerId: companyId, conversationId: companyId });
  if (!transportAvailable()) return admission.admission.finish(fallback('transport_none'));
  try {
    const proposed = await gateway().roles.companyDialogue.converse(built.context, companyKey, { sessionId, quarter: canonical.state.quarter });
    const normalized = proposed.output === null ? null : companyDialogueDraft(proposed.output, companyId, built.playerCompanyId, canonical.state.quarter);
    const claimsCompletedAction = (normalized?.commands?.length ?? 0) > 0 && /\b(?:is|was|has been|we have|i have|i)\s+(?:sign(?:ed)?|accept(?:ed)?|approve(?:d)?|reserve(?:d)?|deliver(?:ed)?|complete(?:d)?)\b/i.test(normalized!.text);
    const replyText = claimsCompletedAction ? draftFallback : (normalized?.text ?? 'I cannot make a concrete proposal from the current terms.');
    const output: CharacterReply | { text: string; commands: never[] } = normalized === null ? { text: replyText, commands: [] } : { ...normalized, text: replyText };
    const receipts: never[] = [];
    const revision = await appendCanonicalDialogueTurn({ sessionId, ownerId: admission.admission.principal.id, companyId, turnId, playerCompanyId: built.playerCompanyId, playerCharacterId: built.playerCharacterId, playerText: message, replyText, output, receipts, fallbackUsed: proposed.fallbackUsed });
    if (revision === null) return admission.admission.finish(NextResponse.json({ error: 'conversation_not_saved' }, { status: 409 }));
    return admission.admission.finish(NextResponse.json({ turnId, output, fallbackUsed: proposed.fallbackUsed, receipts, revision }, { headers: { 'cache-control': 'no-store' } }));
  } catch {
    return admission.admission.finish(fallback('company_dialogue_failed'));
  }
}

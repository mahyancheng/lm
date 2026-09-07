import { z } from 'zod';
import { NextResponse } from 'next/server';
import type { ConversationReceipt } from '@frontier/contracts';
import { admit, parseBody } from '../../_gateway';
import { canonicalCompanyDialogueProposal, recordCompanyDialogueProposalReceipt, submitCompanyCommand } from '@/lib/game/server/sessionAuthority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(200),
  companyId: z.string().min(1).max(200),
  turnId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  proposalIndex: z.number().int().min(0).max(1),
});

export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request); if (!admission.ok) return admission.response;
  const parsed = await parseBody(request, BodySchema); if (!parsed.ok) return admission.admission.finish(parsed.response);
  const draft = canonicalCompanyDialogueProposal({ ...parsed.value, ownerId: admission.admission.principal.id });
  if (draft.status !== 'ready') return admission.admission.finish(NextResponse.json({ error: `proposal_${draft.status}` }, { status: draft.status === 'missing' ? 404 : 409 }));
  const result = await submitCompanyCommand({ sessionId: parsed.value.sessionId, ownerId: admission.admission.principal.id, expectedRevision: draft.revision, conversationId: parsed.value.companyId, commandId: `dialogue_${parsed.value.turnId}_${parsed.value.proposalIndex}`, command: draft.command });
  const receipt: ConversationReceipt = { proposalIndex: parsed.value.proposalIndex, status: result.status, revision: result.revision, intent: result.queuedAction?.intent ?? null, reason: result.validation?.reasons.join(' ') ?? (result.status === 'queued' || result.status === 'duplicate' ? null : result.status) };
  const persistedRevision = result.status === 'queued' || result.status === 'rejected'
    ? await recordCompanyDialogueProposalReceipt({ ...parsed.value, ownerId: admission.admission.principal.id, receipt })
    : null;
  return admission.admission.finish(NextResponse.json({ receipt, revision: persistedRevision ?? result.revision }, { status: result.status === 'forbidden' || result.status === 'session_not_registered' ? 403 : result.status === 'stale' ? 409 : 200 }));
}

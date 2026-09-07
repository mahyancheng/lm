'use client';

/**
 * A conversation with one character.
 *
 * The character-dialogue role already existed — `POST /api/llm/character`, a
 * `CharacterUtteranceContext` in, a zod-validated `CharacterReply` out — and no
 * screen had ever opened it. This is the client for it, and it is deliberately
 * small: a thread, a box, a send button.
 *
 * Two boundaries the panel keeps:
 *
 * - **A reply is not a state write.** `CharacterReply` carries relationship
 *   deltas, a memory draft and sometimes a `ConditionalCommitment`. None of it
 *   is applied here. Talking produces words; a commitment becomes real through
 *   the action the conversation was about, and the engine is the only thing
 *   that moves a number.
 * - **The model is never load-bearing.** `requestCharacterReply` resolves to
 *   null whenever no transport is configured or anything at all goes wrong, and
 *   the thread continues on `offlineReply` — in register, carrying no
 *   commitment. The panel says which of the two the player is reading.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AcceleratorPurchaseDraft, ActionIntent, Character, CharacterReply, CharacterUtteranceContext, ConversationReceipt, DealProposal, DealProposalDraft, Memory, MemoryDraft, Relationship, SessionState } from '@frontier/contracts';
import { AiLabel, ConfirmDialog, Icon, SectionHeading, Tag, cx } from '@/components/ui';
import { DealBuilder } from '../deal-room/DealBuilder';
import { BuyAccelerators } from '../company/BuyAccelerators';
import { acceleratorPurchaseDraft, acceleratorPurchaseQuoteStatus, negotiationDraft, negotiationFacts, proposalStatusSummary } from './negotiation';
import { PLAYER_ID, useActiveCompany, useGame, useGameActions, usePlayerView, useQueuedActions } from '@/lib/game';
import { requestCharacterReply, requestCompanyDialogue } from '@/lib/llm/client';
import { noteCanonicalSessionRevision } from '@/lib/game/canonicalSession';
import { sellersFor } from '@frontier/simulation';
import { offlineReply, publicFactsFor, type DialogueTurn } from './actions';

/** Turns kept on screen and sent as history. Enough for the thread to have a memory. */
export const MAX_TURNS = 12;

/** Openers, so a first tap is one tap rather than a blank box. */
const PROMPTS: readonly string[] = [
  'What would it take for you to back us?',
  'What do you make of where this market is going?',
  'Who else should I be talking to?',
];


function receiptLabel(status: ConversationReceipt['status']): string {
  switch (status) {
    case 'queued': return 'Submitted for quarter — see current terms below';
    case 'duplicate': return 'Already queued';
    case 'stale': return 'Pending refresh';
    case 'rejected': return 'Rejected';
    case 'session_not_registered': return 'Pending canonical session';
    case 'forbidden': return 'Rejected by authority';
  }
}

function receiptTone(status: ConversationReceipt['status']): 'gain' | 'warn' | 'loss' | 'neutral' {
  return status === 'queued' || status === 'duplicate' ? 'gain' : status === 'stale' || status === 'session_not_registered' ? 'warn' : 'loss';
}

function commandTerms(intent: ActionIntent | null): readonly string[] {
  if (intent === null) return [];
  switch (intent.type) {
    case 'propose_deal': return [
      `Offer to ${intent.proposal.counterpartyId}`,
      intent.proposal.binding ? 'Binding obligations if accepted' : 'Non-binding intent only',
      ...intent.proposal.gives.concat(intent.proposal.gets).flatMap((obligation) => obligation.kind === 'owned_accelerator_supply'
        ? [`Owned accelerators: ${obligation.quantityPerQuarter}/quarter for ${obligation.durationQuarters} quarters`, `Premium ${obligation.premiumPct}% · cap $${obligation.maxUnitPriceUsd.toLocaleString()} · priority ${obligation.priority}`, obligation.cancellable ? 'Future deliveries cancellable' : 'Future deliveries not cancellable']
        : [obligation.kind.replaceAll('_', ' ')]),
      `Expires Q${intent.proposal.expiresQuarter}`,
    ];
    case 'accept_deal': return [`Accept deal ${intent.dealId}`];
    case 'reject_deal': return [`Reject deal ${intent.dealId}`, intent.reason ? `Reason: ${intent.reason}` : 'No reason supplied'];
    case 'cancel_deal': return [`Cancel future obligations for deal ${intent.dealId}`, intent.reason ? `Reason: ${intent.reason}` : 'No reason supplied'];
    case 'submit_board_proposal': return [`Board proposal: ${intent.title}`, intent.summary];
    default: return [intent.type.replaceAll('_', ' ')];
  }
}

function hardwareTerms(deal: DealProposal): readonly string[] {
  return [...deal.gives, ...deal.gets].flatMap((obligation) => obligation.kind === 'owned_accelerator_supply'
    ? [`${obligation.quantityPerQuarter} owned accelerators/quarter × ${obligation.durationQuarters} quarters`, `Premium ${obligation.premiumPct}% · max $${obligation.maxUnitPriceUsd.toLocaleString()}/unit · priority ${obligation.priority}`, obligation.cancellable ? 'Future deliveries may be cancelled' : 'Not cancellable']
    : []);
}

function hasCancellableHardware(deal: DealProposal, companyId: string): boolean {
  return deal.status === 'accepted' && [...deal.gives, ...deal.gets].some((obligation) => obligation.kind === 'owned_accelerator_supply' && obligation.cancellable && (obligation.supplierCompanyId === companyId || obligation.buyerCompanyId === companyId));
}

/** Context for a company CEO: historic chats follow the employer at each turn. */
export function companyDialogueHistory(
  thread: SessionState['conversationThreads'] extends readonly (infer T)[] | undefined ? T | undefined : never,
  targetCompanyId: string,
  current: DialogueTurn,
): readonly DialogueTurn[] {
  const prior = thread === undefined ? [] : thread.turns
    .filter((turn) => turn.targetCompanyId === targetCompanyId || (turn.targetCompanyId === undefined && thread.targetCompanyId === targetCompanyId))
    .map((turn) => ({ speakerId: turn.speakerId, text: turn.text }));
  return [...prior, current].slice(-MAX_TURNS);
}

export interface TalkPanelProps {
  readonly session: SessionState;
  readonly target: Character;
  readonly selfId: string;
  /** How the target regards the player. Their side of the relationship. */
  readonly inbound: Relationship | null;
  /** How the player regards the target. */
  readonly outbound: Relationship | null;
  /** What the target remembers about the player — their context, never rendered. */
  readonly theirMemories: readonly Memory[];
  /** Why this conversation is permitted at all, in the engine's own words. */
  readonly accessBasis: string;
}

export function TalkPanel({
  session,
  target,
  selfId,
  inbound,
  outbound,
  theirMemories,
  accessBasis,
}: TalkPanelProps): React.JSX.Element {
  const company = useActiveCompany();
  const view = usePlayerView();
  const { recordConversationTurn, queueAction } = useGameActions();
  const { ledger } = useGame();
  const queuedActions = useQueuedActions();
  const counterparty = view.visibleCompanies.find((entry) => entry.id === target.companyId && entry.id !== company.id && entry.isActive !== false);
  const companyDialogue = target.companyId !== null && target.companyId === counterparty?.id && target.id === counterparty?.ceoCharacterId;
  const [deal, setDeal] = useState<DealProposalDraft | undefined>();
  // Keep the quoted draft visible across a quarter boundary. Re-validate it
  // against live published capacity before offering the human an order ticket.
  const [acceleratorQuote, setAcceleratorQuote] = useState<AcceleratorPurchaseDraft | undefined>();
  const [showDeal, setShowDeal] = useState(false);
  const [dealRevision, setDealRevision] = useState(0);
  // Quarter is deliberately absent: this is one durable thread for exactly
  // this session, player company and character. It cannot bleed into another NPC.
  const scope = `${session.sessionId}:${company.id}:${selfId}:${target.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const quarterRef = useRef(session.quarter);
  quarterRef.current = session.quarter;
  const storedThread = (session.conversationThreads ?? []).find(
    (thread) => thread.sessionId === session.sessionId && thread.playerCompanyId === company.id && thread.playerCharacterId === selfId && thread.targetCharacterId === target.id,
  );
  const pendingProposalSummary = useMemo(
    () => proposalStatusSummary(session, queuedActions, company.id, counterparty?.id, ledger),
    [session, queuedActions, company.id, counterparty?.id, ledger],
  );
  const acceleratorOrder = useMemo(
    () => acceleratorPurchaseDraft(acceleratorQuote, session, company, counterparty?.id),
    [acceleratorQuote, session, company, counterparty?.id],
  );
  const acceleratorQuoteStatus = useMemo(
    () => acceleratorQuote === undefined ? null : acceleratorPurchaseQuoteStatus(acceleratorQuote, session, company),
    [acceleratorQuote, session, company],
  );
  const incomingCompanyMessages = useMemo(
    () => (session.companyMessages ?? [])
      .filter((message) => message.recipientCompanyId === company.id && message.senderCompanyId === target.companyId)
      .slice(-6),
    [session.companyMessages, company.id, target.companyId],
  );
  const [turns, setTurns] = useState<readonly DialogueTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const storedReceipts = useMemo(() => (storedThread?.turns ?? []).flatMap((turn) => turn.receipts ?? []), [storedThread?.nextTurnSequence]);
  const conversationDeals = useMemo(() => target.companyId === null ? [] : session.deals.filter((deal) => (deal.proposerId === company.id && deal.counterpartyId === target.companyId) || (deal.proposerId === target.companyId && deal.counterpartyId === company.id)), [session.deals, company.id, target.companyId]);
  const [pendingDealAction, setPendingDealAction] = useState<{ readonly type: 'accept_deal' | 'reject_deal' | 'cancel_deal'; readonly deal: DealProposal } | null>(null);

  // A new person/company is a new thread and may discard local reply cards.
  useEffect(() => {
    setDeal(undefined);
    setAcceleratorQuote(undefined);
    setShowDeal(false);
    setSending(false);
    setTurns((storedThread?.turns ?? []).map((turn) => ({ speakerId: turn.speakerId, text: turn.text })));
    setDraft('');
    setOffline(false);
  }, [scope]);

  // Recording a completed exchange updates this exact thread. Hydrate only the
  // transcript: quote/deal cards came from that exchange and must stay visible.
  useEffect(() => {
    setTurns((storedThread?.turns ?? []).map((turn) => ({ speakerId: turn.speakerId, text: turn.text })));
  }, [storedThread?.nextTurnSequence]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (message.length === 0 || sending) return;
    const asked: DialogueTurn = { speakerId: selfId, text: message };
    const history = [...turns, asked].slice(-MAX_TURNS);
    setTurns(history);
    setDraft('');
    setSending(true);

    // A company CEO's shared agent must never receive chats from a prior
    // employer. The personal transcript can show them; the company context may
    // include only turns recorded under this immutable company scope.
    const companyHistory = companyDialogue
      ? companyDialogueHistory(storedThread, target.companyId!, asked)
      : history;
    const context: CharacterUtteranceContext = {
      character: target,
      relationship: inbound,
      counterpartRelationship: outbound,
      memories: theirMemories.slice(0, 6),
      topic: message.slice(0, 200),
      gameFacts: negotiationFacts(session, target, company, view.techGraph, counterparty?.id),
      conversationHistory: companyHistory.map((turn) => ({ speakerId: turn.speakerId, text: turn.text.slice(0, 600) })),
      accessBasis,
      pendingProposalSummary,
    };

    const requestQuarter = session.quarter;
    let reply: string | null = null;
    let memory: MemoryDraft | null = null;
    let receipts: ConversationReceipt[] | undefined;
    try {
      // A company CEO shares the company agent's server-derived Claude
      // identity. Everyone else keeps a character-scoped conversation.
      const output = companyDialogue
        ? await (async () => {
          const companyResult = await requestCompanyDialogue(context, { sessionId: session.sessionId, playerId: PLAYER_ID, conversationId: target.companyId! });
          // Old deterministic adapters return CharacterReply directly; the
          // actual route returns an envelope with receipts and a revision.
          const wire = companyResult as unknown as { output?: CharacterReply | null; receipts?: readonly ConversationReceipt[]; revision?: number | null; text?: string } | null;
          if (wire !== null && Array.isArray(wire.receipts)) {
            noteCanonicalSessionRevision(session.sessionId, wire.revision ?? null);
            receipts = [...wire.receipts];
          }
          return wire?.output ?? (wire?.text === undefined ? null : wire as unknown as CharacterReply);
        })()
        : await requestCharacterReply(context, { sessionId: session.sessionId, playerId: PLAYER_ID, conversationId: `${company.id}:${target.id}` });
      if (scopeRef.current !== scope || quarterRef.current !== requestQuarter) {
        if (scopeRef.current === scope) setSending(false);
        return;
      }
      const offered = negotiationDraft(output?.dealDraft, counterparty?.id, session.quarter, company.id);
      const verifiedAcceleratorOrder = acceleratorPurchaseDraft(output?.acceleratorPurchaseDraft, session, company, counterparty?.id);
      setDeal(offered);
      // Store only a quote that matched canonical availability when received;
      // later state changes render this same quote as expired rather than hiding it.
      setAcceleratorQuote(verifiedAcceleratorOrder);
      setShowDeal(offered !== undefined);
      setDealRevision((value) => value + 1);
      reply = output?.text ?? null;
      // The store accepts only the LLM contract's bounded memory draft and
      // converts it to a factual, non-binding conversation memory.
      memory = output?.memoryToStore ?? null;
    } catch {
      // The client never throws at a screen. A model failure is a degraded
      // conversation, not a broken one.
      reply = null;
    }

    if (scopeRef.current !== scope || quarterRef.current !== requestQuarter) {
        if (scopeRef.current === scope) setSending(false);
        return;
      }
    const spoken = reply ?? offlineReply(target, inbound?.trust ?? null, inbound?.hostility ?? null, message.slice(0, 120));
    recordConversationTurn({
      playerCompanyId: company.id,
      playerCharacterId: selfId,
      targetCharacterId: target.id,
      playerText: message,
      replyText: spoken,
      quarter: requestQuarter,
      memory: memory === null ? null : { kind: memory.kind, summary: memory.summary, sentiment: memory.sentiment },
      receipts,
    });
    setOffline(reply === null);
    setTurns((current) => [...current, { speakerId: target.id, text: spoken }].slice(-MAX_TURNS));
    setSending(false);
  }

  return (
    <div>
      <SectionHeading rule>Conversation</SectionHeading>

      {incomingCompanyMessages.length > 0 ? <section className="mt-2">
        <div className="label-caps-faint mb-1">Recent company outreach</div>
        <ul className="flex flex-col gap-2">
        {incomingCompanyMessages.map((message) => (
          <li key={message.id} className="mr-6 rounded-card raised-surface px-3 py-2 text-[12.5px] leading-relaxed text-ink-dim">
            <div className="label-caps-faint mb-1 flex items-center gap-1">{target.name} · Q{message.quarter} · {message.purpose.replaceAll('_', ' ')} <AiLabel /></div>
            {message.text}
          </li>
        ))}
        </ul>
      </section> : null}

      {storedReceipts.length > 0 ? <section className="mt-2 rounded-card raised-surface px-3 py-2 text-xs text-ink-dim">
        <SectionHeading rule>Company command status</SectionHeading>
        <p className="mt-1">A company action has no outcome until the matching receipt is queued and the quarter resolves.</p>
        <ul className="mt-2 flex flex-col gap-2">
          {storedReceipts.map((receipt, index) => <li key={`${receipt.revision ?? 'local'}-${index}`}>
            <Tag tone={receiptTone(receipt.status)}>{receiptLabel(receipt.status)}</Tag>
            {commandTerms(receipt.intent).map((term) => <div key={term} className="mt-1">{term}</div>)}
            {receipt.reason === null ? null : <div className="mt-1 text-warn">{receipt.reason}</div>}
          </li>)}
        </ul>
      </section> : null}

      {conversationDeals.length > 0 ? <section className="mt-2 flex flex-col gap-2">
        <SectionHeading rule>Current company terms</SectionHeading>
        {conversationDeals.map((deal) => {
          const inboundDeal = deal.counterpartyId === company.id;
          const answerable = inboundDeal && deal.status === 'proposed' && deal.expiresQuarter >= session.quarter;
          return <article key={deal.id} className="rounded-card raised-surface px-3 py-2 text-xs text-ink-dim">
            <div className="flex flex-wrap items-center gap-2"><Tag tone={deal.status === 'accepted' || deal.status === 'executed' ? 'gain' : deal.status === 'rejected' ? 'loss' : 'warn'}>{deal.status}</Tag><span>{deal.binding ? 'Binding if accepted' : 'Non-binding intent'}</span></div>
            <p className="mt-1">{deal.summary}</p>
            {hardwareTerms(deal).map((term) => <div key={term} className="mt-1">{term}</div>)}
            {deal.settlements?.length ? <div className="mt-1">Latest delivery: {deal.settlements.at(-1)?.status.replaceAll('_', ' ')} · {deal.settlements.at(-1)?.deliveredUnits ?? 0} units</div> : null}
            {answerable ? <div className="mt-2 flex gap-2"><button type="button" className="btn btn-primary" onClick={() => setPendingDealAction({ type: 'accept_deal', deal })}>Accept terms</button><button type="button" className="btn" onClick={() => setPendingDealAction({ type: 'reject_deal', deal })}>Reject terms</button></div> : null}
            {hasCancellableHardware(deal, company.id) ? <button type="button" className="btn mt-2" onClick={() => setPendingDealAction({ type: 'cancel_deal', deal })}>Cancel future deliveries</button> : null}
          </article>;
        })}
      </section> : null}

      {turns.length === 0 ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
          {target.name} answers from their traits, their standing and what they remember about you. Negotiate concrete terms, then review and queue an offer below. The other company decides whether to accept during quarter resolution.
        </p>
      ) : (
        <ul className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
          {turns.map((turn, index) => (
            <li
              key={`${turn.speakerId}-${index}`}
              className={cx(
                'rounded-card px-3 py-2 text-[12.5px] leading-relaxed',
                turn.speakerId === selfId ? 'ml-6 bg-brand-wash text-ink' : 'mr-6 raised-surface text-ink-dim',
              )}
            >
              {turn.speakerId === selfId ? null : (
                <div className="label-caps-faint mb-1">{target.name}</div>
              )}
              {turn.text}
            </li>
          ))}
          <div ref={endRef} />
        </ul>
      )}

      {turns.length === 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                className="btn tap-target text-[11px]"
                disabled={sending}
                onClick={() => {
                  void send(prompt);
                }}
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex items-end gap-2">
        <label className="block flex-1">
          <span className="sr-only">Message {target.name}</span>
          <textarea
            className="field text-[13px]"
            rows={2}
            maxLength={600}
            value={draft}
            placeholder={`Say something to ${target.name.split(' ')[0] ?? target.name}…`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary tap-target icon-knockout-brand shrink-0"
          disabled={sending || draft.trim().length === 0}
          onClick={() => {
            void send(draft);
          }}
        >
          <Icon name="chat" size={15} accent="inherit" />
          {sending ? 'Waiting' : 'Send'}
        </button>
      </div>

      {counterparty?.id ? <div className="mt-3">
        <button type="button" className="btn tap-target" onClick={() => setShowDeal((value) => !value)}>{showDeal ? 'Hide offer' : 'Build an offer'}</button>
        {showDeal ? <div className="mt-3">
          <SectionHeading rule>{deal ? 'Review negotiated terms' : 'Propose a deal'}</SectionHeading>
          <p className="my-2 text-xs text-ink-dim">Binding cash, technology, and owned-hardware terms settle only through the resolver after acceptance. Owned-hardware supply records quantity, price cap, duration, priority, and whether future deliveries may be cancelled; other terms are non-binding intent. Track responses in Deal Room.</p>
          <DealBuilder key={`${scope}:${dealRevision}`} initialDraft={deal}
            counterparties={[{ id: counterparty.id, label: counterparty.name ?? counterparty.id, kind: 'company' }]}
            securities={session.securities.filter((security) => security.companyId === company.id || view.visibleCompanies.some((entry) => entry.id === security.companyId && entry.isPublic)).map((security) => ({ id: security.id, label: security.symbol ?? security.id }))}
            opportunities={view.opportunities.filter((entry) => entry.status === 'open').map((entry) => ({ id: entry.id, label: entry.programme }))}
            techNodes={view.techGraph.nodes.map((node) => ({ id: node.id, label: node.title }))}
            products={company.products.map((product) => ({ id: product.id, label: product.name }))}
            quarter={session.quarter} startYear={session.startYear} company={company} negotiationOnly
            onProposalQueued={(draft) => {
              setDeal(draft);
              setShowDeal(true);
              setDealRevision((value) => value + 1);
            }} />
        </div> : null}
        {acceleratorQuote !== undefined ? <div className="mt-3 rounded-card raised-surface px-3 py-2 text-xs leading-relaxed text-ink-dim">
          <SectionHeading rule>Purchase from this company</SectionHeading>
          {acceleratorQuoteStatus === 'expired' || acceleratorOrder === undefined ? <>
            <Tag tone="warn">Quote expired — do not submit</Tag>
            <p className="mt-1">The published capacity, seller, or price has changed. Ask for a current quote before queuing an order.</p>
          </> : <>
            <p className="mt-1">Review this published capacity and price order. The confirmed order is what enters the resolver.</p>
            <div className="mt-2"><BuyAccelerators session={session} company={company} sellerCompanyId={acceleratorOrder.sellerCompanyId} initialUnits={acceleratorOrder.units} quotedUnitPriceUsd={acceleratorOrder.unitPriceUsd} /></div>
          </>}
        </div> : null}
      </div> : null}
      {offline && turns.length > 0 ? (
        <div className="mt-1.5">
          <Tag tone="neutral">Deterministic reply — no model available</Tag>
        </div>
      ) : null}
      <ConfirmDialog open={pendingDealAction !== null} title={pendingDealAction === null ? '' : pendingDealAction.type === 'accept_deal' ? 'Accept these company terms' : pendingDealAction.type === 'reject_deal' ? 'Reject these company terms' : 'Cancel future deliveries'} actionType={pendingDealAction?.type ?? 'accept_deal'} body={pendingDealAction?.type === 'cancel_deal' ? 'This cancels only future owned-hardware deliveries. Settled deliveries remain recorded.' : 'This queues your company’s response for quarter resolution; it is not an immediate outcome.'} terms={pendingDealAction === null ? [] : [{ label: 'Deal', value: pendingDealAction.deal.summary }, ...hardwareTerms(pendingDealAction.deal).map((value) => ({ label: 'Term', value }))]} confirmLabel={pendingDealAction?.type === 'accept_deal' ? 'Queue acceptance' : pendingDealAction?.type === 'reject_deal' ? 'Queue rejection' : 'Queue cancellation'} onCancel={() => setPendingDealAction(null)} onConfirm={() => { if (pendingDealAction === null) return; const intent = pendingDealAction.type === 'accept_deal' ? { type: 'accept_deal' as const, dealId: pendingDealAction.deal.id } : pendingDealAction.type === 'reject_deal' ? { type: 'reject_deal' as const, dealId: pendingDealAction.deal.id, reason: 'Declined in CEO conversation.' } : { type: 'cancel_deal' as const, dealId: pendingDealAction.deal.id, reason: 'Cancelled in CEO conversation.' }; queueAction(intent, { confirmed: true }); setPendingDealAction(null); }} />
    </div>
  );
}

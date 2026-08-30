'use client';

/**
 * One deal, term by term.
 *
 * Binding status is the most prominent thing on the page, because it is the
 * only thing that decides whether the engine will enforce any of it.
 * `intentStatements` sit under their own heading which says, in the heading
 * itself, that they are not enforceable — silently mixing them in with the
 * obligations would be the single most dishonest thing this screen could do.
 */

import { useState } from 'react';
import type { ActionValidationResult, DealProposal } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { ConfirmDialog, Drawer, KeyValueGrid, SectionHeading, Tag, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { OBLIGATION_LABELS, describeObligation } from './obligations';

export interface DealDrawerProps {
  readonly deal: DealProposal | null;
  readonly ownCompanyId: string;
  readonly nameOf: (id: string) => string;
  readonly startYear: number;
  readonly quarter: number;
  readonly onClose: () => void;
}

const STATUS_TONE: Readonly<Record<DealProposal['status'], 'neutral' | 'info' | 'gain' | 'loss' | 'warn'>> = {
  draft: 'neutral',
  proposed: 'info',
  accepted: 'gain',
  rejected: 'loss',
  expired: 'neutral',
  executed: 'gain',
};

export function DealDrawer({ deal, ownCompanyId, nameOf, startYear, quarter, onClose }: DealDrawerProps): React.JSX.Element | null {
  const { queueAction, validateIntent } = useGameActions();
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [answered, setAnswered] = useState(false);

  if (deal === null) return null;

  // Bound once so the callbacks below close over a non-null value rather than a
  // prop TypeScript has to re-narrow at every call site.
  const current: DealProposal = deal;
  const inbound = deal.counterpartyId === ownCompanyId;
  const answerable = inbound && deal.status === 'proposed' && deal.expiresQuarter >= quarter;

  // `gives` and `gets` are written from the *proposer's* point of view, so an
  // inbound offer reads back to front unless the sides are swapped.
  const yourSide = inbound ? deal.gets : deal.gives;
  const theirSide = inbound ? deal.gives : deal.gets;

  function close(): void {
    setConfirming(false);
    setRejecting(false);
    setReason('');
    setResult(null);
    setAnswered(false);
    onClose();
  }

  function reject(): void {
    const outcome = queueAction({ type: 'reject_deal', dealId: current.id, reason: reason.trim() });
    setResult(outcome.validation);
    setAnswered(true);
    setRejecting(false);
  }

  return (
    <Drawer
      open
      onClose={close}
      title={inbound ? `Offer from ${nameOf(deal.proposerId)}` : `Your offer to ${nameOf(deal.counterpartyId)}`}
      subtitle={`${deal.binding ? 'Binding' : 'Non-binding'} · ${deal.confidentiality}`}
      width={520}
      footer={
        answerable && !answered ? (
          <>
            <button type="button" className="btn" onClick={() => setRejecting(true)}>
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setResult(validateIntent({ type: 'accept_deal', dealId: deal.id }));
                setConfirming(true);
              }}
            >
              Accept
            </button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={STATUS_TONE[deal.status]} dot>
            {deal.status}
          </Tag>
          <Tag tone={deal.binding ? 'gain' : 'warn'}>{deal.binding ? 'Obligations enforced' : 'Nothing enforced'}</Tag>
          <Tag tone="neutral">{deal.confidentiality}</Tag>
          {deal.breachedByPartyId === null ? null : <Tag tone="loss">breached by {nameOf(deal.breachedByPartyId)}</Tag>}
        </div>

        <p className="text-[12px] leading-relaxed text-ink-dim">{deal.summary}</p>

        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Proposed', value: quarterLabel(startYear, deal.createdQuarter) },
            { label: 'Lapses', value: quarterLabel(startYear, deal.expiresQuarter) },
            { label: 'Counterparty', value: nameOf(inbound ? deal.proposerId : deal.counterpartyId), mono: false },
            {
              label: 'Answered',
              value: deal.respondedQuarter === null ? 'Not yet' : quarterLabel(startYear, deal.respondedQuarter),
            },
          ]}
        />

        <div>
          <SectionHeading rule>You give</SectionHeading>
          <ObligationList obligations={yourSide} />
        </div>

        <div>
          <SectionHeading rule>You get</SectionHeading>
          <ObligationList obligations={theirSide} />
        </div>

        <div>
          <SectionHeading rule>Said, not contracted — never enforced</SectionHeading>
          {deal.intentStatements.length === 0 ? (
            <p className="mt-2 text-[11px] text-ink-faint">Nothing was said beyond the terms above.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {deal.intentStatements.map((statement, index) => (
                <li key={index} className="rounded-card border border-dashed border-hair-strong px-3 py-2 text-[11px] text-ink-dim">
                  {statement}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
            Recorded and visible to both parties. The engine will never enforce a statement of intent, which is exactly what makes bluffing
            possible.
          </p>
        </div>

        {deal.conversationId === null ? null : (
          <p className="text-[10px] text-ink-faint">
            Came out of conversation <span className="figure">{deal.conversationId}</span>.
          </p>
        )}

        <ValidationBanner result={result} />

        {rejecting ? (
          <div className="raised-surface px-3 py-2.5">
            <label className="block">
              <span className="label-caps-faint">Why you are turning it down</span>
              <textarea
                className="field mt-1"
                rows={2}
                maxLength={300}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The compute term is fine; the board pledge is not."
              />
            </label>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              {nameOf(deal.proposerId)} remembers how they were turned down, not only that they were.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setRejecting(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={reject}>
                Queue the rejection
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Accept this deal"
        actionType="accept_deal"
        body={
          deal.binding
            ? 'Accepting makes the obligations above enforceable. From next quarter the engine checks every one of them, and a failure to deliver is a breach that transfers value and is permanent in the counterparty’s memory.'
            : 'This agreement is non-binding. Accepting records it and enforces nothing; either side may walk away without mechanical consequence.'
        }
        terms={[
          { label: 'From', value: nameOf(deal.proposerId) },
          { label: 'You give', value: yourSide.map(describeObligation).join(' · ') || 'nothing' },
          { label: 'You get', value: theirSide.map(describeObligation).join(' · ') || 'nothing', emphasis: true },
          { label: 'Binding', value: deal.binding ? 'Yes' : 'No' },
        ]}
        confirmLabel="Queue the acceptance"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          const outcome = queueAction({ type: 'accept_deal', dealId: deal.id }, { confirmed: true });
          setResult(outcome.validation);
          setAnswered(true);
          setConfirming(false);
        }}
      />
    </Drawer>
  );
}

function ObligationList({ obligations }: { readonly obligations: DealProposal['gives'] }): React.JSX.Element {
  if (obligations.length === 0) return <p className="mt-2 text-[11px] text-ink-faint">Nothing.</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {obligations.map((obligation, index) => (
        <li key={`${obligation.kind}-${index}`} className="raised-surface px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <Tag tone="info">{OBLIGATION_LABELS[obligation.kind]}</Tag>
          </div>
          <p className="mt-1 text-[11px] text-ink-dim">{describeObligation(obligation)}</p>
        </li>
      ))}
    </ul>
  );
}

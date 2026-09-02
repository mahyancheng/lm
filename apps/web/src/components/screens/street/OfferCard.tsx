'use client';

/**
 * One offer, as one decision.
 *
 * Three kinds of card — term sheet, approach, activist letter — each with the
 * V5 now→after preview above the verbs, because the cost of a decision must be
 * a number before it is committed rather than a surprise after.
 *
 * The one rule that shapes the whole card: **an offer made in quarter *t* is
 * answerable in *t+1*, and the card says so.** A card that is not yet answerable
 * keeps its verbs present and disabled with the reason, which is the same V4
 * pattern the Boardroom uses — hiding them would make the inbox a notification
 * instead of a decision a founder is preparing for.
 *
 * Everything is wired to the paths that already exist: `accept_deal`,
 * `reject_deal`, and a counter that is an ordinary `propose_deal` back with the
 * two fields a player may move.
 */

import { useState } from 'react';
import type { ActionValidationResult } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  ConfirmDialog,
  Icon,
  IconChip,
  NowAfter,
  Panel,
  Tag,
  ValidationBanner,
  cx,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { humanise } from '@/components/screens/reporting/util';
import { CounterSheet } from './CounterSheet';
import {
  BUYOUT_STAGE_LABEL,
  CAPITAL_KIND_ICON,
  buyoutOf,
  buyoutPreview,
  campaignStageLabel,
  termSheetOf,
  termSheetPreview,
  type BuyoutContext,
  type OfferCardRow,
  type PreviewRow,
  type TermSheetContext,
} from './model';

export interface OfferCardProps {
  readonly offer: OfferCardRow;
  readonly startYear: number;
  readonly quarter: number;
  readonly entityName: string;
  readonly entityKindIcon: keyof typeof CAPITAL_KIND_ICON | null;
  readonly partnerName: string;
  readonly companyName: string;
  readonly termSheetContext: TermSheetContext;
  readonly buyoutContext: BuyoutContext;
  /** Rendered under a live approach: the three defences, present and priced. */
  readonly defences?: React.ReactNode;
}

export function OfferCard({
  offer,
  startYear,
  quarter,
  entityName,
  entityKindIcon,
  partnerName,
  companyName,
  termSheetContext,
  buyoutContext,
  defences,
}: OfferCardProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [countering, setCountering] = useState(false);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [answered, setAnswered] = useState(false);

  const deal = offer.deal;
  const sheet = deal === null ? null : termSheetOf(deal);
  const buyout = deal === null ? null : buyoutOf(deal);

  const rows: readonly PreviewRow[] =
    sheet !== null
      ? termSheetPreview(sheet, termSheetContext)
      : buyout !== null
        ? buyoutPreview(buyout, buyoutContext)
        : [];

  const headline =
    sheet !== null
      ? `${humanise(sheet.stage)} · ${formatMoney(sheet.amountUsd)} at ${formatMoney(sheet.preMoneyUsd)} pre`
      : buyout !== null
        ? `${formatMoney(buyout.offerValueUsd)} for control · ${buyout.premiumPct}% premium`
        : offer.campaign === null
          ? ''
          : `${campaignStageLabel(offer.campaign.stage)} · holds ${offer.campaign.stakePct}%`;

  const canAnswer = deal !== null && offer.isAnswerable && !answered;
  const waitLine =
    deal === null
      ? null
      : offer.isAnswerable
        ? `Lapses ${quarterLabel(startYear, offer.expiresQuarter ?? quarter)}`
        : `Answerable from ${quarterLabel(startYear, offer.answerableFromQuarter)} — a fund’s offer is never resolved in the quarter it is made`;

  function decline(): void {
    if (deal === null) return;
    const outcome = queueAction({ type: 'reject_deal', dealId: deal.id, reason: reason.trim() });
    setResult(outcome.validation);
    setAnswered(true);
    setDeclining(false);
  }

  return (
    <Panel
      className={cx(offer.isAnswerable ? 'border-brand/30' : undefined)}
      icon={<IconChip name={entityKindIcon === null ? 'coins' : CAPITAL_KIND_ICON[entityKindIcon]} tone={offer.kind === 'buyout' ? 'loss' : 'brand'} />}
      title={entityName}
      subtitle={headline}
      actions={
        <Tag tone={offer.kind === 'buyout' ? 'loss' : offer.kind === 'activist' ? 'warn' : 'info'} dot>
          {offer.kind === 'term_sheet'
            ? 'Term sheet'
            : offer.kind === 'buyout'
              ? (buyout === null ? 'Approach' : BUYOUT_STAGE_LABEL[buyout.stage])
              : 'Activist letter'}
        </Tag>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          {deal?.summary ??
            (offer.campaign === null
              ? ''
              : `${entityName} is demanding ${offer.campaign.demands.map((demand) => humanise(demand).toLowerCase()).join(', ')} at ${companyName}.`)}
        </p>

        {rows.length === 0 ? null : (
          <NowAfter
            rows={rows.map((entry) => ({ key: entry.key, label: entry.label, now: entry.now, after: entry.after, tone: entry.tone }))}
            note={
              sheet === null
                ? undefined
                : `${sheet.proRata ? 'Pro-rata rights · ' : ''}${sheet.protectiveProvisions ? 'protective provisions · ' : ''}${sheet.liquidationPreferenceMultiple}× ${sheet.participating ? 'participating' : 'non-participating'}`
            }
          />
        )}

        {offer.campaign === null ? null : (
          <div className="flex flex-wrap gap-1.5">
            {offer.campaign.demands.map((demand) => (
              <Tag key={demand} tone="warn">
                {humanise(demand)}
              </Tag>
            ))}
            {offer.campaign.seatsGranted === 0 ? null : (
              <Tag tone="neutral">{offer.campaign.seatsGranted} seat conceded</Tag>
            )}
          </div>
        )}

        {waitLine === null ? null : (
          <p className={cx('flex items-start gap-1.5 text-[11px] leading-snug', offer.isAnswerable ? 'text-ink-faint' : 'text-brand')}>
            <Icon name="gauge" size={12} accent="current" className="mt-px shrink-0" />
            {waitLine}
          </p>
        )}

        <ValidationBanner result={result} />

        {deal === null ? (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            A campaign is answered in the boardroom, not here: concede a demand, lobby a director, or take it to a vote.
          </p>
        ) : answered ? (
          <p className="text-[11.5px] font-semibold text-brand">Queued. It resolves when the quarter does.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="btn btn-primary tap-target"
              disabled={!canAnswer}
              onClick={() => {
                setResult(validateIntent({ type: 'accept_deal', dealId: deal.id }));
                setConfirming(true);
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn tap-target"
              disabled={!canAnswer || sheet === null}
              title={sheet === null ? 'Only a priced round can be countered' : undefined}
              onClick={() => setCountering(true)}
            >
              Counter
            </button>
            <button type="button" className="btn tap-target" disabled={!canAnswer} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        )}

        {declining && deal !== null ? (
          <div className="raised-surface px-3 py-2.5">
            <label className="block">
              <span className="label-caps-faint">Why you are turning it down</span>
              <textarea
                className="field tap-target mt-1 sm:min-h-0"
                rows={2}
                maxLength={300}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The price is fine; the seat is not."
              />
            </label>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              {partnerName} remembers how they were turned down, not only that they were. A second refusal inside the
              cooldown costs trust.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-sm tap-target" onClick={() => setDeclining(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-sm tap-target" onClick={decline}>
                Queue the refusal
              </button>
            </div>
          </div>
        ) : null}

        {countering && deal !== null && sheet !== null ? (
          <CounterSheet
            sheet={sheet}
            deal={deal}
            partnerName={partnerName}
            quarter={quarter}
            startYear={startYear}
            onDone={(outcome) => {
              setResult(outcome);
              setAnswered(true);
              setCountering(false);
            }}
            onCancel={() => setCountering(false)}
          />
        ) : null}

        {defences}
      </div>

      {deal === null ? null : (
        <ConfirmDialog
          open={confirming}
          title={sheet === null ? 'Accept this approach' : 'Accept this term sheet'}
          actionType="accept_deal"
          body={
            sheet === null
              ? 'Accepting hands control to the sponsor. The debt they place on the business is placed on the business, not on them.'
              : 'Accepting closes a priced round next quarter: the cheque arrives, the shares are issued, and any seat on the sheet is filled by the investor.'
          }
          terms={rows.map((entry) => ({ label: entry.label, value: `${entry.now} → ${entry.after}`, emphasis: entry.key === 'ownership' }))}
          confirmLabel="Queue the acceptance"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            const outcome = queueAction({ type: 'accept_deal', dealId: deal.id }, { confirmed: true });
            setResult(outcome.validation);
            setAnswered(true);
            setConfirming(false);
          }}
        />
      )}
    </Panel>
  );
}

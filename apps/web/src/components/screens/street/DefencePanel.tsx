'use client';

/**
 * The three defences, present and priced.
 *
 * None of them is a new verb. A poison pill is a `financing` matter and a
 * staggered board a `restructuring` matter, both tabled at your own board while
 * the approach is public; a white knight is an ordinary deal offered to a rival
 * institution. So this form queues the actions that already exist and states, on
 * the confirm button, exactly what raising each one costs — the V8 pattern:
 * risk is the price of the effect, never a hidden penalty. None of the three
 * moves antitrust exposure — a rights plan and a classified board are not
 * concentration, and a white knight's acquisition is scored against the buyer —
 * so no "+N exposure" line is printed here. Inventing one would be a number the
 * engine never wrote.
 *
 * A defence that cannot be raised stays on screen, disabled, with the reason.
 */

import { useState } from 'react';
import type { ActionValidationResult, TakeoverDefence } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { ConfirmDialog, Icon, NowAfter, SectionHeading, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { POISON_PILL_DILUTION_PCT, STAGGERED_DELAY_QUARTERS, WHITE_KNIGHT_BUMP_PCT } from '@frontier/contracts';
import { defenceCostLine, type BuyoutOffer, type DefenceOption } from './model';

export interface DefencePanelProps {
  readonly options: readonly DefenceOption[];
  readonly offer: BuyoutOffer;
  readonly raiderName: string;
  readonly companyName: string;
  /** The reader's stake in the target, whole percentage, for the pill preview. */
  readonly ownStakePct: number;
  /** The institution a white knight would be invited from, and its partner. */
  readonly rescuer: { readonly entityId: string; readonly partnerCharacterId: string | null; readonly name: string } | null;
  readonly quarter: number;
}

export function DefencePanel({
  options,
  offer,
  raiderName,
  companyName,
  ownStakePct,
  rescuer,
  quarter,
}: DefencePanelProps): React.JSX.Element {
  const { queueAction } = useGameActions();
  const [confirming, setConfirming] = useState<TakeoverDefence | null>(null);
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [raised, setRaised] = useState<readonly TakeoverDefence[]>([]);

  const selected = confirming === null ? null : (options.find((option) => option.defence === confirming) ?? null);

  function raise(defence: TakeoverDefence): void {
    if (defence === 'white_knight') {
      if (rescuer === null) return;
      const counterUsd = Math.round((offer.offerValueUsd * (100 + WHITE_KNIGHT_BUMP_PCT)) / 100);
      const outcome = queueAction(
        {
          type: 'propose_deal',
          proposal: {
            counterpartyId: rescuer.partnerCharacterId ?? rescuer.entityId,
            counterpartyKind: rescuer.partnerCharacterId === null ? 'company' : 'character',
            gives: [
              {
                kind: 'buyout_offer',
                entityId: rescuer.entityId,
                targetCompanyId: offer.targetCompanyId,
                offerValueUsd: counterUsd,
                premiumPct: offer.premiumPct + WHITE_KNIGHT_BUMP_PCT,
                stage: 'private_approach',
                lboDebtUsd: offer.lboDebtUsd,
                equityChequeUsd: Math.max(0, counterUsd - offer.lboDebtUsd),
              },
            ],
            gets: [],
            confidentiality: 'private',
            expiresQuarter: quarter + 3,
            binding: false,
            intentStatements: [`${companyName} would rather be owned by ${rescuer.name} than by ${raiderName}.`],
            summary: `${companyName} invites ${rescuer.name} to counter ${raiderName}'s ${formatMoney(offer.offerValueUsd)} approach at ${formatMoney(counterUsd)}.`,
          },
        },
        { confirmed: true },
      );
      setResult(outcome.validation);
      setRaised((current) => [...current, defence]);
      setConfirming(null);
      return;
    }

    const isPill = defence === 'poison_pill';
    const outcome = queueAction(
      {
        type: 'submit_board_proposal',
        kind: isPill ? 'financing' : 'restructuring',
        title: isPill ? `Rights plan against ${raiderName}` : `Stagger the board of ${companyName}`,
        summary: isPill
          ? `Issue shares pro rata to every holder except ${raiderName}, diluting the raider by ${POISON_PILL_DILUTION_PCT}% and raising the authorised count in the same step.`
          : `Classify the board so that a holder crossing control is not decisive for ${STAGGERED_DELAY_QUARTERS} quarters, buying ${companyName} time against ${raiderName}.`,
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      },
      { confirmed: true },
    );
    setResult(outcome.validation);
    setRaised((current) => [...current, defence]);
    setConfirming(null);
  }

  return (
    <div>
      <SectionHeading rule>Defences</SectionHeading>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
        Each one is a structure that already exists, and each one has a price. None of them stops a determined bidder; they
        buy time, cost, or a better owner.
      </p>

      <ul className="mt-2 flex flex-col gap-2">
        {options.map((option) => {
          const done = raised.includes(option.defence);
          const disabled = option.blockedReason !== null || done;
          return (
            <li key={option.defence} className="raised-surface px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-ink">{option.label}</span>
                <Tag tone={option.reputationDelta === 0 ? 'neutral' : 'warn'}>{defenceCostLine(option)}</Tag>
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">{option.effect}</p>
              <p className="mt-0.5 text-[10.5px] text-ink-faint">{option.mechanism}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className={cx('btn btn-sm tap-target', disabled ? '' : 'btn-primary')}
                  disabled={disabled}
                  onClick={() => setConfirming(option.defence)}
                >
                  {done ? 'Queued' : `Raise the ${option.label.toLowerCase()}`}
                </button>
                {option.blockedReason === null ? null : (
                  <span className="flex items-center gap-1 text-[10.5px] text-ink-faint">
                    <Icon name="warning" size={12} accent="current" />
                    {option.blockedReason}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ValidationBanner result={result} />

      <ConfirmDialog
        open={selected !== null}
        title={selected === null ? '' : `Raise the ${selected.label.toLowerCase()}`}
        actionType={selected?.defence === 'white_knight' ? 'propose_deal' : 'submit_board_proposal'}
        body={selected === null ? '' : `${selected.effect} ${selected.mechanism}`}
        terms={
          selected === null
            ? []
            : [
                { label: 'Against', value: raiderName },
                { label: 'Investor reputation', value: defenceCostLine(selected), emphasis: selected.reputationDelta !== 0 },
              ]
        }
        confirmLabel="Queue it"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming !== null) raise(confirming);
        }}
      />

      {options.some((option) => option.defence === 'poison_pill' && option.blockedReason === null) ? (
        <NowAfter
          className="mt-2"
          rows={[
            {
              key: 'raider',
              label: 'They hold',
              now: `${offer.premiumPct}% premium`,
              after: `diluted ${POISON_PILL_DILUTION_PCT}%`,
              tone: 'gain',
            },
            {
              key: 'you',
              label: 'You hold',
              now: `${Math.round(ownStakePct)}%`,
              after: `${Math.round(ownStakePct)}% (pro rata)`,
            },
          ]}
          note="A pill issues to everyone but the raider, so your own share is unchanged and theirs is not. It needs a board vote, and the authorised count rises in the same step or it is refused outright."
        />
      ) : null}
    </div>
  );
}

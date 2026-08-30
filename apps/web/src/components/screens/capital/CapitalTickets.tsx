'use client';

/**
 * The three financing tickets: a private round, a debt issue, a buyback.
 *
 * All three are in `CONFIRMATION_REQUIRED_ACTIONS`, and all three are board
 * matters — the validator returns `clamped` and transforms them into a
 * `submit_board_proposal`. `ValidationBanner` says so in the player's language
 * ("Requires board approval") and shows the form that will actually be tabled,
 * which is the truth: the board votes before anything is executed.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult, FundingStage } from '@frontier/contracts';
import { FUNDING_STAGES } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { ConfirmDialog, TabBar, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { formatCount, titleise } from '../reporting/util';

type TicketId = 'raise' | 'debt' | 'buyback';

const TABS = [
  { id: 'raise', label: 'Raise' },
  { id: 'debt', label: 'Debt' },
  { id: 'buyback', label: 'Buyback' },
] as const;

export interface CapitalTicketsProps {
  /** Fully diluted count before the raise, for the dilution preview. */
  readonly fullyDilutedShares: number;
  /** Cash on hand, so a buyback budget can be read against it. */
  readonly cash: number;
  /** Last price or anchor per share, used as the buyback default. */
  readonly pricePerShare: number;
}

function numberOf(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function CapitalTickets({ fullyDilutedShares, cash, pricePerShare }: CapitalTicketsProps): React.JSX.Element {
  const { validateIntent, queueAction } = useGameActions();
  const [tab, setTab] = useState<TicketId>('raise');
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState<ActionValidationResult | null>(null);

  // raise
  const [stage, setStage] = useState<FundingStage>('seed');
  const [raiseAmount, setRaiseAmount] = useState('4000000');
  const [maxDilution, setMaxDilution] = useState('20');

  // debt
  const [debtAmount, setDebtAmount] = useState('2000000');
  const [maxRate, setMaxRate] = useState('9');
  const [term, setTerm] = useState('12');

  // buyback
  const [budget, setBudget] = useState('1000000');
  const [maxPrice, setMaxPrice] = useState(() => (pricePerShare > 0 ? pricePerShare.toFixed(2) : '1'));

  const intent = useMemo<ActionIntent | null>(() => {
    if (tab === 'raise') {
      const amount = numberOf(raiseAmount);
      const dilution = Math.min(1, Math.max(0, numberOf(maxDilution) / 100));
      if (amount <= 0 || dilution <= 0) return null;
      return { type: 'raise_round', stage, targetAmountUsd: amount, maxDilutionPct: dilution };
    }
    if (tab === 'debt') {
      const amount = numberOf(debtAmount);
      const rate = Math.min(0.5, Math.max(0, numberOf(maxRate) / 100));
      const quarters = Math.min(40, Math.max(1, Math.round(numberOf(term))));
      if (amount <= 0) return null;
      return { type: 'issue_debt', amountUsd: amount, maxRatePct: rate, termQuarters: quarters };
    }
    const budgetUsd = numberOf(budget);
    const price = numberOf(maxPrice);
    if (budgetUsd <= 0 || price <= 0) return null;
    return { type: 'buyback', budgetUsd, maxPricePerShareUsd: price };
  }, [tab, stage, raiseAmount, maxDilution, debtAmount, maxRate, term, budget, maxPrice]);

  const preCheck = useMemo(() => (intent === null ? null : validateIntent(intent)), [intent, validateIntent]);

  /* --- previews ----------------------------------------------------------- */

  const raiseDilution = Math.min(1, Math.max(0, numberOf(maxDilution) / 100));
  const impliedPostMoney = raiseDilution > 0 ? numberOf(raiseAmount) / raiseDilution : 0;
  const newShares = raiseDilution > 0 && raiseDilution < 1 ? (fullyDilutedShares * raiseDilution) / (1 - raiseDilution) : 0;
  const quarterlyInterest = (numberOf(debtAmount) * (numberOf(maxRate) / 100)) / 4;
  const buybackShares = numberOf(maxPrice) > 0 ? Math.floor(numberOf(budget) / numberOf(maxPrice)) : 0;

  const dialogTerms =
    tab === 'raise'
      ? [
          { label: 'Stage', value: titleise(stage) },
          { label: 'Sought', value: formatMoney(numberOf(raiseAmount)), emphasis: true },
          { label: 'Dilution ceiling', value: formatPct(raiseDilution) },
          { label: 'Implied post-money at ceiling', value: formatMoney(impliedPostMoney) },
          { label: 'New shares at ceiling', value: formatCount(newShares) },
        ]
      : tab === 'debt'
        ? [
            { label: 'Principal', value: formatMoney(numberOf(debtAmount)), emphasis: true },
            { label: 'Coupon ceiling', value: formatPct(numberOf(maxRate) / 100, 2) },
            { label: 'Term', value: `${Math.round(numberOf(term))} quarters` },
            { label: 'Interest at ceiling', value: `${formatMoney(quarterlyInterest)} per quarter` },
          ]
        : [
            { label: 'Budget', value: formatMoney(numberOf(budget)), emphasis: true },
            { label: 'Price ceiling', value: formatMoney(numberOf(maxPrice)) },
            { label: 'Shares at ceiling', value: formatCount(buybackShares) },
            { label: 'Cash after', value: formatMoney(cash - numberOf(budget)) },
          ];

  const dialogTitle = tab === 'raise' ? 'Attempt a private round' : tab === 'debt' ? 'Attempt a debt issue' : 'Repurchase shares';

  return (
    <div className="flex flex-col gap-3">
      <TabBar
        variant="segmented"
        ariaLabel="Financing"
        tabs={TABS.map((entry) => ({ id: entry.id, label: entry.label }))}
        value={tab}
        onChange={(id) => {
          setTab(id as TicketId);
          setQueued(null);
        }}
      />

      {tab === 'raise' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label-caps-faint">Stage</span>
            <select className="field mt-1" value={stage} onChange={(event) => setStage(event.target.value as FundingStage)}>
              {FUNDING_STAGES.map((entry) => (
                <option key={entry} value={entry}>
                  {titleise(entry)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label-caps-faint">Target (USD)</span>
            <input className="field mt-1" inputMode="numeric" value={raiseAmount} onChange={(event) => setRaiseAmount(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(numberOf(raiseAmount))}</span>
          </label>
          <label className="block">
            <span className="label-caps-faint">Max dilution (%)</span>
            <input className="field mt-1" inputMode="decimal" value={maxDilution} onChange={(event) => setMaxDilution(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">
              Post-money {formatMoney(impliedPostMoney)} · {formatCount(newShares)} new shares
            </span>
          </label>
        </div>
      ) : null}

      {tab === 'debt' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label-caps-faint">Principal (USD)</span>
            <input className="field mt-1" inputMode="numeric" value={debtAmount} onChange={(event) => setDebtAmount(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(numberOf(debtAmount))}</span>
          </label>
          <label className="block">
            <span className="label-caps-faint">Max coupon (%)</span>
            <input className="field mt-1" inputMode="decimal" value={maxRate} onChange={(event) => setMaxRate(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(quarterlyInterest)} interest per quarter</span>
          </label>
          <label className="block">
            <span className="label-caps-faint">Term (quarters)</span>
            <input className="field mt-1" inputMode="numeric" value={term} onChange={(event) => setTerm(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">The issue fails rather than clearing above your ceiling.</span>
          </label>
        </div>
      ) : null}

      {tab === 'buyback' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint">Budget (USD)</span>
            <input className="field mt-1" inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">
              {formatMoney(numberOf(budget))} of {formatMoney(cash)} cash
            </span>
          </label>
          <label className="block">
            <span className="label-caps-faint">Max price per share</span>
            <input className="field mt-1" inputMode="decimal" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatCount(buybackShares)} shares at the ceiling</span>
          </label>
        </div>
      ) : null}

      {preCheck === null ? (
        <p className="text-[11px] text-ink-faint">Enter the terms to run the validator.</p>
      ) : (
        <ValidationBanner result={preCheck} compact />
      )}

      {queued === null ? null : (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[11px] text-brand">
          Queued for this quarter. Review it on End Quarter before you submit.
        </div>
      )}

      <button type="button" className="btn btn-sm btn-primary self-start" disabled={intent === null} onClick={() => setPending(intent)}>
        Review {tab === 'raise' ? 'round' : tab === 'debt' ? 'issue' : 'buyback'}
      </button>

      <ConfirmDialog
        open={pending !== null}
        title={dialogTitle}
        actionType={tab === 'raise' ? 'raise_round' : tab === 'debt' ? 'issue_debt' : 'buyback'}
        tone={tab === 'buyback' ? 'warn' : 'brand'}
        body={
          tab === 'raise'
            ? 'A raise is an attempt, not an outcome: whether it clears depends on venture liquidity, your metrics and what the market believes about you. A failed raise is itself public information.'
            : tab === 'debt'
              ? 'Debt is cheaper than equity while rates and spreads are low, and a trap when they rise. The issue fails rather than clearing above your coupon ceiling.'
              : 'A buyback returns capital instead of investing it, and it needs board approval.'
        }
        terms={dialogTerms}
        confirmLabel="Queue for this quarter"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) {
            const entry = queueAction(pending, { confirmed: true });
            setQueued(entry.validation);
          }
          setPending(null);
        }}
      />
    </div>
  );
}

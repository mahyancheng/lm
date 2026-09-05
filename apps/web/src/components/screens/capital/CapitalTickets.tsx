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
import type { ActionIntent, ActionValidationResult, Company, FundingStage } from '@frontier/contracts';
import { FUNDING_STAGES } from '@frontier/contracts';
import { MAX_ROUND_DILUTION_PCT } from '@frontier/simulation';
import { formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import { CashAfter, ConfirmDialog, NowAfter, SliderField, TabBar, ValidationBanner, cashAfterOf, roundStep } from '@/components/ui';
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
  /** The company itself: the buyback preview reads its cash and its solvency clock. */
  readonly company: Company;
  /** Last price or anchor per share, used as the buyback default. */
  readonly pricePerShare: number;
}

function numberOf(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function CapitalTickets({ fullyDilutedShares, company, pricePerShare }: CapitalTicketsProps): React.JSX.Element {
  const cash = company.financials.cash;
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
  const [maxPrice, setMaxPrice] = useState(() => (pricePerShare > 0 ? String(Math.max(1, Math.round(pricePerShare))) : '1'));

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

  /* --- slider bounds -------------------------------------------------------
     A raise or a debt issue rarely exceeds what the whole company is marked
     at, so the current mark is the range worth arguing inside; Exact covers
     conviction beyond it. The dilution ceiling is the validator's own
     MAX_ROUND_DILUTION_PCT and the coupon ceiling is the schema's 0.5. */
  const mark = fullyDilutedShares * Math.max(pricePerShare, 0);
  const raiseMax = Math.max(mark, numberOf(raiseAmount), 10_000_000);
  const debtMax = Math.max(mark, numberOf(debtAmount), 10_000_000);
  const buybackMax = Math.max(cash, numberOf(budget), 1_000_000);
  const sharePriceMax = Math.max(pricePerShare * 4, numberOf(maxPrice), 10);

  /* --- previews ----------------------------------------------------------- */

  const raiseDilution = Math.min(1, Math.max(0, numberOf(maxDilution) / 100));
  const impliedPostMoney = raiseDilution > 0 ? numberOf(raiseAmount) / raiseDilution : 0;
  const newShares = raiseDilution > 0 && raiseDilution < 1 ? (fullyDilutedShares * raiseDilution) / (1 - raiseDilution) : 0;
  const quarterlyInterest = (numberOf(debtAmount) * (numberOf(maxRate) / 100)) / 4;
  const buybackShares = numberOf(maxPrice) > 0 ? Math.floor(numberOf(budget) / numberOf(maxPrice)) : 0;
  // Where the buyback leaves the balance, and the solvency clock if that is
  // below zero. The engine takes the budget whole either way.
  const solvency = cashAfterOf(company, numberOf(budget));

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
            { label: 'Coupon ceiling', value: formatPct(numberOf(maxRate) / 100) },
            { label: 'Term', value: `${Math.round(numberOf(term))} quarters` },
            { label: 'Interest at ceiling', value: `${formatMoney(quarterlyInterest)} per quarter` },
          ]
        : [
            { label: 'Budget', value: formatMoney(numberOf(budget)), emphasis: true },
            { label: 'Price ceiling', value: formatMoney(numberOf(maxPrice)) },
            { label: 'Shares at ceiling', value: formatCount(buybackShares) },
            { label: 'Cash after', value: formatMoney(cash - numberOf(budget)), emphasis: cash - numberOf(budget) < 0 },
            ...(solvency.line === null ? [] : [{ label: 'Solvency', value: solvency.line, emphasis: true }]),
          ];

  const dialogTitle = tab === 'raise' ? 'Attempt a private round' : tab === 'debt' ? 'Attempt a debt issue' : 'Repurchase shares';

  return (
    <div className="flex flex-col gap-3">
      <TabBar
        className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
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
            <select className="field tap-target mt-1 sm:min-h-0" value={stage} onChange={(event) => setStage(event.target.value as FundingStage)}>
              {FUNDING_STAGES.map((entry) => (
                <option key={entry} value={entry}>
                  {titleise(entry)}
                </option>
              ))}
            </select>
          </label>
          <SliderField
            label="Target (USD)"
            value={numberOf(raiseAmount)}
            onChange={(next) => setRaiseAmount(String(next))}
            min={0}
            max={raiseMax}
            step={roundStep(raiseMax)}
            format={formatMoney}
          />
          <div>
            {/* V5: an issue is priced in ownership, not in dollars, so the
                preview states the ownership rather than the proceeds. */}
            <SliderField
              label="Max dilution"
              value={Math.min(1, Math.max(0, numberOf(maxDilution) / 100))}
              onChange={(next) => setMaxDilution(String(Math.round(next * 100)))}
              min={0}
              max={MAX_ROUND_DILUTION_PCT}
              step={0.01}
              format={formatPct}
              exact={false}
              preview={(shown) => {
                const dilution = Math.min(0.99, Math.max(0, shown));
                const issued = dilution > 0 ? (fullyDilutedShares * dilution) / (1 - dilution) : 0;
                return (
                  <NowAfter
                    rows={[
                      {
                        key: 'holders',
                        label: 'Every existing holder keeps',
                        now: formatPct(1),
                        after: formatPct(1 - dilution),
                        tone: dilution > 0 ? 'loss' : undefined,
                      },
                      { key: 'shares', label: 'Shares in issue', now: formatCount(fullyDilutedShares), after: formatCount(fullyDilutedShares + issued) },
                      {
                        key: 'post',
                        label: 'Implied post-money',
                        now: formatMoney(fullyDilutedShares * Math.max(pricePerShare, 0)),
                        after: formatMoney(dilution > 0 ? numberOf(raiseAmount) / dilution : 0),
                      },
                    ]}
                    note="A ceiling, not a price: the round clears at whatever the market will take, and a failed raise is itself public information."
                  />
                );
              }}
            />
          </div>
        </div>
      ) : null}

      {tab === 'debt' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <SliderField
            label="Principal (USD)"
            value={numberOf(debtAmount)}
            onChange={(next) => setDebtAmount(String(next))}
            min={0}
            max={debtMax}
            step={roundStep(debtMax)}
            format={formatMoney}
          />
          <div>
            <SliderField
              label="Max coupon"
              value={Math.min(0.5, Math.max(0, numberOf(maxRate) / 100))}
              onChange={(next) => setMaxRate(String(Math.round(next * 100)))}
              min={0}
              max={0.5}
              step={0.01}
              format={formatPct}
              exact={false}
            />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(quarterlyInterest)} interest per quarter</span>
          </div>
          <div>
            <SliderField
              label="Term"
              value={Math.min(40, Math.max(1, Math.round(numberOf(term)) || 1))}
              onChange={(next) => setTerm(String(next))}
              min={1}
              max={40}
              step={1}
              format={formatQuarterCount}
              exact={false}
            />
            <span className="mt-1 block text-[10px] text-ink-faint">The issue fails rather than clearing above your ceiling.</span>
          </div>
        </div>
      ) : null}

      {tab === 'buyback' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <SliderField
              label="Budget (USD)"
              value={numberOf(budget)}
              onChange={(next) => setBudget(String(next))}
              min={0}
              max={buybackMax}
              step={roundStep(buybackMax)}
              format={formatMoney}
              chips
            />
            <span className="mt-1 block text-[10px] text-ink-faint">Of {formatMoney(cash)} cash</span>
          </div>
          <div>
            <SliderField
              label="Max price per share"
              value={numberOf(maxPrice)}
              onChange={(next) => setMaxPrice(String(next))}
              min={0}
              max={sharePriceMax}
              step={roundStep(sharePriceMax)}
              format={formatMoney}
            />
            <span className="mt-1 block text-[10px] text-ink-faint">{formatCount(buybackShares)} shares at the ceiling</span>
          </div>
          <div className="sm:col-span-2">
            <CashAfter company={company} spendUsd={numberOf(budget)} note="Paid out of cash in the capital phase." />
          </div>
        </div>
      ) : null}

      {preCheck === null ? (
        <p className="text-[13px] text-ink-faint sm:text-[11px]">Enter the terms to run the validator.</p>
      ) : (
        <ValidationBanner result={preCheck} compact />
      )}

      {queued === null ? null : (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[13px] leading-relaxed text-brand sm:text-[11px]">
          Queued for this quarter. Review it on End Quarter before you submit.
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary tap-target w-full sm:w-auto sm:self-start sm:min-h-0"
        disabled={intent === null}
        onClick={() => setPending(intent)}
      >
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

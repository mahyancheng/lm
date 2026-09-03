'use client';

/**
 * V5 — the payout slider, with the counterfactual under the thumb.
 *
 * The single cleanest decision in a quarterly business sim, and the one the
 * engine had none of before Wave 3: growth or extraction, 0 to 80 per cent of
 * last quarter's net income in steps of five.
 *
 * Every figure in the preview comes from `dividendUsd` and
 * `dividendReputationBonus` — the same pure functions `resolveCapital` calls
 * when it settles the payout — so the preview is not an estimate of what the
 * engine will do, it is the arithmetic the engine will do. The two things the
 * player cannot see coming are stated rather than discovered: the payout is
 * struck on **last** quarter's result, and it is capped at half of cash however
 * high the policy goes.
 *
 * Raising the payout is a board matter, which the validator turns into a
 * proposal; lowering or holding it is management's. `ValidationBanner` says
 * which, in the player's language, before anything is queued.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult, Company, DividendPreview } from '@frontier/contracts';
import {
  DIVIDEND_CASH_CAP_SHARE,
  DIVIDEND_MAX_PAYOUT_PCT,
  DIVIDEND_PAYOUT_STEP_PCT,
  dividendReputationBonus,
  dividendUsd,
} from '@frontier/contracts';
import { lastQuarterNetIncomeUsd, negativeCashQuarters, solvencyLine } from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import { ConfirmDialog, Icon, NowAfter, SliderField, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions } from '@/lib/game';

export interface DividendTicketProps {
  readonly company: Company;
  /** Last quarter's committed payout, when one was made. */
  readonly paid: DividendPreview | null;
  /** Ordinary shares in issue, so a per-share figure can be stated. */
  readonly issuedShares: number;
}

export function DividendTicket({ company, paid, issuedShares }: DividendTicketProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const current = Math.max(0, Math.round(company.dividendPolicyPct ?? 0));
  const [payoutPct, setPayoutPct] = useState(current);
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState<ActionValidationResult | null>(null);

  const basis = useMemo(() => lastQuarterNetIncomeUsd(company), [company]);
  const cash = company.financials.cash;
  const negativeQuarters = negativeCashQuarters(company);

  const intent = useMemo<ActionIntent>(() => ({ type: 'set_dividend_policy', payoutPct }), [payoutPct]);
  const preCheck = useMemo(() => validateIntent(intent), [validateIntent, intent]);

  /** What a policy would pay, and what it would leave behind. Engine arithmetic. */
  function outcome(pct: number): { readonly paidUsd: number; readonly retainedUsd: number; readonly cappedByCash: boolean } {
    const paidUsd = dividendUsd(basis, pct, cash);
    const uncapped = Math.max(0, Math.round((Math.max(0, basis) * Math.round(pct)) / 100));
    return { paidUsd, retainedUsd: Math.round(basis) - paidUsd, cappedByCash: paidUsd < uncapped };
  }

  const now = outcome(current);
  const raising = payoutPct > current;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={current > 0 ? 'gain' : 'neutral'} dot>
          policy {current}%
        </Tag>
        <Tag tone="neutral">basis {formatMoney(basis)}</Tag>
        {paid === null ? null : <Tag tone="info">paid {formatMoney(paid.dividendUsd)} last quarter</Tag>}
      </div>

      <SliderField
        label="Payout of net income"
        value={payoutPct}
        onChange={(next) => {
          setPayoutPct(Math.round(next));
          setQueued(null);
        }}
        min={0}
        max={DIVIDEND_MAX_PAYOUT_PCT}
        step={DIVIDEND_PAYOUT_STEP_PCT}
        format={(value) => `${Math.round(value)}%`}
        exact={false}
        preview={(shown) => {
          const after = outcome(Math.round(shown));
          return (
            <NowAfter
              rows={[
                { key: 'paid', label: 'To shareholders', now: formatMoney(now.paidUsd), after: formatMoney(after.paidUsd), tone: 'gain' },
                {
                  key: 'retained',
                  label: 'Retained in the business',
                  now: formatMoney(now.retainedUsd),
                  after: formatMoney(after.retainedUsd),
                  tone: after.retainedUsd < now.retainedUsd ? 'loss' : undefined,
                },
                {
                  key: 'perShare',
                  label: 'Per ordinary share',
                  now: issuedShares > 0 ? formatMoney(now.paidUsd / issuedShares, 'full') : '—',
                  after: issuedShares > 0 ? formatMoney(after.paidUsd / issuedShares, 'full') : '—',
                },
                {
                  key: 'reputation',
                  label: 'Investor reputation',
                  now: `+${dividendReputationBonus(current)}`,
                  after: `+${dividendReputationBonus(Math.round(shown))}`,
                  tone: 'gain',
                },
                {
                  key: 'cash',
                  label: 'Cash',
                  now: formatMoney(cash),
                  after: formatMoney(cash - after.paidUsd),
                  tone: cash - after.paidUsd < 0 ? 'loss' : undefined,
                },
              ]}
              note={
                solvencyLine(negativeQuarters, cash - after.paidUsd) ??
                (after.cappedByCash
                  ? `Capped at ${formatPct(DIVIDEND_CASH_CAP_SHARE)} of the ${formatMoney(cash)} on hand — the policy asks for more than the cash allows.`
                  : `Settled next quarter on this quarter's result of ${formatMoney(basis)}, and never more than ${formatPct(DIVIDEND_CASH_CAP_SHARE)} of cash.`)
              }
            />
          );
        }}
      />

      <ValidationBanner result={preCheck} compact />

      {queued === null ? null : (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[13px] text-brand sm:text-[11px]">
          Queued for this quarter. Review it on End Quarter before you submit.
        </div>
      )}

      <p className={cx('flex items-start gap-1.5 text-[10.5px] leading-relaxed', raising ? 'tone-warn' : 'text-ink-faint')}>
        <Icon name="stamp" size={12} accent="current" className="mt-px shrink-0" />
        {raising
          ? 'Raising the payout is a board matter: the validator turns it into a dividend proposal and the directors vote on it.'
          : 'Holding or cutting the payout is management’s to decide. Raising it is a board matter.'}
      </p>

      <button
        type="button"
        className="btn btn-primary tap-target w-full sm:w-auto sm:self-start sm:min-h-0"
        disabled={payoutPct === current}
        onClick={() => setPending(intent)}
      >
        Review payout
      </button>

      <ConfirmDialog
        open={pending !== null}
        title="Set the payout policy"
        actionType="set_dividend_policy"
        tone={raising ? 'warn' : 'brand'}
        body="Capital paid out is capital the business does not get to spend. The payment is struck on last quarter's net income and capped at half of cash, so a policy above what the company earns simply pays what it can."
        terms={[
          { label: 'Payout', value: `${payoutPct}% of net income`, emphasis: true },
          { label: 'Basis', value: formatMoney(basis) },
          { label: 'Would pay', value: formatMoney(outcome(payoutPct).paidUsd) },
          { label: 'Retained', value: formatMoney(outcome(payoutPct).retainedUsd) },
          { label: 'Route', value: raising ? 'board proposal' : 'management decision' },
        ]}
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

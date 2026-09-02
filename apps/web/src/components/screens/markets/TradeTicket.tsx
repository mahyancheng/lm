'use client';

/**
 * The trade ticket.
 *
 * `buy_shares` and `sell_shares` are both in `CONFIRMATION_REQUIRED_ACTIONS`,
 * so nothing leaves this component without a human clicking through
 * `ConfirmDialog`. The validator runs live as the player types — a pre-check,
 * never an authorisation: the engine validates again and its answer is the one
 * that counts.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { ConfirmDialog, SectionHeading, TabBar, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { formatCount } from '../reporting/util';

export interface TradeTicketProps {
  readonly securityId: string;
  readonly companyName: string;
  readonly symbol: string | null;
  /** Last traded price, used as the default limit. */
  readonly lastPrice: number;
  /** Shares the acting company already holds in this security. */
  readonly heldShares: number;
  /** Issued shares in the class, so the ticket can state the resulting stake. */
  readonly issuedShares: number;
}

type Side = 'buy' | 'sell';

export function TradeTicket({
  securityId,
  companyName,
  symbol,
  lastPrice,
  heldShares,
  issuedShares,
}: TradeTicketProps): React.JSX.Element {
  const { validateIntent, queueAction } = useGameActions();
  const [side, setSide] = useState<Side>('buy');
  const [shares, setShares] = useState('100000');
  const [limit, setLimit] = useState(() => (lastPrice > 0 ? String(Math.max(1, Math.round(lastPrice))) : '0'));
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState<ActionValidationResult | null>(null);

  const shareCount = Math.max(0, Math.floor(Number(shares) || 0));
  const limitPrice = Math.max(0, Number(limit) || 0);
  const consideration = shareCount * limitPrice;

  const intent = useMemo<ActionIntent>(() => {
    if (side === 'buy') {
      return { type: 'buy_shares', securityId, targetPct: null, shares: shareCount, maxPricePerShareUsd: limitPrice };
    }
    return { type: 'sell_shares', securityId, shares: shareCount, minPricePerShareUsd: limitPrice };
  }, [side, securityId, shareCount, limitPrice]);

  const preCheck = useMemo(() => (shareCount > 0 ? validateIntent(intent) : null), [validateIntent, intent, shareCount]);

  const sharesAfter = side === 'buy' ? heldShares + shareCount : Math.max(0, heldShares - shareCount);
  const stakeAfter = issuedShares > 0 ? sharesAfter / issuedShares : 0;
  const stakeNow = issuedShares > 0 ? heldShares / issuedShares : 0;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading rule>Trade ticket</SectionHeading>

      <TabBar
        className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
        variant="segmented"
        ariaLabel="Side"
        tabs={[
          { id: 'buy', label: 'Buy' },
          { id: 'sell', label: 'Sell', disabled: heldShares <= 0 },
        ]}
        value={side}
        onChange={(id) => {
          setSide(id === 'sell' ? 'sell' : 'buy');
          setQueued(null);
        }}
      />

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label-caps-faint">Shares</span>
          <input
            className="field tap-target mt-1 sm:min-h-0"
            inputMode="numeric"
            value={shares}
            onChange={(event) => {
              setShares(event.target.value);
              setQueued(null);
            }}
          />
        </label>
        <label className="block">
          <span className="label-caps-faint">{side === 'buy' ? 'Max price' : 'Min price'}</span>
          <input
            className="field tap-target mt-1 sm:min-h-0"
            inputMode="decimal"
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
              setQueued(null);
            }}
          />
        </label>
      </div>

      <dl className="raised-surface divide-y divide-hair px-3 py-1 text-[12px]">
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="label-caps-faint">Consideration</dt>
          <dd className="figure text-ink">{formatMoney(consideration)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="label-caps-faint">Stake now</dt>
          <dd className="figure text-ink-dim">{formatPct(stakeNow)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="label-caps-faint">Stake if filled</dt>
          <dd className="figure text-ink">{formatPct(stakeAfter)}</dd>
        </div>
      </dl>

      {preCheck === null ? (
        <p className="text-[13px] text-ink-faint sm:text-[11px]">Enter a share count to run the validator.</p>
      ) : (
        <ValidationBanner result={preCheck} compact />
      )}

      {queued === null ? null : (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[13px] text-brand sm:text-[11px]">
          Queued for this quarter. It resolves in the market phase.
        </div>
      )}

      {/* The one control this ticket exists for: full width and a full thumb
          tall on a phone, the compact button from `sm` up. */}
      <button
        type="button"
        className="btn btn-primary tap-target w-full sm:w-auto sm:min-h-0"
        disabled={shareCount <= 0 || limitPrice <= 0}
        onClick={() => setPending(intent)}
      >
        {side === 'buy' ? 'Review purchase' : 'Review sale'}
      </button>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Accumulating past 5% makes the position public knowledge, which is usually the moment the target notices.
      </p>

      <ConfirmDialog
        open={pending !== null}
        title={side === 'buy' ? `Buy ${companyName}` : `Sell ${companyName}`}
        actionType={side === 'buy' ? 'buy_shares' : 'sell_shares'}
        tone={side === 'buy' ? 'brand' : 'warn'}
        body={
          side === 'buy'
            ? 'A purchase order executes against the public float at the market price, subject to your limit. Large orders move the price against you.'
            : 'A sale executes into the float at the market price, subject to your limit. Large sales move the price against you and are read as a signal.'
        }
        terms={[
          { label: 'Security', value: symbol ?? securityId },
          { label: 'Shares', value: formatCount(shareCount) },
          { label: side === 'buy' ? 'Maximum price' : 'Minimum price', value: formatMoney(limitPrice) },
          { label: 'Consideration at limit', value: formatMoney(consideration), emphasis: true },
          { label: 'Stake if filled', value: formatPct(stakeAfter) },
        ]}
        confirmLabel={side === 'buy' ? 'Queue purchase' : 'Queue sale'}
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

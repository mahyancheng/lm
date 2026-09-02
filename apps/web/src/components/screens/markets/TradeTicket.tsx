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
import type { ActionIntent, ActionValidationResult, ControlStatus } from '@frontier/contracts';
import { BLOCK_PREMIUM, stakeExecutionPriceUsd, stakeImpactPct } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import {
  ConfirmDialog,
  NowAfter,
  ProgressBar,
  SectionHeading,
  SliderField,
  TabBar,
  Tag,
  ValidationBanner,
  openCeiling,
  roundStep,
} from '@/components/ui';
import { controlCaption } from '../sector/model';
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
  /** Shares held by the public float — the validator's own ceiling on a purchase. */
  readonly floatShares: number;
  /**
   * The acting seat's committed control row for this company, when it has one.
   *
   * Drives the V4 progress bar: one number, one target, and the caption that
   * says how far short of decisive the position is.
   */
  readonly control?: ControlStatus | null;
}

type Side = 'buy' | 'sell';

export function TradeTicket({
  securityId,
  companyName,
  symbol,
  lastPrice,
  heldShares,
  issuedShares,
  floatShares,
  control = null,
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

  /* --- slider bounds -------------------------------------------------------
     Both ceilings are the validator's: a purchase is cut to the free float, a
     sale to the whole position, so "Max" is the largest order that clears
     rather than a number this ticket made up. The limit price is not a budget,
     so it carries no chips — a few multiples of the last trade is the range,
     and conviction past it is typed. */
  const sharesMax = side === 'buy' ? Math.max(1, floatShares) : Math.max(1, heldShares);
  const priceMax = openCeiling(10, lastPrice * 3, limitPrice);

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

      {/* V4: one number, one target. The whole Plutocracy loop is a player
          reading one progress bar toward 50% + 1. */}
      {control === null ? null : (
        <div>
          <ProgressBar
            label="Your stake against control"
            value={Math.min(control.stakePct, 100)}
            max={100}
            ghostValue={control.controlThresholdPct}
            tone={control.hasControl ? 'brand' : control.hasInformationRight ? 'info' : 'neutral'}
            valueLabel={`${control.stakePct}% · control at ${control.controlThresholdPct}%`}
          />
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-faint">
            {control.hasInformationRight ? <Tag tone="info" size="sm">information right</Tag> : null}
            {control.hasControl ? <Tag tone="brand" size="sm">control</Tag> : null}
            {controlCaption(control)}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <SliderField
          label="Shares"
          value={shareCount}
          onChange={(next) => {
            setShares(String(next));
            setQueued(null);
          }}
          min={0}
          max={sharesMax}
          step={roundStep(sharesMax)}
          format={formatCount}
          chips
          preview={
            side === 'buy'
              ? (shown) => {
                  // V5: slippage is a decision, not a surprise. Both figures come
                  // from the engine's own convex-accumulation functions, which are
                  // the ones `settleTrades` will apply.
                  const impact = stakeImpactPct(Math.round(shown), floatShares);
                  const execution = stakeExecutionPriceUsd(lastPrice, Math.round(shown), floatShares);
                  return (
                    <NowAfter
                      nowLabel="Quote"
                      afterLabel="Filled at"
                      rows={[
                        { key: 'price', label: 'Price per share', now: formatMoney(lastPrice, 'full'), after: formatMoney(execution, 'full'), tone: impact > 0 ? 'loss' : undefined },
                        { key: 'impact', label: 'Your own price impact', now: '0%', after: `+${impact}%`, tone: impact > 0 ? 'loss' : undefined },
                        {
                          key: 'cost',
                          label: 'All in, at the execution price',
                          now: formatMoney(Math.round(shown) * lastPrice),
                          after: formatMoney(Math.round(shown) * execution),
                        },
                      ]}
                      note={`Buying the whole float costs twice the quote, and a named holder's block costs ${BLOCK_PREMIUM}x flat — the last tranche is the expensive one.`}
                    />
                  );
                }
              : undefined
          }
        />
        <SliderField
          label={side === 'buy' ? 'Max price' : 'Min price'}
          value={limitPrice}
          onChange={(next) => {
            setLimit(String(next));
            setQueued(null);
          }}
          min={0}
          max={priceMax}
          step={roundStep(priceMax)}
          format={formatMoney}
        />
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

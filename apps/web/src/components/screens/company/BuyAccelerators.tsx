'use client';

/**
 * Buying accelerators outright, from a company that makes them.
 *
 * Renting compute is an operating decision and it lives on the sliders beside
 * this one. Owning it is a capital decision: cash now, an asset that ages, and
 * no rent ever again. This card is where that trade is made, and it states both
 * halves — what leaves the balance this quarter, and what the fleet costs to
 * carry afterwards.
 *
 * **Every figure here is the engine's.** The sellers, their prices and what each
 * can ship come from `sellersFor`, the same function the validator resolves a
 * counterparty with; the depreciation rate is the engine's constant; where the
 * cash lands and what the solvency clock reads come from `CashAfter`. The screen
 * computes nothing economic — it multiplies a price the engine quoted by a
 * count the founder chose, which is the arithmetic the preview is *for*.
 *
 * The order is not the price. A seller's asking price can move between now and
 * resolution, so the action carries a ceiling and fails rather than clearing
 * above it, exactly as a reservation does.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, Company, SessionState } from '@frontier/contracts';
import { PPE_DEPRECIATION_PER_QUARTER, isMultiSectorWorld, sellersFor } from '@frontier/simulation';
import { formatCount, formatMoney } from '@frontier/shared';
import {
  CashAfter,
  ConfirmDialog,
  EmptyState,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  cashAfterOf,
  roundStep,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';

/** How much headroom over the asking price the order allows before it fails. */
export const PRICE_CEILING_MARGIN = 1.1;

export interface BuyAcceleratorsProps {
  readonly session: SessionState;
  readonly company: Company;
}

export function BuyAccelerators({ session, company }: BuyAcceleratorsProps): React.JSX.Element | null {
  const { validateIntent, queueAction } = useGameActions();
  const sellers = useMemo(() => sellersFor(session, 'accelerators', company.id), [session, company.id]);
  const [sellerId, setSellerId] = useState<string>(() => sellers[0]?.company.id ?? '');
  const seller = sellers.find((entry) => entry.company.id === sellerId) ?? sellers[0] ?? null;
  const [units, setUnits] = useState(0);
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState(false);

  const wanted = seller === null ? 0 : Math.min(Math.round(units), seller.sellableUnits);
  const costUsd = seller === null ? 0 : wanted * seller.unitPriceUsd;

  const intent = useMemo<ActionIntent | null>(() => {
    if (seller === null || wanted <= 0) return null;
    return {
      type: 'buy_accelerators',
      units: wanted,
      maxPricePerUnitUsd: Math.round(seller.unitPriceUsd * PRICE_CEILING_MARGIN),
      sellerCompanyId: seller.company.id,
    };
  }, [seller, wanted]);

  const preCheck = useMemo(() => (intent === null ? null : validateIntent(intent)), [intent, validateIntent]);
  const solvency = cashAfterOf(company, costUsd);

  // World 1 has no manufacturers and no `buy_accelerators`. Offering the control
  // and then explaining that it does nothing would be worse than not offering it.
  if (!isMultiSectorWorld(session)) return null;

  if (seller === null) {
    return (
      <EmptyState
        icon="building"
        title="Nobody is selling accelerators"
        message="No manufacturer has capacity to ship this quarter. Reserved capacity and on-demand cloud are still open."
      />
    );
  }

  const ownedAfter = company.compute.ownedAccelerators + wanted;
  const depreciationBefore = company.balanceSheet.assets.ppe * PPE_DEPRECIATION_PER_QUARTER;
  const depreciationAfter = (company.balanceSheet.assets.ppe + costUsd) * PPE_DEPRECIATION_PER_QUARTER;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading
        rule
        actions={<Tag tone="neutral">{`${formatCount(sellers.length)} sellers`}</Tag>}
      >
        Buy accelerators
      </SectionHeading>

      <label className="block">
        <span className="label-caps-faint">Seller</span>
        <select
          className="field tap-target mt-1 w-full"
          value={seller.company.id}
          onChange={(event) => {
            setSellerId(event.target.value);
            setUnits(0);
            setQueued(false);
          }}
        >
          {sellers.map((entry) => (
            <option key={entry.company.id} value={entry.company.id}>
              {`${entry.company.name} — ${formatMoney(entry.unitPriceUsd)} each, ${formatCount(entry.sellableUnits)} available`}
            </option>
          ))}
        </select>
      </label>

      <SliderField
        label="Accelerators"
        value={wanted}
        onChange={(next) => {
          setUnits(next);
          setQueued(false);
        }}
        min={0}
        max={seller.sellableUnits}
        step={roundStep(seller.sellableUnits)}
        format={(value) => formatCount(Math.round(value))}
        preview={(shown) => {
          const count = Math.min(Math.round(shown), seller.sellableUnits);
          const spend = count * seller.unitPriceUsd;
          return (
            <CashAfter
              company={company}
              spendUsd={spend}
              label="Cash"
              rows={[
                { key: 'cost', label: 'Cost now', now: formatMoney(0), after: formatMoney(spend), tone: spend > 0 ? 'loss' : undefined },
                { key: 'owned', label: 'Accelerators owned', now: formatCount(company.compute.ownedAccelerators), after: formatCount(company.compute.ownedAccelerators + count) },
                {
                  key: 'dep',
                  label: 'Depreciation a quarter',
                  now: formatMoney(depreciationBefore),
                  after: formatMoney((company.balanceSheet.assets.ppe + spend) * PPE_DEPRECIATION_PER_QUARTER),
                },
              ]}
              note="Owned capacity carries depreciation and energy instead of rent, and is immune to the spot price."
            />
          );
        }}
      />

      {preCheck === null ? (
        <p className="text-[13px] text-ink-faint sm:text-[11px]">Choose how many to buy to run the validator.</p>
      ) : (
        <ValidationBanner result={preCheck} compact />
      )}

      {queued ? (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[13px] leading-relaxed text-brand sm:text-[11px]">
          Queued for this quarter. Review it on End Quarter before you submit.
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary tap-target w-full sm:w-auto sm:self-start sm:min-h-0"
        disabled={intent === null}
        onClick={() => setPending(intent)}
      >
        Review purchase
      </button>

      <ConfirmDialog
        open={pending !== null}
        title={`Buy ${formatCount(wanted)} accelerators from ${seller.company.name}`}
        actionType="buy_accelerators"
        tone="brand"
        body="A capital commitment: the cash leaves this quarter and the capacity is yours from then on. If the seller's price has moved above your ceiling by the time the quarter resolves, the order fails rather than clearing."
        terms={[
          { label: 'Seller', value: seller.company.name },
          { label: 'Units', value: formatCount(wanted), emphasis: true },
          { label: 'Price each', value: formatMoney(seller.unitPriceUsd) },
          { label: 'Price ceiling', value: formatMoney(Math.round(seller.unitPriceUsd * PRICE_CEILING_MARGIN)) },
          { label: 'Cost now', value: formatMoney(costUsd), emphasis: true },
          { label: 'Owned after', value: formatCount(ownedAfter) },
          { label: 'Depreciation a quarter', value: formatMoney(depreciationAfter) },
          { label: 'Cash after', value: formatMoney(solvency.afterUsd), emphasis: solvency.afterUsd < 0 },
          ...(solvency.line === null ? [] : [{ label: 'Solvency', value: solvency.line, emphasis: true }]),
        ]}
        confirmLabel="Queue for this quarter"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) {
            queueAction(pending, { confirmed: true });
            setQueued(true);
          }
          setPending(null);
        }}
      />
    </div>
  );
}

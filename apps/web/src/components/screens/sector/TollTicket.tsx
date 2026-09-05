'use client';

/**
 * The freight toll dial — Plutocracy's Rockefeller squeeze, as one slider.
 *
 * A group that holds two fifths of a region's freight has earned the right to
 * charge everybody else for it, and its own companies ride free. The ceiling is
 * not this control's opinion: `maxTollForCompany` is the engine's own function,
 * the same one the validator clamps against, so the slider offers exactly the
 * range that would clear.
 *
 * Two things the study insists on are here and nowhere else:
 *
 * - **V5** — a now → after preview under the thumb, so the cost of the decision
 *   is a number before it is committed;
 * - **V8** — the antitrust points the toll is worth, printed on the confirm
 *   button. The figure comes from `antitrustExposure` itself rather than from a
 *   weight this file remembers.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult, Company, Region, SessionState } from '@frontier/contracts';
import { ANTITRUST_EXPOSURE_WEIGHTS, REGION_META, TOLL_MAX_PCT, antitrustExposure } from '@frontier/contracts';
import { maxTollForCompany, regionLogistics } from '@frontier/simulation';
import { formatMoney } from '@frontier/shared';
import { ConfirmDialog, EmptyState, Icon, NowAfter, SliderField, Tag, ValidationBanner, regionOf } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { exposureCostLabel } from './model';

export interface TollTicketProps {
  readonly session: SessionState;
  readonly company: Company;
}

/** Whole exposure points a toll of this size is worth, read off the engine's own weights. */
export function tollExposurePoints(tollPct: number): number {
  const { contributions } = antitrustExposure({
    exposure: 0,
    sectorShare: 0,
    inAccord: false,
    recentAcquisitions: 0,
    tollChargedPct: tollPct,
    predatoryQuarters: 0,
  });
  return contributions.find((entry) => entry.key === 'toll')?.points ?? 0;
}

export function TollTicket({ session, company }: TollTicketProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const region = regionOf(company) as Region;
  const [tollPct, setTollPct] = useState(() => Math.max(0, Math.round(company.logisticsTollPct ?? 0)));
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState<ActionValidationResult | null>(null);

  const ceiling = useMemo(() => maxTollForCompany(session, company, region), [session, company, region]);
  const here = useMemo(() => regionLogistics(session)[region], [session, region]);
  const current = Math.max(0, Math.round(company.logisticsTollPct ?? 0));

  const intent = useMemo<ActionIntent>(() => ({ type: 'set_logistics_toll', region, tollPct }), [region, tollPct]);
  const preCheck = useMemo(() => validateIntent(intent), [validateIntent, intent]);

  if (ceiling <= 0) {
    return (
      <EmptyState
        compact
        icon="network"
        title="Your group charges nothing here"
        message={`A toll starts at two fifths of a region's freight. Your group holds ${Math.round((here?.dominantControllerId === null ? 0 : here?.dominantShare ?? 0) * 100)}% of ${REGION_META[region].label}, so every rival buys its inputs at the market and so do you.`}
      />
    );
  }

  const points = tollExposurePoints(tollPct);
  const badge = exposureCostLabel(points);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="brand" dot>
          {REGION_META[region].label}
        </Tag>
        <Tag tone="neutral">ceiling {ceiling}% of {TOLL_MAX_PCT}%</Tag>
        <Tag tone="neutral">freight {formatMoney(here?.logisticsRevenueUsd ?? 0)} a year</Tag>
      </div>

      <SliderField
        label="Toll charged to rivals"
        value={tollPct}
        onChange={(next) => {
          setTollPct(Math.round(next));
          setQueued(null);
        }}
        min={0}
        max={Math.max(1, ceiling)}
        step={1}
        format={(value) => `${Math.round(value)}%`}
        exact={false}
        preview={(shown) => (
          <NowAfter
            rows={[
              { key: 'toll', label: 'Rivals pay on their inputs', now: `${current}%`, after: `${Math.round(shown)}%`, tone: 'gain' },
              { key: 'you', label: 'Your own group pays', now: '0%', after: '0%' },
              {
                key: 'exposure',
                label: 'Antitrust exposure from the toll',
                now: `+${tollExposurePoints(current)}`,
                after: `+${tollExposurePoints(Math.round(shown))}`,
                tone: 'loss',
              },
            ]}
            note={`A dial above your earned ceiling of ${ceiling}% is clamped, never refused. The exemption is the whole point: cheap inputs for you, dear inputs for them.`}
          />
        )}
      />

      <ValidationBanner result={preCheck} compact />

      {queued === null ? null : (
        <div className="rounded-card border border-brand/25 bg-brand-wash px-3 py-2 text-[13px] text-brand sm:text-[11px]">
          Queued for this quarter. The toll takes effect when the costs are recognised.
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto sm:self-start sm:min-h-0"
        onClick={() => setPending(intent)}
      >
        <Icon name="network" size={16} accent="current" />
        Review toll
        {badge === null ? null : <span className="figure rounded-pill bg-loss-wash px-1.5 text-[10px] text-loss">{badge}</span>}
      </button>

      <ConfirmDialog
        open={pending !== null}
        title={`Toll every rival in ${REGION_META[region].label}`}
        actionType="set_logistics_toll"
        tone="warn"
        body="A toll costs you nothing and costs everybody else in the region a share of their cash cost of goods. It is also the most visible thing a group can do to a market, and the regulator counts it."
        terms={[
          { label: 'Region', value: REGION_META[region].label },
          { label: 'Toll on rivals', value: `${tollPct}%`, emphasis: true },
          { label: 'Your group pays', value: 'nothing' },
          { label: 'Earned ceiling', value: `${ceiling}%` },
          { label: 'Antitrust exposure', value: badge ?? 'none', emphasis: points >= ANTITRUST_EXPOSURE_WEIGHTS.toll / 2 },
        ]}
        confirmLabel={badge === null ? 'Queue the toll' : `Queue the toll · ${badge}`}
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

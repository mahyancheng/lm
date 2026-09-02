'use client';

/**
 * One product, opened.
 *
 * Three things live here: the unit economics as the engine will read them, a
 * seat projection at today's rates, and the two tickets that change the
 * product — a reprice and a sunset. Both submit intents; the engine validates,
 * clamps and resolves, and the banner under each control says what it decided.
 *
 * The price preview uses the engine's own `priceFactor`, judged against the
 * published segment reference. The engine judges the same curve against the
 * live customer-weighted market mean, which moves every quarter and is not the
 * player's to see — so the preview is a shape, and the panel says so.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, EconomyReport, Product, SessionState } from '@frontier/contracts';
import { antitrustExposure, isPredatoryPrice, quarterLabel, rivalPressureFor, undercutFraction } from '@frontier/contracts';
import { SEGMENT_PRICE_ELASTICITY, SEGMENT_REFERENCE_PRICE_USD, priceFactor } from '@frontier/simulation';
import { formatCount, formatMoney, formatMultiple, formatPct } from '@frontier/shared';
import {
  DeltaBadge,
  Drawer,
  Icon,
  KeyValueGrid,
  LineChart,
  Meter,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  roundStep,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { predatorsInSegment } from '../sector/model';
import { achievableCeilingUsd, repriceCeilingUsd } from './ceiling';
import { PriceLadder } from './PriceLadder';
import {
  SEGMENT_BLURB,
  SEGMENT_LABEL,
  SEGMENT_UNIT,
  productGrossProfit,
  productRevenue,
  productServingUnits,
  projectCustomers,
} from './labels';

export interface ProductDrawerProps {
  readonly session: SessionState;
  readonly product: Product | null;
  readonly onClose: () => void;
  /** The quarter's committed attribution, already redacted to this seat. */
  readonly report?: EconomyReport | null;
  /** The company this product belongs to, so its own flags can be found. */
  readonly companyId?: string;
  /** Names for company ids, so a dumped price on the ladder has a name on it. */
  readonly companyNames?: ReadonlyMap<string, string>;
}

const PROJECTION_QUARTERS = 4;

export function ProductDrawer({
  session,
  product,
  onClose,
  report = null,
  companyId = '',
  companyNames,
}: ProductDrawerProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [priceText, setPriceText] = useState('');
  const [windDown, setWindDown] = useState(2);
  const [priceResult, setPriceResult] = useState<ActionValidationResult | null>(null);
  const [sunsetResult, setSunsetResult] = useState<ActionValidationResult | null>(null);

  const proposedPrice = Number.parseFloat(priceText);
  const hasPrice = product !== null && Number.isFinite(proposedPrice) && proposedPrice >= 0;

  const preview = useMemo(() => {
    if (product === null) return null;
    const reference = SEGMENT_REFERENCE_PRICE_USD[product.segment];
    const current = priceFactor(product.segment, product.pricePerSeat, reference);
    const next = hasPrice ? priceFactor(product.segment, proposedPrice, reference) : current;
    return { reference, current, next, change: current === 0 ? 0 : next / current - 1 };
  }, [product, hasPrice, proposedPrice]);

  const projection = useMemo(() => (product === null ? [] : projectCustomers(product, PROJECTION_QUARTERS)), [product]);

  /* --- V3: the price ladder -----------------------------------------------
     The ceiling is whichever binds first: the price at which the engine's own
     elasticity stops responding, or the top of the validator's one-quarter
     reprice band. Both are read from the engine; neither is invented here. */
  const ladder = useMemo(() => {
    if (product === null) return null;
    const reference = SEGMENT_REFERENCE_PRICE_USD[product.segment];
    const ceiling = Math.min(achievableCeilingUsd(product.segment, reference), repriceCeilingUsd(product.pricePerSeat));
    return {
      reference,
      ceiling,
      predators: predatorsInSegment(report, product.segment, companyId),
      pressure: rivalPressureFor(report, companyId, product.segment),
      own: report?.predation.find((row) => row.companyId === companyId && row.productId === product.id) ?? null,
    };
  }, [product, report, companyId]);

  // Four times the published reference or today's price, whichever is larger:
  // the whole range a defensible reprice lives in, with Exact beyond it.
  const repriceMax =
    product === null
      ? 10
      : Math.max(SEGMENT_REFERENCE_PRICE_USD[product.segment] * 4, product.pricePerSeat * 4, hasPrice ? proposedPrice : 0, 10);

  function applyPrice(): void {
    if (product === null || !hasPrice) return;
    const entry = queueAction({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: proposedPrice });
    setPriceResult(entry.validation);
  }

  function applySunset(): void {
    if (product === null) return;
    const entry = queueAction({ type: 'sunset_product', productId: product.id, windDownQuarters: windDown });
    setSunsetResult(entry.validation);
  }

  function close(): void {
    setPriceText('');
    setPriceResult(null);
    setSunsetResult(null);
    onClose();
  }

  const previewIntent =
    product !== null && hasPrice ? validateIntent({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: proposedPrice }) : null;

  /* --- V8: the risk on the risky verb -------------------------------------
     A cut deep enough to be predatory is worth antitrust points, and the
     player is told before they queue it rather than after the quarter
     resolves. Both tests are the engine's own functions; the margin used is
     this quarter's committed one, which is what the flag would be struck
     against if nothing else moved, and the copy says so. */
  const predation = useMemo(() => {
    if (product === null || !hasPrice || ladder === null) return null;
    const undercut = undercutFraction(proposedPrice, ladder.reference);
    if (!isPredatoryPrice(product.grossMarginPct, undercut)) return null;
    const { contributions } = antitrustExposure({
      exposure: 0,
      sectorShare: 0,
      inAccord: false,
      recentAcquisitions: 0,
      tollChargedPct: 0,
      // One quarter's worth: what the first quarter of standing at this price costs.
      predatoryQuarters: 1,
    });
    return { undercut, points: contributions.find((entry) => entry.key === 'predation')?.points ?? 0 };
  }, [product, hasPrice, proposedPrice, ladder]);

  return (
    <Drawer
      open={product !== null}
      onClose={close}
      title={product?.name ?? ''}
      subtitle={product === null ? undefined : `${SEGMENT_LABEL[product.segment]} · launched ${quarterLabel(session.startYear, product.launchedQuarter)}`}
      width={520}
    >
      {product === null ? null : (
        <div className="space-y-5">
          <div>
            <SectionHeading rule>Unit economics</SectionHeading>
            <div className="mt-2">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Quarterly revenue', value: formatMoney(productRevenue(product)) },
                  { label: 'Gross profit', value: formatMoney(productGrossProfit(product)), tone: 'gain' },
                  { label: 'List price', value: formatMoney(product.pricePerSeat, 'full'), hint: SEGMENT_UNIT[product.segment] },
                  { label: 'Active customers', value: product.activeCustomers.toString() },
                  {
                    label: 'Revenue per customer',
                    value: formatMoney(product.activeCustomers === 0 ? 0 : productRevenue(product) / product.activeCustomers, 'full'),
                  },
                  { label: 'Cost of serving', value: formatMoney(productRevenue(product) * (1 - product.grossMarginPct)) },
                  { label: 'Gross margin', value: formatPct(product.grossMarginPct) },
                  {
                    label: 'Serving compute',
                    value: `${formatCount(productServingUnits(session, product))} units`,
                    hint: `Compute intensity ${formatPct(product.computeIntensity)}`,
                  },
                ]}
              />
            </div>
          </div>

          <div>
            <SectionHeading rule>Position</SectionHeading>
            <div className="mt-2 space-y-3">
              <Meter value={product.qualityScore * 100} label="Quality against the market frontier" />
              <div className="grid grid-cols-2 gap-3">
                <div className="raised-surface px-3 py-2">
                  <div className="label-caps-faint">Gross additions</div>
                  <div className="figure text-[16px] text-ink">{formatPct(product.growthQuarterly)}</div>
                </div>
                <div className="raised-surface px-3 py-2">
                  <div className="label-caps-faint">Churn</div>
                  <div className="figure text-[16px] text-ink">{formatPct(product.churnQuarterly)}</div>
                </div>
              </div>
              <p className="text-[11px] text-ink-faint">{SEGMENT_BLURB[product.segment]}</p>
            </div>
          </div>

          {ladder === null ? null : (
            <div>
              <SectionHeading rule>Price against the market</SectionHeading>
              <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
                {formatMoney(product.pricePerSeat, 'full')} · segment average {formatMoney(ladder.reference, 'full')}.
                Above the dashed ceiling the elasticity model stops responding and only the churn shock is left, so a
                price walked past it buys nothing.
              </p>
              <div className="mt-2">
                <PriceLadder
                  yourPriceUsd={product.pricePerSeat}
                  referenceUsd={ladder.reference}
                  ceilingUsd={ladder.ceiling}
                  predators={ladder.predators}
                  companyNames={companyNames ?? new Map<string, string>()}
                  pressure={ladder.pressure}
                  ownPredation={ladder.own}
                />
              </div>
            </div>
          )}

          <div>
            <SectionHeading rule>Seat projection</SectionHeading>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              Four quarters at exactly today&apos;s gross additions and churn. A projection, not a forecast: the engine recomputes both rates every
              quarter from demand, price, quality, reputation and serving capacity.
            </p>
            <div className="mt-2">
              <LineChart
                series={[{ id: 'seats', label: 'Seats', values: projection, tone: 'brand', dashed: true }]}
                xLabels={projection.map((_, index) => quarterLabel(session.startYear, session.quarter + index))}
                height={140}
                formatValue={(value) => Math.round(value).toString()}
                showLegend={false}
              />
            </div>
          </div>

          <div>
            <SectionHeading rule>Reprice</SectionHeading>
            {/* The untouched slider sits at today's price; Queue stays
                disabled until it moves, exactly as the empty field did. */}
            <div className="mt-2">
              <SliderField
                label={`New price (${SEGMENT_UNIT[product.segment]})`}
                value={hasPrice ? proposedPrice : product.pricePerSeat}
                onChange={(next) => setPriceText(String(next))}
                min={0}
                max={repriceMax}
                step={roundStep(repriceMax)}
                format={formatMoney}
              />
              {predation === null ? null : (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 rounded-card bg-loss-wash px-2 py-1.5 text-[11px] leading-snug font-semibold text-loss">
                  <Icon name="warning" size={13} accent="current" />
                  Below cost and {formatPct(predation.undercut)} under the segment average — the engine would flag this as
                  predatory and every quarter it stands is worth
                  <span className="figure">+{predation.points} exposure</span>.
                </p>
              )}
              <button
                type="button"
                className="btn btn-primary tap-target mt-2 w-full gap-1.5 sm:w-auto"
                disabled={!hasPrice}
                onClick={applyPrice}
              >
                <Icon name="check" size={16} accent="current" />
                Queue reprice
                {predation === null ? null : (
                  <span className="figure rounded-pill bg-loss-wash px-1.5 text-[10px] text-loss">+{predation.points} exposure</span>
                )}
              </button>
            </div>

            {preview === null ? null : (
              <div className="raised-surface mt-2.5 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="label-caps-faint">Demand multiplier</span>
                  <span className="figure flex items-center gap-1.5 text-[13px] text-ink">
                    {formatMultiple(preview.current)}
                    {hasPrice ? (
                      <span className="text-ink-faint">
                        <Icon name="chevronRight" size={12} accent="current" />
                      </span>
                    ) : null}
                    {hasPrice ? formatMultiple(preview.next) : null}
                  </span>
                </div>
                {hasPrice ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <DeltaBadge value={preview.change} format="percent" />
                    <span className="text-[11px] text-ink-dim">change to gross additions from price alone</span>
                  </div>
                ) : null}
                <p className="mt-2 text-[10px] text-ink-faint">
                  Segment elasticity {formatPct(SEGMENT_PRICE_ELASTICITY[product.segment])} against a published reference of{' '}
                  {formatMoney(preview.reference, 'full')}. The engine judges price against the live customer-weighted market mean, which moves each
                  quarter and is not yours to see.
                </p>
              </div>
            )}

            {previewIntent !== null && priceResult === null ? (
              <div className="mt-2">
                <ValidationBanner result={previewIntent} compact />
              </div>
            ) : null}
            {priceResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={priceResult} />
              </div>
            )}
          </div>

          <div>
            <SectionHeading rule>Sunset</SectionHeading>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              A shorter wind-down saves cost and damages enterprise and developer reputation. Sunset products keep their history for comparatives.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="w-full min-w-0 sm:flex-1">
                <span className="label-caps-faint mb-1 block">Wind-down</span>
                <select className="field tap-target" value={windDown} onChange={(event) => setWindDown(Number(event.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map((quarters) => (
                    <option key={quarters} value={quarters}>
                      {quarters} quarter{quarters === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-danger tap-target w-full gap-1.5 sm:w-auto"
                disabled={!product.isActive}
                onClick={applySunset}
              >
                <Icon name="warning" size={16} accent="current" />
                Queue sunset
              </button>
            </div>
            {sunsetResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={sunsetResult} />
              </div>
            )}
            {product.isActive ? null : (
              <div className="mt-2">
                <Tag tone="warn">Already sunset</Tag>
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

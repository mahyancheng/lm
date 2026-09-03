'use client';

/**
 * One product, opened.
 *
 * Three things live here: the unit economics as the engine will read them, a
 * seat projection at today's rates, and the two tickets that change the
 * product — a reprice and a sunset. Both submit intents; the engine validates
 * and resolves, and the banner under each control says what it decided.
 *
 * The price preview is the engine's own `repriceForecast`: customers, revenue
 * and margin before and after, run through the same demand model and the same
 * capacity rationing the quarter itself will use — never a clamp ceiling or
 * floor. From world version 2 there is no band a price may not cross; the
 * forecast is what tells a founder what a price actually buys instead.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionValidationResult, EconomyReport, Product, SessionState, SupplyTerms } from '@frontier/contracts';
import { antitrustExposure, isPredatoryPrice, quarterLabel, rivalPressureFor, undercutFraction } from '@frontier/contracts';
import {
  SEGMENT_REFERENCE_PRICE_USD,
  categoryOf,
  customersFor,
  dependenceOn,
  isMultiSectorWorld,
  repriceForecast,
  resolveSupplyLedger,
  resolveSupplyLine,
} from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
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
import { useActiveCompany, useGameActions } from '@/lib/game';
import { predatorsInSegment } from '../sector/model';
import { achievableCeilingUsd } from './ceiling';
import { builtOnRows } from './launchFlow';
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
  const company = useActiveCompany();
  const [priceText, setPriceText] = useState('');
  const [windDown, setWindDown] = useState(2);
  const [priceResult, setPriceResult] = useState<ActionValidationResult | null>(null);
  const [sunsetResult, setSunsetResult] = useState<ActionValidationResult | null>(null);
  const [supplyResults, setSupplyResults] = useState<Readonly<Record<string, ActionValidationResult | null>>>({});
  const [publishOpenToAll, setPublishOpenToAll] = useState(true);
  const [publishPrice, setPublishPrice] = useState('');
  const [publishResult, setPublishResult] = useState<ActionValidationResult | null>(null);

  const proposedPrice = Number.parseFloat(priceText);
  const hasPrice = product !== null && Number.isFinite(proposedPrice) && proposedPrice >= 0;

  // The engine's own forecast: customers, revenue and margin the candidate
  // price is expected to produce, run through the identical demand model and
  // capacity rationing the quarter itself uses. Falls back to today's price
  // when the field is empty, so the panel always has something to show.
  const preview = useMemo(() => {
    if (product === null) return null;
    return repriceForecast(session, companyId, product.id, hasPrice ? proposedPrice : product.pricePerSeat);
  }, [session, companyId, product, hasPrice, proposedPrice]);

  const projection = useMemo(() => (product === null ? [] : projectCustomers(product, PROJECTION_QUARTERS)), [product]);

  /* --- V3: the price ladder -------------------------------------------------
     The ceiling is where the engine's own forecast revenue peaks — guidance,
     never enforced. From world version 2 there is no validator band to draw a
     second ceiling from. */
  const ladder = useMemo(() => {
    if (product === null) return null;
    const reference = SEGMENT_REFERENCE_PRICE_USD[product.segment];
    const ceiling = achievableCeilingUsd(session, companyId, product.id, reference, product.pricePerSeat);
    return {
      reference,
      ceiling,
      predators: predatorsInSegment(report, product.segment, companyId),
      pressure: rivalPressureFor(report, companyId, product.segment),
      own: report?.predation.find((row) => row.companyId === companyId && row.productId === product.id) ?? null,
    };
  }, [session, product, report, companyId]);

  /* --- V37: the supply chain -------------------------------------------------
     Everything below reads real engine state — `categoryOf`, `resolveSupplyLine`,
     `resolveSupplyLedger`, `customersFor` — the same functions the Chief of
     Staff's `suppliers`/`customers` lookups and the launch flow's "Built on"
     step read. Nothing here is a modelled price; a row is either a real
     published line or the open market. Only rendered for the player's own
     company — a redacted rival never carries enough to compute this. */
  const isOwnCompany = company.id === companyId;
  const category = useMemo(() => (product === null || !isOwnCompany ? null : categoryOf(company, product)), [company, product, isOwnCompany]);
  const inputRows = useMemo(() => (product === null || category === null ? [] : builtOnRows(session, company, category)), [session, company, category, product]);
  const supplyLedger = useMemo(() => (isMultiSectorWorld(session) ? resolveSupplyLedger(session) : []), [session]);
  const costOfInput = (inputCategoryId: string): number => {
    if (product === null) return 0;
    const entry = supplyLedger.find(
      (row) => row.buyerCompany.id === companyId && row.buyerProduct.id === product.id && row.inputCategoryId === inputCategoryId,
    );
    return entry?.costUsd ?? 0;
  };
  const resolvedInputs = useMemo(() => {
    if (product === null || category === null) return [];
    return category.inputs.map((input) => ({ input, resolved: resolveSupplyLine(session, company, product, input) }));
  }, [session, company, product, category]);

  const customers = useMemo(
    () => (product === null || category === null || !category.canSupply ? [] : customersFor(session, companyId, product.id)),
    [session, product, category, companyId],
  );

  // The publish form starts from whatever this line already has terms for
  // (or the category's reference price, for a first publish), and resets
  // whenever the drawer opens on a different product.
  useEffect(() => {
    if (product === null || category === null) return;
    setPublishOpenToAll(product.supplyTerms?.openToAll ?? true);
    setPublishPrice(String(Math.round(product.supplyTerms?.pricePerUnitUsd ?? category.referencePriceUsd)));
    setPublishResult(null);
  }, [product?.id, category]);

  function switchSupplier(inputCategoryId: string, supplierCompanyId: string | null, supplierProductId: string | null): void {
    if (product === null) return;
    const entry = queueAction({ type: 'choose_supplier', productId: product.id, inputCategoryId, supplierCompanyId, supplierProductId });
    setSupplyResults((current) => ({ ...current, [inputCategoryId]: entry.validation }));
  }

  function submitSupplyTerms(closeToAll: boolean): void {
    if (product === null) return;
    const priceValue = Number.parseFloat(publishPrice);
    if (!Number.isFinite(priceValue) || priceValue < 0) return;
    const terms: SupplyTerms = {
      openToAll: closeToAll ? false : publishOpenToAll,
      pricePerUnitUsd: priceValue,
      exclusiveCustomerIds: closeToAll ? [] : (product.supplyTerms?.exclusiveCustomerIds ?? []),
      blockedCustomerIds: product.supplyTerms?.blockedCustomerIds ?? [],
    };
    const entry = queueAction({ type: 'set_supply_terms', productId: product.id, terms });
    setPublishResult(entry.validation);
  }

  // Ten times the published reference or today's price, whichever is larger —
  // a wide, permissive range. Nothing bounds a reprice from world version 2;
  // this is generous headroom for the slider, not a ceiling.
  const repriceMax =
    product === null
      ? 10
      : Math.max(SEGMENT_REFERENCE_PRICE_USD[product.segment] * 10, product.pricePerSeat * 10, hasPrice ? proposedPrice : 0, 10);

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
    setSupplyResults({});
    setPublishResult(null);
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

          {resolvedInputs.length === 0 ? null : (
            <div>
              <SectionHeading rule>Built on</SectionHeading>
              <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
                What {product.name} is assembled from. Left on the open market an input costs nothing beyond this line&apos;s own margin; naming a
                supplier lets their quality and price flow through, one quarter of degraded quality while a switch beds in.
              </p>
              <div className="mt-2 space-y-2.5">
                {resolvedInputs.map(({ input, resolved }) => {
                  const row = inputRows.find((entry) => entry.input.categoryId === input.categoryId);
                  const costUsd = costOfInput(input.categoryId);
                  const currentKey = resolved.status === 'supplied' ? `${resolved.supplierCompany?.id ?? ''}|${resolved.supplierProduct?.id ?? ''}` : 'open';
                  return (
                    <div key={input.categoryId} className="raised-surface px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[12px] font-semibold text-ink">{row?.category?.label ?? input.categoryId.replace(/_/g, ' ')}</span>
                        <Tag tone={input.required ? 'warn' : 'neutral'}>{input.required ? 'Required' : 'Optional'}</Tag>
                      </div>
                      <p className="mt-1 text-[11px] text-ink-dim">
                        {resolved.status === 'supplied' && resolved.supplierCompany !== null && resolved.supplierProduct !== null
                          ? `Built on ${resolved.supplierCompany.name} — ${resolved.supplierProduct.name}, ${formatMoney(costUsd)} this quarter`
                          : resolved.status === 'unsupplied'
                            ? 'Unsupplied — a deliberate choice, and this line ships zero units until it is filled'
                            : 'Open market — no named counterparty'}
                      </p>
                      {resolved.status === 'supplied' && resolved.supplierCompany !== null ? (
                        <p className="mt-0.5 text-[10px] text-ink-faint">
                          {formatPct(dependenceOn(session, company, resolved.supplierCompany.id))} of {company.name}&apos;s revenue rides on{' '}
                          {resolved.supplierCompany.name} across every line.
                        </p>
                      ) : null}
                      {row === undefined || row.options.length <= 1 ? null : (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {row.options.map((option) => {
                            const key = option.supplierCompanyId === null ? 'open' : `${option.supplierCompanyId}|${option.supplierProductId ?? ''}`;
                            const active = key === currentKey;
                            return (
                              <button
                                key={key}
                                type="button"
                                disabled={active}
                                onClick={() => switchSupplier(input.categoryId, option.supplierCompanyId, option.supplierProductId)}
                                className={`tap-target rounded-chip border px-2 py-1 text-[10.5px] transition-colors ${
                                  active ? 'border-brand bg-brand-wash text-brand' : 'border-hair bg-panel text-ink-dim hover:text-ink'
                                }`}
                              >
                                {option.label}
                                {option.offer !== null ? ` · ${formatMoney(option.offer.pricePerUnitUsd, 'full')}` : ''}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {supplyResults[input.categoryId] == null ? null : (
                        <div className="mt-2">
                          <ValidationBanner result={supplyResults[input.categoryId] as ActionValidationResult} compact />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {category === null || !category.canSupply ? null : (
            <div>
              <SectionHeading rule>Publish as an input</SectionHeading>
              <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
                {product.supplyTerms == null
                  ? `${product.name} is not published — nobody else can build on it. Publishing an API is a real decision: the owner's own words.`
                  : `Published ${product.supplyTerms.openToAll ? 'open to all' : 'on private terms'} at ${formatMoney(product.supplyTerms.pricePerUnitUsd, 'full')} a ${category.unitLabel}.`}
              </p>
              <div className="mt-2 space-y-2.5">
                <SliderField
                  label={`Price per ${category.unitLabel}`}
                  value={Math.max(0, Number.parseFloat(publishPrice) || 0)}
                  onChange={(next) => setPublishPrice(String(next))}
                  min={0}
                  max={Math.max(category.referencePriceUsd * 4, Number.parseFloat(publishPrice) || 0, 10)}
                  step={roundStep(category.referencePriceUsd * 4)}
                  format={formatMoney}
                />
                <label className="flex items-center gap-2 text-[11.5px] text-ink-dim">
                  <input type="checkbox" checked={publishOpenToAll} onChange={(event) => setPublishOpenToAll(event.target.checked)} className="tap-target" />
                  Open to any company — a public API. Unchecked keeps it to whoever already builds on it.
                </label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={() => submitSupplyTerms(false)}>
                    <Icon name="check" size={16} accent="current" />
                    {product.supplyTerms == null ? 'Publish' : 'Update terms'}
                  </button>
                  {product.supplyTerms == null ? null : (
                    <button type="button" className="btn btn-danger tap-target gap-1.5" onClick={() => submitSupplyTerms(true)}>
                      <Icon name="warning" size={16} accent="current" />
                      Close to everyone
                    </button>
                  )}
                </div>
                {publishResult === null ? null : <ValidationBanner result={publishResult} />}
              </div>

              {customers.length === 0 ? (
                <p className="mt-2.5 text-[10.5px] text-ink-faint">Nobody is currently building on this line.</p>
              ) : (
                <div className="mt-2.5 space-y-1.5">
                  <div className="label-caps-faint">Building on this ({customers.length})</div>
                  {customers.map((row) => (
                    <div key={`${row.buyerCompany.id}_${row.buyerProduct.id}`} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-ink-dim">
                        {row.buyerCompany.name} — {row.buyerProduct.name}
                      </span>
                      <span className="figure shrink-0 text-ink">
                        {formatMoney(row.revenueUsd)} · {formatCount(row.unitsFilled)}u
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
                <div className="label-caps-faint">Next quarter, forecast</div>
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Customers', value: formatCount(preview.customersAfter), hint: `now ${formatCount(preview.customersNow)}` },
                    { label: 'Revenue', value: formatMoney(preview.revenueAfterUsd), hint: `now ${formatMoney(preview.revenueNowUsd)}` },
                    {
                      label: 'Gross margin',
                      value: formatPct(preview.marginAfterPct),
                      tone: preview.marginAfterPct < 0 ? 'loss' : undefined,
                      hint: `now ${formatPct(preview.marginNowPct)}`,
                    },
                    { label: 'Churn that quarter', value: formatPct(preview.churnAfter) },
                  ]}
                />
                {hasPrice ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <DeltaBadge
                      value={preview.customersNow === 0 ? 0 : preview.customersAfter / preview.customersNow - 1}
                      format="percent"
                    />
                    <span className="text-[11px] text-ink-dim">change to customers from the price move alone</span>
                  </div>
                ) : null}
                {preview.capacityConstrained ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[10px] text-warn">
                    <Icon name="warning" size={12} accent="current" className="mt-px shrink-0" />
                    Serving capacity, not demand, is what limits the forecast — more compute would grow this further.
                  </p>
                ) : null}
                <p className="mt-2 text-[10px] text-ink-faint">
                  The engine&apos;s own demand model, run at this price with today&apos;s marketing and no rival pressure — a forecast, not a promise. It judges
                  price against the live customer-weighted market mean, which moves each quarter and is not yours to see.
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

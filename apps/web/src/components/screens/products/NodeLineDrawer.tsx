'use client';

/**
 * One world-3 line, opened.
 *
 * Four things this drawer does that world 2's could not.
 *
 * 1. **It uses the node's own unit.** Every figure on it is quoted per
 *    `node.unitLabel` — "per wafer", "per MWh", "per rack". World 2 labelled
 *    every line "per seat / quarter", batteries and megawatt-hours included,
 *    because the label came from the buyer segment rather than from the thing
 *    being sold.
 * 2. **It draws the price against the node's own market price.** Not
 *    `SEGMENT_REFERENCE_PRICE_USD` — the customer-weighted mean price of every
 *    product in the buyer's segment across all six sectors, which is why a
 *    wafer fab priced at its own reference used to lose most of its gross
 *    additions.
 * 3. **It reports what the sale kind actually produces.** Backlog and installed
 *    base for a unit line, deferred revenue and remaining term for a contract,
 *    customers for a recurring one. Three sale kinds, three sets of numbers.
 * 4. **It carries the data policy**, with its trade stated: what aggressive
 *    collection buys in data and costs in churn and reputation, in the
 *    engine's own constants rather than in adjectives.
 *
 * The unit economics and the input routes come from the engine — `unitCostOf`,
 * `costBreakdown`, `inputOptions` — so the margin here is the margin the
 * profit and loss books.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionValidationResult, DataCollectionLevel, EconomyReport, Product, SessionState } from '@frontier/contracts';
import { DATA_COLLECTION_LEVELS, economicNodeById, nodeMarketPriceUsd, quarterLabel, rivalPressureFor } from '@frontier/contracts';
import {
  DATA_POLICY_CHURN,
  DATA_POLICY_REPUTATION,
  biggestCostSentence,
  costBreakdown,
  dataPetabytesOf,
  dataPolicyOf,
  inputOptions,
  lineNodeIdOf,
  repriceForecast,
  totalDataPetabytes,
  unitCostOf,
  type InputRoute,
} from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import {
  Drawer,
  Icon,
  KeyValueGrid,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  roundStep,
} from '@/components/ui';
import { useActiveCompany, useGameActions } from '@/lib/game';
import { predatorsInSegment } from '../sector/model';
import { achievableCeilingUsd } from './ceiling';
import { PriceLadder } from './PriceLadder';
import { priceSentence } from './nodeLaunch';

export interface NodeLineDrawerProps {
  readonly session: SessionState;
  readonly product: Product | null;
  readonly onClose: () => void;
  readonly report?: EconomyReport | null;
  readonly companyId?: string;
  readonly companyNames?: ReadonlyMap<string, string>;
}

/** What each collection level buys and costs, in the engine's own numbers. */
const POLICY_LABEL: Readonly<Record<DataCollectionLevel, string>> = {
  minimal: 'Minimal',
  standard: 'Standard',
  aggressive: 'Aggressive',
};

export function NodeLineDrawer({
  session,
  product,
  onClose,
  report = null,
  companyId = '',
  companyNames,
}: NodeLineDrawerProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const company = useActiveCompany();
  const [priceText, setPriceText] = useState('');
  const [windDown, setWindDown] = useState(2);
  const [priceResult, setPriceResult] = useState<ActionValidationResult | null>(null);
  const [sunsetResult, setSunsetResult] = useState<ActionValidationResult | null>(null);
  const [policyResult, setPolicyResult] = useState<ActionValidationResult | null>(null);
  const [supplyResults, setSupplyResults] = useState<Readonly<Record<string, ActionValidationResult | null>>>({});

  const nodeId = product === null ? null : lineNodeIdOf(product);
  const node = nodeId === null ? undefined : economicNodeById(nodeId);
  const isOwnCompany = company.id === companyId;

  const proposed = Number.parseFloat(priceText);
  const hasPrice = product !== null && Number.isFinite(proposed) && proposed >= 0;
  const priceUsd = hasPrice ? proposed : (product?.pricePerSeat ?? 0);

  const cost = useMemo(
    () => (nodeId === null || !isOwnCompany ? null : unitCostOf(session, company, nodeId)),
    [session, company, nodeId, isOwnCompany],
  );
  const rows = useMemo(() => (cost === null ? [] : costBreakdown(cost)), [cost]);
  const inputs = useMemo(
    () => (nodeId === null || product === null || !isOwnCompany ? [] : inputOptions(session, company, nodeId, product.id)),
    [session, company, nodeId, product, isOwnCompany],
  );

  const marketPriceUsd = nodeId === null ? 0 : nodeMarketPriceUsd(session, nodeId);
  const unitLabel = node?.unitLabel ?? 'unit';
  const saleKind = node?.saleKind ?? 'recurring';

  const preview = useMemo(
    () => (product === null ? null : repriceForecast(session, companyId, product.id, priceUsd)),
    [session, companyId, product, priceUsd],
  );

  /* --- the ladder, drawn against the node's own market price -------------- */
  const ladder = useMemo(() => {
    if (product === null || nodeId === null) return null;
    const ceiling = achievableCeilingUsd(session, companyId, product.id, marketPriceUsd, product.pricePerSeat);
    return {
      reference: marketPriceUsd,
      ceiling,
      predators: predatorsInSegment(report, product.segment, companyId),
      pressure: rivalPressureFor(report, companyId, product.segment),
      own: report?.predation.find((row) => row.companyId === companyId && row.productId === product.id) ?? null,
    };
  }, [session, product, nodeId, marketPriceUsd, report, companyId]);

  useEffect(() => {
    setPriceText('');
    setPriceResult(null);
    setSunsetResult(null);
    setPolicyResult(null);
    setSupplyResults({});
  }, [product?.id]);

  function applyPrice(): void {
    if (product === null || !hasPrice) return;
    setPriceResult(queueAction({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: proposed }).validation);
  }

  function applySunset(): void {
    if (product === null) return;
    setSunsetResult(queueAction({ type: 'sunset_product', productId: product.id, windDownQuarters: windDown }).validation);
  }

  function applyPolicy(level: DataCollectionLevel): void {
    setPolicyResult(queueAction({ type: 'set_data_policy', collectionLevel: level }).validation);
  }

  function switchSupplier(inputNodeId: string, route: InputRoute): void {
    if (product === null) return;
    const entry = queueAction({
      type: 'choose_supplier',
      productId: product.id,
      inputCategoryId: inputNodeId,
      supplierCompanyId: route.kind === 'buy' ? route.supplierCompanyId : null,
      supplierProductId: route.kind === 'buy' ? route.supplierProductId : null,
    });
    setSupplyResults((current) => ({ ...current, [inputNodeId]: entry.validation }));
  }

  const policy = dataPolicyOf(company);
  const sectorData = node === undefined ? 0 : dataPetabytesOf(company, node.sector);

  return (
    <Drawer
      open={product !== null}
      onClose={onClose}
      title={product?.name ?? ''}
      subtitle={
        product === null || node === undefined
          ? undefined
          : `${node.label} · per ${unitLabel} · launched ${quarterLabel(session.startYear, product.launchedQuarter)}`
      }
      width={520}
    >
      {product === null || node === undefined ? null : (
        <div className="space-y-5">
          {/* --- unit economics, in the node's own unit --------------------- */}
          <div>
            <SectionHeading rule>Unit economics</SectionHeading>
            <div className="mt-2">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Price', value: formatMoney(product.pricePerSeat, 'full'), hint: `per ${unitLabel}` },
                  {
                    label: 'Unit cost',
                    value: cost === null ? '—' : formatMoney(cost.unitCostUsd, 'full'),
                    hint: `per ${unitLabel}`,
                  },
                  { label: 'Gross margin', value: formatPct(product.grossMarginPct) },
                  { label: 'Market price', value: formatMoney(marketPriceUsd, 'full'), hint: `per ${unitLabel}` },
                  {
                    label: 'Units sold',
                    value: formatCount(product.unitsSoldQuarterly ?? product.activeCustomers),
                    hint: 'last quarter',
                  },
                  { label: 'Quarterly revenue', value: formatMoney(product.pricePerSeat * (product.unitsSoldQuarterly ?? product.activeCustomers)) },
                ]}
              />
            </div>
          </div>

          {/* --- what the sale kind actually produces ----------------------- */}
          <div>
            <SectionHeading rule>{saleKind === 'unit' ? 'Orders and fleet' : saleKind === 'contract' ? 'Contract book' : 'Subscribers'}</SectionHeading>
            <div className="mt-2">
              {saleKind === 'unit' ? (
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Backlog', value: `${formatCount(product.backlogUnits ?? 0)} ${unitLabel}`, hint: 'ordered, not yet shipped' },
                    {
                      label: 'Installed base',
                      value: `${formatCount(product.installedBase ?? 0)} ${unitLabel}`,
                      hint: `retires over ${node.lifetimeQuarters ?? 12} quarters`,
                    },
                  ]}
                />
              ) : saleKind === 'contract' ? (
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Billed in advance', value: formatMoney(product.contractBilledUsd ?? 0), hint: 'held as deferred revenue' },
                    {
                      label: 'Term remaining',
                      value: `${Math.round(product.contractRemainingQuarters ?? node.contractQuarters ?? 0)} quarters`,
                    },
                  ]}
                />
              ) : (
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Active customers', value: formatCount(product.activeCustomers) },
                    { label: 'Churn', value: formatPct(product.churnQuarterly), hint: 'each quarter' },
                  ]}
                />
              )}
            </div>
          </div>

          {/* --- what it costs to make ------------------------------------- */}
          {cost === null ? null : (
            <div>
              <SectionHeading rule>What it costs to make</SectionHeading>
              {(() => {
                const sentence = biggestCostSentence(cost, rows, companyNames ?? new Map(), (value) => formatMoney(value, 'full'));
                return sentence === '' ? null : <p className="mt-1.5 text-[11.5px] leading-snug text-ink-dim">{sentence}</p>;
              })()}
              <ul className="mt-2 divide-y divide-hairline">
                {rows.map((row) => (
                  <li key={row.key} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{row.label}</span>
                    <span className="figure w-10 shrink-0 text-right text-[10.5px] text-ink-faint">{row.sharePct}%</span>
                    <span className="figure w-24 shrink-0 text-right text-[12px] text-ink">{formatMoney(row.amountUsd, 'full')}</span>
                  </li>
                ))}
              </ul>
              {cost.blockedInputNodeIds.length === 0 ? null : (
                <p className="mt-2 rounded-card bg-loss-wash px-3 py-2 text-[11px] leading-snug font-semibold text-loss">
                  {cost.blockedInputNodeIds.map((id) => economicNodeById(id)?.label ?? id).join(', ')}: nobody in the world
                  owns this, so the line ships nothing until somebody does.
                </p>
              )}
            </div>
          )}

          {/* --- the wires -------------------------------------------------- */}
          {inputs.length === 0 ? null : (
            <div>
              <SectionHeading rule>Wired inputs</SectionHeading>
              <div className="mt-2 space-y-2.5">
                {inputs.map((option) => (
                  <div key={option.inputNodeId} className="rounded-card border border-hairline px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink">
                        {option.label}
                        {option.substitutable ? null : <span className="ml-1 font-bold text-loss">*</span>}
                      </span>
                      <span className="figure text-[10.5px] text-ink-faint">
                        {option.qtyPerUnit} per {unitLabel}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {option.routes.map((route) => (
                        <button
                          key={`${route.kind}:${route.supplierCompanyId ?? 'market'}`}
                          type="button"
                          disabled={route.kind === 'make'}
                          onClick={() => switchSupplier(option.inputNodeId, route)}
                          className={`min-h-11 rounded-pill border px-2.5 text-[11px] ${
                            route.chosen ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                          }`}
                        >
                          {route.label} · {formatMoney(route.unitPriceUsd, 'full')}
                        </button>
                      ))}
                    </div>
                    {supplyResults[option.inputNodeId] == null ? null : (
                      <div className="mt-1.5">
                        <ValidationBanner result={supplyResults[option.inputNodeId]!} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* --- price, against this node's market ------------------------- */}
          <div>
            <SectionHeading rule>Price</SectionHeading>
            {ladder === null ? null : (
              <div className="mt-2">
                <PriceLadder
                  yourPriceUsd={product.pricePerSeat}
                  referenceUsd={ladder.reference}
                  ceilingUsd={ladder.ceiling}
                  predators={ladder.predators}
                  companyNames={companyNames ?? new Map()}
                  pressure={ladder.pressure}
                  ownPredation={ladder.own}
                />
              </div>
            )}
            <div className="mt-3">
              <SliderField
                label={`New price (per ${unitLabel})`}
                value={priceUsd}
                min={0}
                max={Math.max(marketPriceUsd * 4, priceUsd, 10)}
                step={roundStep(Math.max(marketPriceUsd * 4, 10))}
                onChange={(value) => setPriceText(String(Math.round(value)))}
                format={(value) => formatMoney(value, 'full')}
              />
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">
              {priceSentence(priceUsd, marketPriceUsd, cost?.unitCostUsd ?? 0, (value) => formatMoney(value, 'full'))}
            </p>
            {preview === null ? null : (
              <p className="mt-1 text-[10.5px] text-ink-faint">
                The engine&apos;s own forecast at this price: {formatCount(preview.customersAfter)} {unitLabel}s,{' '}
                {formatMoney(preview.revenueAfterUsd)} of revenue.
              </p>
            )}
            <button type="button" className="btn btn-primary mt-2 min-h-11" disabled={!hasPrice} onClick={applyPrice}>
              Queue the reprice
            </button>
            {priceResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={priceResult} />
              </div>
            )}
          </div>

          {/* --- data ------------------------------------------------------- */}
          <div>
            <SectionHeading rule>Customer data</SectionHeading>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              What this line learns from the people using it. Data improves quality and feeds any line that consumes a
              dataset; collecting more of it costs churn and reputation, and it is custodied at a real cost every quarter.
            </p>
            <div className="mt-2">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: `${node.sector} data`, value: `${formatCount(sectorData)} PB` },
                  { label: 'All sectors', value: `${formatCount(totalDataPetabytes(company))} PB` },
                ]}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DATA_COLLECTION_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => applyPolicy(level)}
                  className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                    level === policy ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                  }`}
                >
                  {POLICY_LABEL[level]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-ink-faint">
              {POLICY_LABEL[policy]}: churn {DATA_POLICY_CHURN[policy] === 0 ? 'unchanged' : `${DATA_POLICY_CHURN[policy] > 0 ? '+' : ''}${Math.round(DATA_POLICY_CHURN[policy] * 1000) / 10} points`}
              , reputation {DATA_POLICY_REPUTATION[policy] === 0 ? 'unchanged' : `${DATA_POLICY_REPUTATION[policy] > 0 ? '+' : ''}${DATA_POLICY_REPUTATION[policy]}`} a quarter.
            </p>
            {policyResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={policyResult} />
              </div>
            )}
          </div>

          {/* --- sunset ----------------------------------------------------- */}
          <div>
            <SectionHeading rule>Close the line</SectionHeading>
            <div className="mt-2">
              <SliderField label="Wind-down quarters" value={windDown} min={0} max={8} step={1} onChange={setWindDown} format={(value) => `${value}`} />
            </div>
            <button type="button" className="btn mt-2 min-h-11" onClick={applySunset}>
              <Icon name="warning" size={14} accent="current" /> Queue the sunset
            </button>
            {sunsetResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={sunsetResult} />
              </div>
            )}
          </div>

          {product.isActive ? null : <Tag tone="neutral">Winding down</Tag>}
        </div>
      )}
    </Drawer>
  );
}

'use client';

/**
 * One world-3 line, opened.
 *
 * What this drawer does that world 2's could not.
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
 * 3. **The composition is on it.** One row per slot — which model, which
 *    harness, from whom — and tapping a row opens the same candidate sheet the
 *    launch flow uses; a choice queues `fill_slot`. Making an input yourself is
 *    offered beside buying it, never disabled: declining MAKE is a decision.
 * 4. **It aims the line.** Customer type and industry, with the cell's weight
 *    in words; a change queues `set_target_market`.
 * 5. **It publishes.** "Sell this to other companies": open to all or not, a
 *    price, the companies cut off, and who already builds on it. A public API
 *    in the owner's words is `openToAll: true` on a node line.
 * 6. **It reports what the sale kind actually produces**, and carries the data
 *    policy with its trade stated in the engine's own constants.
 *
 * The unit economics and every route come from the engine — `unitCostOf`,
 * `slotOptions`, `nodeMapFor` — so the margin here is the margin the profit
 * and loss books and the relationships shown are the ones the projection holds.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionValidationResult, DataCollectionLevel, EconomyReport, Product, SessionState, SupplyTerms } from '@frontier/contracts';
import { DATA_COLLECTION_LEVELS, economicNodeById, nodeMarketPriceUsd, quarterLabel, rivalPressureFor } from '@frontier/contracts';
import {
  DATA_POLICY_CHURN,
  DATA_POLICY_REPUTATION,
  biggestCostSentence,
  costBreakdown,
  dataPetabytesOf,
  dataPolicyOf,
  defaultIndustryFor,
  describeLine,
  lineNodeIdOf,
  nodeMapFor,
  repriceForecast,
  sellerPriceFactor,
  slotOptions,
  totalDataPetabytes,
  unitCostOf,
} from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { Drawer, Icon, KeyValueGrid, SectionHeading, SliderField, Tag, ValidationBanner, roundStep, sectorLabel } from '@/components/ui';
import { useActiveCompany, useGameActions } from '@/lib/game';
import { predatorsInSegment } from '../sector/model';
import { achievableCeilingUsd } from './ceiling';
import { PriceLadder } from './PriceLadder';
import {
  CUSTOMER_CHIP,
  choiceOfFill,
  costRowsBySlot,
  customerChoices,
  fillSummary,
  industryChoices,
  priceSentence,
  roleCaption,
  targetSentence,
  type SlotChoice,
  type TargetChoice,
} from './nodeLaunch';
import { SlotCandidateSheet } from './SlotCandidateSheet';

export interface NodeLineDrawerProps {
  readonly session: SessionState;
  readonly product: Product | null;
  readonly onClose: () => void;
  readonly report?: EconomyReport | null;
  readonly companyId?: string;
  readonly companyNames?: ReadonlyMap<string, string>;
  /** Open straight onto this slot's candidates — from a hanging node on the canvas. */
  readonly initialSlotId?: string | null;
}

/** What each collection level buys and costs, in the engine's own numbers. */
const POLICY_LABEL: Readonly<Record<DataCollectionLevel, string>> = {
  minimal: 'Minimal',
  standard: 'Standard',
  aggressive: 'Aggressive',
};

/** The first letter up: `describeLine` speaks in the middle of a sentence, a subtitle opens one. */
function sentenceCase(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

export function NodeLineDrawer({
  session,
  product,
  onClose,
  report = null,
  companyId = '',
  companyNames,
  initialSlotId = null,
}: NodeLineDrawerProps): React.JSX.Element {
  const { queueAction, unqueueAction } = useGameActions();
  const company = useActiveCompany();
  const [priceText, setPriceText] = useState('');
  const [windDown, setWindDown] = useState(2);
  const [priceResult, setPriceResult] = useState<ActionValidationResult | null>(null);
  const [sunsetResult, setSunsetResult] = useState<ActionValidationResult | null>(null);
  const [policyResult, setPolicyResult] = useState<ActionValidationResult | null>(null);
  const [slotResults, setSlotResults] = useState<Readonly<Record<string, ActionValidationResult | null>>>({});
  const [sheetSlotId, setSheetSlotId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, SlotChoice>>>({});
  const [aim, setAim] = useState<TargetChoice | null>(null);
  const [aimResult, setAimResult] = useState<ActionValidationResult | null>(null);
  const [publishOpenToAll, setPublishOpenToAll] = useState(true);
  const [publishPrice, setPublishPrice] = useState('');
  const [blocked, setBlocked] = useState<readonly string[]>([]);
  const [publishResult, setPublishResult] = useState<ActionValidationResult | null>(null);
  // At most one pending ticket per slot, one re-aim and one set of terms: a
  // second tap replaces the queued action rather than stacking another behind it.
  const [pendingFillIds, setPendingFillIds] = useState<Readonly<Record<string, string>>>({});
  const [pendingAimId, setPendingAimId] = useState<string | null>(null);
  const [pendingTermsId, setPendingTermsId] = useState<string | null>(null);

  const nodeId = product === null ? null : lineNodeIdOf(product);
  const node = nodeId === null ? undefined : economicNodeById(nodeId);
  const isOwnCompany = company.id === companyId;

  const proposed = Number.parseFloat(priceText);
  const hasPrice = product !== null && Number.isFinite(proposed) && proposed >= 0;
  const priceUsd = hasPrice ? proposed : (product?.pricePerSeat ?? 0);

  /* --- the engine's own answers ------------------------------------------- */
  const cost = useMemo(
    () => (nodeId === null || !isOwnCompany ? null : unitCostOf(session, company, nodeId)),
    [session, company, nodeId, isOwnCompany],
  );
  const slots = useMemo(
    () => (nodeId === null || product === null || !isOwnCompany ? [] : slotOptions(session, company, nodeId, product.id)),
    [session, company, nodeId, product, isOwnCompany],
  );
  const names = useMemo(() => companyNames ?? new Map(session.companies.map((entry) => [entry.id, entry.name])), [companyNames, session.companies]);
  const grouped = useMemo(() => (node === undefined || cost === null ? null : costRowsBySlot(node, cost, names, company.id)), [node, cost, names, company.id]);

  // Who builds on this line: the projection's own relationships, which resolve
  // every buyer's fills the way the engine does rather than reading them raw.
  const buyers = useMemo(() => {
    if (product === null || nodeId === null || !isOwnCompany) return [];
    const view = nodeMapFor(session, company.id);
    const seen = new Set<string>();
    const out: { readonly companyId: string; readonly name: string; readonly nodeLabel: string }[] = [];
    for (const wire of view.supplyWires) {
      if (wire.supplierCompanyId !== company.id || wire.inputNodeId !== nodeId || wire.buyerCompanyId === company.id) continue;
      const key = `${wire.buyerCompanyId}|${wire.buyerNodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        companyId: wire.buyerCompanyId,
        name: view.companyNames[wire.buyerCompanyId] ?? wire.buyerCompanyId,
        nodeLabel: economicNodeById(wire.buyerNodeId)?.label ?? wire.buyerNodeId,
      });
    }
    return out;
  }, [session, company.id, product, nodeId, isOwnCompany]);

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

  // The forms start from what the line already has and reset whenever the
  // drawer opens on a different product.
  useEffect(() => {
    setPriceText('');
    setPriceResult(null);
    setSunsetResult(null);
    setPolicyResult(null);
    setSlotResults({});
    setDrafts({});
    setAim(null);
    setAimResult(null);
    setPublishOpenToAll(product?.supplyTerms?.openToAll ?? true);
    setPublishPrice(String(Math.round(product?.supplyTerms?.pricePerUnitUsd ?? product?.pricePerSeat ?? 0)));
    setBlocked(product?.supplyTerms?.blockedCustomerIds ?? []);
    setPublishResult(null);
    setPendingFillIds({});
    setPendingAimId(null);
    setPendingTermsId(null);
    setSheetSlotId(initialSlotId);
  }, [product?.id, initialSlotId]);

  const target: TargetChoice | null =
    product === null || node === undefined
      ? null
      : (aim ?? { customer: product.segment, industry: product.segment === 'consumer' ? 'consumer' : (product.targetIndustry ?? defaultIndustryFor(node)) });
  const aimChanged =
    product !== null && target !== null && (target.customer !== product.segment || (target.customer !== 'consumer' && target.industry !== (product.targetIndustry ?? (node === undefined ? null : defaultIndustryFor(node)))));

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

  function applyAim(): void {
    if (product === null || target === null) return;
    if (pendingAimId !== null) unqueueAction(pendingAimId);
    const entry = queueAction({
      type: 'set_target_market',
      productId: product.id,
      segment: target.customer,
      targetIndustry: target.customer === 'consumer' ? 'consumer' : target.industry,
    });
    setPendingAimId(entry.action.actionId);
    setAimResult(entry.validation);
  }

  function fillSlot(slotId: string, choice: SlotChoice): void {
    if (product === null) return;
    setDrafts((current) => ({ ...current, [slotId]: choice }));
    const previous = pendingFillIds[slotId];
    if (previous !== undefined) unqueueAction(previous);
    const entry = queueAction({
      type: 'fill_slot',
      productId: product.id,
      slotId,
      nodeId: choice.nodeId,
      supplierCompanyId: choice.supplierCompanyId,
      supplierProductId: choice.supplierCompanyId === null ? null : choice.supplierProductId,
    });
    setPendingFillIds((current) => ({ ...current, [slotId]: entry.action.actionId }));
    setSlotResults((current) => ({ ...current, [slotId]: entry.validation }));
  }

  function toggleBlocked(id: string): void {
    setBlocked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  function submitSupplyTerms(closeToAll: boolean): void {
    if (product === null) return;
    const priceValue = Number.parseFloat(publishPrice);
    if (!Number.isFinite(priceValue) || priceValue < 0) return;
    const terms: SupplyTerms = {
      openToAll: closeToAll ? false : publishOpenToAll,
      pricePerUnitUsd: priceValue,
      exclusiveCustomerIds: closeToAll ? [] : (product.supplyTerms?.exclusiveCustomerIds ?? []),
      blockedCustomerIds: [...blocked],
    };
    if (pendingTermsId !== null) unqueueAction(pendingTermsId);
    const entry = queueAction({ type: 'set_supply_terms', productId: product.id, terms });
    setPendingTermsId(entry.action.actionId);
    setPublishResult(entry.validation);
  }

  const policy = dataPolicyOf(company);
  const sectorData = node === undefined ? 0 : dataPetabytesOf(company, node.sector);
  const sheetSlot = sheetSlotId === null ? null : (slots.find((slot) => slot.slotId === sheetSlotId) ?? null);

  // The chips a company can be cut off with: whoever builds on the line today,
  // plus anyone already blocked, so a block can be lifted from the same row.
  const blockable = useMemo(() => {
    const out = new Map<string, string>();
    for (const buyer of buyers) out.set(buyer.companyId, buyer.name);
    for (const id of blocked) if (!out.has(id)) out.set(id, names.get(id) ?? id);
    return [...out.entries()].map(([id, name]) => ({ id, name }));
  }, [buyers, blocked, names]);

  return (
    <Drawer
      open={product !== null}
      onClose={onClose}
      title={product?.name ?? ''}
      subtitle={
        product === null || node === undefined
          ? undefined
          : isOwnCompany
            ? // The line in the founder's own words: what it is built on and who it
              // is aimed at, from the same roll-up the cost rows below are read off.
              sentenceCase(describeLine(session, company, product, company.id))
            : `${node.label} · per ${unitLabel}`
      }
      width={520}
    >
      {product === null || node === undefined ? null : sheetSlot !== null ? (
        <SlotCandidateSheet
          slot={sheetSlot}
          companyId={company.id}
          choice={drafts[sheetSlot.slotId] ?? (sheetSlot.fill === null ? undefined : choiceOfFill(sheetSlot.fill))}
          onChoose={(choice) => fillSlot(sheetSlot.slotId, choice)}
          onBack={() => setSheetSlotId(null)}
          banner={slotResults[sheetSlot.slotId] == null ? null : <ValidationBanner result={slotResults[sheetSlot.slotId] ?? null} />}
        />
      ) : (
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
                  { label: 'Sells', value: node.label, hint: `per ${unitLabel}` },
                  { label: 'Launched', value: quarterLabel(session.startYear, product.launchedQuarter) },
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

          {/* --- the target: who it is aimed at ----------------------------- */}
          {!isOwnCompany || target === null ? null : (
            <div>
              <SectionHeading rule>Target market</SectionHeading>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {customerChoices(node).map((entry) => (
                  <button
                    key={entry.customer}
                    type="button"
                    onClick={() => setAim({ customer: entry.customer, industry: target.industry })}
                    className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                      entry.customer === target.customer ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                    }`}
                  >
                    {CUSTOMER_CHIP[entry.customer]}
                  </button>
                ))}
              </div>
              {target.customer === 'consumer' ? null : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {industryChoices(node, target.customer).map((entry) => (
                    <button
                      key={entry.industry}
                      type="button"
                      onClick={() => setAim({ customer: target.customer, industry: entry.industry })}
                      className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                        entry.industry === target.industry ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                      }`}
                    >
                      {sectorLabel(entry.industry)}
                      <span className="figure ml-1 text-[10px] text-ink-faint">{Math.round(entry.weight * 100)}%</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11.5px] leading-snug text-ink-dim">{targetSentence(node, target)}</p>
              {aimChanged ? (
                <button type="button" className="btn btn-primary mt-2 min-h-11" onClick={applyAim}>
                  Queue the re-aim
                </button>
              ) : null}
              {aimResult === null ? null : (
                <div className="mt-2">
                  <ValidationBanner result={aimResult} />
                </div>
              )}
            </div>
          )}

          {/* --- the slots: the composition --------------------------------- */}
          {slots.length === 0 ? null : (
            <div>
              <SectionHeading rule>Slots</SectionHeading>
              <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
                What goes in each slot and where it comes from. Tap a slot to change the node or the source; a change queues for the quarter and
                delivers at the switch-cost factor for one quarter.
              </p>
              <ul className="mt-2 space-y-1.5">
                {slots.map((slot) => {
                  const choice = drafts[slot.slotId] ?? (slot.fill === null ? undefined : choiceOfFill(slot.fill));
                  const verdict = slotResults[slot.slotId] ?? null;
                  return (
                    <li key={slot.slotId}>
                      <button
                        type="button"
                        onClick={() => setSheetSlotId(slot.slotId)}
                        className="flex min-h-11 w-full items-center gap-2.5 rounded-card border border-hairline bg-surface px-3 py-2 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="truncate text-[12.5px] font-medium text-ink">{slot.label}</span>
                            {slot.required ? <span className="font-bold text-loss">*</span> : null}
                            {roleCaption(slot) === '' ? null : <span className="shrink-0 text-[10.5px] text-ink-faint">· {roleCaption(slot)}</span>}
                            <span className="figure ml-auto shrink-0 text-[10.5px] text-ink-faint">
                              {slot.qtyPerUnit} {slot.unitLabel}
                            </span>
                          </div>
                          <div className={`truncate text-[11px] ${slot.fill?.route === 'blocked' ? 'font-semibold text-loss' : 'text-ink-dim'}`}>
                            {fillSummary(slot, choice, company.id)}
                            {slot.fill?.changedThisQuarter ? ' · switched this quarter' : ''}
                          </div>
                        </div>
                        <Icon name="chevronRight" size={14} accent="neutral" />
                      </button>
                      {verdict === null ? null : (
                        <div className="mt-1.5">
                          <ValidationBanner result={verdict} compact />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* --- what it costs to make ------------------------------------- */}
          {cost === null || grouped === null ? null : (
            <div>
              <SectionHeading rule>What it costs to make</SectionHeading>
              {(() => {
                const sentence = biggestCostSentence(cost, costBreakdown(cost), names, (value) => formatMoney(value, 'full'));
                return sentence === '' ? null : <p className="mt-1.5 text-[11.5px] leading-snug text-ink-dim">{sentence}</p>;
              })()}
              <ul className="mt-2 divide-y divide-hairline">
                {grouped.inputs.map((row) => (
                  <li key={row.key} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-ink">{row.label}</span>
                      <span className="block truncate text-[10.5px] text-ink-faint">{row.detail}</span>
                    </span>
                    <span className="figure w-10 shrink-0 text-right text-[10.5px] text-ink-faint">{row.sharePct}%</span>
                    <span className="figure w-24 shrink-0 text-right text-[12px] text-ink">{formatMoney(row.amountUsd, 'full')}</span>
                  </li>
                ))}
                {grouped.making.map((row) => (
                  <li key={row.key} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {row.label}
                      {row.detail === '' ? '' : <span className="text-ink-faint"> · {row.detail}</span>}
                    </span>
                    <span className="figure w-10 shrink-0 text-right text-[10.5px] text-ink-faint">{row.sharePct}%</span>
                    <span className="figure w-24 shrink-0 text-right text-[12px] text-ink">{formatMoney(row.amountUsd, 'full')}</span>
                  </li>
                ))}
              </ul>
              {cost.blockedInputNodeIds.length === 0 ? null : (
                <p className="mt-2 rounded-card bg-loss-wash px-3 py-2 text-[11px] leading-snug font-semibold text-loss">
                  {cost.blockedInputNodeIds.map((id) => economicNodeById(id)?.label ?? id).join(', ')}: nobody in the world owns this, so the
                  line ships nothing until somebody does — or until you fill that slot with something else.
                </p>
              )}
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
                  companyNames={names}
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

          {/* --- publishing: sell this to other companies ------------------- */}
          {!isOwnCompany ? null : (
            <div>
              <SectionHeading rule>Sell this to other companies</SectionHeading>
              <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
                {product.supplyTerms == null
                  ? `${product.name} is not published: nobody else can put a product on it. Publishing is the owner's own move — any company with a slot for ${node.label.toLowerCase()} can then build on yours.`
                  : `Published ${product.supplyTerms.openToAll ? 'open to all' : 'on private terms'} at ${formatMoney(product.supplyTerms.pricePerUnitUsd, 'full')} a ${unitLabel}.`}
              </p>
              <div className="mt-2 space-y-2.5">
                <label className="flex min-h-11 items-center gap-2 text-[11.5px] text-ink-dim">
                  <input type="checkbox" checked={publishOpenToAll} onChange={(event) => setPublishOpenToAll(event.target.checked)} className="size-5" />
                  Open to any company — a public API. Unchecked keeps it to whoever already builds on it.
                </label>
                <SliderField
                  label={`Price per ${unitLabel} to other companies`}
                  value={Math.max(0, Number.parseFloat(publishPrice) || 0)}
                  onChange={(next) => setPublishPrice(String(Math.round(next)))}
                  min={0}
                  max={Math.max(marketPriceUsd * 4, product.pricePerSeat * 2, Number.parseFloat(publishPrice) || 0, 10)}
                  step={roundStep(Math.max(marketPriceUsd * 4, product.pricePerSeat * 2, 10))}
                  format={(value) => formatMoney(value, 'full')}
                />
                <p className="text-[10.5px] leading-snug text-ink-faint">{quoteSentence(sellerPriceFactor(session, company), Math.max(0, Number.parseFloat(publishPrice) || 0), unitLabel, (value) => formatMoney(value, 'full'))}</p>
                {blockable.length === 0 ? (
                  <p className="text-[10.5px] text-ink-faint">Nobody builds on this line yet. A company that does appears here, and can be cut off from here.</p>
                ) : (
                  <div>
                    <span className="label-caps-faint">Cut off</span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {blockable.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => toggleBlocked(entry.id)}
                          className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                            blocked.includes(entry.id) ? 'border-loss bg-loss-wash font-semibold text-loss' : 'border-hairline text-ink-dim'
                          }`}
                        >
                          {blocked.includes(entry.id) ? 'Blocked · ' : ''}
                          {entry.name}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[10.5px] text-ink-faint">A cut-off takes effect after one quarter&apos;s notice.</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary min-h-11 gap-1.5" onClick={() => submitSupplyTerms(false)}>
                    <Icon name="check" size={16} accent="current" />
                    {product.supplyTerms == null ? 'Publish' : 'Update terms'}
                  </button>
                  {product.supplyTerms == null ? null : (
                    <button type="button" className="btn btn-danger min-h-11 gap-1.5" onClick={() => submitSupplyTerms(true)}>
                      <Icon name="warning" size={16} accent="current" />
                      Close to everyone
                    </button>
                  )}
                </div>
                {publishResult === null ? null : <ValidationBanner result={publishResult} />}
              </div>

              {buyers.length === 0 ? null : (
                <div className="mt-2.5 space-y-1">
                  <div className="label-caps-faint">Building on this ({buyers.length})</div>
                  {buyers.map((buyer) => (
                    <div key={`${buyer.companyId}|${buyer.nodeLabel}`} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-ink-dim">
                        {buyer.name} — {buyer.nodeLabel}
                      </span>
                      {blocked.includes(buyer.companyId) ? <Tag tone="loss">cut off</Tag> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* --- data ------------------------------------------------------- */}
          <div>
            <SectionHeading rule>Customer data</SectionHeading>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              What this line learns from the people using it. Data improves quality and feeds any line with a slot for a
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

/**
 * What a buyer is actually quoted for an ask: the ask times this seller's own
 * factor — its region's energy price and how full its fleet is, bounded — and
 * then held inside the market's band by the roll-up. Said here, beside the
 * price control, because a founder setting an ask nobody is ever quoted has
 * been told nothing.
 */
export function quoteSentence(factor: number, askUsd: number, unitLabel: string, formatUsd: (value: number) => string): string {
  const pct = Math.round((factor - 1) * 100);
  if (Math.abs(pct) < 1) return `Buyers are quoted your ask as it stands: your region's energy price and your load add nothing to it this quarter.`;
  const direction = pct > 0 ? 'above' : 'below';
  const quoted = askUsd > 0 ? ` — ${formatUsd(askUsd)} reads to a buyer as ${formatUsd(askUsd * factor)} a ${unitLabel}` : '';
  return `Buyers are quoted ${Math.abs(pct)}% ${direction} your ask, for your region's energy price and how full your fleet is${quoted}. The market's own band still bounds what they pay.`;
}

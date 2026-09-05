'use client';

/**
 * The world-3 launch ticket: What to sell → Inputs → Target → Cost to make → Price.
 *
 * The order is the owner's. A founder picks a node, fills each of its slots —
 * which model, which harness, from whom — says who the line is aimed at, sees
 * the whole unit cost of exactly that composition grouped by slot with the
 * largest named in a sentence, and only then is shown a price field. The
 * margin on the last step is `price − unitCost` over price, where `unitCost` is
 * the number cost of goods will book for the fills chosen two steps earlier.
 *
 * A node the company cannot make is never a dead end: the Inputs step names
 * what is missing and offers the three real routes — research it, licence it,
 * or buy the output instead — with the world's actual answer to each.
 *
 * It presents as a sheet — a bottom sheet on a phone, a side pane from `sm`
 * up — and the slot sheet is hosted inside it rather than stacked over it.
 * World 2's `LaunchModal` is untouched beside this file: two flows, because
 * they are two economies, and the frozen one does not get edited.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionValidationResult, EconomicNode } from '@frontier/contracts';
import { economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import { biggestCostSentence, costBreakdown, launchCapacityPreview, nodeEntryRoutes, slotOptions, unitCostOf } from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { CashAfter, Drawer, Icon, SliderField, Tag, ValidationBanner, roundStep, sectorLabel } from '@/components/ui';
import { setPendingResearchNode, useActiveCompany, useGameActions, useSession } from '@/lib/game';
import {
  CUSTOMER_CHIP,
  DEFAULT_QUALITY_TIER,
  NODE_LAUNCH_STEPS,
  capacitySentence,
  costRowsBySlot,
  costingBlockers,
  customerChoices,
  defaultFills,
  defaultTarget,
  entryRoutes,
  fillSummary,
  industryChoices,
  launchIntent,
  launchOptions,
  lockReason,
  previewFills,
  priceSentence,
  roleCaption,
  targetSentence,
  tierCaption,
  withChoice,
  type FillMap,
  type NodeLaunchStep,
  type TargetChoice,
} from './nodeLaunch';
import { SlotCandidateSheet } from './SlotCandidateSheet';

export interface NodeLaunchModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Open straight onto this node — from a card on the canvas. */
  readonly initialNodeId?: string | null;
}

const LAST_STEP: NodeLaunchStep = 4;

export function NodeLaunchModal({ open, onClose, initialNodeId = null }: NodeLaunchModalProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const company = useActiveCompany();
  const session = useSession();

  const options = useMemo(() => launchOptions(session, company), [session, company]);
  const [step, setStep] = useState<NodeLaunchStep>(0);
  const [nodeId, setNodeId] = useState<string>(() => options.find((entry) => !entry.locked && !entry.alreadySold)?.node.id ?? options[0]?.node.id ?? '');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [marketing, setMarketing] = useState('250000');
  const [tier, setTier] = useState(DEFAULT_QUALITY_TIER);
  const [fills, setFills] = useState<FillMap>({});
  const [target, setTarget] = useState<TargetChoice | null>(null);
  const [sheetSlotId, setSheetSlotId] = useState<string | null>(null);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const node: EconomicNode | undefined = economicNodeById(nodeId);

  /* --- the engine's own answers ------------------------------------------ */
  const slots = useMemo(() => (node === undefined ? [] : slotOptions(session, company, node.id, null)), [session, company, node]);
  const routes = useMemo(() => (node === undefined ? null : nodeEntryRoutes(session, company, node.id)), [session, company, node]);
  const marketPriceUsd = node === undefined ? 0 : nodeMarketPriceUsd(session, node.id);
  const aim = target ?? (node === undefined ? null : defaultTarget(node));

  // The preview costs the composition the founder is drafting at the tier they
  // are drafting it at — never the memoised line, because there is no line yet.
  const cost = useMemo(
    () => (node === undefined ? null : unitCostOf(session, company, node.id, undefined, { fills: previewFills(fills), qualityTier: tier })),
    [session, company, node, fills, tier],
  );
  const companyNames = useMemo(() => new Map(session.companies.map((entry) => [entry.id, entry.name])), [session.companies]);
  const grouped = useMemo(() => (node === undefined || cost === null ? null : costRowsBySlot(node, cost, companyNames, company.id)), [node, cost, companyNames, company.id]);
  const headline = cost === null ? '' : biggestCostSentence(cost, costBreakdown(cost), companyNames, (value) => formatMoney(value, 'full'));
  const blockers = cost === null ? [] : costingBlockers(cost);
  // What the line opens with of the company's own bucket: the same share the
  // production pass will apply the quarter it lands.
  const capacity = useMemo(() => (node === undefined ? '' : capacitySentence(launchCapacityPreview(session, company, node.id, tier), node, formatCount)), [session, company, node, tier]);

  /* --- opening on a node ---------------------------------------------------- */
  function startOn(next: EconomicNode): void {
    setNodeId(next.id);
    setName((current) => (current.trim().length > 0 ? current : `${next.label} line`));
    setPrice(String(Math.round(nodeMarketPriceUsd(session, next.id))));
    setFills(defaultFills(slotOptions(session, company, next.id, null)));
    setTarget(defaultTarget(next));
    setSheetSlotId(null);
    setStep(1);
  }

  useEffect(() => {
    if (!open || initialNodeId === null) return;
    const next = economicNodeById(initialNodeId);
    if (next === undefined) return;
    startOn(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialNodeId]);

  // A locked node is not a dead end: the Inputs step names what is missing and
  // the three routes in, so the row opens like any other.
  function pickNode(next: EconomicNode): void {
    startOn(next);
  }

  const priceUsd = Math.max(0, Number.parseFloat(price) || 0);
  const marketingUsd = Math.max(0, Number.parseFloat(marketing) || 0);
  const intent = useMemo(
    () => (node === undefined || aim === null ? null : launchIntent({ node, name, priceUsd, marketingUsd, qualityTier: tier, target: aim, fills })),
    [node, name, priceUsd, marketingUsd, tier, aim, fills],
  );
  const preview = intent === null || step !== LAST_STEP ? null : validateIntent(intent);

  function submit(): void {
    if (intent === null) return;
    setResult(queueAction(intent).validation);
  }

  function close(): void {
    setStep(0);
    setName('');
    setPrice('');
    setMarketing('250000');
    setTier(DEFAULT_QUALITY_TIER);
    setFills({});
    setTarget(null);
    setSheetSlotId(null);
    setResult(null);
    onClose();
  }

  const sheetSlot = sheetSlotId === null ? null : (slots.find((slot) => slot.slotId === sheetSlotId) ?? null);
  const nextLabel: Readonly<Record<number, string>> = { 1: 'Aim it', 2: 'Cost it', 3: 'Set a price' };

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Open a line"
      subtitle={node === undefined || step === 0 ? 'What it costs to make comes before what you charge for it.' : `${node.label} · per ${node.unitLabel}`}
      width={560}
      footer={
        sheetSlot !== null ? (
          <button type="button" className="btn btn-primary min-h-11" onClick={() => setSheetSlotId(null)}>
            Done with this slot
          </button>
        ) : (
          <>
            <button type="button" className="btn min-h-11" onClick={close}>
              Close
            </button>
            {step > 0 ? (
              <button type="button" className="btn min-h-11" onClick={() => setStep((current) => (current - 1) as NodeLaunchStep)}>
                Back
              </button>
            ) : null}
            {step === LAST_STEP ? (
              <button type="button" className="btn btn-primary min-h-11" disabled={intent === null} onClick={submit}>
                Queue launch
              </button>
            ) : step > 0 ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setStep((current) => (current + 1) as NodeLaunchStep)}>
                {nextLabel[step] ?? 'Next'}
              </button>
            ) : null}
          </>
        )
      }
    >
      {sheetSlot !== null ? (
        <SlotCandidateSheet
          slot={sheetSlot}
          companyId={company.id}
          choice={fills[sheetSlot.slotId]}
          onChoose={(choice) => setFills((current) => withChoice(current, sheetSlot, choice))}
          onBack={() => setSheetSlotId(null)}
        />
      ) : (
        <>
          {/* --- breadcrumb ------------------------------------------------ */}
          <div className="mb-4 flex flex-wrap items-center gap-1 text-[11px]">
            {NODE_LAUNCH_STEPS.map((label, index) => (
              <span key={label} className="flex items-center gap-1">
                {index > 0 ? <span className="text-ink-faint">›</span> : null}
                <button
                  type="button"
                  disabled={index > step}
                  onClick={() => (index <= step ? setStep(index as NodeLaunchStep) : undefined)}
                  className={
                    index === step
                      ? 'min-h-11 rounded-pill bg-brand-wash px-2 font-semibold text-brand'
                      : index < step
                        ? 'min-h-11 rounded-pill px-2 font-medium text-ink-dim'
                        : 'min-h-11 rounded-pill px-2 font-medium text-ink-faint'
                  }
                >
                  {label}
                </button>
              </span>
            ))}
          </div>

          {/* --- 0. what to sell -------------------------------------------- */}
          {step === 0 ? (
            <ul className="space-y-1.5">
              {options.map((option) => (
                <li key={option.node.id}>
                  <button
                    type="button"
                    onClick={() => pickNode(option.node)}
                    className={`flex min-h-11 w-full items-center gap-2.5 rounded-card border px-3 py-2 text-left ${
                      option.node.id === nodeId ? 'border-brand bg-brand-wash' : 'border-hairline bg-surface'
                    } ${option.locked ? 'opacity-70' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-ink">{option.label}</div>
                      <div className="truncate text-[10.5px] text-ink-faint">
                        {option.unitLabel} · {formatMoney(nodeMarketPriceUsd(session, option.node.id))} on the market
                      </div>
                    </div>
                    {option.alreadySold ? <Tag tone="info">Already yours</Tag> : null}
                    {option.locked ? <Tag tone="warn">Locked</Tag> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* --- 1. inputs: one row per slot -------------------------------- */}
          {step === 1 && node !== undefined ? (
            <div className="space-y-3">
              {routes !== null && !routes.canProduce ? (
                <div className="rounded-card border border-warn bg-warn-wash px-3 py-2.5">
                  <p className="text-[12px] leading-snug font-semibold text-warn">{lockReason(routes)}</p>
                  <ul className="mt-2 space-y-1.5">
                    {entryRoutes(routes, (value) => formatMoney(value, 'full')).map((route) => (
                      <li key={route.kind} className="text-[11px] leading-snug">
                        <span className={route.available ? 'font-semibold text-ink' : 'font-semibold text-ink-faint'}>{route.headline}</span>
                        <span className="text-ink-dim"> — {route.detail}</span>
                        {route.kind === 'research' && route.available ? (
                          <button
                            type="button"
                            className="ml-1.5 min-h-11 text-brand underline"
                            onClick={() => setPendingResearchNode(routes.missing[0]?.nodeId ?? node.id)}
                          >
                            Open on the map
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {slots.length === 0 ? (
                <p className="text-[12px] text-ink-dim">{node.label} takes no inputs. There is nothing to compose.</p>
              ) : (
                <>
                  <p className="text-[11px] leading-snug text-ink-faint">
                    Each slot takes any node of its kind, from anyone who sells it. Tap a slot to choose the node and where it comes from.
                  </p>
                  <ul className="space-y-1.5">
                    {slots.map((slot) => (
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
                            <div className="truncate text-[11px] text-ink-dim">{fillSummary(slot, fills[slot.slotId], company.id)}</div>
                          </div>
                          <Icon name="chevronRight" size={14} accent="neutral" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

          {/* --- 2. target: who it is aimed at ------------------------------ */}
          {step === 2 && node !== undefined && aim !== null ? (
            <div className="space-y-4">
              <div>
                <span className="label-caps-faint">Who signs</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {customerChoices(node).map((entry) => (
                    <button
                      key={entry.customer}
                      type="button"
                      onClick={() => setTarget({ customer: entry.customer, industry: aim.industry })}
                      className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                        entry.customer === aim.customer ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                      }`}
                    >
                      {CUSTOMER_CHIP[entry.customer]}
                      <span className="figure ml-1 text-[10px] text-ink-faint">{Math.round(entry.weight * 100)}%</span>
                    </button>
                  ))}
                </div>
              </div>

              {aim.customer === 'consumer' ? null : (
                <div>
                  <span className="label-caps-faint">In which industry</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {industryChoices(node, aim.customer).map((entry) => (
                      <button
                        key={entry.industry}
                        type="button"
                        onClick={() => setTarget({ customer: aim.customer, industry: entry.industry })}
                        className={`min-h-11 rounded-pill border px-3 text-[11.5px] ${
                          entry.industry === aim.industry ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim'
                        }`}
                      >
                        {sectorLabel(entry.industry)}
                        <span className="figure ml-1 text-[10px] text-ink-faint">{Math.round(entry.weight * 100)}%</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="rounded-card bg-brand-wash px-3 py-2 text-[12px] leading-snug text-ink">{targetSentence(node, aim)}</p>
              <p className="text-[10.5px] leading-snug text-ink-faint">
                Demand is modelled per industry and customer type: a line aimed at logistics enterprises grows with the logistics sector. You can re-aim a live line later.
              </p>
            </div>
          ) : null}

          {/* --- 3. what it costs to make ----------------------------------- */}
          {step === 3 && node !== undefined && cost !== null && grouped !== null ? (
            <div className="space-y-4">
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label-caps-faint">Unit cost</span>
                  <span className="figure text-[20px] font-semibold text-ink">{formatMoney(cost.unitCostUsd, 'full')}</span>
                </div>
                <p className="mt-0.5 text-[10.5px] text-ink-faint">per {node.unitLabel}, with the inputs you chose</p>
                {headline === '' ? null : <p className="mt-2 text-[12px] leading-snug text-ink-dim">{headline}</p>}
                {capacity === '' ? null : <p className="mt-2 rounded-card bg-brand-wash px-3 py-2 text-[11.5px] leading-snug text-ink">{capacity}</p>}
              </div>

              {grouped.inputs.length === 0 ? null : (
                <div>
                  <span className="label-caps-faint">Inputs, by slot</span>
                  <ul className="mt-1 divide-y divide-hairline">
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
                  </ul>
                </div>
              )}

              <div>
                <span className="label-caps-faint">Making it</span>
                <ul className="mt-1 divide-y divide-hairline">
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
              </div>

              {blockers.length === 0 ? null : (
                <p className="rounded-card bg-loss-wash px-3 py-2 text-[11px] leading-snug font-semibold text-loss">
                  Nobody in the world makes {blockers.join(', ')}. This line ships nothing until somebody does, or until you fill that slot with something else.
                </p>
              )}
            </div>
          ) : null}

          {/* --- 4. price ---------------------------------------------------- */}
          {step === LAST_STEP && node !== undefined && cost !== null ? (
            <div className="space-y-4">
              <label className="block">
                <span className="label-caps-faint">Line name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-card border border-hairline bg-surface px-3 text-[13px] text-ink"
                  placeholder={`${node.label} line`}
                />
              </label>

              <SliderField
                label={`Price per ${node.unitLabel}`}
                value={priceUsd}
                min={0}
                max={Math.max(marketPriceUsd * 4, priceUsd, 10)}
                step={roundStep(Math.max(marketPriceUsd * 4, 10))}
                onChange={(value) => setPrice(String(Math.round(value)))}
                format={(value) => formatMoney(value, 'full')}
              />
              <p className="text-[11.5px] leading-snug text-ink-dim">
                {priceSentence(priceUsd, marketPriceUsd, cost.unitCostUsd, (value) => formatMoney(value, 'full'))}
              </p>

              <SliderField label="Quality tier" value={tier} min={0} max={1} step={0.05} onChange={setTier} format={(value) => formatPct(value)} />
              <p className="text-[10.5px] leading-snug text-ink-faint">{tierCaption(tier)}</p>

              <SliderField
                label="Launch marketing"
                value={marketingUsd}
                min={0}
                max={Math.max(company.financials.cash, marketingUsd, 1_000_000)}
                step={roundStep(Math.max(company.financials.cash, 1_000_000))}
                onChange={(value) => setMarketing(String(Math.round(value)))}
                format={(value) => formatMoney(value)}
              />
              <CashAfter company={company} spendUsd={marketingUsd} label="Cash after the launch" />

              {preview === null ? null : <ValidationBanner result={preview} />}
              {result === null ? null : <ValidationBanner result={result} />}
            </div>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

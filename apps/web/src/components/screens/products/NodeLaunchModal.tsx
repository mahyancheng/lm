'use client';

/**
 * The world-3 launch ticket: Line → Cost to make → Inputs → Price.
 *
 * The order is the owner's, and the second step is the one that matters. A
 * founder sees the whole unit cost — every input, every conversion line, sorted
 * biggest first, with the largest named in a sentence — **before** the form
 * shows them a price field at all. World 2 asked for a price against a
 * catalogue reference and computed a margin from compute cost alone; here the
 * margin on the last step is `price − unitCost` over price, where `unitCost` is
 * the number cost of goods will book.
 *
 * A node the company cannot make is never selectable, and never a dead end: it
 * names what is missing and offers the three real routes — research it, licence
 * it, or buy the output instead — with the world's actual answer to each.
 *
 * World 2's `LaunchModal` is untouched beside this file. Two flows, because
 * they are two economies, and the frozen one does not get edited.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionValidationResult, EconomicNode } from '@frontier/contracts';
import { economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import {
  biggestCostSentence,
  costBreakdown,
  inputOptions,
  nodeEntryRoutes,
  unitCostOf,
  type InputRoute,
  type NodeInputOptions,
} from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import { CashAfter, Icon, Modal, SliderField, Tag, ValidationBanner, roundStep } from '@/components/ui';
import { setPendingResearchNode, useActiveCompany, useGameActions, useSession } from '@/lib/game';
import {
  NODE_LAUNCH_STEPS,
  costingBlockers,
  defaultWiring,
  entryRoutes,
  launchIntent,
  launchOptions,
  lockReason,
  priceSentence,
  type NodeLaunchStep,
  type WiringMap,
} from './nodeLaunch';

export interface NodeLaunchModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Open straight onto this node — from a card on the canvas. */
  readonly initialNodeId?: string | null;
}

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
  const [quality, setQuality] = useState(0.5);
  const [wiring, setWiring] = useState<WiringMap>({});
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const node: EconomicNode | undefined = economicNodeById(nodeId);

  /* --- the engine's own answers ------------------------------------------ */
  const cost = useMemo(() => (node === undefined ? null : unitCostOf(session, company, node.id)), [session, company, node]);
  const rows = useMemo(() => (cost === null ? [] : costBreakdown(cost)), [cost]);
  const inputs = useMemo(() => (node === undefined ? [] : inputOptions(session, company, node.id)), [session, company, node]);
  const routes = useMemo(() => (node === undefined ? null : nodeEntryRoutes(session, company, node.id)), [session, company, node]);
  const marketPriceUsd = node === undefined ? 0 : nodeMarketPriceUsd(session, node.id);

  const companyNames = useMemo(() => new Map(session.companies.map((entry) => [entry.id, entry.name])), [session.companies]);
  const headline = cost === null ? '' : biggestCostSentence(cost, rows, companyNames, (value) => formatMoney(value, 'full'));
  const blockers = cost === null ? [] : costingBlockers(cost);

  /* --- opening on a node from the canvas ---------------------------------- */
  useEffect(() => {
    if (!open || initialNodeId === null) return;
    const target = economicNodeById(initialNodeId);
    if (target === undefined) return;
    setNodeId(target.id);
    setName(`${target.label} line`);
    setPrice(String(Math.round(nodeMarketPriceUsd(session, target.id))));
    setStep(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialNodeId]);

  // The wiring step opens on whatever the roll-up already does, so a founder who
  // changes nothing launches at the cost they were just shown.
  useEffect(() => {
    setWiring(defaultWiring(inputs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  function pickNode(next: EconomicNode, locked: boolean): void {
    if (locked) return;
    setNodeId(next.id);
    setName((current) => (current.trim().length > 0 ? current : `${next.label} line`));
    setPrice(String(Math.round(nodeMarketPriceUsd(session, next.id))));
    setStep(1);
  }

  function wire(inputNodeId: string, route: InputRoute): void {
    setWiring((current) => ({
      ...current,
      [inputNodeId]:
        route.kind === 'buy'
          ? { supplierCompanyId: route.supplierCompanyId, supplierProductId: route.supplierProductId }
          : { supplierCompanyId: null, supplierProductId: null },
    }));
  }

  const priceUsd = Math.max(0, Number.parseFloat(price) || 0);
  const marketingUsd = Math.max(0, Number.parseFloat(marketing) || 0);
  const intent = useMemo(
    () => (node === undefined ? null : launchIntent({ node, name, priceUsd, marketingUsd, quality, wiring })),
    [node, name, priceUsd, marketingUsd, quality, wiring],
  );
  const preview = intent === null || step !== 3 ? null : validateIntent(intent);

  function submit(): void {
    if (intent === null) return;
    setResult(queueAction(intent).validation);
  }

  function close(): void {
    setStep(0);
    setName('');
    setPrice('');
    setMarketing('250000');
    setQuality(0.5);
    setWiring({});
    setResult(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Open a line"
      subtitle="What it costs to make comes before what you charge for it."
      width="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => setStep((current) => (current - 1) as NodeLaunchStep)}>
              Back
            </button>
          ) : null}
          {step === 3 ? (
            <button type="button" className="btn btn-primary" disabled={intent === null} onClick={submit}>
              Queue launch
            </button>
          ) : step > 0 ? (
            <button type="button" className="btn btn-primary" onClick={() => setStep((current) => (current + 1) as NodeLaunchStep)}>
              {step === 1 ? 'Wire the inputs' : 'Set a price'}
            </button>
          ) : null}
        </>
      }
    >
      {/* --- breadcrumb ---------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px]">
        {NODE_LAUNCH_STEPS.map((label, index) => (
          <span key={label} className="flex items-center gap-1.5">
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

      {/* --- 0. which node -------------------------------------------------- */}
      {step === 0 ? (
        <ul className="space-y-1.5">
          {options.map((option) => (
            <li key={option.node.id}>
              <button
                type="button"
                onClick={() => pickNode(option.node, option.locked)}
                disabled={option.locked}
                className={`flex min-h-11 w-full items-center gap-2.5 rounded-card border px-3 py-2 text-left ${
                  option.node.id === nodeId ? 'border-brand bg-brand-wash' : 'border-hairline bg-surface'
                } ${option.locked ? 'opacity-60' : ''}`}
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

      {/* --- 1. what it costs to make -------------------------------------- */}
      {step === 1 && node !== undefined && cost !== null ? (
        <div className="space-y-4">
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

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="label-caps-faint">Unit cost</span>
              <span className="figure text-[20px] font-semibold text-ink">{formatMoney(cost.unitCostUsd, 'full')}</span>
            </div>
            <p className="mt-0.5 text-[10.5px] text-ink-faint">per {node.unitLabel}</p>
            {headline === '' ? null : <p className="mt-2 text-[12px] leading-snug text-ink-dim">{headline}</p>}
          </div>

          <ul className="divide-y divide-hairline">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{row.label}</span>
                <span className="figure w-10 shrink-0 text-right text-[10.5px] text-ink-faint">{row.sharePct}%</span>
                <span className="figure w-24 shrink-0 text-right text-[12px] text-ink">{formatMoney(row.amountUsd, 'full')}</span>
              </li>
            ))}
          </ul>

          {blockers.length === 0 ? null : (
            <p className="rounded-card bg-loss-wash px-3 py-2 text-[11px] leading-snug font-semibold text-loss">
              Nobody in the world makes {blockers.join(', ')}. This line ships nothing until somebody does.
            </p>
          )}
        </div>
      ) : null}

      {/* --- 2. wire the inputs -------------------------------------------- */}
      {step === 2 && node !== undefined ? (
        <div className="space-y-3">
          {inputs.length === 0 ? (
            <p className="text-[12px] text-ink-dim">{node.label} consumes nothing. There is nothing to wire.</p>
          ) : (
            inputs.map((option) => (
              <InputRow
                key={option.inputNodeId}
                option={option}
                chosenSupplierId={wiring[option.inputNodeId]?.supplierCompanyId ?? null}
                onWire={(route) => wire(option.inputNodeId, route)}
              />
            ))
          )}
        </div>
      ) : null}

      {/* --- 3. price ------------------------------------------------------ */}
      {step === 3 && node !== undefined && cost !== null ? (
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

          <SliderField
            label="Quality tier"
            value={quality}
            min={0}
            max={1}
            step={0.05}
            onChange={setQuality}
            format={(value) => formatPct(value)}
          />
          <p className="text-[10.5px] leading-snug text-ink-faint">
            A higher tier buys quality and draws proportionally more capacity per unit. It costs real unit cost, not a
            phantom margin.
          </p>

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
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  One input, three buttons                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One declared input with every route open to it.
 *
 * Three shapes, exactly as the engine hands them over: make it (your cost), buy
 * it from a named seller (their price, their quality), or take the open market
 * (spot, at a premium). The screen renders buttons; it does no graph search and
 * prices nothing.
 */
function InputRow({
  option,
  chosenSupplierId,
  onWire,
}: {
  readonly option: NodeInputOptions;
  readonly chosenSupplierId: string | null;
  readonly onWire: (route: InputRoute) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-card border border-hairline bg-surface px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">
          {option.label}
          {option.substitutable ? null : <span className="ml-1 font-bold text-loss">*</span>}
        </span>
        <span className="figure text-[10.5px] text-ink-faint">
          {option.qtyPerUnit} {option.unitLabel} per unit
        </span>
      </div>

      {option.blocked ? (
        <p className="mt-1.5 text-[11px] leading-snug font-semibold text-loss">
          Nobody in the world owns this node, so it cannot be had at any price.
        </p>
      ) : null}
      {option.selfSuppliedPct > 0 ? (
        <p className="mt-1.5 text-[11px] leading-snug text-brand">
          Your own data pool covers {option.selfSuppliedPct}% of this, free.
        </p>
      ) : null}

      <div className="mt-2 space-y-1.5">
        {option.routes.map((route) => {
          const selected =
            route.kind === 'buy' ? route.supplierCompanyId === chosenSupplierId : route.kind === 'make' ? true : chosenSupplierId === null;
          return (
            <button
              key={`${route.kind}:${route.supplierCompanyId ?? 'market'}`}
              type="button"
              disabled={route.kind === 'make'}
              onClick={() => onWire(route)}
              className={`flex min-h-11 w-full items-center gap-2 rounded-card border px-2.5 py-1.5 text-left ${
                selected && route.kind !== 'make' ? 'border-brand bg-brand-wash' : 'border-hairline'
              } ${route.kind === 'make' ? 'border-brand bg-brand-wash opacity-90' : ''}`}
            >
              <Icon
                name={route.kind === 'make' ? 'building' : route.kind === 'buy' ? 'handshake' : 'globe'}
                size={15}
                accent={route.kind === 'market' ? 'neutral' : 'brand'}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-ink">{route.label}</span>
                <span className="block truncate text-[10px] text-ink-faint">
                  {route.kind === 'make'
                    ? 'transferred at your own cost, no internal margin'
                    : route.kind === 'market'
                      ? `spot, ${route.premiumPct}% over the market`
                      : `quality ${formatPct(route.qualityScore)}${route.premiumPct === 0 ? '' : `, ${route.premiumPct > 0 ? '+' : ''}${route.premiumPct}% against the market`}`}
                </span>
              </span>
              <span className="figure shrink-0 text-[12px] text-ink">{formatMoney(route.unitPriceUsd, 'full')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

'use client';

/**
 * The launch ticket: Industry → Line → Built on → Terms.
 *
 * A launch is an attempt, not an outcome: the engine delivers the target
 * quality discounted by what the company can actually build and by how rushed
 * the launch is, then prices demand against the segment the line sells into.
 * This modal states that plainly rather than promising the target, and it
 * asks the four questions in the order a founder actually asks them — which
 * industry, which line inside it, what the line is built on, and on what
 * terms — rather than one flat form.
 *
 * A locked line (its category's `requiresNodeIds` not yet met) stays visible
 * with the missing research named and a link to it; it is never selectable.
 * "Built on" is skipped entirely for a commodity line with no declared
 * inputs. Every option on it — "your own line", every named offer — comes
 * from `builtOnRows`, which reads the same `suppliersFor` the engine and the
 * Chief of Staff's `suppliers` lookup read; nothing here invents a price or a
 * quality score.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionIntent, ActionValidationResult, ProductCategory, Sector } from '@frontier/contracts';
import { categoryById, productCategoriesFor } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { CashAfter, Icon, Modal, SectorBadge, SliderField, Tag, ValidationBanner, roundStep, sectorIcon, sectorLabel } from '@/components/ui';
import { setPendingResearchNode, useActiveCompany, useGameActions, useSession } from '@/lib/game';
import { CAPACITY_KIND_LABEL } from './labels';
import { builtOnRows, industriesForCompany, lineLock, missingNodeTitles, supplyChoicesFrom, type SupplyChoiceMap } from './launchFlow';

export interface LaunchModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Set to open straight onto this line — e.g. from a Frontier Map node's "launch this" link. Null for the ordinary Industry-first flow. */
  readonly initialCategoryId?: string | null;
}

const STEPS = ['Industry', 'Line', 'Built on', 'Terms'] as const;
type Step = 0 | 1 | 2 | 3;

export function LaunchModal({ open, onClose, initialCategoryId = null }: LaunchModalProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const company = useActiveCompany();
  const session = useSession();

  const industries = useMemo(() => industriesForCompany(company), [company]);
  const [step, setStep] = useState<Step>(0);
  const [sector, setSector] = useState<Sector>(industries[0] ?? 'ai');
  const [categoryId, setCategoryId] = useState<string>(() => productCategoriesFor(industries[0] ?? 'ai')[0]?.id ?? '');
  const [supply, setSupply] = useState<SupplyChoiceMap>({});
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [intensity, setIntensity] = useState(0.4);
  const [quality, setQuality] = useState(0.6);
  const [marketing, setMarketing] = useState('250000');
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  // Opened from a Frontier Map "launch this" link: jump straight to the line
  // the node unlocks, skip Industry, and land wherever the line itself needs
  // — Built on if it declares inputs, Terms if it is a commodity.
  useEffect(() => {
    if (!open || initialCategoryId === null) return;
    const target = categoryById(initialCategoryId);
    if (target === undefined) return;
    setSector(target.sector);
    setCategoryId(target.id);
    setSupply({});
    setPrice(String(Math.round(target.referencePriceUsd)));
    setName(`${target.label} line`);
    const lock = lineLock(session, company, target);
    setStep(lock.locked ? 1 : target.inputs.length > 0 ? 2 : 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCategoryId]);

  const linesInSector = useMemo(() => productCategoriesFor(sector), [sector]);
  const category: ProductCategory | undefined = useMemo(() => linesInSector.find((entry) => entry.id === categoryId) ?? linesInSector[0], [linesInSector, categoryId]);
  const lock = useMemo(() => (category === undefined ? { locked: false, missingNodeIds: [] } : lineLock(session, company, category)), [session, company, category]);
  const lockedNodeTitles = useMemo(() => missingNodeTitles(session, lock.missingNodeIds), [session, lock.missingNodeIds]);
  const builtOn = useMemo(() => (category === undefined ? [] : builtOnRows(session, company, category)), [session, company, category]);

  function pickSector(next: Sector): void {
    setSector(next);
    const first = productCategoriesFor(next)[0];
    setCategoryId(first?.id ?? '');
    setStep(1);
  }

  function pickLine(next: ProductCategory): void {
    const nextLock = lineLock(session, company, next);
    if (nextLock.locked) return;
    setCategoryId(next.id);
    setSupply({});
    setPrice(String(Math.round(next.referencePriceUsd)));
    setName((current) => (current.trim().length > 0 ? current : `${next.label} line`));
    setStep(next.inputs.length > 0 ? 2 : 3);
  }

  const intent = useMemo<ActionIntent | null>(() => {
    if (category === undefined) return null;
    const priceValue = Number.parseFloat(price);
    const marketingValue = Number.parseFloat(marketing);
    if (name.trim().length === 0 || !Number.isFinite(priceValue) || priceValue < 0) return null;
    return {
      type: 'launch_product',
      name: name.trim().slice(0, 80),
      segment: category.buyerSegment,
      categoryId: category.id,
      pricePerSeatUsd: priceValue,
      computeIntensity: intensity,
      launchMarketingUsd: Number.isFinite(marketingValue) && marketingValue > 0 ? marketingValue : 0,
      targetQuality: quality,
      supply: supplyChoicesFrom(supply),
    };
  }, [category, name, price, intensity, quality, marketing, supply]);

  const preview = intent === null || step !== 3 ? null : validateIntent(intent);

  const priceValue = Math.max(0, Number.parseFloat(price) || 0);
  const priceMax = Math.max((category?.referencePriceUsd ?? 100) * 10, priceValue, 10);
  const marketingValue = Math.max(0, Number.parseFloat(marketing) || 0);
  const marketingMax = Math.max(company.financials.cash, marketingValue, 1_000_000);

  function submit(): void {
    if (intent === null) return;
    const entry = queueAction(intent);
    setResult(entry.validation);
  }

  function reset(): void {
    setStep(0);
    setSector(industries[0] ?? 'ai');
    const first = productCategoriesFor(industries[0] ?? 'ai')[0];
    setCategoryId(first?.id ?? '');
    setSupply({});
    setName('');
    setPrice('');
    setIntensity(0.4);
    setQuality(0.6);
    setMarketing('250000');
    setResult(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  function setSupplyChoice(inputCategoryId: string, supplierCompanyId: string | null, supplierProductId: string | null): void {
    setSupply((current) => ({ ...current, [inputCategoryId]: { supplierCompanyId, supplierProductId } }));
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Launch a product"
      subtitle="An attempt. The engine delivers the quality your capabilities support, not the quality you ask for."
      width="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => setStep((current) => (current - 1) as Step)}>
              Back
            </button>
          ) : null}
          {step === 3 ? (
            <button type="button" className="btn btn-primary" disabled={intent === null} onClick={submit}>
              Queue launch
            </button>
          ) : step === 2 ? (
            <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
              Continue to terms
            </button>
          ) : null}
        </>
      }
    >
      {/* --- breadcrumb -------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px]">
        {STEPS.map((label, index) => (
          <span key={label} className="flex items-center gap-1.5">
            {index > 0 ? <Icon name="chevronRight" size={12} accent="neutral" /> : null}
            <button
              type="button"
              disabled={index > step && index !== step}
              onClick={() => (index <= step ? setStep(index as Step) : undefined)}
              className={
                index === step
                  ? 'rounded-pill bg-brand-wash px-2 py-0.5 font-semibold text-brand'
                  : index < step
                    ? 'rounded-pill px-2 py-0.5 font-medium text-ink-dim hover:text-ink'
                    : 'rounded-pill px-2 py-0.5 font-medium text-ink-faint'
              }
            >
              {label}
            </button>
          </span>
        ))}
      </div>

      {/* --- step 0: industry --------------------------------------------- */}
      {step === 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {industries.map((option, index) => (
            <button
              key={option}
              type="button"
              onClick={() => pickSector(option)}
              className="tap-target flex flex-col items-start gap-1.5 rounded-card border border-hair bg-panel p-3 text-left transition-colors hover:bg-raised"
            >
              <span className="flex w-full items-center justify-between">
                <Icon name={sectorIcon(option)} size={18} accent="brand" />
                {index === 0 ? (
                  <Tag tone="brand" dot>
                    Your sector
                  </Tag>
                ) : null}
              </span>
              <span className="text-[13px] font-semibold text-ink">{sectorLabel(option)}</span>
              <span className="text-[10.5px] text-ink-faint">{productCategoriesFor(option).length} lines</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* --- step 1: line --------------------------------------------------- */}
      {step === 1 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <SectorBadge sector={sector} />
            <span className="text-[11px] text-ink-faint">Pick the industry line this product sells</span>
          </div>
          <div className="space-y-2">
            {linesInSector.map((option) => {
              const optionLock = lineLock(session, company, option);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={optionLock.locked}
                  onClick={() => pickLine(option)}
                  className={`tap-target w-full rounded-card border p-3 text-left transition-colors ${
                    optionLock.locked ? 'cursor-not-allowed border-hair bg-panel opacity-60' : 'border-hair bg-panel hover:bg-raised'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-ink">{option.label}</span>
                    <span className="figure text-[12px] text-ink-dim">
                      {formatMoney(option.referencePriceUsd, 'full')} <span className="text-ink-faint">/ {option.unitLabel}</span>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-faint">
                    <Tag>{CAPACITY_KIND_LABEL[option.capacityKind]}</Tag>
                    {option.inputs.length > 0 ? <Tag>{option.inputs.length} input{option.inputs.length === 1 ? '' : 's'}</Tag> : null}
                    {option.canSupply ? <Tag tone="brand">Publishable</Tag> : null}
                  </div>
                  {optionLock.locked ? (
                    <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[10.5px] text-warn">
                      <Icon name="warning" size={12} accent="current" />
                      Locked until you have {missingNodeTitles(session, optionLock.missingNodeIds).join(', ')}.
                      <Link
                        href="/research"
                        onClick={(event) => {
                          event.stopPropagation();
                          const nodeId = optionLock.missingNodeIds[0];
                          if (nodeId !== undefined) setPendingResearchNode(nodeId);
                        }}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        View in Research
                      </Link>
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* --- step 2: built on ------------------------------------------------ */}
      {step === 2 && category !== undefined ? (
        <div className="space-y-4">
          <p className="text-[11px] text-ink-faint">
            {category.label} is built on {builtOn.length} input{builtOn.length === 1 ? '' : 's'}. Leaving one on the open market is always legal — the
            category's own margin already prices it; naming a supplier lets their quality and price flow into yours.
          </p>
          {builtOn.map((row) => {
            const chosen = supply[row.input.categoryId] ?? { supplierCompanyId: null, supplierProductId: null };
            return (
              <div key={row.input.categoryId} className="rounded-card border border-hair bg-panel p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-ink">{row.category?.label ?? row.input.categoryId.replace(/_/g, ' ')}</span>
                  <Tag tone={row.input.required ? 'warn' : 'neutral'}>{row.input.required ? 'Required input' : 'Optional input'}</Tag>
                </div>
                <div className="mt-2 space-y-1.5">
                  {row.options.map((option) => {
                    const active = chosen.supplierCompanyId === option.supplierCompanyId && chosen.supplierProductId === option.supplierProductId;
                    return (
                      <button
                        key={`${option.kind}_${option.supplierCompanyId ?? 'open'}_${option.supplierProductId ?? ''}`}
                        type="button"
                        onClick={() => setSupplyChoice(row.input.categoryId, option.supplierCompanyId, option.supplierProductId)}
                        className={`tap-target flex w-full items-center justify-between gap-2 rounded-chip border px-2.5 py-1.5 text-left text-[11.5px] transition-colors ${
                          active ? 'border-brand bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim hover:text-ink'
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {active ? <Icon name="check" size={13} accent="current" /> : null}
                          {option.label}
                          {option.offer?.isDirectRival ? (
                            <Tag tone="warn" size="sm">
                              Direct rival
                            </Tag>
                          ) : null}
                        </span>
                        {option.offer !== null ? (
                          <span className="figure text-[10.5px] text-ink-faint">
                            {formatMoney(option.offer.pricePerUnitUsd, 'full')} · quality {formatPct(option.offer.qualityScore)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {row.options.length === 1 ? (
                    <p className="text-[10.5px] text-ink-faint">
                      Nobody publishes {row.category?.label.toLowerCase() ?? 'this input'} yet — it sells on the open market baseline until somebody
                      does.
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* --- step 3: terms ---------------------------------------------------- */}
      {step === 3 && category !== undefined ? (
        <div className="space-y-3.5">
          <div className="rounded-card border border-hair bg-panel p-2.5 text-[11px] text-ink-dim">
            <span className="font-semibold text-ink">{category.label}</span> · {sectorLabel(sector)} ·{' '}
            {formatMoney(category.referencePriceUsd, 'full')} reference / {category.unitLabel}
          </div>

          <label className="block">
            <span className="label-caps-faint mb-1 block">Product name</span>
            <input className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Ventures Copilot Pro" />
          </label>

          <SliderField
            label={`Launch price (per ${category.unitLabel})`}
            value={priceValue}
            onChange={(next) => setPrice(String(next))}
            min={0}
            max={priceMax}
            step={roundStep(priceMax)}
            format={formatMoney}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <SliderField
                label="Compute intensity"
                value={intensity}
                onChange={setIntensity}
                min={0.05}
                max={1}
                step={0.05}
                format={formatPct}
                exact={false}
              />
              <span className="mt-1 block text-[10px] text-ink-faint">Higher intensity buys quality and costs margin.</span>
            </div>
            <div>
              <SliderField
                label="Target quality"
                value={quality}
                onChange={setQuality}
                min={0.05}
                max={1}
                step={0.05}
                format={formatPct}
                exact={false}
              />
              <span className="mt-1 block text-[10px] text-ink-faint">Discounted by real capability and by how rushed the launch is.</span>
            </div>
          </div>

          <div>
            <SliderField
              label="Launch marketing"
              value={marketingValue}
              onChange={(next) => setMarketing(String(next))}
              min={0}
              max={marketingMax}
              step={roundStep(marketingMax)}
              format={formatMoney}
              chips
            />
            <span className="mt-1 block text-[10px] text-ink-faint">One-off spend, charged against this quarter&apos;s uncommitted cash.</span>
            <div className="mt-2">
              <CashAfter company={company} spendUsd={marketingValue} note="Charged in the quarter the product ships." />
            </div>
          </div>

          {builtOn.length === 0 ? null : (
            <div className="text-[11px] text-ink-dim">
              Built on: {builtOn.map((row) => `${row.category?.label ?? row.input.categoryId} → ${(supply[row.input.categoryId]?.supplierCompanyId === null || supply[row.input.categoryId] === undefined) ? 'open market' : row.options.find((option) => option.supplierCompanyId === supply[row.input.categoryId]?.supplierCompanyId)?.label ?? 'open market'}`).join('; ')}
            </div>
          )}

          <p className="text-[11px] text-ink-dim">
            A launch at {formatPct(quality)} target quality into {category.label} competes against the segment frontier from the quarter it ships.
            Nothing is promised: the resolution report will say what actually landed.
          </p>

          {result === null && preview !== null ? <ValidationBanner result={preview} compact /> : null}
          {result === null ? null : <ValidationBanner result={result} />}
        </div>
      ) : null}
    </Modal>
  );
}

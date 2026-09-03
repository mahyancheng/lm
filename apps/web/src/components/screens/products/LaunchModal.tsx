'use client';

/**
 * The launch ticket.
 *
 * A launch is an attempt, not an outcome: the engine delivers the target
 * quality discounted by what the company can actually build and by how rushed
 * the launch is, then prices demand against the segment the product lands in.
 * The modal states that plainly rather than promising the target.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult, ProductSegment } from '@frontier/contracts';
import { PRODUCT_SEGMENTS } from '@frontier/contracts';
import { SEGMENT_REFERENCE_PRICE_USD } from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import { CashAfter, Modal, SliderField, ValidationBanner, roundStep } from '@/components/ui';
import { useGameActions, usePlayerCompany } from '@/lib/game';
import { SEGMENT_BLURB, SEGMENT_LABEL, SEGMENT_UNIT } from './labels';

export interface LaunchModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function LaunchModal({ open, onClose }: LaunchModalProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const company = usePlayerCompany();
  const [name, setName] = useState('');
  const [segment, setSegment] = useState<ProductSegment>('enterprise');
  const [price, setPrice] = useState('60');
  const [intensity, setIntensity] = useState(0.4);
  const [quality, setQuality] = useState(0.6);
  const [marketing, setMarketing] = useState('250000');
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const intent = useMemo<ActionIntent | null>(() => {
    const priceValue = Number.parseFloat(price);
    const marketingValue = Number.parseFloat(marketing);
    if (name.trim().length === 0 || !Number.isFinite(priceValue) || priceValue < 0) return null;
    return {
      type: 'launch_product',
      name: name.trim().slice(0, 80),
      segment,
      pricePerSeatUsd: priceValue,
      computeIntensity: intensity,
      launchMarketingUsd: Number.isFinite(marketingValue) && marketingValue > 0 ? marketingValue : 0,
      targetQuality: quality,
    };
  }, [name, segment, price, intensity, quality, marketing]);

  const preview = intent === null ? null : validateIntent(intent);

  /* --- slider bounds ------------------------------------------------------ */
  const priceValue = Math.max(0, Number.parseFloat(price) || 0);
  // Four times the engine's published segment reference: demand collapses long
  // before that, so it is the whole range a launch price argument lives in.
  const priceMax = Math.max(SEGMENT_REFERENCE_PRICE_USD[segment] * 4, priceValue, 10);
  const marketingValue = Math.max(0, Number.parseFloat(marketing) || 0);
  // Not a cap: launch marketing is never cut back to the balance any more, so the
  // range stays usable on an overdrawn company and the preview says what it costs.
  const marketingMax = Math.max(company.financials.cash, marketingValue, 1_000_000);

  function submit(): void {
    if (intent === null) return;
    const entry = queueAction(intent);
    setResult(entry.validation);
  }

  function close(): void {
    setResult(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Launch a product"
      subtitle="An attempt. The engine delivers the quality your capabilities support, not the quality you ask for."
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={intent === null} onClick={submit}>
            Queue launch
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <label className="block">
          <span className="label-caps-faint mb-1 block">Product name</span>
          <input className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Ventures Copilot Pro" />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint mb-1 block">Segment</span>
            <select className="field" value={segment} onChange={(event) => setSegment(event.target.value as ProductSegment)}>
              {PRODUCT_SEGMENTS.map((option) => (
                <option key={option} value={option}>
                  {SEGMENT_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <SliderField
            label={`Launch price (${SEGMENT_UNIT[segment]})`}
            value={priceValue}
            onChange={(next) => setPrice(String(next))}
            min={0}
            max={priceMax}
            step={roundStep(priceMax)}
            format={formatMoney}
          />
        </div>

        <p className="text-[10px] text-ink-faint">{SEGMENT_BLURB[segment]}</p>

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

        <p className="text-[11px] text-ink-dim">
          A launch at {formatPct(quality)} target quality into {SEGMENT_LABEL[segment]} competes against the segment frontier from the quarter it
          ships. Nothing is promised: the resolution report will say what actually landed.
        </p>

        {result === null && preview !== null ? <ValidationBanner result={preview} compact /> : null}
        {result === null ? null : <ValidationBanner result={result} />}
      </div>
    </Modal>
  );
}

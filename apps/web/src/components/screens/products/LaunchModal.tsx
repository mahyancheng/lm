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
import { formatMoney, formatPct } from '@frontier/shared';
import { Modal, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { SEGMENT_BLURB, SEGMENT_LABEL, SEGMENT_UNIT } from './labels';

export interface LaunchModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function LaunchModal({ open, onClose }: LaunchModalProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
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
          <label className="block">
            <span className="label-caps-faint mb-1 block">Launch price ({SEGMENT_UNIT[segment]})</span>
            <input className="field" type="number" min={0} step="1" value={price} onChange={(event) => setPrice(event.target.value)} />
          </label>
        </div>

        <p className="text-[10px] text-ink-faint">{SEGMENT_BLURB[segment]}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint mb-1 flex items-baseline justify-between">
              <span>Compute intensity</span>
              <span className="figure text-ink-dim">{intensity.toFixed(2)}</span>
            </span>
            <input
              className="tap-target w-full"
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={intensity}
              onChange={(event) => setIntensity(Number(event.target.value))}
            />
            <span className="mt-1 block text-[10px] text-ink-faint">Higher intensity buys quality and costs margin.</span>
          </label>
          <label className="block">
            <span className="label-caps-faint mb-1 flex items-baseline justify-between">
              <span>Target quality</span>
              <span className="figure text-ink-dim">{quality.toFixed(2)}</span>
            </span>
            <input
              className="tap-target w-full"
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
            />
            <span className="mt-1 block text-[10px] text-ink-faint">Discounted by real capability and by how rushed the launch is.</span>
          </label>
        </div>

        <label className="block">
          <span className="label-caps-faint mb-1 block">Launch marketing</span>
          <input className="field" type="number" min={0} step="10000" value={marketing} onChange={(event) => setMarketing(event.target.value)} />
          <span className="mt-1 block text-[10px] text-ink-faint">
            One-off spend, {formatMoney(Number.parseFloat(marketing) || 0)}. Charged against this quarter&apos;s uncommitted cash.
          </span>
        </label>

        <p className="text-[11px] text-ink-dim">
          A launch at {formatPct(quality, 0)} target quality into {SEGMENT_LABEL[segment]} competes against the segment frontier from the quarter it
          ships. Nothing is promised: the resolution report will say what actually landed.
        </p>

        {result === null && preview !== null ? <ValidationBanner result={preview} compact /> : null}
        {result === null ? null : <ValidationBanner result={result} />}
      </div>
    </Modal>
  );
}

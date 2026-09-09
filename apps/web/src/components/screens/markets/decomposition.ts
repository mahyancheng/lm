/**
 * Reading the return decomposition out of the ledger.
 *
 * "Why did my stock move?" is answered from committed rows, never from a
 * narrator. The `market_priced` event carries the seven components and their
 * total exactly as the pricing model produced them, and this module parses that
 * payload defensively — the payload shape is engine-internal, so every field is
 * checked rather than assumed.
 */

import type { SimEvent } from '@frontier/contracts';

export interface DecompositionComponent {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** One line on why this term moved the price. */
  readonly note: string;
}

export interface DecompositionView {
  readonly eventId: string;
  readonly instrumentId: string;
  readonly quarter: number;
  readonly symbol: string | null;
  readonly components: readonly DecompositionComponent[];
  readonly total: number;
  /** Sum of the seven components; equals `total` within the engine's tolerance. */
  readonly sum: number;
  readonly reconciles: boolean;
  readonly priceBefore: number;
  readonly priceAfter: number;
  readonly floored: boolean;
  readonly volume: number | null;
  readonly marketCapUsd: number | null;
}

const COMPONENT_META: readonly { readonly key: string; readonly label: string; readonly note: string }[] = [
  { key: 'marketBeta', label: 'Market factor', note: 'The whole in-world market, scaled by this instrument’s beta.' },
  { key: 'sectorBeta', label: 'Sector factor', note: 'Sentiment, demand and multiple in this instrument’s sector.' },
  { key: 'fundamentalAlpha', label: 'Fundamental pull', note: 'The pull toward the valuation anchor: what was actually delivered.' },
  { key: 'publicInfoEffect', label: 'Public information', note: 'Guidance, earnings, awards and leaks that became public this quarter.' },
  { key: 'sentimentEffect', label: 'Sentiment', note: 'Narrative unsupported by fundamentals — the euphoria and the panic.' },
  { key: 'liquidityEffect', label: 'Trading flow', note: 'Index inclusion, block purchases, forced selling.' },
  { key: 'noise', label: 'Idiosyncratic noise', note: 'The residual term, drawn from the seeded RNG. Deterministic given the seed.' },
];

const TOLERANCE = 1e-9;

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parse one `market_priced` row, or return null when it is not one. */
export function decompositionOf(event: SimEvent): DecompositionView | null {
  if (event.type !== 'market_priced' || event.targetId === null) return null;
  const payload = event.payload;
  const raw = asRecord(payload.decomposition);
  if (raw === null) return null;

  const components: DecompositionComponent[] = [];
  for (const meta of COMPONENT_META) {
    const value = numberAt(raw, meta.key);
    if (value === null) return null;
    components.push({ key: meta.key, label: meta.label, value, note: meta.note });
  }

  const total = numberAt(raw, 'total') ?? components.reduce((sum, component) => sum + component.value, 0);
  const sum = components.reduce((accumulator, component) => accumulator + component.value, 0);

  return {
    eventId: event.eventId,
    instrumentId: event.targetId,
    quarter: event.quarter,
    symbol: stringAt(payload, 'symbol'),
    components,
    total,
    sum,
    reconciles: Math.abs(sum - total) <= Math.max(TOLERANCE, Math.abs(total) * 1e-9),
    priceBefore: numberAt(payload, 'priceBefore') ?? 0,
    priceAfter: numberAt(payload, 'priceAfter') ?? 0,
    floored: payload.floored === true,
    volume: numberAt(payload, 'volume'),
    marketCapUsd: numberAt(payload, 'marketCapUsd'),
  };
}

/** Every decomposition in a resolution's event list, keyed by instrument id. */
export function decompositionsFrom(events: readonly SimEvent[]): Map<string, DecompositionView> {
  const out = new Map<string, DecompositionView>();
  for (const event of events) {
    const parsed = decompositionOf(event);
    if (parsed !== null) out.set(parsed.instrumentId, parsed);
  }
  return out;
}

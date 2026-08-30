/**
 * @frontier/simulation — government/util.ts
 *
 * Deterministic helpers for the procurement subsystem. Nothing here reads a
 * clock or a random source; `emitEvent` is a typed wrapper over
 * `ResolverContext.emit`.
 */

import type { Company, LedgerVisibility, ResolverContext, SessionState, SimEventType, TechCapabilityArea } from '@frontier/contracts';

/** Clamp `value` into `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into the 0..1 unit interval used by every score axis. */
export function unit(value: number): number {
  return clamp(value, 0, 1);
}

/** Clamp into the 0..100 range used by past performance and reputations. */
export function score100(value: number): number {
  return clamp(value, 0, 100);
}

/** Round to `dp` decimal places. */
export function round(value: number, dp = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** Round a dollar amount to whole cents and floor it at zero. */
export function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 100) / 100);
}

/** Safe division that returns `fallback` rather than infinity or NaN. */
export function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/** Format a dollar amount compactly for a resolution line. */
export function usdLabel(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Trim a report line to the contract's 300-character ceiling. */
export function line(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

/** Emit a ledger row and return its assigned id. */
export function emitEvent(
  draft: SessionState,
  ctx: ResolverContext,
  type: SimEventType,
  actorId: string | null,
  targetId: string | null,
  payload: Record<string, unknown>,
  visibility: LedgerVisibility,
): string {
  return ctx.emit({ sessionId: draft.sessionId, quarter: ctx.quarter, type, actorId, targetId, payload, visibility });
}

/* -------------------------------------------------------------------------- */
/*  Company reads                                                              */
/* -------------------------------------------------------------------------- */

export function companyById(draft: SessionState, id: string): Company | null {
  return draft.companies.find((c) => c.id === id) ?? null;
}

/** One capability area, defaulting to zero for an area a company has no strength in. */
export function capabilityOf(company: Company, area: TechCapabilityArea): number {
  return unit(company.techCapabilities[area] ?? 0);
}

/** Mean capability across several areas. */
export function meanCapability(company: Company, areas: readonly TechCapabilityArea[]): number {
  if (areas.length === 0) return 0;
  let sum = 0;
  for (const area of areas) sum += capabilityOf(company, area);
  return unit(sum / areas.length);
}

/** Total headcount across the five roles. */
export function headcount(company: Company): number {
  const e = company.employees;
  return e.engineers + e.researchers + e.sales + e.ops + e.execs;
}

/** Accelerator-equivalents the company controls outright this quarter. */
export function heldCompute(company: Company): number {
  return company.compute.ownedAccelerators + company.compute.reservedAccelerators;
}

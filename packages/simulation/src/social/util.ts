/**
 * @frontier/simulation — social/util.ts
 *
 * Deterministic helpers for the social and media subsystem.
 */

import type { Character, Company, LedgerVisibility, ResolverContext, SessionState, SimEventType } from '@frontier/contracts';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const unit = (value: number): number => clamp(value, 0, 1);
export const score100 = (value: number): number => clamp(value, 0, 100);
export const bipolar = (value: number): number => clamp(value, -1, 1);

export function round(value: number, dp = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/** Format a reach figure compactly for a resolution line. */
export function reachLabel(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m reached`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k reached`;
  return `${Math.round(value)} reached`;
}

/** Trim a report line to the contract's 300-character ceiling. */
export function line(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

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

export function characterById(draft: SessionState, id: string): Character | null {
  return draft.characters.find((c) => c.id === id) ?? null;
}

export function companyById(draft: SessionState, id: string): Company | null {
  return draft.companies.find((c) => c.id === id) ?? null;
}

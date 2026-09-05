/**
 * @frontier/simulation — boards/util.ts
 *
 * Deterministic helpers for the governance subsystem.
 */

import type { Board, Company, LedgerVisibility, ResolverContext, SessionState, SimEventType } from '@frontier/contracts';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const unit = (value: number): number => clamp(value, 0, 1);
export const score100 = (value: number): number => clamp(value, 0, 100);
export const signedScore100 = (value: number): number => clamp(value, -100, 100);
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

/** Centre a 0..100 trait on zero and stretch it to -1..1. */
export function centred(trait100: number): number {
  return clamp((trait100 / 100 - 0.5) * 2, -1, 1);
}

/** Normalise a 0..100 trait into 0..1. */
export function normalised(trait100: number): number {
  return unit(trait100 / 100);
}

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

export function companyById(draft: SessionState, id: string): Company | null {
  return draft.companies.find((c) => c.id === id) ?? null;
}

export function boardById(draft: SessionState, id: string): Board | null {
  return draft.boards.find((b) => b.id === id) ?? null;
}

/** The board governing a company, by id or by back-reference. */
export function boardForCompany(draft: SessionState, companyId: string): Board | null {
  const company = companyById(draft, companyId);
  if (company?.boardId != null) {
    const byId = boardById(draft, company.boardId);
    if (byId !== null) return byId;
  }
  return draft.boards.find((b) => b.companyId === companyId) ?? null;
}

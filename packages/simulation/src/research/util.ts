/**
 * @frontier/simulation — research/util.ts
 *
 * Deterministic helpers for the research subsystem. Kept local to the directory
 * so the research code has no dependency on any other subsystem's internals.
 */

import type {
  Company,
  LedgerVisibility,
  ResearchProject,
  ResolverContext,
  SessionState,
  SimEventType,
  TechCapabilityArea,
  TechNode,
} from '@frontier/contracts';
import { TECH_CAPABILITY_AREAS } from '@frontier/contracts';

/** Clamp `value` into `[min, max]`; non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into the 0..1 unit interval. */
export function unit(value: number): number {
  return clamp(value, 0, 1);
}

/** Clamp into the 0..100 score range. */
export function score(value: number): number {
  return clamp(value, 0, 100);
}

/** Round a monetary value to cents, floored at zero. */
export function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 100) / 100);
}

/** Safe division. */
export function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/** Emit a ledger row and return its id. */
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

/**
 * Ledger visibility for something that happened inside a programme. A secret
 * programme's events never reach the company tier, let alone the public one:
 * `docs/SIMULATION.md` §5, private facts do not automatically become public.
 */
export function projectVisibility(project: ResearchProject): LedgerVisibility {
  return project.isSecret ? 'private' : 'company';
}

/** Find a node by id in the session graph. */
export function findNode(draft: SessionState, nodeId: string): TechNode | undefined {
  return draft.techGraph.nodes.find((n) => n.id === nodeId);
}

/** Find a company by id. */
export function findCompany(draft: SessionState, companyId: string): Company | undefined {
  return draft.companies.find((c) => c.id === companyId);
}

/** True when `area` is one of the twelve recognised capability areas. */
export function isCapabilityArea(area: string): area is TechCapabilityArea {
  return (TECH_CAPABILITY_AREAS as readonly string[]).includes(area);
}

/** A company's strength in one capability area, 0 when it has none. */
export function capabilityIn(company: Company, area: string): number {
  const value = company.techCapabilities[area];
  return value === undefined ? 0 : value;
}

/**
 * How well a company's capabilities cover a node's requirements, 0..1. A node
 * with no stated requirements is fully covered: it needs no specialism.
 */
export function capabilityCoverage(company: Company, requirements: readonly string[]): number {
  if (requirements.length === 0) return 1;
  let sum = 0;
  for (const area of requirements) sum += capabilityIn(company, area);
  return unit(sum / requirements.length);
}

/** Mark the graph as changed: bump the version so stale clients can tell. */
export function bumpGraphVersion(draft: SessionState, ctx: ResolverContext): void {
  draft.techGraph.version += 1;
  draft.techGraph.updatedQuarter = ctx.quarter;
}

/** Format a fraction as a signed percentage-point label. */
export function ppLabel(delta: number): string {
  const pp = delta * 100;
  const sign = pp >= 0 ? '+' : '';
  return `${sign}${pp.toFixed(1)}pp`;
}

/** Format a dollar amount compactly. */
export function usdLabel(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

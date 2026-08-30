/**
 * @frontier/simulation — companies/util.ts
 *
 * Small deterministic helpers shared by the company subsystems.
 *
 * Nothing here reads a clock or a random source. Every function is pure except
 * `emitEvent`, which is a thin typed wrapper over `ResolverContext.emit`.
 */

import type {
  ActionIntent,
  Company,
  LedgerVisibility,
  ProductSegment,
  ResolverContext,
  SessionState,
  SimEventType,
  StaffRole,
  SubmittedAction,
} from '@frontier/contracts';
import { MONEY_PRECISION, TALENT_REPUTATION_WEIGHTS } from './balance';

/* -------------------------------------------------------------------------- */
/*  Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/** Clamp `value` into `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into the 0..1 unit interval used by most contract scalars. */
export function unit(value: number): number {
  return clamp(value, 0, 1);
}

/** Clamp into the 0..100 score range used by reputations and morale. */
export function score(value: number): number {
  return clamp(value, 0, 100);
}

/** Round a monetary value to the engine's stored precision and floor it at zero. */
export function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** MONEY_PRECISION;
  return Math.max(0, Math.round(value * factor) / factor);
}

/** Round a monetary value that may legitimately be negative (equity, cash flow). */
export function signedMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** MONEY_PRECISION;
  return Math.round(value * factor) / factor;
}

/** Round to a whole non-negative count (headcount, customers, units). */
export function count(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/** Safe division that returns `fallback` rather than infinity or NaN. */
export function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/** Format a fraction as a signed percentage label for a resolution line. */
export function pctLabel(fraction: number): string {
  const pct = fraction * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
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

/* -------------------------------------------------------------------------- */
/*  Ledger                                                                     */
/* -------------------------------------------------------------------------- */

/** Emit a ledger row and return its assigned id, so a report line can reference it. */
export function emitEvent(
  draft: SessionState,
  ctx: ResolverContext,
  type: SimEventType,
  actorId: string | null,
  targetId: string | null,
  payload: Record<string, unknown>,
  visibility: LedgerVisibility,
): string {
  return ctx.emit({
    sessionId: draft.sessionId,
    quarter: ctx.quarter,
    type,
    actorId,
    targetId,
    payload,
    visibility,
  });
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every action queued for this quarter on behalf of `companyId`, in submission
 * order. `action_collection` has already reduced `pendingActions` to the
 * accepted and clamped set, so anything still here is meant to run.
 */
export function companyActions(draft: SessionState, ctx: ResolverContext, companyId: string): SubmittedAction[] {
  return draft.pendingActions
    .filter((a) => a.quarter === ctx.quarter && a.actorCompanyId === companyId)
    .sort((a, b) => a.sequence - b.sequence);
}

/** Narrow a submitted action's intent to one discriminated member. */
export function intentsOfType<T extends ActionIntent['type']>(
  actions: readonly SubmittedAction[],
  type: T,
): { action: SubmittedAction; intent: Extract<ActionIntent, { type: T }> }[] {
  const out: { action: SubmittedAction; intent: Extract<ActionIntent, { type: T }> }[] = [];
  for (const action of actions) {
    if (action.intent.type === type) {
      out.push({ action, intent: action.intent as Extract<ActionIntent, { type: T }> });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Company reads                                                              */
/* -------------------------------------------------------------------------- */

/** Active companies in stable array order. */
export function activeCompanies(draft: SessionState): Company[] {
  return draft.companies.filter((c) => c.isActive);
}

/** Total headcount across the five roles. */
export function totalHeadcount(company: Company): number {
  const e = company.employees;
  return e.engineers + e.researchers + e.sales + e.ops + e.execs;
}

/** Read one role's headcount. */
export function roleHeadcount(company: Company, role: StaffRole): number {
  return company.employees[role];
}

/** Write one role's headcount, flooring at zero. */
export function setRoleHeadcount(company: Company, role: StaffRole, value: number): void {
  company.employees[role] = count(value);
}

/**
 * A company's standing with the technical talent market. There is no
 * `reputation.talent` field: talent judges a company by its developer standing
 * first, its public standing second and its investor standing last.
 */
export function talentReputation(company: Company): number {
  const r = company.reputation;
  return (
    r.developer * TALENT_REPUTATION_WEIGHTS.developer +
    r.public * TALENT_REPUTATION_WEIGHTS.public +
    r.investor * TALENT_REPUTATION_WEIGHTS.investor
  );
}

/** Mean capability across the areas the company has any strength in, 0 when it has none. */
export function capabilityIndex(company: Company): number {
  const values = Object.values(company.techCapabilities);
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return unit(sum / values.length);
}

/** The reputation score a segment's buyers apply, 0..100. */
export function segmentReputation(company: Company, audience: 'public' | 'developer' | 'enterprise' | 'government'): number {
  return company.reputation[audience];
}

/** Active products of a company, in stable array order. */
export function activeProducts(company: Company): Company['products'] {
  return company.products.filter((p) => p.isActive);
}

/** Sector demand for a company's primary sector, defaulting to the neutral midpoint. */
export function sectorDemand(draft: SessionState, sectorId: string): number {
  const sector = draft.sectors[sectorId];
  return sector === undefined ? 0.5 : sector.demand;
}

/**
 * The reference price a product's own price is judged against: the
 * customer-weighted mean price of every active product in the same segment
 * across the session — in effect the segment's average revenue per customer.
 *
 * Weighting by customers rather than taking a flat mean keeps one exotic
 * product (a handful of very large capacity contracts, say) from dragging the
 * whole segment's reference with it. Pricing is relative to the market a
 * product actually competes in, never to a designer constant; the constant is
 * only the fallback for a segment nobody sells into yet.
 */
export function segmentReferencePrice(draft: SessionState, segment: ProductSegment, fallback: number): number {
  let revenue = 0;
  let customers = 0;
  let priceSum = 0;
  let n = 0;
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    for (const product of company.products) {
      if (!product.isActive || product.segment !== segment || product.pricePerSeat <= 0) continue;
      revenue += product.pricePerSeat * product.activeCustomers;
      customers += product.activeCustomers;
      priceSum += product.pricePerSeat;
      n += 1;
    }
  }
  if (customers > 0) return revenue / customers;
  return n === 0 ? fallback : priceSum / n;
}

/**
 * The best quality on offer in a segment, blended with the world frontier. A
 * product is judged against the market it actually competes in and against how
 * good the state of the art has become.
 */
export function segmentFrontierQuality(draft: SessionState, segment: ProductSegment): number {
  let best = 0;
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    for (const product of company.products) {
      if (!product.isActive || product.segment !== segment) continue;
      if (product.qualityScore > best) best = product.qualityScore;
    }
  }
  return unit(0.5 * best + 0.5 * draft.world.aiFrontier.frontierCapability);
}

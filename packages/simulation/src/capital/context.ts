/**
 * @frontier/simulation — capital/context.ts
 *
 * The lookups every capital desk shares, and the two rules that govern them.
 *
 * **The identity rule.** `CapitalEntity.id` *is* the cap-table holder id, so a
 * fund's portfolio is read straight off the registers rather than out of a
 * second ledger. Nothing in this directory ever writes a holding the ownership
 * invariant would not already sum.
 *
 * **The dry-powder rule.** Every movement of `dryPowderUsd` goes through
 * `moveDryPowder`, which returns the whole-dollar delta actually applied, and
 * every caller writes that delta onto the ledger row it emits as
 * `dryPowderDeltaUsd`. `capital_integrity` reconstructs the quarter's movement
 * from exactly those fields, so a movement no row declares fails the gate — the
 * same discipline `financial_integrity` applies to a company's equity.
 */

import type {
  CapTable,
  CapitalEntity,
  Company,
  CompanyQuarterMetrics,
  Holding,
  Quote,
  ResolverContext,
  SeededRng,
  Security,
  SessionState,
  ValuationAnchor,
} from '@frontier/contracts';
import { CAPITAL_DESK_ORDER_BUDGET, DRY_POWDER_FLOOR_PCT } from '@frontier/contracts';
import { isMultiSectorWorld } from '../economy/sectors';

/* -------------------------------------------------------------------------- */
/*  The per-quarter desk context                                               */
/* -------------------------------------------------------------------------- */

/**
 * One quarter's worth of shared lookups.
 *
 * Built once per phase and thrown away, exactly like `companyMetrics`: caching
 * it on state would drift the first time a cost basis was rebased.
 */
export interface DeskContext {
  readonly draft: SessionState;
  readonly ctx: ResolverContext;
  readonly quarter: number;
  readonly rng: SeededRng;
  /** The roster in declaration order. Ties everywhere break by this order, then by company id. */
  readonly entities: readonly CapitalEntity[];
  /** Session-wide ceiling on rows this layer may produce in one quarter. */
  readonly budget: OrderBudget;
  companyOf(companyId: string): Company | null;
  metricsOf(companyId: string): CompanyQuarterMetrics | null;
  anchorOf(companyId: string): ValuationAnchor | null;
  capTableOf(companyId: string): CapTable | null;
  primarySecurityOf(companyId: string): Security | null;
  lastQuoteOf(company: Company): Quote | null;
}

/**
 * The work budget, applied after every per-entity cap.
 *
 * Eleven institutions scoring twenty-four companies is trivial arithmetic; the
 * *output* is what has to be bounded, or the feed and the save both grow without
 * limit. For comparison, the whole world's social output is capped at fifteen
 * posts a quarter.
 */
export class OrderBudget {
  private used = 0;

  constructor(private readonly ceiling: number = CAPITAL_DESK_ORDER_BUDGET) {}

  get remaining(): number {
    return Math.max(0, this.ceiling - this.used);
  }

  get spent(): number {
    return this.used;
  }

  /** Claim one row. False when the budget is exhausted, and the caller does nothing at all. */
  take(): boolean {
    if (this.used >= this.ceiling) return false;
    this.used += 1;
    return true;
  }
}

/** Whether the capital layer runs at all. World 1 is frozen and grows no capital state. */
export function capitalDesksEnabled(draft: SessionState): boolean {
  if (!isMultiSectorWorld(draft)) return false;
  const entities = draft.capitalEntities;
  return entities !== undefined && entities.length > 0;
}

/** Build the shared lookups for one quarter. */
export function deskContext(draft: SessionState, ctx: ResolverContext, forkLabel: string): DeskContext {
  const companies = new Map(draft.companies.map((company) => [company.id, company] as const));
  const metrics = new Map(draft.companyMetrics.map((row) => [row.companyId, row] as const));
  const anchors = new Map(draft.valuationAnchors.map((row) => [row.companyId, row] as const));
  const tables = new Map(draft.capTables.map((table) => [table.companyId, table] as const));
  const securities = new Map<string, Security>();
  for (const security of draft.securities) {
    if (!securities.has(security.companyId)) securities.set(security.companyId, security);
  }

  return {
    draft,
    ctx,
    quarter: ctx.quarter,
    // A fork, never the phase stream itself: the desks must not shift the draw
    // sequence of any other consumer in their phase.
    rng: ctx.rng.fork(forkLabel),
    entities: (draft.capitalEntities ?? []).filter((entity) => entity.isActive),
    budget: new OrderBudget(),
    companyOf: (companyId) => companies.get(companyId) ?? null,
    metricsOf: (companyId) => metrics.get(companyId) ?? null,
    anchorOf: (companyId) => anchors.get(companyId) ?? null,
    capTableOf: (companyId) => tables.get(companyId) ?? null,
    primarySecurityOf: (companyId) => {
      const company = companies.get(companyId);
      if (company !== undefined && company.primarySecurityId !== null) {
        const named = draft.securities.find((candidate) => candidate.id === company.primarySecurityId);
        if (named !== undefined) return named;
      }
      return securities.get(companyId) ?? null;
    },
    lastQuoteOf: (company) => latestQuote(draft, company.instrumentId, ctx.quarter),
  };
}

/** The last quote at or before `quarter`, or null. */
export function latestQuote(draft: SessionState, instrumentId: string | null, quarter: number): Quote | null {
  if (instrumentId === null) return null;
  let best: Quote | null = null;
  for (const quote of draft.quotes) {
    if (quote.instrumentId !== instrumentId || quote.quarter > quarter) continue;
    if (best === null || quote.quarter > best.quarter) best = quote;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  Reading a fund's positions off the registers                               */
/* -------------------------------------------------------------------------- */

/** Every live holding this entity has, in cap-table order. A short is never one of these. */
export function holdingsOf(draft: SessionState, entityId: string): { table: CapTable; holding: Holding }[] {
  const out: { table: CapTable; holding: Holding }[] = [];
  for (const table of draft.capTables) {
    for (const holding of table.holdings) {
      if (holding.holderId !== entityId || holding.holderKind !== 'fund' || holding.shares <= 0) continue;
      out.push({ table, holding });
    }
  }
  return out;
}

/** Shares issued in the class a security belongs to. */
export function issuedSharesFor(draft: SessionState, table: CapTable, securityId: string): number {
  const security = draft.securities.find((candidate) => candidate.id === securityId);
  if (security === undefined) return 0;
  const declared = table.totalIssuedByClass[security.shareClassId];
  if (declared !== undefined && declared > 0) return declared;
  return table.shareClasses.find((klass) => klass.id === security.shareClassId)?.issuedShares ?? 0;
}

/** One holder's stake in a company as a 0..1 fraction of the issued class. */
export function stakeFractionOf(draft: SessionState, companyId: string, holderId: string): number {
  const table = draft.capTables.find((candidate) => candidate.companyId === companyId);
  if (table === undefined) return 0;
  let issued = 0;
  for (const klass of table.shareClasses) issued += klass.issuedShares;
  if (issued <= 0) return 0;
  let held = 0;
  for (const holding of table.holdings) {
    if (holding.holderId === holderId) held += holding.shares;
  }
  return held / issued;
}

/** Shares sitting in the public float of one security. */
export function floatSharesOf(table: CapTable, securityId: string): number {
  let shares = 0;
  for (const holding of table.holdings) {
    if (holding.securityId === securityId && holding.holderKind === 'public_float') shares += holding.shares;
  }
  return shares;
}

/** Cost basis across every live holding. Derived, never stored. */
export function deployedUsd(draft: SessionState, entityId: string): number {
  let deployed = 0;
  for (const { holding } of holdingsOf(draft, entityId)) deployed += holding.costBasisUsd;
  return Math.round(deployed);
}

/** What one holding is marked at: the quote where there is one, the anchor otherwise. */
export function markValueUsd(desk: DeskContext, table: CapTable, holding: Holding): number {
  const company = desk.companyOf(table.companyId);
  if (company === null) return 0;
  const quote = desk.lastQuoteOf(company);
  if (quote !== null && quote.price > 0) return Math.round(holding.shares * quote.price);
  const issued = issuedSharesFor(desk.draft, table, holding.securityId);
  if (issued <= 0) return 0;
  const anchor = desk.anchorOf(company.id);
  const metrics = desk.metricsOf(company.id);
  const value = anchor?.anchorValueUsd ?? metrics?.marketCapUsd ?? 0;
  return Math.round((holding.shares / issued) * value);
}

/** Marked portfolio plus dry powder: the entity's net asset value. */
export function navUsd(desk: DeskContext, entity: CapitalEntity): number {
  let value = entity.dryPowderUsd;
  for (const { table, holding } of holdingsOf(desk.draft, entity.id)) value += markValueUsd(desk, table, holding);
  return Math.round(value);
}

/**
 * What a company is worth for the purpose of pricing a financing.
 *
 * The market's own answer first, then the fundamental anchor, then a revenue
 * multiple. Deliberately the same order the capital phase uses when it prices a
 * requested round: an offered round and a requested one must price off the same
 * view of the company, or the offer card would quote a number the close then
 * contradicts.
 */
export function estimatedValuationUsd(desk: DeskContext, company: Company): number {
  const metrics = desk.metricsOf(company.id);
  if (company.isPublic && metrics !== null && metrics.marketCapUsd > 0) return Math.round(metrics.marketCapUsd);

  const anchor = desk.anchorOf(company.id);
  if (anchor !== null && anchor.anchorValueUsd > 0) return Math.round(anchor.anchorValueUsd);
  if (metrics !== null && metrics.enterpriseValueUsd > 0) return Math.round(metrics.enterpriseValueUsd);

  const sector = desk.draft.sectors[company.sectorId];
  const multiple = (sector?.multiple ?? 1) * desk.draft.world.capitalMarkets.sectorMultiples;
  const revenueRun = company.financials.revenueQuarterly * 4;
  return Math.round(Math.max(1_000_000, revenueRun * 6 * multiple + company.financials.cash));
}

/* -------------------------------------------------------------------------- */
/*  Dry powder                                                                 */
/* -------------------------------------------------------------------------- */

/** Capital an entity may never deploy, whatever the score says. */
export function reservedFloorUsd(entity: CapitalEntity): number {
  return Math.round((entity.committedCapitalUsd * DRY_POWDER_FLOOR_PCT) / 100);
}

/** Dry powder above the reserve floor: what the desk may actually spend this quarter. */
export function deployableUsd(entity: CapitalEntity): number {
  return Math.max(0, entity.dryPowderUsd - reservedFloorUsd(entity));
}

/**
 * Move dry powder and return the whole-dollar delta actually applied.
 *
 * The return value is the number the caller must put on its ledger row as
 * `dryPowderDeltaUsd`. Two clamps, and both are economic rather than defensive:
 *
 * - a charge stops at the balance rather than driving it negative, so
 *   `capital_integrity` never sees a fund spending money it does not have; and
 * - a credit stops at **committed capital**, because cash a fund holds above the
 *   size it raised is not dry powder — it has been distributed to its investors
 *   and has left the game. Without that ceiling a fund that trebled its money
 *   would compound into an unbounded buyer, which is precisely the failure mode
 *   that makes an AI competitor with a large balance sheet *easier* rather than
 *   harder to play against.
 *
 * Either way the row states exactly what moved, which is what the reconstruction
 * reads.
 */
export function moveDryPowder(entity: CapitalEntity, deltaUsd: number): number {
  const wanted = Math.round(deltaUsd);
  if (wanted === 0) return 0;
  const applied = wanted < 0 ? -Math.min(entity.dryPowderUsd, -wanted) : Math.min(wanted, Math.max(0, entity.committedCapitalUsd - entity.dryPowderUsd));
  if (applied === 0) return 0;
  entity.dryPowderUsd = Math.max(0, Math.round(entity.dryPowderUsd + applied));
  return applied;
}

/**
 * Record a realised distribution.
 *
 * The **whole** of the proceeds counts toward `realisedProceedsUsd`, because DPI
 * is cash returned to investors and that is exactly what this is — including the
 * part that goes straight past the fund to its LPs. Only the part that stays
 * inside the committed size becomes spendable dry powder again, and only that
 * part is returned for the ledger row.
 */
export function creditRealised(entity: CapitalEntity, proceedsUsd: number): number {
  const proceeds = Math.max(0, Math.round(proceedsUsd));
  const applied = moveDryPowder(entity, proceeds);
  entity.realisedProceedsUsd = Math.round(entity.realisedProceedsUsd + proceeds);
  return applied;
}

/* -------------------------------------------------------------------------- */
/*  Memory: the cooldown ledger                                                */
/* -------------------------------------------------------------------------- */

/**
 * Push one act onto the entity's bounded memory.
 *
 * Cooldowns are measured against `memory[].quarter` rather than re-scanned out
 * of the ledger, because the ledger is pruned and the memory is the state the
 * desk actually reasons from.
 */
export function remember(entity: CapitalEntity, entry: CapitalEntity['memory'][number], limit: number): void {
  entity.memory = [...entity.memory, entry].slice(-limit);
}

/** The most recent quarter this entity did `kind` to `companyId`, or null. */
export function lastActQuarter(entity: CapitalEntity, companyId: string, kind: CapitalEntity['memory'][number]['kind']): number | null {
  let latest: number | null = null;
  for (const entry of entity.memory) {
    if (entry.companyId !== companyId || entry.kind !== kind) continue;
    if (latest === null || entry.quarter > latest) latest = entry.quarter;
  }
  return latest;
}

/** True when `cooldown` quarters have not yet elapsed since the last act of this kind. */
export function onCooldown(entity: CapitalEntity, companyId: string, kind: CapitalEntity['memory'][number]['kind'], cooldown: number, quarter: number): boolean {
  const last = lastActQuarter(entity, companyId, kind);
  return last !== null && quarter - last < cooldown;
}

/* -------------------------------------------------------------------------- */
/*  Small shared arithmetic                                                    */
/* -------------------------------------------------------------------------- */

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Compact money for a report line. Whole numbers only, as every surface demands. */
export function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${strip((abs / 1e9).toFixed(2))}bn`;
  if (abs >= 1e6) return `${sign}$${strip((abs / 1e6).toFixed(0))}m`;
  if (abs >= 1e3) return `${sign}$${strip((abs / 1e3).toFixed(0))}k`;
  return `${sign}$${Math.round(abs)}`;
}

function strip(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

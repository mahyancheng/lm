/**
 * @frontier/simulation — economy/prices.ts
 *
 * Goods prices along the six-sector chain, the stateful shortage counter, and
 * the regional logistics toll.
 *
 * Everything here is a **pure function of the draft**. No RNG, no clock. Prices
 * are computed from *last* quarter's revenue, because `financial_resolution` is
 * phase eleven and this runs in phase one — which is correct and is what makes a
 * price plannable. Do not "fix" that into reading this quarter's revenue: it
 * would make every price a consequence of decisions the player had no chance to
 * take against it.
 *
 * ## The rule, in one block
 *
 * ```text
 * supply[s]    = Σ annualised revenue of active companies in sector s
 * endDemand[s] = supply[s] × sectorDemandCycle(s, quarter) × sectorEndShare[s]
 * demand[s]    = SUPPLY_COUPLING × Σ_{d ∈ outputs(s)} supply[d] + endDemand[s]
 * imbalance[s] = clamp((demand − supply) / min(demand, supply), −1, +1)
 * price[s]     = round(100 × (1 + 0.75 × imbalance[s]))          // 25 … 175
 *
 * shortage[s]  = imbalance ≥ 1 ? min(60, shortage + 10) : max(0, shortage − 5)
 * ```
 *
 * And on the regional side:
 *
 * ```text
 * dominantShare(r) = max over controllers c of
 *                    controllerLogisticsRevenue(r, c) / logisticsRevenue(r)
 * toll(r)          = round(25 × clamp((share − 0.40) / 0.60, 0, 1))
 * ```
 *
 * with the dominant controller free to charge *less* than that through the
 * `set_logistics_toll` dial, and never able to charge more.
 *
 * ## World gating
 *
 * Every function returns the neutral answer for a single-sector world, and
 * `priceSectors` writes nothing at all. A world-version-1 save therefore never
 * grows a `sectorPrices` key and hashes exactly as it always has.
 */

import type { Company, ResolverContext, SessionState } from '@frontier/contracts';
import {
  REGIONS,
  SECTORS,
  SECTOR_META,
  SECTOR_PRICE_BASELINE,
  TOLL_MAX_PCT,
  cartelBonusPct,
  emptyEconomyReport,
  logisticsTollPct,
  nextSectorShortage,
  sectorEndShare,
  sectorImbalance,
  sectorPriceIndex,
  sectorPriceIndexFor,
  sectorShortage,
  sectorTradeShare,
  type DealProposal,
  type Region,
  type Sector,
  type SectorPriceRow,
  type RegionTollRow,
} from '@frontier/contracts';
import { SUPPLY_COUPLING, isMultiSectorWorld, sectorDemandCycle, sectorOf, supplyBySector, supplyGateFor, tightnessBySector } from './sectors';
import { regionOf } from './regions';
import { clamp, clamp01, round } from './util';

/* -------------------------------------------------------------------------- */
/*  Supply, demand and the price                                               */
/* -------------------------------------------------------------------------- */

/** One sector's supply and demand aggregates for the quarter being opened. */
export interface SectorBalance {
  readonly sector: Sector;
  readonly supplyUsd: number;
  /** What the five other sectors call on, at `SUPPLY_COUPLING` of their own revenue. */
  readonly coupledDemandUsd: number;
  /** What end customers call on, at this sector's own cycle and end share. */
  readonly endDemandUsd: number;
  readonly demandUsd: number;
  readonly imbalance: number;
  readonly priceIndex: number;
}

/**
 * Compute every sector's balance and price. Pure; walks the company list once.
 *
 * Call it once per phase, never inside a per-company loop.
 */
export function sectorBalances(state: SessionState): Readonly<Record<Sector, SectorBalance>> {
  const supply = supplyBySector(state);
  const out = {} as Record<Sector, SectorBalance>;

  for (const sector of SECTORS) {
    let coupled = 0;
    for (const consumer of SECTOR_META[sector].outputs) coupled += supply[consumer];
    coupled *= SUPPLY_COUPLING;

    const endDemand = supply[sector] * sectorDemandCycle(sector, state.quarter) * sectorEndShare(sector);
    const demand = coupled + endDemand;
    const imbalance = sectorImbalance(demand, supply[sector]);

    out[sector] = {
      sector,
      supplyUsd: supply[sector],
      coupledDemandUsd: coupled,
      endDemandUsd: endDemand,
      demandUsd: demand,
      imbalance,
      priceIndex: sectorPriceIndexFor(imbalance),
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Ultimate control and the logistics toll                                    */
/* -------------------------------------------------------------------------- */

/**
 * The company at the top of a company's ownership chain.
 *
 * An acquired company keeps its `parentCompanyId`, so a group is a tree; this
 * walks it to the root. The common case — a company with no parent — costs
 * nothing, and the lookup only runs on the rare step that has one. Bounded to
 * eight steps so a corrupt cycle cannot hang a quarter: it returns where it got
 * to instead.
 */
export const MAX_GROUP_DEPTH = 8;

export function ultimateControllerId(state: SessionState, company: Company): string {
  let current = company;
  for (let step = 0; step < MAX_GROUP_DEPTH; step += 1) {
    const parentId = current.parentCompanyId;
    if (parentId === null || parentId === current.id) return current.id;
    const parent = state.companies.find((candidate) => candidate.id === parentId);
    if (parent === undefined) return current.id;
    current = parent;
  }
  return current.id;
}

/** Who dominates one region's freight, and by how much. */
export interface RegionLogistics {
  readonly region: Region;
  readonly logisticsRevenueUsd: number;
  readonly dominantControllerId: string | null;
  readonly dominantShare: number;
  /** The toll the share earns, before the controller's own dial. */
  readonly maxTollPct: number;
  /** The toll actually charged: the controller may set the dial lower, never higher. */
  readonly tollPct: number;
}

/** Annualised revenue of one company, trailing where the metrics phase has written it. */
function annualisedRevenueUsd(company: Company): number {
  const trailing = company.fundamentals.revenueTtmUsd;
  return trailing > 0 ? trailing : Math.max(0, company.financials.revenueQuarterly) * 4;
}

/**
 * Regional logistics dominance and the toll it earns.
 *
 * Ties break on company id ascending, so two groups at exactly the same share
 * resolve the same way on every machine.
 */
export function regionLogistics(state: SessionState): Readonly<Record<Region, RegionLogistics>> {
  const out = {} as Record<Region, RegionLogistics>;
  const byController = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const region of REGIONS) {
    byController.set(region, new Map());
    totals.set(region, 0);
  }

  for (const company of state.companies) {
    if (!company.isActive || sectorOf(company) !== 'logistics') continue;
    const region = regionOf(company);
    const revenue = annualisedRevenueUsd(company);
    if (revenue <= 0) continue;
    const controller = ultimateControllerId(state, company);
    const bucket = byController.get(region);
    if (bucket === undefined) continue;
    bucket.set(controller, (bucket.get(controller) ?? 0) + revenue);
    totals.set(region, (totals.get(region) ?? 0) + revenue);
  }

  const dialByCompanyId = new Map(state.companies.map((company) => [company.id, company.logisticsTollPct]));

  for (const region of REGIONS) {
    const bucket = byController.get(region) ?? new Map<string, number>();
    const total = totals.get(region) ?? 0;
    let bestId: string | null = null;
    let bestRevenue = 0;
    // Sorted so the winner does not depend on insertion order.
    for (const controllerId of [...bucket.keys()].sort()) {
      const revenue = bucket.get(controllerId) ?? 0;
      if (revenue > bestRevenue) {
        bestRevenue = revenue;
        bestId = controllerId;
      }
    }
    const share = total <= 0 ? 0 : clamp01(bestRevenue / total);
    const maxToll = bestId === null ? 0 : logisticsTollPct(share);
    const dial = bestId === null ? undefined : dialByCompanyId.get(bestId);
    const toll = dial === undefined ? maxToll : clamp(Math.round(dial), 0, maxToll);

    out[region] = {
      region,
      logisticsRevenueUsd: total,
      dominantControllerId: maxToll > 0 ? bestId : null,
      dominantShare: share,
      maxTollPct: maxToll,
      tollPct: toll,
    };
  }
  return out;
}

/**
 * The toll one company pays on its cash cost of goods, whole percentage points.
 *
 * The exemption is the whole holding fantasy in one line: your own group rides
 * free, and everybody else in the region pays.
 */
export function tollPaidPct(state: SessionState, company: Company, logistics: Readonly<Record<Region, RegionLogistics>>): number {
  if (!isMultiSectorWorld(state)) return 0;
  const region = logistics[regionOf(company)];
  if (region === undefined || region.tollPct <= 0 || region.dominantControllerId === null) return 0;
  return ultimateControllerId(state, company) === region.dominantControllerId ? 0 : region.tollPct;
}

/** True when this company's group is the one charging the toll in its own region. */
export function chargesTollPct(state: SessionState, company: Company, logistics: Readonly<Record<Region, RegionLogistics>>): number {
  if (!isMultiSectorWorld(state)) return 0;
  const region = logistics[regionOf(company)];
  if (region === undefined || region.dominantControllerId === null) return 0;
  return ultimateControllerId(state, company) === region.dominantControllerId ? region.tollPct : 0;
}

/* -------------------------------------------------------------------------- */
/*  Price accords                                                              */
/* -------------------------------------------------------------------------- */

/** One accord in force this quarter. */
export interface ActiveAccord {
  readonly dealId: string;
  readonly sector: Sector;
  readonly memberCompanyIds: readonly string[];
  /** Members' combined share of their sector's supply, 0..1. */
  readonly combinedShare: number;
  /** `5 + round(25 × combinedShare)`, whole percentage points. */
  readonly bonusPct: number;
  /** Members whose accord is suspended by an enforcement action and pay nothing. */
  readonly suspendedMemberIds: readonly string[];
}

/** Deals carrying a live `price_accord` obligation, in deal-array order. */
function accordDeals(state: SessionState): { deal: DealProposal; sector: Sector; members: readonly string[] }[] {
  const out: { deal: DealProposal; sector: Sector; members: readonly string[] }[] = [];
  for (const deal of state.deals) {
    if (!deal.binding) continue;
    if (deal.status !== 'accepted' && deal.status !== 'executed') continue;
    for (const obligation of [...deal.gives, ...deal.gets]) {
      if (obligation.kind !== 'price_accord') continue;
      if (state.quarter > deal.createdQuarter + obligation.quarters) continue;
      out.push({ deal, sector: obligation.sector, members: obligation.memberCompanyIds });
      break;
    }
  }
  return out;
}

/** Every accord in force, with its combined share and the bonus it pays. Pure. */
export function activeAccords(state: SessionState): readonly ActiveAccord[] {
  if (!isMultiSectorWorld(state)) return [];
  const supply = supplyBySector(state);
  const byId = new Map(state.companies.map((company) => [company.id, company]));
  const accords: ActiveAccord[] = [];

  for (const { deal, sector, members } of accordDeals(state)) {
    let combined = 0;
    const suspended: string[] = [];
    for (const memberId of members) {
      const member = byId.get(memberId);
      if (member === undefined || !member.isActive || sectorOf(member) !== sector) continue;
      combined += annualisedRevenueUsd(member);
      const until = member.accordSuspendedUntilQuarter;
      if (until !== undefined && until !== null && state.quarter < until) suspended.push(memberId);
    }
    const share = clamp01(combined / Math.max(1, supply[sector]));
    accords.push({
      dealId: deal.id,
      sector,
      memberCompanyIds: [...members],
      combinedShare: share,
      bonusPct: cartelBonusPct(share),
      suspendedMemberIds: suspended,
    });
  }
  return accords;
}

/** The accord bonus one company earns this quarter, whole percentage points. Zero when suspended. */
export function accordBonusPctFor(companyId: string, accords: readonly ActiveAccord[]): number {
  let best = 0;
  for (const accord of accords) {
    if (!accord.memberCompanyIds.includes(companyId)) continue;
    if (accord.suspendedMemberIds.includes(companyId)) continue;
    best = Math.max(best, accord.bonusPct);
  }
  return best;
}

/** Whether a company is a member of any accord at all, suspended or not. Drives exposure. */
export function isAccordMember(companyId: string, accords: readonly ActiveAccord[]): boolean {
  return accords.some((accord) => accord.memberCompanyIds.includes(companyId));
}

/* -------------------------------------------------------------------------- */
/*  The phase                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Price the chain for the quarter being opened.
 *
 * Runs inside `world_events`, immediately after `updateMacro` and before the
 * hazard draw, so an antitrust investigation drawn this quarter is drawn against
 * a world whose tolls are already settled. Draws no random numbers, so adding it
 * cannot shift any other phase's sequence.
 */
export function priceSectors(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;

  const balances = sectorBalances(draft);
  const supply = supplyBySector(draft);
  const tightness = tightnessBySector(draft, supply);
  const logistics = regionLogistics(draft);

  const priceRows: SectorPriceRow[] = [];
  const tollRows: RegionTollRow[] = [];
  const prices: Record<string, number> = {};
  const shortages: Record<string, number> = {};
  const tolls: Record<string, number> = {};

  for (const region of REGIONS) tolls[region] = logistics[region].tollPct;

  // Shortages step first so the gate the report quotes is the one the product
  // phase will actually apply this quarter.
  const shortageBefore = {} as Record<Sector, number>;
  for (const sector of SECTORS) {
    shortageBefore[sector] = sectorShortage(draft, sector);
    shortages[sector] = nextSectorShortage(shortageBefore[sector], balances[sector].imbalance);
    prices[sector] = balances[sector].priceIndex;
  }

  const priceBefore = {} as Record<Sector, number>;
  for (const sector of SECTORS) priceBefore[sector] = sectorPriceIndex(draft, sector);

  draft.sectorPrices = prices;
  draft.sectorShortages = shortages;
  draft.regionTolls = tolls;

  const tollSummary = REGIONS.map((region) => ({
    region,
    tollPct: logistics[region].tollPct,
    dominantControllerId: logistics[region].dominantControllerId,
    dominantSharePct: Math.round(logistics[region].dominantShare * 100),
  }));

  for (const sector of SECTORS) {
    const balance = balances[sector];
    const before = priceBefore[sector];
    const shortageNow = shortages[sector] ?? 0;
    const shortageWas = shortageBefore[sector];
    const gate = supplyGateFor(draft, sector, tightness);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'sector_price_set',
      actorId: null,
      targetId: sector,
      payload: {
        sector,
        priceIndex: balance.priceIndex,
        priceIndexBefore: before,
        supplyUsd: round(balance.supplyUsd, 0),
        demandUsd: round(balance.demandUsd, 0),
        coupledDemandUsd: round(balance.coupledDemandUsd, 0),
        endDemandUsd: round(balance.endDemandUsd, 0),
        imbalance: round(balance.imbalance, 4),
        shortage: shortageNow,
        endSharePct: Math.round(sectorEndShare(sector) * 100),
        tradeSharePct: Math.round(sectorTradeShare(sector) * 100),
        regionTolls: tollSummary,
      },
      visibility: 'public',
    });

    priceRows.push({
      sector,
      priceIndex: balance.priceIndex,
      priceIndexBefore: before,
      supplyUsd: Math.max(0, Math.round(balance.supplyUsd)),
      demandUsd: Math.max(0, Math.round(balance.demandUsd)),
      imbalancePct: Math.round(balance.imbalance * 100),
      shortage: shortageNow,
      shortageBefore: shortageWas,
      gatePct: Math.round(gate * 100),
      endSharePct: Math.round(sectorEndShare(sector) * 100),
      tradeSharePct: Math.round(sectorTradeShare(sector) * 100),
      causeEventId: eventId,
    });

    if (Math.abs(balance.priceIndex - before) >= 5) {
      ctx.log({
        phase: 'world_events',
        text: `${SECTOR_META[sector].label} goods priced at ${balance.priceIndex} against a baseline of ${SECTOR_PRICE_BASELINE}.`,
        deltaLabel: `${balance.priceIndex >= before ? '+' : ''}${balance.priceIndex - before}`,
        refEventIds: [eventId],
        tone: balance.priceIndex >= before ? 'positive' : 'negative',
        subjectId: null,
      });
    }

    if (shortageNow !== shortageWas) {
      const shortageEventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'sector_shortage_changed',
        actorId: null,
        targetId: sector,
        payload: {
          sector,
          before: shortageWas,
          after: shortageNow,
          gateEffectPct: shortageNow,
        },
        visibility: 'public',
      });
      if (shortageNow > shortageWas) {
        ctx.log({
          phase: 'world_events',
          text: `${SECTOR_META[sector].label} is short: everyone downstream now realises ${100 - shortageNow}% of the demand they have.`,
          deltaLabel: `-${shortageNow}%`,
          refEventIds: [shortageEventId],
          tone: 'warning',
          subjectId: null,
        });
      }
    }
  }

  for (const region of REGIONS) {
    const entry = logistics[region];
    const previousToll = (draft.economyReport?.regionTolls ?? []).find((row) => row.region === region)?.tollPct ?? 0;
    const row: RegionTollRow = {
      region,
      tollPct: entry.tollPct,
      dominantControllerId: entry.dominantControllerId,
      dominantSharePct: Math.round(entry.dominantShare * 100),
      logisticsRevenueUsd: Math.max(0, Math.round(entry.logisticsRevenueUsd)),
      // The toll rides on the sector price row for the sector that sets it: one
      // ledger row, cited from both surfaces.
      causeEventId: priceRows.find((candidate) => candidate.sector === 'logistics')?.causeEventId ?? null,
    };
    tollRows.push(row);

    if (entry.tollPct > 0 && previousToll === 0 && row.causeEventId !== null) {
      ctx.log({
        phase: 'world_events',
        text: `Freight in ${region.replace(/_/g, ' ')} is now tolled at ${entry.tollPct}%: one group controls ${row.dominantSharePct}% of it, and everyone else pays.`,
        deltaLabel: `+${entry.tollPct}%`,
        refEventIds: [row.causeEventId],
        tone: 'negative',
        subjectId: entry.dominantControllerId,
      });
    }
  }

  const report = emptyEconomyReport(ctx.quarter);
  draft.economyReport = { ...report, sectorPrices: priceRows, regionTolls: tollRows };
}

/** The toll ceiling a controller's group has earned in a region. Used by the validator. */
export function maxTollForCompany(state: SessionState, company: Company, region: Region): number {
  if (!isMultiSectorWorld(state)) return 0;
  const entry = regionLogistics(state)[region];
  if (entry === undefined || entry.dominantControllerId === null) return 0;
  return ultimateControllerId(state, company) === entry.dominantControllerId ? Math.min(TOLL_MAX_PCT, entry.maxTollPct) : 0;
}

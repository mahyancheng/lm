/**
 * The priced economy, as things a screen can draw.
 *
 * Every surface in the Wave 3 visual contract (`docs/economy-study.md` §6) is
 * a rendering of rows the resolver committed onto `EconomyReport`. This module
 * is the whole translation layer between those rows and the components, and it
 * obeys one rule, stated in §6.2 and enforced by the tests beside this file:
 *
 * > Nothing here computes an economic number. It maps a committed figure onto a
 * > tone, a label, a bar width or an ordering, and it hands percentages and
 * > dollars to the shared formatters exactly as the engine recorded them.
 *
 * The two places that look like arithmetic are not:
 *
 * - a **bar width** is a fraction of a drawn axis, which is geometry;
 * - a **market share** divides one engine figure (`annualisedRevenueUsd`, the
 *   engine's own exported rule) by another (`SectorPriceRow.supplyUsd`, the sum
 *   the engine wrote), rather than restating either rule.
 *
 * Everything is pure and total: a world-version-1 session carries no
 * `economyReport` at all, so every accessor here takes `null` and answers with
 * an empty list rather than with a default the player would read as a fact.
 */

import type {
  AntitrustBand,
  CompanyExposure,
  CompanyModifierStack,
  Company,
  ControlStatus,
  EconomyReport,
  ModifierRow,
  ModifierRowTone,
  PredationRow,
  Region,
  Sector,
  SectorPriceRow,
} from '@frontier/contracts';
import {
  CONTROL_DECISIVE_PCT,
  CONTROL_INFORMATION_PCT,
  SECTOR_META,
  SECTOR_PRICE_BASELINE,
  SECTOR_PRICE_BOUNDS,
  SECTORS,
  TOLL_MAX_PCT,
} from '@frontier/contracts';
import { annualisedRevenueUsd } from '@frontier/simulation';
import { formatCount, formatDelta, formatMoney, formatPct } from '@frontier/shared';
import { isIconName, type IconName } from '@/components/ui/icons';
import type { Tone } from '@/components/ui/tokens';
import { sectorOf } from '@/components/ui/sector';

/* -------------------------------------------------------------------------- */
/*  V1 — the itemised modifier stack                                           */
/* -------------------------------------------------------------------------- */

/**
 * How a row reads, not what its arithmetic sign is.
 *
 * The engine already decided this: money onto revenue is `positive` and money
 * onto cost is `negative`, whatever direction the dollars moved. The screen
 * only picks the paint.
 */
export const MODIFIER_TONE: Readonly<Record<ModifierRowTone, Tone>> = {
  positive: 'gain',
  negative: 'loss',
  neutral: 'neutral',
};

/** The mark a row asks for, or the neutral coin when the set has no such name. */
export function modifierIcon(row: Pick<ModifierRow, 'icon'>): IconName {
  return isIconName(row.icon) ? row.icon : 'coins';
}

/** One stack row, ready to print. Every string is already formatted. */
export interface RenderedModifierRow {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly tone: Tone;
  /** Signed whole percentage of the base, e.g. `-18%`. */
  readonly pctLabel: string;
  /** Signed whole dollars, e.g. `-$1,200,000`. */
  readonly amountLabel: string;
  /** Ledger row this came from, or null when there is nothing to open. */
  readonly causeEventId: string | null;
  /** A zero row that is still worth printing — the toll exemption is the one. */
  readonly isExemption: boolean;
}

/** Turn a committed stack into printable rows, in the order the engine applied them. */
export function renderedStackRows(stack: CompanyModifierStack | null | undefined): readonly RenderedModifierRow[] {
  if (stack === null || stack === undefined) return [];
  return stack.rows.map((row) => ({
    key: row.key,
    label: row.label,
    icon: modifierIcon(row),
    tone: MODIFIER_TONE[row.tone],
    pctLabel: formatDelta(row.pct / 100, 'percent'),
    amountLabel: formatDelta(row.amountUsd, 'money'),
    causeEventId: row.causeEventId,
    isExemption: row.amountUsd === 0 && row.pct === 0,
  }));
}

/**
 * The invariant the stack card leans on: base plus the rows *is* the total.
 *
 * Two dollars of slack, because every row is rounded to whole dollars before it
 * is written. A card that fails this would be adding up to a different number
 * than the one printed at its foot, which is the exact failure §6.2 forbids —
 * so the component prints a plain reconciliation line rather than hiding it.
 */
export function stackReconciles(stack: CompanyModifierStack | null | undefined): boolean {
  if (stack === null || stack === undefined) return true;
  const summed = stack.rows.reduce((total, row) => total + row.amountUsd, stack.baseUsd);
  return Math.abs(summed - stack.totalUsd) <= 2;
}

/* -------------------------------------------------------------------------- */
/*  V2 — the market-share ladder                                               */
/* -------------------------------------------------------------------------- */

/** One bar of the sector ladder. */
export interface LadderRow {
  readonly key: string;
  readonly label: string;
  /** Share of the sector's supply, 0..1. Null when the company does not disclose. */
  readonly share: number | null;
  readonly revenueUsd: number | null;
  readonly isPlayer: boolean;
  /** Member of an accord the player can see, so members can be grouped. */
  readonly inAccord: boolean;
  readonly isPublic: boolean;
  /** The residual row: everyone whose revenue is not on the public record. */
  readonly isUndisclosed: boolean;
}

/** What the ladder needs about one company, own or redacted. */
export type LadderCompany = Pick<Partial<Company>, 'id' | 'name' | 'sector' | 'isActive' | 'isPublic' | 'fundamentals' | 'financials'>;

/**
 * The ladder for one sector: every company that discloses, largest first, then
 * one residual bar for everyone who does not.
 *
 * The information boundary is the whole shape of this function. A listed rival
 * files its statements, so its revenue is on the ladder; a private rival's is
 * not, and it is *absent* rather than estimated. The residual is the honest
 * remainder: the sector's committed supply less what the disclosed bars sum to.
 * `supplyUsd` is the engine's figure, so the residual never goes negative by
 * more than rounding and is floored at zero when it does.
 */
export function sectorLadderRows(
  companies: readonly LadderCompany[],
  sector: Sector,
  supplyUsd: number,
  playerCompanyId: string,
  accordMemberIds: ReadonlySet<string> = new Set<string>(),
): readonly LadderRow[] {
  const here = companies.filter((company) => company.isActive !== false && sectorOf(company) === sector);
  const rows: LadderRow[] = [];
  let disclosed = 0;

  for (const company of here) {
    const id = company.id ?? company.name ?? '';
    if (id.length === 0) continue;
    const isPlayer = id === playerCompanyId;
    // A private rival discloses nothing; `redactRival` does not carry its
    // statements at all, so there is no figure here to hide.
    const discloses = isPlayer || company.isPublic === true;
    const revenueUsd = discloses ? annualisedRevenueUsd(company) : null;
    if (revenueUsd !== null) disclosed += revenueUsd;
    rows.push({
      key: id,
      label: company.name ?? id,
      share: revenueUsd === null || supplyUsd <= 0 ? null : Math.min(1, revenueUsd / supplyUsd),
      revenueUsd,
      isPlayer,
      inAccord: accordMemberIds.has(id),
      isPublic: company.isPublic === true,
      isUndisclosed: false,
    });
  }

  // Largest first; the undisclosed bars sink to the bottom in name order so the
  // ladder does not reshuffle between renders.
  rows.sort((a, b) => {
    if (a.share === null && b.share === null) return a.label.localeCompare(b.label);
    if (a.share === null) return 1;
    if (b.share === null) return -1;
    if (b.share !== a.share) return b.share - a.share;
    return a.label.localeCompare(b.label);
  });

  const residual = Math.max(0, supplyUsd - disclosed);
  if (supplyUsd > 0 && residual / supplyUsd >= 0.01) {
    rows.push({
      key: '__undisclosed',
      label: 'Privately held — not on the public record',
      share: Math.min(1, residual / supplyUsd),
      revenueUsd: residual,
      isPlayer: false,
      inAccord: false,
      isPublic: false,
      isUndisclosed: true,
    });
  }

  return rows;
}

/** Sectors with at least one company standing in them, in `SECTORS` order. */
export function laddersPresent(companies: readonly LadderCompany[]): readonly Sector[] {
  const seen = new Set<Sector>();
  for (const company of companies) {
    if (company.isActive === false) continue;
    seen.add(sectorOf(company));
  }
  return SECTORS.filter((sector) => seen.has(sector));
}

/* -------------------------------------------------------------------------- */
/*  V6 — the Sector Flow chain                                                 */
/* -------------------------------------------------------------------------- */

/** One tile of the six-sector chain. */
export interface FlowTile {
  readonly sector: Sector;
  readonly label: string;
  readonly icon: IconName;
  /** The committed row, or null in a world that never priced its sectors. */
  readonly row: SectorPriceRow | null;
  /** Sectors this one buys from, declared in `SECTOR_META`. */
  readonly inputs: readonly Sector[];
  /** True when the player's own company sells into this sector's chain. */
  readonly isOwn: boolean;
  /** True when an input is a sector the player's own group produces. */
  readonly internalInputs: readonly Sector[];
}

/**
 * The six tiles, in `SECTORS` order, with their arrows.
 *
 * The links are `SECTOR_META`'s declared supply graph, not something derived
 * here — the same table `SectorPanel` already renders as "buys from" and "sells
 * to". `ownSectors` is the set the player's group actually produces in, which
 * is what makes an internal link visibly different from a market-priced one:
 * §6.1 V6, "the visual gap between a cheap internal link and a market-priced
 * one *is* the pitch for the next acquisition".
 */
export function flowTiles(report: EconomyReport | null, ownSectors: ReadonlySet<Sector>): readonly FlowTile[] {
  return SECTORS.map((sector) => {
    const meta = SECTOR_META[sector];
    const inputs = meta.inputs;
    return {
      sector,
      label: meta.label,
      icon: isIconName(meta.icon) ? meta.icon : 'building',
      row: report?.sectorPrices.find((entry) => entry.sector === sector) ?? null,
      inputs,
      isOwn: ownSectors.has(sector),
      internalInputs: inputs.filter((input) => ownSectors.has(input)),
    };
  });
}

/** `SHORT -30%` when the counter is live, null when it is not. */
export function shortageBadge(row: SectorPriceRow | null): string | null {
  if (row === null || row.shortage <= 0) return null;
  return `SHORT -${row.shortage}%`;
}

/**
 * A price index against its own hard range, as a bar fraction.
 *
 * Geometry: 25 sits at the left edge, 175 at the right, and 100 — the anchor
 * the player learns once — sits a little under halfway, which is where the
 * baseline tick is drawn.
 */
export function priceIndexFraction(index: number): number {
  const span = SECTOR_PRICE_BOUNDS.max - SECTOR_PRICE_BOUNDS.min;
  const clamped = Math.min(SECTOR_PRICE_BOUNDS.max, Math.max(SECTOR_PRICE_BOUNDS.min, index));
  return (clamped - SECTOR_PRICE_BOUNDS.min) / span;
}

/** Where the baseline of 100 falls on that same axis. */
export const PRICE_BASELINE_FRACTION = priceIndexFraction(SECTOR_PRICE_BASELINE);

/** Cheap, dear or neutral — an index is only ever read against 100. */
export function priceIndexTone(index: number): Tone {
  if (index > SECTOR_PRICE_BASELINE) return 'warn';
  if (index < SECTOR_PRICE_BASELINE) return 'info';
  return 'neutral';
}

/* -------------------------------------------------------------------------- */
/*  V8 — antitrust exposure                                                    */
/* -------------------------------------------------------------------------- */

export const BAND_TONE: Readonly<Record<AntitrustBand, Tone>> = {
  calm: 'gain',
  watched: 'warn',
  exposed: 'loss',
};

export const BAND_BLURB: Readonly<Record<AntitrustBand, string>> = {
  calm: 'Nobody is looking at you.',
  watched: 'An investigation is materially more likely than it was.',
  exposed: 'An enforcement action is a question of when, not whether.',
};

/** The drivers as printable rows. Points are already whole and already signed. */
export interface RenderedDriverRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly pointsLabel: string;
  readonly tone: Tone;
}

export function renderedDrivers(exposure: CompanyExposure | null): readonly RenderedDriverRow[] {
  if (exposure === null) return [];
  return exposure.drivers.map((driver) => ({
    key: driver.key,
    label: driver.label,
    detail: driver.detail,
    pointsLabel: formatDelta(driver.points, 'number'),
    // Exposure is a risk, so every point of it is a cost: a driver that
    // contributed nothing is quiet, and one that contributed is not.
    tone: driver.points > 0 ? 'loss' : 'neutral',
  }));
}

/**
 * The exposure a queued action would add, as the label on its confirm button.
 *
 * Read straight off `ANTITRUST_EXPOSURE_WEIGHTS` through the caller, never
 * recomputed here: the caller passes the weight the engine will apply and this
 * only writes the sentence.
 */
export function exposureCostLabel(points: number): string | null {
  if (points <= 0) return null;
  return `+${Math.round(points)} exposure`;
}

/* -------------------------------------------------------------------------- */
/*  V4 — control thresholds                                                    */
/* -------------------------------------------------------------------------- */

/** The two thresholds as whole percentages, for a tick on an ownership bar. */
export const CONTROL_TICKS: readonly { readonly key: string; readonly pct: number; readonly label: string }[] = [
  { key: 'information', pct: Math.round(CONTROL_INFORMATION_PCT * 100), label: 'Information right' },
  { key: 'control', pct: Math.round(CONTROL_DECISIVE_PCT * 100), label: 'Control' },
];

/**
 * The caption a present-but-disabled verb carries.
 *
 * "needs 50%+1 — you hold 38%" is the whole point of V4: the reward is visible
 * before it can be claimed, and the gap is a number rather than a locked icon.
 * Every figure comes off the committed `ControlStatus` row.
 */
export function controlCaption(row: ControlStatus | null): string {
  if (row === null) return 'Needs 50%+1 of the ordinary shares — you hold none of the register.';
  if (row.hasControl) return `You hold ${row.stakePct}% — decisive on every matter but a dismissal of the chief executive.`;
  return `Needs ${row.controlThresholdPct}%+1 — you hold ${row.stakePct}%.`;
}

/** The player's own row for a company, or null when they are not on its register. */
export function ownControlRow(report: EconomyReport | null, companyId: string, holderId: string): ControlStatus | null {
  return report?.control.find((row) => row.companyId === companyId && row.holderId === holderId) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  V3 — the price ladder                                                      */
/* -------------------------------------------------------------------------- */

/** One dot on the price axis. */
export interface PriceLadderPoint {
  readonly key: string;
  readonly label: string;
  readonly priceUsd: number;
  /** 0..1 along the drawn axis. */
  readonly fraction: number;
  readonly kind: 'you' | 'reference' | 'predator' | 'ceiling';
}

export interface PriceLadder {
  readonly maxUsd: number;
  readonly points: readonly PriceLadderPoint[];
  readonly referenceUsd: number;
  readonly ceilingUsd: number;
}

/**
 * Your price against the market, on one axis.
 *
 * What may be drawn is decided by rule 9, not by convenience. The segment
 * reference is a published figure; a **flagged** predatory price is public by
 * design (P0-4 writes `predatory_pricing_flagged` at `public` visibility); an
 * ordinary rival's list price is neither, and does not appear.
 *
 * `ceilingUsd` is handed in by the caller, which reads it from the engine's own
 * elasticity curve — this function only places it on the axis.
 */
export function priceLadder(
  yourPriceUsd: number,
  referenceUsd: number,
  ceilingUsd: number,
  predators: readonly { readonly companyId: string; readonly label: string; readonly priceUsd: number }[],
): PriceLadder {
  const prices = [yourPriceUsd, referenceUsd, ceilingUsd, ...predators.map((entry) => entry.priceUsd)];
  const maxUsd = Math.max(1, ...prices) * 1.08;
  const at = (price: number): number => Math.min(1, Math.max(0, price / maxUsd));

  const points: PriceLadderPoint[] = [
    { key: 'reference', label: 'Segment average', priceUsd: referenceUsd, fraction: at(referenceUsd), kind: 'reference' },
    { key: 'ceiling', label: 'Achievable ceiling', priceUsd: ceilingUsd, fraction: at(ceilingUsd), kind: 'ceiling' },
    { key: 'you', label: 'You', priceUsd: yourPriceUsd, fraction: at(yourPriceUsd), kind: 'you' },
  ];
  for (const predator of predators) {
    points.push({
      key: `predator:${predator.companyId}`,
      label: predator.label,
      priceUsd: predator.priceUsd,
      fraction: at(predator.priceUsd),
      kind: 'predator',
    });
  }
  return { maxUsd, points, referenceUsd, ceilingUsd };
}

/** The flagged predatory prices in one segment. Public rows only — they all are. */
export function predatorsInSegment(report: EconomyReport | null, segment: string, excludeCompanyId: string): readonly PredationRow[] {
  return (report?.predation ?? []).filter((row) => row.segment === segment && row.companyId !== excludeCompanyId);
}

/* -------------------------------------------------------------------------- */
/*  Labels shared across the surfaces                                          */
/* -------------------------------------------------------------------------- */

/** `+18%` / `-4%` from a whole percentage the engine already signed. */
export function signedPct(wholePct: number): string {
  return formatDelta(wholePct / 100, 'percent');
}

/** A toll as a sentence for a region chip, or null when nobody has earned one. */
export function tollCaption(tollPct: number, dominantSharePct: number, controllerName: string | null): string | null {
  if (tollPct <= 0) return null;
  const who = controllerName ?? 'One group';
  return `${who} holds ${dominantSharePct}% of the freight here and charges ${tollPct}% of ${TOLL_MAX_PCT}%.`;
}

/** A share for a ladder label: whole percent, and never a bare 0% for a live bar. */
export function shareLabel(share: number | null): string {
  return share === null ? 'undisclosed' : formatPct(share);
}

/** Money for a ladder label, or the honest dash. */
export function revenueLabel(revenueUsd: number | null): string {
  return revenueUsd === null ? '—' : formatMoney(revenueUsd);
}

/** An index printed bare, the way `SectorPanel` prints a region index. */
export function indexLabel(value: number): string {
  return formatCount(value);
}

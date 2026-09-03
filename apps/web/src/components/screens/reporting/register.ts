/**
 * The register: every company the player can see, as one row each.
 *
 * World version 2 opens with twenty-five companies across six sectors, and no
 * screen in the reporting cluster had a list that showed all of them — the
 * exchange tape only carries the eight that are listed. This file is the
 * derivation the rest of them appear through, and the per-sector roll-up that
 * sits above it.
 *
 * The information boundary is enforced here, once, rather than at each call
 * site:
 *
 * - a **listed** company's capitalisation is its last quoted capitalisation,
 *   and its trailing revenue, margin and growth are what it files;
 * - the player's **own** company shows its anchor and its own fundamentals,
 *   because they are the player's own;
 * - a **private rival** shows neither. The fields are `null` — absent, not
 *   redacted — exactly as `redactRival` leaves them.
 *
 * Everything here is a pure function of the projection plus the public tape, so
 * two renders of one quarter produce one list in one order.
 */

import type { PlayerView, Region, Sector, SessionState } from '@frontier/contracts';
import { SECTORS } from '@frontier/contracts';
import { regionOf, sectorOf } from '@/components/ui';
import { allVisibleCompanies, anchorOf, newEntrantLabel } from './util';
import { latestQuote } from '@/lib/game';

/** Where a row's headline valuation came from. Never a guess at a private one. */
export type ValueBasis = 'quote' | 'anchor' | 'none';

export interface RegisterRow {
  readonly companyId: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly sector: Sector;
  readonly region: Region;
  readonly archetype: string | null;
  readonly isPublic: boolean;
  readonly isOwn: boolean;
  /** Quoted capitalisation, own anchor, or null for a private rival. */
  readonly valueUsd: number | null;
  readonly valueBasis: ValueBasis;
  /** Filed figures. Null wherever the company does not file them. */
  readonly revenueTtmUsd: number | null;
  readonly grossMarginPct: number | null;
  readonly revenueGrowthYoY: number | null;
  readonly sharesOutstanding: number | null;
  /** Value over trailing revenue, where both exist and revenue is positive. */
  readonly revenueMultiple: number | null;
  /** "New · 2029 Q2" for the first four quarters of a mid-session founding, else null. */
  readonly newLabel: string | null;
}

/**
 * One row per company on the register, the player's own first and the rest by
 * id — a stable order that a quarter's results never reshuffle.
 */
export function registerRows(session: SessionState, view: PlayerView): readonly RegisterRow[] {
  const out: RegisterRow[] = [];
  for (const company of allVisibleCompanies(view)) {
    const companyId = company.id;
    if (companyId === undefined || company.isActive === false) continue;
    const isOwn = companyId === view.ownCompany.id;
    const isPublic = company.isPublic === true;

    let valueUsd: number | null = null;
    let valueBasis: ValueBasis = 'none';
    if (isPublic && company.instrumentId !== null && company.instrumentId !== undefined) {
      const quote = latestQuote(session, company.instrumentId);
      if (quote !== null && quote.marketCapUsd > 0) {
        valueUsd = quote.marketCapUsd;
        valueBasis = 'quote';
      }
    }
    if (valueUsd === null && isOwn) {
      const anchor = anchorOf(session, companyId);
      if (anchor !== null && anchor.anchorValueUsd > 0) {
        valueUsd = anchor.anchorValueUsd;
        valueBasis = 'anchor';
      }
    }

    // Present only where the projection carries them: the player's own company
    // and any company that files. A private rival's are simply not here.
    const fundamentals = company.fundamentals ?? null;
    const revenue = fundamentals === null ? null : fundamentals.revenueTtmUsd;

    out.push({
      companyId,
      name: company.name ?? companyId,
      ticker: company.ticker ?? null,
      sector: sectorOf(company),
      region: regionOf(company),
      archetype: company.archetype ?? null,
      isPublic,
      isOwn,
      newLabel: newEntrantLabel(company, view.quarter, view.startYear),
      valueUsd,
      valueBasis,
      revenueTtmUsd: revenue,
      grossMarginPct: fundamentals?.grossMarginPct ?? null,
      revenueGrowthYoY: fundamentals?.revenueGrowthYoY ?? null,
      sharesOutstanding: fundamentals?.sharesOutstanding ?? null,
      revenueMultiple: valueUsd === null || revenue === null || revenue <= 0 ? null : valueUsd / revenue,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Roll-up                                                                    */
/* -------------------------------------------------------------------------- */

export interface SectorRollup {
  readonly sector: Sector;
  readonly companies: number;
  readonly listed: number;
  /** Sum of the capitalisations that are public. Never includes a private one. */
  readonly marketCapUsd: number;
  /** Sum of the trailing revenues that are public. */
  readonly revenueTtmUsd: number;
  /** Capitalisation over revenue across the sector, or null without both. */
  readonly blendedMultiple: number | null;
  /** Revenue-weighted gross margin, or null when no revenue is public here. */
  readonly grossMarginPct: number | null;
}

/**
 * The sector table above the register.
 *
 * Aggregates are of the **public** figures only, which is why a sector can show
 * six companies and one capitalisation: five of them are private. The interface
 * says so rather than quietly summing a number it is not allowed to know.
 */
export function sectorRollups(rows: readonly RegisterRow[]): readonly SectorRollup[] {
  return SECTORS.map((sector) => {
    const here = rows.filter((row) => row.sector === sector);
    const marketCapUsd = here.reduce((total, row) => total + (row.valueBasis === 'quote' ? (row.valueUsd ?? 0) : 0), 0);
    const revenueTtmUsd = here.reduce((total, row) => total + (row.revenueTtmUsd ?? 0), 0);
    const marginWeighted = here.reduce(
      (total, row) => total + (row.grossMarginPct ?? 0) * (row.revenueTtmUsd ?? 0),
      0,
    );
    return {
      sector,
      companies: here.length,
      listed: here.filter((row) => row.isPublic).length,
      marketCapUsd,
      revenueTtmUsd,
      blendedMultiple: revenueTtmUsd > 0 && marketCapUsd > 0 ? marketCapUsd / revenueTtmUsd : null,
      grossMarginPct: revenueTtmUsd > 0 ? marginWeighted / revenueTtmUsd : null,
    } satisfies SectorRollup;
  }).filter((entry) => entry.companies > 0);
}

/** How many rows each sector holds — the counts `SectorFilter` prints. */
export function sectorCounts(rows: readonly RegisterRow[]): Readonly<Partial<Record<Sector, number>>> {
  const counts: Partial<Record<Sector, number>> = {};
  for (const row of rows) counts[row.sector] = (counts[row.sector] ?? 0) + 1;
  return counts;
}

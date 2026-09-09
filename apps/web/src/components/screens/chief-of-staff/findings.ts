/**
 * Findings, as the interface reads them.
 *
 * A `LookupResult` is the engine's answer to one question the assistant went and
 * asked. It carries a dozen figures; a card carries one. This module decides
 * which one, and what the two or three supporting lines under it say — and it is
 * the only place that decision is made, so the drawer and the full screen show
 * the same card.
 *
 * **Nothing here computes an economic number.** Every figure is read off the
 * result exactly as `runLookups` produced it inside the engine, and every string
 * is a formatter from `@frontier/shared` applied to one of them. A screen that
 * did arithmetic on a finding would be a second, quieter copy of the engine.
 */

import type { ActionIntent, LookupResult } from '@frontier/contracts';
import { formatCount, formatMoney, formatQuarterCount } from '@frontier/shared';

/** One line under the headline figure. */
export interface FindingLine {
  readonly label: string;
  readonly value: string;
  /** Set when the line is a warning the founder must not miss — a negative balance. */
  readonly warn?: boolean;
  /** The action this line offers, or null when it offers none. */
  readonly intent?: ActionIntent | null;
  /** Who the action would be with, for the row's own label. */
  readonly counterparty?: string;
}

/** One finding as a card: a title, one figure, and the lines under it. */
export interface FindingCard {
  readonly kind: LookupResult['kind'];
  readonly title: string;
  /** The single figure the card is about. */
  readonly figure: string;
  readonly caption: string;
  readonly lines: readonly FindingLine[];
}

/** The human name of a lookup kind, for the "Sourcing…" line and the card title. */
export const FINDING_TITLE: Readonly<Record<LookupResult['kind'], string>> = {
  compute_market: 'The compute market',
  acquisition_targets: 'Who could be bought',
  debt_headroom: 'What we could borrow',
  government_programmes: 'Procurement open to us',
  hiring_market: 'The hiring market',
  own_position: 'Our own position',
  launchable_lines: 'What we could launch',
  suppliers: 'Who could supply us',
  customers: 'Who builds on us',
  unit_cost: 'What this costs to build',
  entry_path: 'The way into this',
  slot_candidates: 'What could fill this slot',
};

/** "compute market and own position", for the line shown while the lookups run. */
export function sourcingLabel(kinds: readonly string[]): string {
  const named = kinds.map((kind) => (FINDING_TITLE as Record<string, string | undefined>)[kind] ?? kind.replace(/_/g, ' '));
  if (named.length <= 1) return named[0] ?? 'the market';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1] ?? ''}`;
}

/** How many rows a card shows before it stops. Three is a card; twelve is a table. */
export const FINDING_LINES = 3;

export function cardFor(finding: LookupResult): FindingCard {
  switch (finding.kind) {
    case 'compute_market': {
      const buy = finding.sellers.filter((seller) => seller.offering === 'accelerators');
      const cheapest = buy[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.compute_market,
        figure: cheapest === undefined ? '—' : formatMoney(cheapest.unitPriceUsd),
        caption:
          cheapest === undefined
            ? 'Nobody is selling accelerators outright this quarter'
            : `an accelerator from ${cheapest.name}, ${formatCount(finding.units)} of them for ${formatMoney(finding.purchaseCostUsd)}`,
        lines: [
          {
            label: 'Cash after buying them',
            value: formatMoney(finding.cashAfterPurchaseUsd),
            warn: finding.cashAfterPurchaseUsd < 0,
          },
          ...(finding.solvencyLine === '' ? [] : [{ label: 'Solvency', value: finding.solvencyLine, warn: true }]),
          ...finding.sellers.slice(0, FINDING_LINES).map((seller) => ({
            label: `${seller.name} — ${seller.offering === 'accelerators' ? 'to own' : seller.offering === 'cloud' ? 'on demand' : 'reserved'}`,
            value: `${formatMoney(seller.unitPriceUsd)} × ${formatCount(seller.sellableUnits)} spare`,
            intent: seller.intent,
            counterparty: seller.name,
          })),
        ],
      };
    }

    case 'acquisition_targets': {
      const first = finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.acquisition_targets,
        figure: first === undefined ? 'None' : formatMoney(first.indicativePriceUsd),
        caption: first === undefined ? 'nothing matches that description' : `for ${first.name}, the cheapest of ${formatCount(finding.rows.length)}`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: `${row.name} — ${row.sectorId.replace(/_/g, ' ')}, ${row.headcountBand} people`,
          value: `${formatMoney(row.indicativePriceUsd)}, leaving ${formatMoney(row.cashAfterUsd)}`,
          warn: row.cashAfterUsd < 0,
          intent: row.intent,
          counterparty: row.name,
        })),
      };
    }

    case 'debt_headroom':
      return {
        kind: finding.kind,
        title: FINDING_TITLE.debt_headroom,
        figure: finding.available ? formatMoney(finding.headroomUsd) : 'None',
        caption: finding.available ? `at an indicative ${finding.indicativeCouponPct}% coupon` : finding.reason,
        lines: [
          { label: 'Last operating income', value: formatMoney(finding.lastOperatingIncomeUsd), warn: finding.lastOperatingIncomeUsd < 0 },
          { label: 'That would service', value: formatMoney(finding.servisableUsd) },
          ...(finding.intent === null
            ? []
            : [{ label: 'Issue at the headroom', value: formatMoney(finding.headroomUsd), intent: finding.intent }]),
        ].slice(0, FINDING_LINES + 1),
      };

    case 'government_programmes': {
      const first = finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.government_programmes,
        figure: first === undefined ? 'None' : formatMoney(first.maxValueUsd),
        caption: first === undefined ? 'nothing is still accepting bids' : `${first.programme}, closing quarter ${first.closeQuarter}`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: row.programme,
          value: `${formatMoney(row.maxValueUsd)} · ${row.requirementsUnmet.length === 0 ? 'we qualify' : `${row.requirementsUnmet.length} unmet`}`,
          warn: row.requirementsUnmet.length > 0,
        })),
      };
    }

    case 'hiring_market': {
      const first = finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.hiring_market,
        figure: first === undefined ? '—' : formatMoney(first.quarterlyCostUsd),
        caption: first === undefined ? 'no roles quoted' : `a ${first.role} at ${first.band.replace(/_/g, ' ')} a quarter`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: `${row.role} — ${row.band.replace(/_/g, ' ')}`,
          value: `${formatMoney(row.quarterlyCostUsd)} a quarter`,
          intent: row.intent,
        })),
      };
    }

    case 'own_position':
      return {
        kind: finding.kind,
        title: FINDING_TITLE.own_position,
        figure: formatMoney(finding.cashUsd),
        caption: `of cash, ${formatQuarterCount(finding.runwayQuarters)} of runway`,
        lines: [
          { label: 'Net cash movement', value: `${formatMoney(finding.quarterlyBurnUsd)} a quarter`, warn: finding.quarterlyBurnUsd < 0 },
          {
            label: 'Quarters closed below zero',
            value: `${finding.negativeCashQuarters} of ${finding.solvencyQuartersAllowed}`,
            warn: finding.negativeCashQuarters > 0,
          },
          ...finding.statements.slice(-1).map((row) => ({
            label: `Last filed — Q${row.quarter}`,
            value: `${formatMoney(row.revenueUsd)} revenue, ${formatMoney(row.netIncomeUsd)} net`,
            warn: row.netIncomeUsd < 0,
          })),
        ],
      };

    case 'launchable_lines': {
      const open = finding.rows.filter((row) => !row.locked);
      const first = open[0] ?? finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.launchable_lines,
        figure: first === undefined ? '—' : `${open.length} of ${finding.rows.length}`,
        caption: first === undefined ? 'no lines catalogued for this sector' : `open now, out of ${finding.rows.length} in this industry`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: row.locked ? `${row.label} — locked` : row.label,
          value: row.locked ? `needs ${row.missingNodeTitles.join(', ') || 'more research'}` : `${formatMoney(row.referencePriceUsd)} a ${row.unitLabel}`,
          warn: row.locked,
          intent: row.intent,
        })),
      };
    }

    case 'suppliers': {
      const first = finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.suppliers,
        figure: first === undefined ? 'None' : formatMoney(first.pricePerUnitUsd),
        caption: first === undefined ? 'nobody publishes this input yet' : `a unit from ${first.name}, best on quality per dollar`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: `${row.name} — ${row.productName}${row.isDirectRival ? ' (direct rival)' : ''}`,
          value: `${formatMoney(row.pricePerUnitUsd)} · quality ${row.qualityScorePct}`,
          intent: row.intent,
          counterparty: row.name,
        })),
      };
    }

    case 'customers': {
      const revenue = finding.rows.reduce((sum, row) => sum + row.revenueUsd, 0);
      return {
        kind: finding.kind,
        title: FINDING_TITLE.customers,
        figure: finding.rows.length === 0 ? 'None' : formatMoney(revenue),
        caption: finding.rows.length === 0 ? 'nobody is building on this line' : `across ${formatCount(finding.rows.length)} companies this quarter`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: `${row.buyerName} — ${row.buyerProductName}`,
          value: `${formatMoney(row.revenueUsd)} · ${formatCount(row.unitsFilled)} units`,
        })),
      };
    }

    case 'unit_cost': {
      // The figure is the unit cost, because that is the number the founder
      // asked for; the caption puts it beside the market price, which is the
      // only reference a price is judged against in the node economy.
      return {
        kind: finding.kind,
        title: FINDING_TITLE.unit_cost,
        figure: formatMoney(finding.unitCostUsd),
        caption:
          finding.marketPriceUsd <= 0
            ? `to make one ${finding.unitLabel} of ${finding.label}`
            : `a ${finding.unitLabel} of ${finding.label}, against ${formatMoney(finding.marketPriceUsd)} on the market`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: row.sourceName === '' ? row.label : `${row.label} — ${row.sourceName}`,
          value: `${formatMoney(row.amountUsd)} · ${row.sharePct}%`,
          counterparty: row.sourceName === '' ? undefined : row.sourceName,
        })),
      };
    }

    case 'entry_path': {
      return {
        kind: finding.kind,
        title: FINDING_TITLE.entry_path,
        figure: finding.alreadyIn ? 'In already' : finding.rows.length === 0 ? 'Nothing in the way' : formatCount(finding.rows.length),
        caption: finding.alreadyIn
          ? 'we can already make something there'
          : finding.rows.length === 0
            ? 'we can own everything it needs'
            : `node${finding.rows.length === 1 ? '' : 's'} to own before we could make anything`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: row.label,
          value: row.researchable
            ? `research ${formatMoney(row.researchLowUsd)}–${formatMoney(row.researchHighUsd)}`
            : row.licensorName !== ''
              ? `licence from ${row.licensorName} at ${row.licensorRoyaltyPct}%`
              : 'not reachable by research',
          intent: row.intent,
          counterparty: row.licensorName === '' ? undefined : row.licensorName,
        })),
      };
    }

    case 'slot_candidates': {
      // The figure is how many ways the slot could be filled; each line is one
      // node from one source with the fill that puts it there.
      const first = finding.rows[0];
      return {
        kind: finding.kind,
        title: FINDING_TITLE.slot_candidates,
        figure: finding.rows.length === 0 ? 'None' : formatCount(finding.rows.length),
        caption:
          finding.rows.length === 0
            ? `nothing can fill the ${finding.slotLabel.toLowerCase()} slot`
            : `way${finding.rows.length === 1 ? '' : 's'} to fill the ${finding.slotLabel.toLowerCase()} slot${first === undefined ? '' : `, from ${formatMoney(first.unitPriceUsd)} a unit`}`,
        lines: finding.rows.slice(0, FINDING_LINES).map((row) => ({
          label: `${row.label} — ${row.sourceKind === 'make' ? 'make it yourself' : row.sourceKind === 'buy' ? row.sellerName : 'open market'}`,
          value: `${formatMoney(row.unitPriceUsd)} · quality ${row.qualityScorePct}${row.blocked ? ' · blocked' : ''}`,
          warn: row.blocked,
          intent: row.intent,
          counterparty: row.sourceKind === 'buy' ? row.sellerName : undefined,
        })),
      };
    }

    default: {
      const exhaustive: never = finding;
      return { kind: (exhaustive as { kind: LookupResult['kind'] }).kind, title: '', figure: '', caption: '', lines: [] };
    }
  }
}

/**
 * The Connections picture, as words and numbers.
 *
 * `connectionsOf` answers *what is wired to this line and on what terms I am
 * party to*; this module turns that answer into pills — a name, a glyph, one
 * data line, a state and the one thing tapping it does. Nothing here computes
 * an economic figure: every price, unit and share arrives already decided by
 * the engine, and every one that a rival owns arrives as `null` and is simply
 * not drawn.
 *
 * That is the whole of the privacy rule on this screen. The model never asks
 * whether the viewer may see a number; it prints the numbers it was handed. A
 * leak would have to be a leak in `graph/connections.ts`, which its own tests
 * hold shut with five distinctive values.
 *
 * Pure and total: same view in, same model out, no clock, no random.
 */

import type { ProductSegment, Sector } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import type {
  ConnectionsCell,
  ConnectionsSupplier,
  ConnectionsSupplyOption,
  ConnectionsView,
  LineCustomer,
} from '@frontier/simulation';
import { targetPhrase } from '@frontier/simulation';
import { formatCount } from '@frontier/shared';
import type { IconName } from '@/components/ui';
import type { LayoutGroup, PillState } from './layout';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What tapping a pill does. The screen owns every one of these; the model only
 * names it.
 *
 * One vocabulary for both pictures. Products and Research are the same diagram
 * asked two questions, so they are drawn by one `ConnectionsDiagram` and one
 * `ConnectionPill`; the price of that is a union each screen only half uses,
 * which is cheaper than two renderers drifting apart pill by pill. Every
 * handler ends in a `default` — a screen ignores the kinds that are not its
 * own rather than asserting they cannot arrive.
 */
export type PillAction =
  // --- the Products picture --------------------------------------------------
  | { readonly kind: 'slot'; readonly slotId: string }
  | { readonly kind: 'company'; readonly companyId: string }
  | { readonly kind: 'aim'; readonly industry: Sector; readonly customer: ProductSegment }
  | { readonly kind: 'line' }
  | { readonly kind: 'switchLine'; readonly productId: string }
  | { readonly kind: 'href'; readonly href: string }
  // --- the Research picture --------------------------------------------------
  /** Open the Products screen on this line. */
  | { readonly kind: 'products'; readonly nodeId: string; readonly productId: string }
  /** Open the launch flow on this node. */
  | { readonly kind: 'launch'; readonly nodeId: string }
  /**
   * Open the node drawer — where a programme is started. `fallbackNodeId` is
   * what to open when the reader's own tech graph does not carry `nodeId`: an
   * unlock the graph never projected must not be a dead tap, so it opens the
   * programme that would reach it instead.
   */
  | { readonly kind: 'node'; readonly nodeId: string; readonly fallbackNodeId: string }
  /** Expand one held sector past its first four. */
  | { readonly kind: 'expand'; readonly sector: Sector }
  /** Show every research option rather than the first six. */
  | { readonly kind: 'showAll' };

/** What is drawn in the 22-point circle at the pill's leading edge. */
export type PillGlyph =
  | { readonly kind: 'company'; readonly companyId: string; readonly archetype: string | null; readonly own: boolean }
  | { readonly kind: 'sector'; readonly sector: Sector }
  | { readonly kind: 'icon'; readonly name: IconName };

export interface PillModel {
  readonly key: string;
  readonly state: PillState;
  readonly glyph: PillGlyph;
  readonly name: string;
  /** The leading figure on the wire edge: a price, a count, a contract value. */
  readonly figure: string | null;
  /** What the figure means, in two or three words. */
  readonly detail: string | null;
  /** 0..100 for the ring around a right-hand glyph; null for no ring. */
  readonly ringPct: number | null;
  readonly action: PillAction | null;
  readonly ariaLabel: string;
  readonly nested?: boolean;
  readonly parentKey?: string | null;
}

export interface PillGroup {
  readonly key: string;
  readonly header: string | null;
  /**
   * The second header line: the recipe, "40 1M tokens per unit".
   *
   * Its own line because the two together are 25 characters and the column is
   * 130 points wide — printed as one row the quantity is the half that gets
   * truncated, and the quantity is the half that decides anything.
   */
  readonly subheader: string | null;
  /** A required slot wears a red asterisk on its header. */
  readonly required: boolean;
  /** "+3 more" when the group lists fewer routes than exist. */
  readonly moreLabel: string | null;
  readonly pills: readonly PillModel[];
}

export interface HubModel {
  /** The line's own name, above the disc. */
  readonly name: string;
  readonly nodeLabel: string;
  /** "Cost $12", "Price $30", "Ask $28" — only the ones this seat is entitled to. */
  readonly figures: readonly string[];
  /** Whole percent, or null on a seat that may not read it. */
  readonly marginPct: number | null;
  readonly showOutput: boolean;
  readonly companyId: string;
  readonly companyName: string;
  readonly archetype: string | null;
  readonly own: boolean;
  readonly action: PillAction | null;
  readonly ariaLabel: string;
}

export interface ConnectionsModel {
  readonly left: readonly PillGroup[];
  readonly right: readonly PillGroup[];
  readonly hub: HubModel | null;
}

export interface ConnectionsModelOptions {
  /** Archetype per company id, for the glyph tint. Public: it survives redaction. */
  readonly archetypes?: Readonly<Record<string, string>>;
}

/** How many market cells a founder may aim at before the column is longer than the screen. */
export const MAX_AIM_CELLS = 4;
/** A quality gap worth printing on an alternative, in whole points. */
export const QUALITY_GAP_POINTS = 5;

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How wide a pill's data row may be, in characters.
 *
 * Measured, not guessed. A pill is 130 points at a 390-point phone and 115 at a
 * 360-point one; the glyph, the gap and the padding take 36, leaving 92 for
 * words. At 9 points the figure tag is about 4.9 points a character plus 4 of
 * ground, and the words beside it the same, so the row holds about seventeen
 * characters between them — `ROW_MAX_CH` — of which no figure may take more
 * than six and no detail more than twelve. `ConnectionPill.rowSizePx` steps the
 * row down from 9 points to 7.5 when a narrow phone leaves less, and these
 * three numbers are what stop it having to.
 *
 * `model.test.ts` measures every string this module produces against all three,
 * because the alternative is a screen full of "67,32…" and "<1% of dem…" that
 * every layout test still passes.
 */
export const FIGURE_MAX_CH = 6;
export const DETAIL_MAX_CH = 12;
export const ROW_MAX_CH = 15;

/** The scales a compact figure steps through, largest last. */
const SCALES: readonly (readonly [number, string])[] = [
  [1e3, 'K'],
  [1e6, 'M'],
  [1e9, 'B'],
  [1e12, 'T'],
];

/**
 * A number as few characters as it can be without lying: "$810K", "$4.1M".
 *
 * One decimal below ten of a scale, whole numbers above it, and the next scale
 * up before three digits would become four — so the longest this returns is six
 * characters ("-$999K"), which is `FIGURE_MAX_CH`.
 */
function compact(abs: number, prefix: string, sign: string): string {
  if (abs < 999.5) return `${sign}${prefix}${Math.round(abs)}`;
  for (const [div, suffix] of SCALES) {
    const scaled = abs / div;
    if (scaled < 9.95) return `${sign}${prefix}${scaled.toFixed(1)}${suffix}`;
    if (scaled < 999.5) return `${sign}${prefix}${Math.round(scaled)}${suffix}`;
  }
  return `${sign}${prefix}${Math.round(abs / 1e12)}T`;
}

/**
 * Money for a figure tag.
 *
 * The exact dollar belongs in the drawer; the tag's job is to be read in the
 * two seconds the whole picture gets. `formatMoney(_, 'full')` prints
 * "$809,638" — eight characters that take the entire data row and leave the
 * words that say what the money *is* at "67,32…".
 */
export function tagMoney(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return compact(Math.abs(value), '$', value < 0 ? '-' : '');
}

/**
 * A unit count for a figure tag: "280", "67.3K", "14M".
 *
 * `formatCount` prints "14,009,473" — eight digits of precision on a demand
 * figure whose neighbours are within 16% of it, so none of them carries a
 * decision and all of them crowd out the word that says what they are.
 */
export function tagCount(units: number): string {
  if (!Number.isFinite(units)) return '—';
  return compact(Math.abs(units), '', units < 0 ? '-' : '');
}

/**
 * How much of an input one unit takes, in as few characters as the truth allows.
 *
 * Slot quantities in the table run from 10,000 down to 5e-9 (one delivery
 * device per two hundred million calls), so `formatCount` alone would print
 * "0" on a slot that is genuinely consumed — the worst possible lie on a cost
 * screen. Two significant figures below one, whole numbers above.
 */
export function qtyText(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  if (qty >= 1) return formatCount(qty);
  return Number(qty.toPrecision(2))
    .toFixed(12)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/**
 * The recipe, as the header's second line: "40 1M tokens per unit".
 *
 * The slot's own name is the first line, so it is not repeated here; the unit
 * is dropped when it only says the slot's name back.
 */
export function slotRecipe(slotLabel: string, qty: number, unitLabel: string): string {
  const unit = unitLabel.trim().toLowerCase() === slotLabel.trim().toLowerCase() ? '' : `${unitLabel} `;
  return `${qtyText(qty)} ${unit}per unit`;
}

/** The first letter up: engine phrases speak mid-sentence, a pill opens one. */
function sentenceCase(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A market cell in words: "Logistics enterprises", "Consumers". */
function cellName(industry: Sector, customer: ProductSegment): string {
  return sentenceCase(targetPhrase(industry, customer));
}

/** What a compute bill is, in one word. The full word is in the aria. */
const COMPUTE_WORD: Readonly<Record<'reservation' | 'cloud' | 'accelerators', string>> = {
  reservation: 'reservation',
  cloud: 'cloud',
  accelerators: 'accelerators',
};

/** The same, cut to the data row beside a money tag. */
const COMPUTE_SHORT: Readonly<Record<'reservation' | 'cloud' | 'accelerators', string>> = {
  reservation: 'reserved',
  cloud: 'cloud',
  accelerators: 'chips',
};

/** A contracting role, short enough for the row; the full word is in the aria. */
const ROLE_WORD: Readonly<Record<'prime' | 'consortium' | 'subcontractor', string>> = {
  prime: 'prime',
  consortium: 'member',
  subcontractor: 'sub',
};

/* -------------------------------------------------------------------------- */
/*  The supplier column                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The glyph for one supply route: a counterparty, the open market, or a warning.
 *
 * `viewerCompanyId`, never the subject of the view: the brand tint means "this
 * is you" on every other screen, so on a rival's picture it has to mark the
 * reader's own company among the rival's suppliers rather than marking the
 * rival.
 */
function supplyGlyph(option: ConnectionsSupplyOption, viewerCompanyId: string, archetypes: Readonly<Record<string, string>>): PillGlyph {
  if (option.kind === 'market') return { kind: 'icon', name: 'globe' };
  if (option.kind === 'blocked') return { kind: 'icon', name: 'warning' };
  if (option.kind === 'empty') return { kind: 'icon', name: 'plus' };
  const companyId = option.supplierCompanyId;
  if (companyId === null) return { kind: 'icon', name: 'box' };
  return { kind: 'company', companyId, archetype: archetypes[companyId] ?? null, own: companyId === viewerCompanyId };
}

/**
 * The words after the figure, in fourteen characters or fewer.
 *
 * What each one leaves out is deliberate. The slot's own name is the group's
 * header, so it is not repeated; the node a route buys is the pill's name on a
 * market route and the seller's line everywhere else, so it lives in the
 * `aria-label` rather than on a row that would truncate it mid-word. What is
 * left is the one thing that decides between two routes: how much of it I
 * actually drew, what the open market charges over list, or how much better the
 * alternative is.
 */
function supplyDetail(option: ConnectionsSupplyOption, liveQuality: number | null): string | null {
  if (option.kind === 'empty') return 'optional';
  if (option.kind === 'blocked') return 'not made';

  // The viewer's own order book: the one number the privacy rule adds to a
  // wire, and null on every wire the viewer is not standing on.
  if (option.live) {
    const units = option.unitsDrawnLastQuarter;
    // "×67K" beside "$12": how many of them, at what each — the reference's own
    // grammar, and the word "drawn" is in the aria where it costs nothing.
    if (units !== null && units > 0) return `×${tagCount(units)}`;
    return option.kind === 'market' ? `+${option.premiumPct ?? 0}% spot` : null;
  }

  // On a route nobody has taken, quality outranks the spot premium: the premium
  // is already inside the price on the tag beside it, and quality is the other
  // axis the decision turns on. Only when it would change the decision.
  if (option.qualityScore !== null && liveQuality !== null) {
    const gap = Math.abs(option.qualityScore - liveQuality) * 100;
    if (gap >= QUALITY_GAP_POINTS) return `qual ${Math.round(option.qualityScore * 100)}%`;
  }
  return option.kind === 'market' ? `+${option.premiumPct ?? 0}% spot` : null;
}

function supplierGroups(
  view: ConnectionsView,
  archetypes: Readonly<Record<string, string>>,
): readonly PillGroup[] {
  const own = view.isOwn;
  return view.suppliers.map((supplier: ConnectionsSupplier) => {
    const live = supplier.options[0] ?? null;
    const liveQuality = live?.qualityScore ?? null;
    const pills = supplier.options.map((option, index) => {
      const name =
        option.kind === 'empty'
          ? `Add ${supplier.slotLabel.toLowerCase()}`
          : // A blocked slot has no counterparty to name, and a market route has
            // none either — both name the *thing*, which is what you would be
            // buying and, on a blocked slot, what nobody sells.
            option.kind === 'blocked' || option.kind === 'market'
            ? option.nodeLabel
            : option.label.length === 0
              ? supplier.slotLabel
              : option.label;
      const state: PillState = !option.live ? 'possible' : option.kind === 'blocked' ? 'blocked' : option.kind === 'empty' ? 'empty' : 'live';
      // On my own line every route is a decision I can take, so every pill
      // opens the slot. On somebody else's, a supplier is a company I can walk
      // to and nothing more — I cannot fill their slots.
      const action: PillAction | null = own
        ? { kind: 'slot', slotId: supplier.slotId }
        : option.supplierCompanyId === null
          ? null
          : { kind: 'company', companyId: option.supplierCompanyId };
      const figure = option.unitPriceUsd === null ? null : tagMoney(option.unitPriceUsd);
      const detail = supplyDetail(option, liveQuality);
      const thing =
        option.kind === 'market' ? `${option.nodeLabel} on the open market at +${option.premiumPct ?? 0}% spot` : option.nodeLabel;
      // The exact count lives here rather than on the data row: a screen
      // reader has no fourteen-character budget, and "44,440 units drawn" is
      // the half of the wire that is mine.
      const drawn = option.unitsDrawnLastQuarter;
      const book = drawn === null || drawn <= 0 ? '' : `, ${formatCount(drawn)} units drawn`;
      const verb =
        option.kind === 'empty'
          ? `${supplier.slotLabel} is empty`
          : option.kind === 'blocked'
            ? `blocks ${supplier.slotLabel}: nobody in the world makes it`
            : `${option.live ? 'fills' : 'could fill'} ${supplier.slotLabel} with ${thing}${book}`;
      // Walking to my own company from a rival's picture is a legitimate move —
      // their slot may be filled by me — so the label says whose connections
      // open rather than always saying "their".
      const mine = option.supplierCompanyId === view.viewerCompanyId;
      const ariaLabel = own
        ? `${name}${figure === null ? '' : `, ${figure}`} — ${verb}. Change what fills it.`
        : `${name} supplies ${supplier.slotLabel}${figure === null ? '' : ` at ${figure}`}${book}. Open ${
            mine ? 'your own' : 'their'
          } connections.`;
      return {
        key: `slot:${supplier.slotId}:${index}`,
        state,
        glyph: supplyGlyph(option, view.viewerCompanyId, archetypes),
        name,
        figure,
        detail,
        ringPct: null,
        action,
        ariaLabel,
      } satisfies PillModel;
    });

    return {
      key: `slot:${supplier.slotId}`,
      header: supplier.slotLabel,
      subheader: slotRecipe(supplier.slotLabel, supplier.qtyPerUnit, supplier.unitLabel),
      required: supplier.required,
      moreLabel: supplier.moreCount > 0 ? `+${supplier.moreCount} more` : null,
      pills,
    } satisfies PillGroup;
  });
}

/* -------------------------------------------------------------------------- */
/*  The customer column                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How much of everything that leaves this line goes one way.
 *
 * The reference's signature is a green ring on each customer showing their
 * share, and the only denominator that makes every ring on the column mean the
 * same thing is *everything the line put out*: the units named buyers drew plus
 * the units it sold into its own market cell. Those are two separate flows in
 * the engine — a buyer's draw is not netted off the market sale — so summing
 * them is what reconciles the column, and the rings then add to 100 by
 * construction instead of by a clamp that fired on every pill.
 *
 * Zero on a rival's picture, where every unit is null, so a rival's customers
 * carry no ring at all.
 */
export function totalUnitsOut(view: ConnectionsView): number {
  const drawn = view.customers.reduce((total, customer) => total + Math.max(0, customer.unitsDrawnLastQuarter ?? 0), 0);
  return drawn + Math.max(0, view.hub?.unitsSoldLastQuarter ?? 0);
}

/** `units` as a whole percent of `total`, or null when there is no total to be a share of. */
function shareOfOutput(units: number | null, total: number): number | null {
  if (units === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((units / total) * 100)));
}

function buyerPill(
  customer: LineCustomer,
  index: number,
  view: ConnectionsView,
  archetypes: Readonly<Record<string, string>>,
  totalOut: number,
): PillModel {
  const nodeLabel = economicNodeById(customer.buyerNodeId)?.label ?? customer.buyerNodeId;
  const name = customer.internal ? 'Your own line' : (view.companyNames[customer.buyerCompanyId] ?? 'Undisclosed');
  const units = customer.unitsDrawnLastQuarter;
  const action: PillAction = customer.internal
    ? { kind: 'switchLine', productId: customer.buyerProductId }
    : { kind: 'company', companyId: customer.buyerCompanyId };
  return {
    key: `buyer:${customer.buyerCompanyId}:${customer.buyerProductId}:${index}`,
    state: 'live',
    glyph: {
      kind: 'company',
      companyId: customer.buyerCompanyId,
      archetype: archetypes[customer.buyerCompanyId] ?? null,
      // The brand tint marks the reader, not the subject: on a rival's picture
      // it is the reader's own company among the rival's buyers that is "me".
      own: customer.buyerCompanyId === view.viewerCompanyId,
    },
    name,
    // The price they pay is my own published ask, so it is the money tag the
    // reference puts on a customer wire; the units are the order book beside it.
    figure: customer.unitPriceUsd === null ? (units === null ? null : tagCount(units)) : tagMoney(customer.unitPriceUsd),
    detail: units === null ? null : `×${tagCount(units)}`,
    // The reference rings named companies and leaves its third-party market
    // pills bare, and it is right to: a ring compares one customer with
    // another, and a market cell's own row already carries the share of demand,
    // which is a different fraction of a different whole.
    ringPct: shareOfOutput(units, totalOut),
    action,
    ariaLabel: customer.internal
      ? `Your own ${nodeLabel} line draws on this${units === null ? '' : `, ${formatCount(units)} units`}. Show that line.`
      : `${name} draws on this for ${nodeLabel}${units === null ? '' : `, ${formatCount(units)} units`}. Open ${
          customer.buyerCompanyId === view.viewerCompanyId ? 'your own' : 'their'
        } connections.`,
  };
}

/**
 * My share of one cell, rounded but never rounded to nothing.
 *
 * A line selling 1,683 seats into a cell of 12.4 million holds 0.014% of it,
 * and "0% of demand" beside a live green pill reads as a broken screen rather
 * than as a small share. Anything above nothing and below half a point says so.
 */
function sharePhrase(pct: number, units: number | null): string {
  if (pct === 0 && (units ?? 0) > 0) return '<1%';
  return `${pct}%`;
}

function cellPill(cell: ConnectionsCell, index: number, own: boolean): PillModel {
  const name = cellName(cell.industry, cell.customer);
  const share = cell.sharePct === null ? null : sharePhrase(cell.sharePct, cell.myUnits);
  return {
    key: `cell:${cell.cellKey}:${index}`,
    state: cell.live ? 'live' : 'possible',
    glyph: { kind: 'sector', sector: cell.industry },
    name,
    // Live: what I list it at. Not live: how many units that cell is asking
    // for, which is the only thing about a market I do not sell into that is
    // mine to know — and it is the figure that decides whether to aim there.
    figure: cell.live && cell.listPriceUsd !== null ? tagMoney(cell.listPriceUsd) : tagCount(cell.demandUnits),
    detail: cell.live && share !== null ? `${share} share` : 'wanted',
    // No ring. The ring on this column means "how much of my output goes to
    // this named customer"; a cell's share of *demand* is a different fraction
    // of a different whole, and two percentages on one pill is one too many.
    ringPct: null,
    // Re-aiming is a decision only the line's owner gets to take, so a rival's
    // target cell is a fact on the picture and not a button.
    action: own ? { kind: 'aim', industry: cell.industry, customer: cell.customer } : null,
    ariaLabel: !own
      ? `Aimed at ${name}, ${formatCount(cell.demandUnits)} wanted.`
      : cell.live
        ? `Aimed at ${name}${share === null ? '' : `, ${share} of that demand`}. Change the target market.`
        : `Aim at ${name}, ${formatCount(cell.demandUnits)} wanted. Change the target market.`,
  };
}

function customerGroups(
  view: ConnectionsView,
  archetypes: Readonly<Record<string, string>>,
  totalOut: number,
): readonly PillGroup[] {
  const groups: PillGroup[] = [];

  if (view.customers.length > 0) {
    groups.push({
      key: 'buyers',
      header: 'Buyers',
      subheader: null,
      required: false,
      moreLabel: null,
      pills: view.customers.map((customer, index) => buyerPill(customer, index, view, archetypes, totalOut)),
    });
  }

  if (view.cells.length > 0) {
    const live = view.cells.filter((cell) => cell.live);
    const rest = view.cells.filter((cell) => !cell.live);
    const shown = rest.slice(0, MAX_AIM_CELLS);
    const hidden = rest.length - shown.length;
    groups.push({
      key: 'markets',
      header: 'Market',
      subheader: null,
      required: false,
      moreLabel: hidden > 0 ? `+${hidden} more` : null,
      pills: [...live, ...shown].map((cell, index) => cellPill(cell, index, view.isOwn)),
    });
  }

  if (view.agencies.length > 0) {
    groups.push({
      key: 'government',
      header: 'Government',
      subheader: null,
      required: false,
      moreLabel: null,
      pills: view.agencies.map((agency, index) => ({
        key: `agency:${agency.contractId}:${index}`,
        state: 'live' as const,
        glyph: { kind: 'icon' as const, name: 'capitol' as IconName },
        name: agency.shortName,
        figure: tagMoney(agency.totalValueUsd),
        detail: ROLE_WORD[agency.role],
        ringPct: null,
        action: { kind: 'href' as const, href: '/government' },
        ariaLabel: `${agency.name}, ${tagMoney(agency.totalValueUsd)} as ${agency.role}. Open Government.`,
      })),
    });
  }

  const paysMe = view.compute.filter((row) => row.direction === 'pays_me');
  if (paysMe.length > 0) {
    groups.push({
      key: 'compute-in',
      header: 'Company-wide',
      subheader: null,
      required: false,
      moreLabel: null,
      pills: paysMe.map((row, index) => computePill(row.counterpartyCompanyId, row.kind, row.amountUsd, view, archetypes, `in:${index}`, true)),
    });
  }

  // A line with nothing on its right is the single most important thing this
  // screen can say, so it says it as a pill rather than as an absence.
  if (groups.length === 0) {
    groups.push({
      key: 'nobody',
      header: null,
      subheader: null,
      required: false,
      moreLabel: null,
      pills: [
        {
          key: 'nobody:0',
          state: 'empty',
          glyph: { kind: 'icon', name: 'plus' },
          name: 'Nobody buys this yet',
          figure: null,
          detail: 'publish it',
          ringPct: null,
          action: view.isOwn ? { kind: 'line' } : null,
          ariaLabel: 'Nobody buys this yet. Open the line to publish it or aim it at a market with demand.',
        },
      ],
    });
  }

  return groups;
}

/* -------------------------------------------------------------------------- */
/*  Company-wide                                                               */
/* -------------------------------------------------------------------------- */

function computePill(
  counterpartyCompanyId: string,
  kind: 'reservation' | 'cloud' | 'accelerators',
  amountUsd: number | null,
  view: ConnectionsView,
  archetypes: Readonly<Record<string, string>>,
  suffix: string,
  paysMe: boolean,
): PillModel {
  const name = view.companyNames[counterpartyCompanyId] ?? 'Undisclosed';
  return {
    key: `compute:${counterpartyCompanyId}:${suffix}`,
    state: 'live',
    glyph: { kind: 'company', companyId: counterpartyCompanyId, archetype: archetypes[counterpartyCompanyId] ?? null, own: false },
    name,
    figure: amountUsd === null ? null : tagMoney(amountUsd),
    detail: COMPUTE_SHORT[kind],
    ringPct: null,
    action: { kind: 'company', companyId: counterpartyCompanyId },
    ariaLabel: `${name}, ${COMPUTE_WORD[kind]} ${paysMe ? 'they pay for' : 'you pay for'}. Open their connections.`,
  };
}

/* -------------------------------------------------------------------------- */
/*  The whole picture                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One company's Connections, as pills.
 *
 * The left column is one group per slot in the node's own table order, its
 * live fill first and at most two alternatives behind it, then the compute the
 * company pays for. The right is buyers, market cells, agencies, then the
 * compute somebody pays the company for.
 */
export function connectionsModel(view: ConnectionsView, options: ConnectionsModelOptions = {}): ConnectionsModel {
  const archetypes = options.archetypes ?? {};
  const hub = view.hub;
  const line = view.lines.find((entry) => entry.selected) ?? null;
  const totalOut = totalUnitsOut(view);

  const left: PillGroup[] = [...supplierGroups(view, archetypes)];
  const iPay = view.compute.filter((row) => row.direction === 'i_pay');
  if (iPay.length > 0) {
    left.push({
      key: 'compute-out',
      header: 'Company-wide',
      subheader: null,
      required: false,
      moreLabel: null,
      pills: iPay.map((row, index) => computePill(row.counterpartyCompanyId, row.kind, row.amountUsd, view, archetypes, `out:${index}`, false)),
    });
  }

  const right = hub === null ? [] : customerGroups(view, archetypes, totalOut);

  const companyName = view.companyNames[view.subjectCompanyId] ?? 'Undisclosed';
  const figures: string[] = [];
  if (hub !== null) {
    if (hub.unitCostUsd !== null) figures.push(`Cost ${tagMoney(hub.unitCostUsd)}`);
    if (hub.listPriceUsd !== null) figures.push(`Price ${tagMoney(hub.listPriceUsd)}`);
    if (hub.askUsd !== null) figures.push(`Ask ${tagMoney(hub.askUsd)}`);
  }

  return {
    left,
    right,
    hub:
      hub === null
        ? null
        : {
            // A rival's picture is already titled with their company name, and
            // a seeded line is named "<company> <node>", so the line's own name
            // under their hub prints their name twice in a 96-point box. Their
            // hub says what the line *is*, which is what the chips beside it say.
            name: view.isOwn ? (line?.name ?? hub.nodeLabel) : hub.nodeLabel,
            nodeLabel: hub.nodeLabel,
            figures,
            marginPct: hub.grossMarginPct === null ? null : Math.round(hub.grossMarginPct * 100),
            showOutput: true,
            companyId: view.subjectCompanyId,
            companyName,
            archetype: archetypes[view.subjectCompanyId] ?? null,
            own: view.isOwn,
            action: view.isOwn ? { kind: 'line' } : null,
            ariaLabel: view.isOwn
              ? `${line?.name ?? hub.nodeLabel}, your ${hub.nodeLabel} line. Open it.`
              : `${companyName}'s ${hub.nodeLabel} line.`,
          },
  };
}

/* -------------------------------------------------------------------------- */
/*  The layout's input                                                         */
/* -------------------------------------------------------------------------- */

/** The groups a `ConnectionsModel` hands `layoutConnections`, one for one. */
export function layoutGroupsOf(groups: readonly PillGroup[]): readonly LayoutGroup[] {
  return groups.map((group) => ({
    key: group.key,
    header: group.header,
    subheader: group.subheader,
    pills: group.pills.map((pill) => ({ key: pill.key, state: pill.state, nested: pill.nested, parentKey: pill.parentKey })),
  }));
}

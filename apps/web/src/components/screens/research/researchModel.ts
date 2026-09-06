/**
 * Research as three columns: what I hold, me, what I could reach next.
 *
 * The same picture the Products screen draws, asked of technology instead of
 * trade. `researchMapFor` in the engine answers *what do I hold, what is one
 * programme away, what would it cost and what does it get me*; this file turns
 * that answer into pills and groups the shared Connections layout can place,
 * and does nothing else. No engine call, no React, no clock, no random — the
 * inputs are the engine's own figures and the output is text and geometry
 * hints, which is what makes both testable.
 *
 * Two rules it keeps, the same two the rest of the screen layer keeps.
 *
 * 1. **Nothing is computed.** Quarters, costs and progress arrive already
 *    worked out by `programmeForecast` / `runningForecast` inside
 *    `researchMapFor`. A screen that derived a quarter count would be a second,
 *    disagreeing model of the engine.
 * 2. **Order is deterministic.** The engine hands `held` back tier-first and
 *    `options` running-first-then-cheapest; the one reordering here — a node I
 *    run a line on before one I merely own — is a stable sort, so ties keep the
 *    engine's order on every machine.
 */

import type { Sector } from '@frontier/contracts';
import { SECTOR_META } from '@frontier/contracts';
import type { HeldNode, LockedOption, ResearchMapView, ResearchOption } from '@frontier/simulation';
import { MAX_FORECAST_QUARTERS } from '@frontier/simulation';
import { formatCount, formatMoney } from '@frontier/shared';
import { tagMoney, type PillAction } from '@/components/screens/connections/model';

/* -------------------------------------------------------------------------- */
/*  Sizes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Held nodes drawn per sector before the group collapses behind a "+N more".
 *
 * Three, not four: an AI-software company that has bought one energy node holds
 * a column of polysilicon, lithium and graphite it will never open a line on,
 * and every row of it is 52 points of the one screen the picture gets.
 */
export const HELD_PER_SECTOR = 3;
/** Research options drawn before the "Show all" toggle. */
export const OPTIONS_SHOWN = 6;
/** Unlocks nested under one option before the rest collapse into a "+N". */
export const UNLOCKS_PER_OPTION = 2;

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** A pill is live (solid), possible (dashed), blocked or empty — the four the layout knows. */
export type ResearchPillState = 'live' | 'possible' | 'blocked' | 'empty';

/**
 * What tapping a pill does. The screen owns the doing; the model only says
 * which.
 *
 * Carved out of the Connections picture's own `PillAction` rather than
 * declared beside it, so the two cannot drift: this picture is drawn by
 * `ConnectionsDiagram`, and a kind that existed here and not there would be a
 * pill the shared renderer could not hand back.
 */
export type ResearchAction = Extract<PillAction, { kind: 'products' | 'launch' | 'node' | 'expand' | 'showAll' }>;

export interface ResearchPill {
  /** Unique across the whole picture; the layout keys placement off it. */
  readonly key: string;
  readonly state: ResearchPillState;
  readonly label: string;
  /**
   * The tag on the pill's wire edge: the quarters, as the Products picture puts
   * a price there. Empty when the pill is a control rather than a programme.
   */
  readonly figure: string;
  /** The line under the name, at most `DETAIL_MAX_CH` characters. */
  readonly data: string;
  /** Tints the glyph. Null on a control pill, which carries no sector. */
  readonly sector: Sector | null;
  /** Programme progress as a whole percent, drawn as a ring. Null on everything else. */
  readonly ringPct: number | null;
  readonly action: ResearchAction;
  /** Unlocks, drawn indented under the pill on a bracket wire. */
  readonly children: readonly ResearchPill[];
}

export interface ResearchGroup {
  readonly key: string;
  /** Small-caps header above the group, or null for an unlabelled run of pills. */
  readonly header: string | null;
  readonly pills: readonly ResearchPill[];
}

export interface ResearchHub {
  /** The sentence the picture is read by, above it. */
  readonly label: string;
  /** The figures, as one line: "20 nodes held · 1 line". */
  readonly figures: string;
  /** The same figures as separate lines, for the narrow box under the hub disc. */
  readonly figureParts: readonly string[];
}

export interface ResearchDiagramModel {
  readonly hub: ResearchHub;
  readonly left: readonly ResearchGroup[];
  readonly right: readonly ResearchGroup[];
  /** Options not drawn because of the cap. Zero when every one is on the picture. */
  readonly hiddenOptionCount: number;
}

export interface ResearchViewOptions {
  /** Sectors the reader has opened past their first `HELD_PER_SECTOR` held nodes. */
  readonly expandedSectors: ReadonlySet<Sector>;
  /** True once the reader has asked for every option rather than the first six. */
  readonly showAllOptions: boolean;
}

/* -------------------------------------------------------------------------- */
/*  The picture                                                                */
/* -------------------------------------------------------------------------- */

/** The engine's research map as the two columns of pills the diagram places. */
export function researchDiagram(view: ResearchMapView, options: ResearchViewOptions): ResearchDiagramModel {
  const heldCount = view.held.reduce((total, group) => total + group.nodes.length, 0);
  const producingCount = view.held.reduce((total, group) => total + group.nodes.filter((node) => node.producing).length, 0);

  const figureParts = [
    `${formatCount(heldCount)} node${heldCount === 1 ? '' : 's'} held`,
    `${formatCount(producingCount)} line${producingCount === 1 ? '' : 's'}`,
  ];
  return {
    // Short because it lands in a truncating panel subtitle beside a tag; the
    // sentence in full is the page header's, one line above it.
    hub: { label: 'Held → open to you', figures: figureParts.join(' · '), figureParts },
    left: leftGroups(view, options.expandedSectors),
    right: rightGroups(view, options.showAllOptions),
    hiddenOptionCount: Math.max(0, view.options.length - (options.showAllOptions ? view.options.length : OPTIONS_SHOWN)),
  };
}

/**
 * What a programme is short of, in one word that fits the data row.
 *
 * `BOTTLENECK_LABEL` in `nodeState.ts` writes for a sentence ("short of
 * customer data"); a pill's data row is fourteen characters, and "low on
 * customer data" is nineteen.
 */
const SHORT_OF: Readonly<Record<string, string>> = {
  funding: 'money',
  compute: 'compute',
  talent: 'people',
  data: 'data',
};

/**
 * "short of compute" in eight characters.
 *
 * The plus is doing the work "more of" would: the figure beside it is already a
 * quarter count, so "+compute" reads as the thing the programme wants more of.
 * The `aria-label` says it in words, where there is room for them.
 */
function shortOf(bottleneck: string | null): string | null {
  const word = bottleneck === null ? undefined : SHORT_OF[bottleneck];
  return word === undefined ? null : `+${word}`;
}

/* -------------------------------------------------------------------------- */
/*  Left: what I hold                                                          */
/* -------------------------------------------------------------------------- */

function leftGroups(view: ResearchMapView, expanded: ReadonlySet<Sector>): readonly ResearchGroup[] {
  // Owning a node is not the same as being able to make it: a node whose own
  // requirement is still missing is on the locked list, and saying "could open
  // a line" about it would be the screen's one outright lie.
  const short = new Map(view.locked.map((entry) => [entry.nodeId, entry]));
  const out: ResearchGroup[] = [];
  for (const group of view.held) {
    // A line I actually run leads its sector; the engine's tier order survives
    // inside each half because `sort` is stable.
    const ordered = [...group.nodes].sort((a, b) => Number(b.producing) - Number(a.producing));
    const open = expanded.has(group.sector);
    const shown = open ? ordered : ordered.slice(0, HELD_PER_SECTOR);
    const hidden = ordered.length - shown.length;
    const pills: ResearchPill[] = shown.map((node) => heldPill(node, short.get(node.nodeId) ?? null));
    // The same pill both ways. A tap that grows the column with no tap that
    // shrinks it again leaves a founder scrolling past thirteen resource nodes
    // with no way back short of leaving the screen.
    if (hidden > 0) {
      pills.push({
        key: `held_more_${group.sector}`,
        state: 'possible',
        label: `+${formatCount(hidden)} more`,
        figure: '',
        data: 'show them',
        sector: group.sector,
        ringPct: null,
        action: { kind: 'expand', sector: group.sector },
        children: [],
      });
    } else if (open && ordered.length > HELD_PER_SECTOR) {
      pills.push({
        key: `held_more_${group.sector}`,
        state: 'possible',
        label: 'Show fewer',
        figure: '',
        data: `first ${formatCount(HELD_PER_SECTOR)} only`,
        sector: group.sector,
        ringPct: null,
        action: { kind: 'expand', sector: group.sector },
        children: [],
      });
    }
    out.push({
      key: `held_${group.sector}`,
      header: `${SECTOR_META[group.sector].label} · ${formatCount(ordered.length)}`,
      pills,
    });
  }
  return out;
}

/**
 * One node this company already holds.
 *
 * The data row is fourteen characters (`DETAIL_MAX_CH`), so the tier moves to
 * the `aria-label` and what is left is the only thing that separates one held
 * node from another on this picture: whether a line is running on it, whether
 * one could be, or what is standing in the way.
 */
function heldPill(node: HeldNode, short: LockedOption | null): ResearchPill {
  if (node.producing && node.productId !== null) {
    return {
      key: `held_${node.nodeId}`,
      state: 'live',
      label: node.label,
      figure: '',
      data: 'your line',
      sector: node.sector,
      ringPct: null,
      action: { kind: 'products', nodeId: node.nodeId, productId: node.productId },
      children: [],
    };
  }
  return {
    key: `held_${node.nodeId}`,
    state: short === null ? 'possible' : 'blocked',
    label: node.label,
    figure: '',
    data: short === null ? 'could sell' : '1 step short',
    sector: node.sector,
    ringPct: null,
    // The launch flow is still the right destination for a blocked node: its
    // first step names what is missing and offers the three ways in.
    action: { kind: 'launch', nodeId: node.nodeId },
    children: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Right: what I could research                                               */
/* -------------------------------------------------------------------------- */

function rightGroups(view: ResearchMapView, showAll: boolean): readonly ResearchGroup[] {
  // The engine already put running programmes first and sorted the rest
  // cheapest first; the cap therefore never hides work already under way.
  const shown = showAll ? view.options : view.options.slice(0, OPTIONS_SHOWN);
  const running = shown.filter((option) => option.running !== null);
  const open = shown.filter((option) => option.running === null);

  const groups: ResearchGroup[] = [];
  if (running.length > 0) groups.push({ key: 'running', header: 'Under way', pills: running.map(optionPill) });
  if (open.length > 0) groups.push({ key: 'open', header: 'Open to you', pills: open.map(optionPill) });

  const toggle = toggleP(view.options.length, shown.length, showAll);
  if (toggle === null) return groups;
  const last = groups[groups.length - 1];
  if (last === undefined) return [{ key: 'open', header: null, pills: [toggle] }];
  groups[groups.length - 1] = { ...last, pills: [...last.pills, toggle] };
  return groups;
}

/** The "Show all N" / "Show fewer" pill, or null when the cap is not biting. */
function toggleP(total: number, shown: number, showAll: boolean): ResearchPill | null {
  if (total <= OPTIONS_SHOWN) return null;
  return {
    key: 'options_toggle',
    state: 'possible',
    label: showAll ? 'Show fewer' : `Show all ${formatCount(total)}`,
    figure: '',
    data: showAll ? `first ${formatCount(OPTIONS_SHOWN)} only` : `${formatCount(total - shown)} more`,
    sector: null,
    ringPct: null,
    action: { kind: 'showAll' },
    children: [],
  };
}

/**
 * One programme: what it would reach, how long it would take and what it costs.
 *
 * The quarters ride the wire edge as the figure, the way a price does on the
 * Products picture — except when the forecast has run into its own ceiling.
 * `quartersAtPace` clamps at `MAX_FORECAST_QUARTERS`, and its own comment says
 * that beyond it "the honest answer is 'not on this resourcing'", so a
 * saturated forecast prints as the bound it is (">200q") and spends its data
 * row naming what is holding it there rather than repeating a cost range that
 * is not the reason.
 */
function optionPill(option: ResearchOption): ResearchPill {
  const children = unlockPills(option);
  // The payoff, when the picture would otherwise not state it: every programme
  // unlocks its own node, that pill is dropped as a duplicate, and an option
  // whose only unlock was itself would then say nothing about what it buys.
  const payoff = children.length === 0 && sellsItself(option) ? SELL_HINT : null;
  if (option.running !== null) {
    const short = shortOf(option.running.bottleneck);
    return {
      key: `option_${option.nodeId}`,
      state: 'live',
      label: option.label,
      figure: `${formatCount(Math.round(option.running.quartersLeft))}q`,
      data: short ?? payoff ?? `${tagMoney(option.running.quarterlyCostUsd)}/q`,
      sector: option.sector,
      ringPct: Math.round(Math.max(0, Math.min(1, option.running.progress)) * 100),
      action: { kind: 'node', nodeId: option.nodeId, fallbackNodeId: option.nodeId },
      children,
    };
  }
  const [low, high] = option.costRangeUsd;
  const saturated = option.expectedQuarters >= MAX_FORECAST_QUARTERS;
  const short = shortOf(option.bottleneck);
  return {
    key: `option_${option.nodeId}`,
    state: 'possible',
    label: option.label,
    figure: saturated ? `>${formatCount(MAX_FORECAST_QUARTERS)}q` : `~${formatCount(Math.round(option.expectedQuarters))}q`,
    data: saturated && short !== null ? short : (payoff ?? `${tagMoney(low)}–${tagMoney(high)}`),
    sector: option.sector,
    ringPct: null,
    action: { kind: 'node', nodeId: option.nodeId, fallbackNodeId: option.nodeId },
    children,
  };
}

/**
 * The programme's own node, which `unlocksOf` always lists first: holding a
 * node is what lets you sell it. As a nested pill it printed the option's own
 * name back at it — "Training run → Training run · sell it next" — so it is
 * dropped here and stated as `SELL_HINT` on the option's own data line when
 * nothing else is left to draw.
 */
export const SELL_HINT = 'then sell it';

/** True when researching this node would let the company sell that same node. */
function sellsItself(option: ResearchOption): boolean {
  return option.unlocks.some((unlock) => unlock.nodeId === option.nodeId && unlock.kind === 'now_producible');
}

/**
 * What else the programme buys, in the order it matters: something to sell
 * first, then the programme after this one, then a count of the rest.
 *
 * The engine returns `now_producible` before `next_researchable`, so slicing
 * keeps that order without a second sort. The option's own node is filtered
 * out first, so the two drawn slots go to unlocks the reader has not already
 * read on the parent pill — and the "+N more" counts what is left after it.
 */
function unlockPills(option: ResearchOption): readonly ResearchPill[] {
  const others = option.unlocks.filter((unlock) => unlock.nodeId !== option.nodeId);
  const shown = others.slice(0, UNLOCKS_PER_OPTION);
  const pills: ResearchPill[] = shown.map((unlock) => ({
    key: `unlock_${option.nodeId}_${unlock.nodeId}`,
    state: 'possible',
    // The *thing* is the name and what it is for is the data row. Named the
    // other way round — "Lets you sell Inference API" — a 110-point nested pill
    // clamps to "Lets you se…" and four unlocks in a row are the same pill.
    label: unlock.label,
    figure: '',
    data: unlock.kind === 'now_producible' ? 'sell it next' : 'research it',
    sector: option.sector,
    ringPct: null,
    action: { kind: 'node', nodeId: unlock.nodeId, fallbackNodeId: option.nodeId },
    children: [],
  }));
  const hidden = others.length - shown.length;
  if (hidden > 0) {
    pills.push({
      key: `unlock_${option.nodeId}_more`,
      state: 'possible',
      label: `+${formatCount(hidden)} more`,
      figure: '',
      data: 'and more',
      sector: option.sector,
      ringPct: null,
      // The node's own drawer lists every unlock, so "+3" opens the programme
      // rather than an arbitrary one of the three.
      action: { kind: 'node', nodeId: option.nodeId, fallbackNodeId: option.nodeId },
      children: [],
    });
  }
  return pills;
}

/* -------------------------------------------------------------------------- */
/*  Locked, one step away                                                      */
/* -------------------------------------------------------------------------- */

/** The three ways into a node this company cannot reach yet, as chips. */
export type LockedRouteKind = 'research' | 'licence' | 'buy';

export interface LockedRouteChip {
  readonly kind: LockedRouteKind;
  readonly text: string;
  /** False when the world offers no such route; the chip greys rather than vanishing. */
  readonly available: boolean;
  /** The node the chip's drawer should open on, when it opens one. */
  readonly nodeId: string | null;
}

export interface LockedRow {
  readonly nodeId: string;
  readonly label: string;
  /** "Needs Solid-state cell" — the one thing standing in the way. */
  readonly needs: string;
  readonly routes: readonly LockedRouteChip[];
}

/**
 * A node one requirement short, and the ways in.
 *
 * Same three routes, same order and same "an unavailable route is greyed, not
 * hidden" rule as the launch flow's `entryRoutes` — a founder who cannot licence
 * a node needs to be told nobody is licensing it. The figures come off the
 * `LockedOption` the engine already filled from `nodeEntryRoutes`, rather than
 * asking it a second question, and are cut to what fits a phone-width chip.
 */
export function lockedRow(locked: LockedOption): LockedRow {
  const cheapest = [...locked.missing.licensors].sort((a, b) => a.royaltyPct - b.royaltyPct)[0] ?? null;
  const seller = locked.buyInstead[0] ?? null;
  const [low, high] = locked.missing.researchCostRangeUsd;
  return {
    nodeId: locked.nodeId,
    label: locked.label,
    needs: `Needs ${locked.missing.label}`,
    routes: [
      {
        kind: 'research',
        text: locked.missing.researchable ? `Research it ${formatMoney(low)}–${formatMoney(high)}` : 'Cannot be researched',
        available: locked.missing.researchable,
        nodeId: locked.missing.researchable ? locked.missing.nodeId : null,
      },
      {
        kind: 'licence',
        text: cheapest === null ? 'Nobody licenses it' : `Licence from ${cheapest.name} · ${formatCount(cheapest.royaltyPct)}%`,
        available: cheapest !== null,
        nodeId: null,
      },
      {
        kind: 'buy',
        text: seller === null ? 'Nobody sells it' : `Buy from ${seller.name} · ${formatMoney(seller.askUsd)}`,
        available: seller !== null,
        nodeId: null,
      },
    ],
  };
}

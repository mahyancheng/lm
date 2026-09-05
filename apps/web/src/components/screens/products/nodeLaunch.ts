/**
 * The world-3 launch flow, as pure functions.
 *
 * The owner's order, and it is not negotiable: **what to sell → what goes in
 * each slot and where it comes from → who it is aimed at → what it costs to
 * make → the price.** Cost comes before price because a founder who prices
 * before they have costed is guessing, and world 2 let them: it showed a
 * reference price on the launch form and a margin computed from compute alone.
 *
 * Nothing here computes an economic number. `slotOptions`, `unitCostOf`,
 * `costBreakdown`, `nodeEntryRoutes`, `marketCellWeight` and `priceVerdict`
 * are the engine's, and this module only decides which of them a step needs,
 * what the words around them are, and how the founder's draft — a fill per
 * slot, a target cell, a tier — becomes the one `launch_product` ticket the
 * validator is asked to accept. A screen that restated any of that arithmetic
 * would be a second economy.
 */

import type {
  ActionIntent,
  Company,
  EconomicNode,
  LaunchSlotChoice,
  ProductSegment,
  ProductSlotFill,
  Sector,
  SessionState,
  UnitCostLine,
  UnitCostResult,
} from '@frontier/contracts';
import { NODE_ROLE_LABELS, PRODUCT_SEGMENTS, SECTORS, SECTOR_META, economicNodeById, primaryCustomerOf } from '@frontier/contracts';
import {
  defaultIndustryFor,
  launchableNodes,
  marketCellWeight,
  type InputRoute,
  type LaunchCapacityPreview,
  type LaunchableNode,
  type NodeEntryRoutes,
  type NodeSlotOptions,
  type ResolvedFill,
  type SlotCandidate,
} from '@frontier/simulation';

/* -------------------------------------------------------------------------- */
/*  The five steps                                                             */
/* -------------------------------------------------------------------------- */

export const NODE_LAUNCH_STEPS = ['What to sell', 'Inputs', 'Target', 'Cost to make', 'Price'] as const;
export type NodeLaunchStep = 0 | 1 | 2 | 3 | 4;

/** The craft quality every world-3 launch aims at. One lever is enough, and the tier is that lever. */
export const LAUNCH_TARGET_QUALITY = 0.75;

/** The quality tier a launch opens at: the node's own draw, the node's own craft. */
export const DEFAULT_QUALITY_TIER = 0.5;

/* -------------------------------------------------------------------------- */
/*  Which node                                                                 */
/* -------------------------------------------------------------------------- */

/** A launchable node with its own name resolved, ready to list. */
export interface LaunchOption extends LaunchableNode {
  readonly label: string;
  readonly unitLabel: string;
  readonly tier: number;
}

/**
 * Every node this company could put on sale, open ones first, then by tier
 * descending — the most finished thing a founder can make is the thing they
 * most want to see, and a tier-0 commodity is the fallback rather than the
 * headline.
 *
 * A node already sold is kept in the list and marked, because "you already sell
 * this" is a useful answer to "can I sell this", and removing the row would
 * make the list change shape as the company grows.
 */
export function launchOptions(state: SessionState, company: Company): readonly LaunchOption[] {
  return [...launchableNodes(state, company)]
    .map((entry) => ({
      ...entry,
      label: entry.node.label,
      unitLabel: entry.node.unitLabel,
      tier: entry.node.tier,
    }))
    .sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? 1 : -1;
      if (a.alreadySold !== b.alreadySold) return a.alreadySold ? 1 : -1;
      if (b.tier !== a.tier) return b.tier - a.tier;
      return a.label.localeCompare(b.label);
    });
}

/* -------------------------------------------------------------------------- */
/*  Why a node is locked, and the three ways out                               */
/* -------------------------------------------------------------------------- */

/**
 * One sentence saying what stands in the way, naming the nodes rather than
 * saying "requirements not met".
 *
 * Empty string when nothing does, so a caller can render it or not without a
 * second condition.
 */
export function lockReason(routes: NodeEntryRoutes): string {
  if (routes.canProduce || routes.missing.length === 0) return '';
  const names = routes.missing.map((entry) => entry.label);
  const node = economicNodeById(routes.nodeId)?.label ?? routes.nodeId;
  if (names.length === 1 && routes.missing[0]?.nodeId === routes.nodeId) {
    return `You do not own ${node} yet.`;
  }
  return `${node} needs ${names.join(', ')}, and you own none of it yet.`;
}

/** The three ways into a node a company cannot make, in the order a founder should consider them. */
export type EntryRouteKind = 'research' | 'licence' | 'buy';

export interface EntryRouteOffer {
  readonly kind: EntryRouteKind;
  readonly headline: string;
  readonly detail: string;
  /** True when the world currently offers this route at all. */
  readonly available: boolean;
}

/**
 * "Research it, licence it, or buy the output instead", with the world's actual
 * answer to each rather than three generic buttons.
 *
 * A route that nobody offers still appears, greyed, and says why — a founder
 * who cannot licence a node needs to know that nobody is licensing it, not to
 * be shown two buttons and left to infer the third.
 */
export function entryRoutes(routes: NodeEntryRoutes, formatUsd: (value: number) => string): readonly EntryRouteOffer[] {
  const first = routes.missing[0] ?? null;
  const researchable = routes.missing.some((entry) => entry.researchable);
  const licensors = routes.missing.flatMap((entry) => entry.licensors);
  const cheapest = [...licensors].sort((a, b) => a.royaltyPct - b.royaltyPct)[0] ?? null;
  const seller = routes.buyInstead[0] ?? null;

  return [
    {
      kind: 'research',
      headline: 'Research it',
      detail:
        first === null
          ? 'Nothing left to research.'
          : researchable
            ? `A programme against ${first.label} costs ${formatUsd(first.researchCostRangeUsd[0])} to ${formatUsd(first.researchCostRangeUsd[1])} on the table's own estimate.`
            : `${first.label} cannot be reached by research — it has to be bought or licensed.`,
      available: researchable,
    },
    {
      kind: 'licence',
      headline: 'Licence it',
      detail:
        cheapest === null
          ? 'Nobody is currently licensing what you are missing.'
          : `${cheapest.name} licenses it at ${cheapest.royaltyPct}% of revenue, ${formatUsd(cheapest.upfrontUsd)} up front.`,
      available: cheapest !== null,
    },
    {
      kind: 'buy',
      headline: 'Buy the output instead',
      detail:
        seller === null
          ? 'Nobody publishes terms on this node, so there is nothing to buy.'
          : `${seller.name} will sell you the finished thing at ${formatUsd(seller.askUsd)}.`,
      available: seller !== null,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  What the line opens with                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The capacity sentence on the cost step: how much of the company's own bucket
 * the new line starts with, in units a quarter, and where the rest is.
 *
 * A second line on a bucket does not get the bucket: `bucketShare` opens it on
 * a foothold beside the lines already drawing there and lets it grow into more
 * as it sells. A founder who is not told that reads a healthy unit cost and
 * then watches the line ship a fraction of what the suite beside it ships.
 * Empty for a node no bucket constrains.
 */
export function capacitySentence(preview: LaunchCapacityPreview | null, node: EconomicNode, formatUnits: (value: number) => string): string {
  if (preview === null) return '';
  const bucket = CAPACITY_BUCKET_NAME[preview.capacityKind] ?? preview.capacityKind;
  // The node's unit label is singular and not every one takes an s ("kWh", "1M tokens"),
  // so the sentence counts units; the line's subtitle already names the unit.
  const units = `${formatUnits(preview.unitsPerQuarter)} units a quarter`;
  if (preview.sharers === 0) return `Made on your ${bucket}: room for about ${units} at this tier. Add capacity to make more.`;
  const others = preview.sharers === 1 ? 'the line already on it keeps' : `the ${preview.sharers} lines already on it keep`;
  const head = `Opens with ${Math.round(preview.share * 100)}% of your ${bucket} — about ${units} at this tier — and ${others} the rest.`;
  const tail = preview.unitsPerQuarter <= 0 ? ' That share is under one unit, so nothing ships until you add capacity or close a line.' : ' It grows into more as it sells; add capacity if both lines need it.';
  return head + tail;
}

/** The bucket a capacity kind is, in the founder's words. */
const CAPACITY_BUCKET_NAME: Readonly<Record<string, string>> = { compute: 'compute', plant: 'plant', fleet: 'fleet', grid: 'grid' };

/* -------------------------------------------------------------------------- */
/*  Fills: one choice per slot                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One slot's choice as the form holds it: the node in the slot and where it
 * comes from. The company's own id as supplier means MAKE; a seller's id means
 * BUY from that seller's line; null means the open market. A null node leaves
 * the slot empty, which is legal only on a slot the table does not require.
 */
export interface SlotChoice {
  readonly nodeId: string | null;
  readonly supplierCompanyId: string | null;
  readonly supplierProductId: string | null;
}

/** The form's composition: a choice per slot id. */
export type FillMap = Readonly<Record<string, SlotChoice>>;

/** The choice that leaves a slot empty. */
export const EMPTY_CHOICE: SlotChoice = { nodeId: null, supplierCompanyId: null, supplierProductId: null };

/** A resolved fill as a form choice: the same node and the same source the roll-up would take. */
export function choiceOfFill(fill: ResolvedFill): SlotChoice {
  if (fill.nodeId === null) return EMPTY_CHOICE;
  const named = fill.route === 'make' || fill.route === 'buy';
  return {
    nodeId: fill.nodeId,
    supplierCompanyId: named ? fill.supplierCompanyId : null,
    supplierProductId: named ? fill.supplierProductId : null,
  };
}

/** The choice a route stands for on a candidate node. */
export function choiceOfRoute(nodeId: string, route: InputRoute): SlotChoice {
  if (route.kind === 'market') return { nodeId, supplierCompanyId: null, supplierProductId: null };
  return { nodeId, supplierCompanyId: route.supplierCompanyId, supplierProductId: route.supplierProductId };
}

/**
 * What the form opens on: whatever route each slot resolves to before a founder
 * has touched anything — the table's default, made in-house when the company
 * already runs a line on it, so the first costing shown is the costing a
 * founder who changes nothing will launch at.
 *
 * Every slot gets an entry, including the make route on a slot the company
 * fills itself: an entry naming nobody would read as *declining* MAKE, which is
 * allowed but must be a choice, not an accident of a missing key.
 */
export function defaultFills(options: readonly NodeSlotOptions[]): FillMap {
  const out: Record<string, SlotChoice> = {};
  for (const slot of options) {
    out[slot.slotId] = slot.fill === null ? EMPTY_CHOICE : choiceOfFill(slot.fill);
  }
  return out;
}

/** Whether a slot may be left empty at all. Required slots cannot, and the sheet offers no such button on one. */
export function canLeaveEmpty(slot: Pick<NodeSlotOptions, 'required'>): boolean {
  return !slot.required;
}

/**
 * The kind of node a slot takes, for its row, when the slot's own label does
 * not already say so: an app's "Model" slot takes an API, a robot's "Arms" slot
 * a robot. Empty when label and role read the same, singular or plural, so a
 * row never says "Wafer · Wafer".
 */
export function roleCaption(slot: Pick<NodeSlotOptions, 'label' | 'role'>): string {
  const role = NODE_ROLE_LABELS[slot.role];
  const stem = (text: string): string => text.toLowerCase().replace(/s$/, '');
  return stem(role) === stem(slot.label) ? '' : role;
}

/**
 * The fills with one slot set. An empty choice on a required slot is refused
 * and the map comes back unchanged: the validator would refuse the ticket, so
 * the form never holds a draft the validator would not take.
 */
export function withChoice(fills: FillMap, slot: Pick<NodeSlotOptions, 'slotId' | 'required'>, choice: SlotChoice): FillMap {
  if (choice.nodeId === null && !canLeaveEmpty(slot)) return fills;
  return { ...fills, [slot.slotId]: choice };
}

/** The fills as the engine's preview override reads them: one product fill per chosen slot, never memoised. */
export function previewFills(fills: FillMap): readonly ProductSlotFill[] {
  return Object.entries(fills).map(([slotId, choice]) => ({
    slotId,
    nodeId: choice.nodeId,
    supplierCompanyId: choice.supplierCompanyId,
    supplierProductId: choice.supplierCompanyId === null ? null : choice.supplierProductId,
    cutOffNoticeQuarter: null,
    changedQuarter: null,
  }));
}

/** The `slots` array `launch_product` takes: one entry per slot of the node the form has a choice for, in slot order. */
export function slotChoicesFor(node: EconomicNode, fills: FillMap): readonly LaunchSlotChoice[] {
  const out: LaunchSlotChoice[] = [];
  for (const slot of node.slots) {
    const choice = fills[slot.id];
    if (choice === undefined) continue;
    out.push({
      slotId: slot.id,
      nodeId: choice.nodeId,
      supplierCompanyId: choice.supplierCompanyId,
      supplierProductId: choice.supplierCompanyId === null ? null : choice.supplierProductId,
    });
  }
  return out;
}

/** The candidate a choice names, or null for an empty slot or a node the slot no longer admits. */
export function candidateOf(slot: NodeSlotOptions, choice: SlotChoice | undefined): SlotCandidate | null {
  if (choice === undefined || choice.nodeId === null) return null;
  return slot.candidates.find((candidate) => candidate.nodeId === choice.nodeId) ?? null;
}

/** The route a choice stands on, among a candidate's routes, or null when it names nobody the candidate lists. */
export function routeOf(candidate: SlotCandidate, choice: SlotChoice): InputRoute | null {
  if (choice.supplierCompanyId === null) return candidate.routes.find((route) => route.kind === 'market') ?? null;
  return (
    candidate.routes.find(
      (route) => route.kind !== 'market' && route.supplierCompanyId === choice.supplierCompanyId && route.supplierProductId === choice.supplierProductId,
    ) ?? null
  );
}

/**
 * The cheapest way to get one candidate, its quality riding along. Ties go to
 * the higher quality, so two routes at one price are told apart by the thing
 * that differs.
 */
export function bestRouteOf(candidate: SlotCandidate): InputRoute | null {
  let best: InputRoute | null = null;
  for (const route of candidate.routes) {
    if (best === null || route.unitPriceUsd < best.unitPriceUsd || (route.unitPriceUsd === best.unitPriceUsd && route.qualityScore > best.qualityScore)) {
      best = route;
    }
  }
  return best;
}

/** How one slot reads on its row: the node in it and where it comes from, in a few words. */
export function fillSummary(slot: NodeSlotOptions, choice: SlotChoice | undefined, companyId: string): string {
  const candidate = candidateOf(slot, choice);
  if (candidate === null) return slot.required ? 'Nothing chosen' : 'Left empty';
  if (candidate.blocked && (choice?.supplierCompanyId ?? null) === null) return `${candidate.label} · nobody makes it`;
  const supplierId = choice?.supplierCompanyId ?? null;
  if (supplierId === null) return `${candidate.label} · open market`;
  if (supplierId === companyId) return `${candidate.label} · made by you`;
  const route = choice === undefined ? null : routeOf(candidate, choice);
  return `${candidate.label} · ${route?.label ?? 'named seller'}`;
}

/* -------------------------------------------------------------------------- */
/*  Target: who it is aimed at                                                 */
/* -------------------------------------------------------------------------- */

/** Where a line is aimed: who signs, and what business they are in. */
export interface TargetChoice {
  readonly customer: ProductSegment;
  readonly industry: Sector;
}

/** The customer type in words, after an industry: "Logistics enterprises". */
export const CUSTOMER_PLURAL: Readonly<Record<ProductSegment, string>> = {
  consumer: 'the public',
  enterprise: 'enterprises',
  developer_api: 'developers',
  government: 'government buyers',
};

/** The short chip label for a customer type. */
export const CUSTOMER_CHIP: Readonly<Record<ProductSegment, string>> = {
  consumer: 'The public',
  enterprise: 'Enterprises',
  developer_api: 'Developers',
  government: 'Government',
};

/** The target a launch opens on: the heaviest customer type and the heaviest industry in the node's own market. */
export function defaultTarget(node: EconomicNode): TargetChoice {
  return { customer: primaryCustomerOf(node), industry: defaultIndustryFor(node) };
}

/** Every customer type with its share of the node's end demand, in `PRODUCT_SEGMENTS` order. Zero-weight types stay: a founder may aim there and be told. */
export function customerChoices(node: EconomicNode): readonly { readonly customer: ProductSegment; readonly weight: number }[] {
  return PRODUCT_SEGMENTS.map((customer) => ({ customer, weight: node.market.customers[customer] ?? 0 }));
}

/** Every industry with the weight of its cell for `customer`, in `SECTORS` order. */
export function industryChoices(node: EconomicNode, customer: ProductSegment): readonly { readonly industry: Sector; readonly weight: number }[] {
  return SECTORS.map((industry) => ({ industry, weight: marketCellWeight(node, industry, customer) }));
}

/** The industry the ticket carries. Selling to the public has no industry, so a consumer target sends none. */
export function targetIndustryOf(target: TargetChoice): Sector | null {
  return target.customer === 'consumer' ? null : target.industry;
}

/**
 * The cell's weight in words: "Logistics enterprises are 22% of who buys this."
 *
 * Whole percent, per the house rules. A cell with no weight says so plainly
 * rather than showing 0%, because a line aimed there sells nothing and the
 * founder should read that before the validator's advisory says it.
 */
export function targetSentence(node: EconomicNode, target: TargetChoice): string {
  if (target.customer === 'consumer') {
    const share = Math.round(marketCellWeight(node, 'consumer', 'consumer') * 100);
    return share === 0
      ? `Nobody in the public buys ${node.label.toLowerCase()}: a line aimed there sells nothing.`
      : `The public is ${share}% of who buys this.`;
  }
  const who = `${SECTOR_META[target.industry].label} ${CUSTOMER_PLURAL[target.customer]}`;
  const share = Math.round(marketCellWeight(node, target.industry, target.customer) * 100);
  return share === 0 ? `${who} do not buy ${node.label.toLowerCase()}: a line aimed there sells nothing.` : `${who} are ${share}% of who buys this.`;
}

/* -------------------------------------------------------------------------- */
/*  Cost, grouped by slot                                                      */
/* -------------------------------------------------------------------------- */

/** One row of the cost step: a slot with what fills it, or one conversion line. */
export interface CostRow {
  readonly key: string;
  /** The slot's label for an input row, the conversion line's label otherwise. */
  readonly label: string;
  /** What is in the slot, or empty for a conversion row. */
  readonly detail: string;
  readonly amountUsd: number;
  /** Whole percent of the unit cost. */
  readonly sharePct: number;
  readonly sourceKind: UnitCostLine['sourceKind'];
}

/**
 * The roll-up in the order a founder reads a bill of materials: one row per
 * slot in slot order, each naming the node in it and where it comes from, then
 * the conversion lines. Amounts are the engine's; this only labels them.
 */
export function costRowsBySlot(node: EconomicNode, result: UnitCostResult, companyNames: ReadonlyMap<string, string>, companyId: string): { readonly inputs: readonly CostRow[]; readonly making: readonly CostRow[] } {
  const total = result.unitCostUsd;
  const share = (amount: number): number => (total <= 0 ? 0 : Math.round((amount / total) * 100));
  const inputs: CostRow[] = [];
  for (const slot of node.slots) {
    const line = result.lines.find((entry) => entry.slotId === slot.id);
    if (line === undefined) continue;
    const filledWith = line.nodeId ?? null;
    const source =
      filledWith === null
        ? 'left empty'
        : line.sourceKind === 'make'
          ? 'made by you'
          : line.sourceKind === 'buy' && line.sourceCompanyId !== null
            ? (companyNames.get(line.sourceCompanyId) ?? line.sourceCompanyId)
            : result.blockedInputNodeIds.includes(filledWith)
              ? 'nobody makes it'
              : 'open market';
    const detail = filledWith === null ? source : `${economicNodeById(filledWith)?.label ?? filledWith} · ${source}`;
    inputs.push({ key: line.key, label: slot.label, detail, amountUsd: line.amountUsd, sharePct: share(line.amountUsd), sourceKind: line.sourceKind });
  }
  const making: CostRow[] = result.lines
    .filter((line) => line.sourceKind === 'conversion')
    .map((line) => ({
      key: line.key,
      label: line.label,
      detail: line.sourceCompanyId === null || line.sourceCompanyId === companyId ? '' : (companyNames.get(line.sourceCompanyId) ?? ''),
      amountUsd: line.amountUsd,
      sharePct: share(line.amountUsd),
      sourceKind: line.sourceKind,
    }));
  return { inputs, making };
}

/** Whether the costing step has anything a founder must act on before pricing. */
export function costingBlockers(result: UnitCostResult): readonly string[] {
  return result.blockedInputNodeIds.map((nodeId) => economicNodeById(nodeId)?.label ?? nodeId);
}

/* -------------------------------------------------------------------------- */
/*  The tier                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the one slider does, under it: the capacity a unit draws and the
 * quality it delivers both scale by `0.5 + tier`, the engine's own factor.
 */
export function tierCaption(tier: number): string {
  const factor = Math.round((0.5 + Math.max(0, tier)) * 100) / 100;
  return `Each unit draws ${factor}× the node's baseline capacity and delivers quality in the same proportion. Capacity is real unit cost, not a phantom margin.`;
}

/* -------------------------------------------------------------------------- */
/*  The ticket                                                                 */
/* -------------------------------------------------------------------------- */

export interface LaunchDraft {
  readonly node: EconomicNode;
  readonly name: string;
  readonly priceUsd: number;
  readonly marketingUsd: number;
  /** The quality tier, 0..1: one lever scaling the capacity a unit draws and the quality it delivers. */
  readonly qualityTier: number;
  readonly target: TargetChoice;
  readonly fills: FillMap;
}

/**
 * The `launch_product` intent, or null when the form is not yet a legal ticket.
 *
 * `categoryId` carries the NODE id in world 3 — the two id spaces are disjoint,
 * every node id having a table prefix. `segment` and `targetIndustry` are the
 * founder's target cell, `slots` their composition, `computeIntensity` the
 * tier — the engine writes it to `qualityTier` — and `targetQuality` is fixed:
 * one lever, not two. `supply` is world 2's and goes empty.
 */
export function launchIntent(draft: LaunchDraft): ActionIntent | null {
  const name = draft.name.trim();
  if (name.length === 0) return null;
  if (!Number.isFinite(draft.priceUsd) || draft.priceUsd < 0) return null;
  const tier = Number.isFinite(draft.qualityTier) ? Math.min(1, Math.max(0, draft.qualityTier)) : DEFAULT_QUALITY_TIER;
  return {
    type: 'launch_product',
    name: name.slice(0, 80),
    segment: draft.target.customer,
    categoryId: draft.node.id,
    pricePerSeatUsd: draft.priceUsd,
    computeIntensity: tier,
    launchMarketingUsd: Number.isFinite(draft.marketingUsd) && draft.marketingUsd > 0 ? draft.marketingUsd : 0,
    targetQuality: LAUNCH_TARGET_QUALITY,
    supply: [],
    targetIndustry: targetIndustryOf(draft.target),
    slots: [...slotChoicesFor(draft.node, draft.fills)],
  };
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The line under the price control: where this price sits against the node's
 * own market price, and what margin it leaves after the roll-up.
 *
 * Whole percent both times, per the house rules, and it says "under cost" in
 * words rather than showing a negative margin and hoping.
 */
export function priceSentence(
  priceUsd: number,
  marketPriceUsd: number,
  unitCostUsd: number,
  formatUsd: (value: number) => string,
): string {
  const against =
    marketPriceUsd <= 0 ? '' : `${Math.abs(Math.round(((priceUsd - marketPriceUsd) / marketPriceUsd) * 100))}% ${priceUsd >= marketPriceUsd ? 'above' : 'below'} the market at ${formatUsd(marketPriceUsd)}`;
  if (priceUsd <= 0) return against === '' ? 'Free.' : `Free — ${against}.`;
  const margin = Math.round(((priceUsd - unitCostUsd) / priceUsd) * 100);
  const marginPart = margin < 0 ? `${Math.abs(margin)}% under cost` : `a ${margin}% gross margin`;
  return against === '' ? `${marginPart}.` : `${against}, ${marginPart}.`;
}

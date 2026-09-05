/**
 * @frontier/contracts — nodeOwnership.ts
 *
 * Who may produce what, and where a company starts.
 *
 * The owner's sentence, mechanised: *"I'm an AI lab, I shouldn't start with
 * having techs of robotics. I can purchase or invest but I don't start with it.
 * Vice versa for all industries."*
 *
 * A starting position is therefore **derived by rule**, never hand-written per
 * background. Twenty-four hand-written lists would rot inside a month and the
 * day a node is renamed half of them go dangling in silence. The rule has four
 * parts, unioned:
 *
 * 1. every node in the background's **own sector** at or below its tier reach,
 *    whose maturity is commodity or established — what an incumbent in that
 *    industry simply knows how to make;
 * 2. two to four **signature nodes**, the reason you picked that card;
 * 3. every **tier-0 commodity resource**, in every sector — nobody owns iron
 *    ore exclusively;
 * 4. the **`requires` closure of your own starting product**, so you can always
 *    make the thing you sell.
 *
 * `BACKGROUND_TIER_REACH` is one integer per background and applies to that
 * background's own sector only. A frontier laboratory reaches tier 6 in `ai`
 * and *nothing at all* in robotics, energy, manufacturing or logistics; a
 * freight network reaches tier 7, the operations run on a platform.
 */

import type { Company, ProductSegment } from './company';
import { ECONOMIC_NODES, ECONOMIC_NODES_BY_ID } from './nodeGraph';
import { STARTING_MATURITIES, type EconomicNode, type NodeTier } from './nodes';
import { ALL_BACKGROUND_IDS, sectorForBackground, type BackgroundId } from './session';
import type { Sector } from './sectors';

/* -------------------------------------------------------------------------- */
/*  Reach                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How far up its own sector's chain each background already reaches. One
 * integer, applied to the background's own sector and to nothing else.
 *
 * A precision-components house reaches tier 3 — it makes parts, not products.
 * A grid developer reaches 6, because a grid developer's product *is* a
 * contract. A freight network reaches 7, because line haul is an operation run
 * on a platform. A bootstrapper reaches 4: enough to sell something, not enough
 * to be safe.
 */
export const BACKGROUND_TIER_REACH: Readonly<Record<BackgroundId, NodeTier>> = {
  // ai
  frontier_lab: 6,
  enterprise_ai: 6,
  consumer_ai: 6,
  infrastructure: 5,
  bootstrapper: 4,
  // robotics
  warehouse_robotics: 5,
  humanoid_lab: 5,
  // manufacturing
  contract_manufacturer: 5,
  precision_components: 3,
  // energy
  grid_developer: 6,
  renewables_operator: 5,
  // logistics: line haul and last mile are operations at tier 7
  freight_network: 7,
  last_mile: 7,
  // consumer: a retail platform runs a brand at tier 7
  direct_brand: 5,
  retail_platform: 7,
};

/**
 * The two to four nodes that are the reason a founder chose that card. The
 * **first entry is the starting product** — the node of the composed line in
 * `BACKGROUND_OPENING_LINE` below, which `startingLineNodeFor` reads — and its
 * `requires` closure is added on top, so a new company can always make the
 * thing it sells.
 */
export const BACKGROUND_SIGNATURE_NODES: Readonly<Record<BackgroundId, readonly string[]>> = {
  frontier_lab: ['sys_frontier_model', 'svc_training_run', 'dat_web_corpus', 'dat_preference_data'],
  enterprise_ai: ['app_ai_software_suite', 'svc_inference_api', 'app_vertical_ai_app'],
  consumer_ai: ['app_consumer_subscription', 'svc_inference_api', 'sys_efficient_small_model'],
  infrastructure: ['svc_training_run', 'svc_inference_api', 'svc_datacentre_capacity'],
  bootstrapper: ['app_vertical_ai_app', 'svc_inference_api'],
  warehouse_robotics: ['sys_warehouse_amr', 'cmp_precision_actuator', 'sys_edge_compute_module'],
  humanoid_lab: ['sys_humanoid_robot', 'sys_robot_policy_model', 'dat_robot_telemetry'],
  contract_manufacturer: ['sys_advanced_package', 'mat_wafer_300mm', 'cmp_logic_die', 'cmp_ic_substrate'],
  precision_components: ['cmp_precision_actuator', 'mat_machined_structure', 'cmp_power_electronics'],
  grid_developer: ['svc_power_purchase_agreement', 'sys_substation', 'svc_grid_interconnect'],
  renewables_operator: ['sys_solar_array', 'mat_solar_module', 'sys_grid_storage_system'],
  freight_network: ['svc_line_haul', 'sys_electric_truck', 'svc_routing_platform'],
  last_mile: ['svc_last_mile', 'sys_delivery_van', 'mat_packaging_materials'],
  direct_brand: ['sys_consumer_device', 'cmp_consumer_soc', 'svc_brand_retail'],
  retail_platform: ['app_marketplace', 'svc_brand_retail', 'dat_consumer_behaviour'],
};

/* -------------------------------------------------------------------------- */
/*  The composed opening line                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One slot of a seeded line, as the scenario declares it: which node sits in
 * the slot and where it comes from.
 *
 * `source` is `'self'` for the company's own line on that node (MAKE),
 * `'market'` for the open market, or the slug of the seeded rival whose
 * published line supplies it (BUY). Slugs belong to the simulation's world-2
 * seeds; the contracts layer carries them as plain strings and the scenario
 * test holds every one against a real published line.
 */
export interface W3SeedFill {
  readonly slotId: string;
  readonly nodeId: string;
  readonly source: 'self' | 'market' | string;
}

/**
 * One line a company opens selling in world 3, composed on purpose.
 *
 * `revenueShare` is the fraction of the seed's declared revenue this line
 * books; a company's lines sum to one. A slot the `fills` do not name runs on
 * the table's default from the open market. `published` opens the line to
 * every other company at its list price from quarter zero.
 */
export interface W3SeedLine {
  readonly nodeId: string;
  readonly revenueShare: number;
  /** The customer type the line is aimed at. */
  readonly segment: ProductSegment;
  /** The industry the line is aimed at; collapses to `consumer` when the customer is the public. */
  readonly targetIndustry: Sector;
  readonly published: boolean;
  readonly fills: readonly W3SeedFill[];
}

/**
 * The composed line each background opens selling: the first signature node,
 * filled with real sources and aimed at a real cell.
 *
 * Every node named in a fill is admissible for its slot and every supplier
 * slug names a seeded rival whose line on that node is published at quarter
 * zero; `world3Scenario.test.ts` holds both against the built world. A
 * background has exactly one opening line, so no fill here may say `'self'`:
 * a humanoid laboratory owns the policy-model node and may open a line on it,
 * but until it does the humanoid's model comes from the open market.
 */
export const BACKGROUND_OPENING_LINE: Readonly<Record<BackgroundId, W3SeedLine>> = {
  frontier_lab: {
    nodeId: 'sys_frontier_model',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'ai',
    published: true,
    fills: [
      { slotId: 'corpus', nodeId: 'dat_web_corpus', source: 'kestrel' },
      { slotId: 'preference', nodeId: 'dat_preference_data', source: 'kestrel' },
    ],
  },
  // The plan's own description of this line: "your AI software suite on
  // Basalt's inference API with an agent harness from the open market, aimed
  // at logistics enterprises".
  enterprise_ai: {
    nodeId: 'app_ai_software_suite',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'logistics',
    published: false,
    fills: [
      { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
      { slotId: 'harness', nodeId: 'svc_agent_harness', source: 'market' },
    ],
  },
  // The owner's chain at quarter zero: Sable's model behind Aletheia's harness,
  // two companies in two slots of one consumer app.
  consumer_ai: {
    nodeId: 'app_consumer_subscription',
    revenueShare: 1,
    segment: 'consumer',
    targetIndustry: 'consumer',
    published: false,
    fills: [
      { slotId: 'model', nodeId: 'svc_inference_api', source: 'sable' },
      { slotId: 'harness', nodeId: 'svc_agent_harness', source: 'aletheia' },
      { slotId: 'data', nodeId: 'dat_consumer_behaviour', source: 'lumen' },
    ],
  },
  infrastructure: {
    nodeId: 'svc_training_run',
    revenueShare: 1,
    segment: 'developer_api',
    targetIndustry: 'ai',
    published: true,
    fills: [{ slotId: 'corpus', nodeId: 'dat_web_corpus', source: 'kestrel' }],
  },
  bootstrapper: {
    nodeId: 'app_vertical_ai_app',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'manufacturing',
    published: false,
    fills: [
      { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
      { slotId: 'harness', nodeId: 'svc_copilot_framework', source: 'sable' },
    ],
  },
  warehouse_robotics: {
    nodeId: 'sys_warehouse_amr',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'logistics',
    published: false,
    fills: [
      { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
      { slotId: 'battery', nodeId: 'sys_battery_pack_lfp', source: 'cinder' },
      { slotId: 'model', nodeId: 'sys_robot_policy_model', source: 'wrenford' },
      { slotId: 'harness', nodeId: 'svc_robot_control_stack', source: 'palma' },
    ],
  },
  humanoid_lab: {
    nodeId: 'sys_humanoid_robot',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'manufacturing',
    published: false,
    fills: [
      { slotId: 'actuators', nodeId: 'cmp_precision_actuator', source: 'ironvale' },
      { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
      { slotId: 'model', nodeId: 'sys_robot_policy_model', source: 'market' },
      { slotId: 'harness', nodeId: 'svc_robot_control_stack', source: 'palma' },
    ],
  },
  contract_manufacturer: {
    nodeId: 'sys_advanced_package',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'manufacturing',
    published: true,
    fills: [],
  },
  precision_components: {
    nodeId: 'cmp_precision_actuator',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'robotics',
    published: true,
    fills: [
      { slotId: 'structure', nodeId: 'mat_machined_structure', source: 'rasan' },
      { slotId: 'wafer', nodeId: 'mat_wafer_300mm', source: 'tessellate' },
    ],
  },
  grid_developer: {
    nodeId: 'svc_power_purchase_agreement',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'ai',
    published: true,
    fills: [
      { slotId: 'interconnect', nodeId: 'svc_grid_interconnect', source: 'grimsby' },
      { slotId: 'generation', nodeId: 'sys_solar_array', source: 'suryan' },
    ],
  },
  renewables_operator: {
    nodeId: 'sys_solar_array',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'energy',
    published: true,
    fills: [
      { slotId: 'modules', nodeId: 'mat_solar_module', source: 'suryan' },
      { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
      { slotId: 'transformer', nodeId: 'cmp_transformer', source: 'rasan' },
    ],
  },
  freight_network: {
    nodeId: 'svc_line_haul',
    revenueShare: 1,
    segment: 'enterprise',
    targetIndustry: 'manufacturing',
    published: false,
    fills: [
      { slotId: 'vehicle', nodeId: 'sys_electric_truck', source: 'harbourline' },
      { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
    ],
  },
  last_mile: {
    nodeId: 'svc_last_mile',
    revenueShare: 1,
    segment: 'consumer',
    targetIndustry: 'consumer',
    published: false,
    fills: [
      { slotId: 'vehicle', nodeId: 'sys_delivery_van', source: 'dune' },
      { slotId: 'drones', nodeId: 'sys_autonomous_drone', source: 'sentinel' },
      { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
    ],
  },
  direct_brand: {
    nodeId: 'sys_consumer_device',
    revenueShare: 1,
    segment: 'consumer',
    targetIndustry: 'consumer',
    published: true,
    fills: [
      { slotId: 'soc', nodeId: 'cmp_consumer_soc', source: 'vasant' },
      { slotId: 'cell', nodeId: 'cmp_battery_cell_lfp', source: 'cinder' },
    ],
  },
  retail_platform: {
    nodeId: 'app_marketplace',
    revenueShare: 1,
    segment: 'consumer',
    targetIndustry: 'consumer',
    published: true,
    fills: [
      { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
      { slotId: 'data', nodeId: 'dat_consumer_behaviour', source: 'lumen' },
    ],
  },
};

/**
 * The node a background's company opens selling: its composed opening line's
 * node, which is also the first entry of its signature. Total over every
 * background.
 */
export function startingLineNodeFor(background: BackgroundId): string {
  return BACKGROUND_OPENING_LINE[background].nodeId;
}

/* -------------------------------------------------------------------------- */
/*  The rule                                                                   */
/* -------------------------------------------------------------------------- */

/** Every tier-0 commodity. Nobody has an exclusive claim on what comes out of the ground. */
export function commodityResourceNodeIds(): readonly string[] {
  return ECONOMIC_NODES.filter((entry) => entry.tier === 0 && entry.maturity === 'commodity').map((entry) => entry.id);
}

/** The transitive `requires` closure of a node, including the node itself. Terminating: `requires` is acyclic. */
export function requiresClosure(nodeId: string, seen: Set<string> = new Set<string>()): readonly string[] {
  if (seen.has(nodeId)) return [];
  const node = ECONOMIC_NODES_BY_ID[nodeId];
  if (node === undefined) return [];
  seen.add(nodeId);
  const out: string[] = [nodeId];
  for (const required of node.requires) out.push(...requiresClosure(required, seen));
  return out;
}

/**
 * Every node a company in `sector` with this reach simply knows how to make:
 * its own sector, at or below the reach, and nothing anybody had to invent.
 */
export function sectorReachNodeIds(sector: Sector, tierReach: number): readonly string[] {
  return ECONOMIC_NODES.filter(
    (entry) => entry.sector === sector && entry.tier <= tierReach && STARTING_MATURITIES.includes(entry.maturity),
  ).map((entry) => entry.id);
}

/**
 * Deduplicate while keeping the table's own order, which is what makes the
 * result identical on every machine and safe to hash.
 */
function inTableOrder(ids: Iterable<string>): readonly string[] {
  const wanted = new Set(ids);
  return ECONOMIC_NODES.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id);
}

/**
 * The nodes a company founded on `background` owns at quarter zero.
 *
 * Deterministic and pure: the same background always yields the same list, in
 * the node table's own order, on any machine, forever.
 */
export function startingNodesFor(background: BackgroundId): readonly string[] {
  const sector = sectorForBackground(background);
  const reach = BACKGROUND_TIER_REACH[background];
  const ids = new Set<string>([
    ...sectorReachNodeIds(sector, reach),
    ...BACKGROUND_SIGNATURE_NODES[background],
    ...commodityResourceNodeIds(),
    ...requiresClosure(startingLineNodeFor(background)),
  ]);
  return inTableOrder(ids);
}

/** The highest tier in the table, restated for the reach rule. */
const TOP_TIER: NodeTier = 7;

/**
 * The same rule for a seeded rival, whose reach comes from how capable the
 * scenario says it is: `round(1 + 6 × capabilityLevel)`, clamped to the tiers
 * that exist. A rival at capability 0 still makes materials; a rival at 1
 * reaches the top of its own chain, operations included.
 */
export function rivalTierReach(capabilityLevel: number): NodeTier {
  const raw = Math.round(1 + 6 * capabilityLevel);
  const clamped = Math.min(TOP_TIER, Math.max(0, raw));
  return clamped as NodeTier;
}

/** The nodes a seeded rival in `sector` at `capabilityLevel` owns at quarter zero. */
export function startingNodesForRival(sector: Sector, capabilityLevel: number, signature: readonly string[] = []): readonly string[] {
  const ids = new Set<string>([
    ...sectorReachNodeIds(sector, rivalTierReach(capabilityLevel)),
    ...signature,
    ...commodityResourceNodeIds(),
  ]);
  for (const id of signature) for (const required of requiresClosure(id)) ids.add(required);
  return inTableOrder(ids);
}

/* -------------------------------------------------------------------------- */
/*  Can this company make this?                                                */
/* -------------------------------------------------------------------------- */

/** Whether the company holds this node outright, or under a licence still in force. */
export function holdsNode(company: Company, nodeId: string, quarter = 0): boolean {
  if (company.ownedNodes?.includes(nodeId) === true) return true;
  return (company.licences ?? []).some((licence) => licence.nodeId === nodeId && licence.expiryQuarter > quarter);
}

/**
 * Whether the company may produce this node at all: it holds the node, and it
 * holds every node the node `requires`.
 *
 * This is the check world 2 got wrong. There, `dependencySatisfied` asked
 * whether a node was globally achieved by *anybody*, and exactly one of
 * forty-two seed nodes was, so on turn one nearly every technology and a dozen
 * product lines were locked for everyone — incumbents already selling them
 * included. Here the question is only ever about this company.
 */
export function canProduce(company: Company, nodeId: string, quarter = 0): boolean {
  const node = ECONOMIC_NODES_BY_ID[nodeId];
  if (node === undefined) return false;
  if (!holdsNode(company, nodeId, quarter)) return false;
  for (const required of node.requires) if (!holdsNode(company, required, quarter)) return false;
  return true;
}

/** Nodes this company may produce right now, in table order. What the launch screen offers. */
export function producibleNodes(company: Company, quarter = 0): readonly EconomicNode[] {
  return ECONOMIC_NODES.filter((entry) => canProduce(company, entry.id, quarter));
}

/** Every background id, for tests and pickers that walk them all. Re-exported for convenience. */
export const OWNERSHIP_BACKGROUND_IDS = ALL_BACKGROUND_IDS;

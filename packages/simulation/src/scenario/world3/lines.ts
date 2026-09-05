/**
 * @frontier/simulation — scenario/world3/lines.ts
 *
 * What every seeded rival opens selling in world 3, composed on purpose.
 *
 * The owner's third north star only means something if the background economy
 * is already doing it when the game opens: Sable's inference API runs on
 * Sable's own small model; Basalt's runs on Aletheia's frontier model; Aletheia
 * sells its AI software suite on Basalt's API; Ironvale's warehouse robot
 * carries Cinder's LFP pack and runs Wrenford's policy model; Overland's
 * routing platform runs on Sable's API and Copa's marketplace on Basalt's. Every
 * one of those is a published line another company buys through a slot, so a
 * founder who opens the canvas on quarter zero sees a supply chain that is
 * already wired, and a founder who publishes a model has rivals who could
 * build on it.
 *
 * The harness layer has sellers of its own, because "a harness from company B"
 * needs a company B: Aletheia publishes an agent harness and Sable a copilot
 * framework, so an app founder chooses between two harness nodes from two
 * companies and not between two anonymous market prices; Palma publishes the
 * robot control stack every arm and warehouse robot runs on; and Volta lays up
 * the carbon composite its own turbine blades take, so a structure slot
 * anywhere in the world chooses between Rasan's machined structure and Volta's
 * composite — two nodes, two producers.
 *
 * ## The shape
 *
 * One to three `W3SeedLine`s per rival, in the order the company's products are
 * built. `revenueShare` splits the world-2 seed's declared revenue between
 * them; `fills` name the slots the company has an opinion about — a slot left
 * unnamed runs on the table's default from the open market, exactly as a
 * launch with no choices does. A `'self'` source is honoured only when the same
 * company runs a line on that node in this table; a supplier slug is honoured
 * only when that rival's line on the node is published here. Both are held by
 * `world3Scenario.test.ts` against the built world, resolving every fill
 * through `resolveFill` and asserting the route it lands on.
 *
 * ## Determinism
 *
 * A constant table. Product ids derive from the seed's slug and the line's
 * position (`w3SeedProductId`), so a fill can name another company's line
 * before either company exists.
 */

import type { W3SeedLine } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { W2_COMPANIES } from '../world2';

export type { W3SeedFill, W3SeedLine } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Ids                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The product id of a seed's line by position: the first keeps the id the
 * world-2 seed always had (`prd_<slug>_core`), so fixtures and saves that name
 * it keep naming it; later lines are `prd_<slug>_line2`, `prd_<slug>_line3`.
 */
export function w3SeedProductId(slug: string, index: number): string {
  return index === 0 ? makeId('prd', slug, 'core') : makeId('prd', slug, `line${index + 1}`);
}

/** The company id a seed slug resolves to: the same derivation the world-2 seeds use. */
export function w3SeedCompanyId(slug: string): string {
  return makeId('cmp', slug);
}

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The composed lines of the twenty-four seeded rivals, keyed by company id. A
 * line added after the first two keeps the earlier lines' positions, so the
 * product ids fixtures and saves already name stay where they are.
 *
 * Sources name seed slugs (`'basalt'`, `'cinder'`), `'self'` or `'market'`. A
 * published line is open to every company at its list price from quarter zero;
 * an unpublished one is published by the NPC policy on quarter one regardless,
 * so the flag decides only what the founder sees before the first End Quarter.
 */
export const W3_RIVAL_LINES: Readonly<Record<string, readonly W3SeedLine[]>> = {
  /* --- AI ---------------------------------------------------------------- */
  [W2_COMPANIES.aletheia]: [
    {
      nodeId: 'sys_frontier_model',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'ai',
      published: true,
      // The corpus is the lab's own crawl, bought at spot: the largest lab in
      // the world does not license its web corpus from a broker. The graded
      // comparisons it does license, from Kestrel.
      fills: [{ slotId: 'preference', nodeId: 'dat_preference_data', source: 'kestrel' }],
    },
    {
      nodeId: 'app_ai_software_suite',
      revenueShare: 0.35,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: false,
      fills: [
        { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
        { slotId: 'harness', nodeId: 'svc_agent_harness', source: 'self' },
      ],
    },
    // The harness the lab's own suite runs on, sold to anyone with a model to
    // put in it: the owner's "any company with a harness".
    { nodeId: 'svc_agent_harness', revenueShare: 0.15, segment: 'enterprise', targetIndustry: 'ai', published: true, fills: [] },
  ],
  [W2_COMPANIES.sable]: [
    {
      nodeId: 'sys_efficient_small_model',
      revenueShare: 0.25,
      segment: 'enterprise',
      targetIndustry: 'ai',
      published: true,
      fills: [{ slotId: 'corpus', nodeId: 'dat_web_corpus', source: 'kestrel' }],
    },
    {
      nodeId: 'svc_inference_api',
      revenueShare: 0.6,
      segment: 'developer_api',
      targetIndustry: 'ai',
      published: true,
      fills: [{ slotId: 'model', nodeId: 'sys_efficient_small_model', source: 'self' }],
    },
    // The second harness node, from a second company, so the harness slot of
    // every app is a choice of whose harness and not only of which.
    { nodeId: 'svc_copilot_framework', revenueShare: 0.15, segment: 'enterprise', targetIndustry: 'ai', published: true, fills: [] },
  ],
  [W2_COMPANIES.basalt]: [
    {
      nodeId: 'svc_datacentre_capacity',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'ai',
      published: true,
      fills: [
        { slotId: 'interconnect', nodeId: 'svc_grid_interconnect', source: 'grimsby' },
        { slotId: 'storage', nodeId: 'sys_grid_storage_system', source: 'grimsby' },
      ],
    },
    {
      nodeId: 'svc_inference_api',
      revenueShare: 0.5,
      segment: 'developer_api',
      targetIndustry: 'ai',
      published: true,
      fills: [{ slotId: 'model', nodeId: 'sys_frontier_model', source: 'aletheia' }],
    },
  ],
  [W2_COMPANIES.kestrel]: [
    { nodeId: 'dat_web_corpus', revenueShare: 0.6, segment: 'enterprise', targetIndustry: 'ai', published: true, fills: [] },
    { nodeId: 'dat_preference_data', revenueShare: 0.4, segment: 'enterprise', targetIndustry: 'ai', published: true, fills: [] },
  ],

  /* --- Robotics ---------------------------------------------------------- */
  [W2_COMPANIES.ironvale]: [
    {
      nodeId: 'cmp_precision_actuator',
      revenueShare: 0.3,
      segment: 'enterprise',
      targetIndustry: 'robotics',
      published: true,
      fills: [
        { slotId: 'structure', nodeId: 'mat_machined_structure', source: 'rasan' },
        { slotId: 'wafer', nodeId: 'mat_wafer_300mm', source: 'tessellate' },
      ],
    },
    {
      nodeId: 'sys_warehouse_amr',
      revenueShare: 0.7,
      segment: 'enterprise',
      targetIndustry: 'logistics',
      published: true,
      fills: [
        { slotId: 'actuators', nodeId: 'cmp_precision_actuator', source: 'self' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
        { slotId: 'battery', nodeId: 'sys_battery_pack_lfp', source: 'cinder' },
        { slotId: 'model', nodeId: 'sys_robot_policy_model', source: 'wrenford' },
        { slotId: 'harness', nodeId: 'svc_robot_control_stack', source: 'palma' },
      ],
    },
  ],
  [W2_COMPANIES.wrenford]: [
    { nodeId: 'sys_robot_policy_model', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'robotics', published: true, fills: [] },
    {
      nodeId: 'sys_humanoid_robot',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: true,
      fills: [
        { slotId: 'model', nodeId: 'sys_robot_policy_model', source: 'self' },
        { slotId: 'actuators', nodeId: 'cmp_precision_actuator', source: 'ironvale' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
        { slotId: 'harness', nodeId: 'svc_robot_control_stack', source: 'palma' },
      ],
    },
  ],
  [W2_COMPANIES.sentinel]: [
    { nodeId: 'svc_autonomy_stack', revenueShare: 0.3, segment: 'enterprise', targetIndustry: 'logistics', published: true, fills: [] },
    {
      nodeId: 'sys_autonomous_drone',
      revenueShare: 0.7,
      segment: 'government',
      targetIndustry: 'logistics',
      published: true,
      fills: [
        { slotId: 'harness', nodeId: 'svc_autonomy_stack', source: 'self' },
        { slotId: 'battery', nodeId: 'sys_battery_pack_lfp', source: 'cinder' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
      ],
    },
  ],
  [W2_COMPANIES.palma]: [
    {
      nodeId: 'sys_industrial_arm',
      revenueShare: 0.85,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: true,
      fills: [
        { slotId: 'actuators', nodeId: 'cmp_precision_actuator', source: 'ironvale' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
        { slotId: 'harness', nodeId: 'svc_robot_control_stack', source: 'self' },
      ],
    },
    // The robot harness: the control stack Palma's own arm, Ironvale's
    // warehouse robot and Wrenford's humanoid all run on, beside Sentinel's
    // autonomy stack as the other node of the role.
    { nodeId: 'svc_robot_control_stack', revenueShare: 0.15, segment: 'enterprise', targetIndustry: 'robotics', published: true, fills: [] },
  ],

  /* --- Manufacturing ----------------------------------------------------- */
  [W2_COMPANIES.tessellate]: [
    { nodeId: 'mat_wafer_300mm', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'manufacturing', published: true, fills: [] },
    { nodeId: 'sys_advanced_package', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'manufacturing', published: true, fills: [] },
  ],
  [W2_COMPANIES.halcyon]: [
    {
      nodeId: 'cmp_sensor_suite',
      revenueShare: 0.6,
      segment: 'enterprise',
      targetIndustry: 'robotics',
      published: true,
      fills: [
        { slotId: 'wafer', nodeId: 'mat_wafer_300mm', source: 'tessellate' },
        { slotId: 'structure', nodeId: 'mat_machined_structure', source: 'rasan' },
      ],
    },
    {
      nodeId: 'cmp_power_electronics',
      revenueShare: 0.4,
      segment: 'enterprise',
      targetIndustry: 'energy',
      published: true,
      fills: [{ slotId: 'wafer', nodeId: 'mat_wafer_300mm', source: 'tessellate' }],
    },
  ],
  [W2_COMPANIES.cinder]: [
    { nodeId: 'cmp_battery_cell_lfp', revenueShare: 0.4, segment: 'enterprise', targetIndustry: 'energy', published: true, fills: [] },
    {
      nodeId: 'sys_battery_pack_lfp',
      revenueShare: 0.6,
      segment: 'enterprise',
      targetIndustry: 'robotics',
      published: true,
      fills: [
        { slotId: 'cell', nodeId: 'cmp_battery_cell_lfp', source: 'self' },
        { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
        { slotId: 'structure', nodeId: 'mat_machined_structure', source: 'rasan' },
      ],
    },
  ],
  [W2_COMPANIES.rasan]: [
    { nodeId: 'mat_machined_structure', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'robotics', published: true, fills: [] },
    { nodeId: 'cmp_transformer', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'energy', published: true, fills: [] },
  ],

  /* --- Energy ------------------------------------------------------------ */
  [W2_COMPANIES.qanat]: [
    {
      nodeId: 'sys_smr_module',
      revenueShare: 0.3,
      segment: 'government',
      targetIndustry: 'energy',
      published: true,
      fills: [
        { slotId: 'transformer', nodeId: 'cmp_transformer', source: 'rasan' },
        { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
      ],
    },
    {
      nodeId: 'svc_power_purchase_agreement',
      revenueShare: 0.7,
      segment: 'enterprise',
      targetIndustry: 'ai',
      published: true,
      fills: [
        { slotId: 'generation', nodeId: 'sys_smr_module', source: 'self' },
        { slotId: 'interconnect', nodeId: 'svc_grid_interconnect', source: 'grimsby' },
      ],
    },
  ],
  [W2_COMPANIES.volta]: [
    {
      nodeId: 'sys_wind_turbine',
      revenueShare: 0.25,
      segment: 'enterprise',
      targetIndustry: 'energy',
      published: true,
      fills: [
        { slotId: 'structure', nodeId: 'mat_carbon_composite', source: 'self' },
        { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
      ],
    },
    {
      nodeId: 'svc_power_purchase_agreement',
      revenueShare: 0.65,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: true,
      fills: [
        { slotId: 'generation', nodeId: 'sys_wind_turbine', source: 'self' },
        { slotId: 'interconnect', nodeId: 'svc_grid_interconnect', source: 'grimsby' },
      ],
    },
    // A turbine maker lays up its own blades. Published, so every structure
    // slot in the world has a second producer to choose against Rasan's
    // machined structure — the one node choice manufacturing otherwise lacked.
    { nodeId: 'mat_carbon_composite', revenueShare: 0.1, segment: 'enterprise', targetIndustry: 'energy', published: true, fills: [] },
  ],
  [W2_COMPANIES.grimsby]: [
    { nodeId: 'svc_grid_interconnect', revenueShare: 0.5, segment: 'enterprise', targetIndustry: 'energy', published: true, fills: [] },
    {
      nodeId: 'sys_grid_storage_system',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'energy',
      published: true,
      fills: [
        { slotId: 'cell', nodeId: 'cmp_battery_cell_lfp', source: 'cinder' },
        { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
      ],
    },
  ],
  [W2_COMPANIES.suryan]: [
    { nodeId: 'mat_solar_module', revenueShare: 0.3, segment: 'consumer', targetIndustry: 'consumer', published: true, fills: [] },
    {
      nodeId: 'sys_solar_array',
      revenueShare: 0.7,
      segment: 'enterprise',
      targetIndustry: 'energy',
      published: true,
      fills: [
        { slotId: 'modules', nodeId: 'mat_solar_module', source: 'self' },
        { slotId: 'power', nodeId: 'cmp_power_electronics', source: 'halcyon' },
        { slotId: 'transformer', nodeId: 'cmp_transformer', source: 'rasan' },
      ],
    },
  ],

  /* --- Logistics --------------------------------------------------------- */
  [W2_COMPANIES.harbourline]: [
    {
      nodeId: 'sys_electric_truck',
      revenueShare: 0.2,
      segment: 'enterprise',
      targetIndustry: 'logistics',
      published: true,
      fills: [
        { slotId: 'battery', nodeId: 'sys_battery_pack_lfp', source: 'cinder' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
      ],
    },
    {
      nodeId: 'svc_line_haul',
      revenueShare: 0.8,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: true,
      fills: [
        { slotId: 'vehicle', nodeId: 'sys_electric_truck', source: 'self' },
        { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
      ],
    },
  ],
  [W2_COMPANIES.overland]: [
    {
      nodeId: 'svc_routing_platform',
      revenueShare: 0.3,
      segment: 'enterprise',
      targetIndustry: 'logistics',
      published: true,
      fills: [{ slotId: 'model', nodeId: 'svc_inference_api', source: 'sable' }],
    },
    {
      nodeId: 'svc_line_haul',
      revenueShare: 0.7,
      segment: 'enterprise',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'vehicle', nodeId: 'sys_electric_truck', source: 'harbourline' },
        { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'self' },
      ],
    },
  ],
  [W2_COMPANIES.ganga]: [
    {
      nodeId: 'svc_port_terminal',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'manufacturing',
      published: true,
      fills: [
        { slotId: 'robots', nodeId: 'sys_warehouse_amr', source: 'ironvale' },
        { slotId: 'arms', nodeId: 'sys_industrial_arm', source: 'palma' },
        { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
      ],
    },
    {
      nodeId: 'svc_freight_brokerage',
      revenueShare: 0.5,
      segment: 'enterprise',
      targetIndustry: 'logistics',
      published: true,
      fills: [
        { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
        { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
      ],
    },
  ],
  [W2_COMPANIES.dune]: [
    {
      nodeId: 'sys_delivery_van',
      revenueShare: 0.25,
      segment: 'enterprise',
      targetIndustry: 'logistics',
      published: true,
      fills: [
        { slotId: 'battery', nodeId: 'sys_battery_pack_lfp', source: 'cinder' },
        { slotId: 'sensors', nodeId: 'cmp_sensor_suite', source: 'halcyon' },
      ],
    },
    {
      nodeId: 'svc_last_mile',
      revenueShare: 0.75,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'vehicle', nodeId: 'sys_delivery_van', source: 'self' },
        { slotId: 'drones', nodeId: 'sys_autonomous_drone', source: 'sentinel' },
        { slotId: 'routing', nodeId: 'svc_routing_platform', source: 'overland' },
      ],
    },
  ],

  /* --- Consumer ---------------------------------------------------------- */
  [W2_COMPANIES.lumen]: [
    { nodeId: 'dat_consumer_behaviour', revenueShare: 0.1, segment: 'enterprise', targetIndustry: 'consumer', published: true, fills: [] },
    {
      nodeId: 'app_consumer_subscription',
      revenueShare: 0.9,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
        { slotId: 'harness', nodeId: 'svc_agent_harness', source: 'market' },
        { slotId: 'data', nodeId: 'dat_consumer_behaviour', source: 'self' },
      ],
    },
  ],
  [W2_COMPANIES.tanto]: [
    {
      nodeId: 'sys_consumer_device',
      revenueShare: 0.4,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'soc', nodeId: 'cmp_consumer_soc', source: 'vasant' },
        { slotId: 'cell', nodeId: 'cmp_battery_cell_lfp', source: 'cinder' },
      ],
    },
    {
      nodeId: 'app_marketplace',
      revenueShare: 0.6,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'model', nodeId: 'svc_inference_api', source: 'sable' },
        { slotId: 'harness', nodeId: 'svc_agent_harness', source: 'market' },
        { slotId: 'data', nodeId: 'dat_consumer_behaviour', source: 'lumen' },
      ],
    },
  ],
  [W2_COMPANIES.copa]: [
    {
      nodeId: 'app_marketplace',
      revenueShare: 0.6,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' },
        { slotId: 'data', nodeId: 'dat_consumer_behaviour', source: 'lumen' },
      ],
    },
    {
      nodeId: 'svc_brand_retail',
      revenueShare: 0.4,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'goods', nodeId: 'sys_consumer_device', source: 'tanto' },
        { slotId: 'storefront', nodeId: 'app_marketplace', source: 'self' },
      ],
    },
  ],
  [W2_COMPANIES.vasant]: [
    {
      nodeId: 'cmp_consumer_soc',
      revenueShare: 0.3,
      segment: 'enterprise',
      targetIndustry: 'consumer',
      published: true,
      fills: [{ slotId: 'wafer', nodeId: 'mat_wafer_300mm', source: 'tessellate' }],
    },
    {
      nodeId: 'svc_brand_retail',
      revenueShare: 0.7,
      segment: 'consumer',
      targetIndustry: 'consumer',
      published: true,
      fills: [
        { slotId: 'goods', nodeId: 'sys_consumer_device', source: 'tanto' },
        { slotId: 'storefront', nodeId: 'app_marketplace', source: 'copa' },
      ],
    },
  ],
};

/** The lines a seeded rival opens with, or none for an id the table does not know. */
export function w3RivalLinesFor(companyId: string): readonly W3SeedLine[] {
  return W3_RIVAL_LINES[companyId] ?? [];
}

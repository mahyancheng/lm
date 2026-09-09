/**
 * @frontier/contracts — nodeRoles.ts
 *
 * A **role** is the substitution class of a node: the set of things a buyer
 * could put in the same slot. A slot on a node names a role, not a node, and
 * every node of that role — or the narrower list the slot `accepts` — can fill
 * it. That is the whole mechanism behind the owner's ask: "if any company
 * publishes a public API for its LLM, any other company with a harness can
 * decide if they want to put a product on the other company's LLM". The
 * inference API's one slot is of role `model`; three nodes carry that role;
 * the buyer chooses.
 *
 * ## Rules the role table lives under
 *
 * - Every node carries exactly one role (`EconomicNode.role`).
 * - A slot's role must sit strictly below the slot owner's tier for **every**
 *   node of that role, so a fill can never point upward and the cost roll-up
 *   stays provably terminating however a player composes a line.
 * - The roles in `ROLE_CHOICE_REQUIRED` must carry at least two nodes each:
 *   they are the places the owner asked for a real choice, and a role of one
 *   is a fixed recipe wearing a new name.
 * - The enum grows only at the end. Roles are written into slot rows and
 *   product fills; reordering would re-key nothing but would break the habit
 *   every other enum in this package keeps.
 *
 * Roles a slot never names — the finished services at the top of each chain —
 * are grouped by what they are rather than one role per node: a role nothing
 * admits says only what the node is, and eleven singleton roles would say it
 * eleven times.
 */

import { z } from 'zod';

/**
 * Every role in the economy, ordered by the tier its members sit at and then
 * by the node table's own order. Append only.
 */
export const NODE_ROLES = [
  // tiers 0 and 1: what comes out of the ground, and power
  'silicon',
  'lithium',
  'nickel',
  'graphite',
  'copper',
  'steel',
  'aluminium',
  'rare_earth',
  'chemicals',
  'polymer',
  'fuel',
  'grid_power',
  // tier 2: materials and data
  'wafer',
  'cathode',
  'anode',
  'electrolyte',
  'magnet',
  'structure',
  'solar_module',
  'display',
  'packaging',
  'dataset',
  // tier 3: components
  'chip_component',
  'memory',
  'substrate',
  'battery_cell',
  'power_electronics',
  'drivetrain',
  'transformer',
  'actuator',
  'sensor',
  'soc',
  'training_compute',
  'evaluation',
  // tier 4: subsystems
  'package',
  'battery_pack',
  'electrolyser',
  'generation_asset',
  'storage',
  'substation',
  'model',
  'edge_compute',
  'control_stack',
  // tier 5: systems and finished products
  'accelerator',
  'inference_api',
  'harness',
  'robot',
  'vehicle',
  'device',
  'interconnect',
  // tier 6: platforms
  'rack',
  'app',
  'logistics_software',
  'automation_cell',
  'energy_service',
  'fleet_service',
  // tier 7: operations
  'logistics_service',
  'retail',
] as const;

export const NodeRoleSchema = z
  .enum(NODE_ROLES)
  .describe('The substitution class a node belongs to. A slot names a role; every node of that role, or the narrower list the slot accepts, can fill it.');
export type NodeRole = z.infer<typeof NodeRoleSchema>;

/** What a slot of each role is called on the canvas. Whole words a founder would say. */
export const NODE_ROLE_LABELS: Readonly<Record<NodeRole, string>> = {
  silicon: 'Silicon',
  lithium: 'Lithium',
  nickel: 'Nickel',
  graphite: 'Graphite',
  copper: 'Copper',
  steel: 'Steel',
  aluminium: 'Aluminium',
  rare_earth: 'Rare earths',
  chemicals: 'Chemicals',
  polymer: 'Polymer',
  fuel: 'Fuel',
  grid_power: 'Power',
  wafer: 'Wafer',
  cathode: 'Cathode',
  anode: 'Anode',
  electrolyte: 'Electrolyte',
  magnet: 'Magnet',
  structure: 'Structure',
  solar_module: 'Panel',
  display: 'Display',
  packaging: 'Packaging',
  dataset: 'Data',
  chip_component: 'Die',
  memory: 'Memory',
  substrate: 'Substrate',
  battery_cell: 'Cell',
  power_electronics: 'Power electronics',
  drivetrain: 'Drivetrain',
  transformer: 'Transformer',
  actuator: 'Actuator',
  sensor: 'Sensor',
  soc: 'SoC',
  training_compute: 'Training compute',
  evaluation: 'Evaluation',
  package: 'Package',
  battery_pack: 'Pack',
  electrolyser: 'Electrolyser',
  generation_asset: 'Generation',
  storage: 'Storage',
  substation: 'Substation',
  model: 'Model',
  edge_compute: 'Edge compute',
  control_stack: 'Control stack',
  accelerator: 'Accelerator',
  inference_api: 'API',
  harness: 'Harness',
  robot: 'Robot',
  vehicle: 'Vehicle',
  device: 'Device',
  interconnect: 'Interconnect',
  rack: 'Rack',
  app: 'Software',
  logistics_software: 'Routing',
  automation_cell: 'Automation',
  energy_service: 'Energy service',
  fleet_service: 'Fleet service',
  logistics_service: 'Logistics',
  retail: 'Retail',
};

/**
 * The roles that must carry at least two nodes: where the owner asked for a
 * real choice — which model, which harness, which chemistry, which robot. The
 * contract tests pin the count on the real table.
 */
export const ROLE_CHOICE_REQUIRED: readonly NodeRole[] = [
  'model',
  'harness',
  'control_stack',
  'edge_compute',
  'actuator',
  'battery_cell',
  'battery_pack',
  'generation_asset',
  'device',
  'vehicle',
  'structure',
  'robot',
  'chip_component',
];

/**
 * The world-3 node table, proved rather than trusted.
 *
 * Five kinds of assertion run here:
 *
 * - **The schema holds.** Every row parses, and the schema refuses the shapes
 *   that would make the roll-up ill-defined.
 * - **The slots are sound.** Every slot names a role every node of which sits
 *   strictly below the owner, admits only nodes that agree on a unit, and
 *   defaults to something admissible; the thirteen roles the owner asked for a
 *   real choice on carry more than one node; three of the old fixed edges are
 *   pinned to the slots that replaced them.
 * - **The graph is sound.** Each integrity rule is shown to catch the defect it
 *   exists to catch — a cycle, a dangling id, a tier violation, an orphan
 *   sector, a rigged slot — by rigging one and watching it fail.
 * - **The economics are believable.** Every manufactured end product's default
 *   bill of materials lands inside a stated band, no line spends more on inputs
 *   than it charges, and no service spends like hardware.
 * - **A founder can make what they sell.** For every one of the fifteen
 *   backgrounds, `canProduce` is true for that background's own opening line at
 *   quarter zero. This is the test that would have caught world 2's bug, where
 *   `dependencySatisfied` asked whether a node was achieved by *anybody* and
 *   exactly one of forty-two seeded nodes was.
 */

import { describe, expect, it } from 'vitest';

/** Vite supplies this at transform time; the package carries no Vite types. */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}
import {
  BACKGROUND_SIGNATURE_NODES,
  BACKGROUND_TIER_REACH,
  BOM_BAND_HARDWARE,
  BOM_CAP_SERVICE,
  COMPUTE_CAPACITY_NODE_ID,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  ECONOMIC_NODE_SECTORS,
  EconomicNodeSchema,
  GRID_POWER_NODE_ID,
  GRID_POWER_TIER,
  MAX_NODE_SLOTS,
  NODE_ID_PREFIXES,
  NODE_ROLES,
  NODE_ROLE_LABELS,
  NODE_TIERS,
  NODE_TIER_LABELS,
  NodeSlotSchema,
  PRODUCT_SEGMENTS,
  ROLE_CHOICE_REQUIRED,
  SECTORS,
  ALL_BACKGROUND_IDS,
  admissibleNodeIds,
  admissibleNodesFor,
  billOfMaterialsShare,
  bomBandApplies,
  bomCapApplies,
  canProduce,
  defaultInputsOf,
  economicGraphDefects,
  economicNodeById,
  economicNodesInSector,
  economicNodesOfRole,
  indexNodes,
  nodeIdPrefixSuitsTier,
  nodeReferencesResolve,
  primaryCustomerOf,
  producibleNodes,
  requiresIsAcyclicAndNonIncreasing,
  rivalTierReach,
  sectorForBackground,
  sectorsAreConnected,
  slotById,
  slotRolesStrictlyDecreaseTier,
  slotsAccepting,
  startingLineNodeFor,
  startingNodesFor,
  startingNodesForRival,
  type Company,
  type EconomicNode,
  type NodeSlot,
} from '../src/index';

const BY_ID = indexNodes(ECONOMIC_NODES);

/** A company that owns exactly these nodes. Only the fields the rules read. */
function companyOwning(ownedNodes: readonly string[]): Company {
  return { id: 'cmp_probe', ownedNodes: [...ownedNodes] } as unknown as Company;
}

/** The table with one node's slots replaced. */
function withSlots(nodeId: string, slots: readonly NodeSlot[]): readonly EconomicNode[] {
  return ECONOMIC_NODES.map((entry) => (entry.id === nodeId ? { ...entry, slots: [...slots] } : entry));
}

/** One node's slot, or a thrown error naming what is missing, so a failure reads as words. */
function slotOf(nodeId: string, slotId: string): NodeSlot {
  const node = economicNodeById(nodeId);
  if (node === undefined) throw new Error(`${nodeId} is not in the table`);
  const found = slotById(node, slotId);
  if (found === undefined) throw new Error(`${nodeId} has no slot ${slotId}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

describe('the node table', () => {
  it('carries the whole economy: ninety-seven rows, every one a valid node', () => {
    expect(ECONOMIC_NODES.length).toBe(97);
    for (const entry of ECONOMIC_NODES) expect(() => EconomicNodeSchema.parse(entry)).not.toThrow();
  });

  it('has unique ids, every one carrying one of the seven prefixes', () => {
    const ids = ECONOMIC_NODES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ECONOMIC_NODES) {
      expect(NODE_ID_PREFIXES.some((prefix) => entry.id.startsWith(prefix)), `${entry.id} has no tier prefix`).toBe(true);
      expect(nodeIdPrefixSuitsTier(entry.id, entry.tier), `${entry.id} prefix disagrees with tier ${entry.tier}`).toBe(true);
    }
  });

  it('spans eight tiers, each with a lane title and at least one node', () => {
    expect(NODE_TIERS).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const tier of NODE_TIERS) {
      expect(NODE_TIER_LABELS[tier].length).toBeGreaterThan(0);
      expect(ECONOMIC_NODES.some((entry) => entry.tier === tier), `tier ${tier} is empty`).toBe(true);
    }
    // Tier 7 is the operation run on a platform: the five the chains end in.
    expect(
      ECONOMIC_NODES.filter((entry) => entry.tier === 7)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['svc_brand_retail', 'svc_freight_brokerage', 'svc_last_mile', 'svc_line_haul', 'svc_port_terminal']);
  });

  it('covers every sector, at more than one tier each', () => {
    for (const sector of SECTORS) {
      const inSector = economicNodesInSector(sector);
      expect(inSector.length, `${sector} is empty`).toBeGreaterThanOrEqual(8);
      expect(new Set(inSector.map((entry) => entry.tier)).size, `${sector} sits on one tier`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no defects at all', () => {
    expect(economicGraphDefects(ECONOMIC_NODES, ECONOMIC_NODE_SECTORS)).toEqual([]);
  });

  it('puts grid power at tier 1 and lets it consume no power of its own', () => {
    const power = economicNodeById(GRID_POWER_NODE_ID);
    expect(power?.tier).toBe(GRID_POWER_TIER);
    expect(power?.energyMwhPerUnit).toBe(0);
    // The compute bucket is a real node too, or the capacity draw means nothing.
    expect(economicNodeById(COMPUTE_CAPACITY_NODE_ID)).toBeDefined();
  });

  it('makes every company in the world an energy customer', () => {
    const drawing = ECONOMIC_NODES.filter((entry) => entry.energyMwhPerUnit > 0);
    expect(drawing.length).toBeGreaterThanOrEqual(30);
    for (const entry of drawing) expect(entry.tier, `${entry.id} draws power below tier 2`).toBeGreaterThan(GRID_POWER_TIER);
  });

  it('bills a chip once and a seat every quarter', () => {
    for (const entry of ECONOMIC_NODES) {
      if (entry.saleKind === 'unit') expect(entry.lifetimeQuarters, `${entry.id}`).not.toBeNull();
      else expect(entry.lifetimeQuarters, `${entry.id}`).toBeNull();
      if (entry.saleKind === 'contract') expect(entry.contractQuarters, `${entry.id}`).not.toBeNull();
      else expect(entry.contractQuarters, `${entry.id}`).toBeNull();
    }
    // The power purchase agreement is the row that makes "$26,000 per MWh every
    // quarter" honest: a twenty-quarter commitment, priced per MW-quarter.
    const ppa = economicNodeById('svc_power_purchase_agreement');
    expect(ppa?.saleKind).toBe('contract');
    expect(ppa?.contractQuarters).toBe(20);
  });

  it('gives every node a market with weights that sum to one, and some end demand', () => {
    for (const entry of ECONOMIC_NODES) {
      expect(entry.endDemandBaseUnits, `${entry.id} has no end demand`).toBeGreaterThan(0);
      const customers = Object.values(entry.market.customers).reduce((total, weight) => total + (weight ?? 0), 0);
      const industries = Object.values(entry.market.industries).reduce((total, weight) => total + (weight ?? 0), 0);
      expect(customers, `${entry.id} customers do not sum to one`).toBeCloseTo(1, 9);
      expect(industries, `${entry.id} industries do not sum to one`).toBeCloseTo(1, 9);
      expect(PRODUCT_SEGMENTS).toContain(primaryCustomerOf(entry));
    }
    // The public has no industry: a consumer line sells into the consumer sector alone.
    for (const entry of ECONOMIC_NODES) {
      if (Object.keys(entry.market.customers).every((key) => key === 'consumer')) {
        expect(entry.market.industries, `${entry.id}`).toEqual({ consumer: 1 });
      }
    }
    // The derivation, on three rows the plan states: an intermediate sells to the
    // sectors whose slots admit it, an enterprise application to every industry,
    // and the inference API to the weights it was authored with.
    expect(Object.keys(economicNodeById('mat_wafer_300mm')?.market.industries ?? {}).sort()).toEqual(['consumer', 'manufacturing', 'robotics']);
    expect(Object.keys(economicNodeById('app_ai_software_suite')?.market.industries ?? {}).sort()).toEqual([...SECTORS].sort());
    expect(economicNodeById('svc_inference_api')?.market.customers).toEqual({ developer_api: 0.7, enterprise: 0.3 });
    expect(primaryCustomerOf(economicNodeById('svc_inference_api') as EconomicNode)).toBe('developer_api');
    expect(primaryCustomerOf(economicNodeById('svc_last_mile') as EconomicNode)).toBe('consumer');
    expect(primaryCustomerOf(economicNodeById('sys_smr_module') as EconomicNode)).toBe('government');
  });

  it('types every talent area, rather than carrying strings nothing reads', () => {
    for (const entry of ECONOMIC_NODES) {
      expect(entry.talentAreas.length, `${entry.id} names no capability area`).toBeGreaterThan(0);
      expect(new Set(entry.talentAreas).size).toBe(entry.talentAreas.length);
    }
  });

  it('leaves raw resources and power unresearchable, and everything else reachable', () => {
    for (const entry of ECONOMIC_NODES) {
      expect(entry.researchable, `${entry.id}`).toBe(entry.tier >= 2);
      if (!entry.researchable) expect(entry.requires, `${entry.id}`).toEqual([]);
    }
    expect(ECONOMIC_NODES.filter((entry) => entry.researchable).length).toBeGreaterThanOrEqual(60);
  });

  it('collects data where a product actually observes a customer', () => {
    const observing = ECONOMIC_NODES.filter((entry) => entry.dataYieldPerUnitQuarter > 0);
    expect(observing.length).toBeGreaterThanOrEqual(15);
    for (const entry of ECONOMIC_NODES) {
      // Nothing may be sensitive without observing anything.
      if (entry.dataSensitivity > 0 && entry.dataYieldPerUnitQuarter === 0) {
        expect(entry.id.startsWith('dat_') || entry.slots.length > 0, `${entry.id} is sensitive but sees nothing`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Roles and slots                                                            */
/* -------------------------------------------------------------------------- */

describe('roles', () => {
  it('partition the table: every node has a role, every role has a node, every role a canvas word', () => {
    const members = new Map<string, number>();
    for (const entry of ECONOMIC_NODES) members.set(entry.role, (members.get(entry.role) ?? 0) + 1);
    let total = 0;
    for (const role of NODE_ROLES) {
      expect(members.get(role) ?? 0, `role ${role} has no node`).toBeGreaterThan(0);
      expect(NODE_ROLE_LABELS[role].length, `role ${role} has no label`).toBeGreaterThan(0);
      expect(economicNodesOfRole(role).length).toBe(members.get(role));
      total += members.get(role) ?? 0;
    }
    expect(total).toBe(ECONOMIC_NODES.length);
    expect(new Set(NODE_ROLES).size).toBe(NODE_ROLES.length);
  });

  it('give the owner a real choice everywhere one was asked for', () => {
    expect(ROLE_CHOICE_REQUIRED.length).toBe(13);
    for (const role of ROLE_CHOICE_REQUIRED) {
      expect(economicNodesOfRole(role).length, `role ${role} offers no choice`).toBeGreaterThanOrEqual(2);
    }
    expect(economicNodesOfRole('model').map((entry) => entry.id)).toEqual(['sys_frontier_model', 'sys_efficient_small_model', 'sys_robot_policy_model']);
    expect(economicNodesOfRole('harness').map((entry) => entry.id)).toEqual(['svc_agent_harness', 'svc_copilot_framework']);
    expect(economicNodesOfRole('robot').length).toBe(4);
  });
});

describe('slots', () => {
  it('sit strictly below their owner for EVERY node of the role, not only the default', () => {
    expect(slotRolesStrictlyDecreaseTier(ECONOMIC_NODES)).toBe(true);
    for (const entry of ECONOMIC_NODES) {
      expect(entry.slots.length).toBeLessThanOrEqual(MAX_NODE_SLOTS);
      for (const slot of entry.slots) {
        for (const candidate of economicNodesOfRole(slot.role)) {
          expect(candidate.tier, `${entry.id}.${slot.id} admits ${candidate.id} at tier ${candidate.tier}`).toBeLessThan(entry.tier);
        }
      }
    }
  });

  it('admit only nodes that agree on a unit, and default to one of them', () => {
    for (const entry of ECONOMIC_NODES) {
      for (const slot of entry.slots) {
        const admissible = admissibleNodeIds(entry, slot, BY_ID);
        expect(admissible.length, `${entry.id}.${slot.id} admits nothing`).toBeGreaterThan(0);
        for (const id of admissible) expect(BY_ID.get(id)?.role, `${entry.id}.${slot.id} admits ${id} of the wrong role`).toBe(slot.role);
        expect(new Set(admissible.map((id) => BY_ID.get(id)?.unitLabel)).size, `${entry.id}.${slot.id} mixes units`).toBe(1);
        for (const id of slot.accepts) expect(admissible, `${entry.id}.${slot.id} accepts ${id} but does not admit it`).toContain(id);
        if (slot.defaultNodeId === null) expect(slot.required, `${entry.id}.${slot.id} is required with no default`).toBe(false);
        else expect(admissible, `${entry.id}.${slot.id} defaults outside its own admissible set`).toContain(slot.defaultNodeId);
        if (slot.blocking) expect(slot.required, `${entry.id}.${slot.id} blocks without being required`).toBe(true);
        expect(admissibleNodesFor(entry.id, slot.id).map((node) => node.id)).toEqual(admissible);
      }
      expect(new Set(entry.slots.map((slot) => slot.id)).size, `${entry.id} repeats a slot id`).toBe(entry.slots.length);
    }
  });

  it('pin the three old fixed edges to the slots that replaced them', () => {
    // wafer → die: a blocking slot narrowed to the logic wafer, at the same quantity.
    expect(slotOf('cmp_logic_die', 'wafer')).toMatchObject({ role: 'wafer', qtyPerUnit: 0.022, required: true, blocking: true, accepts: ['mat_wafer_300mm'], defaultNodeId: 'mat_wafer_300mm', kind: 'input' });
    // model → API: ONE slot of role model, open to every model, defaulting to the frontier.
    expect(slotOf('svc_inference_api', 'model')).toMatchObject({ role: 'model', required: true, blocking: false, accepts: [], defaultNodeId: 'sys_frontier_model', kind: 'input' });
    expect(admissibleNodesFor('svc_inference_api', 'model').map((entry) => entry.id)).toEqual(['sys_frontier_model', 'sys_efficient_small_model', 'sys_robot_policy_model']);
    // API → app: required, never blocking, at today's ninety million tokens a seat; beside it a harness and an empty delivery slot.
    expect(slotOf('app_agent_platform', 'model')).toMatchObject({ role: 'inference_api', qtyPerUnit: 90, required: true, blocking: false, defaultNodeId: 'svc_inference_api' });
    expect(slotOf('app_agent_platform', 'harness')).toMatchObject({ role: 'harness', required: true, blocking: false, accepts: [] });
    expect(slotOf('app_agent_platform', 'delivery')).toMatchObject({ role: 'device', required: false, blocking: false, defaultNodeId: null, kind: 'delivery' });
  });

  it('read the default recipe as the old consumes list did: default node, quantity, blocking', () => {
    expect(defaultInputsOf(economicNodeById('mat_wafer_300mm') as EconomicNode)).toEqual([
      { slotId: 'silicon', nodeId: 'res_silicon_feedstock', qtyPerUnit: 1.4, blocking: false },
      { slotId: 'chemicals', nodeId: 'res_fab_chemicals', qtyPerUnit: 1, blocking: true },
    ]);
    // An empty default is not part of the recipe; a filled optional one is.
    const app = defaultInputsOf(economicNodeById('app_agent_platform') as EconomicNode);
    expect(app.map((input) => input.slotId)).toEqual(['model', 'harness']);
    const arm = defaultInputsOf(economicNodeById('sys_industrial_arm') as EconomicNode);
    expect(arm.map((input) => input.slotId)).toContain('model');
  });

  it('answer the reverse question: which slots could a node be sold into', () => {
    const api = slotsAccepting('svc_inference_api').map((entry) => `${entry.node.id}.${entry.slot.id}`);
    expect(api).toContain('app_agent_platform.model');
    expect(api).toContain('svc_routing_platform.model');
    expect(api).toContain('app_marketplace.model');
    // A harness nobody's default names is still admitted by every application.
    const copilot = slotsAccepting('svc_copilot_framework').map((entry) => entry.node.id);
    expect(copilot).toContain('app_agent_platform');
    expect(copilot).toContain('app_social_network');
    // A model is admitted by the API, the robots and the devices.
    const small = slotsAccepting('sys_efficient_small_model').map((entry) => entry.node.id);
    expect(small).toContain('svc_inference_api');
    expect(small).toContain('sys_humanoid_robot');
    expect(small).toContain('sys_consumer_device');
    expect(slotsAccepting('svc_line_haul')).toEqual([]);
  });

  it('parse as the schema says, and refuse what it forbids', () => {
    const good = slotOf('svc_inference_api', 'model');
    expect(NodeSlotSchema.safeParse(good).success).toBe(true);
    expect(NodeSlotSchema.safeParse({ ...good, role: 'not_a_role' }).success).toBe(false);
    expect(NodeSlotSchema.safeParse({ ...good, qtyPerUnit: -1 }).success).toBe(false);
    expect(NodeSlotSchema.safeParse({ ...good, accepts: new Array<string>(7).fill('x') }).success).toBe(false);
    expect(NodeSlotSchema.safeParse({ ...good, kind: 'output' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  The integrity rules, each shown to catch its own defect                    */
/* -------------------------------------------------------------------------- */

describe('graph integrity', () => {
  it('accepts the real table on all four predicates', () => {
    expect(nodeReferencesResolve(ECONOMIC_NODES)).toBe(true);
    expect(slotRolesStrictlyDecreaseTier(ECONOMIC_NODES)).toBe(true);
    expect(requiresIsAcyclicAndNonIncreasing(ECONOMIC_NODES)).toBe(true);
    expect(sectorsAreConnected(ECONOMIC_NODES, ECONOMIC_NODE_SECTORS)).toBe(true);
  });

  it('catches an accepts id that does not exist', () => {
    const cell = slotOf('sys_battery_pack', 'cell');
    const rigged = withSlots('sys_battery_pack', [{ ...cell, accepts: ['cmp_does_not_exist'] }]);
    expect(nodeReferencesResolve(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('accepts unknown node cmp_does_not_exist');
  });

  it('catches an accepts id of the wrong role', () => {
    const cell = slotOf('sys_battery_pack', 'cell');
    const rigged = withSlots('sys_battery_pack', [{ ...cell, accepts: ['cmp_power_electronics'] }]);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('whose role power_electronics is not battery_cell');
  });

  it('catches a default outside the admissible set', () => {
    const cell = slotOf('sys_battery_pack', 'cell');
    const rigged = withSlots('sys_battery_pack', [{ ...cell, defaultNodeId: 'cmp_battery_cell_lfp' }]);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('default cmp_battery_cell_lfp is not admissible');
  });

  it('catches a required slot with no default', () => {
    const model = slotOf('svc_inference_api', 'model');
    const rigged = withSlots('svc_inference_api', [{ ...model, defaultNodeId: null }]);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('required slot with no default');
  });

  it('catches a blocking slot that is not required', () => {
    const model = slotOf('svc_inference_api', 'model');
    const rigged = withSlots('svc_inference_api', [{ ...model, required: false, blocking: true }]);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('blocking slot that is not required');
  });

  it('catches a duplicate slot id', () => {
    const model = slotOf('svc_inference_api', 'model');
    const rigged = withSlots('svc_inference_api', [model, { ...model }]);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('duplicate slot id');
  });

  it('catches a tier violation at the role level, even when the default is fine', () => {
    // A component whose slot admits a finished product is exactly the shape that
    // made the world-2 catalogue's cost roll-up non-terminating in principle.
    // Here the DEFAULT is the die, which is below; the ROLE reaches tier 5.
    const die = slotOf('sys_advanced_package', 'die');
    const rigged = withSlots('cmp_battery_cell', [{ ...die, role: 'accelerator', accepts: [], defaultNodeId: 'sys_ai_accelerator' }]);
    expect(slotRolesStrictlyDecreaseTier(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('not below 3');

    // And the subtler case: the default sits below, another node of the role does not.
    const promoted = ECONOMIC_NODES.map((entry) => (entry.id === 'sys_efficient_small_model' ? { ...entry, tier: 5 as EconomicNode['tier'] } : entry));
    expect(slotRolesStrictlyDecreaseTier(promoted)).toBe(false);
    expect(economicGraphDefects(promoted, ECONOMIC_NODE_SECTORS).join(' ')).toContain('svc_inference_api.model: role model carries sys_efficient_small_model at tier 5');
  });

  it('catches admissible nodes that disagree on a unit', () => {
    const rigged = ECONOMIC_NODES.map((entry) => (entry.id === 'sys_efficient_small_model' ? { ...entry, unitLabel: 'model' } : entry));
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('svc_inference_api.model: admissible nodes disagree on unit');
  });

  it('catches a market with no weight, and a node with no demand', () => {
    const noCustomers = ECONOMIC_NODES.map((entry) => (entry.id === 'cmp_logic_die' ? { ...entry, market: { customers: {}, industries: entry.market.industries } } : entry));
    expect(economicGraphDefects(noCustomers, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cmp_logic_die: market names no customer type');
    const noIndustries = ECONOMIC_NODES.map((entry) => (entry.id === 'cmp_logic_die' ? { ...entry, market: { customers: entry.market.customers, industries: { ai: 0 } } } : entry));
    expect(economicGraphDefects(noIndustries, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cmp_logic_die: market names no industry');
    const noDemand = ECONOMIC_NODES.map((entry) => (entry.id === 'cmp_logic_die' ? { ...entry, endDemandBaseUnits: 0 } : entry));
    expect(economicGraphDefects(noDemand, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cmp_logic_die: no end demand');
  });

  it('catches power drawn below tier 2', () => {
    const rigged = ECONOMIC_NODES.map((entry) => (entry.id === 'res_natural_gas' ? { ...entry, energyMwhPerUnit: 1 } : entry));
    expect(slotRolesStrictlyDecreaseTier(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('tier 0 cannot consume grid power');
  });

  it('catches a requires cycle', () => {
    const rigged = ECONOMIC_NODES.map((entry) => {
      if (entry.id === 'svc_training_run') return { ...entry, requires: ['dat_web_corpus'] };
      if (entry.id === 'dat_web_corpus') return { ...entry, requires: ['svc_training_run'], tier: 3 as EconomicNode['tier'], id: 'dat_web_corpus' };
      return entry;
    });
    expect(requiresIsAcyclicAndNonIncreasing(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cycle');
  });

  it('refuses a node that requires something above it', () => {
    const rigged = ECONOMIC_NODES.map((entry) => (entry.id === 'cmp_logic_die' ? { ...entry, requires: ['sys_ai_accelerator'] } : entry));
    expect(requiresIsAcyclicAndNonIncreasing(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('requires sys_ai_accelerator at a higher tier');
  });

  it('catches an orphan sector', () => {
    // Cut every slot that leaves or enters consumer and the sector is stranded.
    const consumerIds = new Set(economicNodesInSector('consumer').map((entry) => entry.id));
    const rigged = ECONOMIC_NODES.map((entry) => {
      const inside = consumerIds.has(entry.id);
      const kept = entry.slots.filter((slot) => admissibleNodeIds(entry, slot, BY_ID).every((id) => consumerIds.has(id) === inside));
      return inside ? { ...entry, slots: kept, requires: [], energyMwhPerUnit: 0, capacityDrawPerUnit: 0 } : { ...entry, slots: kept };
    });
    expect(sectorsAreConnected(rigged, ECONOMIC_NODE_SECTORS)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('orphaned');
  });

  it('links a sector through every admissible node, not only the default', () => {
    // Three nodes: an AI harness, a consumer harness and a consumer app whose
    // harness slot DEFAULTS to the consumer one. The AI harness is admitted but
    // never named; it is still the only edge that crosses the sector line.
    const aiHarness = economicNodeById('svc_agent_harness') as EconomicNode;
    const consumerHarness = { ...(economicNodeById('svc_copilot_framework') as EconomicNode), sector: 'consumer' as const };
    const harnessSlot = { ...slotOf('app_marketplace', 'harness'), defaultNodeId: consumerHarness.id };
    const app = { ...(economicNodeById('app_marketplace') as EconomicNode), slots: [harnessSlot], requires: [], energyMwhPerUnit: 0, capacityDrawPerUnit: 0 };
    expect(sectorsAreConnected([aiHarness, consumerHarness, app], ['ai', 'consumer'])).toBe(true);
    // Narrow the slot to the consumer harness and the AI sector is stranded.
    const narrowed = { ...app, slots: [{ ...harnessSlot, accepts: [consumerHarness.id] }] };
    expect(sectorsAreConnected([aiHarness, consumerHarness, narrowed], ['ai', 'consumer'])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Believable economics                                                       */
/* -------------------------------------------------------------------------- */

describe('the economics of a line', () => {
  it('gives every manufactured end product a believable default bill of materials', () => {
    const judged = ECONOMIC_NODES.filter(bomBandApplies);
    expect(judged.length).toBeGreaterThanOrEqual(15);
    for (const entry of judged) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeGreaterThanOrEqual(BOM_BAND_HARDWARE[0]);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeLessThanOrEqual(BOM_BAND_HARDWARE[1]);
    }
  });

  it('keeps services and platforms below what hardware spends', () => {
    for (const entry of ECONOMIC_NODES.filter(bomCapApplies)) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeLessThanOrEqual(BOM_CAP_SERVICE);
    }
  });

  it('leaves every balance price a real margin over its own inputs', () => {
    // The guard against world 2's failure, where eight seeded prices
    // contradicted the catalogue they were drawn from. Every price here is
    // judged against its own node's default inputs and nothing else.
    for (const entry of ECONOMIC_NODES) {
      const bom = billOfMaterialsShare(entry, BY_ID);
      if (bom === 0) continue;
      const ratio = 1 / bom;
      expect(ratio, `${entry.id} prices at only ${ratio.toFixed(2)}x its own inputs`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('never lets a line spend more on inputs than it charges', () => {
    for (const entry of ECONOMIC_NODES) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} is underwater at its own base price`).toBeLessThan(1);
    }
  });

  it('prices the semiconductor chain so each step adds value over the last', () => {
    const chain = ['res_silicon_feedstock', 'mat_wafer_300mm', 'cmp_accelerator_die', 'sys_advanced_package', 'sys_ai_accelerator', 'sys_ai_server_rack'];
    for (const id of chain) expect(economicNodeById(id), `${id} is missing from the table`).toBeDefined();
    const tiers = chain.map((id) => ECONOMIC_NODES_BY_ID[id]?.tier ?? -1);
    for (let index = 1; index < tiers.length; index += 1) expect(tiers[index]).toBeGreaterThan(tiers[index - 1] ?? -1);
  });

  it('measures compute in accelerators and plant in millions of dollars', () => {
    for (const entry of ECONOMIC_NODES) {
      if (entry.capacityKind === 'none') expect(entry.capacityDrawPerUnit, `${entry.id}`).toBe(0);
      else if (entry.tier >= 2) expect(entry.capacityDrawPerUnit, `${entry.id} claims a bucket it never draws on`).toBeGreaterThan(0);
    }
    // A training run occupies accelerators; it does not eat them, so no slot
    // anywhere in the AI chain admits the accelerator node.
    const run = economicNodeById('svc_training_run');
    expect(run?.capacityKind).toBe('compute');
    expect(run?.capacityDrawPerUnit).toBeGreaterThan(1);
    expect(slotsAccepting(COMPUTE_CAPACITY_NODE_ID).every((entry) => entry.node.sector !== 'ai')).toBe(true);
  });

  it('carries the three price moves the bill of materials forced, and the wind turbine per megawatt', () => {
    expect(economicNodeById('sys_humanoid_robot')?.basePriceUsd).toBe(45_000);
    expect(economicNodeById('sys_autonomous_drone')?.basePriceUsd).toBe(10_500);
    expect(economicNodeById('svc_power_purchase_agreement')?.capacityDrawPerUnit).toBe(0.5);
    expect(economicNodeById('sys_wind_turbine')).toMatchObject({ unitLabel: 'MW', basePriceUsd: 1_000_000, energyMwhPerUnit: 150 });
    for (const id of ['sys_industrial_arm', 'sys_warehouse_amr', 'sys_humanoid_robot', 'sys_autonomous_drone']) expect(economicNodeById(id)?.unitLabel, id).toBe('robot');
    expect(economicNodeById('cmp_network_switch_asic')?.unitLabel).toBe('die');
  });
});

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('where a founder starts', () => {
  it('offers a reach and a signature for every background the contracts declare', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      expect(BACKGROUND_TIER_REACH[background], `${background} has no reach`).toBeGreaterThanOrEqual(0);
      const signature = BACKGROUND_SIGNATURE_NODES[background];
      expect(signature.length, `${background} has too few signature nodes`).toBeGreaterThanOrEqual(2);
      expect(signature.length, `${background} has too many signature nodes`).toBeLessThanOrEqual(4);
      for (const id of signature) expect(economicNodeById(id), `${background} names unknown node ${id}`).toBeDefined();
    }
    // The three backgrounds whose opening line is an operation reach tier 7.
    expect(BACKGROUND_TIER_REACH.freight_network).toBe(7);
    expect(BACKGROUND_TIER_REACH.last_mile).toBe(7);
    expect(BACKGROUND_TIER_REACH.retail_platform).toBe(7);
  });

  it('reaches tier 7 for the most capable rival and stays inside the tiers that exist', () => {
    expect(rivalTierReach(0)).toBe(1);
    expect(rivalTierReach(0.5)).toBe(4);
    expect(rivalTierReach(1)).toBe(7);
    expect(rivalTierReach(5)).toBe(7);
    expect(rivalTierReach(-5)).toBe(0);
  });

  it('starts an AI laboratory with no robotics, energy, manufacturing or logistics of its own', () => {
    const owned = startingNodesFor('frontier_lab');
    const foreign = owned
      .map((id) => ECONOMIC_NODES_BY_ID[id])
      .filter((entry): entry is EconomicNode => entry !== undefined)
      .filter((entry) => entry.sector !== 'ai' && entry.tier > 0);
    expect(foreign.map((entry) => entry.id)).toEqual([]);
    // It still owns the commodities nobody has an exclusive claim on.
    expect(owned).toContain('res_silicon_feedstock');
  });

  it('starts every other background inside its own industry and nowhere else above the ground', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const sector = sectorForBackground(background);
      const signature = new Set(BACKGROUND_SIGNATURE_NODES[background]);
      for (const id of startingNodesFor(background)) {
        const entry = ECONOMIC_NODES_BY_ID[id];
        expect(entry, `${background} owns unknown node ${id}`).toBeDefined();
        if (entry === undefined || entry.tier === 0) continue;
        if (signature.has(id)) continue;
        // The requires closure of the opening line may cross a sector — that is
        // the point of it — so anything left must be the founder's own industry.
        const closureCrossing = startingNodesFor(background).includes(id) && entry.sector !== sector;
        if (closureCrossing) {
          expect(ECONOMIC_NODES_BY_ID[startingLineNodeFor(background)]?.requires.length ?? 0, `${background} owns foreign ${id} for no reason`).toBeGreaterThan(0);
          continue;
        }
        expect(entry.sector, `${background} owns ${id} outside ${sector}`).toBe(sector);
      }
    }
  });

  it('never hands a founder more nodes than the schema allows', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      expect(startingNodesFor(background).length, `${background} owns too many nodes`).toBeLessThanOrEqual(48);
    }
  });

  it('is deterministic and in table order', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const first = startingNodesFor(background);
      expect(startingNodesFor(background)).toEqual(first);
      const positions = first.map((id) => ECONOMIC_NODES.findIndex((entry) => entry.id === id));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  /*
   * The test that would have caught world 2's bug. There, a launch gate asked
   * whether a node was globally achieved, so a company could be seeded selling
   * something it was not allowed to make.
   */
  it('lets every background make the thing it opens selling', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const line = startingLineNodeFor(background);
      const company = companyOwning(startingNodesFor(background));
      expect(canProduce(company, line, 0), `${background} cannot produce its own opening line ${line}`).toBe(true);
    }
  });

  it('lets a rival at any capability make something, and more of it when it is better', () => {
    for (const sector of SECTORS) {
      const weak = companyOwning(startingNodesForRival(sector, 0.1));
      const strong = companyOwning(startingNodesForRival(sector, 0.95));
      expect(producibleNodes(weak).length, `${sector} weak rival can make nothing`).toBeGreaterThan(0);
      expect(producibleNodes(strong).length).toBeGreaterThanOrEqual(producibleNodes(weak).length);
    }
  });

  it('refuses a line whose prerequisite the company does not hold', () => {
    // Owning the accelerator without the package it is built from is exactly
    // the case ownership exists to refuse.
    const withoutPackage = companyOwning(['sys_ai_accelerator']);
    expect(canProduce(withoutPackage, 'sys_ai_accelerator')).toBe(false);
    const withPackage = companyOwning(['sys_ai_accelerator', 'sys_advanced_package']);
    expect(canProduce(withPackage, 'sys_ai_accelerator')).toBe(true);
  });

  it('lets a licence stand in for ownership until it lapses', () => {
    const licensee = {
      id: 'cmp_licensee',
      ownedNodes: ['sys_advanced_package'],
      licences: [{ nodeId: 'sys_ai_accelerator', ownerCompanyId: 'cmp_owner', royaltyPct: 8, expiryQuarter: 6 }],
    } as unknown as Company;
    expect(canProduce(licensee, 'sys_ai_accelerator', 0)).toBe(true);
    expect(canProduce(licensee, 'sys_ai_accelerator', 6)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  World 2 stays where it is                                                  */
/* -------------------------------------------------------------------------- */

describe('the deprecated world-2 catalogue', () => {
  it('is not imported by any world-3 module', () => {
    /*
     * Read as text through the bundler rather than through `node:fs`: this
     * package deliberately carries no Node type definitions, and the rule is
     * worth one declaration rather than a dependency. `import.meta.glob` is
     * replaced literally at transform time, so it must be written out in full.
     */
    const sources = import.meta.glob('../src/node*.ts', { query: '?raw', import: 'default', eager: true });
    const paths = Object.keys(sources);
    expect(paths.length, 'no world-3 source was scanned at all').toBeGreaterThanOrEqual(4);
    // Comments may name the catalogue — several of them explain what replaced
    // it. Only code counts, so the comments come out before the scan.
    const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [path, source] of Object.entries(sources)) {
      const code = codeOf(source);
      expect(code.includes("from './productCategories'"), `${path} imports the deprecated catalogue`).toBe(false);
      expect(code.includes('PRODUCT_CATEGORIES'), `${path} names the deprecated catalogue`).toBe(false);
      expect(code.includes('ProductCategorySchema'), `${path} names the deprecated schema`).toBe(false);
    }
  });
});

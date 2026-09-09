/**
 * @frontier/simulation — scenario/world2/frontier.ts
 *
 * The world-version-2 Frontier Map: the seventeen AI nodes the frozen world
 * already had, plus five for each of the other five sectors, laid out as six
 * tracks and wired together where one sector's progress genuinely gates
 * another's.
 *
 * ## The AI track is lifted, not copied
 *
 * The AI nodes are read straight out of the frozen scenario rather than
 * re-typed here, so the two worlds can never drift apart on what transformer
 * scaling is or when it happened. Only the company references are rewritten:
 * a node achieved by a world-1 laboratory is attributed to the world-2 company
 * that occupies the same seat, so nothing points at a company that does not
 * exist in this session.
 *
 * ## Why the cross-sector edges matter
 *
 * Dexterous manipulation depends on both an AI node and a manufacturing node,
 * a lights-out line depends on robotics, an electrified fleet depends on
 * grid-scale storage. Those edges are the research half of the same argument
 * the supply graph makes on the economic side: no sector gets to advance alone.
 */

import type { ResearchProject, TechEdge, TechGraph, TechNode, TechTrack } from '@frontier/contracts';
import { SECTORS, TechGraphSchema } from '@frontier/contracts';
import { DEMO_COMPANIES, demoSessionInput } from '../demo';
import { W2_COMPANIES } from './seeds';

const M = 1_000_000;
const BN = 1_000_000_000;

/* -------------------------------------------------------------------------- */
/*  The AI track, lifted from the frozen world                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which world-2 company inherits each world-1 company's place on the map. The
 * seats match: the frontier laboratory, the data house, the assurance shop, the
 * fabricator, the capacity provider and the robotics platform.
 */
const COMPANY_REMAP: Readonly<Record<string, string>> = {
  [DEMO_COMPANIES.nexus]: W2_COMPANIES.aletheia,
  [DEMO_COMPANIES.meridian]: W2_COMPANIES.kestrel,
  [DEMO_COMPANIES.vectorworks]: W2_COMPANIES.sable,
  [DEMO_COMPANIES.aurora]: W2_COMPANIES.tessellate,
  [DEMO_COMPANIES.helix]: W2_COMPANIES.basalt,
  [DEMO_COMPANIES.orbit]: W2_COMPANIES.ironvale,
};

/** Built once: the frozen graph is a constant, so lifting it is not per-session work. */
const LEGACY_GRAPH: TechGraph = TechGraphSchema.parse(demoSessionInput(0).techGraph);

function remapNode(node: TechNode): TechNode {
  const confidenceByCompany: Record<string, number> = {};
  for (const [companyId, confidence] of Object.entries(node.confidenceByCompany)) {
    confidenceByCompany[COMPANY_REMAP[companyId] ?? companyId] = confidence;
  }
  return {
    ...node,
    confidenceByCompany,
    achievedByCompanyId: node.achievedByCompanyId === null ? null : (COMPANY_REMAP[node.achievedByCompanyId] ?? node.achievedByCompanyId),
    originalProposerId: node.originalProposerId === null ? null : (COMPANY_REMAP[node.originalProposerId] ?? node.originalProposerId),
    estimatedWindow: [node.estimatedWindow[0], node.estimatedWindow[1]],
    researchCostRange: [node.researchCostRange[0], node.researchCostRange[1]],
    dependencies: [...node.dependencies],
    possibleUnlocks: [...node.possibleUnlocks],
  };
}

/** The seventeen AI nodes, re-attributed to world-2 companies. */
export const W2_AI_NODES: readonly TechNode[] = LEGACY_GRAPH.nodes.map(remapNode);

/** The AI edges, unchanged: edges name nodes, and no node id moved. */
export const W2_AI_EDGES: readonly TechEdge[] = LEGACY_GRAPH.edges.map((edge) => ({ ...edge }));

/* -------------------------------------------------------------------------- */
/*  The five new tracks                                                        */
/* -------------------------------------------------------------------------- */

interface NodeSeed {
  readonly id: string;
  readonly sector: TechNode['sector'];
  readonly title: string;
  readonly summary: string;
  readonly status: TechNode['status'];
  readonly confidence: number;
  readonly window: readonly [number, number];
  readonly cost: readonly [number, number];
  readonly intensity: number;
  readonly talent: readonly string[];
  readonly novelty: number;
  readonly plausibility: number;
  readonly visibility?: TechNode['visibility'];
  readonly achievedBy?: string;
  readonly companyConfidence?: Readonly<Record<string, number>>;
}

const SECTOR_NODE_SEEDS: readonly NodeSeed[] = [
  /* --- Robotics ---------------------------------------------------------- */
  {
    id: 'tech_dexterous_manipulation',
    sector: 'robotics',
    title: 'Dexterous Manipulation',
    summary: 'Grasping and placing unfamiliar objects at production rates without a fixture. The line between a demonstration and a fleet.',
    status: 'emerging',
    confidence: 0.66,
    window: [2027, 2030],
    cost: [80 * M, 520 * M],
    intensity: 0.58,
    talent: ['agents', 'multimodal', 'hardware_design'],
    novelty: 0.46,
    plausibility: 0.78,
    companyConfidence: { [W2_COMPANIES.ironvale]: 0.79 },
  },
  {
    id: 'tech_bipedal_locomotion',
    sector: 'robotics',
    title: 'Robust Bipedal Locomotion',
    summary: 'Walking, recovering and carrying load across surfaces nobody prepared. Solved in the laboratory, unsolved on a wet loading dock.',
    status: 'emerging',
    confidence: 0.58,
    window: [2028, 2031],
    cost: [120 * M, 700 * M],
    intensity: 0.62,
    talent: ['agents', 'hardware_design', 'evaluation'],
    novelty: 0.54,
    plausibility: 0.71,
    companyConfidence: { [W2_COMPANIES.wrenford]: 0.84 },
  },
  {
    id: 'tech_field_autonomy_stack',
    sector: 'robotics',
    title: 'Field Autonomy Stack',
    summary: 'Machines that work an unstructured site for a week without an operator, and know when to stop.',
    status: 'forecast',
    confidence: 0.49,
    window: [2029, 2033],
    cost: [200 * M, 950 * M],
    intensity: 0.68,
    talent: ['agents', 'reasoning', 'safety_alignment'],
    novelty: 0.61,
    plausibility: 0.63,
  },
  {
    id: 'tech_swarm_coordination',
    sector: 'robotics',
    title: 'Swarm Coordination',
    summary: 'Hundreds of cheap machines cooperating without a central planner, degrading gracefully as they fail.',
    status: 'emerging',
    confidence: 0.44,
    window: [2029, 2032],
    cost: [90 * M, 480 * M],
    intensity: 0.52,
    talent: ['agents', 'infrastructure'],
    novelty: 0.57,
    plausibility: 0.66,
  },
  {
    id: 'tech_general_purpose_humanoid',
    sector: 'robotics',
    title: 'General-Purpose Humanoid',
    summary: 'One machine that does an unfamiliar physical job after being shown it once. The category everybody is funding and nobody has.',
    status: 'speculative',
    confidence: 0.24,
    window: [2033, 2040],
    cost: [900 * M, 5 * BN],
    intensity: 0.81,
    talent: ['agents', 'reasoning', 'hardware_design'],
    novelty: 0.83,
    plausibility: 0.38,
    companyConfidence: { [W2_COMPANIES.wrenford]: 0.62 },
  },

  /* --- Manufacturing ----------------------------------------------------- */
  {
    id: 'tech_precision_actuators',
    sector: 'manufacturing',
    title: 'Precision Actuators at Volume',
    summary: 'Backlash-free actuation made by the hundred thousand rather than the hundred. Everything embodied is priced off this.',
    status: 'established',
    confidence: 0.88,
    window: [2023, 2027],
    cost: [30 * M, 260 * M],
    intensity: 0.14,
    talent: ['hardware_design', 'efficiency'],
    novelty: 0.18,
    plausibility: 0.95,
    achievedBy: W2_COMPANIES.halcyon,
  },
  {
    id: 'tech_closed_loop_yield',
    sector: 'manufacturing',
    title: 'Closed-Loop Yield Control',
    summary: 'Process control that reads its own defect data and corrects the line inside a shift instead of a quarter.',
    status: 'emerging',
    confidence: 0.71,
    window: [2027, 2029],
    cost: [60 * M, 380 * M],
    intensity: 0.34,
    talent: ['data_curation', 'evaluation', 'efficiency'],
    novelty: 0.36,
    plausibility: 0.84,
    companyConfidence: { [W2_COMPANIES.tessellate]: 0.86 },
  },
  {
    id: 'tech_additive_metal_forming',
    sector: 'manufacturing',
    title: 'Additive Metal Forming',
    summary: 'Printed structural metal with certified fatigue behaviour, which is the only reason anyone would fly it.',
    status: 'emerging',
    confidence: 0.54,
    window: [2028, 2031],
    cost: [80 * M, 460 * M],
    intensity: 0.28,
    talent: ['hardware_design', 'evaluation'],
    novelty: 0.48,
    plausibility: 0.7,
  },
  {
    id: 'tech_lights_out_line',
    sector: 'manufacturing',
    title: 'Lights-Out Line',
    summary: 'A production line that runs a full shift with nobody in the building, including the changeovers.',
    status: 'forecast',
    confidence: 0.46,
    window: [2030, 2034],
    cost: [300 * M, 1.6 * BN],
    intensity: 0.55,
    talent: ['agents', 'infrastructure', 'efficiency'],
    novelty: 0.58,
    plausibility: 0.61,
  },
  {
    id: 'tech_self_reconfiguring_tooling',
    sector: 'manufacturing',
    title: 'Self-Reconfiguring Tooling',
    summary: 'Tooling that re-forms itself for a new part overnight, collapsing the economics of small runs.',
    status: 'speculative',
    confidence: 0.21,
    window: [2034, 2041],
    cost: [600 * M, 3.2 * BN],
    intensity: 0.62,
    talent: ['hardware_design', 'agents'],
    novelty: 0.79,
    plausibility: 0.32,
  },

  /* --- Energy ------------------------------------------------------------ */
  {
    id: 'tech_grid_scale_storage',
    sector: 'energy',
    title: 'Grid-Scale Storage',
    summary: 'Four hours of firm capacity at a price the market will actually pay. The thing that makes intermittent generation dispatchable.',
    status: 'established',
    confidence: 0.91,
    window: [2022, 2027],
    cost: [200 * M, 1.4 * BN],
    intensity: 0.09,
    talent: ['hardware_design', 'infrastructure'],
    novelty: 0.14,
    plausibility: 0.96,
    achievedBy: W2_COMPANIES.qanat,
  },
  {
    id: 'tech_long_duration_storage',
    sector: 'energy',
    title: 'Long-Duration Storage',
    summary: 'A hundred hours rather than four, which is the difference between smoothing a day and surviving a still week.',
    status: 'emerging',
    confidence: 0.57,
    window: [2028, 2032],
    cost: [400 * M, 2.4 * BN],
    intensity: 0.11,
    talent: ['hardware_design', 'infrastructure', 'efficiency'],
    novelty: 0.52,
    plausibility: 0.68,
    companyConfidence: { [W2_COMPANIES.cinder]: 0.74 },
  },
  {
    id: 'tech_grid_forming_inverters',
    sector: 'energy',
    title: 'Grid-Forming Inverters',
    summary: 'Inverters that hold a grid up on their own, so a region can run without a spinning machine anywhere on it.',
    status: 'emerging',
    confidence: 0.63,
    window: [2027, 2030],
    cost: [90 * M, 520 * M],
    intensity: 0.13,
    talent: ['hardware_design', 'security', 'infrastructure'],
    novelty: 0.41,
    plausibility: 0.79,
    companyConfidence: { [W2_COMPANIES.grimsby]: 0.71 },
  },
  {
    id: 'tech_advanced_geothermal',
    sector: 'energy',
    title: 'Advanced Geothermal',
    summary: 'Firm, siteable heat almost anywhere, drilled with methods the oil industry already owns.',
    status: 'forecast',
    confidence: 0.42,
    window: [2030, 2035],
    cost: [700 * M, 3.8 * BN],
    intensity: 0.08,
    talent: ['infrastructure', 'hardware_design'],
    novelty: 0.56,
    plausibility: 0.58,
  },
  {
    id: 'tech_fusion_pilot_plant',
    sector: 'energy',
    title: 'Fusion Pilot Plant',
    summary: 'Net electrical output onto a real grid for a sustained run. Perennially a decade away, and funded anyway.',
    status: 'speculative',
    confidence: 0.18,
    window: [2036, 2046],
    cost: [3 * BN, 14 * BN],
    intensity: 0.24,
    talent: ['hardware_design', 'infrastructure', 'evaluation'],
    novelty: 0.88,
    plausibility: 0.27,
  },

  /* --- Logistics --------------------------------------------------------- */
  {
    id: 'tech_dynamic_network_routing',
    sector: 'logistics',
    title: 'Dynamic Network Routing',
    summary: 'Re-planning a whole freight network hourly against live demand and live disruption, rather than nightly against yesterday.',
    status: 'established',
    confidence: 0.86,
    window: [2023, 2027],
    cost: [20 * M, 160 * M],
    intensity: 0.26,
    talent: ['agents', 'data_curation', 'efficiency'],
    novelty: 0.22,
    plausibility: 0.94,
    achievedBy: W2_COMPANIES.harbourline,
  },
  {
    id: 'tech_autonomous_line_haul',
    sector: 'logistics',
    title: 'Autonomous Line Haul',
    summary: 'Trunk routes driven without a cab occupant, on corridors chosen for how boring they are.',
    status: 'emerging',
    confidence: 0.61,
    window: [2028, 2031],
    cost: [180 * M, 900 * M],
    intensity: 0.48,
    talent: ['agents', 'evaluation', 'safety_alignment'],
    novelty: 0.49,
    plausibility: 0.72,
  },
  {
    id: 'tech_automated_crossdock',
    sector: 'logistics',
    title: 'Automated Cross-Dock',
    summary: 'Freight broken down and rebuilt without a human touching it, at the point where every network currently loses its margin.',
    status: 'emerging',
    confidence: 0.59,
    window: [2027, 2030],
    cost: [70 * M, 420 * M],
    intensity: 0.32,
    talent: ['agents', 'infrastructure', 'efficiency'],
    novelty: 0.38,
    plausibility: 0.8,
  },
  {
    id: 'tech_electrified_fleet',
    sector: 'logistics',
    title: 'Fully Electrified Fleet',
    summary: 'Heavy freight on batteries with depot charging that does not need a new substation for every yard.',
    status: 'forecast',
    confidence: 0.51,
    window: [2029, 2034],
    cost: [250 * M, 1.8 * BN],
    intensity: 0.16,
    talent: ['infrastructure', 'hardware_design', 'efficiency'],
    novelty: 0.44,
    plausibility: 0.69,
  },
  {
    id: 'tech_drone_last_mile',
    sector: 'logistics',
    title: 'Drone Last Mile',
    summary: 'Airborne delivery at a unit cost below a van, in airspace a regulator has actually opened.',
    status: 'forecast',
    confidence: 0.33,
    window: [2031, 2036],
    cost: [140 * M, 820 * M],
    intensity: 0.36,
    talent: ['agents', 'safety_alignment', 'hardware_design'],
    novelty: 0.63,
    plausibility: 0.47,
  },

  /* --- Consumer ---------------------------------------------------------- */
  {
    id: 'tech_synthetic_media_studio',
    sector: 'consumer',
    title: 'Synthetic Media Studio',
    summary: 'Broadcast-quality creative produced end to end by a two-person team, and the provenance marking that keeps it sellable.',
    status: 'established',
    confidence: 0.84,
    window: [2024, 2027],
    cost: [15 * M, 120 * M],
    intensity: 0.44,
    talent: ['multimodal', 'evaluation'],
    novelty: 0.26,
    plausibility: 0.93,
    achievedBy: W2_COMPANIES.lumen,
  },
  {
    id: 'tech_personal_agent_commerce',
    sector: 'consumer',
    title: 'Personal Agent Commerce',
    summary: 'Agents that shop, negotiate and return on a household\'s behalf — and the merchants who have to decide whether to serve them.',
    status: 'emerging',
    confidence: 0.68,
    window: [2027, 2030],
    cost: [40 * M, 340 * M],
    intensity: 0.51,
    talent: ['agents', 'retrieval', 'safety_alignment'],
    novelty: 0.47,
    plausibility: 0.77,
    companyConfidence: { [W2_COMPANIES.copa]: 0.72 },
  },
  {
    id: 'tech_ambient_home_assistant',
    sector: 'consumer',
    title: 'Ambient Home Assistant',
    summary: 'A household system that is useful without being asked, and trusted enough to be left switched on.',
    status: 'emerging',
    confidence: 0.55,
    window: [2028, 2031],
    cost: [60 * M, 420 * M],
    intensity: 0.46,
    talent: ['multimodal', 'agents', 'safety_alignment'],
    novelty: 0.5,
    plausibility: 0.7,
    companyConfidence: { [W2_COMPANIES.lumen]: 0.66 },
  },
  {
    id: 'tech_household_robotics',
    sector: 'consumer',
    title: 'Household Robotics',
    summary: 'A machine that does domestic work in a house nobody tidied for it, at a price a household would pay.',
    status: 'forecast',
    confidence: 0.31,
    window: [2032, 2038],
    cost: [400 * M, 2.6 * BN],
    intensity: 0.58,
    talent: ['agents', 'hardware_design', 'multimodal'],
    novelty: 0.72,
    plausibility: 0.44,
  },
  {
    id: 'tech_neural_interface_retail',
    sector: 'consumer',
    title: 'Consumer Neural Interfaces',
    summary: 'Direct neural input as a mass-market product. Two funded attempts collapsed on regulatory and comfort grounds, and the field has moved on.',
    status: 'discredited',
    confidence: 0.09,
    window: [2035, 2045],
    cost: [800 * M, 4 * BN],
    intensity: 0.31,
    talent: ['hardware_design', 'safety_alignment'],
    novelty: 0.81,
    plausibility: 0.12,
  },
];

/**
 * The new edges. Cross-sector dependencies are the point: robotics cannot move
 * without AI and manufacturing, a lights-out line cannot exist without robotics,
 * and an electrified fleet is downstream of a battery.
 */
const SECTOR_EDGE_SEEDS: readonly TechEdge[] = [
  // Robotics is downstream of AI and of the parts it is made of.
  { from: 'tech_tool_learning', to: 'tech_dexterous_manipulation', kind: 'depends', strength: 0.9 },
  { from: 'tech_precision_actuators', to: 'tech_dexterous_manipulation', kind: 'depends', strength: 1 },
  { from: 'tech_precision_actuators', to: 'tech_bipedal_locomotion', kind: 'depends', strength: 1 },
  { from: 'tech_dexterous_manipulation', to: 'tech_field_autonomy_stack', kind: 'depends', strength: 1 },
  { from: 'tech_long_horizon_planning', to: 'tech_field_autonomy_stack', kind: 'depends', strength: 0.8 },
  { from: 'tech_dexterous_manipulation', to: 'tech_swarm_coordination', kind: 'informs', strength: 0.5 },
  { from: 'tech_bipedal_locomotion', to: 'tech_general_purpose_humanoid', kind: 'depends', strength: 1 },
  { from: 'tech_field_autonomy_stack', to: 'tech_general_purpose_humanoid', kind: 'depends', strength: 1 },

  // Manufacturing takes AI as an input and hands parts back to everyone else.
  { from: 'tech_transformer_scaling', to: 'tech_closed_loop_yield', kind: 'informs', strength: 0.6 },
  { from: 'tech_closed_loop_yield', to: 'tech_lights_out_line', kind: 'depends', strength: 1 },
  { from: 'tech_dexterous_manipulation', to: 'tech_lights_out_line', kind: 'depends', strength: 0.9 },
  { from: 'tech_additive_metal_forming', to: 'tech_self_reconfiguring_tooling', kind: 'depends', strength: 0.8 },
  { from: 'tech_lights_out_line', to: 'tech_self_reconfiguring_tooling', kind: 'informs', strength: 0.6 },
  { from: 'tech_precision_actuators', to: 'tech_additive_metal_forming', kind: 'informs', strength: 0.4 },

  // Energy: storage first, then everything that assumes storage.
  { from: 'tech_grid_scale_storage', to: 'tech_long_duration_storage', kind: 'depends', strength: 1 },
  { from: 'tech_grid_scale_storage', to: 'tech_grid_forming_inverters', kind: 'informs', strength: 0.7 },
  { from: 'tech_grid_forming_inverters', to: 'tech_advanced_geothermal', kind: 'informs', strength: 0.4 },
  { from: 'tech_long_duration_storage', to: 'tech_fusion_pilot_plant', kind: 'informs', strength: 0.3 },
  { from: 'tech_efficient_sparse_inference', to: 'tech_advanced_geothermal', kind: 'informs', strength: 0.3 },

  // Logistics: routing first, then autonomy, then the fleet that runs it.
  { from: 'tech_dynamic_network_routing', to: 'tech_autonomous_line_haul', kind: 'depends', strength: 0.7 },
  { from: 'tech_tool_learning', to: 'tech_autonomous_line_haul', kind: 'depends', strength: 0.8 },
  { from: 'tech_dexterous_manipulation', to: 'tech_automated_crossdock', kind: 'depends', strength: 1 },
  { from: 'tech_grid_scale_storage', to: 'tech_electrified_fleet', kind: 'depends', strength: 1 },
  { from: 'tech_autonomous_line_haul', to: 'tech_drone_last_mile', kind: 'informs', strength: 0.5 },
  { from: 'tech_swarm_coordination', to: 'tech_drone_last_mile', kind: 'depends', strength: 0.8 },

  // Consumer is downstream of everything, which is why it turns fastest.
  { from: 'tech_tool_learning', to: 'tech_personal_agent_commerce', kind: 'depends', strength: 1 },
  { from: 'tech_retrieval_grounding', to: 'tech_personal_agent_commerce', kind: 'informs', strength: 0.6 },
  { from: 'tech_synthetic_media_studio', to: 'tech_ambient_home_assistant', kind: 'informs', strength: 0.4 },
  { from: 'tech_personal_agent_commerce', to: 'tech_ambient_home_assistant', kind: 'depends', strength: 0.8 },
  { from: 'tech_general_purpose_humanoid', to: 'tech_household_robotics', kind: 'depends', strength: 0.9 },
  { from: 'tech_ambient_home_assistant', to: 'tech_household_robotics', kind: 'depends', strength: 0.7 },
];

/** All edges in the world-2 map: the AI ones lifted, the sector ones declared. */
export const W2_EDGES: readonly TechEdge[] = [...W2_AI_EDGES, ...SECTOR_EDGE_SEEDS.map((edge) => ({ ...edge }))];

function buildSectorNode(seed: NodeSeed): TechNode {
  const dependencies = W2_EDGES.filter((edge) => edge.to === seed.id && edge.kind === 'depends').map((edge) => edge.from);
  const unlocks = W2_EDGES.filter((edge) => edge.from === seed.id && edge.kind === 'unlocks').map((edge) => edge.to);
  return {
    id: seed.id,
    title: seed.title,
    summary: seed.summary,
    sector: seed.sector,
    status: seed.status,
    publicConfidence: seed.confidence,
    confidenceByCompany: { ...(seed.companyConfidence ?? {}) },
    estimatedWindow: [seed.window[0], seed.window[1]],
    researchCostRange: [seed.cost[0], seed.cost[1]],
    computeIntensity: seed.intensity,
    talentRequirements: [...seed.talent],
    dependencies,
    possibleUnlocks: unlocks,
    originalProposerId: null,
    visibility: seed.visibility ?? 'public',
    achievedByCompanyId: seed.achievedBy ?? null,
    achievedQuarter: seed.achievedBy === undefined ? null : 0,
    createdQuarter: 0,
    novelty: seed.novelty,
    plausibility: seed.plausibility,
  };
}

/**
 * The AI nodes keep the dependency lists the frozen world gave them; the new
 * ones derive theirs from the combined edge list, so a cross-sector `depends`
 * edge shows up on the node it gates.
 */
export const W2_NODES: readonly TechNode[] = [...W2_AI_NODES, ...SECTOR_NODE_SEEDS.map(buildSectorNode)];

/** Track titles and blurbs, one lane per sector, in `SECTORS` order. */
const TRACK_COPY: Readonly<Record<TechTrack['sector'], { readonly title: string; readonly summary: string }>> = {
  ai: { title: 'Frontier Intelligence', summary: 'Scaling, reasoning and the systems that train them. Everything else on this map takes it as an input.' },
  robotics: { title: 'Embodied Autonomy', summary: 'Getting capability out of a datacentre and into a machine that has to survive a wet floor.' },
  manufacturing: { title: 'Production Systems', summary: 'Yield, tolerance and what it costs to make the next physical unit.' },
  energy: { title: 'Power and Grid', summary: 'Firm capacity, storage and the price everybody else pays for electricity.' },
  logistics: { title: 'Movement', summary: 'Routing, autonomy and the last ten miles that cost more than the first thousand.' },
  consumer: { title: 'Everyday Systems', summary: 'What all of this looks like from a household, and whether it is trusted enough to leave running.' },
};

/** One lane per sector, in presentation order, listing its nodes in graph order. */
export const W2_TRACKS: readonly TechTrack[] = SECTORS.map((sector) => ({
  sector,
  title: TRACK_COPY[sector].title,
  summary: TRACK_COPY[sector].summary,
  nodeIds: W2_NODES.filter((node) => node.sector === sector).map((node) => node.id),
}));

/* -------------------------------------------------------------------------- */
/*  Live programmes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Five programmes are already running when the session opens, spread across
 * four sectors, and one of them is secret: Aletheia is quietly testing whether
 * its own scaling guidance holds, and its results contradict what it has told
 * the market.
 */
export const W2_RESEARCH_PROJECTS: readonly ResearchProject[] = [
  {
    id: 'rsp_aletheia_sparse_expert',
    companyId: W2_COMPANIES.aletheia,
    targetNodeId: 'tech_sparse_expert_reasoning',
    budgetQuarterly: 420 * M,
    computeAllocated: 74_000,
    talentAllocated: 190,
    progress: 0.11,
    internalConfidence: 0.64,
    quartersElapsed: 1,
    expectedQuarters: 5,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 44 * M,
    setbacks: 0,
    startedQuarter: 0,
  },
  {
    id: 'rsp_aletheia_scaling_wall',
    companyId: W2_COMPANIES.aletheia,
    targetNodeId: 'tech_dense_scaling_saturation',
    budgetQuarterly: 30 * M,
    computeAllocated: 5_000,
    talentAllocated: 22,
    progress: 0.36,
    internalConfidence: 0.76,
    quartersElapsed: 2,
    expectedQuarters: 4,
    // Nobody outside Aletheia knows this exists. Its setbacks stay out of the
    // share price; its conclusions contradict the company's own guidance.
    isSecret: true,
    status: 'active',
    cumulativeSpendUsd: 58 * M,
    setbacks: 1,
    startedQuarter: 0,
  },
  {
    id: 'rsp_ironvale_manipulation',
    companyId: W2_COMPANIES.ironvale,
    targetNodeId: 'tech_dexterous_manipulation',
    budgetQuarterly: 96 * M,
    computeAllocated: 9_000,
    talentAllocated: 210,
    progress: 0.29,
    internalConfidence: 0.79,
    quartersElapsed: 3,
    expectedQuarters: 7,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 246 * M,
    setbacks: 1,
    startedQuarter: 0,
  },
  {
    id: 'rsp_wrenford_locomotion',
    companyId: W2_COMPANIES.wrenford,
    targetNodeId: 'tech_bipedal_locomotion',
    budgetQuarterly: 54 * M,
    computeAllocated: 6_400,
    talentAllocated: 160,
    progress: 0.41,
    internalConfidence: 0.84,
    quartersElapsed: 5,
    expectedQuarters: 9,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 238 * M,
    setbacks: 2,
    startedQuarter: 0,
  },
  {
    id: 'rsp_grimsby_inverters',
    companyId: W2_COMPANIES.grimsby,
    targetNodeId: 'tech_grid_forming_inverters',
    budgetQuarterly: 18 * M,
    computeAllocated: 400,
    talentAllocated: 60,
    progress: 0.47,
    internalConfidence: 0.71,
    quartersElapsed: 4,
    expectedQuarters: 6,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 66 * M,
    setbacks: 0,
    startedQuarter: 0,
  },
];

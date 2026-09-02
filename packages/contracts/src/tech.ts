/**
 * @frontier/contracts — tech.ts
 *
 * The Frontier Map.
 *
 * This is not a conventional technology tree. A tree tells the player that A
 * leads to B leads to C, which implicitly claims the designers already know the
 * future. The Frontier Map instead represents **what the inhabitants of this
 * particular simulated world currently believe the technological future might
 * look like**. It is probabilistic, contested and mutable.
 *
 * Consequences that follow from that framing:
 * - Every node carries an epistemic state and a confidence, not a boolean.
 * - Confidence differs between the public and each company. A company thesis is
 *   a belief one company holds and the market does not share.
 * - World events move beliefs. When power costs soar, confidence in huge dense
 *   models falls and confidence in efficient sparse inference rises, and the
 *   rendered graph rearranges.
 * - Players can invent nodes that were never in the seed graph. An accepted
 *   innovation proposal becomes a real node in that session's graph.
 *
 * The model generates a typed `TechGraph`, never executable markup. Trusted
 * React and SVG code renders it. That is what makes the interface generative
 * without making generated content authoritative.
 */

import { z } from 'zod';
import { CalendarYearSchema, QuarterIndexSchema, intCount, unitInterval, usd } from './ids';
import { DEFAULT_SECTOR, SectorSchema } from './sectors';

/* -------------------------------------------------------------------------- */
/*  Epistemic state                                                            */
/* -------------------------------------------------------------------------- */

export const TECH_EPISTEMIC_STATES = [
  'established',
  'emerging',
  'forecast',
  'speculative',
  'company_thesis',
  'secret',
  'discredited',
  'achieved',
  'dead_end',
] as const;

export const TechEpistemicStateSchema = z
  .enum(TECH_EPISTEMIC_STATES)
  .describe(
    'How the world currently regards this technology. "established": widely known and deployed. "emerging": technically credible and actively developing. "forecast": broadly considered plausible. "speculative": weak or contested evidence. "company_thesis": believed mainly by one company. "secret": known only inside one organisation. "discredited": previously expected, now considered unlikely. "achieved": successfully demonstrated in this session. "dead_end": session evidence has strongly undermined the path.',
  );
export type TechEpistemicState = z.infer<typeof TechEpistemicStateSchema>;

export const TECH_VISIBILITIES = ['public', 'sector', 'company_private', 'classified'] as const;

export const TechVisibilitySchema = z
  .enum(TECH_VISIBILITIES)
  .describe('Who can see the node exists. A secret programme is company_private: rivals cannot see it until it is published, leaked or demonstrated in a product.');
export type TechVisibility = z.infer<typeof TechVisibilitySchema>;

/* -------------------------------------------------------------------------- */
/*  Nodes                                                                      */
/* -------------------------------------------------------------------------- */

export const TechNodeSchema = z
  .object({
    id: z.string().min(1).describe('Node id, e.g. "tech_autonomous_research_v2".'),
    title: z.string().min(3).max(120).describe('Node name as it appears on the Frontier Map, e.g. "Autonomous Research Systems".'),
    summary: z.string().min(10).max(1000).describe('What this technology would be and why it would matter.'),
    sector: SectorSchema.default(DEFAULT_SECTOR).describe(
      'Which sector this node belongs to. The map draws one track per sector, and a node only counts toward a company\'s capability when the sectors agree. Defaults to "ai" so a world-version-1 graph parses unchanged.',
    ),
    status: TechEpistemicStateSchema,
    publicConfidence: unitInterval('How likely the world at large thinks this is to arrive. This is the number the map renders and the number events move.'),
    confidenceByCompany: z
      .record(z.string(), unitInterval('That company\'s private confidence in this node.'))
      .describe(
        'Private confidence keyed by company id. INTERNAL: never send another company\'s entry to a client. The gap between a company\'s confidence and public confidence is exactly the informational edge a research bet is made on.',
      ),
    estimatedWindow: z
      .tuple([CalendarYearSchema, CalendarYearSchema])
      .describe('[earliestYear, latestYear] in which arrival is currently expected. Events shift this: an efficiency breakthrough can pull a 2032 expectation to 2030.'),
    researchCostRange: z
      .tuple([usd('Low estimate of total programme cost.'), usd('High estimate of total programme cost.')])
      .describe('[low, high] estimated total cost to reach this node, in dollars. Estimates, not truth: real cost is drawn inside the range and can overrun.'),
    computeIntensity: unitInterval('How compute-hungry the programme is. High-intensity nodes are hostage to the compute domain of the world state.'),
    talentRequirements: z.array(z.string()).describe('Capability areas required, e.g. ["reasoning", "agents", "evaluation"]. Compared against the company\'s techCapabilities.'),
    dependencies: z.array(z.string()).describe('Node ids that must be achieved, or nearly achieved, first.'),
    possibleUnlocks: z.array(z.string()).describe('Node ids this one would make credible. Possible, not guaranteed: an unlock is a belief about consequence.'),
    originalProposerId: z.string().nullable().describe('Character who first proposed this node, or null for nodes present in the seed graph. Player-invented nodes carry their inventor\'s name for the rest of the session.'),
    visibility: TechVisibilitySchema,
    achievedByCompanyId: z.string().nullable().describe('First company to demonstrate it, or null.'),
    achievedQuarter: QuarterIndexSchema.nullable(),
    createdQuarter: QuarterIndexSchema.describe('Quarter the node entered the graph.'),
    novelty: unitInterval('How far this sits from what the world already believes. High novelty nodes move the whole map when they succeed.'),
    plausibility: unitInterval('Engine assessment of whether the node is coherent with known physics, economics and the current frontier.'),
  })
  .describe('One node on the Frontier Map: a belief about a possible technology, held with a confidence that differs between the public and each company.');
export type TechNode = z.infer<typeof TechNodeSchema>;

/* -------------------------------------------------------------------------- */
/*  Graph                                                                      */
/* -------------------------------------------------------------------------- */

export const TECH_EDGE_KINDS = ['depends', 'unlocks', 'informs'] as const;

export const TechEdgeKindSchema = z
  .enum(TECH_EDGE_KINDS)
  .describe('"depends": the target needs the source first. "unlocks": the source makes the target credible. "informs": evidence about the source updates belief in the target without being a prerequisite.');
export type TechEdgeKind = z.infer<typeof TechEdgeKindSchema>;

export const TechEdgeSchema = z
  .object({
    from: z.string().min(1).describe('Source node id.'),
    to: z.string().min(1).describe('Target node id.'),
    kind: TechEdgeKindSchema,
    strength: unitInterval('How strong the relationship is. Weak "informs" edges propagate small confidence changes; strong "depends" edges gate progress outright.'),
  })
  .describe('One directed relationship between nodes.');
export type TechEdge = z.infer<typeof TechEdgeSchema>;

export const TechTrackSchema = z
  .object({
    sector: SectorSchema,
    title: z.string().min(3).max(80).describe('Track name as it appears above its lane on the map, e.g. "Embodied Autonomy".'),
    summary: z.string().max(400).describe('One or two sentences on what this sector is currently trying to reach.'),
    nodeIds: z.array(z.string()).describe('Nodes in this track, in the order the map lays them out. A node may appear in one track only.'),
  })
  .describe('One sector lane on the Frontier Map. Tracks are presentation and grouping only: the graph is still the nodes and edges, and a dependency may cross tracks.');
export type TechTrack = z.infer<typeof TechTrackSchema>;

export const TechGraphSchema = z
  .object({
    version: z.number().int().min(1).describe('Monotonic graph version. Every accepted innovation proposal or belief shift increments it, so clients can detect a stale map.'),
    sessionId: z.string().min(1),
    nodes: z.array(TechNodeSchema),
    edges: z.array(TechEdgeSchema),
    tracks: z
      .array(TechTrackSchema)
      .default([])
      .describe('Per-sector lanes, in presentation order. Empty for a world-version-1 graph, which is a single implicit AI track.'),
    updatedQuarter: QuarterIndexSchema,
  })
  .describe('The session Frontier Map. Versioned because it changes: nodes are added, confidences move, windows shift and paths die.');
export type TechGraph = z.infer<typeof TechGraphSchema>;

/** Nodes belonging to one sector, in graph order. Pure; safe in the engine. */
export function nodesInSector(graph: TechGraph, sector: TechNode['sector']): readonly TechNode[] {
  return graph.nodes.filter((node) => node.sector === sector);
}

/* -------------------------------------------------------------------------- */
/*  Research projects                                                          */
/* -------------------------------------------------------------------------- */

export const RESEARCH_PROJECT_STATUSES = ['active', 'paused', 'succeeded', 'failed', 'abandoned'] as const;
export const ResearchProjectStatusSchema = z.enum(RESEARCH_PROJECT_STATUSES).describe('State of a research programme.');
export type ResearchProjectStatus = z.infer<typeof ResearchProjectStatusSchema>;

export const ResearchProjectSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    targetNodeId: z.string().min(1).describe('The Frontier Map node this programme is trying to reach.'),
    budgetQuarterly: usd('Cash committed per quarter, excluding compute.'),
    computeAllocated: intCount('Accelerator-equivalents dedicated to the programme each quarter.'),
    talentAllocated: intCount('Researchers assigned. The binding constraint more often than money.'),
    progress: unitInterval('Fraction of the way to demonstration. Progress is not linear and can go backwards after a failed run.'),
    internalConfidence: unitInterval(
      'The team\'s own belief that the programme will succeed. Diverges from public confidence and from what the company says publicly, which is how "internal confidence 42%, guidance on schedule" happens.',
    ),
    quartersElapsed: z.number().int().min(0).max(200).describe('Quarters since the programme began.'),
    expectedQuarters: z.number().int().min(1).max(200).describe('Current internal estimate of total quarters required. Slips when a run disappoints.'),
    isSecret: z.boolean().describe('True while the programme is concealed. A secret setback damages internal research and does not move the share price — unless it leaks.'),
    status: ResearchProjectStatusSchema,
    cumulativeSpendUsd: usd('Everything spent so far, used for cost-overrun reporting.'),
    setbacks: z.number().int().min(0).describe('Failed runs so far. Each one raises expectedQuarters and lowers internalConfidence.'),
    startedQuarter: QuarterIndexSchema,
  })
  .describe('An internal research programme. Its private truth and its public story are stored separately on purpose.');
export type ResearchProject = z.infer<typeof ResearchProjectSchema>;

/* -------------------------------------------------------------------------- */
/*  Innovation proposals (LLM-facing)                                          */
/* -------------------------------------------------------------------------- */

export const INITIAL_TECH_VISIBILITIES = ['public', 'company_private'] as const;

export const InnovationProposalSchema = z
  .object({
    nodeType: z
      .enum(['player_hypothesis'])
      .describe('Always "player_hypothesis". Marks the node as invented within this session rather than seeded, which is how the game credits an inventor.'),
    title: z.string().min(3).max(120).describe('Name for the proposed technology, e.g. "Mass Multi-Agent World Learning".'),
    summary: z.string().min(20).max(1000).describe('What it is, in two to four sentences: the mechanism, not the marketing.'),
    novelty: unitInterval('How far this sits from what the world already believes is possible. 0.2 restates the consensus; 0.85 is a genuinely new direction.'),
    plausibility: unitInterval(
      'How consistent this is with known physics, economics and the current frontier. Be honest: a low plausibility proposal is not rejected outright, it becomes a speculative node that will be expensive to prove.',
    ),
    requiredCapabilities: z
      .array(z.string())
      .max(8)
      .describe('Capability areas the programme needs, e.g. ["agent_simulation", "reinforcement_learning", "large_scale_compute"]. Checked against the company\'s real capabilities.'),
    estimatedCost: usd('Total estimated programme cost in dollars, e.g. 280000000 for $280m. Checked against the company\'s actual resources.'),
    estimatedQuarters: z.number().int().min(1).max(60).describe('Quarters to a first demonstration if it works at all.'),
    dependencies: z.array(z.string()).max(8).describe('Ids of existing Frontier Map nodes this builds on. Use only ids present in the supplied graph; unknown ids are dropped.'),
    initialVisibility: z.enum(INITIAL_TECH_VISIBILITIES).describe('"company_private" keeps the thesis secret, which is usually right for a genuine edge. "public" announces it and can attract talent and capital at the cost of surrendering surprise.'),
    rationale: z.string().min(20).max(800).describe('Why this is worth doing now, given this company\'s position and this world\'s conditions.'),
  })
  .describe(
    'A proposed new node on the Frontier Map, produced by the Innovation Interpreter from a player\'s own idea. The rules engine then checks it is remotely consistent with the game\'s resources and technology; if accepted it becomes a real node in this session\'s graph.',
  );
export type InnovationProposal = z.infer<typeof InnovationProposalSchema>;

export const InnovationIntegrationResultSchema = z
  .object({
    accepted: z.boolean().describe('Whether the proposal became a node.'),
    nodeId: z.string().nullable().describe('Id of the created node, or null when rejected.'),
    reasons: z.array(z.string()).describe('Why it was accepted or refused, in player-readable language.'),
    adjustedPlausibility: unitInterval('Engine-assessed plausibility, which may be lower than the proposer claimed.'),
    adjustedCostUsd: usd('Engine-assessed cost, which may be far higher than the proposer estimated.'),
    adjustedQuarters: z.number().int().min(1).max(60).describe('Engine-assessed duration.'),
  })
  .describe('Outcome of running an innovation proposal through the rules engine.');
export type InnovationIntegrationResult = z.infer<typeof InnovationIntegrationResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Belief movement                                                            */
/* -------------------------------------------------------------------------- */

export const TechConfidenceUpdateSchema = z
  .object({
    nodeId: z.string().min(1),
    quarter: QuarterIndexSchema,
    previousConfidence: unitInterval('Public confidence before the update.'),
    newConfidence: unitInterval('Public confidence after the update.'),
    previousStatus: TechEpistemicStateSchema,
    newStatus: TechEpistemicStateSchema,
    windowShiftYears: z.number().int().min(-10).max(10).describe('Change to the expected arrival window, in years.'),
    causeEventId: z.string().nullable().describe('World event that caused the shift, or null for endogenous drift.'),
    reason: z.string().max(300).describe('Player-readable explanation shown on the Frontier Map.'),
  })
  .describe('One recorded movement in what the world believes. The Frontier Map screen animates these.');
export type TechConfidenceUpdate = z.infer<typeof TechConfidenceUpdateSchema>;

/** How a company can make a private research result public. */
export const PUBLICATION_MODES = ['paper', 'open_weights', 'product_demonstration', 'closed_briefing', 'leak'] as const;
export const PublicationModeSchema = z
  .enum(PUBLICATION_MODES)
  .describe(
    'How a result reaches the world. "paper" and "open_weights" buy developer and research reputation while handing rivals the method. "product_demonstration" proves capability commercially. "closed_briefing" reaches government and investors only. "leak" is not chosen; it happens.',
  );
export type PublicationMode = z.infer<typeof PublicationModeSchema>;

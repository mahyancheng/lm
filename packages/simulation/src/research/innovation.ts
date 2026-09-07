/**
 * @frontier/simulation — research/innovation.ts
 *
 * Player-invented technology.
 *
 * The Innovation Interpreter turns a player's own idea into an
 * `InnovationProposal`. That is a *proposal*: this module is the rules engine
 * that decides whether it is remotely consistent with the session's resources
 * and technology, and what it would actually cost.
 *
 * The engine is deliberately permissive about ambition and strict about
 * arithmetic. A low-plausibility idea is not thrown out — it becomes a
 * `speculative` thesis that will be expensive to prove. What is thrown out is an
 * idea that depends on nothing that exists, duplicates a node already on the
 * map, or would cost twenty-five times everything the company could ever reach.
 *
 * `InnovationProposal` carries no company id, by the same rule that keeps
 * `ActionIntent` free of one. The proposing company comes from the
 * `propose_innovation` action that carried it.
 */

import { ECONOMIC_NODES_BY_ID, economicNodeById, economicNodeInSession, productBlueprintNodeId, type EconomicNode, type ProductRecipe } from '@frontier/contracts';
import { isNodeEconomyWorld } from '../economy/sectors';
import { integrateExperiment } from './experiments';
import type {
  Company,
  InnovationIntegrationResult,
  InnovationProposal,
  ResolverContext,
  SessionState,
  TechEdge,
  TechNode,
} from '@frontier/contracts';
import { DEFAULT_SECTOR, makeId, quarterToYear, slugify } from '@frontier/contracts';
import {
  CLAIMED_PLAUSIBILITY_WEIGHT,
  INNOVATION_AFFORDABILITY_MULTIPLE,
  INNOVATION_COST_FLOOR_USD,
  INNOVATION_COST_RANGE,
  INNOVATION_DEPENDENCY_EDGE_STRENGTH,
  INNOVATION_INTERNAL_CONFIDENCE,
  INNOVATION_NOVELTY_COST_MULTIPLE,
  INNOVATION_PRIVATE_PUBLIC_CONFIDENCE,
  INNOVATION_PUBLIC_CONFIDENCE,
  INNOVATION_REVENUE_REACH_QUARTERS,
  INNOVATION_SCHEDULE_STRETCH,
  MIN_ACCEPTABLE_PLAUSIBILITY,
} from './balance';
import { bumpGraphVersion, capabilityCoverage, clamp, emitEvent, findCompany, isCapabilityArea, money, ratio, unit, usdLabel } from './util';

/** Who proposed this, resolved from the action that carried the proposal. */
interface Proposer {
  readonly companyId: string | null;
  readonly characterId: string | null;
  readonly company: Company | undefined;
}

/**
 * Find the company behind a proposal. The proposal itself carries no company id,
 * so it is matched to the `propose_innovation` action queued for this quarter
 * that carries the same title.
 */
function resolveProposer(draft: SessionState, ctx: ResolverContext, proposal: InnovationProposal): Proposer {
  for (const action of draft.pendingActions) {
    if (action.quarter !== ctx.quarter || action.intent.type !== 'propose_innovation') continue;
    if (action.intent.proposal.title !== proposal.title) continue;
    return {
      companyId: action.actorCompanyId,
      characterId: action.actorCharacterId,
      company: findCompany(draft, action.actorCompanyId),
    };
  }
  return { companyId: null, characterId: null, company: undefined };
}

/** Capital a company could plausibly reach for a programme: cash plus a year of revenue. */
export function reachableCapitalUsd(company: Company | undefined): number {
  if (company === undefined) return 0;
  return company.financials.cash + company.financials.revenueQuarterly * INNOVATION_REVENUE_REACH_QUARTERS;
}

/**
 * The engine's own view of how plausible a proposal is, before the proposer's
 * claim is blended in. Built from what the idea rests on, how far it sits from
 * the current frontier, and whether the company proposing it has any of the
 * capabilities it names.
 */
export function assessPlausibility(
  draft: SessionState,
  proposal: InnovationProposal,
  knownDependencies: readonly TechNode[],
  company: Company | undefined,
): number {
  // An idea resting on established ground is more credible than one resting on
  // nothing at all.
  const support =
    knownDependencies.length === 0
      ? 0.35
      : unit(
          knownDependencies.reduce((sum, node) => sum + 0.5 * node.plausibility + 0.5 * node.publicConfidence, 0) /
            knownDependencies.length,
        );
  const coverage = company === undefined ? 0.2 : capabilityCoverage(company, proposal.requiredCapabilities);
  const noveltyPenalty = proposal.novelty * 0.35;
  const frontier = draft.world.aiFrontier.frontierCapability;
  return unit(0.2 + 0.35 * support + 0.25 * coverage + 0.2 * frontier - noveltyPenalty);
}

/** The engine's own cost estimate, which may be far above what the proposer claimed. */
export function assessCostUsd(proposal: InnovationProposal): number {
  const floor = INNOVATION_COST_FLOOR_USD * (1 + INNOVATION_NOVELTY_COST_MULTIPLE * proposal.novelty) * (2 - proposal.plausibility);
  // A product-backed thesis must cost at least the catalogue's low research
  // estimate. Keep this in the shared estimator so the review card cannot
  // promise a cheaper programme than integration will accept.
  const blueprint = proposal.productBlueprint;
  const productFloor = blueprint === undefined
    ? 0
    : 'recipe' in blueprint
      ? Math.max(50_000, blueprint.recipe.inputNodeIds.reduce((total, id, index) => total + (ECONOMIC_NODES_BY_ID[id]?.basePriceUsd ?? 0) * blueprint.recipe.inputQuantities[index]!, 0) * 4) / INNOVATION_COST_RANGE.low
      : (economicNodeById(productBlueprintNodeId(blueprint)!)?.researchCostRangeUsd[0] ?? 0) / INNOVATION_COST_RANGE.low;
  return money(Math.max(proposal.estimatedCost, floor, productFloor));
}

/**
 * Turn the deliberately small, declarative recipe accepted from an innovation
 * proposal into a real world-3 node.  This is engine code, not model output:
 * prices, tier, capacity and market are fixed functions of the selected
 * catalogue inputs.  Keeping it here also means the immutable catalogue is
 * never extended or cached globally.
 */
function materialiseRecipe(draft: SessionState, recipe: ProductRecipe, techId: string, ctx: ResolverContext): EconomicNode | null {
  // Recipes may compose only public catalogue inputs.  A session-local recipe
  // is private canonical state and must never become an upstream dependency.
  const inputs = recipe.inputNodeIds.map((id) => ECONOMIC_NODES_BY_ID[id]);
  if (inputs.some((node) => node === undefined) || new Set(recipe.inputNodeIds).size !== recipe.inputNodeIds.length) return null;
  const inputNodes = inputs as EconomicNode[];
  // Recipes are terminal apps/services.  Requiring a lower-tier input keeps
  // the roll-up acyclic even when a session has several invented products.
  if (inputNodes.some((node) => node.tier >= 6)) return null;
  const id = `app_custom_${slugify(techId).replace(/^tech_/, '').slice(0, 72)}`;
  if (ECONOMIC_NODES_BY_ID[id] !== undefined || draft.customEconomicNodes?.some((node) => node.id === id)) return null;
  const inputCost = inputNodes.reduce((sum, node, index) => sum + node.basePriceUsd * recipe.inputQuantities[index]!, 0);
  const recurring = recipe.saleKind === 'recurring';
  const contract = recipe.saleKind === 'contract';
  const sector = recipe.sector;
  return {
    id, label: recipe.label, blurb: `A researched ${recipe.label.toLowerCase()} product.`, sector,
    tier: 6, role: 'app', maturity: 'frontier',
    unitLabel: recipe.unitLabel, saleKind: recipe.saleKind,
    lifetimeQuarters: recipe.saleKind === 'unit' ? 12 : null,
    contractQuarters: contract ? 4 : null,
    basePriceUsd: money(Math.max(1, inputCost * (recurring ? 1.8 : contract ? 1.5 : 1.3) + 25)),
    requires: [],
    slots: inputNodes.map((node, index) => ({ id: `input_${index + 1}`, role: node.role, label: node.label.slice(0, 24), qtyPerUnit: recipe.inputQuantities[index]!, required: true, blocking: false, accepts: [node.id], defaultNodeId: node.id, kind: 'input' as const })),
    capacityKind: recurring ? 'compute' : 'plant', capacityDrawPerUnit: recurring ? 0.000002 : 0.00001,
    // One sold unit is a customer-quarter/physical unit, not a whole FTE.
    // Keep operating labour in the same units as the catalogue so a viable
    // recipe cannot acquire thousands of dollars of labour per seat.
    labourPerUnit: 0.00002 + inputNodes.length * 0.000005, energyMwhPerUnit: 0,
    supportCostShare: 0.08,
    researchCostRangeUsd: [money(Math.max(50_000, inputCost * 4)), money(Math.max(100_000, inputCost * 8))],
    researchComputeIntensity: recurring ? 0.35 : 0.15, talentAreas: ['reasoning'], dataRequiredPb: 0,
    novelty: 0.5, plausibility: 0.65, researchable: true,
    publicConfidence: 0.15, confidenceByCompany: {}, estimatedWindow: [quarterToYear(draft.startYear, ctx.quarter), quarterToYear(draft.startYear, ctx.quarter) + 2],
    originalProposerId: null, visibility: 'company_private', pioneer: null, createdQuarter: ctx.quarter,
    market: { customers: { [recipe.customerSegment]: 1 }, industries: { [sector]: 1 } },
    endDemandBaseUnits: recurring ? 5_000 : 1_000, elasticity: recurring ? 1.1 : 0.8,
    churnBand: { min: 0.03, max: 0.1 }, dataYieldPerUnitQuarter: recurring ? 0.0001 : 0, dataSensitivity: 0.25,
  };
}

/** Map a proposal's stated capabilities onto recognised capability areas where possible. */
function normaliseCapabilities(requested: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of requested) {
    const slug = slugify(raw);
    if (isCapabilityArea(slug)) {
      if (!out.includes(slug)) out.push(slug);
      continue;
    }
    // Unrecognised areas are kept verbatim: the Frontier Map is allowed to
    // contain requirements the seed vocabulary never anticipated.
    if (!out.includes(slug) && slug.length > 0) out.push(slug);
  }
  return out;
}

/**
 * Check a player innovation proposal against the session's resources and
 * technology, and add it to the graph when it is remotely consistent.
 */
export function integrateInnovationProposal(
  draft: SessionState,
  proposal: InnovationProposal,
  ctx: ResolverContext,
): InnovationIntegrationResult {
  if (proposal.experiment || proposal.experimentReview) return integrateExperiment(draft, proposal, ctx);
  return integrateTechnology(draft, proposal, ctx, resolveProposer(draft, ctx, proposal));
}

/** An experiment may discover several unfunded hypotheses. Ownership comes
 * from its validated parent project, never from model-supplied company ids. */
export function integrateDiscoveredInnovation(draft: SessionState, proposal: InnovationProposal, ctx: ResolverContext, company: Company, characterId: string | null): InnovationIntegrationResult {
  return integrateTechnology(draft, proposal, ctx, { company, companyId: company.id, characterId }, true);
}

function integrateTechnology(draft: SessionState, proposal: InnovationProposal, ctx: ResolverContext, proposer: Proposer, unfundedDiscovery = false): InnovationIntegrationResult {
  const reasons: string[] = [];
  const company = proposer.company;

  const blueprint = isNodeEconomyWorld(draft) ? proposal.productBlueprint : undefined;
  const productNode = blueprint === undefined || productBlueprintNodeId(blueprint) === undefined ? undefined : economicNodeInSession(draft, productBlueprintNodeId(blueprint)!);
  const knownDependencies: TechNode[] = [];
  const unknownDependencies: string[] = [];
  for (const depId of [...proposal.dependencies, ...(productNode?.requires ?? [])]) {
    const node = draft.techGraph.nodes.find((n) => n.id === depId);
    if (node === undefined) unknownDependencies.push(depId);
    else if (!knownDependencies.some((k) => k.id === node.id)) knownDependencies.push(node);
  }

  const adjustedPlausibility = unit(
    CLAIMED_PLAUSIBILITY_WEIGHT * proposal.plausibility +
      (1 - CLAIMED_PLAUSIBILITY_WEIGHT) * assessPlausibility(draft, proposal, knownDependencies, company),
  );
  const adjustedCost = assessCostUsd(proposal);
  const reach = reachableCapitalUsd(company);
  const adjustedQuarters = clamp(
    Math.round(proposal.estimatedQuarters * (1 + INNOVATION_SCHEDULE_STRETCH * proposal.novelty)),
    1,
    60,
  );

  const rejected = (): InnovationIntegrationResult => {
    const eventId = emitEvent(
      draft,
      ctx,
      'action_rejected',
      proposer.companyId,
      null,
      {
        kind: 'innovation_proposal',
        title: proposal.title,
        reasons,
        adjustedPlausibility,
        adjustedCostUsd: adjustedCost,
        adjustedQuarters,
      },
      'company',
    );
    ctx.log({
      phase: 'research_resolution',
      text: `The proposal "${proposal.title}" was not added to the Frontier Map: ${reasons[0] ?? 'it is not consistent with what this world knows.'}`,
      deltaLabel: 'rejected',
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: proposer.companyId,
    });
    return { accepted: false, nodeId: null, reasons, adjustedPlausibility, adjustedCostUsd: adjustedCost, adjustedQuarters };
  };

  /* --- eligibility -------------------------------------------------------- */
  if (!draft.config.allowPlayerInnovation) {
    reasons.push('This session does not allow players to propose new technologies.');
    return rejected();
  }

  if (blueprint !== undefined && 'nodeId' in blueprint && (productNode === undefined || !productNode.researchable)) {
    reasons.push('Choose a researchable product from the commercialization catalogue; raw resources must be acquired.');
    return rejected();
  }

  const titleSlug = slugify(proposal.title);
  const duplicate = draft.techGraph.nodes.find((n) => slugify(n.title) === titleSlug);
  if (duplicate !== undefined) {
    reasons.push(`The Frontier Map already carries "${duplicate.title}"; propose work against that node instead.`);
    return rejected();
  }

  if (proposal.dependencies.length > 0 && knownDependencies.length === 0) {
    reasons.push('None of the technologies this builds on exist on this session\'s Frontier Map.');
    return rejected();
  }
  if (unknownDependencies.length > 0) {
    reasons.push(`${unknownDependencies.length} unrecognised dependenc${unknownDependencies.length === 1 ? 'y was' : 'ies were'} dropped.`);
  }

  if (adjustedPlausibility < MIN_ACCEPTABLE_PLAUSIBILITY) {
    reasons.push('The mechanism is not coherent with what is currently known about physics, economics and the frontier.');
    return rejected();
  }

  if (!unfundedDiscovery && company !== undefined && adjustedCost > reach * INNOVATION_AFFORDABILITY_MULTIPLE) {
    reasons.push(
      `The engine costs this programme at ${usdLabel(adjustedCost)}, more than ${INNOVATION_AFFORDABILITY_MULTIPLE} times everything ${company.name} could reach.`,
    );
    return rejected();
  }

  /* --- accepted ----------------------------------------------------------- */
  if (adjustedCost > proposal.estimatedCost * 1.25) {
    reasons.push(`The engine costs this at ${usdLabel(adjustedCost)} against the ${usdLabel(proposal.estimatedCost)} proposed.`);
  }
  if (adjustedQuarters > proposal.estimatedQuarters) {
    reasons.push(`Expected duration stretched to ${adjustedQuarters} quarters for a programme this novel.`);
  }
  if (adjustedPlausibility < proposal.plausibility - 0.1) {
    reasons.push('Engine-assessed plausibility is materially below the claim; this will be an expensive thesis to prove.');
  }
  reasons.push(`Accepted as a company thesis${company === undefined ? '' : ` held by ${company.name}`}.`);

  let nodeId = makeId('tech', titleSlug);
  if (draft.techGraph.nodes.some((n) => n.id === nodeId)) nodeId = makeId('tech', titleSlug, ctx.quarter);

  const year = quarterToYear(draft.startYear, ctx.quarter);
  // A recipe is a request for a session-local economic node.  Validate and
  // append it before the tech node is written, so its id can become the
  // blueprint and then be granted only when this programme succeeds.
  const recipeNode = blueprint !== undefined && 'recipe' in blueprint ? materialiseRecipe(draft, blueprint.recipe, nodeId, ctx) : undefined;
  if (recipeNode !== undefined && recipeNode !== null && (draft.customEconomicNodes?.length ?? 0) >= 120) {
    reasons.push('This session has reached its limit of 120 custom economic recipes.');
    return rejected();
  }
  if (blueprint !== undefined && 'recipe' in blueprint && recipeNode === null) {
    reasons.push('The recipe must use distinct, existing lower-tier catalogue inputs and may not collide with an existing product id.');
    return rejected();
  }
  const resolvedBlueprint = recipeNode === undefined || recipeNode === null ? blueprint : { nodeId: recipeNode.id, customerValue: blueprint!.customerValue };
  const arrival = year + Math.ceil(adjustedQuarters / 4);
  const isPublic = proposal.initialVisibility === 'public';
  const publicConfidence = isPublic
    ? unit(
        INNOVATION_PUBLIC_CONFIDENCE.base +
          INNOVATION_PUBLIC_CONFIDENCE.plausibilityWeight * adjustedPlausibility * (1 - INNOVATION_PUBLIC_CONFIDENCE.noveltyPenalty * proposal.novelty),
      )
    : INNOVATION_PRIVATE_PUBLIC_CONFIDENCE;

  const confidenceByCompany: Record<string, number> = {};
  if (proposer.companyId !== null) {
    confidenceByCompany[proposer.companyId] = unit(
      INNOVATION_INTERNAL_CONFIDENCE.base + INNOVATION_INTERNAL_CONFIDENCE.plausibilityWeight * proposal.plausibility,
    );
  }

  const computeIntensity = unit(0.25 + 0.5 * proposal.novelty + 0.25 * ratio(adjustedCost, Math.max(1, adjustedCost + INNOVATION_COST_FLOOR_USD)));

  const node: TechNode = {
    id: nodeId,
    title: proposal.title,
    summary: proposal.summary,
    // An invented node joins its proposer's track; with no proposing company it
    // lands on the default one.
    sector: (recipeNode === null ? undefined : recipeNode?.sector) ?? productNode?.sector ?? company?.sector ?? DEFAULT_SECTOR,
    ...(resolvedBlueprint === undefined ? {} : { productBlueprint: resolvedBlueprint }),
    status: 'company_thesis',
    publicConfidence,
    confidenceByCompany,
    estimatedWindow: [clamp(arrival, 1900, 2200), clamp(arrival + 2 + Math.round(proposal.novelty * 3), 1900, 2200)],
    researchCostRange: [money(adjustedCost * INNOVATION_COST_RANGE.low), money(adjustedCost * INNOVATION_COST_RANGE.high)],
    computeIntensity: Math.max(computeIntensity, productNode?.researchComputeIntensity ?? 0),
    talentRequirements: normaliseCapabilities(proposal.requiredCapabilities),
    dependencies: knownDependencies.map((n) => n.id),
    possibleUnlocks: [],
    originalProposerId: proposer.characterId,
    visibility: isPublic ? 'public' : 'company_private',
    achievedByCompanyId: null,
    achievedQuarter: null,
    createdQuarter: ctx.quarter,
    novelty: proposal.novelty,
    plausibility: adjustedPlausibility,
  };

  if (recipeNode !== undefined && recipeNode !== null) {
    draft.customEconomicNodes ??= [];
    draft.customEconomicNodes.push(recipeNode);
  }

  draft.techGraph.nodes.push(node);
  const edges: TechEdge[] = knownDependencies.map((dep) => ({
    from: dep.id,
    to: node.id,
    kind: 'depends' as const,
    strength: INNOVATION_DEPENDENCY_EDGE_STRENGTH,
  }));
  draft.techGraph.edges.push(...edges);
  bumpGraphVersion(draft, ctx);

  const eventId = emitEvent(
    draft,
    ctx,
    'tech_node_added',
    proposer.companyId,
    node.id,
    {
      nodeId: node.id,
      title: node.title,
      status: node.status,
      visibility: node.visibility,
      originalProposerId: node.originalProposerId,
      dependencies: node.dependencies,
      adjustedPlausibility,
      adjustedCostUsd: adjustedCost,
      adjustedQuarters,
      graphVersion: draft.techGraph.version,
    },
    isPublic ? 'public' : 'company',
  );
  ctx.log({
    phase: 'research_resolution',
    text: `"${node.title}" joined the Frontier Map as a ${isPublic ? 'public' : 'private'} company thesis at ${(adjustedPlausibility * 100).toFixed(0)}% plausibility and ${usdLabel(adjustedCost)} estimated cost.`,
    deltaLabel: `v${draft.techGraph.version}`,
    refEventIds: [eventId],
    tone: 'positive',
    subjectId: proposer.companyId,
  });

  return { accepted: true, nodeId: node.id, reasons, adjustedPlausibility, adjustedCostUsd: adjustedCost, adjustedQuarters };
}

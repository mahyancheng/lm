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
  return money(Math.max(proposal.estimatedCost, floor));
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
  const reasons: string[] = [];
  const proposer = resolveProposer(draft, ctx, proposal);
  const company = proposer.company;

  const knownDependencies: TechNode[] = [];
  const unknownDependencies: string[] = [];
  for (const depId of proposal.dependencies) {
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

  if (company !== undefined && adjustedCost > reach * INNOVATION_AFFORDABILITY_MULTIPLE) {
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
    sector: company?.sector ?? DEFAULT_SECTOR,
    status: 'company_thesis',
    publicConfidence,
    confidenceByCompany,
    estimatedWindow: [clamp(arrival, 1900, 2200), clamp(arrival + 2 + Math.round(proposal.novelty * 3), 1900, 2200)],
    researchCostRange: [money(adjustedCost * INNOVATION_COST_RANGE.low), money(adjustedCost * INNOVATION_COST_RANGE.high)],
    computeIntensity,
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

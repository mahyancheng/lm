/**
 * @frontier/simulation — resolver/routing.ts
 *
 * Turning accepted actions into the state rows the subsystems resolve.
 *
 * A subsystem interface method exists for everything that *happens* to a row —
 * scoring a bid, tallying a proposal, advancing a programme. Nothing in the
 * interfaces creates the row in the first place, so the resolver does it, in the
 * phase that owns the row, immediately before the subsystem runs.
 *
 * Every function here is **idempotent**: it dedupes on a deterministic id and on
 * the natural key, and does nothing when the row already exists. That matters
 * for two reasons. A quarter that is retried after an invariant failure must not
 * end up with two copies of the same bid; and a subsystem that decides to create
 * its own rows from `pendingActions` must not collide with these. Deterministic
 * ids make both cases safe.
 */

import type {
  BoardProposal,
  Company,
  DealProposal,
  NodeLicence,
  ResearchProject,
  ResolverContext,
  SessionState,
  SocialPost,
  StoredGovernmentBid,
  SubmittedAction,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, economicNodeById, makeId } from '@frontier/contracts';
import { labelFor, pendingOfType } from './actions';
import { plannedProgrammeQuarters } from '../research/forecast';
import { abandonProject } from '../research/ownership';
import { emitPartialFill } from '../companies/partialFill';
import {
  LICENCE_TERM_QUARTERS,
  boundedRoyaltyPct,
  dropLapsedLicences,
  grantLicence,
  licenceUpfrontUsd,
  nodeLicenceOf,
  npcLicenceVerdict,
  ownsNodeOutright,
} from '../graph/licensing';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { computeCommitted, researchComputeHeadroom, researchersCommitted } from '../validator/context';

/* -------------------------------------------------------------------------- */
/*  Board proposals                                                            */
/* -------------------------------------------------------------------------- */

/** Table every `submit_board_proposal` that is not already on the agenda. */
export function ensureBoardProposals(draft: SessionState, ctx: ResolverContext): BoardProposal[] {
  const created: BoardProposal[] = [];

  for (const { action, intent } of pendingOfType(draft, 'submit_board_proposal')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    if (company === undefined || company.boardId === null) continue;
    const board = draft.boards.find((candidate) => candidate.id === company.boardId);
    if (board === undefined) continue;

    const id = makeId('prp', action.actorCompanyId, draft.quarter, intent.kind, String(action.sequence));
    const already = draft.boardProposals.some(
      (proposal) =>
        proposal.id === id ||
        proposal.linkedActionId === action.actionId ||
        (proposal.companyId === company.id &&
          proposal.kind === intent.kind &&
          proposal.title === intent.title &&
          proposal.quarterProposed === draft.quarter),
    );
    if (already) continue;

    const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
    const proposal: BoardProposal = {
      id,
      companyId: company.id,
      boardId: board.id,
      kind: intent.kind,
      title: intent.title,
      summary: intent.summary,
      proposedByCharacterId: action.actorCharacterId,
      quarterProposed: draft.quarter,
      decisionQuarter: draft.quarter,
      status: 'tabled',
      amountUsd: intent.amountUsd,
      dilutionPct: null,
      stockComponentPct: intent.stockComponentPct,
      targetCompanyId: intent.targetCompanyId,
      linkedActionId: action.actionId,
      requiredThresholdFraction: rule.supermajorityKinds.includes(intent.kind)
        ? rule.supermajorityThresholdFraction
        : rule.passThresholdFraction,
    };
    draft.boardProposals.push(proposal);
    created.push(proposal);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'board_proposal_submitted',
      actorId: action.actorCharacterId,
      targetId: proposal.id,
      payload: {
        companyId: company.id,
        kind: proposal.kind,
        title: proposal.title,
        amountUsd: proposal.amountUsd,
        requiredThresholdFraction: proposal.requiredThresholdFraction,
      },
      visibility: 'company',
    });
    ctx.log({
      phase: 'board_resolution',
      text: `${company.name} tabled "${proposal.title}" for the board, needing ${Math.round(proposal.requiredThresholdFraction * 100)}% of votes cast.`,
      deltaLabel: proposal.amountUsd === null ? null : compactUsd(proposal.amountUsd),
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }

  return created;
}

/* -------------------------------------------------------------------------- */
/*  Research programmes                                                        */
/* -------------------------------------------------------------------------- */

/** Open every `start_research_project` that is not already running. */
export function ensureResearchProjects(draft: SessionState, ctx: ResolverContext): ResearchProject[] {
  const created: ResearchProject[] = [];

  for (const { action, intent } of pendingOfType(draft, 'start_research_project')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    const node = draft.techGraph.nodes.find((candidate) => candidate.id === intent.targetNodeId);
    if (company === undefined || node === undefined) continue;

    const id = makeId('rsp', company.id, node.id);
    const already = draft.researchProjects.some(
      (project) =>
        project.id === id ||
        (project.companyId === company.id && project.targetNodeId === node.id && (project.status === 'active' || project.status === 'paused')),
    );
    if (already) continue;

    // World 1: the validator already clamped these to what was free, against a
    // snapshot the whole batch shared, and resolution has never re-checked
    // them — re-checking now would move the frozen world's hash.
    //
    // World 2: the validator no longer clamps the ask — it notes the same
    // expectation instead — so a programme opens with whatever researchers and
    // compute are actually free once earlier actions in this resolution have
    // already been booked, and the rest is reported as a `partial_fill`.
    let talentAllocated = intent.researchersAssigned;
    let computeAllocated = intent.computeUnits;
    if (isMultiSectorWorld(draft)) {
      const freeResearchers = Math.max(0, company.employees.researchers - researchersCommitted(draft, company.id));
      const freeCompute = Math.max(0, Math.floor(researchComputeHeadroom(draft, company)) - computeCommitted(draft, company.id));
      talentAllocated = Math.min(talentAllocated, freeResearchers);
      computeAllocated = Math.min(computeAllocated, freeCompute);
      if (talentAllocated < intent.researchersAssigned || computeAllocated < intent.computeUnits) {
        emitPartialFill(draft, ctx, company.id, {
          actionType: 'start_research_project',
          asked: Math.max(intent.researchersAssigned, intent.computeUnits),
          got: Math.max(talentAllocated, computeAllocated),
          unit: talentAllocated < intent.researchersAssigned ? 'researchers' : 'accelerators',
          reason:
            talentAllocated < intent.researchersAssigned
              ? `${talentAllocated} of ${intent.researchersAssigned} researchers were free; the rest are on other programmes.`
              : `${computeAllocated} of ${intent.computeUnits} accelerator-equivalents were free; the rest are committed elsewhere.`,
          phase: 'research_resolution',
          targetId: node.id,
        });
      }
    }

    // One definition of the schedule, shared with the Frontier Map's forecast:
    // a preview cannot promise a different number of quarters from the
    // programme it opens.
    const expectedQuarters = plannedProgrammeQuarters(node, intent.budgetUsd);

    const project: ResearchProject = {
      id,
      companyId: company.id,
      targetNodeId: node.id,
      budgetQuarterly: intent.budgetUsd,
      computeAllocated,
      talentAllocated,
      progress: 0,
      internalConfidence: node.confidenceByCompany[company.id] ?? node.publicConfidence,
      quartersElapsed: 0,
      expectedQuarters,
      isSecret: intent.secret,
      status: 'active',
      cumulativeSpendUsd: 0,
      setbacks: 0,
      startedQuarter: draft.quarter,
    };
    draft.researchProjects.push(project);
    created.push(project);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'research_progress',
      actorId: company.id,
      targetId: node.id,
      payload: {
        projectId: project.id,
        started: true,
        budgetQuarterly: project.budgetQuarterly,
        computeAllocated: project.computeAllocated,
        talentAllocated: project.talentAllocated,
        expectedQuarters,
        secret: project.isSecret,
      },
      // A secret programme is a private fact. It does not reach the report.
      visibility: project.isSecret ? 'private' : 'company',
    });

    if (!project.isSecret) {
      ctx.log({
        phase: 'research_resolution',
        text: `${company.name} opened a programme against ${node.title} with ${project.talentAllocated} researchers and ${project.computeAllocated} accelerators.`,
        deltaLabel: `${expectedQuarters}q est.`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }

  return created;
}

/**
 * Apply every `adjust_research_project` to the programme it names.
 *
 * A running programme's allocation was previously unchangeable: a founder told
 * "short of compute: 300 of 600 units" had no instruction that could answer it,
 * short of abandoning the programme. This is that instruction. It runs before
 * `advanceProjects`, so the quarter the change is made is already resourced the
 * new way — which is what a player who fixes a shortfall expects.
 *
 * Secrecy is not touched here: it is set when the programme opens and changing
 * it would move a private fact into public view without a publication.
 */
/**
 * Apply every `abandon_research_project` to the programme it names.
 *
 * Runs before `advanceProjects`, so a programme closed this quarter costs
 * nothing this quarter: that is the whole point of the instruction. The
 * consequences — releasing the researchers and the compute, stopping the
 * budget, and the investor reputation it costs — live in `research/ownership.ts`
 * beside the pause it is the answer to.
 */
export function applyResearchAbandonments(draft: SessionState, ctx: ResolverContext): number {
  let closed = 0;
  for (const { action, intent } of pendingOfType(draft, 'abandon_research_project')) {
    if (action.actorCompanyId === null) continue;
    if (abandonProject(draft, ctx, action.actorCompanyId, intent.projectId)) closed += 1;
  }
  return closed;
}

/**
 * Apply every `set_data_policy` to the company that submitted it.
 *
 * Nothing else happens here: the yield, the churn, the reputation and the
 * regulatory exposure are all read off the stored level by the passes that own
 * those numbers, so the policy is a single field and never a second copy of the
 * arithmetic.
 */
export function applyDataPolicies(draft: SessionState, ctx: ResolverContext): number {
  let changed = 0;
  for (const { action, intent } of pendingOfType(draft, 'set_data_policy')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    if (company === undefined) continue;
    const before = company.dataPolicy ?? 'standard';
    if (before === intent.collectionLevel) continue;
    company.dataPolicy = intent.collectionLevel;
    changed += 1;
    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'data_resolved',
      actorId: company.id,
      targetId: company.id,
      payload: { collectionLevel: intent.collectionLevel, previousLevel: before, policyChanged: true },
      visibility: 'company',
    });
    ctx.log({
      phase: 'research_resolution',
      text: `${company.name} moved to ${intent.collectionLevel} data collection from ${before}.`,
      deltaLabel: intent.collectionLevel,
      refEventIds: [eventId],
      tone: intent.collectionLevel === 'aggressive' ? 'warning' : 'positive',
      subjectId: company.id,
    });
  }
  return changed;
}

export function applyResearchAdjustments(draft: SessionState, ctx: ResolverContext): ResearchProject[] {
  const changed: ResearchProject[] = [];

  for (const { action, intent } of pendingOfType(draft, 'adjust_research_project')) {
    const project = draft.researchProjects.find((candidate) => candidate.id === intent.projectId);
    if (project === undefined || project.companyId !== action.actorCompanyId) continue;
    if (project.status !== 'active' && project.status !== 'paused') continue;

    const node = draft.techGraph.nodes.find((candidate) => candidate.id === project.targetNodeId);
    const company = draft.companies.find((candidate) => candidate.id === project.companyId);
    const before = {
      budgetQuarterly: project.budgetQuarterly,
      computeAllocated: project.computeAllocated,
      talentAllocated: project.talentAllocated,
    };

    // World 1: the validator already clamped these against a batch-wide
    // snapshot, and re-checking now would move the frozen world's hash.
    //
    // World 2: not clamped at the validator, so the programme hands back what
    // it already holds, is re-resourced with whatever is actually free, and
    // reports the rest as a `partial_fill` — the same "hand back before
    // counting free" rule the validator has always used for this action.
    let wantedTalent = Math.max(0, Math.round(intent.researchersAssigned));
    let wantedCompute = Math.max(0, Math.round(intent.computeUnits));
    if (isMultiSectorWorld(draft) && company !== undefined) {
      const freeResearchers = Math.max(0, company.employees.researchers - researchersCommitted(draft, company.id) + before.talentAllocated);
      const freeCompute = Math.max(0, Math.floor(researchComputeHeadroom(draft, company)) - computeCommitted(draft, company.id) + before.computeAllocated);
      const cappedTalent = Math.min(wantedTalent, freeResearchers);
      const cappedCompute = Math.min(wantedCompute, freeCompute);
      if (cappedTalent < wantedTalent || cappedCompute < wantedCompute) {
        emitPartialFill(draft, ctx, company.id, {
          actionType: 'adjust_research_project',
          asked: Math.max(wantedTalent, wantedCompute),
          got: Math.max(cappedTalent, cappedCompute),
          unit: cappedTalent < wantedTalent ? 'researchers' : 'accelerators',
          reason:
            cappedTalent < wantedTalent
              ? `${cappedTalent} of ${wantedTalent} researchers were free; the rest are on other programmes.`
              : `${cappedCompute} of ${wantedCompute} accelerator-equivalents were free; the rest are committed elsewhere.`,
          phase: 'research_resolution',
          targetId: project.targetNodeId,
        });
      }
      wantedTalent = cappedTalent;
      wantedCompute = cappedCompute;
    }

    project.budgetQuarterly = Math.max(0, intent.budgetUsd);
    project.computeAllocated = wantedCompute;
    project.talentAllocated = wantedTalent;
    if (
      project.budgetQuarterly === before.budgetQuarterly &&
      project.computeAllocated === before.computeAllocated &&
      project.talentAllocated === before.talentAllocated
    ) {
      continue;
    }
    changed.push(project);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'research_progress',
      actorId: project.companyId,
      targetId: project.targetNodeId,
      payload: {
        projectId: project.id,
        reallocated: true,
        budgetBeforeUsd: before.budgetQuarterly,
        budgetQuarterly: project.budgetQuarterly,
        computeBefore: before.computeAllocated,
        computeAllocated: project.computeAllocated,
        researchersBefore: before.talentAllocated,
        talentAllocated: project.talentAllocated,
        secret: project.isSecret,
      },
      // A secret programme's resourcing is a private fact, exactly as its
      // progress is.
      visibility: project.isSecret ? 'private' : 'company',
    });

    if (!project.isSecret) {
      const title = node?.title ?? project.targetNodeId;
      const peopleDelta = project.talentAllocated - before.talentAllocated;
      const computeDelta = project.computeAllocated - before.computeAllocated;
      const parts: string[] = [];
      if (peopleDelta !== 0) parts.push(`${peopleDelta > 0 ? 'added' : 'took off'} ${Math.abs(peopleDelta)} researcher${Math.abs(peopleDelta) === 1 ? '' : 's'}`);
      if (computeDelta !== 0) parts.push(`${computeDelta > 0 ? 'added' : 'freed'} ${Math.abs(computeDelta)} accelerators`);
      ctx.log({
        phase: 'research_resolution',
        text: `${company?.name ?? project.companyId} re-resourced the programme against ${title}: ${parts.length === 0 ? 'a change of budget' : parts.join(' and ')}.`,
        deltaLabel: `${project.talentAllocated} researchers`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: project.companyId,
      });
    }
  }

  return changed;
}

/* -------------------------------------------------------------------------- */
/*  Government bids                                                            */
/* -------------------------------------------------------------------------- */

/** Record every `bid_government` that has not already been lodged. */
export function ensureGovernmentBids(draft: SessionState, ctx: ResolverContext): StoredGovernmentBid[] {
  const created: StoredGovernmentBid[] = [];

  for (const { action, intent } of pendingOfType(draft, 'bid_government')) {
    const opportunity = draft.procurementOpportunities.find((candidate) => candidate.id === intent.opportunityId);
    if (opportunity === undefined) continue;

    const id = makeId('bid', action.actorCompanyId, opportunity.id);
    const already = draft.governmentBids.some(
      (bid) => bid.id === id || (bid.bidderCompanyId === action.actorCompanyId && bid.opportunityId === opportunity.id && bid.status !== 'withdrawn'),
    );
    if (already) continue;

    const stored: StoredGovernmentBid = {
      ...intent.bid,
      id,
      bidderCompanyId: action.actorCompanyId,
      submittedQuarter: draft.quarter,
      status: 'submitted',
      disqualificationReason: null,
    };
    draft.governmentBids.push(stored);
    created.push(stored);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'bid_submitted',
      actorId: action.actorCompanyId,
      targetId: opportunity.id,
      payload: {
        bidId: stored.id,
        price: stored.price,
        deliveryQuarters: stored.timeline.deliveryQuarters,
        computeUnits: stored.computeCommitment.acceleratorUnits,
        consortium: stored.consortiumMemberIds,
      },
      // A bid is commercially confidential until the award is announced.
      visibility: 'company',
    });
    ctx.log({
      phase: 'government_resolution',
      text: `${labelFor(intent)} was lodged at ${compactUsd(stored.price)} against a ceiling of ${compactUsd(opportunity.maxValue)}.`,
      deltaLabel: compactUsd(stored.price),
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: action.actorCompanyId,
    });
  }

  return created;
}

/* -------------------------------------------------------------------------- */
/*  Social posts                                                               */
/* -------------------------------------------------------------------------- */

/** Publish every `social_post` that is not already in the feed. */
export function ensureSocialPosts(draft: SessionState, ctx: ResolverContext): SocialPost[] {
  const created: SocialPost[] = [];

  for (const { action, intent } of pendingOfType(draft, 'social_post')) {
    const account = draft.socialAccounts.find(
      (candidate) =>
        candidate.isActive &&
        candidate.network === intent.draft.network &&
        (candidate.ownerCharacterId === intent.draft.authorCharacterId || candidate.ownerCompanyId === action.actorCompanyId),
    );
    if (account === undefined) continue;

    const id = makeId('pst', draft.sessionId, draft.quarter, action.actorCompanyId, String(action.sequence));
    if (draft.socialPosts.some((post) => post.id === id)) continue;

    const post: SocialPost = {
      ...intent.draft,
      id,
      accountId: account.id,
      quarter: draft.quarter,
      engagement: null,
      isAiGenerated: action.actorPlayerId === null,
      reportedCount: 0,
      // Submitted posts are always top-level; the engine authors every reply.
      replyToPostId: null,
    };
    draft.socialPosts.push(post);
    created.push(post);

    ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'social_post_published',
      actorId: intent.draft.authorCharacterId,
      targetId: post.id,
      payload: {
        network: post.network,
        intent: post.intent,
        accountId: account.id,
        targetCompanyId: post.targetCompanyId,
        isAiGenerated: post.isAiGenerated,
      },
      visibility: 'public',
    });
  }

  return created;
}

/* -------------------------------------------------------------------------- */
/*  Deals                                                                      */
/* -------------------------------------------------------------------------- */

/** Record proposals, acceptances and rejections. Obligations execute later. */
export function routeDeals(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'propose_deal')) {
    const id = makeId('deal', draft.sessionId, draft.quarter, action.actorCompanyId, String(action.sequence));
    if (draft.deals.some((deal) => deal.id === id)) continue;

    const proposal: DealProposal = {
      ...intent.proposal,
      id,
      proposerId: action.actorCompanyId,
      proposerKind: 'company',
      status: 'proposed',
      createdQuarter: draft.quarter,
      respondedQuarter: null,
      conversationId: null,
      breachedByPartyId: null,
    };
    draft.deals.push(proposal);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'deal_proposed',
      actorId: action.actorCompanyId,
      targetId: proposal.counterpartyId,
      payload: {
        dealId: proposal.id,
        binding: proposal.binding,
        gives: proposal.gives.map((obligation) => obligation.kind),
        gets: proposal.gets.map((obligation) => obligation.kind),
        expiresQuarter: proposal.expiresQuarter,
      },
      visibility: proposal.confidentiality === 'public' ? 'public' : 'company',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `A ${proposal.binding ? 'binding' : 'non-binding'} deal was put to ${proposal.counterpartyId}: ${clip(proposal.summary, 160)}`,
      deltaLabel: proposal.binding ? 'binding' : 'intent',
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: action.actorCompanyId,
    });
  }

  for (const { action, intent } of pendingOfType(draft, 'accept_deal')) {
    const deal = draft.deals.find((candidate) => candidate.id === intent.dealId);
    if (deal === undefined || deal.status !== 'proposed') continue;
    deal.status = 'accepted';
    deal.respondedQuarter = draft.quarter;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'deal_accepted',
      actorId: action.actorCompanyId,
      targetId: deal.id,
      payload: { proposerId: deal.proposerId, binding: deal.binding },
      visibility: deal.confidentiality === 'public' ? 'public' : 'company',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${action.actorCompanyId} accepted the deal from ${deal.proposerId}. ${deal.binding ? 'Its obligations are now enforceable.' : 'It binds nobody.'}`,
      deltaLabel: 'accepted',
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: action.actorCompanyId,
    });
  }

  for (const { action, intent } of pendingOfType(draft, 'reject_deal')) {
    const deal = draft.deals.find((candidate) => candidate.id === intent.dealId);
    if (deal === undefined || deal.status !== 'proposed') continue;
    deal.status = 'rejected';
    deal.respondedQuarter = draft.quarter;

    ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'deal_rejected',
      actorId: action.actorCompanyId,
      targetId: deal.id,
      payload: { proposerId: deal.proposerId, reason: clip(intent.reason, 240) },
      visibility: deal.confidentiality === 'public' ? 'public' : 'company',
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Node licences (world 3)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a quarter does about licensing, in the order it has to happen:
 * lapse what has run out, publish what an owner is advertising, put every
 * request to its owner, and execute what has been agreed.
 *
 * Lapsing first is what lets a renewal agreed this quarter land on top of the
 * licence it renews rather than fighting it; executing last is what lets a
 * request an NPC owner accepted in the same breath take effect in the same
 * quarter, so a founder is never told to come back in three months to find out
 * whether they may buy something.
 *
 * A no-op below world version 3, which has no node ownership to licence.
 */
export function routeNodeLicences(draft: SessionState, ctx: ResolverContext): void {
  if (!isNodeEconomyWorld(draft)) return;
  lapseNodeLicences(draft, ctx);
  publishLicenceTerms(draft, ctx);
  proposeNodeLicences(draft, ctx);
  executeNodeLicences(draft, ctx);
}

/** The plain name of a node, for a report line. Falls back to the id. */
function nodeLabel(nodeId: string): string {
  return economicNodeById(nodeId)?.label ?? nodeId;
}

/**
 * Drop every licence whose term has ended and say so.
 *
 * The owner declining a renewal is not an event the owner has to take: it is
 * what happens by default, and that is what makes a licence a weapon. A line
 * built on a lapsed licence stops being producible the same quarter, which the
 * production phase reports on its own.
 */
function lapseNodeLicences(draft: SessionState, ctx: ResolverContext): void {
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    for (const licence of dropLapsedLicences(company, draft.quarter)) {
      const owner = draft.companies.find((candidate) => candidate.id === licence.ownerCompanyId);
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        type: 'node_licence_lapsed',
        actorId: licence.ownerCompanyId,
        targetId: company.id,
        payload: { nodeId: licence.nodeId, royaltyPct: licence.royaltyPct, expiryQuarter: licence.expiryQuarter },
        visibility: 'company',
      });
      ctx.log({
        phase: 'capital_resolution',
        text: `${company.name}'s licence on ${nodeLabel(licence.nodeId)} from ${
          owner?.name ?? licence.ownerCompanyId
        } has run out. Anything built on it stops until it is renewed, researched or bought.`,
        deltaLabel: 'lapsed',
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: company.id,
      });
    }
  }
}

/** Record what an owner is advertising. Its own state, so no consent is involved. */
function publishLicenceTerms(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'publish_licence_terms')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    if (company === undefined || !ownsNodeOutright(company, intent.nodeId)) continue;
    const royaltyPct = boundedRoyaltyPct(intent.royaltyPct);
    const offers = company.licenceOffers ?? [];
    const existing = offers.findIndex((offer) => offer.nodeId === intent.nodeId);
    const offer = { nodeId: intent.nodeId, royaltyPct, openToAll: intent.openToAll };
    if (existing >= 0) company.licenceOffers = offers.map((entry, index) => (index === existing ? offer : entry));
    else if (offers.length < 12) company.licenceOffers = [...offers, offer];
    else continue;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'node_licensed',
      actorId: company.id,
      targetId: intent.nodeId,
      payload: { published: true, nodeId: intent.nodeId, royaltyPct, openToAll: intent.openToAll },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} will licence ${nodeLabel(intent.nodeId)} at ${royaltyPct}% ${
        intent.openToAll ? 'to anybody who asks' : 'to anybody it does not compete with'
      }.`,
      deltaLabel: `${royaltyPct}%`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/**
 * Put every `license_node` request to the company that owns the node, as an
 * ordinary deal, and let an NPC owner answer it in the same quarter.
 *
 * A player-run owner answers with `accept_deal` or `reject_deal` like any other
 * proposal — the offer is on their deal room table, and it expires next quarter
 * if they ignore it.
 */
function proposeNodeLicences(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'license_node')) {
    const licensee = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    const owner = draft.companies.find((candidate) => candidate.id === intent.ownerCompanyId);
    const node = economicNodeById(intent.nodeId);
    if (licensee === undefined || owner === undefined || node === undefined) continue;
    if (!licensee.isActive || !owner.isActive || licensee.id === owner.id) continue;
    // Only an outright owner may grant: a licensee sublicensing is the one
    // thing a licence does not permit, and the validator says so too.
    if (!ownsNodeOutright(owner, node.id)) continue;

    const id = makeId('deal', draft.sessionId, draft.quarter, action.actorCompanyId, 'licence', String(action.sequence));
    if (draft.deals.some((deal) => deal.id === id)) continue;

    const royaltyPct = boundedRoyaltyPct(intent.royaltyPct);
    const upfrontUsd = licenceUpfrontUsd(node);
    // The fee is a FIELD of the licence obligation and is paid once, by the
    // executor below. A second `cash_payment` obligation naming the same
    // dollars would be a second claim on them the first time anything else
    // learns to execute one.
    const proposal: DealProposal = {
      id,
      counterpartyId: owner.id,
      counterpartyKind: 'company',
      gives: [],
      gets: [
        {
          kind: 'node_licence',
          nodeId: node.id,
          ownerCompanyId: owner.id,
          licenseeCompanyId: licensee.id,
          royaltyPct,
          quarters: LICENCE_TERM_QUARTERS,
          upfrontUsd,
        },
      ],
      confidentiality: 'private',
      expiresQuarter: draft.quarter + 1,
      binding: true,
      intentStatements: [],
      summary: `${licensee.name} asks to licence ${node.label} from ${owner.name}: ${compactUsd(
        upfrontUsd,
      )} on signature and ${royaltyPct}% of the revenue of every line that needs it, for ${LICENCE_TERM_QUARTERS} quarters.`,
      proposerId: licensee.id,
      proposerKind: 'company',
      status: 'proposed',
      createdQuarter: draft.quarter,
      respondedQuarter: null,
      conversationId: null,
      breachedByPartyId: null,
    };
    draft.deals.push(proposal);

    const proposedId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'deal_proposed',
      actorId: licensee.id,
      targetId: owner.id,
      payload: { dealId: proposal.id, binding: true, gives: [], gets: ['node_licence'], expiresQuarter: proposal.expiresQuarter },
      visibility: 'company',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: proposal.summary,
      deltaLabel: `${royaltyPct}%`,
      refEventIds: [proposedId],
      tone: 'neutral',
      subjectId: licensee.id,
    });

    // A player-run owner decides for themselves, next quarter, on the deal
    // screen. An NPC owner decides here, by a rule a founder can read.
    if (owner.controllerPlayerId !== null) continue;
    const verdict = npcLicenceVerdict(owner, licensee, node, royaltyPct);
    proposal.status = verdict.accepted ? 'accepted' : 'rejected';
    proposal.respondedQuarter = draft.quarter;
    const answerId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: verdict.accepted ? 'deal_accepted' : 'deal_rejected',
      actorId: owner.id,
      targetId: proposal.id,
      payload: { proposerId: licensee.id, binding: true, reason: clip(verdict.reason, 240) },
      visibility: 'company',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: verdict.reason,
      deltaLabel: verdict.accepted ? 'accepted' : 'refused',
      refEventIds: [answerId],
      tone: verdict.accepted ? 'positive' : 'warning',
      subjectId: licensee.id,
    });
  }
}

/**
 * Execute every accepted node licence: the fee moves, the right is written onto
 * the licensee, and the deal is marked executed so no quarter does it twice.
 *
 * The fee moves cash and equity together on both sides, exactly as a transfer
 * inside a group does, because these are two separate companies and nothing on
 * the licensee's own sheet offsets the money leaving it.
 */
function executeNodeLicences(draft: SessionState, ctx: ResolverContext): void {
  for (const deal of draft.deals) {
    if (deal.status !== 'accepted' || !deal.binding) continue;
    const terms = nodeLicenceOf(deal);
    if (terms === null) continue;

    const owner = draft.companies.find((candidate) => candidate.id === terms.ownerCompanyId);
    const licensee = draft.companies.find((candidate) => candidate.id === terms.licenseeCompanyId);
    const node = economicNodeById(terms.nodeId);
    // Executed-with-nothing-done rather than left accepted for ever: the
    // counterparty is gone or the node is not in this session's table, and
    // re-checking it every quarter would be a slow way to keep saying no.
    if (owner === undefined || licensee === undefined || node === undefined || !ownsNodeOutright(owner, node.id)) {
      deal.status = 'executed';
      continue;
    }

    const licence: NodeLicence = {
      nodeId: node.id,
      ownerCompanyId: owner.id,
      royaltyPct: terms.royaltyPct,
      expiryQuarter: draft.quarter + terms.quarters,
    };
    if (!grantLicence(licensee, licence)) {
      deal.status = 'executed';
      ctx.log({
        phase: 'capital_resolution',
        text: `${licensee.name} already licenses as much as it can carry, so ${node.label} was not added.`,
        deltaLabel: 'not granted',
        refEventIds: [],
        tone: 'warning',
        subjectId: licensee.id,
      });
      continue;
    }
    deal.status = 'executed';
    payLicenceFee(licensee, owner, terms.upfrontUsd);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'node_licensed',
      actorId: owner.id,
      targetId: licensee.id,
      payload: {
        published: false,
        dealId: deal.id,
        nodeId: node.id,
        royaltyPct: terms.royaltyPct,
        upfrontUsd: terms.upfrontUsd,
        expiryQuarter: licence.expiryQuarter,
      },
      visibility: 'company',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${licensee.name} may now make ${node.label} under ${owner.name}'s licence: ${compactUsd(terms.upfrontUsd)} paid, ${
        terms.royaltyPct
      }% of every line that needs it for the next ${terms.quarters} quarters, and no right to licence it on.`,
      deltaLabel: `-${compactUsd(terms.upfrontUsd)}`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: licensee.id,
    });
  }
}

/** Move the signing fee. Cash and equity together, on both sheets. */
function payLicenceFee(licensee: Company, owner: Company, upfrontUsd: number): void {
  const amount = Math.max(0, Math.round(upfrontUsd));
  if (amount <= 0) return;
  licensee.financials.cash -= amount;
  licensee.balanceSheet.assets.cash -= amount;
  licensee.balanceSheet.equity -= amount;
  owner.financials.cash += amount;
  owner.balanceSheet.assets.cash += amount;
  owner.balanceSheet.equity += amount;
}

/* -------------------------------------------------------------------------- */
/*  Introductions                                                              */
/* -------------------------------------------------------------------------- */

/** Trust and respect above this, on the 0..100 scale, and the favour is done. */
export const INTRODUCTION_THRESHOLD = 45;

/**
 * Decide every `request_introduction`.
 *
 * The intermediary has to be able to reach the target themselves, and has to
 * think well enough of the asker to spend standing on them. A granted
 * introduction becomes a real `AccessOverride` — the main legitimate route from
 * a low connection level to a high one.
 */
export function applyIntroductionRequests(
  draft: SessionState,
  ctx: ResolverContext,
  canReach: (from: string, to: string) => boolean,
): void {
  const rng = ctx.rng.fork('introductions');

  for (const { action, intent } of pendingOfType(draft, 'request_introduction')) {
    const asker = action.actorCharacterId;
    const via = draft.characters.find((character) => character.id === intent.viaCharacterId);
    const target = draft.characters.find((character) => character.id === intent.targetCharacterId);
    if (via === undefined || target === undefined) continue;

    const relationship = draft.relationships.find((edge) => edge.fromId === via.id && edge.toId === asker) ?? null;
    const regard = relationship === null ? 20 : relationship.trust * 0.5 + relationship.respect * 0.5 - relationship.hostility * 0.3;
    const jitter = rng.range(-8, 8);
    const willing = regard + jitter >= INTRODUCTION_THRESHOLD;
    const able = canReach(via.id, target.id);

    if (willing && able) {
      const id = makeId('ovr', draft.sessionId, draft.quarter, asker, target.id);
      if (!draft.accessOverrides.some((override) => override.id === id)) {
        draft.accessOverrides.push({
          id,
          kind: 'introduction',
          fromId: asker,
          toId: target.id,
          grantedQuarter: draft.quarter,
          expiresQuarter: draft.quarter + 4,
          isPermanent: false,
          grantedByCharacterId: via.id,
          reason: `${via.name} introduced them: ${clip(intent.purpose, 180)}`,
        });
      }
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        type: 'introduction_granted',
        actorId: via.id,
        targetId: target.id,
        payload: { requesterId: asker, overrideId: id, regard: Math.round(regard), expiresQuarter: draft.quarter + 4 },
        visibility: 'company',
      });
      ctx.log({
        phase: 'relationship_update',
        text: `${via.name} introduced ${asker} to ${target.name}, opening a channel that would otherwise have been closed.`,
        deltaLabel: 'access granted',
        refEventIds: [eventId],
        tone: 'positive',
        subjectId: asker,
      });
      continue;
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'relationship_changed',
      actorId: via.id,
      targetId: asker,
      payload: {
        kind: 'introduction_refused',
        targetCharacterId: target.id,
        reason: able ? 'insufficient regard' : 'the intermediary cannot reach the target either',
        regard: Math.round(regard),
      },
      visibility: 'company',
    });
    ctx.log({
      phase: 'relationship_update',
      text: `${via.name} declined to introduce ${asker} to ${target.name}${able ? '.' : ', not being able to reach them either.'}`,
      deltaLabel: 'refused',
      refEventIds: [eventId],
      tone: 'negative',
      subjectId: asker,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Local formatting                                                           */
/* -------------------------------------------------------------------------- */

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${strip((abs / 1e9).toFixed(2))}bn`;
  if (abs >= 1e6) return `${sign}$${strip((abs / 1e6).toFixed(1))}m`;
  if (abs >= 1e3) return `${sign}$${strip((abs / 1e3).toFixed(0))}k`;
  return `${sign}$${Math.round(abs)}`;
}

function strip(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** `SubmittedAction` is re-exported for callers assembling routing results. */
export type { SubmittedAction };

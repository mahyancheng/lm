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
  DealProposal,
  ResearchProject,
  ResolverContext,
  SessionState,
  SocialPost,
  StoredGovernmentBid,
  SubmittedAction,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, makeId } from '@frontier/contracts';
import { labelFor, pendingOfType } from './actions';

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

    const [lowCost, highCost] = node.researchCostRange;
    const expectedCost = (lowCost + highCost) / 2;
    const quarterlyDraw = Math.max(1, intent.budgetUsd);
    const expectedQuarters = Math.max(2, Math.min(24, Math.round(expectedCost / quarterlyDraw)));

    const project: ResearchProject = {
      id,
      companyId: company.id,
      targetNodeId: node.id,
      budgetQuarterly: intent.budgetUsd,
      computeAllocated: intent.computeUnits,
      talentAllocated: intent.researchersAssigned,
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

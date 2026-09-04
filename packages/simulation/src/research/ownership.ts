/**
 * @frontier/simulation — research/ownership.ts
 *
 * What a finished programme does in world 3: it makes the company **able to
 * produce a node**, and it makes what that company already sells better.
 *
 * ## The rule this file exists to enforce
 *
 * Ownership is asked of the COMPANY, never of the world. World 2 asked whether
 * a node was globally `achieved` and exactly one of forty-two seed nodes was,
 * so on turn one nearly every technology and a dozen product lines were locked
 * for everybody — including the incumbents already selling them. Here the only
 * question ever asked is `holdsNode(company, id)`, and the answer to it is a
 * field on the company.
 *
 * ## The money pit, closed
 *
 * A programme whose `requires` are unmet at the moment it is opened is REFUSED
 * by the validator, naming what is missing. A programme whose requires become
 * unmet mid-flight — a licence lapsed — is PAUSED, which stops the money that
 * quarter because `advanceProjects` and the research budget both filter on
 * `status === 'active'`. Neither case writes `progress = 0.98` and leaves the
 * programme running for ever, which is what world 2 did.
 *
 * ## Achieving a node improves what you already sell
 *
 * Two effects, and the second needs no code at all:
 *
 * 1. Every live line whose node **is** the achieved node gains
 *    `LINE_QUALITY_OWN_GAIN` of craft, and every line whose node *requires* it
 *    gains `LINE_QUALITY_UPSTREAM_GAIN`. That is the fix for world 2's frozen
 *    `qualityScore`, set at launch and never revisited.
 * 2. Owning `cmp_hbm_stack` means you can now MAKE the memory your accelerator
 *    consumes, so the roll-up prices that input at your own cost instead of at
 *    market plus the open-market premium. The unit cost falls, visibly, in the
 *    same breakdown the player was already reading, with no bonus multiplier
 *    anywhere.
 *
 * Determinism: no RNG, no clock. Companies are walked in state order and
 * projects in project order.
 */

import type { Company, ResearchProject, ResolverContext, SessionState, TechNode } from '@frontier/contracts';
import { ECONOMIC_NODES_BY_ID, economicNodeById, holdsNode, requiresClosure } from '@frontier/contracts';
import { stateAfterFirstAchievement } from '../graph/techGraph';
import { lineNodeIdOf } from '../graph/lines';
import { UNLOCK_CONFIDENCE_GAIN } from './balance';
import { applyCapabilityGain, raiseAchievementHazard, unlockTargets } from './nodes';
import { bumpGraphVersion, emitEvent, findCompany, findNode, projectVisibility, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Craft a line gains when the node it sells is the one just achieved. */
export const LINE_QUALITY_OWN_GAIN = 0.1;

/** Craft a line gains when the node just achieved is somewhere in its own `requires` closure. */
export const LINE_QUALITY_UPSTREAM_GAIN = 0.04;

/**
 * Investor reputation lost for closing a programme.
 *
 * Two points, so quitting is a decision with a price rather than a free undo —
 * and small enough that a founder who has correctly recognised a dead end is
 * not punished into carrying it for ever.
 */
export const ABANDON_REPUTATION_COST = 2;

/* -------------------------------------------------------------------------- */
/*  Holding what a programme needs                                             */
/* -------------------------------------------------------------------------- */

/** Nodes this programme's target requires that the company does not hold. */
export function unheldRequirements(draft: SessionState, company: Company, nodeId: string): readonly string[] {
  const node = economicNodeById(nodeId);
  if (node === undefined) return [];
  return node.requires.filter((required) => !holdsNode(company, required, draft.quarter));
}

/** The plain-words name of a node, for a report line. Falls back to the id. */
function nameOf(nodeId: string): string {
  return ECONOMIC_NODES_BY_ID[nodeId]?.label ?? nodeId;
}

/**
 * Pause a programme whose requirements are no longer held, and say why.
 *
 * Called from `advanceProjects` before a quarter's progress is computed, so the
 * budget stops in the same quarter the ground under it went. Returns true when
 * the programme was paused.
 */
export function pauseIfUnheld(draft: SessionState, ctx: ResolverContext, project: ResearchProject, node: TechNode): boolean {
  const company = findCompany(draft, project.companyId);
  if (company === undefined) return false;
  const missing = unheldRequirements(draft, company, project.targetNodeId);
  if (missing.length === 0) return false;

  project.status = 'paused';
  const eventId = emitEvent(
    draft,
    ctx,
    'research_paused',
    project.companyId,
    project.targetNodeId,
    { projectId: project.id, nodeId: project.targetNodeId, missingNodeIds: [...missing], progress: project.progress },
    projectVisibility(project),
  );
  if (!project.isSecret) {
    ctx.log({
      phase: 'research_resolution',
      text: `${node.title} is paused: ${missing.map(nameOf).join(', ')} is no longer yours to build on, so the programme stops spending until it is. Resume it by owning or licensing that again, or close it.`,
      deltaLabel: 'paused',
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: project.companyId,
    });
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Achievement                                                                */
/* -------------------------------------------------------------------------- */

/** Give the company the node, keeping the list in table order and inside its schema bound. */
function grantOwnership(company: Company, nodeId: string): boolean {
  const owned = company.ownedNodes ?? [];
  if (owned.includes(nodeId)) return false;
  company.ownedNodes = [...owned, nodeId];
  return true;
}

/**
 * Raise the craft of every line this achievement makes better.
 *
 * The line that sells the node itself gains most; a line that merely depends on
 * it gains less. Returns how many lines moved, for the report line.
 */
export function improveLinesOnAchievement(company: Company, achievedNodeId: string): number {
  let improved = 0;
  for (const product of company.products) {
    if (!product.isActive) continue;
    const lineNodeId = lineNodeIdOf(product);
    if (lineNodeId === null) continue;
    const gain =
      lineNodeId === achievedNodeId
        ? LINE_QUALITY_OWN_GAIN
        : requiresClosure(lineNodeId).includes(achievedNodeId)
          ? LINE_QUALITY_UPSTREAM_GAIN
          : 0;
    if (gain <= 0) continue;
    const before = product.craftQuality ?? product.qualityScore;
    const after = unit(before + gain);
    if (after === before) continue;
    product.craftQuality = after;
    improved += 1;
  }
  return improved;
}

/**
 * Turn every finished world-3 programme into ownership of its node.
 *
 * A programme whose target is not a row of the node table — one the World
 * Director invented mid-session — still succeeds, still moves capability and
 * belief, and simply grants no ownership: there is nothing in the economy to
 * own yet.
 */
export function achieveOwnedNodes(draft: SessionState, ctx: ResolverContext): void {
  let graphChanged = false;

  for (const project of draft.researchProjects) {
    if (project.status !== 'active' || project.progress < 1) continue;
    const node = findNode(draft, project.targetNodeId);
    if (node === undefined) continue;
    const company = findCompany(draft, project.companyId);
    if (company === undefined) continue;

    // A programme that reached the line without the ground under it is paused,
    // not pinned: the work stands, the money stops, and the founder decides.
    if (pauseIfUnheld(draft, ctx, project, node)) continue;

    project.status = 'succeeded';
    project.progress = 1;
    project.internalConfidence = 1;
    node.confidenceByCompany[project.companyId] = 1;

    const granted = grantOwnership(company, project.targetNodeId);
    const improvedLines = improveLinesOnAchievement(company, project.targetNodeId);
    const gains = applyCapabilityGain(draft, project, node);
    const unlocks = unlockTargets(draft, node);
    graphChanged = true;

    // The pioneer is recorded whether or not the programme was secret: being
    // first is a fact about the session, and it gates nothing.
    const firstEver = node.achievedByCompanyId === null;
    if (firstEver) {
      node.achievedByCompanyId = project.companyId;
      node.achievedQuarter = ctx.quarter;
    }

    if (project.isSecret) {
      for (const { node: target, strength } of unlocks) {
        const before = target.confidenceByCompany[project.companyId] ?? target.publicConfidence;
        target.confidenceByCompany[project.companyId] = unit(before + (1 - before) * UNLOCK_CONFIDENCE_GAIN * strength);
      }
      emitEvent(
        draft,
        ctx,
        'node_owned',
        project.companyId,
        project.targetNodeId,
        {
          projectId: project.id,
          nodeId: project.targetNodeId,
          secret: true,
          publishedPublicly: false,
          ownershipGranted: granted,
          linesImproved: improvedLines,
          pioneer: firstEver,
          capabilityGains: gains,
          quartersElapsed: project.quartersElapsed,
          cumulativeSpendUsd: project.cumulativeSpendUsd,
        },
        'private',
      );
      continue;
    }

    // Public: the world learns the thing is possible, and the node moves one
    // rung toward routine. `status` never becomes `achieved` in world 3 —
    // achievement is a fact about a company and lives on the company.
    if (firstEver) node.status = stateAfterFirstAchievement(node.status);
    node.publicConfidence = 1;
    node.visibility = 'public';
    for (const { node: target, strength } of unlocks) {
      target.publicConfidence = unit(target.publicConfidence + (1 - target.publicConfidence) * UNLOCK_CONFIDENCE_GAIN * strength);
      const own = target.confidenceByCompany[project.companyId] ?? target.publicConfidence;
      target.confidenceByCompany[project.companyId] = unit(own + (1 - own) * UNLOCK_CONFIDENCE_GAIN * strength);
    }

    const eventId = emitEvent(
      draft,
      ctx,
      'node_owned',
      project.companyId,
      project.targetNodeId,
      {
        projectId: project.id,
        nodeId: project.targetNodeId,
        secret: false,
        publishedPublicly: true,
        ownershipGranted: granted,
        linesImproved: improvedLines,
        pioneer: firstEver,
        capabilityGains: gains,
        unlockedNodeIds: unlocks.map((entry) => entry.node.id),
        quartersElapsed: project.quartersElapsed,
        cumulativeSpendUsd: project.cumulativeSpendUsd,
        novelty: node.novelty,
      },
      'public',
    );
    const familyId = raiseAchievementHazard(draft, node, eventId);
    ctx.log({
      phase: 'research_resolution',
      text: `${company.name} can now make ${node.title} after ${project.quartersElapsed} quarters${
        improvedLines > 0 ? `, and ${improvedLines} line${improvedLines === 1 ? '' : 's'} improved because of it` : ''
      }.`,
      deltaLabel: 'owned',
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: project.companyId,
    });
    if (familyId !== null) {
      emitEvent(
        draft,
        ctx,
        'tech_confidence_shifted',
        project.companyId,
        node.id,
        { familyId, cause: 'achievement' },
        'public',
      );
    }
  }

  if (graphChanged) bumpGraphVersion(draft, ctx);
}

/* -------------------------------------------------------------------------- */
/*  Abandonment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Close one programme for good.
 *
 * The researchers and the compute are released the same quarter — both are read
 * off programmes whose status is active or paused — the budget stops, and the
 * company's investor reputation falls by `ABANDON_REPUTATION_COST`, because
 * giving up on something you told the market you were building is a decision
 * the market notices. Returns false when there is nothing to close.
 */
export function abandonProject(draft: SessionState, ctx: ResolverContext, companyId: string, projectId: string): boolean {
  const project = draft.researchProjects.find((candidate) => candidate.id === projectId && candidate.companyId === companyId);
  if (project === undefined) return false;
  if (project.status !== 'active' && project.status !== 'paused') return false;

  const node = findNode(draft, project.targetNodeId);
  const company = findCompany(draft, companyId);
  const releasedResearchers = project.talentAllocated;
  const releasedCompute = project.computeAllocated;

  project.status = 'abandoned';
  project.talentAllocated = 0;
  project.computeAllocated = 0;
  project.budgetQuarterly = 0;
  if (company !== undefined) {
    company.reputation.investor = Math.max(0, company.reputation.investor - ABANDON_REPUTATION_COST);
  }

  const eventId = emitEvent(
    draft,
    ctx,
    'research_abandoned',
    companyId,
    project.targetNodeId,
    {
      projectId: project.id,
      nodeId: project.targetNodeId,
      progress: project.progress,
      releasedResearchers,
      releasedComputeUnits: releasedCompute,
      cumulativeSpendUsd: project.cumulativeSpendUsd,
      investorReputationCost: ABANDON_REPUTATION_COST,
    },
    projectVisibility(project),
  );
  if (!project.isSecret) {
    ctx.log({
      phase: 'research_resolution',
      text: `${company?.name ?? companyId} closed the programme against ${node?.title ?? project.targetNodeId}. ${releasedResearchers} researcher${
        releasedResearchers === 1 ? '' : 's'
      } and ${releasedCompute} accelerator${releasedCompute === 1 ? '' : 's'} are free again, and the spending stops.`,
      deltaLabel: 'closed',
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: companyId,
    });
  }
  return true;
}

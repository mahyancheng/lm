/**
 * @frontier/simulation — research/nodes.ts
 *
 * The second half of the research phase: turning a completed programme into an
 * achieved node, and propagating what that makes credible.
 *
 * A node is achieved when a programme reaches progress 1 **and** every node it
 * depends on has been achieved — by anybody publicly, or by this company
 * privately. A programme that finishes ahead of its dependencies is held at the
 * line rather than allowed to skip them.
 *
 * **Private until published.** When the programme was secret the world is told
 * nothing: the node keeps its epistemic state, its public confidence and its
 * visibility, and only `confidenceByCompany[companyId]` moves to certainty. The
 * ledger row is written at `private` visibility. The achievement becomes public
 * knowledge through `publish_research` (handled in `confidence.ts`) or through a
 * leak — never automatically.
 */

import type { ResearchProject, ResolverContext, SessionState, TechNode } from '@frontier/contracts';
import {
  ACHIEVEMENT_HAZARD_DECAY_QUARTERS,
  ACHIEVEMENT_HAZARD_DELTA,
  CAPABILITY_GAIN_ON_ACHIEVEMENT,
  UNLOCK_CONFIDENCE_GAIN,
} from './balance';
import { bumpGraphVersion, emitEvent, findCompany, findNode, isCapabilityArea, projectVisibility, unit } from './util';

/**
 * True when `nodeId` counts as achieved from `companyId`'s point of view: either
 * the world knows it is done, or this company privately finished it itself.
 */
export function dependencySatisfied(draft: SessionState, nodeId: string, companyId: string): boolean {
  const node = findNode(draft, nodeId);
  if (node === undefined) return false;
  if (node.status === 'achieved') return true;
  return draft.researchProjects.some(
    (p) => p.companyId === companyId && p.targetNodeId === nodeId && p.status === 'succeeded' && p.progress >= 1,
  );
}

/** Dependencies of `node` that are not yet satisfied for `companyId`. */
export function unmetDependencies(draft: SessionState, node: TechNode, companyId: string): string[] {
  return node.dependencies.filter((depId) => !dependencySatisfied(draft, depId, companyId));
}

/** Raise the company's capability in every area the node required. */
function applyCapabilityGain(draft: SessionState, project: ResearchProject, node: TechNode): Record<string, number> {
  const company = findCompany(draft, project.companyId);
  const gains: Record<string, number> = {};
  if (company === undefined) return gains;
  for (const area of node.talentRequirements) {
    if (!isCapabilityArea(area)) continue;
    const before = company.techCapabilities[area] ?? 0;
    const after = unit(before + (1 - before) * CAPABILITY_GAIN_ON_ACHIEVEMENT);
    company.techCapabilities[area] = after;
    gains[area] = after - before;
  }
  return gains;
}

/** Every node this achievement makes more credible, with the strength of the link. */
function unlockTargets(draft: SessionState, node: TechNode): { node: TechNode; strength: number }[] {
  const out: { node: TechNode; strength: number }[] = [];
  const seen = new Set<string>();
  for (const id of node.possibleUnlocks) {
    const target = findNode(draft, id);
    if (target === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({ node: target, strength: 1 });
  }
  for (const edge of draft.techGraph.edges) {
    if (edge.from !== node.id || (edge.kind !== 'unlocks' && edge.kind !== 'informs')) continue;
    if (seen.has(edge.to)) continue;
    const target = findNode(draft, edge.to);
    if (target === undefined) continue;
    seen.add(edge.to);
    out.push({ node: target, strength: edge.strength });
  }
  return out;
}

/**
 * Raise the hazard of the event family an achievement plausibly provokes. Only
 * families that already exist in the session's hazard map are touched: the
 * engine never invents a family that the scenario did not author.
 */
function raiseAchievementHazard(draft: SessionState, node: TechNode, eventId: string): string | null {
  const candidates = ['fam_model_breakthrough', 'fam_frontier_breakthrough', 'fam_capability_jump'];
  for (const familyId of candidates) {
    const hazard = draft.eventHazards[familyId];
    if (hazard === undefined) continue;
    hazard.pendingDeltas.push({
      amount: ACHIEVEMENT_HAZARD_DELTA * (0.5 + node.novelty),
      remainingQuarters: ACHIEVEMENT_HAZARD_DECAY_QUARTERS,
      sourceEventId: eventId,
    });
    let sum = hazard.baseHazard;
    for (const delta of hazard.pendingDeltas) sum += delta.amount;
    hazard.currentHazard = unit(sum);
    return familyId;
  }
  return null;
}

/** Mark nodes achieved where a programme has completed, and propagate the consequences. */
export function achieveNodes(draft: SessionState, ctx: ResolverContext): void {
  let graphChanged = false;

  for (const project of draft.researchProjects) {
    if (project.status !== 'active' || project.progress < 1) continue;
    const node = findNode(draft, project.targetNodeId);
    if (node === undefined) continue;

    const unmet = unmetDependencies(draft, node, project.companyId);
    if (unmet.length > 0) {
      // Held at the line: the work is done, the ground under it is not.
      project.progress = 0.98;
      const eventId = emitEvent(
        draft,
        ctx,
        'research_progress',
        project.companyId,
        node.id,
        { projectId: project.id, nodeId: node.id, blockedByDependencies: unmet, progress: project.progress },
        projectVisibility(project),
      );
      if (!project.isSecret) {
        ctx.log({
          phase: 'research_resolution',
          text: `${node.title} is complete but cannot be demonstrated until ${unmet.length} prerequisite${unmet.length === 1 ? '' : 's'} ${unmet.length === 1 ? 'is' : 'are'} in place.`,
          deltaLabel: 'blocked',
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: project.companyId,
        });
      }
      continue;
    }

    project.status = 'succeeded';
    project.progress = 1;
    project.internalConfidence = 1;
    node.confidenceByCompany[project.companyId] = 1;
    const gains = applyCapabilityGain(draft, project, node);
    const unlocks = unlockTargets(draft, node);
    graphChanged = true;

    if (project.isSecret) {
      // Nothing public moves. The company knows; the world does not.
      for (const { node: target, strength } of unlocks) {
        const before = target.confidenceByCompany[project.companyId] ?? target.publicConfidence;
        target.confidenceByCompany[project.companyId] = unit(before + (1 - before) * UNLOCK_CONFIDENCE_GAIN * strength);
      }
      emitEvent(
        draft,
        ctx,
        'tech_node_achieved',
        project.companyId,
        node.id,
        {
          projectId: project.id,
          nodeId: node.id,
          secret: true,
          publishedPublicly: false,
          capabilityGains: gains,
          unlockedNodeIds: unlocks.map((u) => u.node.id),
          quartersElapsed: project.quartersElapsed,
          cumulativeSpendUsd: project.cumulativeSpendUsd,
        },
        'private',
      );
      continue;
    }

    node.status = 'achieved';
    node.publicConfidence = 1;
    node.achievedByCompanyId = project.companyId;
    node.achievedQuarter = ctx.quarter;
    node.visibility = 'public';
    for (const { node: target, strength } of unlocks) {
      target.publicConfidence = unit(target.publicConfidence + (1 - target.publicConfidence) * UNLOCK_CONFIDENCE_GAIN * strength);
      const own = target.confidenceByCompany[project.companyId] ?? target.publicConfidence;
      target.confidenceByCompany[project.companyId] = unit(own + (1 - own) * UNLOCK_CONFIDENCE_GAIN * strength);
    }

    const company = findCompany(draft, project.companyId);
    const eventId = emitEvent(
      draft,
      ctx,
      'tech_node_achieved',
      project.companyId,
      node.id,
      {
        projectId: project.id,
        nodeId: node.id,
        secret: false,
        publishedPublicly: true,
        capabilityGains: gains,
        unlockedNodeIds: unlocks.map((u) => u.node.id),
        quartersElapsed: project.quartersElapsed,
        cumulativeSpendUsd: project.cumulativeSpendUsd,
        novelty: node.novelty,
      },
      'public',
    );
    const familyId = raiseAchievementHazard(draft, node, eventId);
    ctx.log({
      phase: 'research_resolution',
      text: `${company?.name ?? project.companyId} demonstrated ${node.title} after ${project.quartersElapsed} quarters${unlocks.length > 0 ? `, making ${unlocks.length} further path${unlocks.length === 1 ? '' : 's'} credible` : ''}.`,
      deltaLabel: 'achieved',
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
        { familyId, hazardDelta: ACHIEVEMENT_HAZARD_DELTA * (0.5 + node.novelty), cause: 'achievement' },
        'public',
      );
    }
  }

  if (graphChanged) bumpGraphVersion(draft, ctx);
}

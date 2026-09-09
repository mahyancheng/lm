/**
 * @frontier/simulation — research/confidence.ts
 *
 * What the world believes about the technological future, and how this quarter
 * changed it.
 *
 * Three things move belief, in this order:
 *
 * 1. **Publications.** A company choosing to make a private result public. This
 *    is the only routine path from private truth to public knowledge, and it is
 *    always a decision with a price: a paper buys developer standing and hands
 *    rivals the method.
 * 2. **World events.** A compute shock does not make sparse inference less
 *    likely to work; it makes the expensive dense path less likely to be taken.
 *    That is why every event effect carries a compute-intensity weighting.
 * 3. **Drift.** Absent evidence, confidence falls back toward the prior for the
 *    node's epistemic state, and a node whose confidence collapses is
 *    discredited and eventually written off as a dead end.
 */

import type {
  PublicationMode,
  ResolverContext,
  SessionState,
  SubmittedAction,
  TechConfidenceUpdate,
  TechEpistemicState,
  TechNode,
} from '@frontier/contracts';
import {
  CLOSED_BRIEFING_CONFIDENCE_GAIN,
  CONFIDENCE_DRIFT,
  CONFIDENCE_LINE_FLOOR,
  CONFIDENCE_NOISE,
  CONFIDENCE_REPORT_FLOOR,
  DEAD_END_THRESHOLD,
  DISCREDIT_THRESHOLD,
  EMERGING_THRESHOLD,
  ESTABLISHED_THRESHOLD,
  EVENT_BELIEF_EFFECTS,
  PUBLICATION_EFFECTS,
  STATUS_CONFIDENCE_PRIOR,
  WINDOW_SHIFT_THRESHOLD,
} from './balance';
import { bumpGraphVersion, clamp, emitEvent, findCompany, findNode, ppLabel, score, unit } from './util';

/** Epistemic states that are settled: belief no longer drifts for them. */
const TERMINAL_STATES: readonly TechEpistemicState[] = ['achieved', 'dead_end'];

/** Epistemic states a rising confidence can promote out of. */
const PROMOTABLE_STATES: readonly TechEpistemicState[] = ['forecast', 'speculative', 'company_thesis'];

/** Epistemic states a collapsing confidence can discredit. */
const DISCREDITABLE_STATES: readonly TechEpistemicState[] = ['emerging', 'forecast', 'speculative', 'company_thesis'];

/** Shift a node's expected arrival window, keeping it ordered and in range. */
function shiftWindow(node: TechNode, years: number): void {
  if (years === 0) return;
  const low = clamp(node.estimatedWindow[0] + years, 1900, 2200);
  const high = clamp(Math.max(low, node.estimatedWindow[1] + years), 1900, 2200);
  node.estimatedWindow = [Math.round(low), Math.round(high)];
}

/** Every `publish_research` action queued for this quarter, in submission order. */
function publications(draft: SessionState, ctx: ResolverContext): SubmittedAction[] {
  return draft.pendingActions
    .filter((a) => a.quarter === ctx.quarter && a.intent.type === 'publish_research')
    .sort((a, b) => a.sequence - b.sequence);
}

/** Apply the reputation consequences of a publication mode. */
function applyPublicationReputation(draft: SessionState, companyId: string, mode: PublicationMode): void {
  const company = findCompany(draft, companyId);
  if (company === undefined) return;
  const effect = PUBLICATION_EFFECTS[mode];
  company.reputation.developer = score(company.reputation.developer + effect.developer);
  company.reputation.public = score(company.reputation.public + effect.public);
  company.reputation.investor = score(company.reputation.investor + effect.investor);
  company.reputation.government = score(company.reputation.government + effect.government);
}

/**
 * Move public and per-company confidence across the Frontier Map, and return
 * every movement worth recording.
 */
export function updateTechConfidence(draft: SessionState, ctx: ResolverContext): TechConfidenceUpdate[] {
  const rng = ctx.rng;
  const updates: TechConfidenceUpdate[] = [];
  let graphChanged = false;

  /* --- publications ------------------------------------------------------- */
  for (const action of publications(draft, ctx)) {
    if (action.intent.type !== 'publish_research') continue;
    const { nodeId, mode, rationale } = action.intent;
    const companyId = action.actorCompanyId;
    const node = findNode(draft, nodeId);
    if (node === undefined) {
      emitEvent(draft, ctx, 'action_rejected', companyId, nodeId, { actionId: action.actionId, reason: 'unknown_tech_node' }, 'company');
      continue;
    }
    const project = draft.researchProjects.find(
      (p) => p.companyId === companyId && p.targetNodeId === nodeId && (p.status === 'succeeded' || p.status === 'active'),
    );
    if (project === undefined) {
      emitEvent(
        draft,
        ctx,
        'action_rejected',
        companyId,
        nodeId,
        { actionId: action.actionId, reason: 'no_result_to_publish' },
        'company',
      );
      continue;
    }

    const effect = PUBLICATION_EFFECTS[mode];
    const previousConfidence = node.publicConfidence;
    const previousStatus = node.status;
    const complete = project.progress >= 1 || project.status === 'succeeded';

    if (effect.revealsMethod || effect.fullReveal) {
      // Publishing surrenders the surprise: the programme is no longer secret.
      project.isSecret = false;
    }

    if (complete && effect.fullReveal) {
      node.status = 'achieved';
      node.publicConfidence = 1;
      node.achievedByCompanyId = node.achievedByCompanyId ?? companyId;
      node.achievedQuarter = node.achievedQuarter ?? ctx.quarter;
      node.visibility = 'public';
    } else if (complete) {
      // A closed briefing reaches investors and officials, not the world.
      node.publicConfidence = unit(previousConfidence + (1 - previousConfidence) * CLOSED_BRIEFING_CONFIDENCE_GAIN);
    } else {
      // A partial result: the world moves toward what the team privately thinks.
      node.publicConfidence = unit(previousConfidence + (project.internalConfidence - previousConfidence) * 0.3);
      if (effect.fullReveal && node.visibility !== 'public') node.visibility = 'public';
    }

    if (effect.revealsMethod) {
      // Rivals now know the method, whatever they thought of it before.
      for (const company of draft.companies) {
        if (!company.isActive || company.id === companyId) continue;
        const own = node.confidenceByCompany[company.id] ?? previousConfidence;
        node.confidenceByCompany[company.id] = unit(own + (node.publicConfidence - own) * 0.6);
      }
    }
    node.confidenceByCompany[companyId] = unit(Math.max(node.confidenceByCompany[companyId] ?? 0, project.internalConfidence));
    applyPublicationReputation(draft, companyId, mode);
    graphChanged = true;

    const eventId = emitEvent(
      draft,
      ctx,
      'research_published',
      companyId,
      node.id,
      {
        nodeId: node.id,
        projectId: project.id,
        mode,
        complete,
        rationale,
        previousConfidence,
        newConfidence: node.publicConfidence,
        previousStatus,
        newStatus: node.status,
      },
      mode === 'closed_briefing' ? 'sector' : 'public',
    );
    if (node.status === 'achieved' && previousStatus !== 'achieved') {
      emitEvent(
        draft,
        ctx,
        'tech_node_achieved',
        companyId,
        node.id,
        { nodeId: node.id, projectId: project.id, secret: false, publishedPublicly: true, viaPublication: mode },
        'public',
      );
    }
    updates.push({
      nodeId: node.id,
      quarter: ctx.quarter,
      previousConfidence,
      newConfidence: node.publicConfidence,
      previousStatus,
      newStatus: node.status,
      windowShiftYears: 0,
      causeEventId: eventId,
      reason: `${findCompany(draft, companyId)?.name ?? companyId} published ${node.title} as ${mode.replace(/_/g, ' ')}.`,
    });
    ctx.log({
      phase: 'research_resolution',
      text: `${findCompany(draft, companyId)?.name ?? companyId} published ${node.title} as ${mode.replace(/_/g, ' ')}; public confidence moved to ${(node.publicConfidence * 100).toFixed(0)}%.`,
      deltaLabel: ppLabel(node.publicConfidence - previousConfidence),
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: companyId,
    });
  }

  /* --- world events and drift --------------------------------------------- */
  for (const node of draft.techGraph.nodes) {
    if (TERMINAL_STATES.includes(node.status)) continue;

    const previousConfidence = node.publicConfidence;
    const previousStatus = node.status;
    let confidence = previousConfidence;
    let causeEventId: string | null = null;
    let strongestEventEffect = 0;
    let reason = '';

    for (const event of draft.activeEvents) {
      const effect = EVENT_BELIEF_EFFECTS[event.type];
      if (effect === undefined) continue;
      const age = Math.max(0, ctx.quarter - event.quarter);
      const ageFactor = 1 / (1 + age);
      const intensityWeight = 1 - effect.computeIntensityWeight + effect.computeIntensityWeight * node.computeIntensity * 2;
      const delta = effect.delta * event.severity * ageFactor * intensityWeight;
      confidence = unit(confidence + delta);
      if (Math.abs(delta) > Math.abs(strongestEventEffect)) {
        strongestEventEffect = delta;
        // `causeEventId` names the *world event*, not the ledger row: the
        // Frontier Map screen links a belief movement back to what happened.
        causeEventId = event.id;
        reason = `${event.title} moved expectations for ${node.title}.`;
      }
    }

    // Endogenous drift toward the prior for this epistemic state, plus a small
    // seeded jitter so belief is never perfectly still.
    const prior = STATUS_CONFIDENCE_PRIOR[node.status];
    confidence = unit(confidence + (prior - confidence) * CONFIDENCE_DRIFT + rng.range(-CONFIDENCE_NOISE, CONFIDENCE_NOISE));

    let status: TechEpistemicState = node.status;
    if (confidence <= DEAD_END_THRESHOLD && (status === 'discredited' || DISCREDITABLE_STATES.includes(status))) {
      status = 'dead_end';
    } else if (confidence <= DISCREDIT_THRESHOLD && DISCREDITABLE_STATES.includes(status)) {
      status = 'discredited';
    } else if (confidence >= ESTABLISHED_THRESHOLD && status === 'emerging') {
      status = 'established';
    } else if (confidence >= EMERGING_THRESHOLD && PROMOTABLE_STATES.includes(status)) {
      status = 'emerging';
    }

    const move = confidence - previousConfidence;
    const windowShift = Math.abs(move) >= WINDOW_SHIFT_THRESHOLD ? (move > 0 ? -1 : 1) : 0;

    if (Math.abs(move) < CONFIDENCE_REPORT_FLOOR && status === previousStatus && windowShift === 0) {
      node.publicConfidence = confidence;
      continue;
    }

    node.publicConfidence = confidence;
    node.status = status;
    shiftWindow(node, windowShift);
    graphChanged = true;

    if (reason === '') {
      reason =
        status !== previousStatus
          ? `${node.title} moved from ${previousStatus.replace(/_/g, ' ')} to ${status.replace(/_/g, ' ')}.`
          : `Expectations for ${node.title} drifted toward the ${status.replace(/_/g, ' ')} consensus.`;
    }

    const eventId = emitEvent(
      draft,
      ctx,
      'tech_confidence_shifted',
      null,
      node.id,
      {
        nodeId: node.id,
        previousConfidence,
        newConfidence: confidence,
        previousStatus,
        newStatus: status,
        windowShiftYears: windowShift,
        strongestEventEffect,
      },
      node.visibility === 'public' ? 'public' : 'company',
    );

    updates.push({
      nodeId: node.id,
      quarter: ctx.quarter,
      previousConfidence,
      newConfidence: confidence,
      previousStatus,
      newStatus: status,
      windowShiftYears: windowShift,
      causeEventId,
      reason: reason.slice(0, 300),
    });

    if (node.visibility === 'public' && (Math.abs(move) >= CONFIDENCE_LINE_FLOOR || status !== previousStatus)) {
      ctx.log({
        phase: 'research_resolution',
        text:
          status !== previousStatus
            ? `${node.title} is now regarded as ${status.replace(/_/g, ' ')}; confidence ${(confidence * 100).toFixed(0)}%.`
            : `Confidence in ${node.title} moved to ${(confidence * 100).toFixed(0)}%.`,
        deltaLabel: ppLabel(move),
        refEventIds: [eventId],
        tone: move >= 0 ? 'positive' : 'negative',
        subjectId: node.id,
      });
    }
  }

  if (graphChanged) bumpGraphVersion(draft, ctx);
  return updates;
}

/**
 * @frontier/simulation — relationships/reactions.ts
 *
 * `updateRelationships` — phase 15, `relationship_update`.
 *
 * Two jobs, in order:
 *
 * 1. **Record what the quarter's actions did to people.** A poaching approach,
 *    an introduction asked for, a deal accepted, rejected or breached, a
 *    regulator met: each becomes a `Memory` in somebody's head.
 * 2. **Convert this quarter's memories into feelings.** Government, boards and
 *    social have already stored their memories in earlier phases; here every
 *    memory dated this quarter is translated, once, through the single
 *    conversion table in `relations.ts` and applied with a per-quarter cap.
 *
 * The subsystem never reads the ledger — a `ResolverContext` deliberately has
 * no read path — so everything here is derived from the draft: the quarter's
 * `pendingActions`, the deals, and the memories other phases wrote.
 */

import type { AccessOverride, Relationship, ResolverContext, SessionState, SubmittedAction } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { emitEvent, line, round } from './util';
import { addDelta, applyRelationshipDelta, ceoOf, characterById, ensureRelationship, memoryEffect, rememberEvent, subjectCharacterId, ZERO_DELTA, type RelationshipDelta } from './relations';
import { checkAccess } from './access';

/** How many quarters an introduction stays open before it must be converted. */
export const INTRODUCTION_QUARTERS = 3;

/** Combined trust and respect an introducer needs before spending their standing. */
export const INTRODUCTION_QUALITY_THRESHOLD = 55;

/** Movements smaller than this on every dimension are not worth a report line. */
const REPORT_THRESHOLD = 2;

/* -------------------------------------------------------------------------- */
/*  Action reactions                                                           */
/* -------------------------------------------------------------------------- */

function quarterActions(draft: SessionState, ctx: ResolverContext): SubmittedAction[] {
  return draft.pendingActions.filter((a) => a.quarter === ctx.quarter).sort((a, b) => a.sequence - b.sequence);
}

/** An approach to somebody's senior person. Their employer remembers it either way. */
function reactToPoach(draft: SessionState, ctx: ResolverContext, action: SubmittedAction): void {
  if (action.intent.type !== 'poach_executive') return;
  const target = characterById(draft, action.intent.targetCharacterId);
  if (target === null) return;
  const employerId = target.companyId;
  const actorCompany = draft.companies.find((c) => c.id === action.actorCompanyId);
  const actorName = actorCompany?.name ?? action.actorCompanyId;

  if (employerId !== null && employerId !== action.actorCompanyId) {
    const employerCeo = ceoOf(draft, employerId);
    if (employerCeo !== null && employerCeo !== action.actorCharacterId) {
      const public_ = action.intent.approach === 'public';
      rememberEvent(draft, ctx, {
        ownerCharacterId: employerCeo,
        aboutId: action.actorCompanyId,
        kind: 'poach',
        summary: `${actorName} approached ${target.name} with a ${Math.round(action.intent.compPremiumPct * 100)}% package${public_ ? ', and did it in public' : ''}.`,
        sentiment: -(0.45 + (public_ ? 0.3 : 0) + Math.min(0.25, action.intent.compPremiumPct * 0.25)),
      });
    }
  }

  // The person approached remembers being wanted.
  rememberEvent(draft, ctx, {
    ownerCharacterId: target.id,
    aboutId: action.actorCharacterId,
    kind: 'meeting',
    summary: `${actorName} came to me with an offer at a ${Math.round(action.intent.compPremiumPct * 100)}% premium.`,
    sentiment: action.intent.approach === 'public' ? 0.05 : 0.3,
  });
}

/**
 * An introduction request. The introducer must be reachable by the asker and
 * must think well enough of them to spend their standing — the main legitimate
 * route from a low connection level to a high one.
 */
function reactToIntroduction(draft: SessionState, ctx: ResolverContext, action: SubmittedAction): void {
  if (action.intent.type !== 'request_introduction') return;
  const asker = action.actorCharacterId;
  const via = characterById(draft, action.intent.viaCharacterId);
  const target = characterById(draft, action.intent.targetCharacterId);
  if (via === null || target === null || via.id === asker) return;

  const reachable = checkAccess(draft, asker, via.id).allowed;
  const rel = draft.relationships.find((r) => r.fromId === via.id && r.toId === asker);
  const quality = rel === undefined ? 45 : (rel.trust + rel.respect) / 2;
  const viaReachesTarget = checkAccess(draft, via.id, target.id).allowed;
  const vague = action.intent.purpose.trim().length < 20;

  if (!reachable || !viaReachesTarget || vague || quality < INTRODUCTION_QUALITY_THRESHOLD) {
    rememberEvent(draft, ctx, {
      ownerCharacterId: via.id,
      aboutId: asker,
      kind: 'meeting',
      summary: `They asked me to introduce them to ${target.name}${vague ? ' without saying what for' : ''}. I did not.`,
      sentiment: -0.2,
    });
    return;
  }

  const overrideId = makeId('ovr', 'introduction', asker, target.id, ctx.quarter);
  if (!draft.accessOverrides.some((o) => o.id === overrideId)) {
    const override: AccessOverride = {
      id: overrideId,
      kind: 'introduction',
      fromId: asker,
      toId: target.id,
      grantedQuarter: ctx.quarter,
      expiresQuarter: ctx.quarter + INTRODUCTION_QUARTERS,
      isPermanent: false,
      grantedByCharacterId: via.id,
      reason: `${via.name} introduced you to ${target.name}.`.slice(0, 240),
    };
    draft.accessOverrides.push(override);

    const eventId = emitEvent(
      draft,
      ctx,
      'introduction_granted',
      via.id,
      target.id,
      { overrideId, askerCharacterId: asker, expiresQuarter: override.expiresQuarter, purpose: action.intent.purpose.slice(0, 300) },
      'private',
    );
    ctx.log({
      phase: 'relationship_update',
      text: line(`${via.name} spent standing to introduce ${characterById(draft, asker)?.name ?? asker} to ${target.name}.`),
      deltaLabel: `${INTRODUCTION_QUARTERS}q access`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: asker,
    });
  }

  rememberEvent(draft, ctx, {
    ownerCharacterId: asker,
    aboutId: via.id,
    kind: 'introduction',
    summary: `${via.name} put their own standing behind me and introduced me to ${target.name}.`,
    sentiment: 0.7,
  });
  // The introducer now has a stake in how it goes.
  rememberEvent(draft, ctx, {
    ownerCharacterId: via.id,
    aboutId: asker,
    kind: 'favour',
    summary: `I introduced them to ${target.name}. That is on my name now.`,
    sentiment: 0.35,
  });
}

function reactToDealActions(draft: SessionState, ctx: ResolverContext, action: SubmittedAction): void {
  if (action.intent.type === 'accept_deal') {
    const deal = draft.deals.find((d) => d.id === action.intent.dealId);
    if (deal === undefined) return;
    const proposerCharacter = subjectCharacterId(draft, deal.proposerId);
    if (proposerCharacter !== null) {
      rememberEvent(draft, ctx, {
        ownerCharacterId: proposerCharacter,
        aboutId: action.actorCharacterId,
        kind: 'negotiation',
        summary: `They took the terms I offered: ${deal.summary}`.slice(0, 300),
        sentiment: 0.5,
        stableKey: `${deal.id}_accepted`,
      });
    }
    return;
  }
  if (action.intent.type === 'reject_deal') {
    const deal = draft.deals.find((d) => d.id === action.intent.dealId);
    if (deal === undefined) return;
    const proposerCharacter = subjectCharacterId(draft, deal.proposerId);
    if (proposerCharacter !== null) {
      rememberEvent(draft, ctx, {
        ownerCharacterId: proposerCharacter,
        aboutId: action.actorCharacterId,
        kind: 'negotiation',
        summary: `They turned the deal down: ${action.intent.reason || 'no reason given'}.`.slice(0, 300),
        sentiment: -0.35,
        stableKey: `${deal.id}_rejected`,
      });
    }
  }
}

function reactToRegulatorMeeting(draft: SessionState, ctx: ResolverContext, action: SubmittedAction): void {
  if (action.intent.type !== 'meet_regulator') return;
  const regulator = characterById(draft, action.intent.regulatorCharacterId);
  if (regulator === null) return;
  const postureSentiment: Record<string, number> = { cooperative: 0.5, informational: 0.2, defensive: -0.1, lobbying: -0.3 };
  const base = postureSentiment[action.intent.posture] ?? 0;
  const concessionBonus = Math.min(0.25, action.intent.concessionsOffered.length * 0.08);
  rememberEvent(draft, ctx, {
    ownerCharacterId: regulator.id,
    aboutId: action.actorCharacterId,
    kind: 'meeting',
    summary: `They came to talk about ${action.intent.topic.replace(/_/g, ' ')} in a ${action.intent.posture} posture.`,
    sentiment: base + (base >= 0 ? concessionBonus : concessionBonus * 0.5),
  });
}

/** Deals that have been discharged or broken since anyone last looked. */
function reactToDealOutcomes(draft: SessionState, ctx: ResolverContext): void {
  for (const deal of draft.deals) {
    if (deal.breachedByPartyId !== null) {
      const victim = deal.breachedByPartyId === deal.proposerId ? deal.counterpartyId : deal.proposerId;
      const owner = subjectCharacterId(draft, victim);
      const breacher = deal.breachedByPartyId;
      if (owner !== null) {
        rememberEvent(draft, ctx, {
          ownerCharacterId: owner,
          aboutId: breacher,
          kind: 'deal_broken',
          summary: `They did not deliver what they signed for: ${deal.summary}`.slice(0, 300),
          sentiment: -0.9,
          stableKey: `${deal.id}_breach`,
        });
      }
      continue;
    }
    if (deal.status === 'executed' && deal.binding) {
      for (const [ownerId, aboutId] of [
        [deal.proposerId, deal.counterpartyId],
        [deal.counterpartyId, deal.proposerId],
      ] as const) {
        const owner = subjectCharacterId(draft, ownerId);
        if (owner === null) continue;
        rememberEvent(draft, ctx, {
          ownerCharacterId: owner,
          aboutId,
          kind: 'deal_kept',
          summary: `They delivered every obligation: ${deal.summary}`.slice(0, 300),
          sentiment: 0.7,
          stableKey: `${deal.id}_executed`,
        });
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Memory to relationship                                                     */
/* -------------------------------------------------------------------------- */

interface PairMovement {
  readonly fromId: string;
  readonly toId: string;
  readonly delta: RelationshipDelta;
  readonly applied: RelationshipDelta;
  readonly after: Relationship;
  readonly reasons: string[];
}

function magnitude(delta: RelationshipDelta): number {
  return Math.abs(delta.trust) + Math.abs(delta.respect) + Math.abs(delta.hostility) + Math.abs(delta.dependence);
}

/* -------------------------------------------------------------------------- */
/*  Subsystem function                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Move trust, respect, hostility and dependence in response to what actually
 * happened this quarter. Every movement is bounded and traceable to a stored
 * memory; nothing here is narrative invention.
 */
export function updateRelationships(draft: SessionState, ctx: ResolverContext): void {
  for (const action of quarterActions(draft, ctx)) {
    switch (action.intent.type) {
      case 'poach_executive':
        reactToPoach(draft, ctx, action);
        break;
      case 'request_introduction':
        reactToIntroduction(draft, ctx, action);
        break;
      case 'accept_deal':
      case 'reject_deal':
        reactToDealActions(draft, ctx, action);
        break;
      case 'meet_regulator':
        reactToRegulatorMeeting(draft, ctx, action);
        break;
      default:
        break;
    }
  }
  reactToDealOutcomes(draft, ctx);

  // Every memory dated this quarter, whoever wrote it, becomes a feeling here
  // and only here.
  const pairs = new Map<string, { fromId: string; toId: string; delta: RelationshipDelta; reasons: string[] }>();
  for (const memory of draft.memories) {
    if (memory.quarter !== ctx.quarter) continue;
    const toId = subjectCharacterId(draft, memory.aboutId);
    if (toId === null || toId === memory.ownerCharacterId) continue;
    const key = `${memory.ownerCharacterId}->${toId}`;
    const existing = pairs.get(key) ?? { fromId: memory.ownerCharacterId, toId, delta: ZERO_DELTA, reasons: [] };
    existing.delta = addDelta(existing.delta, memoryEffect(memory.kind, memory.sentiment, memory.strength));
    existing.reasons.push(memory.kind);
    pairs.set(key, existing);
  }

  const movements: PairMovement[] = [];
  for (const pair of [...pairs.values()].sort((a, b) => (a.fromId === b.fromId ? a.toId.localeCompare(b.toId) : a.fromId.localeCompare(b.fromId)))) {
    if (magnitude(pair.delta) < 1e-9) continue;
    const relationship = ensureRelationship(draft, pair.fromId, pair.toId);
    const applied = applyRelationshipDelta(relationship, pair.delta, ctx.quarter);
    movements.push({ fromId: pair.fromId, toId: pair.toId, delta: pair.delta, applied, after: relationship, reasons: pair.reasons });
  }

  if (movements.length === 0) return;

  const eventId = emitEvent(
    draft,
    ctx,
    'relationship_changed',
    null,
    null,
    {
      quarter: ctx.quarter,
      movements: movements.map((m) => ({
        fromId: m.fromId,
        toId: m.toId,
        causes: m.reasons,
        trust: round(m.applied.trust, 2),
        respect: round(m.applied.respect, 2),
        hostility: round(m.applied.hostility, 2),
        dependence: round(m.applied.dependence, 2),
        after: {
          trust: round(m.after.trust, 2),
          respect: round(m.after.respect, 2),
          hostility: round(m.after.hostility, 2),
          dependence: round(m.after.dependence, 2),
        },
      })),
    },
    'private',
  );

  const notable = [...movements].sort((a, b) => magnitude(b.applied) - magnitude(a.applied)).slice(0, 4);
  for (const move of notable) {
    if (magnitude(move.applied) < REPORT_THRESHOLD) continue;
    const from = characterById(draft, move.fromId)?.name ?? move.fromId;
    const to = characterById(draft, move.toId)?.name ?? move.toId;
    const hostile = move.applied.hostility > 0 || move.applied.trust < 0;
    const headline = hostile
      ? `${from} took ${to} badly this quarter (${move.reasons.join(', ')}).`
      : `${from} thinks better of ${to} after this quarter (${move.reasons.join(', ')}).`;
    ctx.log({
      phase: 'relationship_update',
      text: line(headline),
      deltaLabel: `trust ${move.applied.trust >= 0 ? '+' : ''}${round(move.applied.trust, 1)}`,
      refEventIds: [eventId],
      tone: hostile ? 'negative' : 'positive',
      subjectId: move.toId,
    });
  }
}

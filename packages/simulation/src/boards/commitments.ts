/**
 * @frontier/simulation — boards/commitments.ts
 *
 * Conditional commitments: the machine-readable residue of a negotiation.
 *
 * > "At $6.4 billion I do not support it. Below $5.5 billion, or with a larger
 * > stock component, I would."
 *
 * becomes `support / purchasePriceUsd lte 5500000000 / stockComponentPct gte
 * 0.35`. The dialogue agent produces the `ConditionalCommitment`; this module
 * gives it an identity, an expiry and a lifecycle, and — when the matching
 * proposal is finally tabled — records whether it was honoured or broken.
 *
 * `commitmentsFromLobbying` is the deterministic fallback for the same
 * mechanism: with no model in the loop, a `lobby_director` action still
 * produces a testable promise, derived from the director's own traits under the
 * concession terms offered. An LLM outage degrades the prose, never the rules.
 */

import type {
  BoardProposal,
  CommitmentCondition,
  ConditionalCommitment,
  ResolverContext,
  SessionState,
  StoredCommitment,
  SubmittedAction,
  BoardTally,
} from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { rememberEvent } from '../relationships/relations';
import { assessDirector, boardForProposal, bindingCommitments, SUPPORT_THRESHOLD } from './tally';
import { clamp, companyById, emitEvent, round, signedScore100, unit } from './util';

/** How long a promise made in a lobbying conversation stands. */
export const LOBBY_COMMITMENT_QUARTERS = 2;

/* -------------------------------------------------------------------------- */
/*  Registration                                                               */
/* -------------------------------------------------------------------------- */

export interface RegisteredCommitment {
  readonly commitment: StoredCommitment;
  /** The `commitment_registered` ledger row, so a report line can reference it. */
  readonly eventId: string;
}

/**
 * Store a validated conditional commitment with an engine-assigned identity.
 * The LLM never supplies an id, a created quarter or a status.
 */
export function registerCommitment(
  draft: SessionState,
  ctx: ResolverContext,
  commitment: ConditionalCommitment,
  conversationId: string | null = null,
): RegisteredCommitment {
  const base = makeId('cmt', draft.sessionId, ctx.quarter, commitment.actorCharacterId, commitment.proposalKind);
  const taken = new Set(draft.commitments.map((c) => c.id));
  let id = base;
  let suffix = 1;
  while (taken.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }

  const stored: StoredCommitment = {
    ...commitment,
    conditions: commitment.conditions.map((c) => ({ ...c })),
    id,
    createdQuarter: ctx.quarter,
    conversationId,
    status: 'active',
    resolvedProposalId: null,
  };
  draft.commitments.push(stored);

  const eventId = emitEvent(
    draft,
    ctx,
    'commitment_registered',
    commitment.actorCharacterId,
    commitment.targetCompanyId,
    {
      commitmentId: id,
      proposalKind: commitment.proposalKind,
      stance: commitment.stance,
      commitmentStrength: commitment.commitmentStrength,
      expiresQuarter: commitment.expiresQuarter,
      conditions: stored.conditions,
      conversationId,
    },
    'company',
  );
  return { commitment: stored, eventId };
}

/* -------------------------------------------------------------------------- */
/*  Lobbying                                                                   */
/* -------------------------------------------------------------------------- */

/** A copy of the proposal as it would read if every concession were granted. */
export function applyConcessions(proposal: BoardProposal, conditions: readonly CommitmentCondition[]): BoardProposal {
  const next: BoardProposal = { ...proposal };
  for (const condition of conditions) {
    switch (condition.field) {
      case 'purchasePriceUsd':
      case 'amountUsd':
      case 'ceoCompUsd':
      case 'capexUsd':
      case 'contractValueUsd':
        next.amountUsd = Math.max(0, condition.value);
        break;
      case 'stockComponentPct':
        next.stockComponentPct = unit(condition.value);
        break;
      case 'cashComponentPct':
        next.stockComponentPct = unit(1 - condition.value);
        break;
      case 'dilutionPct':
      case 'floatPct':
      case 'headcountReductionPct':
        next.dilutionPct = unit(condition.value);
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * Turn this quarter's `lobby_director` actions into commitments.
 *
 * The reply comes from the director's traits, their mandate and their memory of
 * the person asking — never from how persuasive the message text was. The
 * message is not read by the engine at all.
 */
export function commitmentsFromLobbying(draft: SessionState, ctx: ResolverContext): RegisteredCommitment[] {
  const created: RegisteredCommitment[] = [];
  const actions: SubmittedAction[] = draft.pendingActions
    .filter((a) => a.quarter === ctx.quarter && a.intent.type === 'lobby_director')
    .sort((a, b) => a.sequence - b.sequence);

  for (const action of actions) {
    const intent = action.intent;
    if (intent.type !== 'lobby_director') continue;
    const proposal = draft.boardProposals.find((p) => p.id === intent.proposalId);
    if (proposal === undefined || proposal.status !== 'tabled') continue;
    const board = boardForProposal(draft, proposal);
    const director = board?.directors.find((d) => d.characterId === intent.directorCharacterId);
    if (board === null || board === undefined || director === undefined) continue;

    // Would they support it on the terms offered?
    const hypothetical = applyConcessions(proposal, intent.concessions);
    const withConcessions = assessDirector(draft, hypothetical, director);
    const stance = withConcessions.value > SUPPORT_THRESHOLD ? 'support' : withConcessions.value < -SUPPORT_THRESHOLD ? 'oppose' : 'abstain';

    const relationship = draft.relationships.find((r) => r.fromId === director.characterId && r.toId === action.actorCharacterId);
    const trust = relationship?.trust ?? 45;
    const strength = unit(
      0.3 + 0.25 * (director.relationshipWithCeo / 100) + 0.3 * (trust / 100) - 0.15 * (director.independence / 100) + 0.15 * Math.abs(withConcessions.value),
    );

    const commitment: ConditionalCommitment = {
      actorCharacterId: director.characterId,
      proposalKind: proposal.kind,
      stance,
      conditions: intent.concessions.slice(0, 6).map((c) => ({ ...c })),
      commitmentStrength: round(strength, 3),
      expiresQuarter: Math.max(proposal.decisionQuarter, ctx.quarter + LOBBY_COMMITMENT_QUARTERS),
      targetCompanyId: proposal.targetCompanyId,
      rationale: withConcessions.rationale.slice(0, 400),
    };
    created.push(registerCommitment(draft, ctx, commitment, null));

    rememberEvent(draft, ctx, {
      ownerCharacterId: director.characterId,
      aboutId: action.actorCharacterId,
      kind: 'negotiation',
      summary: `They came to me before the ${proposal.kind.replace(/_/g, ' ')} vote and moved on terms.`,
      sentiment: stance === 'support' ? 0.35 : stance === 'abstain' ? 0.1 : -0.1,
      stableKey: `${proposal.id}_lobby_${action.actorCharacterId}`,
    });
  }

  return created;
}

/* -------------------------------------------------------------------------- */
/*  Expiry                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Lapse promises whose window has closed. A promise made three quarters ago has
 * usually expired, and an expired promise is not a broken one: no relationship
 * consequence, no ledger row, just state hygiene.
 */
export function expireCommitments(draft: SessionState, ctx: ResolverContext): number {
  let expired = 0;
  for (const commitment of draft.commitments) {
    if (commitment.status !== 'active') continue;
    if (commitment.expiresQuarter >= ctx.quarter) continue;
    commitment.status = 'expired';
    expired += 1;
  }
  return expired;
}

/* -------------------------------------------------------------------------- */
/*  Honour and break                                                           */
/* -------------------------------------------------------------------------- */

export interface CommitmentOutcome {
  readonly commitmentId: string;
  readonly directorCharacterId: string;
  readonly honoured: boolean;
  readonly eventId: string;
}

/**
 * Check every live commitment against the vote that just happened.
 *
 * A commitment whose conditions hold and whose promised stance matches the vote
 * is honoured. One whose conditions hold and whose stance does not match is
 * **broken**, which damages the relationship with the counterparty permanently —
 * the memory is a betrayal, and betrayals barely decay.
 */
export function resolveCommitmentOutcomes(
  draft: SessionState,
  ctx: ResolverContext,
  proposal: BoardProposal,
  tally: BoardTally,
): CommitmentOutcome[] {
  const outcomes: CommitmentOutcome[] = [];
  const board = boardForProposal(draft, proposal);
  if (board === null) return outcomes;
  const counterparty = proposal.proposedByCharacterId;
  const company = companyById(draft, proposal.companyId);

  for (const director of board.directors) {
    const live = bindingCommitments(draft, proposal, director.characterId);
    if (live.length === 0) continue;
    const vote = tally.perDirector.find((v) => v.directorCharacterId === director.characterId);
    if (vote === undefined) continue;

    for (const commitment of live) {
      const kept = vote.vote === commitment.stance;
      commitment.status = kept ? 'honoured' : 'broken';
      commitment.resolvedProposalId = proposal.id;

      const eventId = emitEvent(
        draft,
        ctx,
        kept ? 'commitment_honoured' : 'commitment_broken',
        director.characterId,
        proposal.id,
        {
          commitmentId: commitment.id,
          promisedStance: commitment.stance,
          castVote: vote.vote,
          commitmentStrength: commitment.commitmentStrength,
          conditions: commitment.conditions,
        },
        'company',
      );
      outcomes.push({ commitmentId: commitment.id, directorCharacterId: director.characterId, honoured: kept, eventId });

      director.relationshipWithCeo = signedScore100(director.relationshipWithCeo + (kept ? 3 : -6));

      if (counterparty !== director.characterId) {
        rememberEvent(draft, ctx, {
          ownerCharacterId: counterparty,
          aboutId: director.characterId,
          kind: kept ? 'board_vote' : 'betrayal',
          summary: kept
            ? `They kept their word on the ${proposal.kind.replace(/_/g, ' ')} vote.`
            : `They promised to ${commitment.stance} the ${proposal.kind.replace(/_/g, ' ')} vote and did not.`,
          sentiment: kept ? 0.6 : -0.9,
          stableKey: `${commitment.id}_${kept ? 'honoured' : 'broken'}`,
        });
      }

      if (!kept && company !== null) {
        // A director who breaks a promise loses standing with the whole room.
        for (const other of board.directors) {
          if (other.characterId === director.characterId) continue;
          rememberEvent(draft, ctx, {
            ownerCharacterId: other.characterId,
            aboutId: director.characterId,
            kind: 'board_vote',
            summary: `They gave their word before the ${company.name} vote and broke it.`,
            sentiment: -0.4,
            stableKey: `${commitment.id}_witnessed_by_${other.characterId}`,
          });
        }
      }
    }
  }

  return outcomes;
}

/** Live commitments a director holds on a class of matter, for the boardroom screen. */
export function activeCommitmentsFor(draft: SessionState, characterId: string, quarter: number): StoredCommitment[] {
  return draft.commitments.filter((c) => c.status === 'active' && c.actorCharacterId === characterId && c.expiresQuarter >= quarter);
}

/** Clamp helper re-exported so callers can bound a strength before registering. */
export const clampStrength = (value: number): number => clamp(value, 0, 1);

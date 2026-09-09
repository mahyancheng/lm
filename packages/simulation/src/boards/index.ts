/**
 * @frontier/simulation — boards
 *
 * Governance. Phase 5, `board_resolution`: boards decide before capital moves,
 * so an acquisition approved here alters the purchaser's cash in phase 6 and is
 * priced by the market in phase 13.
 *
 * ```text
 * applyCommitments   register promises made this quarter, lapse stale ones
 * tallyProposal      every director's stance, from traits and live commitments
 * resolveProposals   carry or refuse each matter, apply it, honour or break
 * ```
 *
 * The subsystem's load-bearing claim is that being chief executive and owning
 * the company are separate states. A board can dismiss the player as chief
 * executive; the player keeps every share and the campaign continues as a proxy
 * fight. `effects.ts` is where that is made mechanical.
 */

import type { BoardsSubsystem, BoardTally, ResolverContext, SessionState } from '@frontier/contracts';
import { tallyProposal, boardForProposal, thresholdFor } from './tally';
import { applyProposalEffects } from './effects';
import { commitmentsFromLobbying, expireCommitments, resolveCommitmentOutcomes } from './commitments';
import { emitEvent, line, round } from './util';

export {
  controllingHolderId,
  tallyProposal,
  assessDirector,
  bindingCommitments,
  boardForProposal,
  isRecused,
  proposalCommitmentValues,
  proposalEconomics,
  thresholdFor,
  SUPPORT_THRESHOLD,
  LOYALTY_WEIGHT,
  BINDING_COMMITMENT_STRENGTH,
} from './tally';
export type { DirectorAssessment, ProposalEconomics } from './tally';
export { applyProposalEffects } from './effects';
export type { ProposalEffect } from './effects';
export {
  registerCommitment,
  commitmentsFromLobbying,
  expireCommitments,
  resolveCommitmentOutcomes,
  applyConcessions,
  activeCommitmentsFor,
  LOBBY_COMMITMENT_QUARTERS,
} from './commitments';
export type { CommitmentOutcome, RegisteredCommitment } from './commitments';
export { boardForCompany, boardById, companyById } from './util';

/* -------------------------------------------------------------------------- */
/*  Subsystem                                                                  */
/* -------------------------------------------------------------------------- */

export function createBoardsSubsystem(): BoardsSubsystem {
  /* ------------------------------ commitments ----------------------------- */

  function applyCommitments(draft: SessionState, ctx: ResolverContext): void {
    const registered = commitmentsFromLobbying(draft, ctx);
    expireCommitments(draft, ctx);

    for (const { commitment, eventId } of registered) {
      ctx.log({
        phase: 'board_resolution',
        text: line(
          `A director committed to ${commitment.stance} the ${commitment.proposalKind.replace(/_/g, ' ')} matter on ${commitment.conditions.length} stated condition(s), at strength ${round(commitment.commitmentStrength, 2)}.`,
        ),
        deltaLabel: `strength ${round(commitment.commitmentStrength, 2)}`,
        refEventIds: [eventId],
        tone: commitment.stance === 'support' ? 'positive' : commitment.stance === 'oppose' ? 'negative' : 'neutral',
        subjectId: commitment.actorCharacterId,
      });
    }
    // Lapsed commitments write no ledger row: a promise that expired unused is
    // not a promise that was broken.
  }

  /* ------------------------------- proposals ------------------------------ */

  function resolveProposals(draft: SessionState, ctx: ResolverContext): void {
    for (const proposal of draft.boardProposals) {
      if (proposal.status !== 'tabled') continue;
      if (proposal.decisionQuarter > ctx.quarter) continue;

      const board = boardForProposal(draft, proposal);
      const tally: BoardTally = tallyProposal(draft, proposal.id);

      if (board === null) continue;

      if (!tally.quorumMet) {
        // The matter does not resolve and rolls to the next meeting.
        proposal.decisionQuarter = ctx.quarter + 1;
        const eventId = emitEvent(
          draft,
          ctx,
          'board_vote_resolved',
          proposal.proposedByCharacterId,
          proposal.id,
          {
            companyId: proposal.companyId,
            kind: proposal.kind,
            quorumMet: false,
            support: tally.support,
            against: tally.against,
            abstain: tally.abstain,
            absent: tally.absent,
            rolledToQuarter: proposal.decisionQuarter,
          },
          'company',
        );
        ctx.log({
          phase: 'board_resolution',
          text: line(`"${proposal.title}" did not reach quorum and rolls to the next meeting.`),
          deltaLabel: 'no quorum',
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: proposal.companyId,
        });
        continue;
      }

      proposal.status = tally.passes ? 'passed' : 'failed';
      const effect = applyProposalEffects(draft, ctx, proposal, tally);
      const commitmentOutcomes = resolveCommitmentOutcomes(draft, ctx, proposal, tally);

      const eventId = emitEvent(
        draft,
        ctx,
        'board_vote_resolved',
        proposal.proposedByCharacterId,
        proposal.id,
        {
          companyId: proposal.companyId,
          boardId: board.id,
          kind: proposal.kind,
          quorumMet: true,
          passes: tally.passes,
          threshold: round(thresholdFor(board, proposal), 4),
          support: tally.support,
          against: tally.against,
          abstain: tally.abstain,
          absent: tally.absent,
          amountUsd: proposal.amountUsd,
          dilutionPct: proposal.dilutionPct,
          stockComponentPct: proposal.stockComponentPct,
          perDirector: tally.perDirector.map((v) => ({
            directorCharacterId: v.directorCharacterId,
            vote: v.vote,
            weight: v.weight,
            rationale: v.rationale,
            honouredCommitmentId: v.honouredCommitmentId,
          })),
          commitments: commitmentOutcomes.map((o) => ({
            commitmentId: o.commitmentId,
            directorCharacterId: o.directorCharacterId,
            honoured: o.honoured,
          })),
          effects: effect.changes,
        },
        // Board outcomes are visible to the company; the market learns about
        // them through disclosure, not through the ledger row.
        'company',
      );

      const refs = [eventId, ...effect.eventIds];
      ctx.log({
        phase: 'board_resolution',
        text: line(
          `"${proposal.title}" ${tally.passes ? 'carried' : 'failed'} ${round(tally.support, 1)} to ${round(tally.against, 1)}${tally.abstain > 0 ? ` with ${round(tally.abstain, 1)} abstaining` : ''}. ${effect.summary}`,
        ),
        deltaLabel: `${round(tally.support, 1)}-${round(tally.against, 1)}`,
        refEventIds: refs,
        tone: tally.passes ? (proposal.kind === 'ceo_dismissal' || proposal.kind === 'restructuring' ? 'warning' : 'positive') : 'negative',
        subjectId: proposal.companyId,
      });

      for (const outcome of commitmentOutcomes) {
        if (outcome.honoured) continue;
        ctx.log({
          phase: 'board_resolution',
          text: line(`A director broke a commitment on "${proposal.title}". That will be remembered.`),
          deltaLabel: 'broken',
          refEventIds: [outcome.eventId],
          tone: 'negative',
          subjectId: outcome.directorCharacterId,
        });
      }
    }
  }

  return { tallyProposal, resolveProposals, applyCommitments };
}

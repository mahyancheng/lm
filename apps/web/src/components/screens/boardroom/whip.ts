/**
 * The whip count.
 *
 * `tallyProposal` needs a proposal that exists in state, which a matter still
 * being drafted does not. So the draft is assembled into a `BoardProposal`
 * shape — never written anywhere — and run through the engine's own
 * `assessDirector`, which is pure with respect to the draft: it reads traits,
 * mandate, the relationship with the chief executive and any live conditional
 * commitment, and returns a stance with its reasoning.
 *
 * The two lines this file adds on top are the weighted count and the threshold
 * comparison, both restated from `boards/tally.ts`. The real vote is the
 * engine's, in the board-resolution phase; this is what a founder would get from
 * ringing round before the meeting.
 */

import type {
  Board,
  BoardProposal,
  BoardProposalKind,
  SessionState,
  VoteStance,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE } from '@frontier/contracts';
import { assessDirector, thresholdFor } from '@frontier/simulation';

export interface WhipLine {
  readonly characterId: string;
  readonly stance: VoteStance;
  readonly recused: boolean;
  readonly weight: number;
  readonly rationale: string;
  readonly honouredCommitmentId: string | null;
  /** Position on a -1..1 scale after any binding commitment. */
  readonly value: number;
}

export interface WhipCount {
  readonly lines: readonly WhipLine[];
  readonly support: number;
  readonly against: number;
  readonly abstain: number;
  readonly absent: number;
  readonly threshold: number;
  readonly quorumMet: boolean;
  readonly carries: boolean;
}

export interface DraftProposal {
  readonly kind: BoardProposalKind;
  readonly title: string;
  readonly summary: string;
  readonly amountUsd: number | null;
  readonly targetCompanyId: string | null;
  readonly stockComponentPct: number | null;
}

/** The in-memory `BoardProposal` a draft would become if it were tabled now. */
export function hypotheticalProposal(
  session: SessionState,
  board: Board,
  proposedByCharacterId: string,
  draft: DraftProposal,
): BoardProposal {
  return {
    id: `prp_preview_${board.id}`,
    companyId: board.companyId,
    boardId: board.id,
    kind: draft.kind,
    title: draft.title.length >= 3 ? draft.title.slice(0, 140) : 'Untitled matter',
    summary: draft.summary.slice(0, 1200),
    proposedByCharacterId,
    quarterProposed: session.quarter,
    decisionQuarter: session.quarter,
    status: 'tabled',
    amountUsd: draft.amountUsd,
    dilutionPct: null,
    stockComponentPct: draft.stockComponentPct,
    targetCompanyId: draft.targetCompanyId,
    linkedActionId: null,
    requiredThresholdFraction: 0,
  };
}

/** Run every seated director over a proposal and count the room. */
export function whipCount(session: SessionState, board: Board, proposal: BoardProposal): WhipCount {
  const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
  const lines: WhipLine[] = [];

  let support = 0;
  let against = 0;
  let abstain = 0;
  let absent = 0;
  let chairSupports = false;

  for (const director of board.directors) {
    const assessment = assessDirector(session, proposal, director);
    const weight = Math.max(0, Math.min(5, director.votingWeight));
    if (assessment.recused) absent += weight;
    else if (assessment.stance === 'support') support += weight;
    else if (assessment.stance === 'oppose') against += weight;
    else abstain += weight;

    if (director.isChair && !assessment.recused && assessment.stance === 'support') chairSupports = true;

    lines.push({
      characterId: director.characterId,
      stance: assessment.stance,
      recused: assessment.recused,
      weight,
      rationale: assessment.recused ? 'Recused: the matter concerns me personally.' : assessment.rationale,
      honouredCommitmentId: assessment.honouredCommitmentId,
      value: assessment.value,
    });
  }

  const totalWeight = board.directors.reduce((total, director) => total + Math.max(0, Math.min(5, director.votingWeight)), 0);
  const present = support + against + abstain;
  const quorumMet = totalWeight <= 0 ? false : present / totalWeight >= rule.minPresentFraction;
  const threshold = thresholdFor(board, proposal);
  const cast = support + against;

  let carries = false;
  if (quorumMet && cast > 0) {
    carries = support / cast >= threshold;
    if (!carries && Math.abs(support - against) < 1e-9 && rule.chairBreaksTies && chairSupports) carries = true;
  }

  return { lines, support, against, abstain, absent, threshold, quorumMet, carries };
}

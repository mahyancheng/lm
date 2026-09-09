/**
 * @frontier/simulation — capital/rounds.ts
 *
 * Closing a term sheet a company accepted.
 *
 * A term sheet is offered in quarter *t* and answerable only in *t+1*, so by the
 * time this runs the acceptance is an ordinary `accept_deal` that the deal
 * router has already recorded. What is left is the round itself, and it closes
 * through exactly the shape `resolveFundingRounds` writes — `funding_round_closed`
 * plus `shares_issued`, cash and equity moving together — with two differences
 * that are the whole point of the subsystem:
 *
 * - the holder is the **real fund**, so the shares land on the cap table at the
 *   id the entity already is; and
 * - `leadInvestorCharacterId` is the **real partner**, so the round has a person
 *   attached to it who can be lobbied, thanked and disappointed later.
 *
 * Both movements are read by the equity reconstruction (`funding_round_closed`
 * carries `amountUsd`), so the quarter still commits.
 */

import type { CapitalEntity, Company, DealProposal, FundingRound, ResolverContext, SessionState } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { addShares, holderPct, setIssued } from '../resolver/capital';
import { compactUsd, moveDryPowder } from './context';

/** What a closed sponsor round produced, for the caller's report line. */
export interface ClosedSponsorRound {
  readonly round: FundingRound;
  readonly eventId: string;
  readonly dryPowderDeltaUsd: number;
  readonly stakePctAfter: number;
}

/**
 * Close one accepted term sheet.
 *
 * Returns null when the company, register or security has gone since the sheet
 * was written, or when the fund can no longer fund it — a lapsed offer, never a
 * half-settled one.
 */
export function closeSponsorRound(
  draft: SessionState,
  ctx: ResolverContext,
  entity: CapitalEntity,
  company: Company,
  deal: DealProposal,
  terms: { stage: FundingRound['stage']; amountUsd: number; preMoneyUsd: number; boardSeats: number },
): ClosedSponsorRound | null {
  const table = draft.capTables.find((candidate) => candidate.companyId === company.id) ?? null;
  const security =
    draft.securities.find((candidate) => candidate.id === company.primarySecurityId) ??
    draft.securities.find((candidate) => candidate.companyId === company.id) ??
    null;
  const shareClass = table?.shareClasses.find((klass) => klass.id === security?.shareClassId) ?? table?.shareClasses[0] ?? null;
  if (table === null || security === null || shareClass === null) return null;

  const amount = Math.min(Math.round(terms.amountUsd), entity.dryPowderUsd);
  if (amount <= 0) return null;

  const preMoney = Math.max(1, Math.round(terms.preMoneyUsd));
  const postMoney = preMoney + amount;
  const dilution = amount / postMoney;
  const pricePerShare = table.fullyDilutedShares > 0 ? preMoney / table.fullyDilutedShares : 1;
  const newShares = Math.max(1, Math.round(amount / Math.max(pricePerShare, 1e-6)));

  addShares(table, {
    securityId: security.id,
    holderId: entity.id,
    holderKind: 'fund',
    shares: newShares,
    costUsd: amount,
    quarter: draft.quarter,
    lockupUntilQuarter: null,
  });
  // A priced round amends the charter as part of closing it: the acceptance that
  // authorised the money authorised the shares that carry it. This is not the
  // rule a rights plan has to obey — there a company dilutes a raider it did not
  // agree terms with, and the issue is refused rather than authorised.
  shareClass.authorisedShares = Math.max(shareClass.authorisedShares, shareClass.issuedShares + newShares);
  setIssued(table, shareClass, shareClass.issuedShares + newShares, draft.quarter);

  company.financials.cash += amount;
  company.balanceSheet.assets.cash += amount;
  company.balanceSheet.equity += amount;

  const dryPowderDeltaUsd = moveDryPowder(entity, -amount);

  const roundId = makeId('rnd', company.id, draft.quarter, terms.stage, entity.id);
  const round: FundingRound = {
    id: roundId,
    companyId: company.id,
    stage: terms.stage,
    amount,
    preMoney,
    postMoney,
    dilution,
    pricePerShareUsd: pricePerShare,
    shareClassId: shareClass.id,
    // The sentence this whole module exists to write.
    leadInvestorCharacterId: entity.partnerCharacterIds[0] ?? null,
    participantHolderIds: [entity.id],
    boardSeatsGranted: terms.boardSeats,
    closedQuarter: draft.quarter,
    status: 'closed',
  };
  draft.fundingRounds.push(round);

  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter: draft.quarter,
    type: 'funding_round_closed',
    actorId: company.id,
    targetId: roundId,
    payload: {
      stage: terms.stage,
      amountUsd: amount,
      preMoney,
      postMoney,
      dilution: Math.round(dilution * 10_000) / 10_000,
      pricePerShareUsd: Math.round(pricePerShare * 1e6) / 1e6,
      newShares,
      dealKind: 'term_sheet',
      dealId: deal.id,
      entityId: entity.id,
      leadInvestorCharacterId: round.leadInvestorCharacterId,
      // The dry-powder half of the movement, declared on the row that caused it.
      dryPowderDeltaUsd,
    },
    visibility: 'public',
  });
  ctx.emit({
    sessionId: draft.sessionId,
    quarter: draft.quarter,
    type: 'shares_issued',
    actorId: company.id,
    targetId: security.id,
    payload: { shares: newShares, holderId: entity.id, shareClassId: shareClass.id, reason: 'funding_round', roundId },
    visibility: 'public',
  });

  if (terms.boardSeats > 0) grantInvestorSeat(draft, company, entity);

  ctx.log({
    phase: 'capital_resolution',
    text: `${company.name} closed ${compactUsd(amount)} from ${entity.name} at a ${compactUsd(postMoney)} post-money, selling ${Math.round(dilution * 100)}%.`,
    deltaLabel: `-${Math.round(dilution * 100)}% founder`,
    refEventIds: [eventId],
    tone: 'positive',
    subjectId: company.id,
  });

  return { round, eventId, dryPowderDeltaUsd, stakePctAfter: holderPct(table, security.id, shareClass.id, entity.id) };
}

/**
 * Seat the fund's partner on the board the round bought a seat on.
 *
 * An ordinary `Director` row whose `representedHolderId` is the entity id, which
 * is what makes the seat vote through the existing tally: no new governance
 * machinery, and the partner is a person the player can lobby.
 */
export function grantInvestorSeat(draft: SessionState, company: Company, entity: CapitalEntity): boolean {
  if (company.boardId === null) return false;
  const board = draft.boards.find((candidate) => candidate.id === company.boardId);
  const partnerId = entity.partnerCharacterIds[0];
  if (board === undefined || partnerId === undefined) return false;
  if (board.directors.some((director) => director.characterId === partnerId)) return false;
  if (board.directors.length >= board.seatsAuthorised) return false;

  board.directors.push({
    characterId: partnerId,
    seat: 'investor',
    // An investor director is independent of management by construction, holds
    // the fund's risk appetite, and cares about the balance sheet in proportion
    // to how little of it the fund's money is left.
    independence: 78,
    riskTolerance: entity.riskAppetite,
    growthPreference: entity.kind === 'vc' ? 72 : 38,
    financialDiscipline: entity.kind === 'vc' ? 46 : 82,
    techKnowledge: 58,
    safetyOrientation: 44,
    relationshipWithCeo: 10,
    mandate: 'investor_return',
    votingWeight: 1,
    isChair: false,
    appointedQuarter: draft.quarter,
    representedHolderId: entity.id,
    committees: [],
  });
  return true;
}

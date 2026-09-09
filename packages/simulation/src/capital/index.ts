/**
 * @frontier/simulation — capital
 *
 * Venture, buyout, hedge and sovereign funds as actors rather than furniture.
 *
 * The whole subsystem rests on one sentence: **`CapitalEntity.id` is the
 * cap-table holder id**. A fund is not a new owner; it is the thing that was
 * always at the other end of those `holderKind: 'fund'` holdings. That is why
 * there is no second ownership ledger, why every fund vote is already counted by
 * the board tally, and why every fund block is already reachable by a raider at
 * a premium.
 *
 * The second sentence is the one that keeps the quarter committing: a fund may
 * move a company's equity **only** through a row the financial-integrity
 * reconstruction already reads — `funding_round_closed`, `shares_issued`,
 * `shares_traded`, `acquisition_completed`, `dividend_paid`, `debt_issued`.
 * Everything a fund does to its own books touches no company balance sheet at
 * all, and declares its own cash movement as `dryPowderDeltaUsd` for
 * `capital_integrity` to reconstruct.
 */

export { createCapitalDesksSubsystem } from './desks';
export {
  capitalDesksEnabled,
  deployableUsd,
  deployedUsd,
  deskContext,
  estimatedValuationUsd,
  floatSharesOf,
  holdingsOf,
  markValueUsd,
  moveDryPowder,
  navUsd,
  reservedFloorUsd,
  stakeFractionOf,
  type DeskContext,
} from './context';
export { pickLeadInvestor, maxChequeUsd, type LeadInvestor } from './leads';
export { closeSponsorRound, grantInvestorSeat } from './rounds';
export { sourcingScore, targetScore, convictionFor, valuationGapPct, newsScore, nextStageFor, stageFitFor } from './scores';
export { runVentureDesk, termSheetTerms, termSheetOf, partnerGoalFor, rivalAcceptsTermSheet } from './vc';
export { runBuyoutDesk, buyoutOf, liveApproaches, lboFinancing, controlledCompanies, offerReferenceUsd, offerValueAt, whiteKnightAccepts } from './pe';
export { runHedgeDesk, runActivism, positionNotionalUsd, sharesShortIn, demandsFor } from './hedge';
export { settleCapitalOrders } from './orders';
export { settleShortBook, coverPosition, type ShortInterestSnapshot } from './shorts';
export { renderPartnerRemark, voiceOf, partnerNameOf, type PartnerVoice } from './voice';

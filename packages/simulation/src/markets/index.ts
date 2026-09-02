/**
 * @frontier/simulation — markets
 *
 * The in-world exchange: valuation anchors, market beliefs, the quarterly return
 * model and trade settlement.
 *
 * Two hard rules govern everything in this directory.
 *
 * 1. **Reality is not ours to modify.** Reference instruments (`isReference`)
 *    are never priced, never targeted and never mutated. A reference quote is a
 *    fact we display.
 * 2. **Markets price beliefs, not the database.** The only path from canonical
 *    private reality to a share price runs through `disclosures` →
 *    `updateBeliefs` → `publicInfoEffect`. Nothing in this directory reads a
 *    company's private research, undisclosed holdings or unpublished results.
 *
 * The phase runs in one order and it matters: beliefs move on the quarter's
 * disclosures, then prices are struck against the new information set, then
 * trades settle against those prices.
 */

import type {
  MarketsSubsystem,
  ResolverContext,
  ReturnDecomposition,
  SessionState,
  ValuationAnchor,
} from '@frontier/contracts';
import { CONTROL_DECISIVE_PCT, CONTROL_INFORMATION_PCT, returnDecompositionSums } from '@frontier/contracts';
import { companyTransientMetrics } from '../economy/scope';
import { round } from '../economy/util';
import { computeValuationAnchor, selectValuationMethod } from './valuation';
import { runBeliefUpdate } from './beliefs';
import { runPricing } from './pricing';
import { runSettlement } from './settlement';

export { computeValuationAnchor, selectValuationMethod } from './valuation';
export { runBeliefUpdate, TOPIC_META, assertedProbability } from './beliefs';
export type { BeliefChange, TopicMeta } from './beliefs';
export {
  runPricing,
  marketFactor,
  sectorFactor,
  MIN_PRICE_USD,
  MAX_ABS_LOG_RETURN,
  V2_ANCHOR_PULL,
  V2_MAX_ABS_LOG_RETURN,
  V2_NOISE_SIGMA_CAP,
  V2_SHOCK_BAND,
  V2_SHOCK_MAX_ABS_LOG_RETURN,
  V2_SHOCK_PROBABILITY,
} from './pricing';
export type { PricedInstrument, PriceShock } from './pricing';
export {
  FUNDAMENTAL_CONFIDENCE,
  GROWTH_AT_BOTTOM_OF_BAND,
  GROWTH_AT_TOP_OF_BAND,
  GROWTH_QUALITY_WEIGHT,
  MIN_TRAILING_REVENUE_USD,
  MULTIPLE_INDEX_BOUNDS,
  fundamentalValueUsd,
  multipleIndex,
  qualityScore,
  sectorRevenueMultiple,
} from './fundamentalValue';
export type { FundamentalValue } from './fundamentalValue';
export { FUNDAMENTAL_ANCHOR_WEIGHT } from './valuation';
export { runSettlement, DISCLOSURE_THRESHOLD_PCT } from './settlement';
export type { TradeSettlement } from './settlement';

/** Belief moves smaller than this are bookkeeping, not news. */
const BELIEF_REPORT_THRESHOLD = 0.05;

/** Price moves smaller than this do not earn a line in the report. */
const PRICE_REPORT_THRESHOLD = 0.02;

export function createMarketsSubsystem(): MarketsSubsystem {
  /* ------------------------------ valuation ------------------------------- */

  function refreshAnchors(draft: SessionState, ctx: ResolverContext): Map<string, ValuationAnchor> {
    const anchors = new Map<string, ValuationAnchor>();
    const companies = draft.companies
      .filter((company) => company.isActive)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const company of companies) {
      const computed = computeValuationAnchor(draft, company.id);
      const anchor: ValuationAnchor = { ...computed, quarter: ctx.quarter };
      anchors.set(company.id, anchor);

      const previous = draft.valuationAnchors.find((entry) => entry.companyId === company.id) ?? null;
      draft.valuationAnchors = [...draft.valuationAnchors.filter((entry) => entry.companyId !== company.id), anchor];

      ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'valuation_anchor_updated',
        actorId: null,
        targetId: company.id,
        payload: {
          method: anchor.method,
          anchorValueUsd: anchor.anchorValueUsd,
          perShareValueUsd: anchor.perShareValueUsd,
          confidence: anchor.confidence,
          previousAnchorValueUsd: previous?.anchorValueUsd ?? null,
          inputs: anchor.inputs,
        },
        visibility: company.isPublic ? 'public' : 'company',
      });
    }
    return anchors;
  }

  /* -------------------------------- beliefs ------------------------------- */

  function updateBeliefs(draft: SessionState, ctx: ResolverContext): void {
    for (const change of runBeliefUpdate(draft, ctx.quarter)) {
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'belief_updated',
        actorId: null,
        targetId: change.belief.subjectId,
        payload: {
          beliefId: change.belief.id,
          topic: change.belief.topic,
          subjectKind: change.belief.subjectKind,
          before: round(change.before, 6),
          after: round(change.after, 6),
          weight: change.weight,
          source: change.source,
          evidenceId: change.evidenceId,
        },
        visibility: 'public',
      });

      if (Math.abs(change.after - change.before) >= BELIEF_REPORT_THRESHOLD) {
        const direction = change.after > change.before ? 'rose' : 'fell';
        ctx.log({
          phase: 'market_resolution',
          text: `Market probability of ${change.belief.topic.replace(/_/g, ' ')} for ${change.belief.subjectId} ${direction} from ${round(
            change.before * 100,
            1,
          )}% to ${round(change.after * 100, 1)}%.`.slice(0, 300),
          deltaLabel: `${change.after > change.before ? '+' : ''}${round((change.after - change.before) * 100, 1)}pp`,
          refEventIds: [eventId],
          tone: change.after > change.before ? 'warning' : 'neutral',
          subjectId: change.belief.subjectKind === 'company' ? change.belief.subjectId : null,
        });
      }
    }
  }

  /* -------------------------------- pricing ------------------------------- */

  function priceMarket(draft: SessionState, ctx: ResolverContext): ReturnDecomposition[] {
    const anchors = refreshAnchors(draft, ctx);
    const transient = companyTransientMetrics(draft, ctx.quarter);
    const sentiment: Record<string, number> = {};
    for (const [companyId, metrics] of Object.entries(transient)) {
      sentiment[companyId] = metrics.valuationSentiment;
    }

    const priced = runPricing(draft, ctx.quarter, ctx.rng, anchors, sentiment);
    const decompositions: ReturnDecomposition[] = [];

    for (const entry of priced) {
      // Structural invariant, asserted continuously rather than at commit.
      const sums = returnDecompositionSums(entry.decomposition);
      draft.quotes = [
        ...draft.quotes.filter((quote) => !(quote.instrumentId === entry.instrument.id && quote.quarter === ctx.quarter)),
        entry.quote,
      ];

      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'market_priced',
        actorId: null,
        targetId: entry.instrument.id,
        payload: {
          companyId: entry.decomposition.companyId,
          symbol: entry.instrument.symbol,
          kind: entry.instrument.kind,
          priceBefore: entry.decomposition.priceBefore,
          priceAfter: entry.decomposition.priceAfter,
          return: entry.quote.return,
          volume: entry.quote.volume,
          marketCapUsd: entry.quote.marketCapUsd,
          decomposition: {
            marketBeta: entry.decomposition.marketBeta,
            sectorBeta: entry.decomposition.sectorBeta,
            fundamentalAlpha: entry.decomposition.fundamentalAlpha,
            publicInfoEffect: entry.decomposition.publicInfoEffect,
            sentimentEffect: entry.decomposition.sentimentEffect,
            liquidityEffect: entry.decomposition.liquidityEffect,
            noise: entry.decomposition.noise,
            total: entry.decomposition.total,
          },
          componentsReconcile: sums,
          floored: entry.floored,
          shock: entry.shock === null ? null : { magnitude: round(entry.shock.magnitude, 6), reason: entry.shock.reason },
        },
        visibility: 'public',
      });

      // A dislocation is the only thing permitted to move a world-version-2 price
      // past the ordinary bound, so it gets its own row. The invariant gate reads
      // these rows: a move past the bound with no row behind it fails the quarter.
      if (entry.shock !== null) {
        const shockId = ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'sentiment_shifted',
          actorId: null,
          targetId: entry.instrument.id,
          payload: {
            kind: 'price_shock',
            instrumentId: entry.instrument.id,
            companyId: entry.instrument.companyId,
            magnitude: round(entry.shock.magnitude, 6),
            reason: entry.shock.reason,
            priceBefore: entry.decomposition.priceBefore,
            priceAfter: entry.decomposition.priceAfter,
          },
          visibility: 'public',
        });
        ctx.log({
          phase: 'market_resolution',
          text: `${entry.instrument.symbol} was dislocated: ${entry.shock.reason}`.slice(0, 300),
          deltaLabel: `${entry.shock.magnitude >= 0 ? '+' : ''}${round(entry.shock.magnitude * 100, 1)}%`,
          refEventIds: [shockId],
          tone: entry.shock.magnitude >= 0 ? 'warning' : 'negative',
          subjectId: entry.instrument.companyId,
        });
      }

      decompositions.push(entry.decomposition);

      if (Math.abs(entry.quote.return) >= PRICE_REPORT_THRESHOLD || entry.floored) {
        const largest = largestComponent(entry.decomposition);
        ctx.log({
          phase: 'market_resolution',
          text: `${entry.instrument.symbol} ${entry.quote.return >= 0 ? 'rose' : 'fell'} to ${round(entry.quote.price, 2)}${
            entry.floored ? ' (floored; the company is distressed)' : ''
          }, driven mostly by ${largest}.`.slice(0, 300),
          deltaLabel: `${entry.quote.return >= 0 ? '+' : ''}${round(entry.quote.return * 100, 1)}%`,
          refEventIds: [eventId],
          tone: entry.floored ? 'warning' : entry.quote.return >= 0 ? 'positive' : 'negative',
          subjectId: entry.instrument.companyId,
        });
      }
    }

    // Keep live state bounded; the ledger and snapshots hold the full history.
    const cutoff = ctx.quarter - draft.quoteHistoryQuarters;
    draft.quotes = draft.quotes.filter((quote) => quote.quarter > cutoff);

    return decompositions;
  }

  /* ------------------------------ settlement ------------------------------ */

  function settleTrades(draft: SessionState, ctx: ResolverContext): void {
    for (const settlement of runSettlement(draft, ctx.quarter)) {
      if (settlement.settledShares <= 0) {
        const rejectedId = ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'action_rejected',
          actorId: settlement.action.actorCompanyId,
          targetId: settlement.securityId,
          payload: { actionId: settlement.action.actionId, side: settlement.side, code: settlement.rejectionCode, detail: settlement.detail },
          visibility: 'company',
        });
        ctx.log({
          phase: 'market_resolution',
          text: `A ${settlement.side} order in ${settlement.securityId} did not execute: ${settlement.detail}`.slice(0, 300),
          deltaLabel: null,
          refEventIds: [rejectedId],
          tone: 'warning',
          subjectId: settlement.action.actorCompanyId,
        });
        continue;
      }

      const disclosed = settlement.ownershipPctAfter >= 0.05;
      const tradeId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'shares_traded',
        actorId: settlement.action.actorCompanyId,
        targetId: settlement.securityId,
        payload: {
          actionId: settlement.action.actionId,
          side: settlement.side,
          shares: settlement.settledShares,
          requestedShares: settlement.requestedShares,
          pricePerShare: settlement.pricePerShare,
          considerationUsd: settlement.considerationUsd,
          issuerCompanyId: settlement.companyId,
          ownershipPctBefore: settlement.ownershipPctBefore,
          ownershipPctAfter: settlement.ownershipPctAfter,
          // Slippage is a decision, not a surprise: the quote, what the order
          // actually executed at, and what its own size cost.
          quotePriceUsd: settlement.quotePriceUsd,
          executionPriceUsd: settlement.executionPriceUsd,
          impactPct: settlement.impactPct,
          floatShares: settlement.floatShares,
          blockShares: settlement.blockShares,
          blockPremiumApplied: settlement.blockShares > 0,
        },
        visibility: disclosed ? 'public' : 'company',
      });

      ctx.log({
        phase: 'market_resolution',
        text: `${settlement.action.actorCompanyId} ${settlement.side === 'buy' ? 'acquired' : 'sold'} ${settlement.settledShares} shares of ${
          settlement.companyId
        } at ${round(settlement.pricePerShare, 2)}.`.slice(0, 300),
        deltaLabel: `${round(settlement.ownershipPctAfter * 100, 2)}%`,
        refEventIds: [tradeId],
        tone: 'neutral',
        subjectId: settlement.companyId,
      });

      for (const threshold of settlement.crossedThresholds) {
        const crossedId = ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'ownership_threshold_crossed',
          actorId: settlement.action.actorCompanyId,
          targetId: settlement.companyId,
          payload: {
            threshold,
            securityId: settlement.securityId,
            ownershipPct: settlement.ownershipPctAfter,
            grantsControl: settlement.ownershipPctAfter > CONTROL_DECISIVE_PCT,
            grantsInformationRight: settlement.ownershipPctAfter >= CONTROL_INFORMATION_PCT,
          },
          visibility: threshold === 'strategic_holding' ? 'company' : 'public',
        });
        ctx.log({
          phase: 'market_resolution',
          text: `${settlement.action.actorCompanyId} crossed the ${threshold.replace(/_/g, ' ')} threshold in ${settlement.companyId}.`.slice(0, 300),
          deltaLabel: `${round(settlement.ownershipPctAfter * 100, 2)}%`,
          refEventIds: [crossedId],
          tone: 'warning',
          subjectId: settlement.companyId,
        });
      }
    }
  }

  return {
    computeValuationAnchor: (draft: SessionState, companyId: string): ValuationAnchor => computeValuationAnchor(draft, companyId),
    updateBeliefs,
    priceMarket,
    settleTrades,
  };
}

/** Which term explains most of a move, for the one-line report summary. */
function largestComponent(decomposition: ReturnDecomposition): string {
  const entries: readonly [string, number][] = [
    ['the market factor', decomposition.marketBeta],
    ['its sector', decomposition.sectorBeta],
    ['the pull toward fundamental value', decomposition.fundamentalAlpha],
    ['information that became public', decomposition.publicInfoEffect],
    ['sentiment', decomposition.sentimentEffect],
    ['trading flow', decomposition.liquidityEffect],
    ['idiosyncratic noise', decomposition.noise],
  ];
  let best: readonly [string, number] = entries[0] ?? ['idiosyncratic noise', 0];
  for (const entry of entries) {
    if (Math.abs(entry[1]) > Math.abs(best[1])) best = entry;
  }
  return best[0];
}

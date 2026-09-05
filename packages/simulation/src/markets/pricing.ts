/**
 * @frontier/simulation — markets/pricing.ts
 *
 * The quarterly return model.
 *
 * ```text
 * r_{i,t} = β_m·M_t + β_s·S_t + α_fundamental + E_public + N_sentiment
 *           + L_liquidity + σ_i·ε
 *
 * P_{i,t+1} = P_{i,t} · e^{r_{i,t}}
 * ```
 *
 * Fundamentals pull the price toward the valuation anchor over several quarters;
 * public information, sentiment, flow and volatility create the short-term
 * deviations. Every term is stored in a `ReturnDecomposition`, and the eight
 * fields (seven components plus the total) **must** satisfy
 * `returnDecompositionSums` — the components are reconciled against the applied
 * total before the decomposition is returned, including when the price floor
 * truncates the move. That invariant is why the Markets screen can always answer
 * "why did my stock move?" from committed rows rather than from a narrator.
 *
 * Index instruments do not draw their own noise: their return is the
 * market-capitalisation-weighted average of their constituents, component by
 * component, so an index move decomposes into exactly the same seven reasons.
 */

import type {
  DominantNarrative,
  MarketInstrument,
  Quote,
  ReturnDecomposition,
  SeededRng,
  SessionState,
  ValuationAnchor,
} from '@frontier/contracts';
import { TOPIC_META } from './beliefs';
import { clamp, clamp01, round, standardNormal } from '../economy/util';
import { isMultiSectorWorld } from '../economy/sectors';

/** In-world prices are floored, never negative and never NaN. */
export const MIN_PRICE_USD = 0.01;

/** Largest permitted single-quarter log return, applied by scaling every component. */
export const MAX_ABS_LOG_RETURN = 0.6;

/* -------------------------------------------------------------------------- */
/*  World version 2: prices that behave like prices                            */
/* -------------------------------------------------------------------------- */

/**
 * Largest ordinary single-quarter log return in world version 2. About 20%: a
 * bad quarter, not a catastrophe. Anything larger has to be a *shock*, and a
 * shock writes its own ledger row, so the Markets screen can always name the
 * reason a stock moved more than a fifth in one quarter.
 */
export const V2_MAX_ABS_LOG_RETURN = 0.18;

/** The bound a shocked instrument is held to instead. Roughly -36% to +57%. */
export const V2_SHOCK_MAX_ABS_LOG_RETURN = 0.45;

/** Speed at which a version-2 price is pulled toward its anchor. Harder than v1. */
export const V2_ANCHOR_PULL = 0.34;

/** Ceiling on the idiosyncratic volatility term, before beta scaling. */
export const V2_NOISE_SIGMA_CAP = 0.045;

/**
 * Chance an instrument is dislocated in a quarter, drawn per instrument from its
 * own stream. Once every twenty-five quarters per name is roughly one dislocation
 * a quarter across a twenty-four company market — frequent enough to be part of
 * the game, rare enough that a price is normally explained by its business.
 */
export const V2_SHOCK_PROBABILITY = 0.04;

/** How hard a shock hits, as a log return before the shock bound clamps it. */
export const V2_SHOCK_BAND = { min: 0.2, max: 0.44 } as const;

/** A dislocation that let one instrument move past the ordinary bound. */
export interface PriceShock {
  /** Signed log return the shock contributed. */
  readonly magnitude: number;
  /** Why the market dislocated, for the ledger row and the report line. */
  readonly reason: string;
}

/** Fallback opening price for an instrument with no quote history. */
const DEFAULT_EQUITY_PRICE = 100;
const DEFAULT_INDEX_LEVEL = 1000;

/** Speed at which price is pulled toward the anchor. Several quarters, not one. */
const ANCHOR_PULL = 0.22;

const NARRATIVE_BIAS: Record<DominantNarrative, number> = {
  ai_optimism: 1,
  productivity_miracle: 0.8,
  bubble_concern: -0.7,
  safety_alarm: -0.8,
  labour_disruption: -0.4,
  concentration_backlash: -0.5,
  geopolitical_race: 0.1,
  energy_backlash: -0.3,
  scandal_cycle: -0.6,
  neutral: 0,
};

/* -------------------------------------------------------------------------- */
/*  Factors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The in-world market factor: one number per quarter, shared by every
 * instrument and scaled by each instrument's beta.
 */
export function marketFactor(state: SessionState): number {
  const w = state.world;
  const raw =
    0.02 * (w.capitalMarkets.riskAppetite - 0.5) * 2 +
    0.6 * (w.macro.gdpGrowth - 0.024) -
    1.2 * (w.macro.policyRate - 0.035) -
    0.8 * (w.macro.creditSpreads - 0.015) +
    0.015 * (w.capitalMarkets.ipoWindow - 0.5);
  return clamp(raw, -0.12, 0.12);
}

/** The sector factor for one sector id. */
export function sectorFactor(state: SessionState, sectorId: string | null): number {
  if (sectorId === null) return 0;
  const sector = state.sectors[sectorId];
  if (sector === undefined) return 0;
  const raw = 0.05 * sector.sentiment + 0.04 * (sector.demand - 0.5) * 2 + 0.03 * (sector.multiple - 1);
  return clamp(raw, -0.1, 0.1);
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                    */
/* -------------------------------------------------------------------------- */

export interface PricedInstrument {
  readonly instrument: MarketInstrument;
  readonly decomposition: ReturnDecomposition;
  readonly quote: Quote;
  /** True when the price floor truncated the move and the company is distressed. */
  readonly floored: boolean;
  /**
   * The dislocation that permitted a move past the ordinary bound, or null. Only
   * ever set in world version 2; the caller must write a ledger row for it, which
   * is what makes "no price moves more than the bound without a recorded reason"
   * a checkable invariant rather than a promise.
   */
  readonly shock: PriceShock | null;
}

interface Components {
  marketBeta: number;
  sectorBeta: number;
  fundamentalAlpha: number;
  publicInfoEffect: number;
  sentimentEffect: number;
  liquidityEffect: number;
  noise: number;
}

const zeroComponents = (): Components => ({
  marketBeta: 0,
  sectorBeta: 0,
  fundamentalAlpha: 0,
  publicInfoEffect: 0,
  sentimentEffect: 0,
  liquidityEffect: 0,
  noise: 0,
});

const sumComponents = (c: Components): number =>
  c.marketBeta + c.sectorBeta + c.fundamentalAlpha + c.publicInfoEffect + c.sentimentEffect + c.liquidityEffect + c.noise;

/** Scale every component so they sum to `target`, then absorb float dust into noise. */
function reconcile(c: Components, target: number): void {
  const sum = sumComponents(c);
  if (sum !== 0 && Number.isFinite(sum)) {
    const factor = target / sum;
    c.marketBeta *= factor;
    c.sectorBeta *= factor;
    c.fundamentalAlpha *= factor;
    c.publicInfoEffect *= factor;
    c.sentimentEffect *= factor;
    c.liquidityEffect *= factor;
    c.noise *= factor;
  }
  c.noise += target - sumComponents(c);
}

/** The most recent quote strictly before `quarter`, or the one at `quarter` as a fallback. */
function priorPrice(state: SessionState, instrumentId: string, quarter: number): { price: number; volume: number } | null {
  let best: Quote | null = null;
  for (const quote of state.quotes) {
    if (quote.instrumentId !== instrumentId) continue;
    if (quote.quarter < quarter && (best === null || quote.quarter > best.quarter)) best = quote;
  }
  if (best === null) {
    for (const quote of state.quotes) {
      if (quote.instrumentId === instrumentId && quote.quarter === quarter) best = quote;
    }
  }
  return best === null ? null : { price: best.price, volume: best.volume };
}

/** Net shares this quarter's submitted trades would move in `securityId`. */
function netTradeFlow(state: SessionState, securityId: string | null, sharesOutstanding: number): number {
  if (securityId === null) return 0;
  let net = 0;
  for (const action of state.pendingActions) {
    const intent = action.intent;
    if (intent.type === 'buy_shares' && intent.securityId === securityId) {
      net += intent.shares ?? (intent.targetPct ?? 0) * sharesOutstanding;
    } else if (intent.type === 'sell_shares' && intent.securityId === securityId) {
      net -= intent.shares;
    }
  }
  return net;
}

/** Information that became public this quarter, as a return contribution. */
function publicInformationEffect(state: SessionState, companyId: string | null, quarter: number): number {
  let effect = 0;
  for (const belief of state.beliefs) {
    if (belief.lastUpdatedQuarter !== quarter) continue;
    const meta = TOPIC_META[belief.topic];
    if (meta === undefined) continue;
    const delta = belief.probability - belief.priorProbability;
    if (delta === 0) continue;
    if (companyId !== null && belief.subjectId === companyId) {
      effect += meta.priceImpact * delta;
    } else if (belief.subjectKind === 'world') {
      // A belief about the whole world moves every name, but less than a belief
      // about this one.
      effect += 0.35 * meta.priceImpact * delta;
    }
  }
  return clamp(effect, -0.25, 0.25);
}

/**
 * Price every in-world instrument for one quarter.
 *
 * Reference instruments are skipped: their prices belong to reality and are not
 * ours to simulate. Equities are priced first in id order, then indices
 * aggregate them, so an index and its constituents can never disagree.
 */
export function runPricing(
  state: SessionState,
  quarter: number,
  rngIn: SeededRng,
  anchors: ReadonlyMap<string, ValuationAnchor>,
  valuationSentiment: Readonly<Record<string, number>>,
): PricedInstrument[] {
  const rng = rngIn.fork(`pricing_q${quarter}`);
  const multiSector = isMultiSectorWorld(state);
  // Forked, never drawn from, in a version-1 session: forking does not advance a
  // parent stream, so the whole version-1 draw sequence is untouched by its
  // existence and a legacy save replays byte-identically.
  const shockRng = rng.fork(`shocks_q${quarter}`);
  const anchorPull = multiSector ? V2_ANCHOR_PULL : ANCHOR_PULL;
  const ordinaryBound = multiSector ? V2_MAX_ABS_LOG_RETURN : MAX_ABS_LOG_RETURN;
  const inWorld = state.marketInstruments.filter((instrument) => !instrument.isReference);
  const equities = inWorld
    .filter((instrument) => instrument.kind === 'in_world_equity')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const indices = inWorld
    .filter((instrument) => instrument.kind === 'in_world_index')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const market = marketFactor(state);
  const narrativeBias = NARRATIVE_BIAS[state.world.media.dominantNarrative] ?? 0;
  const priced: PricedInstrument[] = [];
  const equityWeights = new Map<string, number>();

  for (const instrument of equities) {
    const shares = instrument.sharesOutstanding ?? 0;
    const anchor = instrument.companyId === null ? undefined : anchors.get(instrument.companyId);
    const prior = priorPrice(state, instrument.id, quarter);
    const fallback = anchor?.perShareValueUsd ?? DEFAULT_EQUITY_PRICE;
    const before = Math.max(MIN_PRICE_USD, prior?.price ?? (fallback > 0 ? fallback : DEFAULT_EQUITY_PRICE));
    const priorVolume = prior?.volume ?? 0;

    const c = zeroComponents();
    c.marketBeta = instrument.beta * market;
    c.sectorBeta = (0.5 + 0.5 * instrument.beta) * sectorFactor(state, instrument.sectorId);

    if (anchor !== undefined && anchor.perShareValueUsd !== null && anchor.perShareValueUsd > 0) {
      const gap = clamp(Math.log(anchor.perShareValueUsd / before), -0.8, 0.8);
      c.fundamentalAlpha = anchorPull * gap * clamp01(anchor.confidence);
    }

    c.publicInfoEffect = publicInformationEffect(state, instrument.companyId, quarter);

    const sentiment = instrument.companyId === null ? 0 : valuationSentiment[instrument.companyId] ?? 0;
    c.sentimentEffect = clamp(
      0.08 * sentiment + 0.03 * narrativeBias + 0.03 * (state.world.capitalMarkets.riskAppetite - 0.5),
      -0.15,
      0.15,
    );

    const flow = shares > 0 ? clamp(netTradeFlow(state, instrument.securityId, shares) / shares, -0.5, 0.5) : 0;
    const illiquidity = shares > 0 ? 0.004 * (1 - clamp01(priorVolume / (0.03 * shares))) : 0;
    c.liquidityEffect = clamp(1.2 * flow - illiquidity, -0.1, 0.1);

    const sectorState = instrument.sectorId === null ? undefined : state.sectors[instrument.sectorId];
    const rawSigma =
      (0.02 + 0.1 * state.world.capitalMarkets.volatility + 0.06 * (sectorState?.volatility ?? 0.3)) *
      clamp(0.6 + 0.4 * Math.abs(instrument.beta), 0.5, 2);
    // Version 2 damps idiosyncratic volatility to a few percent a quarter: a
    // share price should be explained by the business and the market, and only
    // rarely by nothing at all.
    const sigma = multiSector ? Math.min(rawSigma, V2_NOISE_SIGMA_CAP) : rawSigma;
    c.noise = sigma * standardNormal(rng);

    // A dislocation is the only thing that lets a version-2 price move further
    // than the ordinary bound, and it is drawn per instrument from its own
    // stream so adding or removing a company cannot shift anybody else's draws.
    let shock: PriceShock | null = null;
    if (multiSector) {
      const own = shockRng.fork(instrument.id);
      if (own.next() < V2_SHOCK_PROBABILITY) {
        const size = own.range(V2_SHOCK_BAND.min, V2_SHOCK_BAND.max);
        const downward = own.next() < 0.5;
        const magnitude = downward ? -size : size;
        shock = {
          magnitude,
          reason: downward
            ? 'A holder liquidated into a thin book and the price gapped down.'
            : 'A block bid cleared the offer and the price gapped up.',
        };
        c.sentimentEffect += magnitude;
      }
    }

    const bound = shock === null ? ordinaryBound : V2_SHOCK_MAX_ABS_LOG_RETURN;
    let total = sumComponents(c);
    if (Math.abs(total) > bound) total = total > 0 ? bound : -bound;

    let after = before * Math.exp(total);
    let floored = false;
    if (!Number.isFinite(after) || after < MIN_PRICE_USD) {
      after = MIN_PRICE_USD;
      floored = true;
      total = Math.log(after / before);
    }
    after = round(after, 6);
    total = Math.log(Math.max(after, MIN_PRICE_USD) / before);
    reconcile(c, total);

    const tradedShares = Math.abs(netTradeFlow(state, instrument.securityId, shares));
    const turnover = clamp(0.015 + 0.06 * Math.abs(total) + 0.04 * state.world.capitalMarkets.volatility, 0, 0.3);
    const volume = Math.max(0, Math.round(turnover * shares + tradedShares));

    equityWeights.set(instrument.id, before * shares);
    priced.push({
      instrument,
      floored,
      shock,
      decomposition: {
        instrumentId: instrument.id,
        companyId: instrument.companyId,
        quarter,
        marketBeta: c.marketBeta,
        sectorBeta: c.sectorBeta,
        fundamentalAlpha: c.fundamentalAlpha,
        publicInfoEffect: c.publicInfoEffect,
        sentimentEffect: c.sentimentEffect,
        liquidityEffect: c.liquidityEffect,
        noise: c.noise,
        total,
        priceBefore: before,
        priceAfter: after,
      },
      quote: {
        instrumentId: instrument.id,
        quarter,
        price: after,
        return: clamp(after / before - 1, -1, 10),
        volume,
        marketCapUsd: shares > 0 ? round(after * shares, 2) : 0,
      },
    });
  }

  for (const instrument of indices) {
    const constituents = priced.filter(
      (entry) => instrument.sectorId === null || entry.instrument.sectorId === instrument.sectorId,
    );
    const prior = priorPrice(state, instrument.id, quarter);
    const before = Math.max(MIN_PRICE_USD, prior?.price ?? DEFAULT_INDEX_LEVEL);

    const c = zeroComponents();
    let weightSum = 0;
    for (const entry of constituents) {
      const weight = Math.max(0, equityWeights.get(entry.instrument.id) ?? 0);
      const effective = weight > 0 ? weight : 1;
      weightSum += effective;
      c.marketBeta += effective * entry.decomposition.marketBeta;
      c.sectorBeta += effective * entry.decomposition.sectorBeta;
      c.fundamentalAlpha += effective * entry.decomposition.fundamentalAlpha;
      c.publicInfoEffect += effective * entry.decomposition.publicInfoEffect;
      c.sentimentEffect += effective * entry.decomposition.sentimentEffect;
      c.liquidityEffect += effective * entry.decomposition.liquidityEffect;
      c.noise += effective * entry.decomposition.noise;
    }
    if (weightSum > 0) {
      c.marketBeta /= weightSum;
      c.sectorBeta /= weightSum;
      c.fundamentalAlpha /= weightSum;
      c.publicInfoEffect /= weightSum;
      c.sentimentEffect /= weightSum;
      c.liquidityEffect /= weightSum;
      c.noise /= weightSum;
    }

    // An index is the weighted average of instruments already bounded, so it can
    // exceed the ordinary bound only when its constituents were shocked.
    const indexShocked = constituents.some((entry) => entry.shock !== null);
    let total = clamp(
      sumComponents(c),
      -(indexShocked ? V2_SHOCK_MAX_ABS_LOG_RETURN : ordinaryBound),
      indexShocked ? V2_SHOCK_MAX_ABS_LOG_RETURN : ordinaryBound,
    );
    let after = before * Math.exp(total);
    let floored = false;
    if (!Number.isFinite(after) || after < MIN_PRICE_USD) {
      after = MIN_PRICE_USD;
      floored = true;
    }
    after = round(after, 6);
    total = Math.log(Math.max(after, MIN_PRICE_USD) / before);
    reconcile(c, total);

    priced.push({
      instrument,
      floored,
      shock: indexShocked ? { magnitude: total, reason: 'A constituent was dislocated and carried the index with it.' } : null,
      decomposition: {
        instrumentId: instrument.id,
        companyId: null,
        quarter,
        marketBeta: c.marketBeta,
        sectorBeta: c.sectorBeta,
        fundamentalAlpha: c.fundamentalAlpha,
        publicInfoEffect: c.publicInfoEffect,
        sentimentEffect: c.sentimentEffect,
        liquidityEffect: c.liquidityEffect,
        noise: c.noise,
        total,
        priceBefore: before,
        priceAfter: after,
      },
      quote: {
        instrumentId: instrument.id,
        quarter,
        price: after,
        return: clamp(after / before - 1, -1, 10),
        volume: 0,
        marketCapUsd: 0,
      },
    });
  }

  return priced;
}

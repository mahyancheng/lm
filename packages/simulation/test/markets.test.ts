import { describe, expect, it } from 'vitest';
import { QuoteSchema, ReturnDecompositionSchema, ValuationAnchorSchema, returnDecompositionSums } from '@frontier/contracts';
import type { PublicDisclosure, SessionState, SubmittedAction } from '@frontier/contracts';
import { createMarketsSubsystem, runBeliefUpdate, runPricing, selectValuationMethod, TOPIC_META } from '../src/markets';
import { computeValuationAnchor } from '../src/markets/valuation';
import { createEconomySubsystem, toActiveModifier } from '../src/economy';
import { cloneState, makeContext, makeRng, makeState } from './_economyMarketsHarness';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function disclosure(overrides: Partial<PublicDisclosure> = {}): PublicDisclosure {
  return {
    id: 'dsc_1',
    companyId: 'cmp_nexus',
    quarter: 1,
    kind: 'rumour',
    headline: 'Frontier programme said to have slipped',
    body: 'Two people familiar with the programme say the next model has slipped a quarter.',
    metrics: {},
    credibility: 0.31,
    sourceCharacterId: null,
    isTruthful: true,
    beliefTopic: 'model_delay',
    ...overrides,
  };
}

function tradeAction(overrides: Partial<SubmittedAction> & { intent: SubmittedAction['intent'] }): SubmittedAction {
  return {
    actionId: 'act_q1_0001',
    sessionId: 'sess_demo_world',
    quarter: 1,
    sequence: 0,
    actorPlayerId: null,
    actorCompanyId: 'cmp_nexus',
    actorCharacterId: 'chr_maya_chen',
    origin: 'player_ui',
    confirmedByHuman: true,
    ...overrides,
  };
}

/** Give an instrument a deep, liquid quote for the quarter being settled. */
function seedLiquidity(state: SessionState, instrumentId: string, quarter: number, price: number, volume: number): void {
  state.quotes = [
    ...state.quotes.filter((quote) => !(quote.instrumentId === instrumentId && quote.quarter === quarter)),
    { instrumentId, quarter, price, return: 0, volume, marketCapUsd: 0 },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Valuation anchors                                                          */
/* -------------------------------------------------------------------------- */

describe('computeValuationAnchor', () => {
  it('chooses a method by maturity and archetype', () => {
    const state = makeState();
    const method = (id: string): string => {
      const company = state.companies.find((candidate) => candidate.id === id);
      expect(company, id).toBeDefined();
      return company === undefined ? 'none' : selectValuationMethod(state, company);
    };

    // Helix and Aurora are asset-heavy infrastructure and silicon.
    expect(method('cmp_helix')).toBe('asset_cashflow_utilisation');
    expect(method('cmp_aurora')).toBe('asset_cashflow_utilisation');
    // Orbit is large, profitable and growing slowly once growth is trimmed.
    const orbit = state.companies.find((candidate) => candidate.id === 'cmp_orbit');
    if (orbit !== undefined) {
      const metrics = state.companyMetrics.find((entry) => entry.companyId === 'cmp_orbit');
      if (metrics !== undefined) metrics.revenueGrowthYoY = 0.12;
      expect(selectValuationMethod(state, orbit)).toBe('earnings_fcf');
    }
    // VectorWorks is a growth company: real revenue, still investing ahead of it.
    expect(method('cmp_vector')).toBe('forward_revenue_quality');
  });

  it('values a pre-revenue frontier laboratory on option value, with low confidence', () => {
    const state = makeState();
    const nexus = state.companies.find((candidate) => candidate.id === 'cmp_nexus');
    const metrics = state.companyMetrics.find((entry) => entry.companyId === 'cmp_nexus');
    expect(nexus).toBeDefined();
    if (nexus === undefined || metrics === undefined) return;
    nexus.financials.revenueQuarterly = 2_000_000;
    metrics.revenueTtm = 8_000_000;

    const anchor = computeValuationAnchor(state, 'cmp_nexus');
    expect(anchor.method).toBe('technology_option_value');
    expect(anchor.anchorValueUsd).toBeGreaterThan(0);
    expect(anchor.confidence).toBeLessThan(0.45);
    expect(anchor.inputs['strategicProbability']).toBeGreaterThan(0);
    ValuationAnchorSchema.parse(anchor);
  });

  it('values an early startup on a revenue multiple', () => {
    const state = makeState();
    const meridian = state.companies.find((candidate) => candidate.id === 'cmp_meridian');
    const metrics = state.companyMetrics.find((entry) => entry.companyId === 'cmp_meridian');
    if (meridian === undefined || metrics === undefined) return;
    meridian.financials.revenueQuarterly = 4_000_000;
    metrics.revenueTtm = 16_000_000;

    const anchor = computeValuationAnchor(state, 'cmp_meridian');
    expect(anchor.method).toBe('revenue_multiple');
    expect(anchor.anchorValueUsd).toBeGreaterThan(0);
    expect(anchor.inputs['survivalProbability']).toBeGreaterThan(0);
  });

  it('produces a finite, non-negative, schema-valid anchor for every seeded company', () => {
    const state = makeState();
    const confidences: Record<string, number> = {};
    for (const company of state.companies) {
      const anchor = computeValuationAnchor(state, company.id);
      ValuationAnchorSchema.parse(anchor);
      expect(Number.isFinite(anchor.anchorValueUsd), company.name).toBe(true);
      expect(anchor.anchorValueUsd, company.name).toBeGreaterThan(0);
      expect(anchor.perShareValueUsd, company.name).not.toBeNull();
      expect(anchor.perShareValueUsd ?? -1, company.name).toBeGreaterThan(0);
      confidences[anchor.method] = anchor.confidence;
    }
    // Cash-flow valuations are trusted more than asset or forward-revenue ones.
    if (confidences['earnings_fcf'] !== undefined && confidences['forward_revenue_quality'] !== undefined) {
      expect(confidences['earnings_fcf']).toBeGreaterThan(confidences['forward_revenue_quality']);
    }
  });

  it('discounts harder when rates and spreads rise', () => {
    const cheap = makeState();
    const dear = makeState();
    dear.world.macro.policyRate = 0.12;
    dear.world.macro.creditSpreads = 0.06;
    const cheapAnchor = computeValuationAnchor(cheap, 'cmp_vector');
    const dearAnchor = computeValuationAnchor(dear, 'cmp_vector');
    expect(dearAnchor.anchorValueUsd).toBeLessThan(cheapAnchor.anchorValueUsd);
  });

  it('never throws on an unknown company', () => {
    const state = makeState();
    const anchor = computeValuationAnchor(state, 'cmp_does_not_exist');
    expect(anchor.anchorValueUsd).toBe(0);
    expect(anchor.confidence).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Beliefs                                                                    */
/* -------------------------------------------------------------------------- */

describe('updateBeliefs', () => {
  it('moves a belief toward what a disclosure asserts, weighted by credibility', () => {
    const state = makeState({ disclosures: [disclosure()] });
    const changes = runBeliefUpdate(state, 1);
    const change = changes.find((entry) => entry.belief.topic === 'model_delay');
    expect(change).toBeDefined();
    expect(change?.after).toBeGreaterThan(change?.before ?? 1);
    expect(change?.after).toBeLessThan(0.8); // a 31%-credible rumour does not become fact
    expect(change?.belief.evidenceDisclosureIds).toContain('dsc_1');
  });

  it('lets a company on the record push an adverse belief back down', () => {
    const state = makeState({
      disclosures: [
        disclosure(),
        disclosure({ id: 'dsc_2', kind: 'guidance', credibility: 0.82, sourceCharacterId: 'chr_maya_chen', headline: 'Programme is on schedule' }),
      ],
    });
    runBeliefUpdate(state, 1);
    const belief = state.beliefs.find((entry) => entry.topic === 'model_delay');
    expect(belief).toBeDefined();
    expect(belief?.probability ?? 1).toBeLessThan(0.35);
  });

  it('lets rumours travel further when institutional trust is low', () => {
    const trusting = makeState({ disclosures: [disclosure()] });
    trusting.world.media.institutionalTrust = 0.95;
    const distrustful = makeState({ disclosures: [disclosure()] });
    distrustful.world.media.institutionalTrust = 0.05;

    runBeliefUpdate(trusting, 1);
    runBeliefUpdate(distrustful, 1);
    const high = trusting.beliefs.find((entry) => entry.topic === 'model_delay')?.probability ?? 0;
    const low = distrustful.beliefs.find((entry) => entry.topic === 'model_delay')?.probability ?? 0;
    expect(low).toBeGreaterThan(high);
  });

  it('never reads canonical private state: the same public information yields the same beliefs', () => {
    const honest = makeState({ disclosures: [disclosure()] });
    const catastrophic = makeState({ disclosures: [disclosure()] });

    // Wreck the private reality of every company. None of it is public.
    for (const company of catastrophic.companies) {
      company.financials.revenueQuarterly = 0;
      company.financials.cash = 0;
      company.financials.quarterlyBurn = -900_000_000;
      company.employees.morale = 1;
      company.employees.attrition = 0.9;
      company.reputation.investor = 1;
      company.compute.computeUtilisation = 0.01;
    }
    catastrophic.researchProjects = [
      {
        id: 'rsp_secret',
        companyId: 'cmp_nexus',
        targetNodeId: 'tech_x',
        budgetQuarterly: 100_000_000,
        computeAllocated: 1000,
        talentAllocated: 40,
        progress: 0.1,
        internalConfidence: 0.05,
        expectedQuarters: 12,
        quartersElapsed: 9,
        cumulativeSpendUsd: 900_000_000,
        status: 'active',
        isSecret: true,
        startedQuarter: 0,
        setbacks: 6,
      },
    ];

    runBeliefUpdate(honest, 1);
    runBeliefUpdate(catastrophic, 1);
    expect(JSON.stringify(catastrophic.beliefs)).toBe(JSON.stringify(honest.beliefs));
  });

  it('reverts an uncorroborated belief toward its base rate', () => {
    const state = makeState({ disclosures: [disclosure()] });
    runBeliefUpdate(state, 1);
    const afterRumour = state.beliefs.find((entry) => entry.topic === 'model_delay')?.probability ?? 0;
    for (let quarter = 2; quarter <= 6; quarter += 1) runBeliefUpdate(state, quarter);
    const later = state.beliefs.find((entry) => entry.topic === 'model_delay')?.probability ?? 0;
    expect(later).toBeLessThan(afterRumour);
    expect(later).toBeGreaterThanOrEqual(TOPIC_META.model_delay.baseRate - 1e-9);
  });

  it('emits a ledger row for every belief that moved', () => {
    const state = makeState({ disclosures: [disclosure()] });
    const harness = makeContext(1, 'beliefs');
    createMarketsSubsystem().updateBeliefs(state, harness.ctx);
    const rows = harness.events.filter((event) => event.type === 'belief_updated');
    expect(rows.length).toBeGreaterThan(0);
    for (const line of harness.lines) expect((line.refEventIds ?? []).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                    */
/* -------------------------------------------------------------------------- */

describe('priceMarket', () => {
  it('prices every in-world instrument, skips reference instruments and emits the decomposition', () => {
    const state = makeState();
    const harness = makeContext(1, 'pricing');
    const decompositions = createMarketsSubsystem().priceMarket(state, harness.ctx);

    const inWorld = state.marketInstruments.filter((instrument) => !instrument.isReference);
    expect(decompositions).toHaveLength(inWorld.length);
    expect(decompositions.some((entry) => entry.instrumentId === 'ins_reference_ndx')).toBe(false);
    expect(state.quotes.some((quote) => quote.instrumentId === 'ins_reference_ndx' && quote.quarter === 1)).toBe(false);

    const priced = harness.events.filter((event) => event.type === 'market_priced');
    expect(priced).toHaveLength(inWorld.length);
    for (const event of priced) expect(event.payload['decomposition']).toBeDefined();

    for (const decomposition of decompositions) {
      ReturnDecompositionSchema.parse(decomposition);
      expect(returnDecompositionSums(decomposition), decomposition.instrumentId).toBe(true);
    }
    for (const quote of state.quotes.filter((entry) => entry.quarter === 1)) QuoteSchema.parse(quote);
  });

  it('is deterministic: the same state and seed produce the same prices', () => {
    const first = makeState();
    const second = cloneState(makeState());
    const runOne = makeContext(1, 'same-seed');
    const runTwo = makeContext(1, 'same-seed');
    const a = createMarketsSubsystem().priceMarket(first, runOne.ctx);
    const b = createMarketsSubsystem().priceMarket(second, runTwo.ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const third = makeState();
    const runThree = makeContext(1, 'other-seed');
    const c = createMarketsSubsystem().priceMarket(third, runThree.ctx);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('pulls a price toward its anchor: a cheap company rises, an expensive one falls', () => {
    const state = makeState();
    const vector = state.marketInstruments.find((instrument) => instrument.id === 'ins_cmp_vector');
    if (vector === undefined) return;
    // Neutralise everything but the fundamental term.
    state.world.capitalMarkets.volatility = 0;
    for (const sector of Object.values(state.sectors)) {
      sector.sentiment = 0;
      sector.demand = 0.5;
      sector.multiple = 1;
      sector.volatility = 0;
    }

    const cheap = cloneState(state);
    seedLiquidity(cheap, 'ins_cmp_vector', 0, 2, 1_000_000);
    const dear = cloneState(state);
    seedLiquidity(dear, 'ins_cmp_vector', 0, 400, 1_000_000);

    const cheapRun = createMarketsSubsystem().priceMarket(cheap, makeContext(1, 'anchor').ctx);
    const dearRun = createMarketsSubsystem().priceMarket(dear, makeContext(1, 'anchor').ctx);
    const cheapAlpha = cheapRun.find((entry) => entry.instrumentId === 'ins_cmp_vector')?.fundamentalAlpha ?? 0;
    const dearAlpha = dearRun.find((entry) => entry.instrumentId === 'ins_cmp_vector')?.fundamentalAlpha ?? 0;
    expect(cheapAlpha).toBeGreaterThan(0);
    expect(dearAlpha).toBeLessThan(0);
  });

  it('carries public information into the price and nothing else', () => {
    const withNews = makeState({
      disclosures: [disclosure({ kind: 'leak', credibility: 0.9, beliefTopic: 'accounting_concern', companyId: 'cmp_orbit' })],
    });
    const quiet = cloneState(withNews);
    quiet.disclosures = [];

    createMarketsSubsystem().updateBeliefs(withNews, makeContext(1, 'news').ctx);
    createMarketsSubsystem().updateBeliefs(quiet, makeContext(1, 'news').ctx);
    const noisy = createMarketsSubsystem().priceMarket(withNews, makeContext(1, 'news-price').ctx);
    const calm = createMarketsSubsystem().priceMarket(quiet, makeContext(1, 'news-price').ctx);

    const noisyOrbit = noisy.find((entry) => entry.companyId === 'cmp_orbit');
    const calmOrbit = calm.find((entry) => entry.companyId === 'cmp_orbit');
    expect(noisyOrbit?.publicInfoEffect ?? 0).toBeLessThan(0);
    expect(Math.abs(calmOrbit?.publicInfoEffect ?? 1)).toBeLessThan(Math.abs(noisyOrbit?.publicInfoEffect ?? 0));
    expect(noisyOrbit?.priceAfter ?? 0).toBeLessThan(calmOrbit?.priceAfter ?? 0);
  });

  it('aggregates an index from its constituents, component by component', () => {
    const state = makeState();
    const priced = runPricing(state, 1, makeRng('index'), new Map(), {});
    const index = priced.find((entry) => entry.instrument.id === 'ins_fcai');
    expect(index).toBeDefined();
    if (index === undefined) return;

    const constituents = priced.filter((entry) => entry.instrument.kind === 'in_world_equity');
    let weighted = 0;
    let weight = 0;
    for (const entry of constituents) {
      const w = entry.decomposition.priceBefore * (entry.instrument.sharesOutstanding ?? 0);
      weighted += w * entry.decomposition.marketBeta;
      weight += w;
    }
    expect(index.decomposition.marketBeta).toBeCloseTo(weighted / weight, 6);
    expect(returnDecompositionSums(index.decomposition)).toBe(true);
    expect(index.quote.volume).toBe(0);
  });

  it('keeps prices positive, finite and explained through twenty chaotic quarters', () => {
    const state = makeState({ config: { ...makeState().config, difficulty: 'brutal' } });
    const economy = createEconomySubsystem();
    const markets = createMarketsSubsystem();

    for (let quarter = 1; quarter <= 20; quarter += 1) {
      const harness = makeContext(quarter, `chaos-${quarter}`);
      // A permanent barrage of maximum-magnitude modifiers, in both directions.
      state.activeModifiers = [
        toActiveModifier(
          {
            id: `mod_chaos_spot_${quarter}`,
            source: 'system',
            target: 'world.compute.spotPrice',
            operation: 'multiply',
            value: quarter % 2 === 0 ? 1.6 : 0.55,
            decay: 'none',
            durationQuarters: 2,
            remainingQuarters: 2,
            appliedAtQuarter: quarter,
            originEventId: null,
            reason: 'Chaos test.',
          },
          quarter,
        ),
        toActiveModifier(
          {
            id: `mod_chaos_sent_${quarter}`,
            source: 'system',
            target: 'sector.frontier_models.sentiment',
            operation: 'add',
            value: quarter % 3 === 0 ? -0.9 : 0.9,
            decay: 'none',
            durationQuarters: 2,
            remainingQuarters: 2,
            appliedAtQuarter: quarter,
            originEventId: null,
            reason: 'Chaos test.',
          },
          quarter,
        ),
        toActiveModifier(
          {
            id: `mod_chaos_vol_${quarter}`,
            source: 'system',
            target: 'world.capitalMarkets.volatility',
            operation: 'add',
            value: 0.9,
            decay: 'none',
            durationQuarters: 2,
            remainingQuarters: 2,
            appliedAtQuarter: quarter,
            originEventId: null,
            reason: 'Chaos test.',
          },
          quarter,
        ),
      ];
      economy.updateMacro(state, harness.ctx);
      economy.applyModifiers(state, harness.ctx);
      markets.updateBeliefs(state, harness.ctx);
      const decompositions = markets.priceMarket(state, harness.ctx);
      economy.decayModifiers(state, harness.ctx);

      for (const decomposition of decompositions) {
        expect(Number.isFinite(decomposition.priceAfter), `${decomposition.instrumentId} q${quarter}`).toBe(true);
        expect(decomposition.priceAfter, `${decomposition.instrumentId} q${quarter}`).toBeGreaterThan(0);
        expect(returnDecompositionSums(decomposition), `${decomposition.instrumentId} q${quarter}`).toBe(true);
        ReturnDecompositionSchema.parse(decomposition);
      }
      for (const quote of state.quotes) QuoteSchema.parse(quote);
    }

    // History stays bounded by the retention window.
    expect(state.quotes.every((quote) => quote.quarter > 20 - state.quoteHistoryQuarters)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Settlement                                                                 */
/* -------------------------------------------------------------------------- */

describe('settleTrades', () => {
  it('moves shares from the float, charges the buyer and reconciles the cap table', () => {
    const state = makeState();
    seedLiquidity(state, 'ins_cmp_orbit', 1, 40, 80_000_000);
    state.pendingActions = [
      tradeAction({
        intent: { type: 'buy_shares', securityId: 'sec_cmp_orbit', targetPct: 0.06, shares: null, maxPricePerShareUsd: 50 },
      }),
    ];

    const nexus = state.companies.find((company) => company.id === 'cmp_nexus');
    const cashBefore = nexus?.financials.cash ?? 0;
    const harness = makeContext(1, 'settle');
    createMarketsSubsystem().settleTrades(state, harness.ctx);

    const capTable = state.capTables.find((table) => table.companyId === 'cmp_orbit');
    expect(capTable).toBeDefined();
    if (capTable === undefined) return;

    const holding = capTable.holdings.find((entry) => entry.holderId === 'cmp_nexus');
    expect(holding?.shares ?? 0).toBeGreaterThan(0);
    expect(holding?.isDisclosed).toBe(true);

    const issued = capTable.totalIssuedByClass['shc_cmp_orbit'] ?? 0;
    const held = capTable.holdings.reduce((sum, entry) => sum + entry.shares, 0);
    expect(held).toBe(issued);
    expect(capTable.holdings.every((entry) => entry.shares >= 0)).toBe(true);

    expect(nexus?.financials.cash ?? 0).toBeLessThan(cashBefore);
    expect(nexus?.balanceSheet.assets.investments ?? 0).toBeGreaterThan(0);

    const traded = harness.events.filter((event) => event.type === 'shares_traded');
    expect(traded).toHaveLength(1);
    const crossings = harness.events.filter((event) => event.type === 'ownership_threshold_crossed');
    expect(crossings.map((event) => event.payload['threshold'])).toContain('significant_holder_disclosure');
    for (const line of harness.lines) expect((line.refEventIds ?? []).length).toBeGreaterThan(0);
  });

  it('caps a purchase at what the quarter can absorb', () => {
    const state = makeState();
    seedLiquidity(state, 'ins_cmp_orbit', 1, 40, 1_000_000);
    state.pendingActions = [
      tradeAction({
        intent: { type: 'buy_shares', securityId: 'sec_cmp_orbit', targetPct: null, shares: 200_000_000, maxPricePerShareUsd: 50 },
      }),
    ];
    const harness = makeContext(1, 'absorb');
    createMarketsSubsystem().settleTrades(state, harness.ctx);
    const capTable = state.capTables.find((table) => table.companyId === 'cmp_orbit');
    const holding = capTable?.holdings.find((entry) => entry.holderId === 'cmp_nexus');
    expect(holding?.shares ?? 0).toBeLessThan(200_000_000);
    expect(holding?.shares ?? 0).toBeGreaterThan(0);
  });

  it('refuses a purchase above the limit price and a sale inside a lock-up', () => {
    const state = makeState();
    seedLiquidity(state, 'ins_cmp_orbit', 1, 40, 80_000_000);
    state.pendingActions = [
      tradeAction({
        intent: { type: 'buy_shares', securityId: 'sec_cmp_orbit', targetPct: 0.02, shares: null, maxPricePerShareUsd: 10 },
      }),
    ];
    const limited = makeContext(1, 'limit');
    createMarketsSubsystem().settleTrades(state, limited.ctx);
    expect(limited.events.filter((event) => event.type === 'shares_traded')).toHaveLength(0);
    expect(limited.events.filter((event) => event.type === 'action_rejected')).toHaveLength(1);

    const capTable = state.capTables.find((table) => table.companyId === 'cmp_orbit');
    if (capTable === undefined) return;
    capTable.holdings = [
      ...capTable.holdings,
      {
        id: 'hld_locked',
        holderId: 'cmp_nexus',
        holderKind: 'company',
        securityId: 'sec_cmp_orbit',
        shares: 1_000_000,
        costBasisUsd: 40_000_000,
        acquiredQuarter: 0,
        lockupUntilQuarter: 6,
        isDisclosed: false,
      },
    ];
    const floatHolding = capTable.holdings.find((entry) => entry.holderKind === 'public_float');
    if (floatHolding !== undefined) floatHolding.shares -= 1_000_000;

    state.pendingActions = [
      tradeAction({
        actionId: 'act_q1_0002',
        intent: { type: 'sell_shares', securityId: 'sec_cmp_orbit', shares: 500_000, minPricePerShareUsd: 1 },
      }),
    ];
    const locked = makeContext(1, 'lockup');
    createMarketsSubsystem().settleTrades(state, locked.ctx);
    expect(locked.events.filter((event) => event.type === 'shares_traded')).toHaveLength(0);
    expect(locked.events.some((event) => event.payload['code'] === 'lockup_active')).toBe(true);
  });

  it('keeps the balance sheet reconciling across a round trip', () => {
    const state = makeState();
    seedLiquidity(state, 'ins_cmp_orbit', 1, 40, 80_000_000);
    const nexus = state.companies.find((company) => company.id === 'cmp_nexus');
    expect(nexus).toBeDefined();
    if (nexus === undefined) return;

    const reconciles = (): boolean => {
      const assets =
        nexus.balanceSheet.assets.cash +
        nexus.balanceSheet.assets.ppe +
        nexus.balanceSheet.assets.goodwill +
        nexus.balanceSheet.assets.investments +
        nexus.balanceSheet.assets.receivables;
      const liabilities =
        nexus.balanceSheet.liabilities.debt + nexus.balanceSheet.liabilities.payables + nexus.balanceSheet.liabilities.deferredRevenue;
      return Math.abs(assets - liabilities - nexus.balanceSheet.equity) <= 1;
    };

    nexus.balanceSheet.assets.cash = nexus.financials.cash;
    expect(reconciles()).toBe(true);

    state.pendingActions = [
      tradeAction({ intent: { type: 'buy_shares', securityId: 'sec_cmp_orbit', targetPct: 0.03, shares: null, maxPricePerShareUsd: 50 } }),
    ];
    createMarketsSubsystem().settleTrades(state, makeContext(1, 'buy').ctx);
    expect(reconciles()).toBe(true);

    state.pendingActions = [
      tradeAction({ actionId: 'act_q1_0003', intent: { type: 'sell_shares', securityId: 'sec_cmp_orbit', shares: 5_000_000, minPricePerShareUsd: 1 } }),
    ];
    createMarketsSubsystem().settleTrades(state, makeContext(1, 'sell').ctx);
    expect(reconciles()).toBe(true);

    const capTable = state.capTables.find((table) => table.companyId === 'cmp_orbit');
    const issued = capTable?.totalIssuedByClass['shc_cmp_orbit'] ?? 0;
    const held = capTable?.holdings.reduce((sum, entry) => sum + entry.shares, 0) ?? -1;
    expect(held).toBe(issued);
  });
});

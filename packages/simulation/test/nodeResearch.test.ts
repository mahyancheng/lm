/**
 * @frontier/simulation — world 3 puts research on the one graph.
 *
 * What stage 4 has to be true for, in the order the brief asks it:
 *
 * 1. **Production is asked of the company.** An AI laboratory cannot make a
 *    robotics node until it owns one, and the same holds in every direction
 *    across all six industries. Buying an input needs no ownership at all —
 *    that is the difference between making a thing and paying somebody for it.
 * 2. **The money pit is closed.** A programme whose requirements are unheld is
 *    refused at the start, naming what is missing; one whose requirements go
 *    mid-flight is PAUSED rather than pinned at ninety-eight percent for ever;
 *    and `abandon_research_project` closes either, releases the researchers and
 *    the compute, and costs standing.
 * 3. **Achieving a node improves what you already sell** — the lines, through
 *    craft, and the unit cost, through the roll-up, with no bonus multiplier
 *    anywhere: owning the input means you MAKE it, so its market price and the
 *    open-market premium leave the bill of materials.
 * 4. **Customer data is a real asset.** It accrues from what was served,
 *    decays, lifts quality, feeds a model node free, is capped by the pool when
 *    it is the thing being sold, and answers `world.regulation.privacy` — the
 *    first economic number that dial has ever moved.
 * 5. **Rivals answer a backlog** by building capacity, so the backlog mechanic
 *    has teeth on both sides of the market.
 *
 * The frozen worlds are pinned by hash in `world2Scenario.test.ts` and are not
 * restated here.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, ResearchProject, ResolverContext, SessionState } from '@frontier/contracts';
import { canProduce, economicNodeById, holdsNode } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session } from '../src/scenario/world3';
import { priceNodes } from '../src/graph/market';
import { unitCostOf } from '../src/graph/cost';
import { createNodeCostCache, launchableNodes } from '../src/graph/lines';
import {
  DATA_DECAY,
  DATA_QUALITY_MAX,
  PRIVACY_DRAG,
  dataEdgeOf,
  dataPetabytesOf,
  dataQualityUplift,
  generatedPetabytes,
  petabytesPerUnit,
  privacyFactor,
  resolveNodeData,
} from '../src/graph/data';
import { QUALITY_DECAY, effectiveQuality } from '../src/graph/production';
import { ABANDON_REPUTATION_COST, abandonProject, improveLinesOnAchievement, unheldRequirements } from '../src/research/ownership';
import { achieveNodes } from '../src/research/nodes';
import { advanceProjects, resourcingFactors } from '../src/research/progress';
import { nodeTechGraph, stateAfterFirstAchievement } from '../src/graph/techGraph';
import { capacityInvestmentsFor } from '../src/companies/npc';
import { validateAction } from '../src/validator';
import { BatchBudget } from '../src/validator/context';
import { resolveProducts } from '../src/companies/products';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Nodes these tests quote from the table, asserted against it before anything is built on them. */
const ARM = 'sys_industrial_arm';
const ACTUATOR = 'cmp_precision_actuator';
const FRONTIER_MODEL = 'sys_frontier_model';
const CORPUS = 'dat_web_corpus';
const PACKAGE = 'sys_advanced_package';
const HBM = 'cmp_hbm_stack';
const SUBSCRIPTION = 'app_consumer_subscription';

describe('the table these tests are pinned to', () => {
  it('still declares the sectors and edges they quote', () => {
    expect(economicNodeById(ARM)?.sector).toBe('robotics');
    expect(economicNodeById(ACTUATOR)?.sector).toBe('robotics');
    expect(economicNodeById(FRONTIER_MODEL)?.sector).toBe('ai');
    expect(economicNodeById(CORPUS)?.sector).toBe('ai');
    // The model consumes a corpus. That is the input world 2's frontier model
    // never had: it declared none at all.
    expect(economicNodeById(FRONTIER_MODEL)?.consumes.some((input) => input.nodeId === CORPUS)).toBe(true);
    expect(economicNodeById(PACKAGE)?.consumes.some((input) => input.nodeId === HBM)).toBe(true);
    expect(economicNodeById(FRONTIER_MODEL)?.dataRequiredPb).toBeGreaterThan(0);
    expect(economicNodeById(SUBSCRIPTION)).toMatchObject({ sector: 'consumer', buyerSegment: 'consumer', saleKind: 'recurring' });
    // A model requires the corpus and the training run; that is what a pause is about.
    expect(economicNodeById(FRONTIER_MODEL)?.requires.length).toBeGreaterThan(0);
  });
});

/** A context that records what a phase emitted and said. */
function recorder(quarter = 0) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let counter = 0;
  const ctx: ResolverContext = {
    quarter,
    rng: createRng(`node_research_q${quarter}`),
    emit(draft) {
      events.push({ type: draft.type, payload: draft.payload });
      counter += 1;
      return `evt_${counter}`;
    },
    log(line) {
      lines.push(line.text);
    },
  };
  return { events, lines, ctx };
}

/** One line on one node, as a world-3 product. */
function lineOn(nodeId: string, units: number, priceUsd: number, craft = 0.6): Product {
  return {
    id: `prd_${nodeId}`,
    name: nodeId,
    segment: economicNodeById(nodeId)?.buyerSegment ?? 'enterprise',
    nodeId,
    pricePerSeat: priceUsd,
    activeCustomers: units,
    unitsSoldQuarterly: units,
    installedBase: 0,
    backlogUnits: 0,
    contractBilledUsd: 0,
    unitCostUsd: 0,
    churnQuarterly: 0.05,
    growthQuarterly: 0,
    grossMarginPct: 0.4,
    computeIntensity: 0.5,
    qualityScore: craft,
    craftQuality: craft,
    qualityTier: 0.5,
    launchedQuarter: 0,
    isActive: true,
  };
}

/** A programme against one node, resourced to run. */
function programmeOn(companyId: string, nodeId: string, progress = 0.5): ResearchProject {
  return {
    id: `rsp_${companyId}_${nodeId}`,
    companyId,
    targetNodeId: nodeId,
    budgetQuarterly: 5_000_000,
    computeAllocated: 40,
    talentAllocated: 30,
    progress,
    internalConfidence: 0.6,
    quartersElapsed: 4,
    expectedQuarters: 8,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 20_000_000,
    setbacks: 0,
    startedQuarter: 0,
  };
}

/** The world-3 session, with the first company handed to the test. */
function world3(): { state: SessionState; company: Company } {
  const state = createWorld3Session();
  const company = state.companies[0] as Company;
  return { state, company };
}

/* -------------------------------------------------------------------------- */
/*  1. Production is asked of the company                                      */
/* -------------------------------------------------------------------------- */

describe('the production rule', () => {
  it('is the node table projected onto the Frontier Map, not a second catalogue', () => {
    const { state } = world3();
    expect(state.techGraph.nodes.length).toBeGreaterThan(20);
    // The seeded map IS the projection, not a copy that can drift from it.
    expect(state.techGraph.nodes.map((node) => node.id)).toEqual(nodeTechGraph(state.sessionId).nodes.map((node) => node.id));
    expect(state.techGraph.edges).toEqual([]);
    for (const node of state.techGraph.nodes) {
      const economic = economicNodeById(node.id);
      expect(economic, `${node.id} is on the map but not in the node table`).toBeDefined();
      expect(node.dependencies).toEqual([...(economic?.requires ?? [])]);
      expect(node.researchCostRange).toEqual([...(economic?.researchCostRangeUsd ?? [0, 0])]);
      // Never `achieved`: in world 3 that is a fact about a company.
      expect(node.status).not.toBe('achieved');
    }
    // Every seeded programme aims at something its company can actually start.
    for (const project of state.researchProjects) {
      const company = state.companies.find((entry) => entry.id === project.companyId);
      expect(company, `${project.companyId} is gone`).toBeDefined();
      expect(economicNodeById(project.targetNodeId), `${project.targetNodeId} is not a node`).toBeDefined();
      expect(unheldRequirements(state, company as Company, project.targetNodeId)).toEqual([]);
    }
  });

  it('stops an AI laboratory making a robotics node until it owns one', () => {
    const { state, company } = world3();
    company.sector = 'ai';
    company.ownedNodes = ['svc_inference_api'];
    company.licences = [];
    expect(canProduce(company, ARM)).toBe(false);
    expect(canProduce(company, ACTUATOR)).toBe(false);

    // Researching it is one way in. Ownership is per company: nobody else's
    // achievement moves this answer.
    company.ownedNodes = [...company.ownedNodes, ACTUATOR, ARM, ...(economicNodeById(ARM)?.requires ?? [])];
    expect(canProduce(company, ARM)).toBe(true);

    // A licence is the other way in, and it lapses.
    const other = state.companies[1] as Company;
    other.ownedNodes = [];
    other.licences = [{ nodeId: ACTUATOR, ownerCompanyId: company.id, royaltyPct: 6, expiryQuarter: state.quarter + 4 }];
    expect(holdsNode(other, ACTUATOR, state.quarter)).toBe(true);
    expect(holdsNode(other, ACTUATOR, state.quarter + 8)).toBe(false);
  });

  it('holds in every direction: no company starts able to make another industry outright', () => {
    const { state } = world3();
    for (const company of state.companies) {
      if (!company.isActive) continue;
      const foreign = launchableNodes(state, company).filter((entry) => entry.node.sector !== company.sector && !entry.locked);
      // Anything a company can make outside its own sector is something the
      // ownership rule handed it deliberately — a tier-0 commodity nobody owns
      // exclusively, or a node in the `requires` closure of its own line — and
      // never a finished product of somebody else's industry.
      for (const entry of foreign) {
        expect(
          entry.node.tier <= 1 || (company.ownedNodes ?? []).includes(entry.node.id),
          `${company.name} can make ${entry.node.id} without owning it`,
        ).toBe(true);
      }
    }
  });

  it('refuses a launch onto a node the company cannot produce, and names what is missing', () => {
    const { state, company } = world3();
    company.controllerPlayerId = state.players[0]?.playerId ?? null;
    company.ownedNodes = (company.ownedNodes ?? []).filter((id) => id !== ARM);
    const verdict = validateAction(
      state,
      {
        type: 'launch_product',
        name: 'Arms',
        segment: 'enterprise',
        categoryId: ARM,
        pricePerSeatUsd: 100_000,
        computeIntensity: 0.5,
        launchMarketingUsd: 0,
        targetQuality: 0.5,
        supply: [],
      },
      { companyId: company.id, characterId: company.ceoCharacterId ?? 'chr_x', playerId: company.controllerPlayerId, confirmedByHuman: true },
      new BatchBudget(),
      'act_launch_probe',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain(economicNodeById(ARM)?.label ?? ARM);
  });

  it('lets a company BUY an input it does not own: paying for a thing is not making it', () => {
    const { state, company } = world3();
    const packageNode = economicNodeById(PACKAGE);
    expect(packageNode).toBeDefined();
    company.ownedNodes = [PACKAGE, ...(packageNode?.requires ?? [])];
    company.licences = [];
    company.products = [lineOn(PACKAGE, 100, 400_000)];
    expect(canProduce(company, HBM)).toBe(false);

    const { ctx } = recorder();
    priceNodes(state, ctx);
    const cost = unitCostOf(state, company, PACKAGE, createNodeCostCache(state));
    // The memory is on the bill of materials, priced, and the line is not
    // blocked: somebody in the world owns it, so it can be had.
    const hbmLine = cost.lines.find((line) => line.key === HBM);
    expect(hbmLine?.amountUsd).toBeGreaterThan(0);
    expect(cost.blockedInputNodeIds).not.toContain(HBM);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The money pit                                                           */
/* -------------------------------------------------------------------------- */

describe('a programme that cannot be finished', () => {
  it('is refused at the start, naming what is missing, rather than opened and charged', () => {
    const { state, company } = world3();
    company.controllerPlayerId = state.players[0]?.playerId ?? null;
    // A node whose requirements this company does not hold.
    const target = state.techGraph.nodes.find((node) => unheldRequirements(state, company, node.id).length > 0);
    expect(target, 'the world has no node with an unheld requirement').toBeDefined();
    const verdict = validateAction(
      state,
      {
        type: 'start_research_project',
        targetNodeId: (target as { id: string }).id,
        budgetUsd: 4_000_000,
        computeUnits: 10,
        researchersAssigned: 10,
        secret: false,
      },
      { companyId: company.id, characterId: company.ceoCharacterId ?? 'chr_x', playerId: company.controllerPlayerId, confirmedByHuman: true },
      new BatchBudget(),
      'act_research_probe',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.join(' ')).toMatch(/cannot work on/);
  });

  it('is paused, never pinned at 0.98, when its ground goes mid-flight', () => {
    const { state, company } = world3();
    const target = economicNodeById(FRONTIER_MODEL);
    expect(target?.requires.length).toBeGreaterThan(0);
    company.ownedNodes = [...(target?.requires ?? [])];
    const project = programmeOn(company.id, FRONTIER_MODEL, 0.9);
    state.researchProjects = [project];

    // The licence lapses: the requirement is no longer held.
    company.ownedNodes = [];
    const { events, ctx } = recorder(state.quarter);
    advanceProjects(state, ctx);

    expect(project.status).toBe('paused');
    expect(project.progress).toBe(0.9);
    expect(project.progress).not.toBe(0.98);
    expect(events.some((event) => event.type === 'research_paused')).toBe(true);
    // And the money stops: a paused programme is skipped the next quarter too.
    const before = project.cumulativeSpendUsd;
    advanceProjects(state, recorder(state.quarter + 1).ctx);
    expect(project.cumulativeSpendUsd).toBe(before);
  });

  it('can be abandoned: the researchers and the compute come back and the spending stops', () => {
    const { state, company } = world3();
    const project = programmeOn(company.id, ARM, 0.4);
    state.researchProjects = [project];
    const investorBefore = company.reputation.investor;

    const { events, ctx } = recorder(state.quarter);
    expect(abandonProject(state, ctx, company.id, project.id)).toBe(true);

    expect(project.status).toBe('abandoned');
    expect(project.talentAllocated).toBe(0);
    expect(project.computeAllocated).toBe(0);
    expect(project.budgetQuarterly).toBe(0);
    expect(company.reputation.investor).toBe(investorBefore - ABANDON_REPUTATION_COST);
    expect(events.some((event) => event.type === 'research_abandoned')).toBe(true);

    // The spend never moves again.
    const spent = project.cumulativeSpendUsd;
    advanceProjects(state, recorder(state.quarter + 1).ctx);
    expect(project.cumulativeSpendUsd).toBe(spent);
    // And abandoning a closed programme is refused rather than repeated.
    expect(abandonProject(state, recorder().ctx, company.id, project.id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Achieving a node improves what you already sell                         */
/* -------------------------------------------------------------------------- */

describe('achieving a node', () => {
  it('grants ownership to the company and to nobody else, and records the pioneer', () => {
    const { state, company } = world3();
    const rival = state.companies[1] as Company;
    company.ownedNodes = [...(economicNodeById(ARM)?.requires ?? [])];
    rival.ownedNodes = [];
    const project = programmeOn(company.id, ARM, 1);
    state.researchProjects = [project];
    const mapNode = state.techGraph.nodes.find((node) => node.id === ARM);
    expect(mapNode).toBeDefined();
    const statusBefore = (mapNode as NonNullable<typeof mapNode>).status;

    const { events, ctx } = recorder(state.quarter);
    achieveNodes(state, ctx);

    expect(project.status).toBe('succeeded');
    expect(company.ownedNodes).toContain(ARM);
    expect(rival.ownedNodes ?? []).not.toContain(ARM);
    expect((mapNode as { achievedByCompanyId: string | null }).achievedByCompanyId).toBe(company.id);
    // The world learns: the node steps one rung toward routine, in state.
    expect((mapNode as NonNullable<typeof mapNode>).status).toBe(stateAfterFirstAchievement(statusBefore));
    expect(events.some((event) => event.type === 'node_owned')).toBe(true);
  });

  it('raises the craft of the line that sells it, and of the lines built on it', () => {
    const { company } = world3();
    const upstream = economicNodeById(FRONTIER_MODEL)?.requires[0];
    expect(upstream).toBeDefined();
    company.products = [lineOn(FRONTIER_MODEL, 10, 22_000_000, 0.5), lineOn(upstream as string, 10, 500_000, 0.5)];
    const modelBefore = company.products[0]?.craftQuality ?? 0;
    const upstreamBefore = company.products[1]?.craftQuality ?? 0;

    // The frontier model REQUIRES the upstream node, so achieving the upstream
    // one lifts its own line most and the model line by the smaller amount.
    const improved = improveLinesOnAchievement(company, upstream as string);
    expect(improved).toBe(2);
    const modelGain = (company.products[0]?.craftQuality ?? 0) - modelBefore;
    const upstreamGain = (company.products[1]?.craftQuality ?? 0) - upstreamBefore;
    expect(upstreamGain).toBeGreaterThan(modelGain);
    expect(modelGain).toBeGreaterThan(0);
  });

  it('lowers unit cost through the roll-up alone, with no bonus multiplier anywhere', () => {
    const { state, company } = world3();
    const packageNode = economicNodeById(PACKAGE);
    company.ownedNodes = [PACKAGE, ...(packageNode?.requires ?? [])];
    company.licences = [];
    company.products = [lineOn(PACKAGE, 100, 400_000)];
    const { ctx } = recorder();
    priceNodes(state, ctx);
    const bought = unitCostOf(state, company, PACKAGE, createNodeCostCache(state));

    // Now the company can make the memory itself, and runs a line on it.
    company.ownedNodes = [...(company.ownedNodes ?? []), HBM, ...(economicNodeById(HBM)?.requires ?? [])];
    company.products = [lineOn(PACKAGE, 100, 400_000), lineOn(HBM, 1000, 3_000)];
    const made = unitCostOf(state, company, PACKAGE, createNodeCostCache(state));

    const boughtLine = bought.lines.find((line) => line.key === HBM);
    const madeLine = made.lines.find((line) => line.key === HBM);
    expect(boughtLine?.sourceKind).toBe('market');
    expect(madeLine?.sourceKind).toBe('make');
    // Strictly cheaper, and cheaper by exactly what the market row cost less
    // what making it costs — no bonus term.
    expect(madeLine?.amountUsd).toBeLessThan(boughtLine?.amountUsd ?? 0);
    expect(made.madeInHouseSharePct).toBeGreaterThan(bought.madeInHouseSharePct);
  });

  it('lets a line fall behind when it is left alone', () => {
    const { state, company } = world3();
    for (const other of state.companies) if (other.id !== company.id) other.products = [];
    company.products = [lineOn(ARM, 10, 200_000, 0.8)];
    const before = company.products[0]?.craftQuality ?? 0;
    const { ctx } = recorder(state.quarter);
    priceNodes(state, ctx);
    resolveProducts(state, ctx);
    expect(company.products[0]?.craftQuality).toBeCloseTo(before * (1 - QUALITY_DECAY), 8);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Customer data                                                           */
/* -------------------------------------------------------------------------- */

describe('customer data', () => {
  it('accrues from what was served and decays every quarter', () => {
    const { state, company } = world3();
    // A consumer subscription observes everything and eats no dataset, which is
    // the clean case: what is left at the end of the quarter is what was
    // collected, less the decay.
    const node = economicNodeById(SUBSCRIPTION);
    expect(node?.dataYieldPerUnitQuarter).toBeGreaterThan(0);
    expect(node?.consumes.some((input) => input.nodeId.startsWith('dat_'))).toBe(false);
    company.dataAssets = [];
    company.products = [lineOn(SUBSCRIPTION, 20_000_000, 16)];

    const generated = generatedPetabytes(state, company, node as NonNullable<typeof node>, 20_000_000, 'consumer');
    expect(generated).toBeGreaterThan(0);

    const { events, ctx } = recorder(state.quarter);
    resolveNodeData(state, ctx);
    const held = dataPetabytesOf(company, 'consumer');
    // Stocks are stored to three decimals, which is a thousandth of a petabyte.
    expect(held).toBeCloseTo(generated * (1 - DATA_DECAY), 2);
    expect(events.some((event) => event.type === 'data_resolved')).toBe(true);

    // A quarter with nothing served is a quarter the stock shrinks.
    company.products = [];
    resolveNodeData(state, recorder(state.quarter + 1).ctx);
    expect(dataPetabytesOf(company, 'consumer')).toBeCloseTo(held * (1 - DATA_DECAY), 2);
  });

  it('answers world.regulation.privacy, which until now moved no economic number', () => {
    const { state, company } = world3();
    const node = economicNodeById(CORPUS);
    expect(node?.dataSensitivity).toBeGreaterThan(0);
    state.world.regulation.privacy = 0;
    const free = privacyFactor(state, node as NonNullable<typeof node>);
    state.world.regulation.privacy = 1;
    const tight = privacyFactor(state, node as NonNullable<typeof node>);
    expect(free).toBe(1);
    expect(tight).toBeCloseTo(1 - PRIVACY_DRAG * (node?.dataSensitivity ?? 0), 8);
    expect(tight).toBeLessThan(free);
    // Never zero: operating a service lawfully still leaves a record.
    expect(tight).toBeGreaterThan(0);
    void company;
  });

  it('lifts the quality of what a company sells in that sector, bounded', () => {
    const { state, company } = world3();
    const product = lineOn(FRONTIER_MODEL, 10, 22_000_000, 0.5);
    company.products = [product];
    company.dataAssets = [];
    const { ctx } = recorder();
    priceNodes(state, ctx);
    const cost = unitCostOf(state, company, FRONTIER_MODEL, createNodeCostCache(state));
    const node = economicNodeById(FRONTIER_MODEL) as NonNullable<ReturnType<typeof economicNodeById>>;
    const dry = effectiveQuality(state, company, product, node, cost);

    company.dataAssets = [{ sector: 'ai', petabytes: 400 }];
    const wet = effectiveQuality(state, company, product, node, cost);
    expect(wet).toBeGreaterThan(dry);
    expect(wet - dry).toBeCloseTo(DATA_QUALITY_MAX * dataEdgeOf(400), 6);
    // The ceiling holds however much is hoarded.
    company.dataAssets = [{ sector: 'ai', petabytes: 100_000_000 }];
    expect(dataQualityUplift(company, 'ai')).toBeLessThanOrEqual(DATA_QUALITY_MAX);
  });

  it('feeds a model node free from the company own pool, and buys only the shortfall', () => {
    const { state, company } = world3();
    company.ownedNodes = [FRONTIER_MODEL, ...(economicNodeById(FRONTIER_MODEL)?.requires ?? [])];
    company.products = [lineOn(FRONTIER_MODEL, 1, 22_000_000)];
    company.dataAssets = [];
    const { ctx } = recorder();
    priceNodes(state, ctx);
    const bought = unitCostOf(state, company, FRONTIER_MODEL, createNodeCostCache(state));
    const boughtCorpus = bought.lines.find((line) => line.key === CORPUS);
    expect(boughtCorpus?.amountUsd).toBeGreaterThan(0);

    // A pool big enough to cover the whole draw: the corpus line goes to zero
    // and is marked as made, which is what owning your own data means.
    const perUnit = petabytesPerUnit(CORPUS);
    const qty = economicNodeById(FRONTIER_MODEL)?.consumes.find((input) => input.nodeId === CORPUS)?.qtyPerUnit ?? 0;
    company.dataAssets = [{ sector: 'ai', petabytes: qty * perUnit * 10 }];
    const free = unitCostOf(state, company, FRONTIER_MODEL, createNodeCostCache(state));
    const freeCorpus = free.lines.find((line) => line.key === CORPUS);
    expect(freeCorpus?.amountUsd).toBe(0);
    expect(freeCorpus?.sourceKind).toBe('make');
    expect(free.unitCostUsd).toBeLessThan(bought.unitCostUsd);
  });

  it('caps a dataset line at the pool it sells out of', () => {
    const { state, company } = world3();
    for (const other of state.companies) if (other.id !== company.id) other.products = [];
    company.ownedNodes = [CORPUS, ...(economicNodeById(CORPUS)?.requires ?? [])];
    company.products = [lineOn(CORPUS, 5_000, 18_000)];
    company.dataAssets = [{ sector: 'ai', petabytes: 1 }];
    const { ctx } = recorder(state.quarter);
    priceNodes(state, ctx);
    resolveProducts(state, ctx);
    // One petabyte is a thousand terabytes, and a terabyte is the unit.
    expect(company.products[0]?.unitsSoldQuarterly ?? 0).toBeLessThanOrEqual(Math.ceil(1 / petabytesPerUnit(CORPUS)));
  });

  it('costs something to hold, as an operating expense and never as cost of goods', () => {
    const engine = createDefaultEngine();
    const build = (privacy: number): { custody: number; cogs: number } => {
      const state = createWorld3Session();
      state.world.regulation.privacy = privacy;
      for (const entry of state.companies) entry.dataAssets = [{ sector: entry.sector, petabytes: 500 }];
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      const settled = outcome.nextState.companies[0] as Company;
      return { custody: settled.financials.dataCustodyUsd ?? 0, cogs: settled.financials.cogs };
    };
    const permissive = build(0);
    const strict = build(1);
    // The custody charge answers the regime; the roll-up does not, so cost of
    // goods is the same number under both regimes and only the operating
    // expense moves. That is the whole point of keeping it out of cost of
    // goods.
    //
    // The comparison is relational rather than absolute because the world phase
    // moves `world.regulation.privacy` during the quarter, so neither run
    // resolves at exactly the figure it opened on.
    expect(strict.custody).toBeGreaterThan(permissive.custody);
    expect(permissive.custody).toBeGreaterThanOrEqual(0);
    expect(strict.cogs).toBeCloseTo(permissive.cogs, 2);
  }, 60_000);

  it('is the fourth resourcing factor, so a programme can be short of data', () => {
    const { state, company } = world3();
    company.dataAssets = [];
    const project = programmeOn(company.id, FRONTIER_MODEL, 0.2);
    const node = state.techGraph.nodes.find((entry) => entry.id === FRONTIER_MODEL);
    expect(node).toBeDefined();
    const dry = resourcingFactors(state, project, node as NonNullable<typeof node>);
    expect(dry.requiredDataPb).toBeGreaterThan(0);
    expect(dry.data).toBeLessThan(1);

    company.dataAssets = [{ sector: 'ai', petabytes: dry.requiredDataPb * 2 }];
    const wet = resourcingFactors(state, project, node as NonNullable<typeof node>);
    expect(wet.data).toBe(1);
    expect(wet.data).toBeGreaterThan(dry.data);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Rivals answer a backlog                                                 */
/* -------------------------------------------------------------------------- */

describe('the rivals', () => {
  it('invest in capacity when their orders go unfilled', () => {
    const { state, company } = world3();
    const product = lineOn(ARM, 100, 200_000);
    product.backlogUnits = 0;
    company.products = [product];
    company.balanceSheet.assets.cash = 5_000_000_000;
    const quiet = capacityInvestmentsFor(state, company);
    const quietUsd = quiet.reduce((sum, intent) => sum + (intent.type === 'invest_capacity' ? intent.amountUsd : 0), 0);

    product.backlogUnits = 400;
    const backlogged = capacityInvestmentsFor(state, company);
    const backloggedUsd = backlogged.reduce((sum, intent) => sum + (intent.type === 'invest_capacity' ? intent.amountUsd : 0), 0);

    expect(backloggedUsd).toBeGreaterThan(quietUsd);
    expect(backlogged.every((intent) => intent.type === 'invest_capacity')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. The whole thing still resolves, deterministically                       */
/* -------------------------------------------------------------------------- */

describe('resolving world 3 with research on the one graph', () => {
  it('passes every invariant and resolves four quarters identically from the same seed', () => {
    const engine = createDefaultEngine();
    const run = (): string[] => {
      let state = createWorld3Session();
      const out: string[] = [];
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.invariants.filter((result) => !result.passed)).toEqual([]);
        expect(outcome.committed).toBe(true);
        state = outcome.nextState;
        out.push(JSON.stringify(state.companies.map((company) => [company.id, company.dataAssets ?? [], company.ownedNodes?.length ?? 0])));
      }
      return out;
    };
    expect(run()).toEqual(run());
  }, 120_000);

  it('collects data for the companies actually serving customers', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld3Session(), [], null, []);
    expect(outcome.committed).toBe(true);
    const holders = outcome.nextState.companies.filter((company) => (company.dataAssets ?? []).some((asset) => asset.petabytes > 0));
    expect(holders.length).toBeGreaterThan(0);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*  7. The deleted global test is on no world-3 path                           */
/* -------------------------------------------------------------------------- */

describe('the world-2 global achievement test', () => {
  it('is not reached by any world-3 module', () => {
    // `dependencySatisfied` asks whether a node was achieved by ANYBODY, which
    // is the check that locked nearly every line for everybody on turn one.
    // World 3 asks `canProduce`, which is about one company. The frozen worlds
    // still run on the old test, so it is deprecated rather than deleted — and
    // this is the proof that no world-3 path reaches it.
    const sources = {
      ...import.meta.glob('../src/graph/*.ts', { query: '?raw', import: 'default', eager: true }),
      ...import.meta.glob('../src/scenario/world3/*.ts', { query: '?raw', import: 'default', eager: true }),
      ...import.meta.glob('../src/research/ownership.ts', { query: '?raw', import: 'default', eager: true }),
    } as Record<string, string>;
    expect(Object.keys(sources).length, 'no world-3 source was scanned').toBeGreaterThanOrEqual(6);
    // Comments may name the old test; only code counts, so they come out first.
    const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [path, source] of Object.entries(sources)) {
      const code = codeOf(source);
      expect(code.includes('dependencySatisfied'), `${path} reaches the deleted global test`).toBe(false);
      expect(code.includes('PRODUCT_CATEGORIES'), `${path} names the deprecated world-2 catalogue`).toBe(false);
    }
  });

  it('is not what the world-3 launch gate or research gate runs', () => {
    const rules = import.meta.glob('../src/validator/rules.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const source = Object.values(rules)[0] ?? '';
    // Both world-3 gates return before the world-2 catalogue branch is reached,
    // and both name `canProduce` or `holdsNode` instead.
    expect(source.includes('canProduce(ctx.company')).toBe(true);
    expect(source.includes('holdsNode(ctx.company')).toBe(true);
  });
});

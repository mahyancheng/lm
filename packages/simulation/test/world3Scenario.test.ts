/**
 * The world-version-3 opening state.
 *
 * World 3 is the node economy: one table of nodes, one market price per node,
 * ownership per company, and every company selling composed lines. What is
 * proved here is the floor the rest of world 3 stands on:
 *
 * - **Worlds 1 and 2 do not move.** Both are pinned by hash in
 *   `world2Scenario.test.ts`; here it is enough to show world 3 is a different
 *   world and that a version-2 setup still builds world 2.
 * - **Every company can make what it sells.** For all fifteen backgrounds and
 *   every line of all twenty-four seeded rivals, `canProduce` is true at
 *   quarter zero. This is the assertion world 2 lacked: there, a launch gate
 *   asked whether a node was achieved by *anybody*, exactly one of forty-two
 *   seeded nodes was, and a dozen product lines were locked on turn one for
 *   companies already selling them.
 * - **Every node has a producer or an owner.** World 2 shipped
 *   `manufacturing_accelerators` as a required input of three categories with
 *   no seller anywhere.
 * - **The composition is real.** Every `'self'` fill in the line table names a
 *   line the same company runs and resolves to MAKE; every supplier slug names
 *   a rival whose line on that node is published and resolves to BUY from that
 *   company; every published seed line carries terms at its list price; and
 *   the fifteen background cards agree with the line table about what they
 *   open selling.
 * - **The seed states what the engine will write.** Every node opens at the
 *   price index its own opening balance settles to and every sector at the
 *   goods index its balance restates, so the first End Quarter moves no price
 *   the seed already implied; every line's `qualityScore` is the engine's own
 *   blend; every line nobody is directing asks at or above its node's market
 *   price, where the tracking rule would walk it anyway; and the demo
 *   dispatcher builds exactly the world `createWorld3Session` builds, so a
 *   player's New Game is the world the picker described.
 * - **The engine accepts it.** Building a world nobody can resolve is not
 *   building a world, so the opening quarter is resolved for real with the
 *   invariant gate on, and four quarters are resolved twice and compared by
 *   state hash.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_BACKGROUNDS,
  ALL_BACKGROUND_IDS,
  BACKGROUND_OPENING_LINE,
  BACKGROUND_SIGNATURE_NODES,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  NODE_PRICE_BASELINE,
  NewGameSetupSchema,
  REGIONS,
  SECTORS,
  SessionStateSchema,
  admissibleNodesFor,
  canProduce,
  economicNodeById,
  nodeMarketPriceUsd,
  sectorForBackground,
  startingLineNodeFor,
  type Company,
  type W3SeedLine,
} from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { sectorBalances } from '../src/economy/prices';
import { supplyBySector } from '../src/economy/sectors';
import { createNodeCostCache, nodeBalances, unitCostOf } from '../src/graph';
import { effectiveQuality } from '../src/graph/production';
import { resolveFill } from '../src/graph/slots';
import { createDemoSession } from '../src/scenario';
import { createWorld2Session, V2_COMPANY_SEEDS, W2_COMPANIES } from '../src/scenario/world2';
import {
  W3_DEFAULT_SETUP,
  W3_MAX_OWNED_NODES,
  W3_RIVAL_LINES,
  W3_SEED,
  createWorld3Session,
  w3NodeOwnership,
  w3OwnershipSubjects,
  w3RivalLinesFor,
  w3SeedCompanyId,
  w3SeedProductId,
  world3SessionInput,
} from '../src/scenario/world3';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../src/economy/sectors';

/** Vite supplies this at transform time; the package carries no Vite types. */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}

const setupFor = (backgroundId: string, region: string) =>
  NewGameSetupSchema.parse({
    companyName: 'Probe Ventures',
    founderName: 'Probe Founder',
    backgroundId,
    sector: sectorForBackground(backgroundId),
    region,
    worldVersion: 3,
  });

const slugOf = (companyId: string): string => V2_COMPANY_SEEDS.find((seed) => seed.id === companyId)?.slug ?? companyId;

/* -------------------------------------------------------------------------- */
/*  Shape of the world                                                         */
/* -------------------------------------------------------------------------- */

describe('the world-3 scenario', () => {
  const state = createWorld3Session();

  it('is a fixed point for a seed, and differs between seeds and from world 2', () => {
    expect(hashState(createWorld3Session())).toBe(hashState(createWorld3Session()));
    expect(hashState(createWorld3Session(7))).not.toBe(hashState(createWorld3Session(8)));
    expect(hashState(createWorld3Session())).not.toBe(hashState(createWorld2Session()));
  });

  it('opens at world version 3, on the node gate and not on the multi-sector one alone', () => {
    expect(state.config.worldVersion).toBe(3);
    expect(isNodeEconomyWorld(state)).toBe(true);
    // World 3 is still a multi-sector world; the point of the second gate is
    // that world 2 is not a node world.
    expect(isMultiSectorWorld(state)).toBe(true);
    expect(isNodeEconomyWorld(createWorld2Session())).toBe(false);
    expect(state.quarter).toBe(0);
    expect(state.lastResolvedQuarter).toBeNull();
  });

  it('still hands a version-2 setup to world 2, and no setup at all to world 1', () => {
    const two = createDemoSession(424242, { ...W3_DEFAULT_SETUP, worldVersion: 2 });
    expect(two.config.worldVersion).toBe(2);
    expect(isNodeEconomyWorld(two)).toBe(false);
    expect(createDemoSession().config.worldVersion).toBe(1);
  });

  it('sends a version-3 setup through the dispatcher to world 3', () => {
    const built = createDemoSession(424242, setupFor('humanoid_lab', 'east_asia'));
    expect(built.config.worldVersion).toBe(3);
    expect(built.companies).toHaveLength(25);
  });

  it('writes each industry\'s size at seed, and only at seed', () => {
    const baseline = state.industryBaselineUsd;
    expect(baseline).toBeDefined();
    const supply = supplyBySector(state);
    for (const sector of SECTORS) {
      expect(baseline?.[sector], `${sector} has no baseline`).toBeGreaterThan(0);
      expect(baseline?.[sector], `${sector}'s baseline is not its size at seed`).toBe(supply[sector]);
    }
    expect(createWorld2Session().industryBaselineUsd).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('world-3 node ownership', () => {
  const state = createWorld3Session();

  it('gives every company a real, bounded set of nodes', () => {
    for (const company of state.companies) {
      const owned = company.ownedNodes ?? [];
      expect(owned.length, `${company.id} owns nothing`).toBeGreaterThan(0);
      expect(owned.length, `${company.id} owns more than the schema allows`).toBeLessThanOrEqual(W3_MAX_OWNED_NODES);
      expect(new Set(owned).size, `${company.id} owns a duplicate`).toBe(owned.length);
      for (const id of owned) expect(economicNodeById(id), `${company.id} owns unknown node ${id}`).toBeDefined();
    }
  });

  it('leaves world-1 and world-2 companies with no ownership at all', () => {
    for (const company of createWorld2Session().companies) expect(company.ownedNodes, `${company.id}`).toBeUndefined();
    for (const company of createDemoSession().companies) expect(company.ownedNodes, `${company.id}`).toBeUndefined();
  });

  /*
   * The fix for world 2, where `manufacturing_accelerators` was a required
   * input of three categories and was sold by nobody, and where seven of
   * thirty-six categories were ever an input at all.
   */
  it('opens with a producer or an owner for every node in the table', () => {
    const unmade: string[] = [];
    for (const node of ECONOMIC_NODES) {
      const made = state.companies.some((company) => canProduce(company, node.id, 0));
      if (!made) unmade.push(node.id);
    }
    expect(unmade).toEqual([]);
  });

  it('lets every seeded rival make every line it opens selling', () => {
    const byId = new Map(state.companies.map((company) => [company.id, company] as const));
    for (const seed of V2_COMPANY_SEEDS) {
      const company = byId.get(seed.id);
      expect(company, `${seed.id} is missing from the world`).toBeDefined();
      if (company === undefined) continue;
      const lines = w3RivalLinesFor(seed.id);
      expect(lines.length, `${seed.name} opens with no line`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(canProduce(company, line.nodeId, 0), `${seed.name} cannot produce its own line ${line.nodeId}`).toBe(true);
      }
    }
  });

  it('lets the player make the line their background opens selling, in every sector', () => {
    for (const background of ALL_BACKGROUNDS) {
      const built = createWorld3Session(4242, setupFor(background.id, 'north_america'));
      const player = built.companies.find((company) => company.id === W2_COMPANIES.player);
      expect(player, `${background.id} built no player company`).toBeDefined();
      if (player === undefined) continue;
      const line = startingLineNodeFor(background.id);
      expect(canProduce(player, line, 0), `${background.id} cannot produce its own line ${line}`).toBe(true);
      expect(player.products[0]?.nodeId, `${background.id}'s first product is not its opening line`).toBe(line);
    }
  });

  it('starts an AI laboratory owning nothing above the ground in another industry', () => {
    const built = createWorld3Session(4242, setupFor('frontier_lab', 'north_america'));
    const player = built.companies.find((company) => company.id === W2_COMPANIES.player);
    const foreign = (player?.ownedNodes ?? [])
      .map((id) => ECONOMIC_NODES_BY_ID[id])
      .filter((node) => node !== undefined && node.tier > 0 && node.sector !== 'ai')
      .map((node) => node?.id ?? '');
    expect(foreign).toEqual([]);
  });

  it('gives every sector a rival whose line the node table, not another sector\'s mean, prices', () => {
    // World 3 judges a price against its own node's market price. The band
    // itself is asserted against the table in the contracts tests; what matters
    // here is that every seeded company has line nodes at all, each carrying a
    // real price of its own.
    for (const sector of SECTORS) {
      const inSector = V2_COMPANY_SEEDS.filter((entry) => entry.sector === sector);
      expect(inSector.length, `${sector} has no seeded rival`).toBeGreaterThan(0);
      for (const seed of inSector) {
        for (const line of w3RivalLinesFor(seed.id)) {
          const node = economicNodeById(line.nodeId);
          expect(node, `${seed.name} has no line node`).toBeDefined();
          expect(node?.basePriceUsd ?? 0, `${seed.name}'s line has no price`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('derives ownership rather than storing it, so the same subjects always give the same world', () => {
    const subjects = w3OwnershipSubjects(W3_DEFAULT_SETUP);
    expect(w3NodeOwnership(subjects)).toEqual(w3NodeOwnership(subjects));
    // One entry per company, player included.
    expect(Object.keys(w3NodeOwnership(subjects))).toHaveLength(V2_COMPANY_SEEDS.length + 1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The composed lines                                                         */
/* -------------------------------------------------------------------------- */

/** The line table as declared, checked before the world is built: what it says has to be sayable. */
function expectLineWellFormed(where: string, line: W3SeedLine, ownLines: readonly W3SeedLine[]): void {
  const node = ECONOMIC_NODES_BY_ID[line.nodeId];
  expect(node, `${where} names unknown node ${line.nodeId}`).toBeDefined();
  if (node === undefined) return;
  expect(line.revenueShare, `${where} has no revenue share`).toBeGreaterThan(0);
  expect(line.revenueShare, `${where} has a revenue share over one`).toBeLessThanOrEqual(1);
  // A line aimed at nobody is a line that sells nothing; the seed aims at a
  // cell its node's market actually weights.
  const industry = line.segment === 'consumer' ? 'consumer' : line.targetIndustry;
  const weight = (node.market.customers[line.segment] ?? 0) * (node.market.industries[industry] ?? 0);
  expect(weight, `${where} is aimed at a cell (${industry}, ${line.segment}) its market gives no weight`).toBeGreaterThan(0);

  const seen = new Set<string>();
  for (const fill of line.fills) {
    const slot = node.slots.find((entry) => entry.id === fill.slotId);
    expect(slot, `${where} fills unknown slot ${fill.slotId}`).toBeDefined();
    expect(seen.has(fill.slotId), `${where} fills ${fill.slotId} twice`).toBe(false);
    seen.add(fill.slotId);
    expect(
      admissibleNodesFor(node.id, fill.slotId).some((candidate) => candidate.id === fill.nodeId),
      `${where}: ${fill.nodeId} is not admissible for slot ${fill.slotId}`,
    ).toBe(true);
    if (fill.source === 'self') {
      // MAKE needs a line to make it on, in the same seed.
      expect(ownLines.some((candidate) => candidate.nodeId === fill.nodeId), `${where}: 'self' on ${fill.nodeId} but the company runs no line on it`).toBe(true);
    } else if (fill.source !== 'market') {
      // BUY needs a seller whose line on that node is published at seed.
      const seller = V2_COMPANY_SEEDS.find((seed) => seed.slug === fill.source);
      expect(seller, `${where}: supplier '${fill.source}' is not a seeded rival`).toBeDefined();
      const sold = w3RivalLinesFor(w3SeedCompanyId(fill.source)).find((candidate) => candidate.nodeId === fill.nodeId);
      expect(sold, `${where}: ${fill.source} runs no line on ${fill.nodeId}`).toBeDefined();
      expect(sold?.published, `${where}: ${fill.source}'s line on ${fill.nodeId} is not published`).toBe(true);
    }
  }
}

describe('the composed rival lines', () => {
  it('gives every seeded rival one to three well-formed lines whose revenue shares sum to one', () => {
    expect(Object.keys(W3_RIVAL_LINES).sort()).toEqual(V2_COMPANY_SEEDS.map((seed) => seed.id).sort());
    for (const seed of V2_COMPANY_SEEDS) {
      const lines = w3RivalLinesFor(seed.id);
      expect(lines.length, `${seed.name}`).toBeGreaterThanOrEqual(1);
      // CHANGED DELIBERATELY, fix-up: the bound was two. The harness layer and
      // the second structure material needed sellers, and a seller is a line,
      // so Aletheia, Sable and Volta compose three.
      expect(lines.length, `${seed.name} has more lines than the seed composes`).toBeLessThanOrEqual(3);
      expect(new Set(lines.map((line) => line.nodeId)).size, `${seed.name} sells one node twice`).toBe(lines.length);
      const shares = lines.reduce((sum, line) => sum + line.revenueShare, 0);
      expect(Math.abs(shares - 1), `${seed.name}'s revenue shares sum to ${shares}`).toBeLessThan(1e-9);
      lines.forEach((line, index) => expectLineWellFormed(`${seed.name} line ${index + 1} (${line.nodeId})`, line, lines));
    }
  });

  it('wires the owner\'s examples: Sable on its own model, Basalt on Aletheia\'s, Aletheia\'s suite on Basalt\'s API, Ironvale\'s robot on Cinder\'s pack and Wrenford\'s model', () => {
    const lineOn = (companyId: string, nodeId: string): W3SeedLine | undefined => w3RivalLinesFor(companyId).find((line) => line.nodeId === nodeId);
    const sourceOf = (line: W3SeedLine | undefined, slotId: string): string | undefined => line?.fills.find((fill) => fill.slotId === slotId)?.source;

    expect(sourceOf(lineOn(W2_COMPANIES.sable, 'svc_inference_api'), 'model')).toBe('self');
    expect(sourceOf(lineOn(W2_COMPANIES.basalt, 'svc_inference_api'), 'model')).toBe('aletheia');
    expect(sourceOf(lineOn(W2_COMPANIES.aletheia, 'app_ai_software_suite'), 'model')).toBe('basalt');
    expect(lineOn(W2_COMPANIES.aletheia, 'sys_frontier_model')?.published).toBe(true);
    expect(sourceOf(lineOn(W2_COMPANIES.ironvale, 'sys_warehouse_amr'), 'battery')).toBe('cinder');
    expect(sourceOf(lineOn(W2_COMPANIES.ironvale, 'sys_warehouse_amr'), 'model')).toBe('wrenford');
    expect(sourceOf(lineOn(W2_COMPANIES.overland, 'svc_routing_platform'), 'model')).toBe('sable');
    expect(sourceOf(lineOn(W2_COMPANIES.copa, 'app_marketplace'), 'model')).toBe('basalt');
    expect(lineOn(W2_COMPANIES.sentinel, 'sys_autonomous_drone')?.segment).toBe('government');
    expect(lineOn(W2_COMPANIES.palma, 'sys_industrial_arm')?.targetIndustry).toBe('manufacturing');
  });

  it('gives the harness layer, the robot control stack and the second structure material a seller each, from different companies', () => {
    const lineOn = (companyId: string, nodeId: string): W3SeedLine | undefined => w3RivalLinesFor(companyId).find((line) => line.nodeId === nodeId);
    const sourceOf = (line: W3SeedLine | undefined, slotId: string): string | undefined => line?.fills.find((fill) => fill.slotId === slotId)?.source;

    // "A harness from company B": two harness nodes, two companies, both published.
    expect(lineOn(W2_COMPANIES.aletheia, 'svc_agent_harness')?.published).toBe(true);
    expect(lineOn(W2_COMPANIES.sable, 'svc_copilot_framework')?.published).toBe(true);
    expect(sourceOf(lineOn(W2_COMPANIES.aletheia, 'app_ai_software_suite'), 'harness')).toBe('self');
    // The robot harness: Palma sells it and its own arm runs on it; Ironvale's robot buys it.
    expect(lineOn(W2_COMPANIES.palma, 'svc_robot_control_stack')?.published).toBe(true);
    expect(sourceOf(lineOn(W2_COMPANIES.palma, 'sys_industrial_arm'), 'harness')).toBe('self');
    expect(sourceOf(lineOn(W2_COMPANIES.ironvale, 'sys_warehouse_amr'), 'harness')).toBe('palma');
    // Two structure nodes from two producers, so a structure slot is a real choice.
    expect(lineOn(W2_COMPANIES.volta, 'mat_carbon_composite')?.published).toBe(true);
    expect(lineOn(W2_COMPANIES.rasan, 'mat_machined_structure')?.published).toBe(true);
    expect(sourceOf(lineOn(W2_COMPANIES.volta, 'sys_wind_turbine'), 'structure')).toBe('self');
    // And the openings that take a harness take it from a named company.
    expect(BACKGROUND_OPENING_LINE.consumer_ai.fills.find((fill) => fill.slotId === 'harness')?.source).toBe('aletheia');
    expect(BACKGROUND_OPENING_LINE.bootstrapper.fills.find((fill) => fill.slotId === 'harness')?.source).toBe('sable');
    expect(BACKGROUND_OPENING_LINE.warehouse_robotics.fills.find((fill) => fill.slotId === 'harness')?.source).toBe('palma');
  });

  it('writes every line onto its company, in table order, with the fills it declared', () => {
    const state = createWorld3Session();
    for (const seed of V2_COMPANY_SEEDS) {
      const company = state.companies.find((candidate) => candidate.id === seed.id) as Company;
      const lines = w3RivalLinesFor(seed.id);
      expect(company.products.map((product) => product.nodeId), seed.name).toEqual(lines.map((line) => line.nodeId));
      lines.forEach((line, index) => {
        const product = company.products[index];
        expect(product?.id, `${seed.name} line ${index + 1}`).toBe(w3SeedProductId(seed.slug, index));
        expect(product?.segment).toBe(line.segment);
        expect(product?.targetIndustry).toBe(line.targetIndustry);
        expect((product?.slots ?? []).map((fill) => fill.slotId)).toEqual(line.fills.map((fill) => fill.slotId));
        expect(product?.isActive).toBe(true);
        expect(product?.pricePerSeat ?? 0).toBeGreaterThan(0);
      });
    }
  });

  it('publishes every published seed line at its list price, and nothing else', () => {
    const state = createWorld3Session();
    let published = 0;
    for (const seed of V2_COMPANY_SEEDS) {
      const company = state.companies.find((candidate) => candidate.id === seed.id) as Company;
      w3RivalLinesFor(seed.id).forEach((line, index) => {
        const product = company.products[index];
        const terms = product?.supplyTerms ?? null;
        if (line.published) {
          expect(terms, `${seed.name}'s ${line.nodeId} is published but carries no terms`).not.toBeNull();
          expect(terms?.openToAll, `${seed.name}'s ${line.nodeId} is not open to all`).toBe(true);
          expect(terms?.pricePerUnitUsd, `${seed.name}'s ${line.nodeId} is not published at list`).toBe(product?.pricePerSeat);
          expect(terms?.blockedCustomerIds).toEqual([]);
          published += 1;
        } else {
          expect(terms, `${seed.name}'s ${line.nodeId} is not published but carries terms`).toBeNull();
        }
      });
    }
    expect(published).toBeGreaterThan(30);
  });

  it('resolves every self fill to MAKE and every supplier fill to BUY from the named company, at quarter zero', () => {
    const state = createWorld3Session();
    let makes = 0;
    let buys = 0;
    for (const seed of V2_COMPANY_SEEDS) {
      const company = state.companies.find((candidate) => candidate.id === seed.id) as Company;
      w3RivalLinesFor(seed.id).forEach((line, index) => {
        const product = company.products[index];
        const node = ECONOMIC_NODES_BY_ID[line.nodeId];
        if (product === undefined || node === undefined) return;
        for (const fill of line.fills) {
          const slot = node.slots.find((entry) => entry.id === fill.slotId);
          if (slot === undefined) continue;
          const resolved = resolveFill(state, company, product, node, slot);
          const where = `${seed.name}'s ${line.nodeId}/${fill.slotId}`;
          expect(resolved.nodeId, where).toBe(fill.nodeId);
          expect(resolved.changedThisQuarter, `${where} opens as a switch`).toBe(false);
          if (fill.source === 'self') {
            expect(resolved.route, where).toBe('make');
            expect(resolved.supplierCompanyId, where).toBe(company.id);
            makes += 1;
          } else if (fill.source === 'market') {
            expect(resolved.route, where).toBe('market');
          } else {
            expect(resolved.route, where).toBe('buy');
            expect(resolved.supplierCompanyId, where).toBe(w3SeedCompanyId(fill.source));
            expect(resolved.askUsd ?? 0, where).toBeGreaterThan(0);
            buys += 1;
          }
        }
      });
    }
    expect(makes).toBeGreaterThan(10);
    expect(buys).toBeGreaterThan(30);
  });

  it('splits a two-line rival\'s revenue by its declared shares, and books revenue as units times price', () => {
    const state = createWorld3Session();
    for (const seed of V2_COMPANY_SEEDS) {
      const company = state.companies.find((candidate) => candidate.id === seed.id) as Company;
      const lineRevenue = company.products.map((product) => Math.round((product.unitsSoldQuarterly ?? 0) * product.pricePerSeat * 100) / 100);
      const total = lineRevenue.reduce((sum, usd) => sum + usd, 0);
      expect(Math.abs(company.financials.revenueQuarterly - total), `${seed.name}'s statement disagrees with its lines`).toBeLessThan(0.02);
      if (company.products.length < 2) continue;
      // The run-rate lift scales every line by one factor, so the split the
      // seed declared survives it; the rounding of units to whole numbers is
      // the only slack.
      const lines = w3RivalLinesFor(seed.id);
      lineRevenue.forEach((usd, index) => {
        const share = usd / total;
        expect(Math.abs(share - (lines[index]?.revenueShare ?? 0)), `${seed.name} line ${index + 1} books ${share.toFixed(3)} of revenue`).toBeLessThan(0.05);
      });
    }
  });

  it('sizes a shared capacity bucket for every line drawing on it, so each line can make what it sells', () => {
    const state = createWorld3Session();
    const engine = createDefaultEngine();
    const after = engine.resolver.resolveQuarter(state, [], null, []).nextState;
    let checked = 0;
    for (const seed of V2_COMPANY_SEEDS) {
      const before = state.companies.find((candidate) => candidate.id === seed.id) as Company;
      const company = after.companies.find((candidate) => candidate.id === seed.id) as Company;
      if (before.products.length < 2) continue;
      for (const product of company.products) {
        const opening = before.products.find((candidate) => candidate.id === product.id);
        if (opening === undefined || (opening.unitsSoldQuarterly ?? 0) <= 0) continue;
        // Every line shipped something in the opening quarter: neither line of a
        // two-line rival is starved of the bucket by the other.
        expect(product.unitsSoldQuarterly ?? 0, `${seed.name}'s ${product.nodeId} shipped nothing`).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  }, 60_000);
});

describe('the composed background openings', () => {
  it('agrees with the signature: the opening line is the first signature node, for every background', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const line = BACKGROUND_OPENING_LINE[background];
      expect(line.nodeId, background).toBe(BACKGROUND_SIGNATURE_NODES[background][0]);
      expect(startingLineNodeFor(background), background).toBe(line.nodeId);
      expect(line.revenueShare, background).toBe(1);
    }
  });

  it('is well formed: admissible fills, published suppliers, a weighted target cell, and no self fill a single line cannot honour', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const line = BACKGROUND_OPENING_LINE[background];
      expectLineWellFormed(`${background} (${line.nodeId})`, line, []);
    }
  });

  it('opens the owner\'s example: enterprise AI sells a suite on Basalt\'s API with a market harness, aimed at logistics enterprises', () => {
    const line = BACKGROUND_OPENING_LINE.enterprise_ai;
    expect(line.nodeId).toBe('app_ai_software_suite');
    expect(line.fills.find((fill) => fill.slotId === 'model')).toEqual({ slotId: 'model', nodeId: 'svc_inference_api', source: 'basalt' });
    expect(line.fills.find((fill) => fill.slotId === 'harness')?.source).toBe('market');
    expect(line.segment).toBe('enterprise');
    expect(line.targetIndustry).toBe('logistics');
    expect(BACKGROUND_OPENING_LINE.consumer_ai.fills.find((fill) => fill.slotId === 'model')?.source).toBe('sable');
    expect(BACKGROUND_OPENING_LINE.bootstrapper.fills.find((fill) => fill.slotId === 'model')?.source).toBe('basalt');
    expect(BACKGROUND_OPENING_LINE.humanoid_lab.fills.find((fill) => fill.slotId === 'actuators')?.source).toBe('ironvale');
  });

  it('writes the composed line onto the player and resolves every fill to the route it was written for, in every background', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const line = BACKGROUND_OPENING_LINE[background];
      const state = createWorld3Session(4242, setupFor(background, 'north_america'));
      const player = state.companies.find((company) => company.id === W2_COMPANIES.player) as Company;
      const product = player.products[0];
      const node = ECONOMIC_NODES_BY_ID[line.nodeId];
      expect(player.products, `${background} opens with more than its one line`).toHaveLength(1);
      expect(product?.nodeId, background).toBe(line.nodeId);
      expect(product?.segment, background).toBe(line.segment);
      expect(product?.targetIndustry, background).toBe(line.targetIndustry);
      expect((product?.slots ?? []).map((fill) => fill.slotId), background).toEqual(line.fills.map((fill) => fill.slotId));
      if (line.published) {
        expect(product?.supplyTerms?.openToAll, `${background} is published but not open`).toBe(true);
        expect(product?.supplyTerms?.pricePerUnitUsd, `${background} is not published at list`).toBe(product?.pricePerSeat);
      } else {
        expect(product?.supplyTerms ?? null, `${background} carries terms it did not publish`).toBeNull();
      }
      if (product === undefined || node === undefined) continue;
      for (const fill of line.fills) {
        const slot = node.slots.find((entry) => entry.id === fill.slotId);
        if (slot === undefined) continue;
        const resolved = resolveFill(state, player, product, node, slot);
        const where = `${background}/${fill.slotId}`;
        expect(resolved.nodeId, where).toBe(fill.nodeId);
        if (fill.source === 'market') expect(resolved.route, where).toBe('market');
        else {
          expect(resolved.route, where).toBe('buy');
          expect(resolved.supplierCompanyId, where).toBe(w3SeedCompanyId(fill.source));
        }
      }
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*  The measured opening                                                       */
/* -------------------------------------------------------------------------- */

describe('the measured opening', () => {
  const state = createWorld3Session();

  it('opens every node at the index its own balance settles to, so the first quarter moves nothing the seed already implied', () => {
    const prices = state.nodePrices ?? {};
    expect(Object.keys(prices)).toHaveLength(ECONOMIC_NODES.length);
    const balances = nodeBalances(state);
    let short = 0;
    let imported = 0;
    for (const node of ECONOMIC_NODES) {
      const balance = balances[node.id];
      expect(balance, `${node.id} has no balance`).toBeDefined();
      if (balance === undefined) continue;
      // The phase's own step from the seeded index lands back on it: the seed
      // is the fixed point, not an approximation of it.
      expect(balance.indexBefore, `${node.id} did not open at the seeded index`).toBe(prices[node.id]);
      expect(balance.index, `${node.id} opened off its own fixed point`).toBe(prices[node.id]);
      if (balance.producerCount === 0) {
        // A node nobody produces is imported at balance: only a world shifter
        // (the accelerator supply index, the electricity price) can move it.
        expect(balance.imbalance, `${node.id} is imported yet not at balance`).toBe(0);
        if (balance.worldShifter === 1) expect(prices[node.id], `${node.id} is imported yet not at baseline`).toBe(NODE_PRICE_BASELINE);
        imported += 1;
      } else if ((prices[node.id] ?? 0) > NODE_PRICE_BASELINE) short += 1;
    }
    // A world of twenty-five companies against world-scale demand is short of
    // most of what it makes, and says so from quarter zero.
    expect(short).toBeGreaterThan(20);
    expect(imported).toBeGreaterThan(20);
    expect(createWorld2Session().nodePrices).toBeUndefined();
  });

  it('opens every sector at the goods index its own balance restates', () => {
    const balances = sectorBalances(state);
    for (const sector of SECTORS) {
      expect(state.sectorPrices?.[sector], `${sector} has no opening goods index`).toBe(balances[sector].priceIndex);
    }
    expect(createWorld2Session().sectorPrices).toBeUndefined();
  });

  it('asks every line nobody directs at or above its market price, and every line at or above its base price', () => {
    let tracked = 0;
    for (const company of state.companies) {
      for (const product of company.products) {
        const node = ECONOMIC_NODES_BY_ID[product.nodeId ?? ''];
        if (node === undefined) continue;
        const where = `${company.id}'s ${node.id}`;
        expect(product.pricePerSeat + 1e-6, `${where} asks under its base price`).toBeGreaterThanOrEqual(node.basePriceUsd);
        if (company.controllerPlayerId !== null) continue;
        // The tracking rule walks a line nobody directs to its node's price, so
        // it opens there rather than arriving over its first year.
        expect(product.pricePerSeat + 1e-6, `${where} asks under the market it will be walked to`).toBeGreaterThanOrEqual(nodeMarketPriceUsd(state, node.id));
        tracked += 1;
      }
    }
    expect(tracked).toBeGreaterThan(40);
  });

  it('opens the founder\'s line on the founder\'s own margin, floored at the base price and never handed the market\'s premium', () => {
    // The freight founder: line haul is short and its market price is 1.7x
    // base, but the founder's line was never walked there and opens at the
    // price its own margin supports. A founder who prices nothing does not
    // multiply their capital on a premium they never chose.
    const built = createWorld3Session(4242, setupFor('freight_network', 'north_america'));
    const player = built.companies.find((company) => company.id === W2_COMPANIES.player) as Company;
    const line = player.products[0];
    const node = ECONOMIC_NODES_BY_ID[line?.nodeId ?? ''];
    expect(node).toBeDefined();
    expect(line?.pricePerSeat).toBe(node?.basePriceUsd);
    expect(nodeMarketPriceUsd(built, node?.id ?? '')).toBeGreaterThan(line?.pricePerSeat ?? 0);
  });

  it('rates every line at the engine\'s own quality blend, suppliers included', () => {
    const cache = createNodeCostCache(state);
    let checked = 0;
    for (const company of state.companies) {
      for (const product of company.products) {
        const node = ECONOMIC_NODES_BY_ID[product.nodeId ?? ''];
        if (node === undefined) continue;
        const cost = unitCostOf(state, company, node.id, cache);
        const blend = effectiveQuality(state, company, product, node, cost, cache);
        expect(Math.abs(blend - product.qualityScore), `${company.id}'s ${node.id} opens rated ${product.qualityScore} but the engine says ${blend}`).toBeLessThan(1e-9);
        // The craft is the seed's own, so the tier lever and the data edge stay
        // legible as separate numbers.
        expect(product.craftQuality, `${company.id}'s ${node.id} lost its craft`).toBeDefined();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('builds the same world through the demo dispatcher, the unparsed input and createWorld3Session', () => {
    // The web's New Game goes through `demoSessionInput`; a card is a promise
    // about that button, so the three doors have to open on one world.
    const setup = setupFor('enterprise_ai', 'north_america');
    const direct = hashState(createWorld3Session(W3_SEED, setup));
    expect(hashState(createDemoSession(W3_SEED, setup))).toBe(direct);
    expect(hashState(SessionStateSchema.parse(world3SessionInput(W3_SEED, setup)))).toBe(direct);
    // And the measured fields are all there on the dispatcher's world.
    const dispatched = createDemoSession(W3_SEED, setup);
    expect(dispatched.nodePrices).toBeDefined();
    expect(dispatched.sectorPrices).toBeDefined();
    expect(dispatched.industryBaselineUsd).toBeDefined();
  });

  it('lifts a small licence line by the revenue it declares, not by a rounded unit count', () => {
    // Wrenford: $24M of seed revenue split evenly between a licence worth five
    // million and a robot worth a hundred thousand, lifted eleven times over
    // to pay 522 people. Rounding two and a half licences to three before the
    // lift booked 57% of the company on one line.
    const company = state.companies.find((candidate) => candidate.id === W2_COMPANIES.wrenford) as Company;
    const revenue = company.products.map((product) => (product.unitsSoldQuarterly ?? 0) * product.pricePerSeat);
    const total = revenue.reduce((sum, usd) => sum + usd, 0);
    w3RivalLinesFor(company.id).forEach((line, index) => {
      expect(Math.abs((revenue[index] ?? 0) / total - line.revenueShare), `Wrenford line ${index + 1}`).toBeLessThan(0.02);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                 */
/* -------------------------------------------------------------------------- */

describe('resolving world 3', () => {
  it('passes every invariant on the opening quarter', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld3Session(), [], null, []);
    const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
    expect(failures).toEqual([]);
    expect(outcome.committed).toBe(true);
  }, 60_000);

  it('resolves four quarters identically from the same seed', () => {
    const engine = createDefaultEngine();
    const run = (): string[] => {
      let state = createWorld3Session();
      const hashes: string[] = [];
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.committed).toBe(true);
        state = outcome.nextState;
        hashes.push(hashState(state));
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  }, 120_000);

  it('carries node ownership through a resolution unchanged', () => {
    const engine = createDefaultEngine();
    const before = createWorld3Session();
    const outcome = engine.resolver.resolveQuarter(before, [], null, []);
    const ownedOf = (companies: readonly Company[]): Record<string, readonly string[]> =>
      Object.fromEntries(companies.map((company) => [company.id, company.ownedNodes ?? []]));
    expect(ownedOf(outcome.nextState.companies)).toEqual(ownedOf(before.companies));
  }, 60_000);

  it('builds and resolves a first quarter from one start in every region', () => {
    const engine = createDefaultEngine();
    for (const region of REGIONS) {
      const outcome = engine.resolver.resolveQuarter(createWorld3Session(4242, setupFor('bootstrapper', region)), [], null, []);
      const failures = outcome.invariants.filter((result) => !result.passed).map((result) => result.invariant);
      expect(failures, `${region} failed`).toEqual([]);
      expect(outcome.committed).toBe(true);
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/*  World 2 stays where it is                                                  */
/* -------------------------------------------------------------------------- */

describe('the deprecated world-2 catalogue', () => {
  it('is not imported by any world-3 scenario module', () => {
    const sources = import.meta.glob('../src/scenario/world3/*.ts', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources).length, 'no world-3 scenario source was scanned').toBeGreaterThanOrEqual(1);
    // Comments may name the catalogue; only code counts, so they come out first.
    const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [path, source] of Object.entries(sources)) {
      const code = codeOf(source);
      expect(code.includes('PRODUCT_CATEGORIES'), `${path} names the deprecated catalogue`).toBe(false);
      expect(code.includes('categoryOf'), `${path} resolves a deprecated category`).toBe(false);
    }
  });
});

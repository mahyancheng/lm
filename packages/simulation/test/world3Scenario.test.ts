/**
 * The world-version-3 opening state.
 *
 * World 3 is the node economy: one table of nodes, one market price per node,
 * and ownership per company. This stage builds the ownership floor and the
 * scenario skeleton, so what is proved here is the floor:
 *
 * - **Worlds 1 and 2 do not move.** Both are pinned by hash in
 *   `world2Scenario.test.ts`; here it is enough to show world 3 is a different
 *   world and that a version-2 setup still builds world 2.
 * - **Every company can make what it sells.** For all fifteen backgrounds and
 *   all twenty-four seeded rivals, `canProduce` is true for that company's own
 *   opening line at quarter zero. This is the assertion world 2 lacked: there,
 *   a launch gate asked whether a node was achieved by *anybody*, exactly one
 *   of forty-two seeded nodes was, and a dozen product lines were locked on
 *   turn one for companies already selling them.
 * - **Every node has a producer.** World 2 shipped `manufacturing_accelerators`
 *   as a required input of three categories with no seller anywhere.
 * - **The engine accepts it.** Building a world nobody can resolve is not
 *   building a world, so the opening quarter is resolved for real with the
 *   invariant gate on, and four quarters are resolved twice and compared by
 *   state hash.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_BACKGROUNDS,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  NewGameSetupSchema,
  REGIONS,
  SECTORS,
  canProduce,
  economicNodeById,
  sectorForBackground,
  startingLineNodeFor,
  type Company,
} from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario';
import { createWorld2Session, V2_COMPANY_SEEDS, W2_COMPANIES } from '../src/scenario/world2';
import { W3_MAX_OWNED_NODES, createWorld3Session, w3LineNodeFor, w3NodeOwnership, w3OwnershipSubjects, W3_DEFAULT_SETUP } from '../src/scenario/world3';
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
  it('opens with a producer for every node in the table', () => {
    const unmade: string[] = [];
    for (const node of ECONOMIC_NODES) {
      const made = state.companies.some((company) => canProduce(company, node.id, 0));
      if (!made) unmade.push(node.id);
    }
    expect(unmade).toEqual([]);
  });

  it('lets every seeded rival make the line it opens selling', () => {
    const byId = new Map(state.companies.map((company) => [company.id, company] as const));
    for (const seed of V2_COMPANY_SEEDS) {
      const company = byId.get(seed.id);
      expect(company, `${seed.id} is missing from the world`).toBeDefined();
      if (company === undefined) continue;
      const line = w3LineNodeFor(seed.sector, seed.capabilityLevel);
      expect(canProduce(company, line, 0), `${seed.name} cannot produce its own line ${line}`).toBe(true);
      expect(economicNodeById(line)?.sector, `${seed.name}'s line is outside its sector`).toBe(seed.sector);
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

  it('gives every sector a line whose price the node table, not another sector\'s mean, sets', () => {
    // World 3 judges a price against its own node's market price. The band
    // itself is asserted against the table in the contracts tests; what matters
    // here is that every seeded company has a line node at all, in its own
    // sector, carrying a real price of its own.
    for (const sector of SECTORS) {
      const inSector = V2_COMPANY_SEEDS.filter((entry) => entry.sector === sector);
      expect(inSector.length, `${sector} has no seeded rival`).toBeGreaterThan(0);
      for (const seed of inSector) {
        const node = economicNodeById(w3LineNodeFor(seed.sector, seed.capabilityLevel));
        expect(node, `${seed.name} has no line node`).toBeDefined();
        expect(node?.sector, `${seed.name}'s line is outside its sector`).toBe(sector);
        expect(node?.basePriceUsd ?? 0, `${seed.name}'s line has no price`).toBeGreaterThan(0);
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

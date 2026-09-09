/**
 * @frontier/simulation — quarter resolution wall time on world 2.
 *
 * Stage #39's audit measured the *engine itself* at roughly a quarter of a
 * second per quarter on world 2 (25+ companies): the "extremely long wait" a
 * founder reports on the Pi is the live-model path (`endQuarter` in
 * `apps/web/src/lib/game/provider.tsx`), never the deterministic resolver.
 * This is the regression test that keeps it that way — a generous ceiling, not
 * a tight one, because the point is to catch an accidental O(n²) creeping back
 * in (a scan over companies × cap tables, JSON hashing per event, that kind of
 * thing), not to chase milliseconds.
 *
 * `Date.now()` is used here, in a *test*, not inside the
 * resolver — `resolver/index.ts` reads no clock by design (`durationMs` on
 * every `EnginePhaseTiming` is zero by construction) so that two runs of the
 * same seed can never disagree on account of wall-clock jitter. Timing the
 * resolver from *outside* it, as this file does, cannot affect what it
 * computes; the second half of every test below is the proof — the state hash
 * is asserted identical whether or not anything was ever timed.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { ECONOMIC_NODES } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld2Session } from '../src/scenario/world2';
import { createWorld3Session } from '../src/scenario/world3';
import { createNodeCostCache, nodeBalances, nodeLinesOf, unitCostOf } from '../src/graph';

/**
 * Generous on purpose. The measured range in this sandbox was 250-400ms for a
 * quarter on world 2's 25-company, six-sector roster; five seconds is a
 * hundred-times margin against a CI runner having a bad day, while still
 * catching a real quadratic blow-up (which would land in the tens of seconds,
 * not a few hundred milliseconds over budget).
 */
const GENEROUS_CEILING_MS = 5_000;

describe('quarter resolution wall time (world 2)', () => {
  it('resolves five quarters on world 2 well inside a generous ceiling', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    const perQuarterMs: number[] = [];

    for (let quarter = 0; quarter < 5; quarter += 1) {
      const startedAt = Date.now();
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      perQuarterMs.push(Date.now() - startedAt);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;
    }

    for (const ms of perQuarterMs) expect(ms).toBeLessThan(GENEROUS_CEILING_MS);
  });

  it('produces the identical state hash whether or not the call is timed', () => {
    const engine = createDefaultEngine();

    // Untimed: exactly what `endQuarter` does today.
    let untimed = createWorld2Session();
    for (let quarter = 0; quarter < 3; quarter += 1) {
      untimed = engine.resolver.resolveQuarter(untimed, [], null, []).nextState;
    }

    // Timed: the same calls, wrapped in `Date.now()` the way this
    // file's other test does.
    let timed = createWorld2Session();
    for (let quarter = 0; quarter < 3; quarter += 1) {
      const startedAt = Date.now();
      const outcome = engine.resolver.resolveQuarter(timed, [], null, []);
      void (Date.now() - startedAt);
      timed = outcome.nextState;
    }

    expect(hashState(timed)).toBe(hashState(untimed));
  });
});

/* -------------------------------------------------------------------------- */
/*  World 3: the node market and the roll-up must not go quadratic             */
/* -------------------------------------------------------------------------- */

/**
 * The two world-3 passes are the ones a future change is most likely to make
 * quadratic — a price recomputed inside a per-company loop, or a roll-up that
 * walks every company to find one line. Both are timed here at two sizes rather
 * than against an absolute ceiling, because a ceiling only says how fast this
 * machine is while the *ratio* says what the algorithm does.
 */
const SUB_QUADRATIC_RATIO = 3;

/** A floor under the comparison, so a sub-millisecond baseline cannot fail it on jitter. */
const TIMING_FLOOR_MS = 40;

/** How many times each pass is repeated, so the measurement is not one noisy sample. */
const REPEATS = 20;

/**
 * A world-3 session grown to `companyCount` companies, every one of them
 * running a line.
 *
 * The clones carry no cap table, so this state is for the *pure* passes only —
 * neither of which reads one — and never for a resolution.
 */
function world3WithCompanies(companyCount: number): SessionState {
  const state = createWorld3Session();
  const template = state.companies[0] as Company;
  while (state.companies.length < companyCount) {
    const index = state.companies.length;
    // A deep copy through JSON, because the clone must not share the arrays it
    // is about to be given its own lines in.
    const clone = JSON.parse(JSON.stringify(template)) as Company;
    state.companies.push({ ...clone, id: `cmp_perf_${index}`, name: `Perf ${index}`, isActive: true });
  }
  state.companies.length = companyCount;

  state.companies.forEach((company, index) => {
    const node = ECONOMIC_NODES[index % ECONOMIC_NODES.length];
    if (node === undefined) return;
    const line: Product = {
      id: `prd_perf_${index}`,
      name: node.label,
      segment: 'enterprise',
      nodeId: node.id,
      pricePerSeat: node.basePriceUsd,
      activeCustomers: 10_000,
      churnQuarterly: 0.05,
      growthQuarterly: 0,
      grossMarginPct: 0.4,
      computeIntensity: 0.5,
      qualityScore: 0.6,
      launchedQuarter: 0,
      isActive: true,
    };
    company.products = [line];
    company.capacity = { plantUsd: 500_000_000, fleetUsd: 500_000_000, gridUsd: 500_000_000 };
  });
  return state;
}

/** One pass of both world-3 computations over a whole world. */
function nodePassMs(state: SessionState): number {
  const startedAt = Date.now();
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    nodeBalances(state);
    const cache = createNodeCostCache(state);
    const byId = new Map(state.companies.map((company) => [company.id, company]));
    for (const line of nodeLinesOf(state)) {
      const company = byId.get(line.companyId);
      if (company === undefined) continue;
      unitCostOf(state, company, line.nodeId, cache);
    }
  }
  return Date.now() - startedAt;
}

describe('the node market and the cost roll-up (world 3)', () => {
  it('grows sub-quadratically from thirty companies to sixty', () => {
    const thirty = world3WithCompanies(30);
    const sixty = world3WithCompanies(60);

    // Warm the module graph so the first call does not pay for everything.
    nodePassMs(thirty);

    const smallMs = nodePassMs(thirty);
    const largeMs = nodePassMs(sixty);

    // Doubling the world may double the work. It may not quadruple it: that
    // would be a loop inside a loop, and the Pi would find it before CI did.
    expect(largeMs).toBeLessThan(Math.max(TIMING_FLOOR_MS, smallMs * SUB_QUADRATIC_RATIO));
  });

  it('resolves five world-3 quarters well inside the same generous ceiling', () => {
    const engine = createDefaultEngine();
    let state = createWorld3Session();
    for (let quarter = 0; quarter < 5; quarter += 1) {
      const startedAt = Date.now();
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      const elapsed = Date.now() - startedAt;
      expect(outcome.committed).toBe(true);
      expect(elapsed).toBeLessThan(GENEROUS_CEILING_MS);
      state = outcome.nextState;
    }
  });
});

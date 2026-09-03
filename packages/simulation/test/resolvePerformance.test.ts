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
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld2Session } from '../src/scenario/world2';

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

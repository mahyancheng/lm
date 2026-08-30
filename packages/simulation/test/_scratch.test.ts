import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario/demo';

const OUT: string[] = [];
const L = (...a: unknown[]) => OUT.push(a.map(String).join(' '));

describe('scratch', () => {
  it('prints', () => {
    const engine = createDefaultEngine();
    for (const seed of [424242, 7, 99991, 31337]) {
      let state = createDemoSession(seed);
      const supply: number[] = [];
      const spot: number[] = [];
      const fab: number[] = [];
      for (let q = 0; q < 24; q += 1) {
        const out = engine.resolver.resolveQuarter(state, [], null, []);
        if (!out.committed) {
          L(seed, 'q', q, 'NOT COMMITTED', out.invariants.filter((i) => !i.passed).map((i) => `${i.invariant}: ${i.detail}`).join(' | '));
          break;
        }
        state = out.nextState;
        supply.push(state.world.compute.acceleratorSupply);
        spot.push(state.world.compute.spotPrice);
        fab.push(state.world.compute.fabCapacity);
      }
      L('seed', seed, 'supply', supply.map((v) => v.toFixed(2)).join(' '));
      L('     ', '     ', 'spot  ', spot.map((v) => v.toFixed(2)).join(' '));
      L('     ', '     ', 'fab   ', fab.map((v) => v.toFixed(2)).join(' '));
      L(
        '     min', Math.min(...supply).toFixed(3),
        'max', Math.max(...supply).toFixed(3),
        'final', supply[supply.length - 1]?.toFixed(3),
        'maxAfterMin', Math.max(...supply.slice(supply.indexOf(Math.min(...supply)))).toFixed(3),
      );
    }
    writeFileSync('/tmp/claude-0/-home-user-lm/bf685dcd-7900-5bc5-a7dc-4e922675c9ff/scratchpad/out.txt', OUT.join('\n'));
  });
});

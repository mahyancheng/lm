import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario/demo';
import { heldComputeUnits, customersPerUnit, servingComputeUnits } from '../src/companies/products';

const OUT: string[] = [];
const L = (...a: unknown[]) => OUT.push(a.map(String).join(' '));
describe('scratch', () => {
  it('prints', () => {
    const state = createDemoSession();
    L('world compute', JSON.stringify(state.world.compute));
    L('world aiFrontier.inferenceCost', state.world.aiFrontier.inferenceCost);
    for (const c of state.companies) {
      const p = c.products[0]!;
      const implied = p.activeCustomers * p.pricePerSeat;
      const serving = servingComputeUnits(state, c);
      const cpu = customersPerUnit(state, p.computeIntensity);
      L(
        c.id.padEnd(22),
        'rev', (c.financials.revenueQuarterly / 1e6).toFixed(2) + 'M',
        'implied', (implied / 1e6).toFixed(4) + 'M',
        'ratio', (c.financials.revenueQuarterly / Math.max(1, implied)).toFixed(1),
        '| cust', p.activeCustomers, 'price', p.pricePerSeat, 'seg', p.segment,
        '| held', heldComputeUnits(state, c).toFixed(0), 'serving', serving.toFixed(0),
        'cpu', cpu.toFixed(1),
        'unitsNeededNow', (p.activeCustomers / cpu).toFixed(0),
        'unitsNeededIfScaled', ((c.financials.revenueQuarterly / p.pricePerSeat) / cpu).toFixed(0),
      );
    }
    const engine = createDefaultEngine();
    const out = engine.resolver.resolveQuarter(state, [], null, []);
    L('committed', out.committed);
    for (const c of out.nextState.companies) {
      const p = c.products[0]!;
      L(c.id.padEnd(22), 'rev after', (c.financials.revenueQuarterly / 1e6).toFixed(3) + 'M', 'cust', p.activeCustomers, 'cash', (c.financials.cash / 1e6).toFixed(1) + 'M');
    }
    writeFileSync('/tmp/claude-0/-home-user-lm/bf685dcd-7900-5bc5-a7dc-4e922675c9ff/scratchpad/out.txt', OUT.join('\n'));
  });
});
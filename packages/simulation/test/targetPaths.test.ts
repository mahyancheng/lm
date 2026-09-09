import { describe, expect, it } from 'vitest';
import {
  COMPANY_TARGET_METRICS,
  PATTERN_TARGET_PATHS,
  SECTOR_TARGET_METRICS,
  WORLD_TARGET_PATH_LIST,
  getTargetPathSpec,
} from '@frontier/contracts';
import type { TargetPathScope } from '@frontier/contracts';
import { applyToTargetPath, resolveTargetPath } from '../src/targetPaths';
import { makeState } from './_economyMarketsHarness';
import { buildTargetPathScope } from '../src/economy/scope';

const scopeOf = (): TargetPathScope => buildTargetPathScope(makeState());

describe('resolveTargetPath', () => {
  it('reads every registered fixed world path', () => {
    const scope = scopeOf();
    for (const path of WORLD_TARGET_PATH_LIST) {
      const value = resolveTargetPath(scope, path);
      expect(value, path).not.toBeNull();
      expect(Number.isFinite(value ?? NaN), path).toBe(true);
    }
  });

  it('reads sector and company pattern paths', () => {
    const scope = scopeOf();
    for (const metric of SECTOR_TARGET_METRICS) {
      expect(resolveTargetPath(scope, `sector.semiconductors.${metric}`)).not.toBeNull();
    }
    for (const metric of COMPANY_TARGET_METRICS) {
      expect(resolveTargetPath(scope, `company.cmp_nexus.${metric}`)).not.toBeNull();
    }
  });

  it('returns null for an unregistered path and for a missing entity', () => {
    const scope = scopeOf();
    expect(resolveTargetPath(scope, 'world.macro.notAVariable')).toBeNull();
    expect(resolveTargetPath(scope, 'instrument.ins_reference_ndx.price')).toBeNull();
    expect(resolveTargetPath(scope, 'sector.atlantis.sentiment')).toBeNull();
    expect(resolveTargetPath(scope, 'company.cmp_nowhere.reputationPublic')).toBeNull();
  });
});

describe('applyToTargetPath', () => {
  it('adds, multiplies and writes through to the scope', () => {
    const scope = scopeOf();
    const before = resolveTargetPath(scope, 'world.society.aiTrust') ?? 0;

    const added = applyToTargetPath(scope, 'world.society.aiTrust', 'add', 0.1);
    expect(added.applied).toBe(true);
    expect(added.clamped).toBe(false);
    expect(added.after).toBeCloseTo(before + 0.1, 12);
    expect(resolveTargetPath(scope, 'world.society.aiTrust')).toBeCloseTo(before + 0.1, 12);

    const spot = resolveTargetPath(scope, 'world.compute.spotPrice') ?? 1;
    const multiplied = applyToTargetPath(scope, 'world.compute.spotPrice', 'multiply', 1.2);
    expect(multiplied.applied).toBe(true);
    expect(multiplied.after).toBeCloseTo(spot * 1.2, 10);
  });

  it('clamps to the registered bounds rather than throwing', () => {
    const scope = scopeOf();
    const high = applyToTargetPath(scope, 'world.society.aiTrust', 'add', 5);
    expect(high.applied).toBe(true);
    expect(high.clamped).toBe(true);
    expect(high.after).toBe(1);

    const low = applyToTargetPath(scope, 'world.society.aiTrust', 'add', -5);
    expect(low.after).toBe(0);

    const spec = getTargetPathSpec('world.compute.spotPrice');
    const huge = applyToTargetPath(scope, 'world.compute.spotPrice', 'multiply', 10_000);
    expect(huge.after).toBe(spec?.max);
    expect(huge.after).toBeLessThanOrEqual(10);
  });

  it('refuses an operation the registry does not permit', () => {
    const scope = scopeOf();
    const set = applyToTargetPath(scope, 'world.macro.gdpGrowth', 'set', 0.05);
    expect(set.applied).toBe(false);
    expect(set.reason).toContain('operation_not_permitted');
    // The value is untouched by a refused application.
    expect(resolveTargetPath(scope, 'world.macro.gdpGrowth')).toBe(set.before);

    const multiplyGdp = applyToTargetPath(scope, 'world.macro.gdpGrowth', 'multiply', 1.1);
    expect(multiplyGdp.applied).toBe(false);
  });

  it('refuses unknown paths, unknown entities and non-finite operands', () => {
    const scope = scopeOf();
    expect(applyToTargetPath(scope, 'world.macro.somethingElse', 'add', 0.1).reason).toContain('unknown_target_path');
    expect(applyToTargetPath(scope, 'company.cmp_nowhere.reputationPublic', 'add', 1).reason).toContain('unknown_entity');
    expect(applyToTargetPath(scope, 'sector.atlantis.demand', 'add', 0.1).applied).toBe(false);

    const nan = applyToTargetPath(scope, 'world.society.aiTrust', 'add', Number.NaN);
    expect(nan.applied).toBe(false);
    expect(resolveTargetPath(scope, 'world.society.aiTrust')).not.toBeNaN();

    const infinite = applyToTargetPath(scope, 'world.compute.spotPrice', 'multiply', Number.POSITIVE_INFINITY);
    expect(infinite.applied).toBe(false);
    expect(Number.isFinite(resolveTargetPath(scope, 'world.compute.spotPrice') ?? NaN)).toBe(true);
  });

  it('never produces a value outside the registry bounds, for any path or operand', () => {
    const scope = scopeOf();
    const operands = [-1e9, -3.5, -0.5, 0, 0.5, 2, 1e9];
    const patternPaths = [
      ...SECTOR_TARGET_METRICS.map((metric) => `sector.frontier_models.${metric}`),
      ...COMPANY_TARGET_METRICS.map((metric) => `company.cmp_orbit.${metric}`),
    ];

    for (const path of [...WORLD_TARGET_PATH_LIST, ...patternPaths]) {
      const spec = getTargetPathSpec(path);
      expect(spec, path).not.toBeNull();
      if (spec === null) continue;
      for (const operation of spec.operations) {
        for (const operand of operands) {
          const result = applyToTargetPath(scope, path, operation, operand);
          if (!result.applied) continue;
          expect(Number.isFinite(result.after), `${path} ${operation} ${operand}`).toBe(true);
          expect(result.after, `${path} ${operation} ${operand}`).toBeGreaterThanOrEqual(spec.min);
          expect(result.after, `${path} ${operation} ${operand}`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it('scales a company reputation on the 0..100 scale the registry declares', () => {
    const scope = scopeOf();
    const before = resolveTargetPath(scope, 'company.cmp_nexus.reputationPublic') ?? 0;
    const result = applyToTargetPath(scope, 'company.cmp_nexus.reputationPublic', 'add', -12);
    expect(result.applied).toBe(true);
    expect(result.after).toBeCloseTo(before - 12, 10);
  });

  it('keeps every pattern spec addressable through the same code path', () => {
    const scope = scopeOf();
    for (const spec of PATTERN_TARGET_PATHS) {
      const concrete = spec.template.replace('{sectorId}', 'consumer_ai').replace('{companyId}', 'cmp_helix');
      expect(getTargetPathSpec(concrete), concrete).not.toBeNull();
      expect(resolveTargetPath(scope, concrete), concrete).not.toBeNull();
    }
  });
});

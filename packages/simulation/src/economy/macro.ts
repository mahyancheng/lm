/**
 * @frontier/simulation — economy/macro.ts
 *
 * Quarterly drift of the twelve world domains: the world's own dynamics, before
 * any event or modifier applies.
 *
 * Every variable is a mean-reverting process
 *
 * ```text
 * x_{t+1} = x_t + θ · (target(w_t) − x_t) + σ · ε        (level variables)
 * x_{t+1} = x_t^{1−θ} · target(w_t)^θ · e^{σ·ε}          (index variables)
 * x_{t+1} = x_t + max(0, rate(w_t) + σ · ε)              (ratchet variables)
 * ```
 *
 * where `target` is a function of the **previous** quarter's world — every
 * target reads a frozen snapshot, so the order of the table below has no effect
 * on the result and the cross-domain couplings are simultaneous rather than
 * cascading. `ε` is a standard normal from the seeded stream; `σ` is small
 * relative to the event budget, because the weather should come from events the
 * player can read, not from unexplained drift.
 *
 * The couplings encode the causal spine described in `docs/SIMULATION.md`:
 * the policy rate responds to inflation and growth; venture liquidity and the
 * listing window follow risk appetite; risk appetite follows spreads, rates and
 * demonstrated capability; the compute spot price follows accelerator supply and
 * energy; electricity follows datacentre draw and grid constraint; regulation
 * follows trust; government demand follows conflict risk.
 *
 * Index variables never go non-positive (they are updated in log space) and every
 * write is clamped to the registered bounds, so no drift can produce a NaN, an
 * Infinity or an out-of-schema value.
 */

import type { DominantNarrative, SeededRng, WorldState } from '@frontier/contracts';
import { clampToTargetBounds, getTargetPathSpec } from '@frontier/contracts';
import { clamp, standardNormal } from './util';

/* -------------------------------------------------------------------------- */
/*  Drift table                                                                */
/* -------------------------------------------------------------------------- */

type DriftMode = 'level' | 'index' | 'ratchet';

interface DriftSpec {
  /** Registered target path — supplies the bounds this write is clamped to. */
  readonly path: string;
  /** Short label for the resolution report. */
  readonly label: string;
  /**
   * For `level` and `index`, the value the variable reverts toward.
   * For `ratchet`, the per-quarter increment before noise.
   */
  readonly target: (w: WorldState) => number;
  readonly theta: number;
  readonly sigma: number;
  readonly mode: DriftMode;
}

const level = (path: string, label: string, target: (w: WorldState) => number, theta: number, sigma: number): DriftSpec => ({
  path,
  label,
  target,
  theta,
  sigma,
  mode: 'level',
});

const index = (path: string, label: string, target: (w: WorldState) => number, theta: number, sigma: number): DriftSpec => ({
  path,
  label,
  target,
  theta,
  sigma,
  mode: 'index',
});

const ratchet = (path: string, label: string, rate: (w: WorldState) => number, sigma: number): DriftSpec => ({
  path,
  label,
  target: rate,
  theta: 1,
  sigma,
  mode: 'ratchet',
});

/**
 * The drift table. Order is fixed: it determines the order of RNG draws and
 * therefore the exact noise each variable receives. Adding a row shifts the
 * draws of every row below it, which is why new variables are appended.
 */
export const WORLD_DRIFT_SPECS: readonly DriftSpec[] = [
  /* -- Macro ------------------------------------------------------------- */
  level(
    'world.macro.gdpGrowth',
    'GDP growth',
    (w) => 0.024 - 0.3 * (w.macro.policyRate - 0.035) - 0.4 * (w.macro.creditSpreads - 0.015) + 0.012 * (w.aiFrontier.trainingEfficiency - 0.5),
    0.25,
    0.006,
  ),
  level(
    'world.macro.inflation',
    'Inflation',
    (w) => 0.022 + 0.02 * (w.energy.electricityPrice - 1) + 0.01 * (w.compute.spotPrice - 1) + 0.012 * (w.geopolitics.tradeFriction - 0.3),
    0.2,
    0.005,
  ),
  level(
    'world.macro.policyRate',
    'Policy rate',
    // A Taylor-style rule: the central bank leans against inflation and, more
    // gently, against the output gap.
    (w) => 0.02 + 1.5 * (w.macro.inflation - 0.02) + 0.5 * (w.macro.gdpGrowth - 0.024),
    0.35,
    0.0015,
  ),
  level(
    'world.macro.unemployment',
    'Unemployment',
    (w) => 0.042 - 0.6 * (w.macro.gdpGrowth - 0.024) + 0.015 * (w.aiFrontier.frontierCapability - 0.5),
    0.3,
    0.003,
  ),
  level(
    'world.macro.creditSpreads',
    'Credit spreads',
    (w) => 0.012 + 0.03 * (0.5 - w.capitalMarkets.riskAppetite) + 0.5 * Math.max(0, -w.macro.gdpGrowth),
    0.3,
    0.002,
  ),
  level('world.macro.fxVolatility', 'FX volatility', (w) => 0.2 + 0.45 * w.geopolitics.conflictRisk + 0.25 * w.geopolitics.sanctions, 0.25, 0.03),
  level(
    'world.macro.consumerDemand',
    'Consumer demand',
    (w) => 0.5 + 2 * (w.macro.gdpGrowth - 0.024) - 0.8 * (w.macro.unemployment - 0.045) + 0.25 * (w.society.consumerSentiment - 0.5),
    0.3,
    0.03,
  ),

  /* -- Capital markets --------------------------------------------------- */
  level(
    'world.capitalMarkets.riskAppetite',
    'Risk appetite',
    (w) =>
      0.52 -
      6 * (w.macro.creditSpreads - 0.015) -
      1.2 * (w.macro.policyRate - 0.03) +
      0.3 * (w.aiFrontier.frontierCapability - 0.5) +
      0.15 * (w.society.aiTrust - 0.5),
    0.3,
    0.05,
  ),
  level(
    'world.capitalMarkets.ipoWindow',
    'IPO window',
    (w) => 0.15 + 0.7 * w.capitalMarkets.riskAppetite - 0.4 * w.capitalMarkets.volatility + 0.1 * (w.capitalMarkets.sectorMultiples - 1),
    0.35,
    0.05,
  ),
  level(
    'world.capitalMarkets.ventureLiquidity',
    'Venture liquidity',
    (w) => 0.25 + 0.65 * w.capitalMarkets.riskAppetite - 3 * (w.macro.creditSpreads - 0.015),
    0.3,
    0.04,
  ),
  index('world.capitalMarkets.sectorMultiples', 'Sector multiples', (w) => 0.6 + 0.9 * w.capitalMarkets.riskAppetite, 0.25, 0.05),
  level(
    'world.capitalMarkets.volatility',
    'Equity volatility',
    (w) => 0.2 + 0.35 * (1 - w.capitalMarkets.riskAppetite) + 0.25 * w.macro.fxVolatility,
    0.3,
    0.05,
  ),
  level(
    'world.capitalMarkets.debtAvailability',
    'Debt availability',
    (w) => 0.75 - 8 * (w.macro.creditSpreads - 0.015) - 1.5 * (w.macro.policyRate - 0.03),
    0.3,
    0.04,
  ),

  /* -- Compute ----------------------------------------------------------- */
  level(
    'world.compute.acceleratorSupply',
    'Accelerator supply',
    (w) => 0.35 + 0.55 * w.compute.fabCapacity - 0.25 * w.regulation.exportControls - 0.15 * w.geopolitics.tradeFriction,
    0.25,
    0.03,
  ),
  level(
    'world.compute.cloudCapacity',
    'Cloud capacity',
    (w) => 0.3 + 0.5 * w.compute.acceleratorSupply + 0.25 * w.energy.datacentreAccess - 0.2 * w.energy.gridConstraint,
    0.3,
    0.03,
  ),
  index(
    'world.compute.spotPrice',
    'Compute spot price',
    (w) => (0.6 + 0.8 * (1 - w.compute.acceleratorSupply) + 0.3 * w.compute.energyDemand) * (0.65 + 0.35 * w.energy.electricityPrice),
    0.35,
    0.05,
  ),
  index('world.compute.reservedPrice', 'Reserved compute price', (w) => 0.85 * w.compute.spotPrice, 0.25, 0.02),
  index(
    'world.compute.fabCapacity',
    'Fabrication capacity',
    // Slow-moving by construction: θ is a third of everything else, so a fab
    // shock takes several quarters to unwind.
    (w) => clamp(0.55 - 0.2 * w.geopolitics.conflictRisk - 0.15 * w.geopolitics.tradeFriction, 0.05, 1),
    0.1,
    0.015,
  ),
  level(
    'world.compute.energyDemand',
    'Datacentre energy draw',
    (w) => 0.3 + 0.4 * w.aiFrontier.frontierCapability + 0.25 * (1 - w.aiFrontier.trainingEfficiency),
    0.2,
    0.02,
  ),

  /* -- Energy ------------------------------------------------------------ */
  index(
    'world.energy.electricityPrice',
    'Electricity price',
    (w) => (0.75 + 0.55 * w.compute.energyDemand) * (1 + 0.25 * w.energy.gridConstraint) * (1 - 0.15 * w.energy.renewableCapacity),
    0.3,
    0.04,
  ),
  level(
    'world.energy.datacentreAccess',
    'Datacentre access',
    (w) => 0.6 - 0.35 * w.energy.gridConstraint - 0.25 * (1 - w.society.aiTrust),
    0.2,
    0.03,
  ),
  level('world.energy.renewableCapacity', 'Clean generation share', () => 0.75, 0.05, 0.01),
  level('world.energy.gridConstraint', 'Grid constraint', (w) => 0.15 + 0.6 * w.compute.energyDemand - 0.3 * w.energy.datacentreAccess, 0.25, 0.03),

  /* -- AI frontier ------------------------------------------------------- */
  ratchet(
    'world.aiFrontier.frontierCapability',
    'Frontier capability',
    // Rises with efficiency and available compute, slows as it approaches the
    // ceiling, and can stall outright when the noise draw goes against it.
    (w) => 0.012 * (1 - w.aiFrontier.frontierCapability) * (0.5 + w.aiFrontier.trainingEfficiency) * (0.4 + 0.6 * w.compute.acceleratorSupply),
    0.004,
  ),
  index(
    'world.aiFrontier.inferenceCost',
    'Inference cost',
    (w) => 0.97 * (1.05 - 0.55 * w.aiFrontier.trainingEfficiency) * (0.7 + 0.3 * w.compute.spotPrice),
    0.3,
    0.03,
  ),
  ratchet(
    'world.aiFrontier.trainingEfficiency',
    'Training efficiency',
    (w) => 0.01 * (1 - w.aiFrontier.trainingEfficiency) * (0.5 + 0.5 * w.talent.researcherSupply),
    0.003,
  ),
  level('world.aiFrontier.openSourceGap', 'Open-weight gap', (w) => 0.4 - 0.3 * (w.society.developerSentiment - 0.5), 0.15, 0.02),
  ratchet(
    'world.aiFrontier.benchmarkSaturation',
    'Benchmark saturation',
    (w) => 0.02 * w.aiFrontier.frontierCapability * (1 - w.aiFrontier.benchmarkSaturation),
    0.005,
  ),

  /* -- Talent ------------------------------------------------------------ */
  level(
    'world.talent.researcherSupply',
    'Researcher supply',
    (w) => 0.42 + 0.25 * w.talent.immigrationAccess - 0.2 * (w.aiFrontier.frontierCapability - 0.5),
    0.2,
    0.03,
  ),
  level(
    'world.talent.engineerSupply',
    'Engineer supply',
    (w) => 0.45 + 0.25 * w.talent.immigrationAccess + 0.6 * (w.macro.unemployment - 0.045),
    0.2,
    0.03,
  ),
  index(
    'world.talent.salaryPressure',
    'Salary pressure',
    (w) => (0.85 + 0.5 * (1 - w.talent.researcherSupply)) * (0.9 + 0.2 * (1 - w.talent.engineerSupply)),
    0.25,
    0.03,
  ),
  level(
    'world.talent.immigrationAccess',
    'Immigration access',
    (w) => 0.6 - 0.4 * w.geopolitics.tradeFriction - 0.25 * w.regulation.exportControls,
    0.15,
    0.02,
  ),

  /* -- Data -------------------------------------------------------------- */
  level(
    'world.dataDomain.dataAvailability',
    'Data availability',
    (w) => 0.55 - 0.35 * w.regulation.copyright - 0.25 * w.regulation.privacy + 0.2 * w.dataDomain.syntheticDataMaturity,
    0.2,
    0.02,
  ),
  index(
    'world.dataDomain.licensingCost',
    'Data licensing cost',
    (w) => (0.8 + 0.6 * w.regulation.copyright) * (1.15 - 0.3 * w.dataDomain.syntheticDataMaturity),
    0.25,
    0.03,
  ),
  level('world.dataDomain.privacyRestriction', 'Privacy restriction', (w) => 0.25 + 0.6 * w.regulation.privacy, 0.2, 0.02),
  ratchet(
    'world.dataDomain.syntheticDataMaturity',
    'Synthetic data maturity',
    (w) => 0.012 * (1 - w.dataDomain.syntheticDataMaturity) * (0.5 + 0.5 * (1 - w.dataDomain.dataAvailability)),
    0.004,
  ),

  /* -- Society ----------------------------------------------------------- */
  level(
    'world.society.aiTrust',
    'Public trust in AI',
    (w) => 0.55 - 0.3 * (w.media.controversyIntensity - 0.4) - 0.25 * (w.society.automationAnxiety - 0.5) + 0.15 * (w.regulation.safetyObligations - 0.4),
    0.2,
    0.03,
  ),
  level(
    'world.society.automationAnxiety',
    'Automation anxiety',
    (w) => 0.3 + 0.35 * w.aiFrontier.frontierCapability + 3 * (w.macro.unemployment - 0.045),
    0.2,
    0.03,
  ),
  level(
    'world.society.consumerSentiment',
    'Consumer sentiment',
    (w) => 0.35 + 0.4 * w.macro.consumerDemand + 0.25 * (w.society.aiTrust - 0.5),
    0.25,
    0.03,
  ),
  level(
    'world.society.developerSentiment',
    'Developer sentiment',
    (w) => 0.45 + 0.3 * (1 - w.aiFrontier.openSourceGap) - 0.1 * (w.aiFrontier.inferenceCost - 1),
    0.25,
    0.03,
  ),

  /* -- Regulation (slow: rules mostly move through events) ---------------- */
  level('world.regulation.modelRules', 'Model rules', (w) => 0.25 + 0.3 * (1 - w.society.aiTrust) + 0.25 * w.regulation.safetyObligations, 0.06, 0.01),
  level('world.regulation.privacy', 'Privacy enforcement', (w) => 0.35 + 0.3 * w.dataDomain.privacyRestriction, 0.06, 0.01),
  level('world.regulation.antitrust', 'Antitrust intensity', (w) => 0.3 + 0.25 * w.media.controversyIntensity, 0.06, 0.01),
  level('world.regulation.copyright', 'Copyright enforcement', (w) => 0.35 + 0.25 * (1 - w.dataDomain.dataAvailability), 0.06, 0.01),
  level('world.regulation.safetyObligations', 'Safety obligations', (w) => 0.3 + 0.4 * (1 - w.society.aiTrust), 0.06, 0.01),
  level('world.regulation.exportControls', 'Export controls', (w) => 0.2 + 0.6 * w.geopolitics.techCompetition, 0.08, 0.01),

  /* -- Government -------------------------------------------------------- */
  level(
    'world.government.procurementBudget',
    'Procurement budget',
    (w) => 0.35 + 0.3 * w.government.defenceUrgency + 0.2 * w.government.digitalModernisation + 1.5 * (w.macro.gdpGrowth - 0.02),
    0.2,
    0.03,
  ),
  level('world.government.defenceUrgency', 'Defence urgency', (w) => 0.2 + 0.6 * w.geopolitics.conflictRisk + 0.3 * w.geopolitics.techCompetition, 0.2, 0.03),
  level('world.government.digitalModernisation', 'Digital modernisation', (w) => 0.4 + 0.5 * (w.aiFrontier.frontierCapability - 0.5), 0.15, 0.03),
  level(
    'world.government.grantFunding',
    'Grant funding',
    (w) => 0.35 + 0.4 * w.government.procurementBudget - 1.5 * (w.macro.policyRate - 0.03),
    0.15,
    0.03,
  ),

  /* -- Geopolitics ------------------------------------------------------- */
  level('world.geopolitics.tradeFriction', 'Trade friction', (w) => 0.25 + 0.5 * w.geopolitics.techCompetition + 0.3 * w.geopolitics.sanctions, 0.12, 0.02),
  level('world.geopolitics.conflictRisk', 'Conflict risk', () => 0.22, 0.1, 0.02),
  level('world.geopolitics.sanctions', 'Sanctions breadth', (w) => 0.15 + 0.5 * w.geopolitics.conflictRisk + 0.3 * w.geopolitics.techCompetition, 0.12, 0.02),
  level(
    'world.geopolitics.techCompetition',
    'Technology competition',
    (w) => 0.4 + 0.6 * (w.aiFrontier.frontierCapability - 0.5) + 0.2 * w.geopolitics.conflictRisk,
    0.12,
    0.02,
  ),

  /* -- Media ------------------------------------------------------------- */
  level(
    'world.media.attentionLevel',
    'Media attention',
    (w) => 0.3 + 0.35 * w.media.controversyIntensity + 0.3 * (w.aiFrontier.frontierCapability - 0.4),
    0.3,
    0.05,
  ),
  level('world.media.institutionalTrust', 'Institutional trust', (w) => 0.5 - 0.25 * (w.media.controversyIntensity - 0.4), 0.15, 0.03),
  level('world.media.controversyIntensity', 'Controversy intensity', (w) => 0.25 + 0.3 * (w.society.automationAnxiety - 0.5), 0.35, 0.05),
];

/* -------------------------------------------------------------------------- */
/*  Application                                                                */
/* -------------------------------------------------------------------------- */

/** One variable's movement across a quarter of drift. */
export interface DriftChange {
  readonly path: string;
  readonly label: string;
  readonly before: number;
  readonly after: number;
  /** Movement expressed as a fraction of the variable's registered range. */
  readonly normalisedDelta: number;
}

function readWorldNumber(world: WorldState, path: string): number | null {
  const parts = path.split('.');
  const domainKey = parts[1];
  const fieldKey = parts[2];
  if (parts.length !== 3 || parts[0] !== 'world' || domainKey === undefined || fieldKey === undefined) return null;
  const domains = world as unknown as Record<string, Record<string, unknown> | undefined>;
  const domain = domains[domainKey];
  if (domain === undefined) return null;
  const value = domain[fieldKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function writeWorldNumber(world: WorldState, path: string, value: number): void {
  const parts = path.split('.');
  const domainKey = parts[1];
  const fieldKey = parts[2];
  if (parts.length !== 3 || domainKey === undefined || fieldKey === undefined) return;
  const domains = world as unknown as Record<string, Record<string, number> | undefined>;
  const domain = domains[domainKey];
  if (domain === undefined) return;
  domain[fieldKey] = value;
}

/** A deep copy of the world, so every drift target reads the same frozen snapshot. */
function snapshotWorld(world: WorldState): WorldState {
  return JSON.parse(JSON.stringify(world)) as WorldState;
}

/**
 * Advance every world variable by one quarter of its own dynamics.
 *
 * Returns the per-variable movements, largest first by normalised size, so the
 * caller can put the two or three that matter into the resolution report.
 */
export function driftWorld(world: WorldState, rng: SeededRng): DriftChange[] {
  const previous = snapshotWorld(world);
  const changes: DriftChange[] = [];

  for (const spec of WORLD_DRIFT_SPECS) {
    const pathSpec = getTargetPathSpec(spec.path);
    const before = readWorldNumber(world, spec.path);
    // Every drifted variable is a registered target path; a mismatch means the
    // registry and this table have diverged, and doing nothing is the safe answer.
    if (pathSpec === null || before === null) continue;

    const shock = standardNormal(rng);
    let raw: number;

    if (spec.mode === 'ratchet') {
      const rate = spec.target(previous);
      raw = before + Math.max(0, (Number.isFinite(rate) ? rate : 0) + spec.sigma * shock);
    } else if (spec.mode === 'index') {
      const target = clamp(spec.target(previous), Math.max(pathSpec.min, 1e-6), pathSpec.max);
      const base = Math.max(before, 1e-6);
      raw = Math.exp((1 - spec.theta) * Math.log(base) + spec.theta * Math.log(target) + spec.sigma * shock);
    } else {
      const target = clamp(spec.target(previous), pathSpec.min, pathSpec.max);
      raw = before + spec.theta * (target - before) + spec.sigma * shock;
    }

    const { value: after } = clampToTargetBounds(pathSpec, raw);
    writeWorldNumber(world, spec.path, after);

    const span = pathSpec.max - pathSpec.min;
    changes.push({
      path: spec.path,
      label: spec.label,
      before,
      after,
      normalisedDelta: span > 0 ? (after - before) / span : 0,
    });
  }

  changes.sort((a, b) => {
    const diff = Math.abs(b.normalisedDelta) - Math.abs(a.normalisedDelta);
    return diff !== 0 ? diff : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return changes;
}

/* -------------------------------------------------------------------------- */
/*  Dominant narrative                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The frame the press is currently using. Chosen deterministically from the
 * world, with hysteresis: the incumbent narrative keeps a margin, so the story
 * of the industry does not flip every quarter on a rounding difference.
 */
export function selectDominantNarrative(world: WorldState, incumbent: DominantNarrative): DominantNarrative {
  const scores: { narrative: DominantNarrative; score: number }[] = [
    { narrative: 'bubble_concern', score: 0.9 * Math.max(0, world.capitalMarkets.sectorMultiples - 1.5) + 0.3 * Math.max(0, world.capitalMarkets.riskAppetite - 0.7) },
    { narrative: 'safety_alarm', score: 0.8 * Math.max(0, world.media.controversyIntensity - 0.45) + 0.6 * Math.max(0, 0.45 - world.society.aiTrust) },
    { narrative: 'labour_disruption', score: 0.9 * Math.max(0, world.society.automationAnxiety - 0.55) + 2 * Math.max(0, world.macro.unemployment - 0.06) },
    { narrative: 'energy_backlash', score: 0.7 * Math.max(0, world.energy.electricityPrice - 1.2) + 0.6 * Math.max(0, world.energy.gridConstraint - 0.55) },
    { narrative: 'geopolitical_race', score: 0.8 * Math.max(0, world.geopolitics.techCompetition - 0.55) + 0.5 * Math.max(0, world.geopolitics.conflictRisk - 0.4) },
    { narrative: 'concentration_backlash', score: 0.9 * Math.max(0, world.regulation.antitrust - 0.5) },
    { narrative: 'scandal_cycle', score: 1.1 * Math.max(0, world.media.controversyIntensity - 0.65) },
    { narrative: 'productivity_miracle', score: 8 * Math.max(0, world.macro.gdpGrowth - 0.035) + 0.4 * Math.max(0, world.society.aiTrust - 0.55) },
    { narrative: 'ai_optimism', score: 0.7 * Math.max(0, world.society.aiTrust - 0.55) + 0.5 * Math.max(0, world.capitalMarkets.riskAppetite - 0.55) },
    { narrative: 'neutral', score: 0.08 },
  ];

  let best = scores[0] ?? { narrative: 'neutral' as DominantNarrative, score: 0 };
  for (const candidate of scores) {
    if (candidate.score > best.score) best = candidate;
  }
  const incumbentScore = scores.find((s) => s.narrative === incumbent)?.score ?? 0;
  // Hysteresis: unseating the incumbent frame takes a clear margin.
  return best.score > incumbentScore + 0.06 ? best.narrative : incumbent;
}

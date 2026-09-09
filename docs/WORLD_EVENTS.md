# World Events

The catalogue of event families, the hazard mechanics that select them, and
worked examples of a quiet quarter, a turbulent quarter and a correlated
cascade.

Events are how the world changes on its own. The engine decides **whether** and
**roughly what**; the World Director decides **how it reads** and **which
variables move**, inside the impact budget. See
[SIMULATION.md](./SIMULATION.md) §3 for the pipeline and
[LLM_CONTRACTS.md](./LLM_CONTRACTS.md) §3.1 for the proposal contract.

## 1. How a family fires

```text
for each family:
    eligible   = all preconditions hold
              ∧ cooldownRemaining == 0
              ∧ no already-drawn family in incompatibleFamilyIds
    hazard     = baseHazard + Σ(pendingDeltas still decaying)
    fires      = rng.next() < hazard

draw severity uniformly inside severityRange, biased by hazard headroom
rank drawn families by weight × severity
truncate to ImpactBudget.maxEventsPerQuarter
truncate again once Σseverity would exceed ImpactBudget.maxTotalSeverity
→ WorldEventCandidate[]
```

Base hazards across the 24 families sum to **1.94**, so an unfiltered draw
averages roughly two families per quarter. Preconditions, cooldowns and
incompatibility typically reduce that to 1.2–1.6, and the standard impact budget
caps it at 3 events with a combined severity of 1.5. **Quiet quarters are
common by construction, and that is correct**: a stable economic quarter with no
material shock is a legitimate outcome, and the World Director is explicitly
permitted to return an empty proposal array.

Follow-on hazards are what make a turbulent quarter feel caused rather than
coincidental. When a family fires, it pushes `hazardDelta` onto the pending
stack of each family it names, decaying over `decayQuarters`. A conflict
escalation raises the odds of energy shocks, export controls and defence
procurement for the next two years **without guaranteeing any of them**.

## 2. Family catalogue

Notation per family: **allowed types** · `hazard` baseHazard · `w` weight ·
`sev` severityRange · `dur` defaultDurationQuarters · `cd` cooldownQuarters ·
default visibility. `↑`/`↓` give direction; `×0.84` is a multiply operation;
`+0.11` is an add. All targets are legal paths from `WORLD_TARGET_PATHS` or the
pattern registry. Follow-ons read `family +delta/decayQuarters`.

### Compute

**`fam_compute_supply` — Accelerator supply disruption** · `compute`
`compute_supply_shock`, `supply_chain_disruption` · hazard 0.10 · w 1.2 · sev [0.25, 0.80] · dur 3q · cd 4q · public
- **Preconditions** none
- **Targets** `world.compute.acceleratorSupply` ×0.80–0.95 ↓ · `world.compute.spotPrice` ×1.10–1.35 ↑ · `world.compute.cloudCapacity` ↓ · `sector.semiconductors.sentiment` +0.05–0.15
- **Follow-ons** `fam_fab_capacity` +0.15/4q · `fam_procurement_programme` +0.08/6q · **Incompatible** `fam_compute_demand`

**`fam_fab_capacity` — Leading-edge fabrication and packaging disruption** · `compute`
`fab_disruption` · hazard 0.06 · w 1.0 · sev [0.35, 0.90] · dur 6q · cd 8q · public
- **Preconditions** `world.compute.fabCapacity` **gt** 0.25
- **Targets** `world.compute.fabCapacity` ×0.75–0.92 ↓ · `world.compute.acceleratorSupply` ↓ · `sector.semiconductors.multiple` ↓ · `world.geopolitics.techCompetition` +0.05–0.12 ↑
- **Follow-ons** `fam_compute_supply` +0.30/4q · `fam_export_control` +0.12/8q · `fam_procurement_programme` +0.10/8q
- **Note** Slow-moving: shocks here take quarters to unwind, which is exactly what makes long compute reservations valuable insurance.

**`fam_compute_demand` — Training demand surge** · `compute`
`compute_demand_shock` · hazard 0.09 · w 1.0 · sev [0.20, 0.60] · dur 2q · cd 3q · public
- **Preconditions** `world.capitalMarkets.riskAppetite` **gt** 0.55
- **Targets** `world.compute.spotPrice` ×1.08–1.25 ↑ · `world.compute.reservedPrice` ↑ · `world.compute.energyDemand` ↑ · `sector.cloud_infrastructure.demand` ↑
- **Follow-ons** `fam_energy_price` +0.15/4q · `fam_grid_constraint` +0.12/6q · **Incompatible** `fam_compute_supply`

### Energy

**`fam_energy_price` — Industrial electricity price shock** · `energy`
`energy_price_shock` · hazard 0.08 · w 1.0 · sev [0.20, 0.75] · dur 4q · cd 4q · public
- **Preconditions** none
- **Targets** `world.energy.electricityPrice` ×1.10–1.40 ↑ · `world.compute.spotPrice` ↑ · `world.aiFrontier.inferenceCost` ↑ · `sector.energy_infrastructure.sentiment` ↑
- **Follow-ons** `fam_public_backlash` +0.10/4q · `fam_grid_constraint` +0.10/4q

**`fam_grid_constraint` — Grid interconnection and siting freeze** · `energy`
`grid_constraint`, `infrastructure_outage` · hazard 0.07 · w 1.0 · sev [0.25, 0.70] · dur 6q · cd 6q · public
- **Preconditions** `world.compute.energyDemand` **gt** 0.55
- **Targets** `world.energy.gridConstraint` +0.08–0.20 ↑ · `world.energy.datacentreAccess` ↓ · `world.compute.cloudCapacity` ↓ · `world.energy.electricityPrice` ↑
- **Follow-ons** `fam_public_backlash` +0.12/6q · `fam_procurement_programme` +0.08/8q

### Macro

**`fam_macro_cycle` — Macro regime shift** · `macro`
`macro_shift` · hazard 0.12 · w 1.4 · sev [0.15, 0.70] · dur 4q · cd 3q · public
- **Preconditions** none
- **Targets** `world.macro.gdpGrowth` ±0.005–0.02 · `world.macro.inflation` ± · `world.macro.policyRate` ±0.0025–0.015 · `world.macro.unemployment` ± · `world.macro.consumerDemand` ±
- **Follow-ons** `fam_capital_rotation` +0.20/4q · `fam_credit_event` +0.10/6q
- **Note** The only family that fires in both directions with equal weight. An expansion is as much an event as a contraction.

**`fam_credit_event` — Credit event and spread blowout** · `macro`
`credit_event` · hazard 0.05 · w 1.0 · sev [0.35, 0.85] · dur 5q · cd 8q · public
- **Preconditions** `world.macro.creditSpreads` **gt** 0.02
- **Targets** `world.macro.creditSpreads` ×1.3–2.0 ↑ · `world.capitalMarkets.debtAvailability` ↓ · `world.capitalMarkets.riskAppetite` ↓ · `world.capitalMarkets.sectorMultiples` ×0.80–0.95 ↓
- **Follow-ons** `fam_fund_collapse` +0.18/6q · `fam_ipo_window` +0.15/6q · `fam_capital_rotation` +0.15/4q
- **Note** The standard route from "aggressive leveraged rival" to "distressed acquisition target".

### Capital markets

**`fam_capital_rotation` — Risk-appetite rotation** · `capital`
`capital_market_shift` · hazard 0.13 · w 1.3 · sev [0.15, 0.65] · dur 3q · cd 2q · public
- **Preconditions** none
- **Targets** `world.capitalMarkets.riskAppetite` ± · `world.capitalMarkets.sectorMultiples` ×0.85–1.25 · `world.capitalMarkets.volatility` ± · `world.capitalMarkets.ventureLiquidity` ±
- **Follow-ons** `fam_ipo_window` +0.15/3q

**`fam_fund_collapse` — Major venture fund fails** · `capital`
`fund_collapse` · hazard 0.05 · w 1.1 · sev [0.30, 0.75] · dur 4q · cd 10q · public
- **Preconditions** `world.capitalMarkets.ventureLiquidity` **lt** 0.55
- **Targets** `world.capitalMarkets.ventureLiquidity` ×0.70–0.90 ↓ · `world.capitalMarkets.riskAppetite` ↓ · `sector.frontier_models.multiple` ↓
- **Follow-ons** `fam_capital_rotation` +0.15/4q · `fam_ipo_window` +0.12/6q · **Incompatible** `fam_ipo_window`
- **Note** Engine consequence beyond the modifiers: late-stage private companies whose runway falls below four quarters attempt `bridge` rounds, and acquisition opportunities multiply.

**`fam_ipo_window` — Listing window swings** · `capital`
`ipo_window_change` · hazard 0.08 · w 1.0 · sev [0.15, 0.60] · dur 4q · cd 4q · public
- **Preconditions** none
- **Targets** `world.capitalMarkets.ipoWindow` ± · `world.capitalMarkets.sectorMultiples` ± · `world.capitalMarkets.volatility` ±
- **Incompatible** `fam_fund_collapse`

### Regulation

**`fam_model_regulation` — Frontier model rulemaking** · `regulation`
`regulatory_action`, `standards_change` · hazard 0.10 · w 1.2 · sev [0.20, 0.75] · dur 8q · cd 6q · public
- **Preconditions** `world.society.aiTrust` **lt** 0.70
- **Targets** `world.regulation.modelRules` +0.05–0.20 ↑ · `world.regulation.safetyObligations` ↑ · `sector.frontier_models.multiple` ↓ · `world.media.attentionLevel` ↑
- **Follow-ons** `fam_public_backlash` +0.08/4q · `fam_procurement_programme` +0.06/6q
- **Note** Uses `decay: 'none'` far more often than other families: a new rule is a step change that holds for its duration rather than a shock that fades.

**`fam_antitrust` — Antitrust investigation** · `regulation`
`antitrust_investigation` · hazard 0.05 · w 1.0 · sev [0.25, 0.70] · dur 6q · cd 8q · public
- **Preconditions** `world.regulation.antitrust` **gt** 0.25
- **Targets** `world.regulation.antitrust` ↑ · `company.<id>.reputationPublic` −4..−12 · `company.<id>.valuationSentiment` −0.05..−0.20 · `world.capitalMarkets.sectorMultiples` ↓
- **Follow-ons** `fam_public_backlash` +0.12/4q
- **Note** Company-scoped. The engine picks the subject by concentration: the largest share of a strategically important segment, weighted by recent acquisition activity. This is the family that punishes a consolidation strategy.

**`fam_ip_data_ruling` — Copyright, privacy or litigation ruling** · `regulation`
`copyright_ruling`, `privacy_enforcement`, `litigation` · hazard 0.06 · w 1.0 · sev [0.20, 0.70] · dur 8q · cd 6q · public
- **Preconditions** none
- **Targets** `world.regulation.copyright` ↑ · `world.regulation.privacy` ↑ · `world.dataDomain.dataAvailability` ↓ · `world.dataDomain.licensingCost` ×1.15–1.60 ↑
- **Follow-ons** `fam_data_licensing` +0.20/6q

**`fam_export_control` — Export control tightening** · `regulation`
`export_control` · hazard 0.07 · w 1.1 · sev [0.30, 0.85] · dur 8q · cd 6q · public
- **Preconditions** `world.geopolitics.techCompetition` **gt** 0.40
- **Targets** `world.regulation.exportControls` +0.08–0.25 ↑ · `world.compute.acceleratorSupply` ↓ · `world.talent.immigrationAccess` ↓ · `sector.semiconductors.demand` ↓
- **Follow-ons** `fam_compute_supply` +0.20/6q · `fam_trade_dispute` +0.15/6q · `fam_procurement_programme` +0.10/8q
- **Note** Also flips `GovernmentContract.exportRestricted` on new defence awards, which can conflict directly with a company's commercial customers.

### Geopolitics

**`fam_geopolitical_escalation` — Strategic escalation** · `geopolitics`
`geopolitical_escalation`, `sanctions_change` · hazard 0.06 · w 1.5 · sev [0.35, 0.95] · dur 8q · cd 8q · public
- **Preconditions** none
- **Targets** `world.geopolitics.conflictRisk` ↑ · `world.geopolitics.techCompetition` ↑ · `world.geopolitics.sanctions` ↑ · `world.macro.fxVolatility` ↑
- **Follow-ons** `fam_energy_price` +0.25/6q · `fam_export_control` +0.22/8q · `fam_procurement_programme` +0.18/8q · `fam_compute_supply` +0.12/6q
- **Note** The canonical cascade root. Its own modifiers are modest; its follow-on hazards are the largest in the catalogue, which is precisely how one root cause produces several correlated events over the following two years.

**`fam_trade_dispute` — Trade dispute and tariffs** · `geopolitics`
`trade_dispute` · hazard 0.07 · w 1.0 · sev [0.20, 0.65] · dur 5q · cd 5q · public
- **Preconditions** none
- **Targets** `world.geopolitics.tradeFriction` ↑ · `world.compute.spotPrice` ↑ · `world.macro.inflation` +0.002–0.01 ↑ · `sector.semiconductors.demand` ↓

### Technology

**`fam_frontier_breakthrough` — Frontier capability breakthrough** · `technology`
`model_breakthrough`, `benchmark_result` · hazard 0.11 · w 1.2 · sev [0.20, 0.80] · dur 3q · cd 3q · public
- **Preconditions** `world.aiFrontier.benchmarkSaturation` **lt** 0.85
- **Targets** `world.aiFrontier.frontierCapability` +0.02–0.08 ↑ · `world.aiFrontier.benchmarkSaturation` ↑ · `sector.frontier_models.sentiment` ↑ · `world.capitalMarkets.riskAppetite` ↑
- **Follow-ons** `fam_capital_rotation` +0.12/3q · `fam_talent_war` +0.10/4q · **Incompatible** `fam_research_disappointment`
- **Note** Carries `TechBeliefShift[]`: the Frontier Map rearranges when this fires.

**`fam_open_weights` — Major open-weight release** · `technology`
`open_source_release` · hazard 0.10 · w 1.1 · sev [0.20, 0.70] · dur 4q · cd 4q · public
- **Preconditions** none
- **Targets** `world.aiFrontier.openSourceGap` −0.05..−0.15 ↓ · `world.aiFrontier.inferenceCost` ×0.80–0.95 ↓ · `world.society.developerSentiment` ↑ · `sector.enterprise_software.multiple` ↓
- **Follow-ons** `fam_model_regulation` +0.08/6q
- **Note** Compresses pricing power for anyone selling a capability the open weights now match. A company whose product `qualityScore` sits below the new open baseline loses customers regardless of what it charges.

**`fam_research_disappointment` — Scaling disappointment** · `technology`
`research_disappointment` · hazard 0.07 · w 1.0 · sev [0.25, 0.75] · dur 5q · cd 6q · public
- **Preconditions** `world.capitalMarkets.sectorMultiples` **gt** 1.40
- **Targets** `sector.frontier_models.sentiment` ↓ · `world.capitalMarkets.sectorMultiples` ×0.78–0.92 ↓ · `world.capitalMarkets.riskAppetite` ↓
- **Follow-ons** `fam_capital_rotation` +0.18/4q · `fam_fund_collapse` +0.10/6q · **Incompatible** `fam_frontier_breakthrough`
- **Note** Only eligible when multiples are stretched — the disappointment is a repricing of optimism, not a physics result. Carries negative `TechBeliefShift`s and can move a `forecast` node to `discredited`.

### Talent and data

**`fam_talent_war` — Talent market shock** · `talent`
`talent_shock`, `immigration_change`, `labour_action` · hazard 0.09 · w 1.0 · sev [0.20, 0.65] · dur 4q · cd 4q · public
- **Preconditions** none
- **Targets** `world.talent.researcherSupply` ↓ · `world.talent.engineerSupply` ↓ · `world.talent.salaryPressure` ×1.10–1.35 ↑ · `world.talent.immigrationAccess` ↓

**`fam_data_licensing` — Data licensing shift** · `data`
`data_licensing_shift` · hazard 0.06 · w 1.0 · sev [0.15, 0.60] · dur 6q · cd 5q · sector
- **Preconditions** none
- **Targets** `world.dataDomain.dataAvailability` ↓ · `world.dataDomain.licensingCost` ↑ · `world.dataDomain.syntheticDataMaturity` +0.02–0.08 ↑ · `sector.data_services.demand` ↑
- **Follow-ons** `fam_ip_data_ruling` +0.10/6q
- **Note** The substitution effect: scarce real data raises the value of synthetic substitutes, so this family moves `syntheticDataMaturity` **up**.

### Society, media and corporate

**`fam_public_backlash` — Public backlash cycle** · `media`
`public_backlash`, `media_cycle` · hazard 0.09 · w 1.1 · sev [0.20, 0.70] · dur 3q · cd 3q · public
- **Preconditions** `world.media.attentionLevel` **gt** 0.35
- **Targets** `world.society.aiTrust` ↓ · `world.society.automationAnxiety` ↑ · `world.media.controversyIntensity` ↑ · `world.media.attentionLevel` ↑
- **Follow-ons** `fam_model_regulation` +0.15/6q · `fam_antitrust` +0.08/6q
- **Note** Also sets `world.media.dominantNarrative` to whichever of `labour_disruption`, `safety_alarm`, `concentration_backlash` or `energy_backlash` best matches the trigger. The frame biases how every subsequent event is interpreted: the same launch reads as visionary under `ai_optimism` and reckless under `safety_alarm`.

**`fam_safety_incident` — Safety, security or conduct incident** · `corporate`
`safety_incident`, `cyber_incident`, `corporate_scandal` · hazard 0.06 · w 1.2 · sev [0.30, 0.90] · dur 4q · cd 5q · public
- **Preconditions** none
- **Targets** `world.society.aiTrust` ↓ · `world.regulation.safetyObligations` ↑ · `company.<id>.reputationPublic` −5..−20 · `company.<id>.reputationGovernment` ↓ · `world.media.controversyIntensity` ↑
- **Follow-ons** `fam_model_regulation` +0.20/8q · `fam_public_backlash` +0.20/4q
- **Note** Company-scoped, and the only family whose subject may be selected from private state: the engine weights companies by unresolved research setbacks, thin `ops` headcount relative to serving load, and `publicControversyLevel` on live contracts. The event itself is `public`; the *reason* the company was selected never is.

### Government

**`fam_procurement_programme` — Public programme announced** · `government`
`procurement_programme`, `grant_programme`, `defence_mobilisation` · hazard 0.12 · w 1.3 · sev [0.15, 0.70] · dur 6q · cd 2q · public
- **Preconditions** `world.government.procurementBudget` **gt** 0.20
- **Targets** `world.government.procurementBudget` ↑ · `world.government.defenceUrgency` ↑ · `world.government.digitalModernisation` ↑ · `world.government.grantFunding` ↑ · `sector.defence_tech.demand` ↑
- **Follow-ons** `fam_talent_war` +0.08/4q
- **Note** The highest-frequency family, deliberately: it is the supply line for [GOVERNMENT.md](./GOVERNMENT.md). Firing it also opens one to three concrete `ProcurementOpportunity` rows in `openOpportunities`.

### Types reserved for other subsystems

Four `WORLD_EVENT_TYPES` are never drawn by the hazard engine because they are
emitted directly by the subsystem that causes them: `consolidation_wave`
(markets, after several acquisitions in one sector), `litigation` (deals, on a
breach), `infrastructure_outage` (companies, on a capacity failure) and `other`
(reserved for a novel World Director proposal that fits no existing category).

## 3. Worked example — a quiet quarter

Session on `standard` difficulty, quarter 12. Nothing extreme in the world:
`riskAppetite` 0.52, `acceleratorSupply` 0.61, `creditSpreads` 0.017,
`attentionLevel` 0.31, `sectorMultiples` 1.22.

```text
ELIGIBILITY                                    7 families gated out
fam_compute_demand    riskAppetite 0.52 < 0.55    fam_credit_event  spreads < 0.02
fam_public_backlash   attention 0.31 < 0.35       fam_grid_constraint  demand < 0.55
fam_research_disapp.  multiples 1.22 < 1.40       fam_fund_collapse  liquidity > 0.55
fam_export_control    techCompetition 0.33 < 0.40 fam_antitrust  cooldown 3
(17 families eligible, summed hazard 1.19)

DRAW
fam_capital_rotation      hazard 0.13   roll 0.41   no
fam_macro_cycle           hazard 0.12   roll 0.87   no
fam_procurement_programme hazard 0.12   roll 0.06   FIRES  severity 0.24
… 14 more, none fire

CANDIDATES: 1        SEVERITY USED: 0.24 / 1.50
```

The World Director receives one candidate and returns one proposal: a mid-size
civilian modernisation programme, two modifiers, `severity: 0.26`,
`durationQuarters: 6`. The News screen headline is the `quarterSummary`; the
resolution report is dominated by the player's own operating results.

**This is the most common shape of a quarter, and it should be.** The
interesting variance in a quiet quarter comes from the player's decisions and
from rival companies, not from the weather.

## 4. Worked example — a turbulent quarter

Quarter 19, `standard`. `attentionLevel` has been climbing, multiples are
stretched at 1.61, `ventureLiquidity` has fallen to 0.48.

```text
DRAW
fam_open_weights          hazard 0.10   FIRES  severity 0.31   minor
fam_procurement_programme hazard 0.12   FIRES  severity 0.44   medium
fam_fund_collapse         hazard 0.05   FIRES  severity 0.58   medium

BUDGET
events 3 / 3          severity 1.33 / 1.50          within budget
```

Presented to the player:

```text
Minor event:   New open-weight model benchmark breakthrough
Medium event:  Continental AI procurement programme announced
Medium event:  Major venture fund collapses

Related cascade:
Late-stage startup funding availability declines
↓  Several private companies need bridge rounds
↓  Acquisition opportunities increase
```

The cascade block is not narration. It is the engine reporting three real
consequences: `ventureLiquidity` fell to 0.36 after the modifier; four
significant-tier companies with runway under four quarters queued `bridge`
rounds in `capital_resolution`; and two of them were promoted from `background`
to `significant` tier because a player is now plausibly interested in them.

The `fam_fund_collapse` firing also pushed `fam_capital_rotation` +0.15 and
`fam_ipo_window` +0.12 onto the pending stack, so the next several quarters are
measurably more likely to be volatile. Nothing is guaranteed.

## 5. Worked example — a correlated cascade

The best turbulent quarters generate multiple correlated events from **one
causal root** rather than three unrelated random shocks. Here is one root cause
tracked across seven quarters.

```text
Q14  fam_geopolitical_escalation FIRES   severity 0.71
     ├─ conflictRisk        +0.18
     ├─ techCompetition     +0.14   → 0.47, now above the export-control gate
     ├─ sanctions           +0.09
     └─ fxVolatility        +0.11
     pending deltas pushed:
       fam_energy_price              +0.25 / 6q   → hazard 0.33
       fam_export_control            +0.22 / 8q   → hazard 0.29 (now eligible)
       fam_procurement_programme     +0.18 / 8q   → hazard 0.30
       fam_compute_supply            +0.12 / 6q   → hazard 0.22

Q15  fam_export_control FIRES  severity 0.62   causalParentId = wev_q14_escalation
     exportControls +0.19 · acceleratorSupply ×0.88 · immigrationAccess −0.08
     pending: fam_compute_supply +0.20/6q (now 0.40) · fam_trade_dispute +0.15/6q

Q15  fam_procurement_programme FIRES  severity 0.55  causalParent = wev_q14
     defenceUrgency +0.16 · procurementBudget +0.12
     → GovernmentSubsystem opens "Sovereign Intelligence Platform", $2.4B ceiling

Q16  quiet — the deltas decay one step, nothing rolls under

Q17  fam_compute_supply FIRES  severity 0.66   causalParent = wev_q15_export
     acceleratorSupply ×0.82 · spotPrice ×1.29 · cloudCapacity ×0.90

Q18  fam_energy_price FIRES  severity 0.48     causalParent = wev_q14
     electricityPrice ×1.22 · inferenceCost ×1.11

Q20  all Q14 deltas fully decayed; hazards back to baseline
```

Five events over seven quarters, every one traceable to a single root, each
linked by `causalParentId`, and none guaranteed at the moment the root fired.
The News screen renders the chain as a tree; the Frontier Map shows the belief
consequences.

The economic story the player lives through:

```text
Export controls tighten → accelerators scarce and expensive
 ↓  TechBeliefShift: efficient sparse inference 0.47 → 0.73
                     huge dense models         0.74 → 0.51
 ↓  The player, who reserved capacity in Q13, has headroom rivals lack
 ↓  A defence programme opens that rewards domestic inference
 ↓  The player bids using efficient inference as the technical advantage
 ↓  A rival that borrowed to keep training is caught by the energy shock
```

Every line is a committed ledger row. None of it was written by a model.

## 6. Authoring a new family

1. Add the row to the seed data. Families are **data**, not code: preconditions
   are `{path, op, value}` triples evaluated by the engine.
2. Pick a `baseHazard` that fits the budget. The catalogue sums to ~1.94; adding
   a family at 0.10 measurably raises the tempo of every session.
3. Name follow-on hazards, not consequences. A family should raise the
   *probability* of related families, never force them.
4. Choose targets from the registry and state the direction and typical
   magnitude in the family description — the World Director reads it.
5. Set `incompatibleFamilyIds` for anything that would double-count a variable
   or contradict the same quarter's story.
6. Add a determinism test: fixed seed, fixed world, assert the family fires in
   the expected quarters and that severity lands inside `severityRange`.

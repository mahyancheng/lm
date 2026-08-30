# Simulation

The heart of Frontier Capital is a **deterministic, server-authoritative World
State Engine**. It lives in `packages/simulation`, is written against the
interfaces in `@frontier/contracts/engine`, and is the only component permitted
to change reality.

The World Director LLM does not calculate whether a company succeeded. It does
not decide that the player's shares went up 17%. It does not spontaneously give
a rival $5 billion. It proposes bounded modifiers; the engine integrates them.

## 1. The formalism

```text
S_{t+1} = F(S_t, A_player, A_agents, M_world, ε_seed)
```

- `S_t` — the canonical state entering the quarter (`SessionState`).
- `A_player` — validated structured actions (`SubmittedAction[]`) from humans.
- `A_agents` — the same, from NPC strategists (`NpcActionBundle[]`).
- `M_world` — validated temporary or permanent world modifiers
  (`ActiveModifier[]`).
- `ε_seed` — controlled pseudo-randomness derived from `SessionState.seed`.
- `F` — ordinary game code. `QuarterResolver.resolveQuarter`.

`F` is a pure function of its inputs. Given the same state, the same recorded
decisions and the same seed, it produces a byte-identical `stateHashAfter`.

## 2. World state: twelve domains

The world is **numbers only**. Narrative lives in events, media stories and
character dialogue; the world itself is a vector the engine integrates.

| Domain | Canonical variables |
|---|---|
| `macro` | gdpGrowth, inflation, policyRate, unemployment, creditSpreads, fxVolatility, consumerDemand |
| `capitalMarkets` | riskAppetite, ipoWindow, ventureLiquidity, sectorMultiples, volatility, debtAvailability |
| `compute` | acceleratorSupply, cloudCapacity, spotPrice, reservedPrice, fabCapacity, energyDemand |
| `energy` | electricityPrice, datacentreAccess, renewableCapacity, gridConstraint |
| `aiFrontier` | frontierCapability, inferenceCost, trainingEfficiency, openSourceGap, benchmarkSaturation |
| `talent` | researcherSupply, engineerSupply, salaryPressure, immigrationAccess |
| `dataDomain` | dataAvailability, licensingCost, privacyRestriction, syntheticDataMaturity |
| `society` | aiTrust, automationAnxiety, consumerSentiment, developerSentiment |
| `regulation` | modelRules, privacy, antitrust, copyright, safetyObligations, exportControls |
| `government` | procurementBudget, defenceUrgency, digitalModernisation, grantFunding |
| `geopolitics` | tradeFriction, conflictRisk, sanctions, techCompetition |
| `media` | attentionLevel, institutionalTrust, controversyIntensity, dominantNarrative |

Alongside the world sit eight **sectors** (`SECTOR_IDS`: semiconductors,
cloud_infrastructure, frontier_models, enterprise_software, consumer_ai,
data_services, defence_tech, energy_infrastructure), each carrying sentiment, a
valuation multiple, demand and volatility.

Every variable documents its unit and range in its schema `.describe()`. Those
strings are handed to the World Director verbatim, so they read as a briefing
note rather than a type annotation.

### The target registry

Nothing in the world may be mutated by a model. A modifier's `target` must
resolve against `WORLD_TARGET_PATHS` (55 fixed dotted paths) or one of the
`PATTERN_TARGET_PATHS`:

- `sector.<sectorId>.{sentiment|multiple|demand}`
- `company.<companyId>.<metric>` where metric is one of the nine
  `COMPANY_TARGET_METRICS` (five reputations, demandMultiplier, costMultiplier,
  attritionRate, valuationSentiment)

Each registry entry carries hard `min`/`max` bounds, a unit description and the
set of operations that make sense on it (`add`, `multiply`, `set`). An
unregistered path rejects the whole proposal
(`unknown_target_path`). A registered path with an out-of-range result is
**clamped**, and the clamp is recorded in the ledger.

Reference-market instruments — real securities — are not part of world state and
can never be targeted (`targets_reference_market`). Reality is not ours to
modify.

## 3. Event generation runs *before* the model

We never ask a model "what random thing happens this quarter?". The
deterministic engine establishes an event budget and chooses eligible families
according to hazards and current conditions. Only then is the model asked to
contextualise the draw.

```text
WORLD STATE
    ↓
EVENT HAZARD CALCULATION            per family: baseHazard + un-decayed deltas
    ↓
0 / 1 / 2 / several potential events
    ↓
Eligibility + cooldown + contradiction checks
    ↓
Severity budget                     ImpactBudget.maxTotalSeverity
    ↓
Candidate event skeletons           WorldEventCandidate[]
    ↓
WORLD DIRECTOR LLM
    ↓
Contextualise + propose structured modifiers   GmProposalBatch
    ↓
VALIDATOR                           target registry + impact budget
    ↓
CANONICAL WORLD MODIFIERS           ActiveModifier[]
```

### Hazard mechanics

An `EventFamily` is a template describing a class of happenings. Its fields:

| Field | Meaning |
|---|---|
| `baseHazard` | Per-quarter firing probability when eligible and off cooldown |
| `preconditions` | Data-expressed `{path, op: gt\|lt, value}` gates; all must hold |
| `followOnHazards` | `{familyId, hazardDelta, decayQuarters}` applied when this fires |
| `cooldownQuarters` | Quarters the family is ineligible after firing |
| `incompatibleFamilyIds` | Families that may not fire in the same quarter |
| `severityRange` | `[min, max]`; severity is drawn inside it by the seeded RNG |
| `defaultVisibility` | `public`, `sector` or `private` |
| `weight` | Relative selection weight among eligible families |

Per-family running state (`EventHazardState`) persists between quarters and is
where causal cascades live: `currentHazard = baseHazard + Σ pendingDeltas`, with
each delta decaying over its own `remainingQuarters`.

Conditions are **data, not code**, so a family can be authored in seed data and
evaluated deterministically without a deploy.

### Causal parents and cascades

The system supports event families, causal parents and follow-on hazards. A
conflict escalation raises later probabilities of energy shortages, defence
procurement and export restrictions **without guaranteeing any of them**. A
`WorldEvent.causalParentId` links the child to the root cause, so a turbulent
quarter reads as consequence rather than coincidence, and the News screen can
draw the chain. Full family catalogue and worked examples:
[WORLD_EVENTS.md](./WORLD_EVENTS.md).

### Impact budgets

The model is free to be imaginative about *what* happens. It is not free to
decide *how much* everything moves.

| Difficulty | maxTotalSeverity | maxSingleModifierMagnitude | maxModifiersPerEvent | maxEventsPerQuarter |
|---|---:|---:|---:|---:|
| `sandbox` | 0.9 | 0.20 | 4 | 2 |
| `standard` | 1.5 | 0.35 | 6 | 3 |
| `hard` | 2.2 | 0.45 | 7 | 4 |
| `brutal` | 3.0 | 0.60 | 8 | 5 |

`maxSingleModifierMagnitude` caps `|value|` for `add` and `|value - 1|` for
`multiply`, so 0.35 permits 0.65× through 1.35×. Novel events the engine did not
suggest are permitted (`candidateId: "novel"`) and receive the same budget.

A proposal is validated into a `ModifierValidationResult`: `accepted` (clamped,
id-assigned), `rejected` with one of eight `MODIFIER_REJECTION_REASONS`, a
`clampedCount` and the fraction of the severity budget consumed.

## 4. The quarter resolver

Eighteen phases, in a fixed order. **The order is part of the contract**, not
decoration: changing it changes causality, not just numbers.

```text
QUARTER OPEN
   ↓  snapshot canonical state                       (pre_resolution)
 1 world_events              generate candidates, apply GM events
 2 gm_modifiers              apply and decay validated modifiers
 3 information_reveal        who learns what, per event visibility
 4 action_collection         lock and validate player + NPC actions
 5 board_resolution          tally proposals, honour/break commitments
 6 capital_resolution        rounds, debt, issuance, buybacks, ownership
 7 government_resolution     score bids, award contracts, advance milestones
 8 talent_resolution         hiring, departures, morale, compensation
 9 research_resolution       project progress, node achievement, belief drift
10 product_demand_resolution capacity, pricing, demand, churn
11 financial_resolution      revenue, COGS, payroll, interest, cash flow
12 disclosure_resolution     guidance, earnings, leaks, rumours
13 market_resolution         belief update, pricing, trade settlement
14 social_resolution         post propagation, press pickup
15 relationship_update       trust/respect/hostility, memory decay, connections
16 leaderboard_update        ten boards, recomputed from state
17 ledger_commit             invariant checks, then commit
18 snapshot                  next-quarter snapshot                (post_commit)
```

Why the ordering matters, concretely:

- An acquisition approved by a board in phase 5 alters the purchaser's cash in
  phase 6, **before** the stock market prices in phase 13.
- A research setback in phase 9 that stays secret damages internal R&D and does
  **not** move the public share price, because phase 12 never disclosed it. If
  it leaks three quarters later, phase 12 publishes it and phase 13 reprices.
- Government awards in phase 7 create backlog before phase 11 recognises any
  revenue from them.
- Social propagation in phase 14 runs *after* the market prices, so a post
  affects next quarter's belief, not this quarter's close.

### Subsystem contract

Every subsystem function is:

- **Deterministic.** No `Math.random()`, no `Date.now()`, no ambient I/O. All
  randomness comes from `ResolverContext.rng`, a `SeededRng` forked per
  subsystem so that adding a draw in the market phase cannot shift which
  candidates the hiring phase picked.
- **A mutator of a draft.** Functions take `draft: SessionState` and change it in
  place. The resolver clones the incoming state once, runs the phase list, and
  returns the result. No subsystem returns a new state.
- **An emitter.** Anything economically material calls `ctx.emit()` to append a
  ledger row and `ctx.log()` to add a line to the resolution report.

`QuarterResolutionOutcome` returns `nextState`, the `ResolutionReport`, the
emitted `SimEvent[]`, the `InvariantCheckResult[]` and a `committed` flag. When
`committed` is false, an invariant failed and `nextState` is the restored
pre-resolution state.

## 5. Truth versus belief

The stock market prices what participants **believe**, not omniscient database
state. This separation is stored structurally: `companies` and
`researchProjects` hold canonical reality; `beliefs` and `disclosures` hold what
the market thinks. Nothing crosses between them except through the disclosure
phase.

```text
CANONICAL PRIVATE REALITY          ResearchProject
Model programme:
- 2 quarters late                  expectedQuarters slipped
- cost overrun +31%                cumulativeSpendUsd vs researchCostRange
- internal confidence 42%          internalConfidence = 0.42
- isSecret = true

PUBLIC INFORMATION SET             PublicDisclosure (kind: 'guidance')
Company guidance:
- "on schedule"                    metrics: { modelLaunchQuarter: t+1 }
- credibility 0.71                 near the issuer's investor reputation
- isTruthful: false                INTERNAL ONLY — never sent to a client

MARKET BELIEF                      MarketBelief (topic: 'model_delay')
Probability of delay: 26%          probability = 0.26
```

That opens the door to earnings surprises, leaks, rumours, analyst research,
short theses, whistleblowers, credibility and investor-relations gameplay.
`PublicDisclosure.isTruthful` is the mechanism that punishes a misleading denial
two quarters later, and it must never be exposed to a client.

Four ledger visibility tiers (`LEDGER_VISIBILITIES`) enforce the same boundary
at the row level: `public`, `sector`, `company`, `private`. The Supabase RLS
policies in `0016_security.sql` restate the rule at the database level, and
`PlayerView` restates it again as a redacted projection. Three independent
statements of one rule is deliberate.

## 6. The ledger

Every economic mutation creates a `SimEvent`. The ledger is **append-only**:
rows are never updated and never deleted, and the database raises on `UPDATE`
and `DELETE` even for the service role.

```json
{
  "eventId": "evt_83a2",
  "sessionId": "sess_001",
  "quarter": 17,
  "sequence": 844,
  "type": "government_contract_awarded",
  "actorId": "cmp_player",
  "targetId": "contract_sov_ai_14",
  "payload": { "value": 2400000000, "expectedMargin": 0.17 },
  "stateHashBefore": "…",
  "stateHashAfter": "…",
  "visibility": "public"
}
```

`SIM_EVENT_TYPES` enumerates 70 types across quarter lifecycle, world, actions,
governance, capital, government, people, research, product and finance, markets
and information, social, deals, and meta.

Snapshots make loads fast; the ledger makes history auditable. Together they let
the game answer:

> "Why did my stock fall?"

from committed facts rather than by asking a model to invent an explanation:

```text
Earnings miss                 -4.1%
Government contract win       +3.4%
Sector sell-off               -2.2%
CEO controversy               -1.7%
Model benchmark beat          +0.9%
Noise/liquidity               -0.5%

Approx. quarterly movement    -4.2%
```

The narrator LLM then explains **facts generated by the simulator**, and is
given nothing else to work with (`NarratorInput.committedLines`).

## 7. Determinism and replay

Requirements, all testable:

1. **No wall-clock time in simulation logic.** All timing is `QuarterIndex`, an
   integer. `EnginePhaseTiming.durationMs` exists for diagnostics and must never
   influence an outcome.
2. **No `Math.random()`.** The only entropy source is `SeededRng`, constructed
   from `SessionState.seed`.
3. **Forked streams.** Each subsystem calls `rng.fork(label)`. Adding a draw in
   one subsystem must not shift another's sequence.
4. **Deterministic ids.** Ids are built with stable inputs — session id, quarter,
   sequence, subject — never from a timestamp or a random suffix.
5. **Stable iteration order.** Collections in `SessionState` are arrays, not
   records, except where a keyed lookup is natural (`sectors`, `eventHazards`).
   Arrays iterate in a stable order, which matters for hashing.
6. **Canonical state hashing.** `StateHasher` normalises key order, rounds floats
   to `EngineOptions.moneyPrecision`, and excludes timestamps. The same state on
   two machines must hash identically.
7. **Recorded decisions.** LLM outputs are recorded as `AgentRunRecord` rows, so
   a replay uses the *recorded* proposal rather than re-calling a model. A replay
   with recorded decisions is exact; a replay without them is a fresh session.

The determinism test suite asserts: resolve quarter N twice from the same
snapshot, with the same recorded actions and the same recorded GM proposal, and
`stateHashAfter` is identical and the ledger sequence range matches.

## 8. Idempotency

A quarter cannot resolve twice.

- `SessionStatus` includes `resolving`, which acts as a lock: no action may be
  submitted while the resolver runs.
- `SessionState.lastResolvedQuarter` guards re-entry. `resolveQuarter` on an
  already-committed quarter returns the same outcome and mutates nothing.
- The database restates it: `UNIQUE (session_id, quarter_no)` on `quarters` plus
  a `planning → locked → resolving → committed` status machine, and
  `UNIQUE (session_id, quarter, sequence)` on `sim_events` so a replay either
  reproduces the identical ledger or fails loudly.
- `SessionState.ledgerSequence` advances monotonically and never rewinds.

## 9. Invariants

Thirteen quality invariants (`SIMULATION_INVARIANTS`) are checked in the
`ledger_commit` phase. **A failed check aborts the commit and restores the
pre-resolution snapshot.**

| Invariant | Requirement |
|---|---|
| `deterministic_replay` | Same state + recorded decisions + seed = same outcome |
| `financial_integrity` | `sum(assets) - sum(liabilities) == equity`, ±$1 |
| `ownership_integrity` | Per class, `sum(holdings.shares) == totalIssuedByClass` |
| `market_integrity` | No negative or NaN in-world prices |
| `llm_containment` | Invalid model output cannot mutate state |
| `idempotency` | A quarter cannot resolve twice |
| `information_boundary` | Private facts do not automatically become public |
| `authoritative_backend` | The client cannot manufacture money, shares or score |
| `social_security` | Unauthorised users cannot join restricted conversations |
| `auditability` | Material state changes trace to an event |
| `tech_graph_safety` | Generated technology cannot execute client code |
| `agent_reproducibility` | Model output and version are logged |
| `failure_mode` | An LLM outage has deterministic fallback behaviour |

Two further structural invariants are asserted continuously rather than at
commit: `ReturnDecomposition` components must sum to `total` within 1e-9, and
every `ResolutionLine` must reference at least one committed ledger event.
Nothing on the Quarter Resolution screen is narrative invention.

## 10. Failure modes

An LLM outage is a **degraded quarter, never a blocked one**. `gmProposal` may
be `null`; the engine applies the candidate skeletons using their family
template modifiers at the drawn severity. The quarter still has weather; it just
has less character. Per-role fallbacks are listed in
[LLM_CONTRACTS.md](./LLM_CONTRACTS.md) and enumerated in
`LLM_FALLBACK_STRATEGIES`.

An invariant failure is loud, not silent: the resolver emits an
`invariant_check_failed` ledger row, restores the pre-resolution snapshot,
returns `committed: false`, and the session stays on the same quarter until the
cause is fixed. We would rather stall a session than commit a world where shares
do not reconcile.

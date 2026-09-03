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

### The forecast is engine-owned

A programme's schedule, cost and risk are one function, not two. `advanceProjects`
moves a programme by `resourcingFactors × noise` and rolls a setback against
`setbackProbability`; `programmeForecast(draft, company, node, plan)` calls
**those same two functions** on the figures an intent carries and returns the
quarters, the cost, the risk, the three factors and the bottleneck. The Frontier
Map renders that result and derives nothing of its own, so a preview cannot
disagree with the programme it creates. `plannedProgrammeQuarters` is the same
shared definition for the schedule a programme opens on, called by both
`programmeForecast` and `resolver/routing.ts`.

`runningForecast` is the same reading for a programme already under way: progress,
quarters left at the pace it is actually being given, spend to date, and the one
shortfall — funding, compute or talent — that is holding it up, stated in the
unit the player set. `adjust_research_project` is the instruction that answers
it; the validator hands the programme its own allocation back before counting
what is free, and the resolver applies it before `advanceProjects` so the fix
takes effect in the quarter it was made.

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

## 9.1 Solvency, and what the validator is for

The validator exists to keep an instruction inside the shape the engine can
execute — not to protect the player from a bad decision. From **world version 2**
that distinction is enforced rather than described:

| Reason | World 1 | World 2 |
|---|---|---|
| Cash | reject or clamp | **note**, action runs whole |
| Compute supply, headcount, float, authorised shares | clamp | clamp |
| Unknown target, illegal value, lockup, board matter | reject / transform | reject / transform |

A cash note reads *"Takes cash from $X to -$Y; 2 quarters below zero and the
company is wound up."* and carries `insufficient_cash` as an **advisory** code.
The batch budget still reserves the full commitment, so two actions in one
submission cannot pretend to spend the same dollar and every preview sees the
running balance.

The consequence lives in `financial_resolution` instead. Cash closes unfloored,
an overdraft is charged as interest at the policy rate plus `OVERDRAFT_SPREAD`,
and a company that closes below zero at `SOLVENCY_NEGATIVE_QUARTERS` (2)
consecutive quarter-ends enters administration with the cause `insolvent` — the
same rule for the player's company and for every bot. A player-controlled company
is never force-bridged; a bot still gets its own rescue round, which can fail.
The count is `negativeCashQuarters(company)`, derived from the filed statements
and never stored. See [ECONOMY.md §5.1](./ECONOMY.md#51-solvency).

`financial_integrity` is unchanged and is what proves this is not a hole: the
overdraft is inside the quarter's stated interest, the wind-up states its own
equity movement, and a negative balance sheet still has to reconcile.

### Market entry

A wind-up leaves a gap, and in world version 2 something fills it. Immediately
after the distress step, `resolveMarketEntry` founds **one new company per
company wound up this quarter**, bounded by `ENTRANTS_PER_QUARTER` (2) and
refused entirely once active non-husk companies reach `ACTIVE_COMPANY_CAP` (40).
Without it a forty-quarter session thins out until a sector has nobody in it and
gates everything downstream of it to `SUPPLY_GATE_FLOOR`.

The entrant takes the dead company's **sector** — that is the gap — and draws
everything else from `ctx.rng` and from state: a region weighted by
`regionMeta().capitalDepth` times `regionSectorAffinity()`, an archetype from the
sector's pool, a name from a bank of sixty-six that never repeats inside a
session, a founder built by the same factory the scenario's founders are, and a
seed cheque sized from the sector, the region's capital depth and
`world.capitalMarkets.ventureLiquidity`. A venture entity with the dry powder
leads the round and holds the stake; otherwise the founder holds it all.

It is assembled by the scenario's own factories (`buildV2Company`,
`buildV2CapTable`, `buildV2Anchor`, `buildV2Metrics`), so its shares reconcile,
its balance sheet closes and every per-company table carries its row before any
gate reads it. It is **private at birth** — no instrument, no quote — and the
founding writes one public `information_revealed` row (`kind:
"company_founded"`), a `funding_round_closed` row declaring the fund's
`dryPowderDeltaUsd`, and a `press_release` disclosure so the founding reaches the
news feed as a story. Everything comes off one stream forked from the financial
phase's own, so replay is byte-identical.

### Elimination

When the company a player directs enters administration the seat is closed:
`SessionPlayer.eliminatedQuarter` is set to that quarter, and from then on the
validator rejects every instruction from that seat with `requirement_not_met`
("… is in administration; the seat is closed"). The market does not care who
died — an entrant spawns for the player's slot exactly as it does for a bot's,
and the husk stays purchasable. The web shell renders a full-screen verdict
instead of the game, and the save is marked ended rather than deleted.

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

## 11. Refuse vs realise

The owner, verbatim: *"it's not logical if I can't perform what I can do
freely in the real world. A price cut is a price cut."* From world version 2
(`isMultiSectorWorld`) the validator in `packages/simulation/src/validator/rules.ts`
refuses an instruction only when it is **malformed** (an unknown target, a
non-positive amount where zero is meaningless, a duplicate, a self-reference)
or **impossible** (a sunset product, a closed seat, a board that does not
exist, a security that is not tradable). Everything else — a hiring
requisition the talent market may not fully fill, a reservation bigger than
the fabs can free, a share buy bigger than the float, a price move bigger
than a founder has ever tried — is **realised at resolution**: the action
runs, gets what the world gives it, and the quarter report states what was
asked, what was got and why. World 1 keeps every clamp and refusal it has
always had, byte for byte — `packages/simulation/test/world2Scenario.test.ts`
pins its hash and every rule below that branches on `solvencyWorld(ctx)` (an
alias for `isMultiSectorWorld`) leaves the world-1 branch untouched.

Two mechanisms carry this from world 2 on:

- **`expectedFill(session, companyId, intent)`** (`packages/simulation/src/fills.ts`)
  is the one place an expectation is computed — pure, reads only the session,
  draws no RNG. The validator calls it through `noteExpectedFill` to attach the
  advisory code `partial_fill_expected` to an accepted verdict; screens call it
  directly so a slider's preview and the validator's note cannot disagree.
  Research's own version, `noteResearchFill`, exists because two research
  actions in the same batch can both draw against the same free compute —
  something a pure, session-only function cannot see, so the validator passes
  it the batch-aware free counts directly instead.
- **`emitPartialFill(draft, ctx, companyId, row)`** (`packages/simulation/src/companies/partialFill.ts`)
  is what the *owning phase* calls when the fill actually falls short at
  resolution. It writes an `information_revealed` row with `kind:
  'partial_fill'` and `{asked, got, shortfall, reason}`, and a plain-words
  `ctx.log` line. It is a `kind`, not a new `SIM_EVENT_TYPES` member, so
  `resolver/invariants.ts` treats it as a staging row that books nothing — the
  money or capacity that *did* land is booked by whatever filled it.

Cash is the one bound that was already realised (a prior stage): every
cash-gated rule below either notes `insufficient_cash` and runs whole
(`commitCashWithNote`) or, where a smaller amount is still an amount worth
having (a purchase, a campaign), clamps to what is affordable — clamping to
an affordable *amount* is not refusing the *decision*, so it stays as it was.

### The table

One row per rule in `RULES`, in the order `ACTION_TYPES` declares them. Every
`reject`/`clamp`/`note` call site the rule contains is named by its code.
**Verdict** is KEEP (still refuses/clamps, because the condition is structural)
or REALISE (world 2: accepted, advisory only — availability is resolved
downstream). A code can appear on both KEEP and REALISE rows across different
rules; what makes a site KEEP is that the condition it guards is true no
matter how the world's supply moves, not the code's name.

| Action | Code sites | Verdict | Why |
| --- | --- | --- | --- |
| `set_research_budget` | `insufficient_cash` (via `affordable`) | KEEP (cash: notes, world 2) | Cash-only; already realised. |
| `start_research_project` | `unknown_target` (no such node) | KEEP | Structural: the node does not exist. |
| | `requirement_not_met` (already demonstrated) | KEEP | Structural: nothing left to research. |
| | `duplicate_action` (programme already running) | KEEP | Structural: the same target twice. |
| | `insufficient_headcount` (free researchers) | REALISE | `noteResearchFill` in world 2; `ensureResearchProjects` resources what is free and reports the rest. World 1 keeps reject/clamp. |
| | `insufficient_compute` (free compute) | REALISE | Same mechanism, same phase. |
| | `insufficient_cash` (budget) | KEEP (cash: notes, world 2) | Cash-only; already realised. |
| `adjust_research_project` | `unknown_target` (no such project) | KEEP | Structural. |
| | `not_controller_of_company` | KEEP | Structural: not this company's programme. |
| | `requirement_not_met` (not active/paused) | KEEP | Structural: nothing to re-resource. |
| | `insufficient_headcount` / `insufficient_compute` | REALISE | `noteResearchFill`; `applyResearchAdjustments` hands back what the programme already holds, re-resources with what is free, reports the rest. |
| | `insufficient_cash` (the increase) | KEEP (cash: notes, world 2) | Cash-only. |
| `propose_innovation` | `requirement_not_met` (feature off) | KEEP | Structural: the session disabled the feature. |
| | `unknown_target` (dependency ids, clamp) | KEEP | A dependency that does not exist cannot be dropped into existing — the clamp drops it, which is repair of a malformed field, not an availability bound. |
| | `duplicate_action` (title clash) | KEEP | Structural: the node already exists. |
| `publish_research` | `unknown_target` (no such node) | KEEP | Structural. |
| | `requirement_not_met` (no result to publish) | KEEP | Structural: nothing exists to publish. |
| `set_product_price` | `unknown_target` (no such product) | KEEP | Structural. |
| | `requirement_not_met` (sunset) | KEEP | Structural: the product cannot be repriced at all. |
| | `illegal_value` (negative price) | KEEP | Malformed: a price cannot be negative (new in this pass). |
| | `illegal_value` (`PRICE_MOVE_BAND`, ±clamp) | **REALISE (world 2 only, §3)** | The band is removed entirely from world 2 — no clamp, no reject, up or down. §3 below. World 1 keeps the exact clamp. |
| `launch_product` | `duplicate_action` (name clash, active) | KEEP | Structural: a company cannot sell two products by the same name at once. |
| | `requirement_not_met` (world 2: category's `requiresNodeIds` not achieved/publicly accessible) | KEEP | Structural, per this table: a company cannot sell a product that needs a technology it does not have and the world has not published. Money and scale never work around it. |
| | `unknown_target` (world 2: `categoryId` null or unrecognised, clamp to `defaultCategoryFor`) | REALISE | Not a refusal at all — the engine chooses the sector/segment default and names the choice back, exactly as a null `providerCompanyId` resolves to the cheapest seller. |
| | `insufficient_cash` (launch marketing) | KEEP (cash: clamps to affordable when not solvency-realised; notes in world 2) | Spend, not the decision to launch — the launch itself is never gated. |
| `sunset_product` | `unknown_target` | KEEP | Structural. |
| | `duplicate_action` (already sunset) | KEEP | Structural. |
| `set_marketing_budget` | `duplicate_action` (repeated segment, clamp-merge) | KEEP | Repair of a malformed field (the same segment twice), not an availability bound. |
| | `insufficient_cash` (scale to affordable) | KEEP (cash: notes, world 2 — never scaled down there) | Cash-only; already realised for world 2 via the `solvencyWorld` branch. |
| `marketing_campaign` | `insufficient_cash` (per-quarter share) | KEEP (cash: notes, world 2) | Cash-only. |
| `hire` | *(no headcount gate at all)* | REALISE (always has been) | The talent market fills what it fills; `hiring.ts` reports `filled`/`unfilled` on `hire_completed`. This pass additionally lifts the resolution-side open-role **backlog cap** for player-controlled companies in world 2 (§ below), and reports it (`emitPartialFill`) for NPC companies it still caps. |
| | `insufficient_cash` (cover, clamp/notes) | KEEP (cash: notes, world 2) | Cash-only. |
| `layoff` | `insufficient_headcount` (nobody in role / count > held) | **REALISE (world 2)** | `layoff` now accepts whole in world 2; `hiring.ts` cuts `min(count, available)` (already did) and now emits `partial_fill` when short. World 1 keeps reject/clamp exactly. |
| | `insufficient_cash` (severance) | KEEP (cash: notes, world 2, on the *expected* cut) | Cash-only. |
| `poach_executive` | `unknown_target` (no such person) | KEEP | Structural. |
| | `illegal_value` (self-poach) | KEEP | Structural: nonsensical instruction. |
| | `requirement_not_met` (left the industry) | KEEP | Structural: nobody to approach. |
| | `target_not_reachable` (private approach, no path) | **REALISE (world 2)** | Accepted with a note; `hiring.ts` computes `canReach` at resolution and, if still unreachable, the approach fails outright (no probability roll) with its own report line — the cash reserved for the attempt is still spent. World 1 keeps the reject. |
| | `insufficient_cash` (offer, clamp premium/notes) | KEEP (cash: notes, world 2) | Cash-only. |
| `appoint_executive` | `unknown_target` / `requirement_not_met` | KEEP | Structural. |
| | `insufficient_cash` | KEEP (cash) | Cash-only. |
| `reserve_compute` | `illegal_value` (units ≤ 0) | KEEP | Malformed: nothing to reserve. |
| | `unknown_target` (named provider substitution) | KEEP | A substitution to a real counterparty, not an availability bound on quantity. |
| | `insufficient_compute` (market/provider cap) | **REALISE (world 2)** | Accepted whole with a note; `resolveComputeOrders` caps to the market/provider spare capacity at resolution and emits `partial_fill`. World 1 keeps the clamp, unre-checked at resolution (a batch-wide snapshot, as it always was). |
| | `insufficient_cash` (first quarter, on the *expected* fill) | KEEP (cash: notes, world 2) | Cash-only. |
| `buy_cloud_capacity` | `unknown_target` (provider substitution) | KEEP | Counterparty substitution, not quantity. |
| | `insufficient_compute` (spend ceiling) | KEEP *(not revisited this pass)* | Still clamped in both worlds; a defensible follow-on for a later pass, not part of the owner's named minimum set. |
| | `insufficient_cash` | KEEP (cash) | Cash-only. |
| `allocate_compute` | `insufficient_compute` (holds none) | KEEP | Structural: nothing to allocate. |
| `raise_round` | `illegal_value` (non-positive target) | KEEP | Malformed. |
| | `illegal_value` (`MAX_ROUND_DILUTION_PCT`, clamp) | KEEP | Legal ceiling, stated as such — no single round may sell more of the company than this by charter, not by scarcity. |
| `issue_debt` | `illegal_value` (non-positive principal) | KEEP | Malformed. |
| | `requirement_not_met` (credit markets shut, `debtAvailability`) | **REALISE (world 2)** | Accepted with a note; `resolveDebtIssues` already prices the attempt against `debtAvailability` and reports "no lender" on a failed placement — this pre-existing resolution logic is what the validator's reject was redundantly pre-empting. World 1 keeps the reject. |
| `buyback` | `requirement_not_met` (no security) | KEEP | Structural. |
| | `insufficient_cash` | KEEP (cash) | Cash-only. |
| `issue_shares` | `unknown_target` (no such share class) | KEEP | Structural. |
| | `exceeds_authorised_shares` (no headroom / clamp to headroom) | **REALISE (world 2)** | Accepted whole with a note; `resolveShareIssues` issues what the class's unissued authorisation allows and reports the rest as `partial_fill`. A genuine "board authorises more shares" mechanic — raising `authorisedShares` itself — is a follow-on this pass does not build (see Known gaps below); World 1 keeps reject/clamp. Separately and unconditionally, a company **with a board** already routes every `issue_shares` through the pre-existing board-matter transform (`BOARD_MATTER_BY_ACTION.issue_shares`), which this pass leaves alone. |
| `ipo` | `duplicate_action` (already listed) | KEEP | Structural. |
| | `illegal_value` (`MIN`/`MAX_IPO_FLOAT_PCT`, clamp) | KEEP | Legal listing-rule ceiling, stated as such. |
| `set_dividend_policy` | `illegal_value` (`DIVIDEND_MAX_PAYOUT_PCT`, clamp) | KEEP | Legal payout ceiling, stated as such. |
| | `requirement_not_met` (note only, no profit) | KEEP (already a note) | Informational; never blocked. |
| `set_logistics_toll` | `requirement_not_met` (dominance floor, clamp to ceiling) | KEEP | A dial with a legal/market ceiling — `maxTollForCompany` — stated as such; not scarcity. |
| `buy_shares` | `unknown_target` (no such security) | KEEP | Structural. |
| | `illegal_value` (own shares via buyback, not tradable, no shares/pct given, non-positive limit) | KEEP | Malformed instructions. |
| | `requirement_not_met` (float, clamp/reject) | **REALISE (world 2)** | Accepted whole with a note; `runSettlement` (`markets/settlement.ts`) already reads the order fresh off `pendingActions` and fills what the float, absorbable volume and limit price allow, independently of the validator — the validator's pre-clamp was shrinking the ask *before* that logic ever saw it. World 1 keeps reject/clamp. |
| | `insufficient_cash` (clamp/notes) | KEEP (cash: notes, world 2 — `runSettlement` does not bound by cash there either) | Cash-only. |
| `sell_shares` | `unknown_target` (no such security) | KEEP | Structural. |
| | `lockup_active` | KEEP | Legal restriction, not scarcity. |
| | `requirement_not_met` (holds none / more than held) | **REALISE (world 2)** | Accepted whole with a note; `runSettlement` reports "nothing to sell" / "sale reduced" itself. World 1 keeps reject/clamp. |
| `acquire_company` | `unknown_target` / `illegal_value` (self) / `requirement_not_met` (inactive) | KEEP | Structural. |
| | `illegal_value` (non-positive offer) | KEEP | Malformed. |
| | `illegal_value` (consideration normalised, clamp) | KEEP | Repair of a malformed field (percentages not summing to one). |
| | `insufficient_cash` | KEEP (cash: notes, world 2) / reject in world 1 | Cash-only. |
| `submit_board_proposal` | `requirement_not_met` (no board) | KEEP | Structural. |
| | `unknown_target` (target company) | KEEP | Structural. |
| | `illegal_value` (CEO dismissing self) | KEEP | Structural. |
| | `duplicate_action` (same matter this quarter) | KEEP | Structural. |
| `lobby_director` | `requirement_not_met` (no board) | KEEP | Structural. |
| | `unknown_target` (director / proposal) | KEEP | Structural. |
| | `requirement_not_met` (already decided) | KEEP | Structural. |
| | `target_not_reachable` | **REALISE (world 2)** | Accepted with a note; `commitmentsFromLobbying` computes `canReach` at resolution and, if unreachable, registers no stance — only a "never got through" memory. World 1 keeps the reject. |
| `bid_government` | `illegal_value` (opportunity id mismatch) | KEEP | Structural. |
| | `unknown_target` | KEEP | Structural. |
| | `opportunity_closed` | KEEP | Structural: the window is shut. |
| | `requirement_not_met` (invited-only, past performance) | KEEP | Eligibility gate, not scarcity — a real bid cannot be entered without qualifying. |
| | `duplicate_action` (already bid) ×2 | KEEP | Structural. |
| | `insufficient_headcount` / `insufficient_compute` (staff/compute commitment, clamp) | KEEP *(not revisited this pass)* | A defensible follow-on; not in the owner's named minimum set. |
| | `unknown_target` (consortium members, clamp) | KEEP | Repair of a malformed field. |
| | `requirement_not_met` (consortium not permitted, clamp) | KEEP | Structural: the programme's own rule. |
| `decline_opportunity` | `unknown_target` / `opportunity_closed` | KEEP | Structural. |
| `form_consortium` | `unknown_target` / `opportunity_closed` / `requirement_not_met` (single-prime only) | KEEP | Structural. |
| | `unknown_target` (unknown invitees, clamp) | KEEP | Repair of a malformed field. |
| | `illegal_value` (lead not a party) | KEEP | Structural. |
| `meet_regulator` | `unknown_target` | KEEP | Structural. |
| | `illegal_value` (not a regulator/official) | KEEP | Structural. |
| | `target_not_reachable` | **REALISE (world 2)** | Accepted with a note; `reactToRegulatorMeeting` computes reach at resolution and, if unreachable, writes a "never took the call" memory instead of the ordinary posture-based one. World 1 keeps the reject. |
| `social_post` | `unknown_target` (author) | KEEP | Structural. |
| | `not_controller_of_company` | KEEP | Structural. |
| | `requirement_not_met` (no account) | KEEP | Structural. |
| | `unknown_target` (target company, clamp to general) | KEEP | Repair of a malformed field. |
| `give_guidance` | `requirement_not_met` (private company) | KEEP | Structural. |
| | `illegal_value` (past quarter) | KEEP | Structural. |
| | `duplicate_action` | KEEP | Structural. |
| `respond_crisis` | `unknown_target` | KEEP | Structural. |
| `propose_deal` | `unknown_target` (counterparty, obligations' targets ×4) | KEEP | Structural. |
| | `illegal_value` (self, expired, sector mismatch, non-member proposer/counterparty) | KEEP | Structural/malformed. |
| | `insufficient_compute` (note only) | KEEP (already a note) | Informational; the breach consequence is what actually bites. |
| | `requirement_not_met` (note only, antitrust exposure) | KEEP (already a note) | Informational. |
| `accept_deal` / `reject_deal` | `unknown_target` / `illegal_value` (not addressed to you) / `requirement_not_met` (not proposed/lapsed) | KEEP | Structural. |
| `request_introduction` | `unknown_target` ×2 | KEEP | Structural. |
| | `illegal_value` (self, needs three people) | KEEP | Structural. |
| | `target_not_reachable` ×2 | KEEP *(not revisited this pass)* | Unlike the poach/lobby/meet cases, an introduction *is* the mechanism by which reach is extended — refusing an impossible chain here is closer to structural than availability, and the owner's minimum list names poach/lobby/meet specifically, not this. Left as a candidate for a later pass rather than assumed. |
| | `requirement_not_met` (purpose too short) | KEEP | Malformed: no purpose stated. |
| `buy_accelerators` | `requirement_not_met` (world 1: not available) | KEEP | Structural: the action does not exist outside world 2. |
| | `illegal_value` (units ≤ 0) | KEEP | Malformed. |
| | `unknown_target` (no seller at all) | KEEP | Structural: nothing exists to buy from. |
| | `unknown_target` (named seller substitution) | KEEP | Counterparty substitution, not quantity. |
| | `insufficient_compute` (seller's sellable units) | **REALISE** | Accepted whole with a note; `resolveComputeOrders` already capped to `seller.sellableUnits` and now also emits `partial_fill` when the fill is partial (previously only a total miss was reported). This action exists in world 2 only, so there is no world-1 branch to preserve. |
| | (cash, always noted — never gated) | KEEP (cash) | Cash-only; this action never rejected for cash even before this pass. |
| `invest_capacity` | `requirement_not_met` (world 1: not available) | KEEP | Structural: no capacity kind but compute exists outside world 2, exactly `buy_accelerators`'s reason. |
| | `illegal_value` (amount ≤ 0) | KEEP | Malformed. |
| | (cash, always noted — never gated) | KEEP (cash) | Cash-only, same as `buy_accelerators`: a capex commitment is a capex commitment. |
| `set_supply_terms` | `requirement_not_met` (world 1: not available) | KEEP | Structural: no product categories exist outside world 2. |
| | `requirement_not_met` (category `canSupply` is false) | KEEP | Structural: this line was never eligible to be anyone's input. |
| | `illegal_value` (negative price) | KEEP | Malformed. |
| | `unknown_target` (`exclusiveCustomerIds`/`blockedCustomerIds` name a company that does not exist) | KEEP | Structural: cannot admit or block a company that isn't there. |
| | (a price far from reference, closing to everyone, blocking a live buyer) | REALISE | A real decision, not gated — the consequence is a customer's margin or a one-quarter cut-off notice, per §2.6, not a refusal. |
| `choose_supplier` | `requirement_not_met` (world 1: not available) | KEEP | Structural, same reason. |
| | `unknown_target` (no such product, unrecognised `inputCategoryId` for this category) | KEEP | Structural: the launch category does not declare this input. |
| | `illegal_value` (a product naming itself as its own supplier) | KEEP | Structural: the one cycle a single action can create. |
| | `unknown_target` (named supplier company/product does not exist or is inactive) | KEEP | Structural. |
| | `unknown_target` (`supplyTerms` unpublished) | KEEP | Structural: nothing to build on yet. |
| | `requirement_not_met` (blocked, or not open and not exclusive) | KEEP | Structural: this buyer is not admitted. |
| | (`null` supplier, including a deliberate refusal on a `required` input) | REALISE | Always legal — the open market, or an unsupplied line that books zero units and says so, per §2.6. Never rejected here. |
| | (switching cost, capacity rationing at the named supplier) | REALISE | One quarter of dampened quality on the switched line, and a proportional fill when the supplier's spare capacity cannot cover every buyer — both realised at resolution, per §2.6, never gated here. |

### What "no headcount gate" already meant for `hire`

`hire` has never had a headcount ceiling in `rules.ts` — the talent market
was always the fill mechanism, not a validator bound. What this pass fixes
is downstream: `hiring.ts`'s standing **open-role backlog cap**
(`OPEN_ROLE_BACKLOG_CAP_SHARE`/`OPEN_ROLE_BACKLOG_FLOOR`) silently withdrew
requisitions past a share of current headcount, for every company, with no
event and no report line. From world 2 a player-controlled company's backlog
is never capped — carrying an aggressive pipeline is the founder's decision,
and its cost already shows up in payroll (`OPEN_ROLE_LOADED_FACTOR`) and in
`CashAfter`, not in a silent withdrawal. An NPC company's backlog is still
capped (a background company should not carry an infinite unworked
pipeline), but the withdrawal is now reported: `emitPartialFill` with
`actionType: 'hire'`. World 1 keeps the unconditional, unreported cap.

### Pricing without a band (§3)

`set_product_price`'s `PRICE_MOVE_BAND` clamp (±0.25x/4x per quarter) is
removed in world 2 — a founder may reprice to anything, including zero or a
6x rise, in one quarter. The consequence moves into the demand model
(`packages/simulation/src/companies/products.ts`), which already saturates
its ordinary elasticity term (`priceFactor`) at `PRICE_DEVIATION_BOUNDS`
(60% either side of the segment reference) — that saturation existed before
this pass and is untouched.

What is new: `priceMoveShock` (unbounded log-ratio of the move, replacing the
old `priceShock` that clamped to 0..1 because a bigger move was previously
unreachable) drives the churn shock in `productChurn` without a ceiling — a
6x rise costs more churn than a 4x one did, and there is no size of move that
escapes it. `priceSaturationDecay` decays gross additions (as the *square* of
how far past its onset the price sits) so a rise that leaves the model's
elasticity range does not go on raising revenue for nothing. Its onset is
**not** `PRICE_DEVIATION_BOUNDS.max` — the same point `priceFactor` already
saturates at — because that point is common, ordinary premium pricing in this
economy (a quality-differentiated product routinely sits there without ever
having been repriced), and decaying every quarter a product holds an ordinary
premium, with no repricing at all, quietly stalled growth economy-wide (it
took `test/capitalEntities.test.ts`'s 40-quarter, whole-economy run to
surface this — no single-action or single-quarter test would have). The onset
is `PRICE_SATURATION_DECAY_ONSET_MULTIPLE = 6` times `PRICE_DEVIATION_BOUNDS.max`
— i.e. a price beyond roughly 4.6x the segment reference, matching the
owner's own "a 6x price" example as the shape of move this mechanism exists
to answer, not a defensible premium a product has always carried.

A price cut is realised the same way, through the existing (unbounded below,
by design) elasticity term: cheap sells more, bounded only by serving
capacity; a deep cut or a $0 price runs at whatever margin the cost model
produces, negative included, and the solvency clock is the consequence, not a
clamp.

### Known gaps — named, not silently dropped

- **`issue_shares` past a class's authorisation** realises by issuing what the
  class allows and reporting the shortfall (`partial_fill`), for a company of
  either kind. A company **with a board** already separately requires board
  approval for *any* `issue_shares` (the pre-existing, unconditional
  `BOARD_MATTER_BY_ACTION` mapping) — but that mechanism approves the
  *financing*, not a raise of the class's own `authorisedShares` ceiling. A
  genuine "the board votes to authorise more shares, and the ceiling itself
  moves" mechanic is not built in this pass; the shortfall is honestly
  reported instead of silently capped or invented.
- **`buy_cloud_capacity`**'s spend ceiling and **`bid_government`**'s
  staff/compute commitment clamps are left as KEEP. Both are structurally the
  same shape as the REALISE set (a scarcity bound, clamped at validation) and
  are reasonable candidates for a later pass; they are outside the owner's
  named minimum and were not touched here to keep this pass's surface area
  reviewable.
- **`request_introduction`**'s `target_not_reachable` is left as KEEP for the
  reason given in the table: an introduction is the mechanism that *extends*
  reach, which makes "attempt it anyway and fail" a different, more involved
  design question than poach/lobby/meet's "the approach fails at resolution."

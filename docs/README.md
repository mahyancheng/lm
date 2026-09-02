# Frontier Capital — Design Documentation

The working design documents for Frontier Capital: an LLM-powered AI corporate
grand-strategy simulation. These are documents engineers implement from, not
marketing copy. Where a formula, a table or an enum appears here, it is the one
in the code.

The rule everything else follows from:

> **LLMs are allowed to think, propose, negotiate, communicate and reinterpret
> the future; only the simulation engine is allowed to make reality.**

## The documents

| Document | One line |
|---|---|
| [GAME_DESIGN.md](./GAME_DESIGN.md) | Product thesis, the progression ladder, the three scales, plural success, the CEO/owner split, first playable and the eighteen screens. |
| [SIMULATION.md](./SIMULATION.md) | `S_{t+1} = F(…)`, the twelve world domains, the hazard pipeline, the eighteen resolution phases, truth versus belief, the ledger, determinism, idempotency and the thirteen invariants. |
| [ECONOMY.md](./ECONOMY.md) | Products, people, compute, financial statements, valuation anchors, the quarterly return model, funding rounds, dilution, debt, acquisitions and balance-sheet invariants. |
| [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) | The seven roles and their authority boundaries, per-role input/output schemas, tiered agent economics, run logging, deterministic fallbacks and Anthropic API conventions. |
| [WORLD_EVENTS.md](./WORLD_EVENTS.md) | The 24-family event catalogue with hazards, preconditions, severities, targets and follow-ons — plus worked quiet, turbulent and cascading quarters. |
| [GOVERNMENT.md](./GOVERNMENT.md) | Procurement end to end: agencies, contract forms, evaluation weights, the bid trade-off space, consortiums, past performance, and why connections help discovery and never award. |
| [MARKETS.md](./MARKETS.md) | The in-world exchange, the optional read-only reference tape, belief-based pricing, disclosures and rumour credibility, ownership thresholds and proxy contests. |
| [MULTIPLAYER.md](./MULTIPLAYER.md) | Shared session worlds, the asynchronous quarter cadence, connection level versus relationship, the access rule, structured deals, moderation, Realtime channels and leaderboards. |
| [UI_SYSTEM.md](./UI_SYSTEM.md) | The aesthetic, all eighteen screens, the quarter-resolution moment, Frontier Map rendering rules and the Chief-of-Staff interaction contract. |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Hosting (the always-on Pi via `deploy/pi`; the generic VPS kit), Supabase setup, migrations and seeds, environment variables, demo mode versus the full stack, LLM cost controls and the operational runbook. |

## Reading paths

**New to the project** — [GAME_DESIGN.md](./GAME_DESIGN.md), then
[SIMULATION.md](./SIMULATION.md). Those two carry the whole shape.

**Working on the engine** — [SIMULATION.md](./SIMULATION.md) →
[ECONOMY.md](./ECONOMY.md) → the subsystem document for your area
([MARKETS.md](./MARKETS.md), [GOVERNMENT.md](./GOVERNMENT.md),
[WORLD_EVENTS.md](./WORLD_EVENTS.md)).

**Working on the LLM gateway** — [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) first,
then `packages/contracts/src/llm.ts`, then
[WORLD_EVENTS.md](./WORLD_EVENTS.md) for what the World Director is actually
being handed.

**Working on the app** — [UI_SYSTEM.md](./UI_SYSTEM.md) →
[MULTIPLAYER.md](./MULTIPLAYER.md) → [DEPLOYMENT.md](./DEPLOYMENT.md).

**Operating a deployment** — [DEPLOYMENT.md](./DEPLOYMENT.md), especially the
invariants checklist and the runbook at the end.

## The stack

| Layer | Technology |
|---|---|
| Frontend + API routes | Next.js App Router, self-hosted as one always-on Node process (`deploy/pi`) |
| Canonical state, auth, realtime | **Supabase** — Postgres, RLS, Broadcast |
| Every LLM role | **Claude**, via `packages/llm` |
| Engine | Pure TypeScript, deterministic (`packages/simulation`) |
| Contracts | zod schemas and engine interfaces (`packages/contracts`) |

GitHub is the source of truth; the owner's always-on Pi runs `apps/web` from a
pinned image built by `deploy/pi`; Supabase is canonical state in full-stack
mode; the Claude gateway powers every LLM role with structured outputs. There
is no dependency on any other model provider anywhere in the project.

## Concepts worth knowing before you read anything else

**Quarter.** The unit of time. An integer `QuarterIndex`, never a wall-clock
date. Nothing in the engine reads a clock.

**Session.** One shared world: one seed, one canonical timeline, one roster of
1–8 human founders plus hundreds of simulated companies.

**Proposal.** Anything an LLM produces. It is parsed by a zod schema, then
bounds-checked by the engine, and only then does it become state. If it did not
emit a `SimEvent`, it did not happen.

**Modifier.** The only mechanism by which the World Director changes reality: a
bounded, decaying, time-limited arithmetic operation on a registered target
path, inside an impact budget.

**Truth versus belief.** Canonical reality and market belief are stored in
separate places. Nothing crosses between them except through the disclosure
phase. That separation is what makes earnings surprises, leaks, short theses and
credibility gameplay possible.

**Frontier Map.** Not a tech tree. A probabilistic, contested, mutable picture
of what *this* world's inhabitants believe the technological future might look
like — including nodes players invented.

**Connection level versus relationship.** How powerful someone is, versus how
they feel about you. The first gates who may open a conversation; the second
shapes how it goes.

**Ledger.** Append-only, hash-chained, never updated and never deleted. It is
why the game can answer "why did my stock fall?" from committed facts instead of
asking a model to invent a reason.

## The thirteen invariants

Enforced at quarter commit. A build that fails one does not ship.

| Invariant | Requirement |
|---|---|
| Deterministic replay | Same state + recorded decisions + seed = same outcome |
| Financial integrity | Balance sheet reconciles |
| Ownership integrity | Issued shares and holdings reconcile |
| Market integrity | No negative or NaN virtual securities prices |
| LLM containment | Invalid model output cannot mutate state |
| Idempotency | A quarter cannot accidentally resolve twice |
| Information boundary | Private facts do not automatically become public |
| Authoritative backend | The client cannot manufacture money, shares or score |
| Social security | Unauthorised users cannot join restricted conversations |
| Auditability | Material state changes trace to an event |
| Tech graph safety | Generated technology cannot execute arbitrary client code |
| Agent reproducibility | Model output and version are logged |
| Failure mode | An LLM outage has deterministic fallback behaviour |

## Where the numbers live

Balancing constants are code, not prose. These documents quote them; the code
owns them. When you change one, update the quotation in the same pull request.

| Constant | Defined in | Documented in |
|---|---|---|
| `WORLD_TARGET_PATHS`, `PATTERN_TARGET_PATHS` | `contracts/src/world.ts` | [SIMULATION.md](./SIMULATION.md) §2 |
| `IMPACT_BUDGET_BY_DIFFICULTY` | `contracts/src/modifiers.ts` | [SIMULATION.md](./SIMULATION.md) §3 |
| `RESOLUTION_PHASES` (18) | `contracts/src/sim.ts` | [SIMULATION.md](./SIMULATION.md) §4 |
| `SIMULATION_INVARIANTS` (13) | `contracts/src/sim.ts` | [SIMULATION.md](./SIMULATION.md) §9 |
| `FOUNDER_INDEX_WEIGHTS` | `contracts/src/sim.ts` | [MULTIPLAYER.md](./MULTIPLAYER.md) §9 |
| `OWNERSHIP_THRESHOLDS` | `contracts/src/ownership.ts` | [ECONOMY.md](./ECONOMY.md) §8 |
| `DEFAULT_EVALUATION_WEIGHTS` | `contracts/src/government.ts` | [GOVERNMENT.md](./GOVERNMENT.md) §3 |
| `DEFAULT_QUORUM_RULE` | `contracts/src/governance.ts` | [GAME_DESIGN.md](./GAME_DESIGN.md) §5 |
| `CONNECTION_GAP_RULE` | `contracts/src/people.ts` | [MULTIPLAYER.md](./MULTIPLAYER.md) §4 |
| `CONFIRMATION_REQUIRED_ACTIONS` (13) | `contracts/src/actions.ts` | [UI_SYSTEM.md](./UI_SYSTEM.md) §5 |
| `LLM_FALLBACK_STRATEGIES` | `contracts/src/llm.ts` | [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) §7 |
| Event family hazards and follow-ons | `supabase/seed.sql` | [WORLD_EVENTS.md](./WORLD_EVENTS.md) §2 |

Event families are seed **data**, not code, so a designer can add one without a
deploy — which is exactly why the catalogue in `WORLD_EVENTS.md` has to stay in
step with the seed.

## Keeping these documents true

These are working documents. When the code and a document disagree, that is a
bug in one of them, and the fix is not to quietly let them drift.

- A change to `packages/contracts` that adds, removes or reshapes a schema
  updates the document that describes that subsystem in the same pull request.
- New enum members — an event family, an action type, a leaderboard, a sim event
  type — appear in the relevant catalogue here.
- Balancing constants (impact budgets, Founder Index weights, evaluation
  weights, hazard rates) live in code as data. This directory quotes them; it
  does not own them. When you change one, update the quotation.
- Worked examples are load-bearing. If a formula changes, rework the example
  rather than deleting it — the examples are how a new engineer checks their
  understanding.

`CLAUDE.md` at the repository root holds the architectural rules themselves and
takes precedence over anything written here.

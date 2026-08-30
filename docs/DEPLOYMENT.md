# Deployment

How Frontier Capital is built, hosted, configured and operated.

## 1. Platform shape

**GitHub is the source of truth. Vercel deploys `apps/web`. Supabase holds
canonical state. Claude powers every LLM role from server-side code.**

```text
                    GITHUB REPOSITORY — SOURCE OF TRUTH
            ┌───────────────┴───────────────┐
      CLAUDE CODE                     GITHUB ACTIONS
      implementation                  typecheck · test · build
            └───────────────┬───────────────┘
                       MERGED COMMIT
                            ▼
                          VERCEL
                  Next.js App Router · apps/web
                  ├── React Server Components
                  └── API routes (Node.js runtime)
                            │  HTTPS / Realtime WebSocket
                            ▼
                         SUPABASE
      ┌─────────────────────┼──────────────────────┐
   Postgres               Auth                  Realtime
      ├── World state · Game sessions             ├── Chat
      ├── Companies · Characters · Markets        ├── Presence
      └── Event ledger · Leaderboards             └── Live updates
                            │
              SERVER-SIDE (Vercel functions)
                ┌───────────┴───────────┐
         Simulation resolver        LLM gateway
         @frontier/simulation       @frontier/llm
                                    Market-data adapter (optional)
```

The resolver and the LLM gateway run **only** on the server, in API routes that
hold the service role key. The browser holds the anon key and reads through Row
Level Security. There is no path from a client to canonical state.

## 2. Repository layout

```text
/frontier-capital
├── apps/web/                 Next.js App Router + API routes → Vercel
├── packages/
│   ├── contracts/            zod schemas + types + engine interfaces
│   ├── simulation/           deterministic world engine
│   │   ├── economy/ companies/ markets/ research/
│   │   └── government/ boards/ relationships/ resolver/
│   ├── llm/                  Claude gateway, transports, fallbacks
│   └── shared/               seeded RNG, ids, formatting, math
├── supabase/
│   ├── migrations/           0001…0016, applied in filename order
│   ├── seed.sql              a complete deterministic demo world
│   └── config.toml
├── docs/                     this directory
├── CLAUDE.md                 architecture rules, non-negotiable
└── .env.example
```

Packages export TypeScript source directly (`main: src/index.ts`) and are
transpiled by the app. **Do not add build steps to packages.**

## 3. Vercel

**Project settings**

| Setting | Value |
|---|---|
| Root directory | `apps/web` |
| Framework preset | Next.js |
| Install command | `pnpm install` (run at the workspace root) |
| Build command | `pnpm build` |
| Node version | 20 or later |

**`next.config.ts`** must transpile every workspace package, because they ship
source rather than build output:

```ts
const nextConfig: NextConfig = {
  transpilePackages: [
    '@frontier/contracts',
    '@frontier/shared',
    '@frontier/simulation',
    '@frontier/llm',
  ],
};
```

**Runtime.** Every route that resolves a quarter or calls a model runs on the
**Node.js runtime**, not the Edge runtime. The default `claude-session`
transport spawns a Claude Code session per call, which the Edge runtime cannot
do; the resolver is CPU-bound and benefits from a longer function duration.

**Function limits.** Quarter resolution for a large session is measured in
seconds, and LLM calls add latency on top. Set a generous `maxDuration` on the
resolve route. If a plan's function ceiling cannot accommodate a full
resolution, split it: run the LLM phase (World Director, NPC strategists) as
one invocation that persists its `AgentRunRecord`s, then run the deterministic
resolution as a second invocation that reads them. Because the resolver takes
the recorded proposals as input, splitting changes nothing about the outcome.
Self-hosting the resolver as a worker is the third option.

**Preview deployments** get their own Supabase project or their own schema.
Never point a preview at production data: a preview that resolves a quarter
would mutate it.

## 4. Supabase

**Provisioning**

1. Create a project. Note the URL, the anon key and the service role key.
2. Apply the schema: `supabase db push`, or apply
   `supabase/migrations/*.sql` in **ascending filename order**. Migrations are
   numbered, not timestamped, and several carry deferred foreign keys added by
   later files — skipping or reordering will fail.
3. Load `supabase/seed.sql` for a demo world, or run the scenario seeder for a
   fresh session.

**The sixteen migrations**

| # | Domain | Tables |
|---:|---|---|
| 0001 | identity | `profiles`, `player_settings`, the auth trigger |
| 0002 | sessions | `game_sessions`, `session_players`, `quarters` |
| 0003 | world | `jurisdictions`, `world_snapshots`, `world_events`, `world_modifiers` |
| 0004 | companies | `companies`, `company_quarter_metrics`, `products`, `company_resources`, `employees_agg`, `executives` |
| 0005 | ownership | `share_classes`, `securities`, `holdings`, `transactions`, `funding_rounds` |
| 0006 | governance | `boards`, `board_seats`, `board_proposals`, `board_votes`, `shareholder_proposals`, `commitments` |
| 0007 | markets | `market_instruments`, `market_quotes`, `market_trades`, `market_beliefs`, `public_disclosures` |
| 0008 | government | `agencies`, `procurement_opportunities`, `government_bids`, `government_contracts`, `contract_milestones`, `contractor_reputation` |
| 0009 | technology | `tech_graph_versions`, `tech_nodes`, `tech_edges`, `research_projects`, `inventions` |
| 0010 | people | `characters`, `character_traits`, `relationships`, `memories`, `connection_scores` |
| 0011 | social | `social_accounts`, `social_posts`, `engagement_events`, `media_stories` |
| 0012 | conversation | `conversations`, `conversation_participants`, `messages`, `deal_proposals`, `reports`, `blocks` |
| 0013 | agents | `agent_profiles`, `agent_runs` |
| 0014 | simulation | `player_actions`, `agent_actions`, `sim_events` (append-only) |
| 0015 | competition | `leaderboard_snapshots`, `achievements` |
| 0016 | security | RLS helpers, every policy, grants, Realtime authorization |

RLS is enabled in the migration that creates each table, so no table is ever
briefly readable. All **policies** live in `0016_security.sql`, so the
information-boundary rules can be read in one place.

**Local development**

```bash
supabase start          # Postgres :54322 · API :54321 · Studio :54323
supabase db reset       # replays every migration in order, then seed.sql
supabase db diff -f my_change
supabase stop
```

`seed.sql` is re-runnable: it begins by purging the demo session id, so a reset
and a bare `psql -f seed.sql` produce the same world.

**Writing a migration**

1. Add `migrations/00NN_<domain>.sql`.
2. `alter table … enable row level security;` immediately after every
   `create table`, and `comment on table …` for each.
3. Add its policies to `0016_security.sql`.
4. `supabase db reset` and confirm the seed still applies.

Conventions: `snake_case`, `uuid` primary keys via `gen_random_uuid()`, a
`created_at timestamptz not null default now()` on every table, `numeric` for
money, and a **named** constraint for every check so failures are legible.

## 5. Environment variables

Mirrors `.env.example` at the repository root. Copy it to
`apps/web/.env.local` for local work, and set the same names in Vercel project
settings for deployments.

```bash
# --- Demo mode -------------------------------------------------------------
# When true (the default when Supabase vars are absent), the app runs a fully
# local, deterministic single-player session in memory: no Supabase and no
# Claude credentials required. Set to false for the full multiplayer stack.
NEXT_PUBLIC_DEMO_MODE=true

# --- Supabase (canonical game state, auth, realtime) -----------------------
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
# Server-only. Used by the quarter resolver and LLM gateway API routes.
SUPABASE_SERVICE_ROLE_KEY=

# --- LLM (all roles: World Director, Chief of Staff, NPCs, characters) -----
# Default transport runs Claude Code sessions via the Claude Agent SDK using
# your Claude subscription OAuth token (not metered API billing).
# Generate with:  claude setup-token
LLM_TRANSPORT=claude-session        # claude-session | api | none
CLAUDE_CODE_OAUTH_TOKEN=
# All in-game roles use Sonnet.
LLM_MODEL=sonnet

# Optional fallback transport (LLM_TRANSPORT=api): metered Anthropic API key.
ANTHROPIC_API_KEY=
```

Rules:

- `SUPABASE_SERVICE_ROLE_KEY` **bypasses RLS**. It must never be prefixed
  `NEXT_PUBLIC_`, never imported into a client component, and never logged.
- `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are server-only for the same
  reason.
- Only `NEXT_PUBLIC_DEMO_MODE`, `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are ever exposed to the browser.
- The default LLM path requires **no API key at all**. Do not write code that
  demands `ANTHROPIC_API_KEY` on the `claude-session` path.

Optional additions when a deployment enables them:

```bash
MARKET_DATA_PROVIDER=            # adapter id; unset disables the reference tape
MARKET_DATA_API_KEY=             # provider credential, server-only
LLM_QUARTER_BUDGET=40            # hard ceiling on model calls per resolution
LLM_ROLES_DISABLED=              # comma-separated AgentRole list to force fallback
```

## 6. Demo mode versus the full stack

| | Demo mode | Full stack |
|---|---|---|
| Canonical state | In-memory store | Supabase Postgres |
| Engine | `@frontier/simulation` | `@frontier/simulation` — identical |
| Invariants | All thirteen enforced | All thirteen enforced |
| Players | One, local | 1–8, authenticated |
| NPC rivals | Deterministic archetypes | LLM strategists by tier |
| LLM | `LLM_TRANSPORT=none` fallbacks | `claude-session` |
| Credentials | None | Supabase + OAuth token |
| Realtime | None | Broadcast channels |
| Persistence | Session lifetime | Durable |

Demo mode is a **first-class configuration**, not a stub. It runs the real
engine, the real seeded world, the real screens and the real invariants. It
exists because the game must be playable and reviewable with zero setup, and
because the deterministic-fallback path is exercised continuously rather than
only during an outage.

```bash
pnpm install
pnpm dev
# http://localhost:3000
```

Switching to the full stack: create the Supabase project, apply migrations,
generate an OAuth token with `claude setup-token`, fill `.env.local`, set
`NEXT_PUBLIC_DEMO_MODE=false`.

## 7. Cost controls for LLM calls

A resolved quarter in a standard single-player session makes roughly **16–25**
model calls (see [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) §5). Five mechanisms
keep that from growing without bound.

**1. Tiering.** The dominant lever. Only 4–10 `major` companies get full LLM
planning each quarter. `significant` companies rotate — roughly one call per
company per four quarters. Hundreds of `background` companies cost nothing at
all and are promoted only when a player makes them relevant. This is what makes
a large economy affordable.

**2. Prompt caching.** Each role's system prompt — its authority description,
its schema guidance, the target-path registry for the World Director — is stable
across a whole session and carries a cache breakpoint. Volatile content (the
quarter digest, the candidate list, the conversation turn) goes **after** the
breakpoint. Verify with `usage.cache_read_input_tokens`; a persistent zero means
a silent invalidator, usually a timestamp or an unsorted object in the prefix.

**3. Per-quarter budgets.** `LLM_QUARTER_BUDGET` is a hard ceiling on calls per
resolution. When it is reached, remaining roles take their deterministic
fallback and each writes an `LlmFallbackRecord` with reason `disabled`. The
quarter still resolves. Budgets are enforced in the gateway, not by hoping
prompts stay small.

**4. Role-level disabling.** `LLM_ROLES_DISABLED` forces named roles to their
fallback permanently. A cost-sensitive deployment might disable `narrator` and
`social_author` — both are colour — while keeping `world_director` and
`npc_strategist`, which carry mechanical weight.

**5. Demand-driven roles.** `chief_of_staff`, `character_dialogue` and
`innovation_interpreter` fire only on player action. They cost nothing in a
quarter where the player uses the normal controls.

**Monitoring.** `agent_runs` records `tokens.input`, `tokens.output`,
`latencyMs`, `fallbackUsed` and `modelId` for every call. Cost per session and
cost per quarter are queries against that table, broken down by role. If a role
starts costing more than its design budget, the input builder is the first place
to look — briefings grow silently as a session matures.

Note that on the default `claude-session` transport, calls run against the
operator's Claude subscription rather than metered API billing, so the binding
constraint is rate and concurrency rather than dollars. Budgets still apply:
they are what keep a resolution bounded in wall-clock time.

## 8. Release workflow

```text
Issue / specification
 ↓
Feature branch
 ↓
Implementation
 ↓
Unit + integration + determinism tests
 ↓
Pull request
 ↓
Automated checks    pnpm typecheck · pnpm test · pnpm build
 ↓
Review
 ↓
Merge to main
 ↓
Vercel deploys the exact commit
 ↓
Visual acceptance on the preview URL
 ↓
Promote to production
```

The commit is the release artifact. A deployment is always traceable to one.

**Required checks:** `pnpm typecheck` (strict, `noUncheckedIndexedAccess` on),
`pnpm test` (including the determinism suite), `pnpm build`. Schema changes
additionally require that `supabase db reset` applies cleanly with the seed.

**Database changes ship before the code that needs them.** Migrations are
additive; a deploy must be able to roll back to the previous commit against the
new schema.

## 9. Operational invariants checklist

The thirteen non-negotiable quality invariants. Each has a test; a build that
fails one does not ship.

| Invariant | Requirement | Enforced where |
|---|---|---|
| Deterministic replay | Same state + recorded decisions + seed = same simulation outcome | Determinism test suite; `StateHasher` |
| Financial integrity | Balance sheet reconciles | `balanceSheetReconciles` at `ledger_commit` |
| Ownership integrity | Issued shares and holdings reconcile | `CapTableCheck` at `ledger_commit`; DB `CHECK`s |
| Market integrity | No negative or NaN virtual securities prices | Price floor in `priceMarket`; `CHECK (price > 0)` |
| LLM containment | Invalid model output cannot mutate state | zod parse → bounds check → ledger, in `@frontier/llm` |
| Idempotency | A quarter cannot accidentally resolve twice | `lastResolvedQuarter`; `UNIQUE (session_id, quarter_no)` |
| Information boundary | Private facts do not automatically become public | `LedgerVisibility`; `PlayerView`; RLS policies |
| Authoritative backend | Client cannot manufacture money, shares or leaderboard score | Server-side validation; no client write path |
| Social security | Unauthorised users cannot join restricted conversations | `checkAccess`; `is_conversation_participant`; Realtime policies |
| Auditability | Material state changes trace to an event | `ctx.emit()`; `refEventIds` on every resolution line |
| Tech graph safety | Generated technology cannot execute arbitrary client code | Typed `TechGraph` → trusted React/SVG only |
| Agent reproducibility | Model output and version are logged | `AgentRunRecord` in `agent_runs` |
| Failure mode | LLM outage has deterministic fallback behaviour | `LLM_FALLBACK_STRATEGIES`; `LLM_TRANSPORT=none` |

Two further checks run continuously rather than at commit: the seven components
of every `ReturnDecomposition` sum to its total within 1e-9, and every
`ResolutionLine` references at least one committed ledger event.

## 10. Operational runbook

**A quarter fails to commit.** An invariant failed. The resolver emitted
`invariant_check_failed`, restored the pre-resolution snapshot and returned
`committed: false`. The session stays on the same quarter. Read the
`InvariantCheckResult.detail` — it names exactly what did not reconcile and for
which subject. Fix the cause; never disable the check. Stalling a session is
strictly better than committing a world where shares do not reconcile.

**The model provider is unavailable.** Nothing to do. Every role falls back
deterministically and each engagement is recorded. Confirm by querying
`agent_runs` for `fallbackUsed = true` grouped by reason. If the outage is
prolonged, set `LLM_TRANSPORT=none` so the gateway stops attempting calls and
paying the timeout.

**A session appears stuck in `resolving`.** That status is the idempotency lock.
Check whether a resolution actually completed by comparing
`lastResolvedQuarter` against `quarters.status`. Clearing the lock is a
service-role operation and must only follow confirmation that no resolution is
in flight.

**Model output looks wrong.** `agent_runs` has the exact `structuredOutput`,
`contextHash`, `inputStateVersion`, `agentVersion` and `validationResult`. A run
with the same context hash and model is reproducible. Check `engineResult`
first: a proposal that was clamped or rejected did not cause the symptom.

**Costs are rising.** Query `agent_runs` by role for token totals per quarter.
The usual causes are a briefing builder that grew, a `significant`-tier rotation
that widened, or cache invalidation in a system prefix.

**Restoring a session.** Snapshots plus the ledger are sufficient. Load the
`post_commit` snapshot for quarter N, replay ledger rows from
`sequenceFrom`, and compare the resulting state hash. A mismatch means either
the engine changed or the ledger was tampered with — and `sim_events` raises on
`UPDATE` and `DELETE`, for the service role too, precisely so the second cause
is nearly impossible.

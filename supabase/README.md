# `supabase/` — canonical game state

Supabase Postgres is the canonical database for Frontier Capital. Everything the
simulation knows lives here: sessions, world state, companies, cap tables,
boards, markets, government contracts, the Frontier Map, people, conversations,
the append-only event ledger and the leaderboards.

The client is never authoritative. Next.js API routes running on Vercel hold the
service role key, run the deterministic resolver and write state; browsers hold
the anon key and read through Row Level Security. Every LLM role calls the
Anthropic Claude API from those same server routes.

```
apps/web (Vercel)                    packages/simulation
  browser  ──anon key──►  RLS  ──►   resolver  ──service role──►  Postgres
                                        ▲
  Realtime Broadcast ◄──────────────────┘
```

## Contents

| Path | What it is |
|---|---|
| `config.toml` | Supabase CLI configuration for the local stack. |
| `migrations/0001…0016_*.sql` | Ordered schema migrations. Apply in filename order. |
| `seed.sql` | A complete, deterministic demo world (2027 Q1, seed 424242). |

## Apply order

Migrations are numbered, not timestamped, and must run in ascending order.
Several tables carry deferred foreign keys that a later migration adds with
`ALTER TABLE` — for example `session_players.character_id` is only wired up once
`0010_people.sql` creates `characters`. Skipping or reordering a file will fail.

| # | File | Domain |
|---:|---|---|
| 0001 | `identity` | `profiles`, `player_settings`, the `auth.users` → profile trigger, shared trigger helpers |
| 0002 | `sessions` | `game_sessions`, `session_players`, `quarters` |
| 0003 | `world` | `visibility_scope`, `jurisdictions`, `world_snapshots`, `world_events`, `world_modifiers` |
| 0004 | `companies` | `companies`, `company_quarter_metrics`, `products`, `company_resources`, `employees_agg`, `executives` |
| 0005 | `ownership` | `share_classes`, `securities`, `holdings`, `transactions`, `funding_rounds` |
| 0006 | `governance` | `boards`, `board_seats`, `board_proposals`, `board_votes`, `shareholder_proposals`, `commitments` |
| 0007 | `markets` | `market_instruments`, `market_quotes`, `market_trades`, `market_beliefs`, `public_disclosures` |
| 0008 | `government` | `agencies`, `procurement_opportunities`, `government_bids`, `government_contracts`, `contract_milestones`, `contractor_reputation` |
| 0009 | `technology` | `tech_graph_versions`, `tech_nodes`, `tech_edges`, `research_projects`, `inventions` |
| 0010 | `people` | `characters`, `character_traits`, `relationships`, `memories`, `connection_scores` |
| 0011 | `social` | `social_accounts`, `social_posts`, `engagement_events`, `media_stories` |
| 0012 | `conversation` | `conversations`, `conversation_participants`, `messages`, `deal_proposals`, `reports`, `blocks` |
| 0013 | `agents` | `agent_profiles`, `agent_runs` |
| 0014 | `simulation` | `player_actions`, `agent_actions`, `sim_events` (append-only) |
| 0015 | `competition` | `leaderboard_snapshots`, `achievements` |
| 0016 | `security` | RLS helpers, all policies, grants, Realtime authorization |

RLS is enabled on each table in the migration that creates it, so no table is
ever briefly readable. All *policies* live in `0016_security.sql`, so the
information-boundary rules can be read in one place.

64 tables, 68 policies, 5 tables deliberately with no policy at all.

## Local development

```bash
supabase start          # Postgres :54322 · API :54321 · Studio :54323
supabase db reset       # drops, replays every migration in order, runs seed.sql
supabase db diff -f my_change   # author a new migration from Studio edits
supabase stop
```

`seed.sql` is re-runnable: it begins with `select public.purge_session(...)` for
the demo session id, so `supabase db reset` and a bare `psql -f seed.sql` both
produce the same world.

Environment variables the app needs (see `.env.example` at the repo root):

```
NEXT_PUBLIC_SUPABASE_URL          from `supabase status`
NEXT_PUBLIC_SUPABASE_ANON_KEY     browser; RLS applies
SUPABASE_SERVICE_ROLE_KEY         server only; bypasses RLS — never ship to a client
```

Writing a new migration:

1. Add `migrations/00NN_<domain>.sql`.
2. `alter table ... enable row level security;` immediately after every
   `create table`, and `comment on table ...` for each one.
3. Add its policies to `0016_security.sql` (or a new `00NN_security.sql` if the
   feature is self-contained).
4. `supabase db reset` and confirm the seed still applies.

Conventions: `snake_case`, `uuid` primary keys with `gen_random_uuid()`, a
`created_at timestamptz not null default now()` on every table, `numeric` for
money, and a named `constraint` for every check so failures are legible.

## How RLS maps to the game's information boundaries

The information boundary is a *mechanic*, not just a security control. Markets
price beliefs, not the database, and a secret research programme that is two
quarters late must not move a share price until it leaks. The policies are the
database-level statement of that rule.

### Four visibility tiers

**Public information set** — readable by any session member. This is what the
market, the news and rival agents are allowed to reason about.

`companies` · `executives` · `market_instruments` · `market_quotes` ·
`market_beliefs` · `public_disclosures` · `world_events` where
`visibility = 'public'` · `agencies` · `procurement_opportunities` ·
`government_contracts` · `contractor_reputation` · `characters` ·
`connection_scores` · `social_accounts` · `social_posts` and `media_stories`
where `visibility = 'public'` · `tech_nodes`/`tech_edges` where
`visibility = 'public'` · `leaderboard_snapshots` · `achievements` ·
launched `products` · `sim_events` where visibility is `public` or `session`.

**Private company reality** — the controlling player only, via
`public.owns_company(company_id)`.

`company_quarter_metrics` · `company_resources` · `employees_agg` ·
unlaunched `products` · undisclosed `holdings` · unannounced `funding_rounds` ·
`contract_milestones` · own `government_bids` · unpublished `inventions` ·
`research_projects` where `is_secret`.

**Participant-only** — `conversations`, `conversation_participants`, `messages`
and `deal_proposals`, gated by `public.is_conversation_participant()`.
Boardroom material (`board_proposals`, `board_votes`, `commitments`) is gated by
`public.can_see_board()`: you run the company, or you hold a seat.

**Canonical truth** — service role only. These five tables have RLS enabled and
**no policy**, and `SELECT` is revoked from `authenticated` outright:

`world_snapshots` · `world_modifiers` · `agent_profiles` · `agent_runs` ·
`agent_actions`

That is where omniscient world state, raw model output, rejected LLM proposals
and NPC intentions live. A client cannot read them under any circumstances.

### Helper functions

All are `security definer` with `search_path = ''`, so a policy can consult
membership tables without recursing through their own RLS.

| Function | Answers |
|---|---|
| `is_session_member(session_id)` | Do I hold a seat in this world? |
| `current_player_id(session_id)` | My `session_players.id` here. |
| `owns_company(company_id)` | Do I *control* this company? (control, not ownership) |
| `company_is_public(company_id)` | Is it listed, and therefore subject to disclosure? |
| `can_see_board(board_id)` | Do I run the company or hold a seat? |
| `is_own_character(character_id)` | Is this my in-world person? |
| `is_conversation_participant(id)` | Am I in this thread? |
| `shares_session_with(profile_id)` | Are we in the same world? (gates profile lookups) |
| `is_quarter_planning(session_id, q)` | Is this quarter still open for instructions? |

### The client write surface

Deliberately tiny. Clients may only:

| Table | Operation | Guard |
|---|---|---|
| `player_actions` | `INSERT` | own `player_id`, quarter still `planning`, status `draft`/`submitted` |
| `messages` | `INSERT` | `sender_profile_id = auth.uid()`, `is_npc = false`, must be a participant |
| `reports` | `INSERT` | own `reporter_profile_id`, status `open` |
| `blocks` | `INSERT`/`DELETE` | own `blocker_profile_id` |
| `profiles` | `INSERT`/`UPDATE` | self; column-level grant excludes `is_admin` |
| `player_settings` | `INSERT`/`UPDATE` | self |

Everything else — cash, shares, prices, contracts, board outcomes, leaderboard
scores — has **no client write path whatsoever**. `leaderboard_snapshots` has no
`INSERT`, `UPDATE` or `DELETE` policy at all: the browser can never submit a
score. The `anon` role has no privileges on any table; every policy targets
`authenticated`.

Beyond RLS, integrity is enforced structurally so it also binds the service role:

- `sim_events` raises on `UPDATE` and `DELETE` via trigger — history is not
  editable. Use `public.purge_session(uuid)` (service role only) for the rare
  hard delete; normally sessions are archived.
- `UNIQUE (session_id, quarter_no)` on `quarters` plus its status machine makes
  quarter resolution idempotent.
- `UNIQUE (session_id, quarter, sequence)` on `sim_events` makes a replay either
  reproduce the identical ledger or fail loudly.
- `CHECK (price > 0)` on `market_quotes` — no negative or NaN virtual price.
- `CHECK (shares >= 0)` on `holdings`, `issued_shares <= authorized_shares` on
  `share_classes`, and exactly-one-holder on every holding row.
- `messages` and `conversation_participants` carry a composite foreign key to
  `conversations (id, session_id)`, so a message can never claim a session other
  than its conversation's.
- `messages` has no anonymous case: a row is either a real player's profile with
  `is_npc = false`, or a character with `is_npc = true` that the UI labels as an
  AI. There is no third state.

## Realtime channel naming

Realtime **Broadcast** carries chat, presence and live session updates; Postgres
stays the source of truth. `0016_security.sql` installs policies on
`realtime.messages` that decode the topic with `realtime.topic()` and delegate
to the same helpers the table policies use.

| Channel | Read | Write |
|---|---|---|
| `session:{session_id}:events` | session members | **nobody** — server broadcast only |
| `session:{session_id}:presence` | session members | server only |
| `session:{session_id}:conversation:{conversation_id}` | participants | participants |

The event feed being read-only for clients is the point: a browser cannot
fabricate a world event, a market tick or a quarter commit. Chat channels accept
participant writes for latency, and the durable copy still goes through the
`messages` table.

```ts
const channel = supabase.channel(
  `session:${sessionId}:conversation:${conversationId}`,
  { config: { private: true } },
);
```

`private: true` is required — it is what makes Realtime consult the policies. A
malformed or unauthorised topic simply fails to join; `public.try_uuid()` makes
the helpers return `false` rather than raising on a garbage topic string.

## The demo world (`seed.sql`)

One session, `00000000-0000-4000-8000-000000000001`, seed `424242`, opening at
2027 Q1 with quarter 1 in `planning`.

- **Six companies**, all listed, deliberately varied: Nexus Intelligence (NXS,
  frontier lab), Orbit Dynamics (ORB, applied AI), Helix Systems (HLX,
  infrastructure), VectorWorks AI (VWA, vertical AI and visibly in trouble),
  Aurora Compute (ARC, semiconductors), Meridian Data (MRD, data platform).
- **Fifteen characters** with traits and directional relationships: six chief
  executives including Maya Chen of Nexus (risk tolerance 89, technical
  orientation 96, financial conservatism 27, aggressiveness 83, status
  sensitivity 66), three investors, three independent directors, a regulator and
  two journalists.
- **A five-member Nexus board**: founder, lead VC, growth investor, independent
  researcher, independent enterprise executive.
- **Three agencies** and **two open procurements** with published evaluation
  weightings that sum to 1.
- **A seventeen-node Frontier Map** spanning every epistemic state — transformer
  scaling, retrieval grounding and tool learning (established); synthetic data
  curricula, sparse expert reasoning, recursive tool learning, efficient sparse
  inference and interpretability at scale (emerging); long-horizon planning,
  specialised accelerator design, autonomous research and automated engineering
  (forecast); self-directed science and continual online learning (speculative);
  neuromorphic substrates (discredited); persistent agent economies (Meridian's
  company thesis); and one *secret* Nexus node, `dense_scaling_saturation`,
  visible only to Nexus.
- **Eight market instruments** — the six equities plus the FCAI and FCSC indices
  — with opening quotes and a full return decomposition on each.
- **Cap tables that reconcile**: every share class's `issued_shares` equals the
  sum of its holdings, including Maya Chen's Class B founder stock (12% of the
  economics, 10 votes per share) and Nexus's undisclosed sub-threshold stake in
  Meridian Data.
- Research programmes including the secret, over-budget, two-quarters-late
  *Project Lattice*; an opening news cycle; and one `company_value` leaderboard.

Every id is fixed, so fixtures and tests can reference entities directly.

The seed does **not** write a `world_snapshots` row. Canonical world state is
produced by the resolver when the session opens, against the schema in
`@frontier/contracts`; seeding a hand-written state blob would fight that.
`quarters.state_snapshot_id` is therefore null until the first resolve.

Verifying the seed's invariants by hand:

```sql
-- ownership integrity: every class must reconcile to its holdings
select sc.company_id, sc.code, sc.issued_shares, coalesce(sum(h.shares), 0) as held
from share_classes sc
join securities s on s.share_class_id = sc.id
left join holdings h on h.security_id = s.id
group by sc.id having sc.issued_shares <> coalesce(sum(h.shares), 0);

-- procurement weightings must sum to 1
select code, sum(w.value::numeric)
from procurement_opportunities o, lateral jsonb_each(o.evaluation_weights) w
group by code;
```

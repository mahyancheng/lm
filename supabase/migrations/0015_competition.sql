-- ===========================================================================
-- 0015_competition.sql — Frontier Capital
--
-- Session-native, server-computed rankings.
--
-- There is no client write path to this domain at all. Leaderboards are
-- recomputed by the resolver from the event ledger; the browser can never
-- submit "score = 900000".
--
-- The composite Founder Index uses percentile-normalised inputs so wealth does
-- not eventually overwhelm every other dimension:
--   FI = .22W + .18E + .15I + .12R + .10N + .10G + .08F + .05S
-- with the weights themselves a balancing variable in game_sessions.config
-- rather than hard-coded frontend logic.
-- ===========================================================================

create type public.leaderboard_board as enum (
  'company_value',
  'founder_wealth',
  'revenue',
  'profit',
  'innovation',
  'market_influence',
  'network',
  'government',
  'reputation',
  'founder_index'
);

create type public.achievement_tier as enum ('bronze', 'silver', 'gold', 'legendary');

-- ---------------------------------------------------------------------------
-- leaderboard_snapshots
-- ---------------------------------------------------------------------------

create table public.leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  board public.leaderboard_board not null,
  entries jsonb not null default '[]'::jsonb,
  methodology_version text not null default '1',
  weights jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint leaderboard_snapshots_quarter_positive check (quarter >= 1),
  constraint leaderboard_snapshots_entries_is_array check (jsonb_typeof(entries) = 'array'),
  constraint leaderboard_snapshots_unique unique (session_id, quarter, board)
);

comment on table public.leaderboard_snapshots is
  'One immutable ranking per board per quarter, recomputed on the authoritative backend from the sim_events ledger. No client INSERT, UPDATE or DELETE policy exists on this table by design.';
comment on column public.leaderboard_snapshots.entries is
  'Ordered array of {rank, previous_rank, player_id, company_id, character_id, label, value, percentile, delta}. Ranks are stored so the resolution report can show "#3 -> #1".';
comment on column public.leaderboard_snapshots.weights is
  'The weighting actually used for this snapshot, so a historic Founder Index stays explainable after balancing changes.';

create index leaderboard_snapshots_session_quarter_idx
  on public.leaderboard_snapshots (session_id, quarter desc);

alter table public.leaderboard_snapshots enable row level security;

-- ---------------------------------------------------------------------------
-- achievements
-- ---------------------------------------------------------------------------

create table public.achievements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  player_id uuid references public.session_players (id) on delete cascade,
  character_id uuid references public.characters (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  code text not null,
  title text not null,
  description text,
  tier public.achievement_tier not null default 'bronze',
  quarter integer not null,
  payload jsonb not null default '{}'::jsonb,
  sim_event_id uuid references public.sim_events (event_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint achievements_code_format check (code ~ '^[a-z0-9_]{3,64}$'),
  constraint achievements_title_len check (char_length(title) between 1 and 120),
  constraint achievements_quarter_positive check (quarter >= 1),
  constraint achievements_has_subject
    check (player_id is not null or character_id is not null or company_id is not null)
);

comment on table public.achievements is
  'Milestones granted by the resolver and traceable to the sim_event that earned them: crossing a significant ownership threshold, winning a first sovereign contract, being dismissed as CEO and regaining control.';

create unique index achievements_unique_idx
  on public.achievements (session_id, player_id, company_id, code)
  nulls not distinct;

create index achievements_session_quarter_idx on public.achievements (session_id, quarter desc);
create index achievements_player_idx on public.achievements (player_id);

alter table public.achievements enable row level security;

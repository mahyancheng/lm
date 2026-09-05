-- ===========================================================================
-- 0002_sessions.sql — Frontier Capital
--
-- Sessions are the unit of a shared world. Everything in the simulation is
-- scoped by session_id: a session has one seed, one canonical timeline of
-- quarters and a fixed roster of human founders and NPC companies.
--
-- Determinism contract: S_{t+1} = F(S_t, actions, modifiers, seed). The seed
-- lives here; the engine derives all pseudo-randomness from it.
--
-- Idempotency contract: quarters has UNIQUE (session_id, quarter_no) and a
-- status machine ('planning' -> 'locked' -> 'resolving' -> 'committed').
-- A quarter can never resolve twice.
-- ===========================================================================

create type public.session_status as enum (
  'lobby',
  'active',
  'paused',
  'completed',
  'archived'
);

comment on type public.session_status is
  'Lifecycle of a shared world. Only ''active'' sessions accept player actions.';

create type public.quarter_status as enum (
  'planning',
  'locked',
  'resolving',
  'committed'
);

comment on type public.quarter_status is
  'Quarter lifecycle. Player actions are only accepted while a quarter is ''planning''; ''committed'' is terminal and makes resolution idempotent.';

-- ---------------------------------------------------------------------------
-- game_sessions
-- ---------------------------------------------------------------------------

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  seed bigint not null,
  status public.session_status not null default 'lobby',
  current_quarter integer not null default 1,
  start_year integer not null default 2027,
  start_quarter_of_year smallint not null default 1,
  max_human_players smallint not null default 8,
  is_public boolean not null default false,
  is_demo boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  engine_version text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_sessions_name_len check (char_length(name) between 1 and 120),
  constraint game_sessions_current_quarter_positive check (current_quarter >= 1),
  constraint game_sessions_start_year_range check (start_year between 2000 and 2200),
  constraint game_sessions_start_quarter_range check (start_quarter_of_year between 1 and 4),
  constraint game_sessions_max_players_range check (max_human_players between 1 and 8),
  constraint game_sessions_slug_format
    check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,60}$')
);

comment on table public.game_sessions is
  'One shared simulated world: a seed, a config and a timeline of quarters. All game data is scoped by session_id.';
comment on column public.game_sessions.seed is
  'Session RNG seed. Same state + same recorded decisions + same seed = same outcome.';
comment on column public.game_sessions.current_quarter is
  '1-based index of the quarter currently open or most recently committed.';
comment on column public.game_sessions.config is
  'Balancing knobs for this session (leaderboard weights, event hazard rates, NPC tiers). Read by the engine, never by the client for authority.';

create index game_sessions_status_idx on public.game_sessions (status);
create index game_sessions_created_by_idx on public.game_sessions (created_by);

create trigger game_sessions_set_updated_at
  before update on public.game_sessions
  for each row execute function public.set_updated_at();

alter table public.game_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- session_players
-- ---------------------------------------------------------------------------

create table public.session_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  -- NULL for NPC founders; NOT NULL (and account-bound) for humans.
  profile_id uuid references public.profiles (id) on delete set null,
  -- FK added in 0010_people.sql (characters) and 0004_companies.sql (companies).
  character_id uuid,
  company_id uuid,
  is_human boolean not null default true,
  seat_no smallint,
  display_name text,
  status text not null default 'active',
  eliminated_quarter integer,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint session_players_human_is_account_bound
    check (
      (is_human and profile_id is not null)
      or ((not is_human) and profile_id is null)
    ),
  constraint session_players_status_values
    check (status in ('active', 'inactive', 'resigned', 'eliminated')),
  constraint session_players_seat_range
    check (seat_no is null or seat_no between 1 and 64)
);

comment on table public.session_players is
  'A seat in a session. Human seats are bound to a profile; NPC founders have profile_id NULL and is_human false.';
comment on column public.session_players.character_id is
  'The in-world person occupying this seat. Foreign key added in 0010_people.sql.';
comment on column public.session_players.company_id is
  'The company this seat currently controls. Being CEO and owning the company are separate states; this is the control pointer, not ownership. Foreign key added in 0004_companies.sql.';

create unique index session_players_unique_profile_idx
  on public.session_players (session_id, profile_id)
  where profile_id is not null;

create unique index session_players_unique_seat_idx
  on public.session_players (session_id, seat_no)
  where seat_no is not null;

create index session_players_session_idx on public.session_players (session_id);
create index session_players_profile_idx on public.session_players (profile_id);
create index session_players_company_idx on public.session_players (company_id);

alter table public.session_players enable row level security;

-- ---------------------------------------------------------------------------
-- quarters
-- ---------------------------------------------------------------------------

create table public.quarters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter_no integer not null,
  year integer not null,
  quarter_of_year smallint not null,
  status public.quarter_status not null default 'planning',
  opened_at timestamptz,
  locked_at timestamptz,
  resolving_at timestamptz,
  committed_at timestamptz,
  -- FK added in 0003_world.sql once world_snapshots exists.
  state_snapshot_id uuid,
  resolver_version text,
  resolution_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quarters_quarter_no_positive check (quarter_no >= 1),
  constraint quarters_year_range check (year between 2000 and 2200),
  constraint quarters_quarter_of_year_range check (quarter_of_year between 1 and 4),
  constraint quarters_committed_requires_timestamp
    check (status <> 'committed' or committed_at is not null),
  constraint quarters_unique_no unique (session_id, quarter_no)
);

comment on table public.quarters is
  'The canonical quarter timeline of a session. UNIQUE (session_id, quarter_no) plus the status machine is what makes quarter resolution idempotent: a quarter cannot resolve twice.';
comment on column public.quarters.state_snapshot_id is
  'World snapshot captured when the quarter opened. Foreign key added in 0003_world.sql.';
comment on column public.quarters.resolution_summary is
  'Engine-authored summary rendered by the Quarter Resolution screen. Every line traces to a committed sim_event.';

create index quarters_session_status_idx on public.quarters (session_id, status);

create trigger quarters_set_updated_at
  before update on public.quarters
  for each row execute function public.set_updated_at();

alter table public.quarters enable row level security;

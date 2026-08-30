-- ===========================================================================
-- 0014_simulation.sql — Frontier Capital
--
-- The resolver's input and output.
--
--   player_actions  — validated structured instructions submitted by humans
--   agent_actions   — the same, from NPC strategists (LLM or archetype AI)
--   sim_events      — the append-only ledger. Every economic mutation writes
--                     one, hash-chained through state_hash_before/after.
--
-- sim_events is enforced append-only at the database level: UPDATE and DELETE
-- raise an exception, for the service role too. Snapshots make loads fast; the
-- ledger makes history auditable, so "why did my stock fall?" is answered from
-- recorded facts rather than invented by a model.
-- ===========================================================================

create type public.action_status as enum (
  'draft',
  'submitted',
  'validated',
  'rejected',
  'resolved',
  'cancelled',
  'superseded'
);

create type public.action_actor_kind as enum ('player', 'npc_company', 'character', 'engine');

-- ---------------------------------------------------------------------------
-- player_actions
-- ---------------------------------------------------------------------------

create table public.player_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  player_id uuid not null references public.session_players (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  -- Stable ordering within a quarter. Resolution order is deterministic:
  -- (player_id, idx), never wall-clock arrival.
  idx integer not null,
  action_type text not null,
  action jsonb not null,
  status public.action_status not null default 'draft',
  requires_confirmation boolean not null default false,
  confirmed_at timestamptz,
  origin text not null default 'ui',
  chief_of_staff_run_id uuid references public.agent_runs (id) on delete set null,
  validation jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint player_actions_quarter_positive check (quarter >= 1),
  constraint player_actions_idx_nonneg check (idx >= 0),
  constraint player_actions_action_type_format check (action_type ~ '^[a-z0-9_]{3,64}$'),
  constraint player_actions_action_is_object check (jsonb_typeof(action) = 'object'),
  constraint player_actions_origin_values check (origin in ('ui', 'chief_of_staff', 'api')),
  constraint player_actions_unique unique (session_id, quarter, player_id, idx)
);

comment on table public.player_actions is
  'Structured quarter instructions. Clients may INSERT their own rows while the quarter is ''planning'' and nothing else — the resolver validates, bounds-checks and resolves them. A client cannot manufacture money, shares or score by writing here.';
comment on column public.player_actions.action is
  'The typed ActionIntent, validated against @frontier/contracts. Free text never reaches this column; the Chief of Staff produces a proposal the player approves first.';
comment on column public.player_actions.requires_confirmation is
  'true for financing, M&A, layoffs, share issuance, major contracts and large spend. Those are never auto-executed, whatever the player''s auto_execute_routine setting says.';

create index player_actions_session_quarter_idx on public.player_actions (session_id, quarter);
create index player_actions_player_idx on public.player_actions (player_id, quarter desc);
create index player_actions_status_idx on public.player_actions (session_id, quarter, status);

alter table public.player_actions enable row level security;

-- ---------------------------------------------------------------------------
-- agent_actions
-- ---------------------------------------------------------------------------

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  actor_kind public.action_actor_kind not null default 'npc_company',
  company_id uuid references public.companies (id) on delete cascade,
  character_id uuid references public.characters (id) on delete cascade,
  agent_run_id uuid references public.agent_runs (id) on delete set null,
  idx integer not null,
  action_type text not null,
  action jsonb not null,
  status public.action_status not null default 'submitted',
  validation jsonb not null default '{}'::jsonb,
  strategy_label text,
  created_at timestamptz not null default now(),
  constraint agent_actions_quarter_positive check (quarter >= 1),
  constraint agent_actions_idx_nonneg check (idx >= 0),
  constraint agent_actions_action_type_format check (action_type ~ '^[a-z0-9_]{3,64}$'),
  constraint agent_actions_action_is_object check (jsonb_typeof(action) = 'object'),
  constraint agent_actions_has_actor
    check (company_id is not null or character_id is not null)
);

comment on table public.agent_actions is
  'NPC intentions for the quarter. An intention is only an attempt: the engine decides whether raising $1.2B at 16% dilution or reserving 45,000 accelerators actually succeeds.';

create unique index agent_actions_unique_idx
  on public.agent_actions (session_id, quarter, company_id, character_id, idx)
  nulls not distinct;

create index agent_actions_session_quarter_idx on public.agent_actions (session_id, quarter);
create index agent_actions_company_idx on public.agent_actions (company_id, quarter desc);

alter table public.agent_actions enable row level security;

-- ---------------------------------------------------------------------------
-- sim_events (append-only ledger)
-- ---------------------------------------------------------------------------

create table public.sim_events (
  event_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  sequence bigint not null,
  type text not null,
  actor_kind text,
  actor_id uuid,
  target_kind text,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  state_hash_before text,
  state_hash_after text,
  visibility public.visibility_scope not null default 'session',
  created_at timestamptz not null default now(),
  constraint sim_events_quarter_positive check (quarter >= 1),
  constraint sim_events_sequence_positive check (sequence >= 0),
  constraint sim_events_type_format check (type ~ '^[a-z0-9_]{3,64}$'),
  constraint sim_events_payload_is_object check (jsonb_typeof(payload) = 'object'),
  constraint sim_events_unique_sequence unique (session_id, quarter, sequence)
);

comment on table public.sim_events is
  'Append-only ledger. Every economic mutation writes exactly one row, hash-chained through state_hash_before/after. UPDATE and DELETE are blocked by trigger for every role including service_role: history is not editable.';
comment on column public.sim_events.sequence is
  'Monotonic ordering within (session, quarter). UNIQUE with session_id and quarter, so a replay produces the identical ledger or fails loudly.';
comment on column public.sim_events.visibility is
  'Private events are canonical truth (a secret research slip, a real cost overrun) and are never readable by clients. Public and session events are what the news, market and resolution report are built from.';

create index sim_events_session_quarter_seq_idx
  on public.sim_events (session_id, quarter, sequence);
create index sim_events_type_idx on public.sim_events (session_id, type);
create index sim_events_actor_idx on public.sim_events (actor_id);
create index sim_events_target_idx on public.sim_events (target_id);
create index sim_events_visibility_idx on public.sim_events (session_id, visibility);

create trigger sim_events_forbid_update
  before update on public.sim_events
  for each row execute function public.forbid_mutation();

create trigger sim_events_forbid_delete
  before delete on public.sim_events
  for each row execute function public.forbid_mutation();

alter table public.sim_events enable row level security;

-- Deferred references to sim_events from earlier migrations.
alter table public.transactions
  add constraint transactions_sim_event_id_fkey
  foreign key (sim_event_id) references public.sim_events (event_id) on delete set null;

alter table public.deal_proposals
  add constraint deal_proposals_sim_event_id_fkey
  foreign key (sim_event_id) references public.sim_events (event_id) on delete set null;

alter table public.memories
  add constraint memories_source_event_id_fkey
  foreign key (source_event_id) references public.sim_events (event_id) on delete set null;

alter table public.media_stories
  add constraint media_stories_source_event_id_fkey
  foreign key (source_event_id) references public.sim_events (event_id) on delete set null;

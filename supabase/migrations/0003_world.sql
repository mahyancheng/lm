-- ===========================================================================
-- 0003_world.sql — Frontier Capital
--
-- World state, world events and world modifiers.
--
-- Information-boundary rule: canonical private reality does not automatically
-- become public belief. world_snapshots holds omniscient truth and is
-- service-role only; world_events carry an explicit visibility and only the
-- public ones reach clients.
--
-- World Director rule: the LLM proposes structured modifiers, it never writes
-- state. world_modifiers rows are validated, impact-budgeted proposals that the
-- engine (and only the engine) promotes to 'active'.
-- ===========================================================================

create type public.visibility_scope as enum (
  'public',        -- everyone in the session may see it
  'session',       -- session-wide but not part of the public information set
  'company',       -- the owning company only
  'participants',  -- named participants only (conversations, deals)
  'private'        -- canonical truth; server-side only
);

comment on type public.visibility_scope is
  'Information boundary. ''public'' is the public information set that markets price; ''private'' is canonical truth that no client may read.';

create type public.modifier_operation as enum ('add', 'multiply', 'set');

create type public.modifier_decay as enum ('none', 'linear', 'exponential', 'step');

create type public.modifier_status as enum ('proposed', 'active', 'expired', 'rejected', 'revoked');

create type public.event_source as enum (
  'engine',
  'world_director',
  'player',
  'agent',
  'seed'
);

-- ---------------------------------------------------------------------------
-- jurisdictions
-- ---------------------------------------------------------------------------

create table public.jurisdictions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  code text not null,
  name text not null,
  region text,
  regulatory_stance numeric not null default 0.5,
  export_control_level numeric not null default 0.2,
  corporate_tax_rate numeric not null default 0.21,
  energy_cost_index numeric not null default 1.0,
  talent_index numeric not null default 1.0,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint jurisdictions_unique_code unique (session_id, code),
  constraint jurisdictions_regulatory_stance_range check (regulatory_stance between 0 and 1),
  constraint jurisdictions_export_control_range check (export_control_level between 0 and 1),
  constraint jurisdictions_tax_range check (corporate_tax_rate between 0 and 1),
  constraint jurisdictions_energy_positive check (energy_cost_index > 0),
  constraint jurisdictions_talent_positive check (talent_index > 0)
);

comment on table public.jurisdictions is
  'Fictional legal/regulatory territories. Governs export controls, tax, energy cost and talent supply for companies domiciled there.';

alter table public.jurisdictions enable row level security;

-- ---------------------------------------------------------------------------
-- world_snapshots
-- ---------------------------------------------------------------------------

create table public.world_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  state jsonb not null,
  state_hash text not null,
  engine_version text,
  created_at timestamptz not null default now(),
  constraint world_snapshots_quarter_positive check (quarter >= 1),
  constraint world_snapshots_unique_quarter unique (session_id, quarter),
  constraint world_snapshots_hash_len check (char_length(state_hash) between 8 and 128)
);

comment on table public.world_snapshots is
  'Canonical omniscient world state at the open of a quarter (macro, capital markets, compute, energy, AI frontier, talent, data, society, regulation, government, geopolitics, media). Service-role only: this is truth, not the public information set.';
comment on column public.world_snapshots.state_hash is
  'Hash of the canonical state. Chained through sim_events.state_hash_before/after to make replays verifiable.';

create index world_snapshots_session_quarter_idx
  on public.world_snapshots (session_id, quarter desc);

alter table public.world_snapshots enable row level security;

-- quarters.state_snapshot_id was declared in 0002 before this table existed.
alter table public.quarters
  add constraint quarters_state_snapshot_id_fkey
  foreign key (state_snapshot_id) references public.world_snapshots (id) on delete set null;

-- ---------------------------------------------------------------------------
-- world_events
-- ---------------------------------------------------------------------------

create table public.world_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  event_family text not null,
  event_type text not null,
  title_key text not null,
  headline text not null,
  body text,
  severity numeric not null default 0,
  visibility public.visibility_scope not null default 'public',
  duration_quarters smallint not null default 1,
  parent_event_id uuid references public.world_events (id) on delete set null,
  source public.event_source not null default 'engine',
  agent_run_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint world_events_quarter_positive check (quarter >= 1),
  constraint world_events_severity_range check (severity between 0 and 1),
  constraint world_events_duration_range check (duration_quarters between 0 and 40),
  constraint world_events_headline_len check (char_length(headline) between 1 and 240),
  constraint world_events_no_self_parent check (parent_event_id is null or parent_event_id <> id)
);

comment on table public.world_events is
  'World shocks and news. The deterministic hazard model chooses event families and a severity budget BEFORE the World Director LLM contextualises them. Only visibility = ''public'' rows are readable by clients.';
comment on column public.world_events.event_family is
  'Causal family (compute_supply, capital_cycle, regulation, geopolitics, energy, talent, media...). Families drive cooldowns and follow-on hazards.';
comment on column public.world_events.parent_event_id is
  'Causal root. Correlated cascades share a parent instead of firing as unrelated random events.';
comment on column public.world_events.agent_run_id is
  'The agent_runs row that proposed this event, when source = ''world_director''. Foreign key added in 0013_agents.sql.';

create index world_events_session_quarter_idx
  on public.world_events (session_id, quarter desc);
create index world_events_visibility_idx
  on public.world_events (session_id, visibility);
create index world_events_family_idx
  on public.world_events (session_id, event_family);

alter table public.world_events enable row level security;

-- ---------------------------------------------------------------------------
-- world_modifiers
-- ---------------------------------------------------------------------------

create table public.world_modifiers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  event_id uuid references public.world_events (id) on delete cascade,
  target text not null,
  operation public.modifier_operation not null,
  value numeric not null,
  decay public.modifier_decay not null default 'none',
  applied_from_quarter integer not null,
  expires_after_quarter integer,
  impact_budget_used numeric not null default 0,
  status public.modifier_status not null default 'proposed',
  rejection_reason text,
  source public.event_source not null default 'world_director',
  created_at timestamptz not null default now(),
  constraint world_modifiers_target_format check (target ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  constraint world_modifiers_from_quarter_positive check (applied_from_quarter >= 1),
  constraint world_modifiers_expiry_after_start
    check (expires_after_quarter is null or expires_after_quarter >= applied_from_quarter),
  constraint world_modifiers_budget_range check (impact_budget_used between 0 and 1),
  constraint world_modifiers_multiply_positive
    check (operation <> 'multiply' or value > 0)
);

comment on table public.world_modifiers is
  'Validated, impact-budgeted changes to world state. The World Director LLM may only propose these; the engine bounds-checks the target, operation, value and duration before promoting a row to ''active''.';
comment on column public.world_modifiers.target is
  'Dotted canonical path, e.g. world.compute.accelerator_supply or sector.semiconductors.sentiment. The engine rejects unknown targets.';
comment on column public.world_modifiers.impact_budget_used is
  'Share of the quarter''s severity budget consumed. Keeps an imaginative model from becoming omnipotent over magnitude.';

create index world_modifiers_session_quarter_idx
  on public.world_modifiers (session_id, applied_from_quarter);
create index world_modifiers_status_idx
  on public.world_modifiers (session_id, status);
create index world_modifiers_event_idx on public.world_modifiers (event_id);

alter table public.world_modifiers enable row level security;

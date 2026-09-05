-- ===========================================================================
-- 0013_agents.sql — Frontier Capital
--
-- LLM agent bookkeeping. Every model role is specialised with sharply
-- separated authority:
--   * world_director        — proposes validated world modifiers, nothing else
--   * chief_of_staff        — conversational; translates intent into actions
--   * npc_strategist        — runs a rival company on its own information set
--   * character_dialogue    — a person with traits, beliefs and memories
--   * innovation_interpreter— turns a player's invented strategy into a node
--   * media / analyst       — narrative and market commentary
--
-- Reproducibility: every important LLM result is stored with its model,
-- schema version, context hash, raw structured output, the validation result
-- and what the engine actually did with it. Bugs are reproducible and sessions
-- can be replayed.
--
-- Containment: nothing in this domain is readable by clients. Prompts,
-- proposals and rejected outputs are server-side only.
-- ===========================================================================

create type public.agent_role as enum (
  'world_director',
  'chief_of_staff',
  'npc_strategist',
  'character_dialogue',
  'innovation_interpreter',
  'media',
  'analyst',
  'regulator',
  'board_director',
  'moderator'
);

create type public.agent_run_status as enum (
  'pending',
  'succeeded',
  'validation_failed',
  'bounds_rejected',
  'model_error',
  'timeout',
  'fallback'
);

-- ---------------------------------------------------------------------------
-- agent_profiles
-- ---------------------------------------------------------------------------

create table public.agent_profiles (
  id uuid primary key default gen_random_uuid(),
  -- NULL for reusable templates shared by every session.
  session_id uuid references public.game_sessions (id) on delete cascade,
  agent_role public.agent_role not null,
  name text not null,
  version text not null default '1',
  model_id text not null default 'claude-opus-5',
  tier public.company_tier not null default 'major',
  system_prompt_key text,
  temperature numeric,
  character_id uuid references public.characters (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  fallback_strategy text not null default 'deterministic_archetype',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_profiles_name_len check (char_length(name) between 1 and 80),
  constraint agent_profiles_version_format check (version ~ '^[a-zA-Z0-9._-]{1,32}$'),
  constraint agent_profiles_temperature_range
    check (temperature is null or temperature between 0 and 2),
  constraint agent_profiles_fallback_values check (
    fallback_strategy in (
      'deterministic_archetype', 'repeat_last_plan', 'no_action',
      'scripted_template', 'rule_strategy'
    )
  )
);

comment on table public.agent_profiles is
  'Configuration of an LLM role instance: which model, which prompt, which company or character it speaks for, and what it falls back to when the model is unavailable. Service-role only — prompt configuration is not client data.';
comment on column public.agent_profiles.fallback_strategy is
  'Deterministic behaviour used when the Claude API is unavailable or returns invalid output. The game never blocks on a model.';

create unique index agent_profiles_unique_idx
  on public.agent_profiles (session_id, agent_role, name, version)
  nulls not distinct;

create index agent_profiles_session_role_idx on public.agent_profiles (session_id, agent_role);
create index agent_profiles_company_idx on public.agent_profiles (company_id);
create index agent_profiles_character_idx on public.agent_profiles (character_id);

create trigger agent_profiles_set_updated_at
  before update on public.agent_profiles
  for each row execute function public.set_updated_at();

alter table public.agent_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- agent_runs
-- ---------------------------------------------------------------------------

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  agent_profile_id uuid references public.agent_profiles (id) on delete set null,
  agent_role public.agent_role not null,
  agent_version text not null default '1',
  model_id text not null,
  schema_version text not null,
  context_hash text not null,
  input_state_version text,
  input_summary jsonb not null default '{}'::jsonb,
  structured_output jsonb,
  validation_result jsonb not null default '{}'::jsonb,
  engine_result jsonb not null default '{}'::jsonb,
  status public.agent_run_status not null default 'pending',
  fallback_used boolean not null default false,
  latency_ms integer,
  tokens jsonb not null default '{}'::jsonb,
  error text,
  company_id uuid references public.companies (id) on delete set null,
  character_id uuid references public.characters (id) on delete set null,
  player_id uuid references public.session_players (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint agent_runs_quarter_positive check (quarter >= 1),
  constraint agent_runs_latency_nonneg check (latency_ms is null or latency_ms >= 0),
  constraint agent_runs_context_hash_len check (char_length(context_hash) between 8 and 128),
  constraint agent_runs_succeeded_has_output
    check (status <> 'succeeded' or structured_output is not null)
);

comment on table public.agent_runs is
  'One record per LLM invocation: session, quarter, role, model, schema version, context hash, raw structured output, validation result, engine result, latency and token usage. Service-role only. This is the audit trail that makes agent behaviour reproducible and containment provable — invalid output is recorded here and never reaches state.';
comment on column public.agent_runs.context_hash is
  'Hash of the exact context the model saw. Same context + same model + same schema version reproduces the run.';
comment on column public.agent_runs.validation_result is
  'Outcome of zod parsing plus engine bounds-checking. status = validation_failed or bounds_rejected means nothing was written to the world.';
comment on column public.agent_runs.tokens is
  'Usage accounting, e.g. {"input":…, "output":…, "cache_read":…, "cache_creation":…}.';

create index agent_runs_session_quarter_idx on public.agent_runs (session_id, quarter desc);
create index agent_runs_role_idx on public.agent_runs (session_id, agent_role, quarter desc);
create index agent_runs_status_idx on public.agent_runs (session_id, status);
create index agent_runs_company_idx on public.agent_runs (company_id);

alter table public.agent_runs enable row level security;

-- Deferred references to agent_runs from earlier migrations.
alter table public.world_events
  add constraint world_events_agent_run_id_fkey
  foreign key (agent_run_id) references public.agent_runs (id) on delete set null;

alter table public.tech_graph_versions
  add constraint tech_graph_versions_agent_run_id_fkey
  foreign key (agent_run_id) references public.agent_runs (id) on delete set null;

alter table public.board_votes
  add constraint board_votes_agent_run_id_fkey
  foreign key (agent_run_id) references public.agent_runs (id) on delete set null;

alter table public.messages
  add constraint messages_agent_run_id_fkey
  foreign key (agent_run_id) references public.agent_runs (id) on delete set null;

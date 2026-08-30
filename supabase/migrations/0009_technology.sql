-- ===========================================================================
-- 0009_technology.sql — Frontier Capital
--
-- The Frontier Map. Not a tech tree: a typed, probabilistic, contested and
-- mutable picture of what the inhabitants of THIS simulated world believe the
-- technological future might look like.
--
-- Safety rule: the LLM generates a typed TechGraph (validated by
-- @frontier/contracts), never executable code. Trusted React/SVG renders it.
--
-- Information boundary: research_projects.is_secret is RLS-critical. A secret
-- programme damages internal R&D when it slips, but must not move the public
-- share price until it leaks or is disclosed.
-- ===========================================================================

create type public.epistemic_state as enum (
  'established',     -- widely known technology
  'emerging',        -- technically credible and actively developing
  'forecast',        -- broadly considered plausible
  'speculative',     -- weak evidence / contested
  'company_thesis',  -- believed mainly by one company
  'secret',          -- known only internally
  'discredited',     -- previously expected, now considered unlikely
  'achieved',        -- successfully demonstrated
  'dead_end'         -- session evidence strongly undermined this path
);

create type public.tech_node_origin as enum (
  'seed',
  'world_director',
  'player_hypothesis',
  'agent_hypothesis',
  'engine'
);

create type public.tech_edge_kind as enum (
  'dependency',
  'unlock',
  'competes_with',
  'supersedes',
  'enables'
);

create type public.research_status as enum (
  'proposed',
  'approved',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled'
);

create type public.invention_kind as enum (
  'capability',
  'product_technology',
  'process',
  'infrastructure',
  'safety',
  'tooling'
);

-- ---------------------------------------------------------------------------
-- tech_graph_versions
-- ---------------------------------------------------------------------------

create table public.tech_graph_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  version integer not null,
  quarter integer not null default 1,
  graph jsonb not null,
  graph_hash text,
  reason text,
  created_by public.tech_node_origin not null default 'engine',
  agent_run_id uuid,
  created_at timestamptz not null default now(),
  constraint tech_graph_versions_version_positive check (version >= 1),
  constraint tech_graph_versions_quarter_positive check (quarter >= 1),
  constraint tech_graph_versions_unique unique (session_id, version)
);

comment on table public.tech_graph_versions is
  'Immutable snapshots of the whole Frontier Map. The graph physically rearranges as beliefs shift, so the UI can diff one version against the next and animate what changed.';
comment on column public.tech_graph_versions.graph is
  'Full typed TechGraph document validated against the zod schema in @frontier/contracts before it is written. Never executable content.';

create index tech_graph_versions_session_idx
  on public.tech_graph_versions (session_id, version desc);

alter table public.tech_graph_versions enable row level security;

-- ---------------------------------------------------------------------------
-- tech_nodes
-- ---------------------------------------------------------------------------

create table public.tech_nodes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  graph_version_id uuid references public.tech_graph_versions (id) on delete set null,
  node_key text not null,
  title text not null,
  summary text,
  epistemic_state public.epistemic_state not null default 'forecast',
  public_confidence numeric not null default 0.5,
  estimated_window_start integer,
  estimated_window_end integer,
  research_cost_min_usd numeric,
  research_cost_max_usd numeric,
  compute_intensity numeric not null default 0.5,
  talent_requirements text[] not null default '{}'::text[],
  visibility public.visibility_scope not null default 'public',
  owner_company_id uuid references public.companies (id) on delete set null,
  origin public.tech_node_origin not null default 'seed',
  novelty numeric,
  plausibility numeric,
  achieved_quarter integer,
  achieved_by_company_id uuid references public.companies (id) on delete set null,
  layout jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tech_nodes_node_key_format check (node_key ~ '^[a-z0-9_]{3,64}$'),
  constraint tech_nodes_title_len check (char_length(title) between 1 and 120),
  constraint tech_nodes_confidence_range check (public_confidence between 0 and 1),
  constraint tech_nodes_compute_range check (compute_intensity between 0 and 1),
  constraint tech_nodes_novelty_range check (novelty is null or novelty between 0 and 1),
  constraint tech_nodes_plausibility_range
    check (plausibility is null or plausibility between 0 and 1),
  constraint tech_nodes_window_order check (
    estimated_window_start is null
    or estimated_window_end is null
    or estimated_window_end >= estimated_window_start
  ),
  constraint tech_nodes_cost_order check (
    research_cost_min_usd is null
    or research_cost_max_usd is null
    or research_cost_max_usd >= research_cost_min_usd
  ),
  constraint tech_nodes_cost_nonneg check (
    (research_cost_min_usd is null or research_cost_min_usd >= 0)
    and (research_cost_max_usd is null or research_cost_max_usd >= 0)
  ),
  constraint tech_nodes_secret_has_owner
    check (epistemic_state <> 'secret' or owner_company_id is not null),
  constraint tech_nodes_unique_key unique (session_id, node_key)
);

comment on table public.tech_nodes is
  'A believed technological possibility. Epistemic state and public_confidence are contested beliefs, not facts: a world event can move a node from forecast to discredited without anything physical happening.';
comment on column public.tech_nodes.visibility is
  'Secret and company-thesis nodes are readable only by the owning company until published, leaked or demonstrated.';
comment on column public.tech_nodes.origin is
  'player_hypothesis marks a node the Innovation Interpreter accepted from a player''s own invented strategy and promoted into this session''s graph.';

create index tech_nodes_session_idx on public.tech_nodes (session_id);
create index tech_nodes_state_idx on public.tech_nodes (session_id, epistemic_state);
create index tech_nodes_owner_idx on public.tech_nodes (owner_company_id);

create trigger tech_nodes_set_updated_at
  before update on public.tech_nodes
  for each row execute function public.set_updated_at();

alter table public.tech_nodes enable row level security;

-- ---------------------------------------------------------------------------
-- tech_edges
-- ---------------------------------------------------------------------------

create table public.tech_edges (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  graph_version_id uuid references public.tech_graph_versions (id) on delete set null,
  from_node_id uuid not null references public.tech_nodes (id) on delete cascade,
  to_node_id uuid not null references public.tech_nodes (id) on delete cascade,
  kind public.tech_edge_kind not null default 'dependency',
  weight numeric not null default 1,
  confidence numeric not null default 0.5,
  visibility public.visibility_scope not null default 'public',
  owner_company_id uuid references public.companies (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tech_edges_no_self_loop check (from_node_id <> to_node_id),
  constraint tech_edges_weight_range check (weight between 0 and 5),
  constraint tech_edges_confidence_range check (confidence between 0 and 1),
  constraint tech_edges_unique unique (session_id, from_node_id, to_node_id, kind)
);

comment on table public.tech_edges is
  'Believed relationships between nodes. Edges carry their own visibility so a secret dependency cannot leak the existence of a secret node.';

create index tech_edges_from_idx on public.tech_edges (from_node_id);
create index tech_edges_to_idx on public.tech_edges (to_node_id);
create index tech_edges_session_idx on public.tech_edges (session_id);

alter table public.tech_edges enable row level security;

-- ---------------------------------------------------------------------------
-- research_projects
-- ---------------------------------------------------------------------------

create table public.research_projects (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  node_id uuid references public.tech_nodes (id) on delete set null,
  owner_player_id uuid references public.session_players (id) on delete set null,
  name text not null,
  hypothesis text,
  -- RLS-critical. A secret programme is visible only to the owning company.
  is_secret boolean not null default false,
  status public.research_status not null default 'proposed',
  started_quarter integer,
  target_quarter integer,
  completed_quarter integer,
  budget_usd numeric not null default 0,
  spent_usd numeric not null default 0,
  compute_allocated numeric not null default 0,
  headcount_allocated integer not null default 0,
  progress numeric not null default 0,
  internal_confidence numeric not null default 0.5,
  risk numeric not null default 0.5,
  schedule_variance_quarters smallint not null default 0,
  cost_variance numeric not null default 0,
  incident_count smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_projects_name_len check (char_length(name) between 1 and 160),
  constraint research_projects_budget_nonneg check (budget_usd >= 0),
  constraint research_projects_spent_nonneg check (spent_usd >= 0),
  constraint research_projects_compute_nonneg check (compute_allocated >= 0),
  constraint research_projects_headcount_nonneg check (headcount_allocated >= 0),
  constraint research_projects_progress_range check (progress between 0 and 1),
  constraint research_projects_confidence_range check (internal_confidence between 0 and 1),
  constraint research_projects_risk_range check (risk between 0 and 1),
  constraint research_projects_incidents_nonneg check (incident_count >= 0),
  constraint research_projects_window
    check (target_quarter is null or started_quarter is null or target_quarter >= started_quarter),
  constraint research_projects_completed_requires_quarter
    check (status <> 'completed' or completed_quarter is not null)
);

comment on table public.research_projects is
  'Internal R&D programmes. is_secret is enforced by RLS: a secret programme that is two quarters late with a 31% cost overrun stays invisible to every other player until it is disclosed or leaks.';
comment on column public.research_projects.internal_confidence is
  'What the company actually believes about shipping. Public guidance can say something entirely different — that gap is the earnings-surprise mechanic.';

create index research_projects_company_idx on public.research_projects (company_id);
create index research_projects_session_secret_idx
  on public.research_projects (session_id, is_secret);
create index research_projects_node_idx on public.research_projects (node_id);
create index research_projects_owner_player_idx on public.research_projects (owner_player_id);

create trigger research_projects_set_updated_at
  before update on public.research_projects
  for each row execute function public.set_updated_at();

alter table public.research_projects enable row level security;

-- ---------------------------------------------------------------------------
-- inventions
-- ---------------------------------------------------------------------------

create table public.inventions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  project_id uuid references public.research_projects (id) on delete set null,
  node_id uuid references public.tech_nodes (id) on delete set null,
  quarter integer not null,
  title text not null,
  description text,
  kind public.invention_kind not null default 'capability',
  significance numeric not null default 0.5,
  capability_delta numeric not null default 0,
  is_published boolean not null default false,
  published_quarter integer,
  is_open_weight boolean not null default false,
  patent_status text not null default 'none',
  visibility public.visibility_scope not null default 'company',
  created_at timestamptz not null default now(),
  constraint inventions_quarter_positive check (quarter >= 1),
  constraint inventions_title_len check (char_length(title) between 1 and 160),
  constraint inventions_significance_range check (significance between 0 and 1),
  constraint inventions_capability_delta_range check (capability_delta between -1 and 1),
  constraint inventions_patent_values
    check (patent_status in ('none', 'filed', 'granted', 'rejected', 'trade_secret')),
  constraint inventions_published_requires_quarter
    check ((not is_published) or published_quarter is not null)
);

comment on table public.inventions is
  'Demonstrated results. Publishing one updates the Frontier Map, which makes rival agents reconsider strategy, moves talent demand and repriced adjacent companies.';

create index inventions_company_idx on public.inventions (company_id, quarter desc);
create index inventions_node_idx on public.inventions (node_id);
create index inventions_session_quarter_idx on public.inventions (session_id, quarter desc);

alter table public.inventions enable row level security;

-- ===========================================================================
-- 0004_companies.sql — Frontier Capital
--
-- The operating layer: companies, their quarterly financials, products,
-- resources (compute/energy/data), aggregated workforce and executives.
--
-- Information boundary: a company's own financials, workforce and resource
-- positions are private to whoever controls it. What the world learns arrives
-- through public_disclosures (0007) and social/media propagation (0011).
-- ===========================================================================

create type public.company_archetype as enum (
  'frontier_lab',
  'applied_ai',
  'infrastructure',
  'semiconductor',
  'data_platform',
  'vertical_ai',
  'open_source',
  'defence_tech',
  'consumer_ai',
  'consultancy',
  'holding_company'
);

create type public.company_stage as enum (
  'idea',
  'seed',
  'early',
  'growth',
  'industry_player',
  'late_stage',
  'public',
  'conglomerate'
);

create type public.company_status as enum (
  'active',
  'acquired',
  'merged',
  'wound_down',
  'bankrupt'
);

-- Agent tiering from the LLM architecture: only major companies get a full LLM
-- deliberation each quarter; background companies run deterministic archetype AI.
create type public.company_tier as enum ('major', 'significant', 'background');

create type public.product_status as enum (
  'research',
  'development',
  'beta',
  'launched',
  'deprecated',
  'sunset'
);

create type public.executive_role as enum (
  'ceo',
  'president',
  'cto',
  'cfo',
  'coo',
  'chief_scientist',
  'chief_safety_officer',
  'chief_revenue_officer',
  'general_counsel',
  'head_of_policy',
  'head_of_people'
);

create type public.resource_kind as enum (
  'accelerator_reservation',
  'accelerator_spot',
  'datacentre_capacity',
  'energy_contract',
  'data_licence',
  'office_lease',
  'network_capacity'
);

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  name text not null,
  ticker text,
  archetype public.company_archetype not null,
  stage public.company_stage not null default 'seed',
  tier public.company_tier not null default 'background',
  status public.company_status not null default 'active',
  is_player_company boolean not null default false,
  controlled_by_player_id uuid references public.session_players (id) on delete set null,
  parent_company_id uuid references public.companies (id) on delete set null,
  jurisdiction_id uuid references public.jurisdictions (id) on delete set null,
  founded_year integer,
  headquarters text,
  tagline text,
  description text,
  thesis text,
  is_public boolean not null default false,
  listed_quarter integer,
  acquired_quarter integer,
  brand_trust numeric not null default 0.5,
  safety_orientation numeric not null default 0.5,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_name_len check (char_length(name) between 1 and 120),
  constraint companies_ticker_format check (ticker is null or ticker ~ '^[A-Z]{2,6}$'),
  constraint companies_no_self_parent check (parent_company_id is null or parent_company_id <> id),
  constraint companies_founded_year_range
    check (founded_year is null or founded_year between 1900 and 2200),
  constraint companies_brand_trust_range check (brand_trust between 0 and 1),
  constraint companies_safety_range check (safety_orientation between 0 and 1),
  constraint companies_public_requires_ticker check ((not is_public) or ticker is not null),
  constraint companies_unique_name unique (session_id, name)
);

comment on table public.companies is
  'An operating business in a session. Slow-moving identity and control pointers only; quarterly economics live in company_quarter_metrics.';
comment on column public.companies.controlled_by_player_id is
  'Who currently runs the company. Deliberately separate from ownership (0005_ownership.sql): a board can dismiss a CEO who still owns 24% of the shares.';
comment on column public.companies.tier is
  'Agent tier. ''major'' = full LLM strategic planning each quarter, ''significant'' = rule strategy with occasional LLM, ''background'' = deterministic archetype AI.';
comment on column public.companies.is_public is
  'Listed on the in-world exchange. Public companies disclose; private companies do not.';

create index companies_session_idx on public.companies (session_id);
create index companies_session_tier_idx on public.companies (session_id, tier);
create index companies_parent_idx on public.companies (parent_company_id);
create unique index companies_unique_ticker_idx
  on public.companies (session_id, ticker)
  where ticker is not null;

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

alter table public.companies enable row level security;

-- session_players.company_id was declared in 0002 before this table existed.
alter table public.session_players
  add constraint session_players_company_id_fkey
  foreign key (company_id) references public.companies (id) on delete set null;

-- ---------------------------------------------------------------------------
-- company_quarter_metrics
-- ---------------------------------------------------------------------------

create table public.company_quarter_metrics (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  revenue_usd numeric not null default 0,
  cogs_usd numeric not null default 0,
  gross_profit_usd numeric not null default 0,
  rnd_usd numeric not null default 0,
  sales_marketing_usd numeric not null default 0,
  general_admin_usd numeric not null default 0,
  operating_income_usd numeric not null default 0,
  interest_expense_usd numeric not null default 0,
  tax_usd numeric not null default 0,
  net_income_usd numeric not null default 0,
  free_cash_flow_usd numeric not null default 0,
  cash_usd numeric not null default 0,
  debt_usd numeric not null default 0,
  total_assets_usd numeric not null default 0,
  total_liabilities_usd numeric not null default 0,
  equity_usd numeric not null default 0,
  burn_rate_usd numeric not null default 0,
  runway_quarters numeric,
  headcount integer not null default 0,
  compute_units numeric not null default 0,
  customers integer not null default 0,
  arr_usd numeric not null default 0,
  net_revenue_retention numeric,
  enterprise_value_usd numeric not null default 0,
  valuation_anchor_usd numeric not null default 0,
  valuation_method text,
  segments jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint company_quarter_metrics_quarter_positive check (quarter >= 1),
  constraint company_quarter_metrics_nonneg check (
    revenue_usd >= 0
    and cogs_usd >= 0
    and rnd_usd >= 0
    and sales_marketing_usd >= 0
    and general_admin_usd >= 0
    and debt_usd >= 0
    and arr_usd >= 0
    and compute_units >= 0
  ),
  constraint company_quarter_metrics_headcount_nonneg check (headcount >= 0),
  constraint company_quarter_metrics_customers_nonneg check (customers >= 0),
  constraint company_quarter_metrics_ev_nonneg check (enterprise_value_usd >= 0),
  constraint company_quarter_metrics_anchor_nonneg check (valuation_anchor_usd >= 0),
  constraint company_quarter_metrics_unique unique (session_id, company_id, quarter)
);

comment on table public.company_quarter_metrics is
  'Committed quarterly P&L, balance sheet and operating metrics. Written only by the resolver, after balance-sheet invariants pass. Private to the controlling player: the world only learns what public_disclosures says.';
comment on column public.company_quarter_metrics.valuation_anchor_usd is
  'Fundamental value the market slowly pulls toward. Method varies by stage (revenue multiple, forward revenue, FCF, asset value, technology option value).';

create index company_quarter_metrics_company_idx
  on public.company_quarter_metrics (company_id, quarter desc);
create index company_quarter_metrics_session_quarter_idx
  on public.company_quarter_metrics (session_id, quarter desc);

alter table public.company_quarter_metrics enable row level security;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

create table public.products (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  category text not null,
  status public.product_status not null default 'development',
  launched_quarter integer,
  sunset_quarter integer,
  price_usd numeric not null default 0,
  pricing_model text not null default 'per_seat',
  capability_score numeric not null default 0,
  quality_score numeric not null default 0,
  reliability numeric not null default 0.9,
  inference_cost_usd numeric not null default 0,
  seats integer not null default 0,
  customers integer not null default 0,
  arr_usd numeric not null default 0,
  churn_rate numeric not null default 0,
  unit_economics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_len check (char_length(name) between 1 and 120),
  constraint products_price_nonneg check (price_usd >= 0),
  constraint products_pricing_model_values
    check (pricing_model in ('per_seat', 'usage', 'flat', 'enterprise_licence', 'free')),
  constraint products_capability_range check (capability_score between 0 and 1),
  constraint products_quality_range check (quality_score between 0 and 1),
  constraint products_reliability_range check (reliability between 0 and 1),
  constraint products_churn_range check (churn_rate between 0 and 1),
  constraint products_seats_nonneg check (seats >= 0),
  constraint products_customers_nonneg check (customers >= 0),
  constraint products_arr_nonneg check (arr_usd >= 0),
  constraint products_inference_cost_nonneg check (inference_cost_usd >= 0),
  constraint products_launched_requires_quarter
    check (status not in ('launched', 'deprecated', 'sunset') or launched_quarter is not null),
  constraint products_unique_name unique (session_id, company_id, name)
);

comment on table public.products is
  'Shipped and in-development products. Launched products are visible to the whole session; unreleased ones are not.';

create index products_company_idx on public.products (company_id);
create index products_session_status_idx on public.products (session_id, status);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

-- ---------------------------------------------------------------------------
-- company_resources
-- ---------------------------------------------------------------------------

create table public.company_resources (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  kind public.resource_kind not null,
  provider text,
  quantity numeric not null default 0,
  unit text not null default 'accelerator_equivalent',
  unit_cost_usd numeric not null default 0,
  committed_from_quarter integer not null,
  committed_until_quarter integer,
  utilisation numeric not null default 0,
  is_cancellable boolean not null default false,
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint company_resources_quantity_nonneg check (quantity >= 0),
  constraint company_resources_unit_cost_nonneg check (unit_cost_usd >= 0),
  constraint company_resources_from_positive check (committed_from_quarter >= 1),
  constraint company_resources_window
    check (committed_until_quarter is null or committed_until_quarter >= committed_from_quarter),
  constraint company_resources_utilisation_range check (utilisation between 0 and 2)
);

comment on table public.company_resources is
  'Compute reservations, datacentre capacity, energy contracts, data licences and leases. Capacity commitments are what make a compute supply shock bite.';

create index company_resources_company_idx on public.company_resources (company_id, kind);

alter table public.company_resources enable row level security;

-- ---------------------------------------------------------------------------
-- employees_agg
-- ---------------------------------------------------------------------------

create table public.employees_agg (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  job_function text not null,
  headcount integer not null default 0,
  hired integer not null default 0,
  departed integer not null default 0,
  avg_salary_usd numeric not null default 0,
  avg_seniority numeric not null default 0.5,
  attrition_rate numeric not null default 0,
  morale numeric not null default 0.5,
  productivity numeric not null default 1.0,
  open_requisitions integer not null default 0,
  created_at timestamptz not null default now(),
  constraint employees_agg_quarter_positive check (quarter >= 1),
  constraint employees_agg_function_values check (
    job_function in (
      'research', 'engineering', 'infrastructure', 'product', 'sales',
      'marketing', 'support', 'safety', 'policy', 'operations', 'g_and_a'
    )
  ),
  constraint employees_agg_headcount_nonneg check (headcount >= 0),
  constraint employees_agg_flows_nonneg check (hired >= 0 and departed >= 0 and open_requisitions >= 0),
  constraint employees_agg_salary_nonneg check (avg_salary_usd >= 0),
  constraint employees_agg_seniority_range check (avg_seniority between 0 and 1),
  constraint employees_agg_attrition_range check (attrition_rate between 0 and 1),
  constraint employees_agg_morale_range check (morale between 0 and 1),
  constraint employees_agg_productivity_range check (productivity between 0 and 3),
  constraint employees_agg_unique unique (session_id, company_id, quarter, job_function)
);

comment on table public.employees_agg is
  'Workforce aggregated by function per quarter. Individually simulated people are characters (0010_people.sql); everyone else is a statistic.';

create index employees_agg_company_quarter_idx
  on public.employees_agg (company_id, quarter desc);

alter table public.employees_agg enable row level security;

-- ---------------------------------------------------------------------------
-- executives
-- ---------------------------------------------------------------------------

create table public.executives (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- FK added in 0010_people.sql (characters).
  character_id uuid not null,
  role public.executive_role not null,
  title text,
  appointed_quarter integer not null default 1,
  departed_quarter integer,
  is_active boolean not null default true,
  performance numeric not null default 0.5,
  loyalty numeric not null default 0.5,
  compensation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint executives_appointed_positive check (appointed_quarter >= 1),
  constraint executives_departure_after_appointment
    check (departed_quarter is null or departed_quarter >= appointed_quarter),
  constraint executives_active_has_no_departure
    check ((not is_active) or departed_quarter is null),
  constraint executives_performance_range check (performance between 0 and 1),
  constraint executives_loyalty_range check (loyalty between 0 and 1)
);

comment on table public.executives is
  'C-suite appointments. Who holds a role is public knowledge; their compensation, loyalty and performance scores are the company''s business.';
comment on column public.executives.character_id is
  'The person holding the role. Foreign key added in 0010_people.sql.';

create unique index executives_unique_active_role_idx
  on public.executives (company_id, role)
  where is_active;

create index executives_company_idx on public.executives (company_id);
create index executives_character_idx on public.executives (character_id);

alter table public.executives enable row level security;

-- ===========================================================================
-- 0008_government.sql — Frontier Capital
--
-- Procurement as a full strategic subsystem, not "government customer +$100m".
--
-- Opportunities publish an explicit evaluation weighting; bids are scored
-- deterministically against it (technical capability, security, past
-- performance, price/cost realism, schedule, domestic supply chain, responsible
-- AI). Winning is not automatically good: contracts carry compliance cost,
-- capacity commitments, IP concessions and overrun risk.
--
-- Connections help a player DISCOVER opportunities, obtain introductions and
-- join consortia. They never appear as a term in the award score.
-- ===========================================================================

create type public.contract_type as enum (
  'firm_fixed_price',
  'fixed_price_incentive',
  'cost_plus_fixed_fee',
  'cost_plus_incentive_fee',
  'time_and_materials',
  'idiq',
  'other_transaction'
);

create type public.opportunity_status as enum (
  'draft',
  'open',
  'evaluating',
  'awarded',
  'cancelled',
  'protested'
);

create type public.bid_role as enum ('prime', 'subcontractor', 'consortium_member');

create type public.bid_status as enum (
  'draft',
  'submitted',
  'clarification_requested',
  'shortlisted',
  'won',
  'lost',
  'withdrawn',
  'disqualified'
);

create type public.government_contract_status as enum (
  'active',
  'completed',
  'suspended',
  'terminated_for_convenience',
  'terminated_for_default',
  'disputed'
);

create type public.milestone_status as enum (
  'pending',
  'in_progress',
  'delivered',
  'late',
  'missed',
  'waived'
);

-- ---------------------------------------------------------------------------
-- agencies
-- ---------------------------------------------------------------------------

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  jurisdiction_id uuid references public.jurisdictions (id) on delete set null,
  code text not null,
  name text not null,
  mission text,
  kind text not null default 'civil',
  annual_budget_usd numeric not null default 0,
  procurement_budget_usd numeric not null default 0,
  urgency numeric not null default 0.5,
  strictness numeric not null default 0.5,
  security_sensitivity numeric not null default 0.5,
  preferred_contract_type public.contract_type not null default 'firm_fixed_price',
  priorities jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint agencies_code_format check (code ~ '^[A-Z0-9_]{2,16}$'),
  constraint agencies_kind_values
    check (kind in ('defence', 'civil', 'regulator', 'research', 'intelligence', 'health', 'energy')),
  constraint agencies_budgets_nonneg
    check (annual_budget_usd >= 0 and procurement_budget_usd >= 0),
  constraint agencies_scores_range check (
    urgency between 0 and 1
    and strictness between 0 and 1
    and security_sensitivity between 0 and 1
  ),
  constraint agencies_unique_code unique (session_id, code)
);

comment on table public.agencies is
  'Government buyers and regulators of the fictional jurisdiction. Each has its own budget, urgency and evaluation temperament.';

create index agencies_session_idx on public.agencies (session_id);

alter table public.agencies enable row level security;

-- ---------------------------------------------------------------------------
-- procurement_opportunities
-- ---------------------------------------------------------------------------

create table public.procurement_opportunities (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  agency_id uuid not null references public.agencies (id) on delete cascade,
  code text not null,
  title text not null,
  programme text,
  description text,
  max_value_usd numeric not null,
  contract_type public.contract_type not null,
  duration_quarters smallint not null default 8,
  evaluation_weights jsonb not null default '{}'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  allows_consortium boolean not null default true,
  allows_subcontracting boolean not null default true,
  min_past_performance numeric,
  opened_quarter integer not null,
  closes_quarter integer not null,
  award_quarter integer,
  status public.opportunity_status not null default 'open',
  visibility public.visibility_scope not null default 'public',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint procurement_opportunities_code_format check (code ~ '^[A-Z0-9_-]{3,32}$'),
  constraint procurement_opportunities_title_len check (char_length(title) between 1 and 200),
  constraint procurement_opportunities_value_positive check (max_value_usd > 0),
  constraint procurement_opportunities_duration_range check (duration_quarters between 1 and 40),
  constraint procurement_opportunities_window
    check (closes_quarter >= opened_quarter and opened_quarter >= 1),
  constraint procurement_opportunities_min_past_range
    check (min_past_performance is null or min_past_performance between 0 and 100),
  constraint procurement_opportunities_unique_code unique (session_id, code)
);

comment on table public.procurement_opportunities is
  'Published government programmes. The evaluation weighting is public up front, so bidding is a real strategic trade-off rather than a hidden dice roll.';
comment on column public.procurement_opportunities.evaluation_weights is
  'Scoring weights that must sum to 1, e.g. {"technical_capability":0.30,"security_reliability":0.20,"past_performance":0.15,"price_cost_realism":0.15,"delivery_schedule":0.10,"domestic_supply_chain":0.05,"responsible_ai":0.05}.';
comment on column public.procurement_opportunities.requirements is
  'Hard gates a bid must satisfy, e.g. {"security_clearance":"level_iv","domestic_inference":true,"model_audit":true,"uptime":0.9999,"data_sovereignty":true}.';

create index procurement_opportunities_agency_idx on public.procurement_opportunities (agency_id);
create index procurement_opportunities_session_status_idx
  on public.procurement_opportunities (session_id, status);

create trigger procurement_opportunities_set_updated_at
  before update on public.procurement_opportunities
  for each row execute function public.set_updated_at();

alter table public.procurement_opportunities enable row level security;

-- ---------------------------------------------------------------------------
-- government_bids
-- ---------------------------------------------------------------------------

create table public.government_bids (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  opportunity_id uuid not null references public.procurement_opportunities (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  role public.bid_role not null default 'prime',
  prime_bid_id uuid references public.government_bids (id) on delete cascade,
  consortium_label text,
  proposed_price_usd numeric not null default 0,
  proposed_cost_usd numeric,
  technical_approach jsonb not null default '{}'::jsonb,
  compute_commitment numeric not null default 0,
  staff_allocation integer not null default 0,
  delivery_quarters smallint not null default 8,
  security_commitments jsonb not null default '{}'::jsonb,
  ip_concessions jsonb not null default '{}'::jsonb,
  audit_rights jsonb not null default '{}'::jsonb,
  domestic_sourcing numeric not null default 0,
  scores jsonb not null default '{}'::jsonb,
  total_score numeric,
  cost_realism_penalty numeric not null default 0,
  status public.bid_status not null default 'draft',
  is_public boolean not null default false,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint government_bids_quarter_positive check (quarter >= 1),
  constraint government_bids_price_nonneg check (proposed_price_usd >= 0),
  constraint government_bids_cost_nonneg check (proposed_cost_usd is null or proposed_cost_usd >= 0),
  constraint government_bids_compute_nonneg check (compute_commitment >= 0),
  constraint government_bids_staff_nonneg check (staff_allocation >= 0),
  constraint government_bids_delivery_range check (delivery_quarters between 1 and 40),
  constraint government_bids_domestic_range check (domestic_sourcing between 0 and 1),
  constraint government_bids_score_range check (total_score is null or total_score between 0 and 100),
  constraint government_bids_penalty_nonneg check (cost_realism_penalty >= 0),
  constraint government_bids_no_self_prime check (prime_bid_id is null or prime_bid_id <> id),
  constraint government_bids_sub_requires_prime
    check (role = 'prime' or prime_bid_id is not null),
  constraint government_bids_unique unique (opportunity_id, company_id, role)
);

comment on table public.government_bids is
  'Proposals against an opportunity. A company may bid as prime, join a consortium or subcontract to another player''s prime bid.';
comment on column public.government_bids.scores is
  'Per-criterion scores the engine computed from the opportunity''s published weights. Released to the bidder after award so a loss is explainable.';
comment on column public.government_bids.cost_realism_penalty is
  'Deduction applied when a cost-reimbursement bid is priced below a realistic cost to perform.';

create index government_bids_opportunity_idx on public.government_bids (opportunity_id);
create index government_bids_company_idx on public.government_bids (company_id, quarter desc);
create index government_bids_prime_idx on public.government_bids (prime_bid_id);

create trigger government_bids_set_updated_at
  before update on public.government_bids
  for each row execute function public.set_updated_at();

alter table public.government_bids enable row level security;

-- ---------------------------------------------------------------------------
-- government_contracts
-- ---------------------------------------------------------------------------

create table public.government_contracts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  agency_id uuid not null references public.agencies (id) on delete cascade,
  opportunity_id uuid references public.procurement_opportunities (id) on delete set null,
  winning_bid_id uuid references public.government_bids (id) on delete set null,
  prime_company_id uuid not null references public.companies (id) on delete cascade,
  code text not null,
  title text not null,
  contract_type public.contract_type not null,
  ceiling_value_usd numeric not null,
  obligated_usd numeric not null default 0,
  invoiced_usd numeric not null default 0,
  expected_margin numeric,
  realised_margin numeric,
  start_quarter integer not null,
  end_quarter integer not null,
  awarded_quarter integer not null,
  status public.government_contract_status not null default 'active',
  compliance_cost_per_quarter_usd numeric not null default 0,
  capacity_commitment numeric not null default 0,
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint government_contracts_code_format check (code ~ '^[A-Z0-9_-]{3,32}$'),
  constraint government_contracts_ceiling_positive check (ceiling_value_usd > 0),
  constraint government_contracts_obligated_range
    check (obligated_usd >= 0 and obligated_usd <= ceiling_value_usd),
  constraint government_contracts_invoiced_nonneg check (invoiced_usd >= 0),
  constraint government_contracts_margin_range
    check (expected_margin is null or expected_margin between -1 and 1),
  constraint government_contracts_realised_margin_range
    check (realised_margin is null or realised_margin between -10 and 1),
  constraint government_contracts_window
    check (end_quarter >= start_quarter and start_quarter >= 1 and awarded_quarter >= 1),
  constraint government_contracts_compliance_nonneg
    check (compliance_cost_per_quarter_usd >= 0),
  constraint government_contracts_capacity_nonneg check (capacity_commitment >= 0),
  constraint government_contracts_unique_code unique (session_id, code)
);

comment on table public.government_contracts is
  'Awarded programmes. Backlog and credibility on one side; compliance expense, capacity commitment, IP constraints and overrun risk on the other.';

create index government_contracts_company_idx on public.government_contracts (prime_company_id);
create index government_contracts_agency_idx on public.government_contracts (agency_id);
create index government_contracts_session_status_idx
  on public.government_contracts (session_id, status);

create trigger government_contracts_set_updated_at
  before update on public.government_contracts
  for each row execute function public.set_updated_at();

alter table public.government_contracts enable row level security;

-- ---------------------------------------------------------------------------
-- contract_milestones
-- ---------------------------------------------------------------------------

create table public.contract_milestones (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  contract_id uuid not null references public.government_contracts (id) on delete cascade,
  -- Denormalised prime, so RLS can scope milestones without a join.
  company_id uuid not null references public.companies (id) on delete cascade,
  seq smallint not null,
  title text not null,
  description text,
  due_quarter integer not null,
  delivered_quarter integer,
  value_usd numeric not null default 0,
  penalty_usd numeric not null default 0,
  quality_score numeric,
  status public.milestone_status not null default 'pending',
  created_at timestamptz not null default now(),
  constraint contract_milestones_seq_positive check (seq >= 1),
  constraint contract_milestones_due_positive check (due_quarter >= 1),
  constraint contract_milestones_value_nonneg check (value_usd >= 0),
  constraint contract_milestones_penalty_nonneg check (penalty_usd >= 0),
  constraint contract_milestones_quality_range
    check (quality_score is null or quality_score between 0 and 1),
  constraint contract_milestones_delivered_requires_quarter
    check (status <> 'delivered' or delivered_quarter is not null),
  constraint contract_milestones_unique unique (contract_id, seq)
);

comment on table public.contract_milestones is
  'Deliverables. Missing one cascades: penalty, government reputation damage, risk-committee scrutiny, press coverage, share price and the next award.';

create index contract_milestones_contract_idx on public.contract_milestones (contract_id, seq);
create index contract_milestones_company_idx on public.contract_milestones (company_id);

alter table public.contract_milestones enable row level security;

-- ---------------------------------------------------------------------------
-- contractor_reputation
-- ---------------------------------------------------------------------------

create table public.contractor_reputation (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- NULL means the government-wide score; a value scopes it to one agency.
  agency_id uuid references public.agencies (id) on delete cascade,
  quarter integer not null,
  past_performance numeric not null default 50,
  rating text not null default 'BBB',
  on_time_rate numeric,
  cost_variance numeric,
  quality_index numeric,
  incidents smallint not null default 0,
  clearance_level text,
  notes text,
  created_at timestamptz not null default now(),
  constraint contractor_reputation_quarter_positive check (quarter >= 1),
  constraint contractor_reputation_past_performance_range
    check (past_performance between 0 and 100),
  constraint contractor_reputation_rating_values check (
    rating in ('AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB', 'BB', 'B', 'CCC', 'D')
  ),
  constraint contractor_reputation_on_time_range
    check (on_time_rate is null or on_time_rate between 0 and 1),
  constraint contractor_reputation_quality_range
    check (quality_index is null or quality_index between 0 and 1),
  constraint contractor_reputation_incidents_nonneg check (incidents >= 0),
  constraint contractor_reputation_clearance_values check (
    clearance_level is null
    or clearance_level in ('none', 'level_i', 'level_ii', 'level_iii', 'level_iv', 'level_v')
  )
);

comment on table public.contractor_reputation is
  'Past-performance record, the memory that makes a failed programme cost more than one quarter of revenue. Public by design: it is an evaluation input every bidder can see.';

create unique index contractor_reputation_unique_idx
  on public.contractor_reputation (session_id, company_id, agency_id, quarter)
  nulls not distinct;

create index contractor_reputation_company_idx
  on public.contractor_reputation (company_id, quarter desc);

alter table public.contractor_reputation enable row level security;

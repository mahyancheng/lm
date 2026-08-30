-- ===========================================================================
-- 0005_ownership.sql — Frontier Capital
--
-- Cap tables. Ownership and control are separate: a founder can own 24% and
-- not be CEO; an investor can hold 12% and control the board.
--
-- Invariant (enforced by the engine before a quarter commits, and supported by
-- the CHECK constraints here): sum(holdings.shares) for a share class must
-- reconcile to share_classes.issued_shares, and no quantity may go negative.
-- ===========================================================================

create type public.security_kind as enum (
  'common_equity',
  'preferred_equity',
  'option',
  'warrant',
  'convertible_note',
  'safe',
  'bond',
  'index_unit'
);

create type public.holder_kind as enum (
  'player',
  'character',
  'company',
  'institution',
  'government',
  'public_float',
  'employee_pool',
  'treasury'
);

create type public.transaction_kind as enum (
  'share_issue',
  'share_purchase',
  'share_sale',
  'secondary_transfer',
  'buyback',
  'dividend',
  'option_grant',
  'option_exercise',
  'debt_draw',
  'debt_repayment',
  'acquisition_consideration',
  'conversion'
);

create type public.funding_round_type as enum (
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'series_d',
  'series_e',
  'growth',
  'bridge',
  'venture_debt',
  'corporate_debt',
  'ipo',
  'follow_on',
  'secondary',
  'pipe'
);

create type public.funding_round_status as enum (
  'proposed',
  'marketing',
  'committed',
  'closed',
  'failed',
  'withdrawn'
);

-- ---------------------------------------------------------------------------
-- share_classes
-- ---------------------------------------------------------------------------

create table public.share_classes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null,
  name text not null,
  votes_per_share numeric not null default 1,
  liquidation_preference numeric not null default 1,
  is_super_voting boolean not null default false,
  is_participating boolean not null default false,
  seniority smallint not null default 0,
  authorized_shares numeric not null default 0,
  issued_shares numeric not null default 0,
  par_value_usd numeric not null default 0,
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint share_classes_code_format check (code ~ '^[a-z0-9_]{2,32}$'),
  constraint share_classes_votes_nonneg check (votes_per_share >= 0),
  constraint share_classes_pref_nonneg check (liquidation_preference >= 0),
  constraint share_classes_authorized_nonneg check (authorized_shares >= 0),
  constraint share_classes_issued_nonneg check (issued_shares >= 0),
  constraint share_classes_issued_within_authorized check (issued_shares <= authorized_shares),
  constraint share_classes_par_nonneg check (par_value_usd >= 0),
  constraint share_classes_unique_code unique (session_id, company_id, code)
);

comment on table public.share_classes is
  'Share classes of a company. Founder super-voting stock, preferred stacks and employee pools are all modelled here; control is votes, not percentage.';
comment on column public.share_classes.issued_shares is
  'Authoritative issued count. sum(holdings.shares) over the class must reconcile to this before a quarter commits.';

create index share_classes_company_idx on public.share_classes (company_id);

alter table public.share_classes enable row level security;

-- ---------------------------------------------------------------------------
-- securities
-- ---------------------------------------------------------------------------

create table public.securities (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  share_class_id uuid references public.share_classes (id) on delete cascade,
  kind public.security_kind not null,
  symbol text,
  name text not null,
  is_listed boolean not null default false,
  listed_quarter integer,
  currency text not null default 'USD',
  face_value_usd numeric,
  coupon_rate numeric,
  maturity_quarter integer,
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint securities_symbol_format check (symbol is null or symbol ~ '^[A-Z0-9.]{2,12}$'),
  constraint securities_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint securities_face_value_nonneg check (face_value_usd is null or face_value_usd >= 0),
  constraint securities_coupon_range check (coupon_rate is null or coupon_rate between -1 and 1),
  constraint securities_listed_requires_symbol check ((not is_listed) or symbol is not null),
  constraint securities_equity_requires_class
    check (kind not in ('common_equity', 'preferred_equity') or share_class_id is not null)
);

comment on table public.securities is
  'Tradeable instruments issued by in-world companies. These are virtual securities only: no real-money transaction, conversion or cash-out exists anywhere in the game.';

create unique index securities_unique_symbol_idx
  on public.securities (session_id, symbol)
  where symbol is not null;
create index securities_company_idx on public.securities (company_id);
create index securities_share_class_idx on public.securities (share_class_id);

alter table public.securities enable row level security;

-- ---------------------------------------------------------------------------
-- holdings
-- ---------------------------------------------------------------------------

create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  security_id uuid not null references public.securities (id) on delete cascade,
  -- Denormalised issuer, so RLS can answer "is this my company's cap table?"
  -- without a join.
  company_id uuid references public.companies (id) on delete cascade,
  holder_kind public.holder_kind not null,
  holder_player_id uuid references public.session_players (id) on delete set null,
  -- FK added in 0010_people.sql (characters).
  holder_character_id uuid,
  holder_company_id uuid references public.companies (id) on delete set null,
  holder_institution text,
  shares numeric not null default 0,
  cost_basis_usd numeric not null default 0,
  acquired_quarter integer,
  locked_until_quarter integer,
  -- Set by the engine when the position crosses the session's public
  -- disclosure threshold (5% of a listed class). Only then is it readable by
  -- other players.
  is_disclosed boolean not null default false,
  disclosed_quarter integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint holdings_shares_nonneg check (shares >= 0),
  constraint holdings_cost_basis_nonneg check (cost_basis_usd >= 0),
  constraint holdings_exactly_one_holder check (
    (case when holder_player_id is not null then 1 else 0 end)
    + (case when holder_character_id is not null then 1 else 0 end)
    + (case when holder_company_id is not null then 1 else 0 end)
    + (case when holder_institution is not null then 1 else 0 end)
    = 1
  ),
  constraint holdings_disclosed_requires_quarter
    check ((not is_disclosed) or disclosed_quarter is not null)
);

comment on table public.holdings is
  'Positions in a security. Exactly one holder reference is set per row. Ownership thresholds (1%, 5%, 10%, 25%, 50%) drive disclosure, board pressure and control.';
comment on column public.holdings.is_disclosed is
  'True once the engine has published the position (crossing the significant-holder threshold). Undisclosed positions are private to the holder and the issuer.';

-- One row per (security, holder). NULLS NOT DISTINCT (PostgreSQL 15+) makes the
-- three unused holder columns collapse correctly.
create unique index holdings_unique_holder_idx
  on public.holdings (
    security_id,
    holder_player_id,
    holder_character_id,
    holder_company_id,
    holder_institution
  )
  nulls not distinct;

create index holdings_session_idx on public.holdings (session_id);
create index holdings_security_idx on public.holdings (security_id);
create index holdings_company_idx on public.holdings (company_id);
create index holdings_player_idx on public.holdings (holder_player_id);
create index holdings_holder_company_idx on public.holdings (holder_company_id);

create trigger holdings_set_updated_at
  before update on public.holdings
  for each row execute function public.set_updated_at();

alter table public.holdings enable row level security;

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  kind public.transaction_kind not null,
  security_id uuid references public.securities (id) on delete set null,
  company_id uuid references public.companies (id) on delete cascade,
  from_holding_id uuid references public.holdings (id) on delete set null,
  to_holding_id uuid references public.holdings (id) on delete set null,
  from_player_id uuid references public.session_players (id) on delete set null,
  to_player_id uuid references public.session_players (id) on delete set null,
  counterparty_label text,
  shares numeric not null default 0,
  price_per_share_usd numeric not null default 0,
  cash_usd numeric not null default 0,
  fees_usd numeric not null default 0,
  is_public_record boolean not null default false,
  -- FK added in 0014_simulation.sql (sim_events).
  sim_event_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint transactions_quarter_positive check (quarter >= 1),
  constraint transactions_shares_nonneg check (shares >= 0),
  constraint transactions_price_nonneg check (price_per_share_usd >= 0),
  constraint transactions_fees_nonneg check (fees_usd >= 0)
);

comment on table public.transactions is
  'Every ownership or capital movement. Each row pairs with an append-only sim_event, so "why do I own this / where did the cash go" is always answerable from the ledger.';
comment on column public.transactions.is_public_record is
  'True for transactions that enter the public information set (listed-market trades, announced financings, 13D-style disclosures).';

create index transactions_session_quarter_idx on public.transactions (session_id, quarter desc);
create index transactions_company_idx on public.transactions (company_id, quarter desc);
create index transactions_security_idx on public.transactions (security_id);

alter table public.transactions enable row level security;

-- ---------------------------------------------------------------------------
-- funding_rounds
-- ---------------------------------------------------------------------------

create table public.funding_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  round_type public.funding_round_type not null,
  status public.funding_round_status not null default 'proposed',
  target_amount_usd numeric not null default 0,
  amount_usd numeric not null default 0,
  pre_money_usd numeric,
  post_money_usd numeric,
  price_per_share_usd numeric,
  dilution numeric,
  share_class_id uuid references public.share_classes (id) on delete set null,
  lead_investor text,
  investors jsonb not null default '[]'::jsonb,
  board_seats_granted smallint not null default 0,
  terms jsonb not null default '{}'::jsonb,
  is_announced boolean not null default false,
  opened_quarter integer,
  closed_quarter integer,
  created_at timestamptz not null default now(),
  constraint funding_rounds_quarter_positive check (quarter >= 1),
  constraint funding_rounds_target_nonneg check (target_amount_usd >= 0),
  constraint funding_rounds_amount_nonneg check (amount_usd >= 0),
  constraint funding_rounds_pre_money_nonneg check (pre_money_usd is null or pre_money_usd >= 0),
  constraint funding_rounds_post_money_nonneg check (post_money_usd is null or post_money_usd >= 0),
  constraint funding_rounds_price_nonneg
    check (price_per_share_usd is null or price_per_share_usd >= 0),
  constraint funding_rounds_dilution_range check (dilution is null or dilution between 0 and 1),
  constraint funding_rounds_seats_nonneg check (board_seats_granted >= 0),
  constraint funding_rounds_closed_requires_quarter
    check (status <> 'closed' or closed_quarter is not null)
);

comment on table public.funding_rounds is
  'Private financings, debt raises, IPOs and secondaries. Dilution here is what separates "my company is worth more" from "I own less of it".';

create index funding_rounds_company_idx on public.funding_rounds (company_id, quarter desc);
create index funding_rounds_session_status_idx on public.funding_rounds (session_id, status);

alter table public.funding_rounds enable row level security;

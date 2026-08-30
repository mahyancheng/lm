-- ===========================================================================
-- 0007_markets.sql — Frontier Capital
--
-- Two market planes:
--   * the Live Reference Market — read-only real-world instruments supplied by
--     a licensed market-data adapter (is_reference = true). The World Director
--     may never alter these; that price belongs to reality.
--   * the In-World Exchange — fully simulated virtual securities. No real-money
--     transaction, conversion or cash-out exists.
--
-- Markets price beliefs, not the database. market_quotes is driven by the
-- public information set (public_disclosures, social/media propagation) plus
-- sector sentiment and a fundamental anchor — never by private truth.
--
-- Quarterly return model:
--   r = beta_m*M + beta_s*S + alpha_fundamental + E_public + N_sentiment
--       + L_liquidity + sigma*eps          and   P_{t+1} = P_t * exp(r)
-- Each term is stored in market_quotes.return_decomposition, which is what the
-- "why did my stock fall?" screen reads.
-- ===========================================================================

create type public.instrument_kind as enum (
  'equity',
  'index',
  'commodity',
  'rate',
  'fx',
  'bond',
  'fund'
);

create type public.belief_holder as enum (
  'market',
  'sell_side_analyst',
  'institutional',
  'retail',
  'media',
  'regulator'
);

create type public.disclosure_kind as enum (
  'earnings',
  'guidance',
  'press_release',
  'regulatory_filing',
  'product_launch',
  'ownership_disclosure',
  'incident_report',
  'denial',
  'ma_announcement',
  'contract_award',
  'research_publication'
);

-- ---------------------------------------------------------------------------
-- market_instruments
-- ---------------------------------------------------------------------------

create table public.market_instruments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  kind public.instrument_kind not null,
  symbol text not null,
  name text not null,
  company_id uuid references public.companies (id) on delete cascade,
  security_id uuid references public.securities (id) on delete set null,
  is_reference boolean not null default false,
  sector text,
  currency text not null default 'USD',
  beta_market numeric not null default 1,
  beta_sector numeric not null default 1,
  idiosyncratic_vol numeric not null default 0.12,
  shares_outstanding numeric,
  free_float numeric,
  listed_quarter integer,
  delisted_quarter integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint market_instruments_symbol_format check (symbol ~ '^[A-Z0-9.^-]{1,16}$'),
  constraint market_instruments_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint market_instruments_vol_range check (idiosyncratic_vol between 0 and 2),
  constraint market_instruments_shares_nonneg
    check (shares_outstanding is null or shares_outstanding >= 0),
  constraint market_instruments_float_range check (free_float is null or free_float between 0 and 1),
  constraint market_instruments_reference_has_no_company
    check ((not is_reference) or company_id is null),
  constraint market_instruments_unique_symbol unique (session_id, symbol)
);

comment on table public.market_instruments is
  'Everything quotable in a session. is_reference = true marks read-only real-world tape delivered by the market-data adapter; everything else is a virtual in-world security.';
comment on column public.market_instruments.is_reference is
  'Reference instruments are never modified by the simulation. Session start may calibrate the world from them; after that the in-world causality branches.';

create index market_instruments_session_idx on public.market_instruments (session_id);
create index market_instruments_company_idx on public.market_instruments (company_id);

alter table public.market_instruments enable row level security;

-- ---------------------------------------------------------------------------
-- market_quotes
-- ---------------------------------------------------------------------------

create table public.market_quotes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  instrument_id uuid not null references public.market_instruments (id) on delete cascade,
  quarter integer not null,
  price numeric not null,
  previous_price numeric,
  log_return numeric,
  return_pct numeric,
  volume numeric not null default 0,
  market_cap_usd numeric,
  fundamental_value numeric,
  premium_to_fundamental numeric,
  return_decomposition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint market_quotes_quarter_positive check (quarter >= 1),
  -- Market integrity invariant: no negative or zero virtual prices, ever.
  constraint market_quotes_price_positive check (price > 0),
  constraint market_quotes_previous_price_positive
    check (previous_price is null or previous_price > 0),
  constraint market_quotes_volume_nonneg check (volume >= 0),
  constraint market_quotes_market_cap_nonneg check (market_cap_usd is null or market_cap_usd >= 0),
  constraint market_quotes_fundamental_nonneg
    check (fundamental_value is null or fundamental_value >= 0),
  constraint market_quotes_unique unique (session_id, instrument_id, quarter)
);

comment on table public.market_quotes is
  'One committed quote per instrument per quarter. price > 0 is a hard invariant: no negative or NaN virtual security price may ever be written.';
comment on column public.market_quotes.return_decomposition is
  'Attribution of the quarter''s move: {"beta_market":…, "beta_sector":…, "alpha_fundamental":…, "public_information":…, "sentiment":…, "liquidity":…, "idiosyncratic":…}. The Quarter Resolution screen explains facts from this, it does not ask a model to invent them.';

create index market_quotes_instrument_quarter_idx
  on public.market_quotes (instrument_id, quarter desc);
create index market_quotes_session_quarter_idx
  on public.market_quotes (session_id, quarter desc);

alter table public.market_quotes enable row level security;

-- ---------------------------------------------------------------------------
-- market_trades
-- ---------------------------------------------------------------------------

create table public.market_trades (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  instrument_id uuid not null references public.market_instruments (id) on delete cascade,
  quarter integer not null,
  buyer_player_id uuid references public.session_players (id) on delete set null,
  buyer_company_id uuid references public.companies (id) on delete set null,
  seller_player_id uuid references public.session_players (id) on delete set null,
  seller_company_id uuid references public.companies (id) on delete set null,
  counterparty_label text,
  shares numeric not null,
  price numeric not null,
  notional_usd numeric not null default 0,
  slippage numeric not null default 0,
  transaction_id uuid references public.transactions (id) on delete set null,
  is_public_record boolean not null default true,
  created_at timestamptz not null default now(),
  constraint market_trades_quarter_positive check (quarter >= 1),
  constraint market_trades_shares_positive check (shares > 0),
  constraint market_trades_price_positive check (price > 0),
  constraint market_trades_notional_nonneg check (notional_usd >= 0)
);

comment on table public.market_trades is
  'Executed fills on the in-world exchange. Aggregated into market_quotes.volume and into the liquidity term of the return decomposition.';

create index market_trades_instrument_quarter_idx
  on public.market_trades (instrument_id, quarter desc);
create index market_trades_session_quarter_idx on public.market_trades (session_id, quarter desc);

alter table public.market_trades enable row level security;

-- ---------------------------------------------------------------------------
-- market_beliefs
-- ---------------------------------------------------------------------------

create table public.market_beliefs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  instrument_id uuid references public.market_instruments (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  held_by public.belief_holder not null default 'market',
  topic text not null,
  claim text not null,
  probability numeric not null default 0.5,
  confidence numeric not null default 0.5,
  price_impact numeric not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  source_disclosure_id uuid,
  source_post_id uuid,
  decays_after_quarter integer,
  created_at timestamptz not null default now(),
  constraint market_beliefs_quarter_positive check (quarter >= 1),
  constraint market_beliefs_probability_range check (probability between 0 and 1),
  constraint market_beliefs_confidence_range check (confidence between 0 and 1),
  constraint market_beliefs_topic_len check (char_length(topic) between 1 and 120),
  constraint market_beliefs_has_subject
    check (instrument_id is not null or company_id is not null)
);

comment on table public.market_beliefs is
  'What market participants believe, which is what the price actually reflects. Canonical private reality lives in world_snapshots and company_quarter_metrics; the gap between them is where earnings surprises, leaks, rumours and short theses come from.';
comment on column public.market_beliefs.source_post_id is
  'Originating social post, when the belief came from a rumour. Foreign key added in 0011_social.sql.';

create index market_beliefs_session_quarter_idx on public.market_beliefs (session_id, quarter desc);
create index market_beliefs_company_idx on public.market_beliefs (company_id, quarter desc);
create index market_beliefs_instrument_idx on public.market_beliefs (instrument_id, quarter desc);

alter table public.market_beliefs enable row level security;

-- ---------------------------------------------------------------------------
-- public_disclosures
-- ---------------------------------------------------------------------------

create table public.public_disclosures (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  kind public.disclosure_kind not null,
  headline text not null,
  body text,
  figures jsonb not null default '{}'::jsonb,
  is_material boolean not null default false,
  is_mandatory boolean not null default false,
  credibility_weight numeric not null default 1,
  issued_by_player_id uuid references public.session_players (id) on delete set null,
  issued_by_character_id uuid,
  created_at timestamptz not null default now(),
  constraint public_disclosures_quarter_positive check (quarter >= 1),
  constraint public_disclosures_headline_len check (char_length(headline) between 1 and 240),
  constraint public_disclosures_credibility_range check (credibility_weight between 0 and 2)
);

comment on table public.public_disclosures is
  'THE public information set. Everything a company tells the world: earnings, guidance, filings, launches, ownership disclosures, denials. Readable by every session member by construction — that is the point of the table.';
comment on column public.public_disclosures.credibility_weight is
  'How much the market discounts this issuer right now. A CEO caught issuing a misleading denial loses weight here for several quarters. Whether a disclosure was actually true is recorded privately in sim_events, never in this table.';

create index public_disclosures_company_quarter_idx
  on public.public_disclosures (company_id, quarter desc);
create index public_disclosures_session_quarter_idx
  on public.public_disclosures (session_id, quarter desc);

alter table public.public_disclosures enable row level security;

alter table public.market_beliefs
  add constraint market_beliefs_source_disclosure_id_fkey
  foreign key (source_disclosure_id) references public.public_disclosures (id) on delete set null;

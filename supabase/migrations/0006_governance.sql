-- ===========================================================================
-- 0006_governance.sql — Frontier Capital
--
-- Boards, votes and machine-readable commitments.
--
-- Dialogue never changes a director's support score. A conversation can only
-- produce a structured, conditional commitment (commitments) that the engine
-- evaluates against the actual proposal at vote time. That is what makes
-- negotiation matter without letting free text write state.
-- ===========================================================================

create type public.board_seat_kind as enum (
  'founder',
  'executive',
  'investor',
  'independent',
  'employee',
  'observer'
);

create type public.board_matter as enum (
  'annual_strategic_plan',
  'operating_budget',
  'financing',
  'acquisition',
  'divestiture',
  'ceo_compensation',
  'executive_appointment',
  'buyback',
  'dividend',
  'ipo',
  'major_government_contract',
  'major_model_release',
  'emergency_restructuring',
  'ceo_dismissal',
  'bylaw_change',
  'related_party_transaction'
);

create type public.board_proposal_status as enum (
  'draft',
  'tabled',
  'voting',
  'approved',
  'rejected',
  'withdrawn',
  'deferred'
);

create type public.board_vote_value as enum ('for', 'against', 'abstain', 'absent', 'recused');

create type public.commitment_status as enum (
  'open',
  'honoured',
  'broken',
  'expired',
  'void',
  'superseded'
);

create type public.shareholder_proposal_status as enum (
  'filed',
  'accepted',
  'rejected',
  'withdrawn',
  'voted'
);

-- ---------------------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------------------

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  seats_total smallint not null default 5,
  quorum_rule text not null default 'majority',
  decision_rule text not null default 'majority_of_quorum',
  chair_seat_id uuid,
  charter jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint boards_seats_range check (seats_total between 1 and 21),
  constraint boards_quorum_values check (quorum_rule in ('majority', 'two_thirds', 'all')),
  constraint boards_decision_values
    check (decision_rule in ('majority_of_quorum', 'majority_of_board', 'supermajority')),
  constraint boards_unique_company unique (session_id, company_id)
);

comment on table public.boards is
  'One board per company. Default governance mirrors the simplified fictional rule set: a majority of directors is a quorum and a majority of those present is the act of the board.';

alter table public.boards enable row level security;

-- ---------------------------------------------------------------------------
-- board_seats
-- ---------------------------------------------------------------------------

create table public.board_seats (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- FK added in 0010_people.sql (characters).
  character_id uuid,
  player_id uuid references public.session_players (id) on delete set null,
  seat_kind public.board_seat_kind not null default 'independent',
  seat_no smallint not null,
  constituency text,
  is_chair boolean not null default false,
  voting_power numeric not null default 1,
  independence numeric not null default 0.5,
  risk_tolerance numeric not null default 0.5,
  growth_preference numeric not null default 0.5,
  financial_discipline numeric not null default 0.5,
  technology_knowledge numeric not null default 0.5,
  safety_orientation numeric not null default 0.5,
  appointed_quarter integer not null default 1,
  vacated_quarter integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint board_seats_seat_no_range check (seat_no between 1 and 21),
  constraint board_seats_voting_power_nonneg check (voting_power >= 0),
  constraint board_seats_scores_range check (
    independence between 0 and 1
    and risk_tolerance between 0 and 1
    and growth_preference between 0 and 1
    and financial_discipline between 0 and 1
    and technology_knowledge between 0 and 1
    and safety_orientation between 0 and 1
  ),
  constraint board_seats_appointed_positive check (appointed_quarter >= 1),
  constraint board_seats_vacated_after_appointed
    check (vacated_quarter is null or vacated_quarter >= appointed_quarter),
  constraint board_seats_active_not_vacated check ((not is_active) or vacated_quarter is null),
  constraint board_seats_occupied check (character_id is not null or player_id is not null)
);

comment on table public.board_seats is
  'Directors. Their stable dispositions (independence, risk tolerance, financial discipline, technology knowledge, safety orientation) are what board LLM dialogue reads and what the engine scores votes with.';
comment on column public.board_seats.constituency is
  'Whose mandate the director carries (lead investor, employees, an acquirer, the public). Factions matter more than headcount.';

create unique index board_seats_unique_seat_no_idx
  on public.board_seats (board_id, seat_no)
  where is_active;
create unique index board_seats_unique_chair_idx
  on public.board_seats (board_id)
  where is_chair and is_active;

create index board_seats_board_idx on public.board_seats (board_id);
create index board_seats_character_idx on public.board_seats (character_id);
create index board_seats_player_idx on public.board_seats (player_id);

alter table public.board_seats enable row level security;

alter table public.boards
  add constraint boards_chair_seat_id_fkey
  foreign key (chair_seat_id) references public.board_seats (id) on delete set null;

-- ---------------------------------------------------------------------------
-- board_proposals
-- ---------------------------------------------------------------------------

create table public.board_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  matter public.board_matter not null,
  title text not null,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  proposed_by_seat_id uuid references public.board_seats (id) on delete set null,
  proposed_by_player_id uuid references public.session_players (id) on delete set null,
  status public.board_proposal_status not null default 'draft',
  requires_supermajority boolean not null default false,
  votes_for smallint not null default 0,
  votes_against smallint not null default 0,
  votes_abstain smallint not null default 0,
  votes_absent smallint not null default 0,
  decided_quarter integer,
  outcome_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint board_proposals_quarter_positive check (quarter >= 1),
  constraint board_proposals_title_len check (char_length(title) between 1 and 200),
  constraint board_proposals_vote_counts_nonneg check (
    votes_for >= 0 and votes_against >= 0 and votes_abstain >= 0 and votes_absent >= 0
  ),
  constraint board_proposals_decided_requires_quarter
    check (status not in ('approved', 'rejected') or decided_quarter is not null)
);

comment on table public.board_proposals is
  'Matters requiring board approval: budgets, financing, M&A, compensation, IPO, major contracts, model releases, restructuring and CEO dismissal.';

create index board_proposals_board_quarter_idx
  on public.board_proposals (board_id, quarter desc);
create index board_proposals_session_status_idx
  on public.board_proposals (session_id, status);

create trigger board_proposals_set_updated_at
  before update on public.board_proposals
  for each row execute function public.set_updated_at();

alter table public.board_proposals enable row level security;

-- ---------------------------------------------------------------------------
-- board_votes
-- ---------------------------------------------------------------------------

create table public.board_votes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  proposal_id uuid not null references public.board_proposals (id) on delete cascade,
  seat_id uuid not null references public.board_seats (id) on delete cascade,
  vote public.board_vote_value not null,
  support_score numeric not null default 0.5,
  weight numeric not null default 1,
  rationale text,
  commitment_id uuid,
  agent_run_id uuid,
  created_at timestamptz not null default now(),
  constraint board_votes_support_range check (support_score between 0 and 1),
  constraint board_votes_weight_nonneg check (weight >= 0),
  constraint board_votes_unique unique (proposal_id, seat_id)
);

comment on table public.board_votes is
  'One vote per seat per proposal. support_score is engine state derived from the director''s dispositions, relationships and any honoured commitment; the rationale text is narration on top of it.';
comment on column public.board_votes.commitment_id is
  'The conditional commitment that decided this vote, if any. Foreign key added below.';

create index board_votes_proposal_idx on public.board_votes (proposal_id);
create index board_votes_seat_idx on public.board_votes (seat_id);

alter table public.board_votes enable row level security;

-- ---------------------------------------------------------------------------
-- shareholder_proposals
-- ---------------------------------------------------------------------------

create table public.shareholder_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  quarter integer not null,
  filed_by_player_id uuid references public.session_players (id) on delete set null,
  filed_by_holder_label text,
  title text not null,
  body text,
  demand jsonb not null default '{}'::jsonb,
  ownership_percent numeric,
  status public.shareholder_proposal_status not null default 'filed',
  votes_for_shares numeric not null default 0,
  votes_against_shares numeric not null default 0,
  decided_quarter integer,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  constraint shareholder_proposals_quarter_positive check (quarter >= 1),
  constraint shareholder_proposals_title_len check (char_length(title) between 1 and 200),
  constraint shareholder_proposals_ownership_range
    check (ownership_percent is null or ownership_percent between 0 and 1),
  constraint shareholder_proposals_votes_nonneg
    check (votes_for_shares >= 0 and votes_against_shares >= 0)
);

comment on table public.shareholder_proposals is
  'Activist and proxy campaigns filed by holders rather than directors. The route back to control for a founder who was dismissed but still owns a bloc.';

create index shareholder_proposals_company_idx
  on public.shareholder_proposals (company_id, quarter desc);

alter table public.shareholder_proposals enable row level security;

-- ---------------------------------------------------------------------------
-- commitments
-- ---------------------------------------------------------------------------

create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  -- Who made the promise.
  actor_player_id uuid references public.session_players (id) on delete set null,
  -- FK added in 0010_people.sql (characters).
  actor_character_id uuid,
  -- Who it was made to.
  beneficiary_player_id uuid references public.session_players (id) on delete set null,
  beneficiary_character_id uuid,
  company_id uuid references public.companies (id) on delete cascade,
  subject text not null,
  board_proposal_id uuid references public.board_proposals (id) on delete cascade,
  -- FK added in 0012_conversation.sql (deal_proposals).
  deal_proposal_id uuid,
  conditions jsonb not null default '{}'::jsonb,
  commitment_strength numeric not null default 0.5,
  is_binding boolean not null default false,
  expires_after_quarter integer,
  status public.commitment_status not null default 'open',
  resolved_quarter integer,
  resolution_note text,
  created_at timestamptz not null default now(),
  constraint commitments_quarter_positive check (quarter >= 1),
  constraint commitments_strength_range check (commitment_strength between 0 and 1),
  constraint commitments_expiry_after_quarter
    check (expires_after_quarter is null or expires_after_quarter >= quarter),
  constraint commitments_has_actor
    check (actor_player_id is not null or actor_character_id is not null),
  constraint commitments_subject_len check (char_length(subject) between 1 and 120)
);

comment on table public.commitments is
  'Machine-readable conditional promises produced by conversation, e.g. "support the acquisition if price <= $5.5B and stock component >= 35%". Non-binding statements are recorded with is_binding false and never enforced: that is what makes bluffing possible.';
comment on column public.commitments.conditions is
  'Structured conditions the engine evaluates against the actual proposal, e.g. {"maximum_purchase_price": 5500000000, "minimum_stock_component": 0.35}.';
comment on column public.commitments.expires_after_quarter is
  'Last quarter in which the commitment can be relied upon. The resolver expires stale commitments before board votes are scored.';

create index commitments_session_quarter_idx on public.commitments (session_id, quarter desc);
create index commitments_actor_player_idx on public.commitments (actor_player_id);
create index commitments_actor_character_idx on public.commitments (actor_character_id);
create index commitments_board_proposal_idx on public.commitments (board_proposal_id);
create index commitments_company_idx on public.commitments (company_id);

alter table public.commitments enable row level security;

alter table public.board_votes
  add constraint board_votes_commitment_id_fkey
  foreign key (commitment_id) references public.commitments (id) on delete set null;

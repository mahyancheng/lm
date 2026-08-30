-- ===========================================================================
-- 0012_conversation.sql — Frontier Capital
--
-- Player and character communication, and the structured deals that come out
-- of it.
--
-- Hard product rules encoded here:
--   * Every message is account-bound. A message is sent either by a profile
--     (a real player) or by an NPC character that is explicitly labelled as
--     AI-generated. There are no anonymous senders and no random chat.
--   * Conversations are purposeful and connection-gated: participation is
--     explicit rows in conversation_participants, and RLS reads that table.
--   * Free text never writes state. A conversation can only produce a
--     deal_proposal, which the counterparty must accept before it enters the
--     ledger. Non-binding language stays non-binding, so bluffing works.
--   * Report and block are first-class, not an afterthought.
-- ===========================================================================

create type public.conversation_kind as enum (
  'direct',
  'group',
  'board',
  'deal_room',
  'consortium',
  'npc',
  'press',
  'system'
);

create type public.conversation_status as enum ('open', 'closed', 'archived');

create type public.participant_role as enum ('owner', 'member', 'observer');

create type public.message_kind as enum ('text', 'system', 'deal_reference', 'disclosure');

create type public.moderation_status as enum ('visible', 'flagged', 'hidden', 'removed');

create type public.deal_status as enum (
  'draft',
  'proposed',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
  'executed',
  'breached'
);

create type public.report_reason as enum (
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'spam',
  'fraud',
  'impersonation',
  'other'
);

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  kind public.conversation_kind not null default 'direct',
  title text,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_character_id uuid references public.characters (id) on delete set null,
  -- Why this conversation was allowed to exist despite the connection gap.
  access_reason text,
  status public.conversation_status not null default 'open',
  is_npc_thread boolean not null default false,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_title_len check (title is null or char_length(title) <= 160),
  constraint conversations_access_reason_values check (
    access_reason is null
    or access_reason in (
      'within_connection_range', 'downward_initiation', 'introduction',
      'shared_board', 'shared_investor', 'consortium', 'acquisition_talks',
      'conference', 'legal_proceeding', 'media', 'system'
    )
  ),
  constraint conversations_has_creator
    check (created_by is not null or created_by_character_id is not null),
  -- Target of the composite foreign keys below: participants and messages must
  -- carry the SAME session_id as their conversation, so a client cannot insert
  -- a message into a conversation while claiming a different session.
  constraint conversations_id_session_unique unique (id, session_id)
);

comment on table public.conversations is
  'A purposeful thread. Creation is gated by the connection rule: within a gap of 10 either party may initiate, above that only the higher-connection actor may initiate downward unless an access override applies.';
comment on column public.conversations.access_reason is
  'The specific rule or override that authorised this thread. Recorded so access is auditable rather than implicit.';

create index conversations_session_idx on public.conversations (session_id);
create index conversations_last_message_idx on public.conversations (session_id, last_message_at desc);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;

-- ---------------------------------------------------------------------------
-- conversation_participants
-- ---------------------------------------------------------------------------

create table public.conversation_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete cascade,
  character_id uuid references public.characters (id) on delete cascade,
  player_id uuid references public.session_players (id) on delete set null,
  role public.participant_role not null default 'member',
  is_npc boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint conversation_participants_exactly_one_identity check (
    (case when profile_id is not null then 1 else 0 end)
    + (case when character_id is not null then 1 else 0 end)
    = 1
  ),
  constraint conversation_participants_npc_is_character
    check (is_npc = (character_id is not null)),
  constraint conversation_participants_conversation_session_fkey
    foreign key (conversation_id, session_id)
    references public.conversations (id, session_id) on delete cascade
);

comment on table public.conversation_participants is
  'Membership. This table IS the authorisation for both the message rows and the Realtime broadcast channel session:{session_id}:conversation:{conversation_id}.';

create unique index conversation_participants_unique_idx
  on public.conversation_participants (conversation_id, profile_id, character_id)
  nulls not distinct;

create index conversation_participants_conversation_idx
  on public.conversation_participants (conversation_id);
create index conversation_participants_profile_idx
  on public.conversation_participants (profile_id);
create index conversation_participants_character_idx
  on public.conversation_participants (character_id);

alter table public.conversation_participants enable row level security;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Exactly one of these is set. No anonymous senders exist.
  sender_profile_id uuid references public.profiles (id) on delete set null,
  sender_character_id uuid references public.characters (id) on delete set null,
  is_npc boolean not null default false,
  kind public.message_kind not null default 'text',
  body text not null,
  -- FK added below, once deal_proposals exists.
  deal_proposal_id uuid,
  moderation_status public.moderation_status not null default 'visible',
  moderation_note text,
  agent_run_id uuid,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  constraint messages_body_len check (char_length(body) between 1 and 8000),
  -- Account-bound sender: a real player's profile, or a labelled AI character.
  constraint messages_sender_bound check (
    (sender_profile_id is not null and sender_character_id is null and is_npc = false)
    or (sender_profile_id is null and sender_character_id is not null and is_npc = true)
  ),
  -- A message's session_id must be the conversation's session_id. Enforced in
  -- the database rather than in the RLS predicate, so it holds for the service
  -- role too.
  constraint messages_conversation_session_fkey
    foreign key (conversation_id, session_id)
    references public.conversations (id, session_id) on delete cascade
);

comment on table public.messages is
  'Chat messages. Every row is account-bound: a human message carries sender_profile_id, an AI message carries sender_character_id with is_npc true and is labelled as AI in the interface. There is no third case.';
comment on column public.messages.is_npc is
  'Rendered as an explicit "AI character" label. Players must always be able to tell whether they are talking to a person.';
comment on column public.messages.moderation_status is
  'Set by moderation review of a report. Removed messages remain for audit but are filtered out of client reads.';

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);
create index messages_session_idx on public.messages (session_id);
create index messages_sender_profile_idx on public.messages (sender_profile_id);

alter table public.messages enable row level security;

-- ---------------------------------------------------------------------------
-- deal_proposals
-- ---------------------------------------------------------------------------

create table public.deal_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  quarter integer not null,
  kind text not null default 'commercial_partnership',
  title text not null,
  proposer_player_id uuid references public.session_players (id) on delete set null,
  proposer_character_id uuid references public.characters (id) on delete set null,
  proposer_company_id uuid references public.companies (id) on delete set null,
  counterparty_player_id uuid references public.session_players (id) on delete set null,
  counterparty_character_id uuid references public.characters (id) on delete set null,
  counterparty_company_id uuid references public.companies (id) on delete set null,
  -- Structured consideration. Each side is an array of typed line items, e.g.
  -- [{"type":"compute","units":10000,"duration_quarters":2}]
  gives jsonb not null default '[]'::jsonb,
  gets jsonb not null default '[]'::jsonb,
  terms jsonb not null default '{}'::jsonb,
  -- false records a stated intention ("we intend to support you next quarter"),
  -- which the engine never enforces. That is what makes bluffing possible.
  is_binding boolean not null default true,
  confidentiality public.visibility_scope not null default 'participants',
  expires_after_quarter integer,
  status public.deal_status not null default 'draft',
  responded_at timestamptz,
  executed_quarter integer,
  parent_proposal_id uuid references public.deal_proposals (id) on delete set null,
  -- FK added in 0014_simulation.sql (sim_events).
  sim_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deal_proposals_quarter_positive check (quarter >= 1),
  constraint deal_proposals_title_len check (char_length(title) between 1 and 200),
  constraint deal_proposals_kind_values check (
    kind in (
      'commercial_partnership', 'joint_venture', 'technology_licence',
      'investment', 'share_purchase', 'merger_acquisition',
      'government_consortium', 'research_collaboration', 'board_voting_agreement',
      'compute_agreement', 'public_endorsement', 'settlement'
    )
  ),
  constraint deal_proposals_gives_is_array check (jsonb_typeof(gives) = 'array'),
  constraint deal_proposals_gets_is_array check (jsonb_typeof(gets) = 'array'),
  constraint deal_proposals_expiry_after_quarter
    check (expires_after_quarter is null or expires_after_quarter >= quarter),
  constraint deal_proposals_no_self_parent
    check (parent_proposal_id is null or parent_proposal_id <> id),
  constraint deal_proposals_has_proposer
    check (proposer_player_id is not null or proposer_character_id is not null),
  constraint deal_proposals_has_counterparty
    check (counterparty_player_id is not null or counterparty_character_id is not null),
  constraint deal_proposals_executed_requires_quarter
    check (status <> 'executed' or executed_quarter is not null)
);

comment on table public.deal_proposals is
  'The only path from conversation to consequence. A chat message can never move compute, shares or cash; a structured proposal accepted by the counterparty can. This is what stops "but they promised me in chat" arguments.';
comment on column public.deal_proposals.gives is
  'What the proposer provides, as typed line items validated by @frontier/contracts before the engine executes anything.';
comment on column public.deal_proposals.is_binding is
  'true = mechanically enforceable contract. false = a stated intention with no enforcement, deliberately preserved so human bluffing is possible.';

create index deal_proposals_session_quarter_idx on public.deal_proposals (session_id, quarter desc);
create index deal_proposals_proposer_idx on public.deal_proposals (proposer_player_id);
create index deal_proposals_counterparty_idx on public.deal_proposals (counterparty_player_id);
create index deal_proposals_conversation_idx on public.deal_proposals (conversation_id);
create index deal_proposals_status_idx on public.deal_proposals (session_id, status);

create trigger deal_proposals_set_updated_at
  before update on public.deal_proposals
  for each row execute function public.set_updated_at();

alter table public.deal_proposals enable row level security;

alter table public.messages
  add constraint messages_deal_proposal_id_fkey
  foreign key (deal_proposal_id) references public.deal_proposals (id) on delete set null;

alter table public.commitments
  add constraint commitments_deal_proposal_id_fkey
  foreign key (deal_proposal_id) references public.deal_proposals (id) on delete set null;

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.game_sessions (id) on delete set null,
  reporter_profile_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  post_id uuid references public.social_posts (id) on delete cascade,
  reported_profile_id uuid references public.profiles (id) on delete cascade,
  reason public.report_reason not null,
  details text,
  status public.report_status not null default 'open',
  reviewed_by uuid references public.profiles (id) on delete set null,
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_details_len check (details is null or char_length(details) <= 2000),
  constraint reports_has_target check (
    message_id is not null or post_id is not null or reported_profile_id is not null
  ),
  constraint reports_not_self
    check (reported_profile_id is null or reported_profile_id <> reporter_profile_id)
);

comment on table public.reports is
  'User reports of objectionable content. Required for user-generated content: players must be able to report a message, a post or another player, and every report is reviewable.';

create index reports_status_idx on public.reports (status, created_at desc);
create index reports_reporter_idx on public.reports (reporter_profile_id);
create index reports_message_idx on public.reports (message_id);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

alter table public.reports enable row level security;

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------

create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_profile_id uuid not null references public.profiles (id) on delete cascade,
  blocked_profile_id uuid not null references public.profiles (id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  constraint blocks_not_self check (blocker_profile_id <> blocked_profile_id),
  constraint blocks_reason_len check (reason is null or char_length(reason) <= 500),
  constraint blocks_unique unique (blocker_profile_id, blocked_profile_id)
);

comment on table public.blocks is
  'Player-level blocks. A block prevents new conversations and hides existing messages in both directions; the engine also refuses to route deal proposals across a block.';

create index blocks_blocked_idx on public.blocks (blocked_profile_id);

alter table public.blocks enable row level security;

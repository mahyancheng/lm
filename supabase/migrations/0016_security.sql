-- ===========================================================================
-- 0016_security.sql — Frontier Capital
--
-- Row Level Security for every table, plus Realtime channel authorization.
--
-- The information boundary is a gameplay mechanic, not just a security control.
-- These policies are the database-level statement of it:
--
--   PUBLIC INFORMATION SET  (readable by any session member)
--     companies, executives, market_instruments, market_quotes, market_beliefs,
--     public_disclosures, world_events(visibility='public'), agencies,
--     government_contracts, contractor_reputation, characters,
--     connection_scores, social_accounts, social_posts(visibility='public'),
--     media_stories(visibility='public'), leaderboard_snapshots, achievements,
--     tech nodes and edges with visibility='public'.
--
--   PRIVATE COMPANY REALITY  (owning player only)
--     company_quarter_metrics, company_resources, employees_agg,
--     unlaunched products, undisclosed holdings, unannounced funding rounds,
--     board proposals and votes, contract milestones, own government bids,
--     research_projects where is_secret, unpublished inventions.
--
--   CANONICAL TRUTH  (service role only — no policy at all, so access is denied)
--     world_snapshots, world_modifiers, agent_profiles, agent_runs,
--     agent_actions, and sim_events with visibility='private'.
--
--   PARTICIPANT-ONLY
--     conversations, conversation_participants, messages, deal_proposals.
--
-- Write surface for clients is deliberately tiny. The authoritative resolver
-- writes state; clients may only:
--   * INSERT their own player_actions while the quarter is 'planning'
--   * INSERT messages into conversations they participate in, as themselves
--   * INSERT reports and INSERT/DELETE blocks
--   * INSERT/UPDATE their own profile and player_settings
-- Everything else — money, shares, prices, contracts, leaderboard scores — has
-- no client write path whatsoever.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper functions.
--
-- All are SECURITY DEFINER with an empty search_path so a policy can consult
-- membership tables without recursing through their own RLS.
-- ---------------------------------------------------------------------------

create or replace function public.is_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_players sp
    where sp.session_id = p_session_id
      and sp.profile_id = (select auth.uid())
  );
$$;

comment on function public.is_session_member(uuid) is
  'True when the calling user holds a seat in the session. The base predicate of almost every read policy.';

create or replace function public.current_player_id(p_session_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.id
  from public.session_players sp
  where sp.session_id = p_session_id
    and sp.profile_id = (select auth.uid())
  limit 1;
$$;

comment on function public.current_player_id(uuid) is
  'The calling user''s session_players.id in the given session, or NULL. A user holds at most one seat per session.';

create or replace function public.owns_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.companies c
    join public.session_players sp on sp.id = c.controlled_by_player_id
    where c.id = p_company_id
      and sp.profile_id = (select auth.uid())
  );
$$;

comment on function public.owns_company(uuid) is
  'True when the calling user currently controls the company. Control, not ownership: a dismissed founder who still holds shares does not pass this test.';

create or replace function public.company_is_public(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.is_public
  );
$$;

comment on function public.company_is_public(uuid) is
  'True when the company is listed on the in-world exchange, and therefore subject to public cap-table and governance visibility.';

create or replace function public.can_see_board(p_board_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.boards b
    join public.session_players sp on sp.session_id = b.session_id
    where b.id = p_board_id
      and sp.profile_id = (select auth.uid())
      and (
        b.company_id = sp.company_id
        or exists (
          select 1
          from public.board_seats bs
          where bs.board_id = b.id
            and bs.is_active
            and (
              bs.player_id = sp.id
              or (bs.character_id is not null and bs.character_id = sp.character_id)
            )
        )
      )
  );
$$;

comment on function public.can_see_board(uuid) is
  'True when the calling user runs the company or holds a seat on its board. Board deliberation is confidential to the boardroom.';

create or replace function public.is_own_character(p_character_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_players sp
    where sp.profile_id = (select auth.uid())
      and (
        sp.character_id = p_character_id
        or exists (
          select 1
          from public.characters ch
          where ch.id = p_character_id
            and ch.player_id = sp.id
        )
      )
  );
$$;

comment on function public.is_own_character(uuid) is
  'True when the character is the calling user''s own in-world person. Gates private interiority: their traits, their relationships, their memories.';

create or replace function public.is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.profile_id = (select auth.uid())
      and cp.left_at is null
  );
$$;

comment on function public.is_conversation_participant(uuid) is
  'True when the calling user is an active participant. Unauthorised users cannot join or read a restricted conversation, in Postgres or over Realtime.';

create or replace function public.shares_session_with(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_players a
    join public.session_players b on b.session_id = a.session_id
    where a.profile_id = (select auth.uid())
      and b.profile_id = p_profile_id
  );
$$;

comment on function public.shares_session_with(uuid) is
  'True when both profiles hold seats in the same session. Lets players see each other''s handle and display name, and nothing else.';

create or replace function public.is_quarter_planning(p_session_id uuid, p_quarter integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quarters q
    where q.session_id = p_session_id
      and q.quarter_no = p_quarter
      and q.status = 'planning'
  );
$$;

comment on function public.is_quarter_planning(uuid, integer) is
  'True only while the quarter is open for planning. Once it is locked, no client may add an instruction to it.';

create or replace function public.try_uuid(p_text text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_text::uuid;
exception when others then
  return null;
end;
$$;

comment on function public.try_uuid(text) is
  'Parses a uuid or returns NULL. Used to decode Realtime topic segments without raising on malformed input.';

-- ---------------------------------------------------------------------------
-- Realtime channel authorization.
--
-- Channel naming convention:
--   session:{session_id}:events
--       server-broadcast session feed (quarter opened/locked/committed, world
--       events, market ticks). Readable by session members; clients never write.
--   session:{session_id}:conversation:{conversation_id}
--       chat and presence. Readable and writable by conversation participants
--       only.
--   session:{session_id}:presence
--       lobby presence for session members.
-- ---------------------------------------------------------------------------

create or replace function public.can_read_realtime_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_conversation_id uuid;
  v_kind text;
begin
  if p_topic is null then
    return false;
  end if;

  if split_part(p_topic, ':', 1) <> 'session' then
    return false;
  end if;

  v_session_id := public.try_uuid(split_part(p_topic, ':', 2));
  if v_session_id is null then
    return false;
  end if;

  v_kind := split_part(p_topic, ':', 3);

  if v_kind in ('events', 'presence') then
    return public.is_session_member(v_session_id);
  end if;

  if v_kind = 'conversation' then
    v_conversation_id := public.try_uuid(split_part(p_topic, ':', 4));
    if v_conversation_id is null then
      return false;
    end if;
    return public.is_session_member(v_session_id)
       and public.is_conversation_participant(v_conversation_id);
  end if;

  return false;
end;
$$;

comment on function public.can_read_realtime_topic(text) is
  'Authorises joining a Realtime Broadcast channel. session:{id}:events and :presence require session membership; session:{id}:conversation:{id} requires participation.';

create or replace function public.can_write_realtime_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_conversation_id uuid;
begin
  if p_topic is null then
    return false;
  end if;

  if split_part(p_topic, ':', 1) <> 'session' then
    return false;
  end if;

  v_session_id := public.try_uuid(split_part(p_topic, ':', 2));
  if v_session_id is null then
    return false;
  end if;

  -- The session event feed is server-broadcast only: clients may listen, never
  -- publish. A client cannot fabricate a world event or a market tick.
  if split_part(p_topic, ':', 3) <> 'conversation' then
    return false;
  end if;

  v_conversation_id := public.try_uuid(split_part(p_topic, ':', 4));
  if v_conversation_id is null then
    return false;
  end if;

  return public.is_session_member(v_session_id)
     and public.is_conversation_participant(v_conversation_id);
end;
$$;

comment on function public.can_write_realtime_topic(text) is
  'Authorises publishing on a Realtime Broadcast channel. Only conversation channels accept client writes.';

-- ---------------------------------------------------------------------------
-- Administrative escape hatch.
--
-- sim_events is append-only by trigger, which also blocks the cascade from
-- deleting a game_session. Sessions are normally archived (status='archived'),
-- not deleted. When a session genuinely must be removed — a local development
-- reset, a data-deletion request — this is the single audited path.
-- ---------------------------------------------------------------------------

create or replace function public.purge_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  alter table public.sim_events disable trigger sim_events_forbid_delete;
  delete from public.game_sessions where id = p_session_id;
  alter table public.sim_events enable trigger sim_events_forbid_delete;
end;
$$;

comment on function public.purge_session(uuid) is
  'Hard-deletes a session and its entire ledger. Service role only. Prefer archiving: the ledger is the audit trail.';

-- ---------------------------------------------------------------------------
-- Base privileges.
--
-- anon gets nothing at all: every policy below targets `authenticated`, and a
-- table with RLS enabled and no matching policy denies by default.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from anon, authenticated;

grant select on all tables in schema public to authenticated;

-- Canonical truth and LLM bookkeeping: not even SELECT is granted.
revoke select on
  public.world_snapshots,
  public.world_modifiers,
  public.agent_profiles,
  public.agent_runs,
  public.agent_actions
from authenticated;

-- The complete client write surface.
grant update (handle, display_name, avatar_url, bio, country_code)
  on public.profiles to authenticated;
grant insert on public.profiles to authenticated;
grant insert, update on public.player_settings to authenticated;
grant insert on public.player_actions to authenticated;
grant insert on public.messages to authenticated;
grant insert on public.reports to authenticated;
grant insert, delete on public.blocks to authenticated;

grant all on all tables in schema public to service_role;

revoke all on function public.purge_session(uuid) from public;
grant execute on function public.purge_session(uuid) to service_role;

-- ===========================================================================
-- identity
-- ===========================================================================

create policy profiles_select_self_or_session_peer
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_session_with(id));

create policy profiles_insert_self
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy player_settings_select_self
  on public.player_settings for select to authenticated
  using (profile_id = (select auth.uid()));

create policy player_settings_insert_self
  on public.player_settings for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy player_settings_update_self
  on public.player_settings for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- ===========================================================================
-- sessions
-- ===========================================================================

create policy game_sessions_select_visible
  on public.game_sessions for select to authenticated
  using (
    is_public
    or created_by = (select auth.uid())
    or public.is_session_member(id)
  );

create policy session_players_select_members
  on public.session_players for select to authenticated
  using (public.is_session_member(session_id));

create policy quarters_select_members
  on public.quarters for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- world
--
-- world_snapshots and world_modifiers intentionally have NO policy: canonical
-- reality and the raw modifier pipeline are service-role only.
-- ===========================================================================

create policy jurisdictions_select_members
  on public.jurisdictions for select to authenticated
  using (public.is_session_member(session_id));

create policy world_events_select_public
  on public.world_events for select to authenticated
  using (public.is_session_member(session_id) and visibility = 'public');

-- ===========================================================================
-- companies
-- ===========================================================================

create policy companies_select_members
  on public.companies for select to authenticated
  using (public.is_session_member(session_id));

create policy company_quarter_metrics_select_owner
  on public.company_quarter_metrics for select to authenticated
  using (public.is_session_member(session_id) and public.owns_company(company_id));

create policy products_select_launched_or_owner
  on public.products for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      public.owns_company(company_id)
      or status in ('beta', 'launched', 'deprecated', 'sunset')
    )
  );

create policy company_resources_select_owner
  on public.company_resources for select to authenticated
  using (public.is_session_member(session_id) and public.owns_company(company_id));

create policy employees_agg_select_owner
  on public.employees_agg for select to authenticated
  using (public.is_session_member(session_id) and public.owns_company(company_id));

create policy executives_select_members
  on public.executives for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- ownership
-- ===========================================================================

create policy share_classes_select_owner_or_public_company
  on public.share_classes for select to authenticated
  using (
    public.is_session_member(session_id)
    and (public.owns_company(company_id) or public.company_is_public(company_id))
  );

create policy securities_select_listed_or_owner
  on public.securities for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      is_listed
      or public.owns_company(company_id)
      or public.company_is_public(company_id)
    )
  );

create policy holdings_select_disclosed_or_involved
  on public.holdings for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      is_disclosed
      or public.owns_company(company_id)
      or public.owns_company(holder_company_id)
      or holder_player_id = public.current_player_id(session_id)
      or public.is_own_character(holder_character_id)
    )
  );

create policy transactions_select_public_or_involved
  on public.transactions for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      is_public_record
      or public.owns_company(company_id)
      or from_player_id = public.current_player_id(session_id)
      or to_player_id = public.current_player_id(session_id)
    )
  );

create policy funding_rounds_select_announced_or_owner
  on public.funding_rounds for select to authenticated
  using (
    public.is_session_member(session_id)
    and (is_announced or public.owns_company(company_id))
  );

-- ===========================================================================
-- governance
-- ===========================================================================

create policy boards_select_boardroom_or_public_company
  on public.boards for select to authenticated
  using (
    public.is_session_member(session_id)
    and (public.can_see_board(id) or public.company_is_public(company_id))
  );

create policy board_seats_select_boardroom_or_public_company
  on public.board_seats for select to authenticated
  using (
    public.is_session_member(session_id)
    and (public.can_see_board(board_id) or public.company_is_public(company_id))
  );

create policy board_proposals_select_boardroom
  on public.board_proposals for select to authenticated
  using (public.is_session_member(session_id) and public.can_see_board(board_id));

create policy board_votes_select_boardroom
  on public.board_votes for select to authenticated
  using (public.is_session_member(session_id) and public.can_see_board(board_id));

create policy shareholder_proposals_select_public_or_involved
  on public.shareholder_proposals for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      is_public
      or public.owns_company(company_id)
      or filed_by_player_id = public.current_player_id(session_id)
    )
  );

create policy commitments_select_parties
  on public.commitments for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      actor_player_id = public.current_player_id(session_id)
      or beneficiary_player_id = public.current_player_id(session_id)
      or public.owns_company(company_id)
      or public.is_own_character(actor_character_id)
      or public.is_own_character(beneficiary_character_id)
    )
  );

-- ===========================================================================
-- markets — the public information set
-- ===========================================================================

create policy market_instruments_select_members
  on public.market_instruments for select to authenticated
  using (public.is_session_member(session_id));

create policy market_quotes_select_members
  on public.market_quotes for select to authenticated
  using (public.is_session_member(session_id));

create policy market_trades_select_public_or_involved
  on public.market_trades for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      is_public_record
      or buyer_player_id = public.current_player_id(session_id)
      or seller_player_id = public.current_player_id(session_id)
      or public.owns_company(buyer_company_id)
      or public.owns_company(seller_company_id)
    )
  );

create policy market_beliefs_select_members
  on public.market_beliefs for select to authenticated
  using (public.is_session_member(session_id));

create policy public_disclosures_select_members
  on public.public_disclosures for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- government
-- ===========================================================================

create policy agencies_select_members
  on public.agencies for select to authenticated
  using (public.is_session_member(session_id));

create policy procurement_opportunities_select_published
  on public.procurement_opportunities for select to authenticated
  using (
    public.is_session_member(session_id)
    and visibility in ('public', 'session')
  );

create policy government_bids_select_own_or_public
  on public.government_bids for select to authenticated
  using (
    public.is_session_member(session_id)
    and (is_public or public.owns_company(company_id))
  );

create policy government_contracts_select_members
  on public.government_contracts for select to authenticated
  using (public.is_session_member(session_id));

create policy contract_milestones_select_owner
  on public.contract_milestones for select to authenticated
  using (public.is_session_member(session_id) and public.owns_company(company_id));

create policy contractor_reputation_select_members
  on public.contractor_reputation for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- technology — the Frontier Map
-- ===========================================================================

create policy tech_graph_versions_select_members
  on public.tech_graph_versions for select to authenticated
  using (public.is_session_member(session_id));

create policy tech_nodes_select_public_or_owner
  on public.tech_nodes for select to authenticated
  using (
    public.is_session_member(session_id)
    and (visibility = 'public' or public.owns_company(owner_company_id))
  );

create policy tech_edges_select_public_or_owner
  on public.tech_edges for select to authenticated
  using (
    public.is_session_member(session_id)
    and (visibility = 'public' or public.owns_company(owner_company_id))
  );

-- is_secret is the RLS-critical flag: a secret programme is readable only by
-- the company that runs it and by the player who owns it.
create policy research_projects_select_owner_or_not_secret
  on public.research_projects for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      public.owns_company(company_id)
      or owner_player_id = public.current_player_id(session_id)
      or (not is_secret)
    )
  );

create policy inventions_select_published_or_owner
  on public.inventions for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      visibility = 'public'
      or is_published
      or public.owns_company(company_id)
    )
  );

-- ===========================================================================
-- people
-- ===========================================================================

create policy characters_select_members
  on public.characters for select to authenticated
  using (public.is_session_member(session_id));

create policy character_traits_select_public_or_own
  on public.character_traits for select to authenticated
  using (
    public.is_session_member(session_id)
    and (is_public or public.is_own_character(character_id))
  );

create policy relationships_select_own_view
  on public.relationships for select to authenticated
  using (
    public.is_session_member(session_id)
    and public.is_own_character(from_character_id)
  );

create policy memories_select_own
  on public.memories for select to authenticated
  using (
    public.is_session_member(session_id)
    and public.is_own_character(character_id)
  );

create policy connection_scores_select_members
  on public.connection_scores for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- social
-- ===========================================================================

create policy social_accounts_select_members
  on public.social_accounts for select to authenticated
  using (public.is_session_member(session_id));

create policy social_posts_select_public_visible
  on public.social_posts for select to authenticated
  using (
    public.is_session_member(session_id)
    and visibility = 'public'
    and moderation_status in ('visible', 'flagged')
  );

create policy engagement_events_select_members
  on public.engagement_events for select to authenticated
  using (public.is_session_member(session_id));

create policy media_stories_select_public
  on public.media_stories for select to authenticated
  using (public.is_session_member(session_id) and visibility = 'public');

-- ===========================================================================
-- conversation
-- ===========================================================================

create policy conversations_select_participants
  on public.conversations for select to authenticated
  using (public.is_conversation_participant(id));

create policy conversation_participants_select_participants
  on public.conversation_participants for select to authenticated
  using (public.is_conversation_participant(conversation_id));

create policy messages_select_participants
  on public.messages for select to authenticated
  using (
    public.is_conversation_participant(conversation_id)
    and moderation_status <> 'removed'
  );

-- The one place a client writes conversational content. The sender must be the
-- calling user, must be a participant, and cannot masquerade as an AI character.
create policy messages_insert_own_as_participant
  on public.messages for insert to authenticated
  with check (
    sender_profile_id = (select auth.uid())
    and sender_character_id is null
    and is_npc = false
    and moderation_status = 'visible'
    and kind in ('text', 'deal_reference')
    and public.is_session_member(session_id)
    and public.is_conversation_participant(conversation_id)
  );

create policy deal_proposals_select_parties
  on public.deal_proposals for select to authenticated
  using (
    public.is_session_member(session_id)
    and (
      confidentiality = 'public'
      or proposer_player_id = public.current_player_id(session_id)
      or counterparty_player_id = public.current_player_id(session_id)
      or public.is_own_character(proposer_character_id)
      or public.is_own_character(counterparty_character_id)
    )
  );

create policy reports_select_own
  on public.reports for select to authenticated
  using (reporter_profile_id = (select auth.uid()));

create policy reports_insert_own
  on public.reports for insert to authenticated
  with check (
    reporter_profile_id = (select auth.uid())
    and status = 'open'
    and reviewed_by is null
  );

create policy blocks_select_own
  on public.blocks for select to authenticated
  using (blocker_profile_id = (select auth.uid()));

create policy blocks_insert_own
  on public.blocks for insert to authenticated
  with check (blocker_profile_id = (select auth.uid()));

create policy blocks_delete_own
  on public.blocks for delete to authenticated
  using (blocker_profile_id = (select auth.uid()));

-- ===========================================================================
-- agents
--
-- agent_profiles, agent_runs and agent_actions intentionally have NO policy:
-- prompts, raw model output, rejected proposals and NPC intentions are
-- service-role only.
-- ===========================================================================

-- ===========================================================================
-- simulation
-- ===========================================================================

create policy player_actions_select_own
  on public.player_actions for select to authenticated
  using (
    public.is_session_member(session_id)
    and player_id = public.current_player_id(session_id)
  );

-- The acting session member may queue their own instructions, and only while
-- the quarter is still open for planning.
create policy player_actions_insert_own_open_quarter
  on public.player_actions for insert to authenticated
  with check (
    public.is_session_member(session_id)
    and player_id = public.current_player_id(session_id)
    and public.is_quarter_planning(session_id, quarter)
    and status in ('draft', 'submitted')
    and resolved_at is null
  );

create policy sim_events_select_non_private
  on public.sim_events for select to authenticated
  using (
    public.is_session_member(session_id)
    and visibility in ('public', 'session')
  );

-- ===========================================================================
-- competition
--
-- Read-only for everyone but the resolver. There is no INSERT, UPDATE or
-- DELETE policy on leaderboard_snapshots at all: a client cannot submit a score.
-- ===========================================================================

create policy leaderboard_snapshots_select_members
  on public.leaderboard_snapshots for select to authenticated
  using (public.is_session_member(session_id));

create policy achievements_select_members
  on public.achievements for select to authenticated
  using (public.is_session_member(session_id));

-- ===========================================================================
-- Realtime authorization (Broadcast).
--
-- Supabase Realtime checks realtime.messages policies when a client joins a
-- private channel. Broadcast is used for chat, presence and live session
-- updates; Postgres remains the source of truth.
-- ===========================================================================

do $realtime$
begin
  if to_regclass('realtime.messages') is null
     or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages or realtime.topic() not present; skipping Realtime authorization policies';
    return;
  end if;

  execute 'drop policy if exists frontier_realtime_read on realtime.messages';
  execute $p$
    create policy frontier_realtime_read
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension in ('broadcast', 'presence')
        and public.can_read_realtime_topic((select realtime.topic()))
      )
  $p$;

  execute 'drop policy if exists frontier_realtime_write on realtime.messages';
  execute $p$
    create policy frontier_realtime_write
      on realtime.messages
      for insert
      to authenticated
      with check (
        realtime.messages.extension in ('broadcast', 'presence')
        and public.can_write_realtime_topic((select realtime.topic()))
      )
  $p$;
end;
$realtime$;

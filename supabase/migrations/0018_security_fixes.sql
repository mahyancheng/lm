-- ===========================================================================
-- 0018_security_fixes.sql — Frontier Capital
--
-- Three corrections to the policy surface laid down in 0016_security.sql.
-- 0016 is already applied, so nothing there is edited: functions are replaced
-- and policies are recreated here, which is the only safe way to change an
-- applied migration's effects.
--
--   1. PRESENCE COULD NEVER BE TRACKED.
--      can_read_realtime_topic admits 'events' and 'presence'; the write side
--      rejected everything whose third topic segment was not 'conversation'.
--      Supabase authorises presence tracking through the INSERT policy on
--      realtime.messages with extension = 'presence', so the lobby documented
--      at 0016:258-260 could be joined but never populated: every member saw an
--      empty roster. Presence is now writable by session members, and the event
--      feed stays server-broadcast only, which is what that test was for.
--
--   2. BROADCAST HAD NO PAYLOAD AUTHORITY.
--      messages_insert_own_as_participant forbids a player from masquerading as
--      an AI character (sender_profile_id = auth.uid(), sender_character_id
--      null, is_npc false), and 0012's messages_sender_bound CHECK enforces the
--      same at the storage layer. A Broadcast payload is opaque client JSON, so
--      a participant could publish {is_npc: true, sender_character_id: ...} on
--      the conversation channel and every subscriber would render a forged turn
--      that never touched Postgres. Client broadcast is therefore withdrawn
--      entirely and replaced with a server relay: an insert into public.messages
--      — which has already passed RLS and the CHECK — emits the broadcast, with
--      a payload the database builds from the stored row. Identity on the wire
--      is now the identity in the table, by construction.
--
--   3. player_actions DID NOT BIND company_id.
--      The INSERT policy checked membership, seat, quarter status and action
--      status, but left company_id — the column that becomes
--      SubmittedAction.actorCompanyId — free, so a member could queue an action
--      on behalf of a rival's company, or a company from another session
--      entirely. The engine rejects it (validator: not_controller_of_company),
--      but 0014's header claims this write surface is the boundary, and a
--      backstop is not a boundary.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. Realtime channel authorization.
--
-- The matrix this file settles, for an authenticated client:
--
--   topic                                    read      presence   broadcast
--   session:{id}:events                      member    no         no
--   session:{id}:presence                    member    member     no
--   session:{id}:conversation:{cid}          participant participant no
--
-- Read is unchanged from 0016. Broadcast is now server-only on every topic:
-- see the relay below.
-- ---------------------------------------------------------------------------

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

  -- The session event feed is server-broadcast only: clients may listen, never
  -- publish. A client cannot fabricate a world event or a market tick.
  if v_kind = 'events' then
    return false;
  end if;

  -- Lobby presence. Tracking a presence state is how a member says "I am here",
  -- which is a claim about themselves and safe to let them make.
  if v_kind = 'presence' then
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

comment on function public.can_write_realtime_topic(text) is
  'Authorises a client presence write on a Realtime channel: session:{id}:presence for members, session:{id}:conversation:{id} for participants. The event feed is server-only. This answers WHO may publish on a topic and can never answer WHAT they published — a Broadcast payload is opaque JSON — which is why client broadcast is refused outright and message content is relayed by broadcast_message_row().';

do $realtime$
begin
  if to_regclass('realtime.messages') is null
     or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages or realtime.topic() not present; skipping Realtime authorization policies';
    return;
  end if;

  -- Read is unchanged; recreated so this migration is self-contained if 0016's
  -- realtime block was skipped on this database.
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

  -- Presence only. A client may say where it is; it may not say what was said.
  execute 'drop policy if exists frontier_realtime_write on realtime.messages';
  execute $p$
    create policy frontier_realtime_write
      on realtime.messages
      for insert
      to authenticated
      with check (
        realtime.messages.extension = 'presence'
        and public.can_write_realtime_topic((select realtime.topic()))
      )
  $p$;
end;
$realtime$;

-- ---------------------------------------------------------------------------
-- The server relay.
--
-- Broadcast is transport, not truth. The payload carries ids only — never the
-- body — so a subscriber has to read the row back through
-- messages_select_participants to render it. That keeps three guarantees the
-- channel cannot make for itself: the sender is whoever RLS and
-- messages_sender_bound allowed, a removed message stays invisible because
-- moderation_status is re-checked on read, and a non-participant learns
-- nothing from a payload they can see the shape of but not the content.
-- ---------------------------------------------------------------------------

do $relay$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise notice 'realtime.send() not present; skipping the message broadcast relay';
    return;
  end if;

  execute $fn$
    create or replace function public.broadcast_message_row()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    begin
      begin
        perform realtime.send(
          jsonb_build_object(
            'messageId', new.id,
            'sessionId', new.session_id,
            'conversationId', new.conversation_id,
            'senderProfileId', new.sender_profile_id,
            'senderCharacterId', new.sender_character_id,
            'isNpc', new.is_npc,
            'kind', new.kind::text,
            'createdAt', new.created_at
          ),
          'message',
          'session:' || new.session_id::text || ':conversation:' || new.conversation_id::text,
          true
        );
      exception
        when others then
          -- A notification is a convenience. Losing one degrades liveness; it
          -- must never fail the insert that is the actual record.
          null;
      end;
      return new;
    end;
    $body$
  $fn$;

  execute 'drop trigger if exists messages_broadcast_after_insert on public.messages';
  execute 'create trigger messages_broadcast_after_insert
             after insert on public.messages
             for each row execute function public.broadcast_message_row()';
end;
$relay$;

-- ---------------------------------------------------------------------------
-- 3. player_actions: bind company_id to a company the acting player controls
--    in this session.
-- ---------------------------------------------------------------------------

create or replace function public.controls_company_in_session(p_session_id uuid, p_company_id uuid)
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
      and c.session_id = p_session_id
      and sp.session_id = p_session_id
      and sp.profile_id = (select auth.uid())
  );
$$;

comment on function public.controls_company_in_session(uuid, uuid) is
  'True when the calling user controls that company AND the company belongs to that session. Stricter than owns_company(uuid), which is session-blind: player_actions.company_id is a bare FK to companies, so without the session test a row could name a company from another game entirely.';

drop policy if exists player_actions_insert_own_open_quarter on public.player_actions;

-- The acting session member may queue their own instructions, on their own
-- company, and only while the quarter is still open for planning.
create policy player_actions_insert_own_open_quarter
  on public.player_actions for insert to authenticated
  with check (
    public.is_session_member(session_id)
    and player_id = public.current_player_id(session_id)
    and public.is_quarter_planning(session_id, quarter)
    and status in ('draft', 'submitted')
    and resolved_at is null
    and (company_id is null or public.controls_company_in_session(session_id, company_id))
  );

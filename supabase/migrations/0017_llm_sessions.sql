-- 0017_llm_sessions.sql
-- Maps a game conversation to the persistent Claude Code session that backs
-- its dialogue, so the LLM gateway can resume the same session on every
-- message (docs/LLM_CONTRACTS.md §11). Server-side detail: service-role only,
-- following the same pattern as agent_runs (RLS enabled, no policies, SELECT
-- revoked from client roles).

create table public.conversation_llm_sessions (
  conversation_id uuid primary key,
  session_id uuid not null,
  claude_session_id text not null,
  transport text not null default 'claude-session',
  last_resumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_llm_sessions_conversation_fk
    foreign key (conversation_id, session_id)
    references public.conversations (id, session_id) on delete cascade,
  constraint conversation_llm_sessions_transport_ck
    check (transport in ('claude-session', 'api'))
);

comment on table public.conversation_llm_sessions is
  'Service-role-only mapping from a game conversation to the Claude Code session resumed for its dialogue. Never exposed to clients; the transcript lives with the Claude session, the canonical memory lives in memories/commitments.';

alter table public.conversation_llm_sessions enable row level security;

revoke all on public.conversation_llm_sessions from anon, authenticated;

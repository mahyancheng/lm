-- ===========================================================================
-- 0001_identity.sql — Frontier Capital
--
-- Player accounts. Supabase Auth owns credentials (auth.users); this domain
-- owns the game-facing identity that every other domain references.
--
-- Every player identity is persistent and account-bound. The game has no
-- anonymous participants: connection-gating, moderation (report/block) and
-- the App Store UGC rules all depend on a stable public identity.
-- ===========================================================================

create extension if not exists "pgcrypto" with schema extensions;

-- ---------------------------------------------------------------------------
-- Shared trigger helpers (used across every later migration).
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger helper: stamps updated_at on every UPDATE.';

create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'relation %.% is append-only; % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = '42501';
  return null;
end;
$$;

comment on function public.forbid_mutation() is
  'Trigger helper: raises on UPDATE/DELETE. Used to make ledgers append-only.';

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique,
  display_name text not null default 'Founder',
  avatar_url text,
  bio text,
  country_code text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,32}$'),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 60),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 500),
  constraint profiles_country_code_format
    check (country_code is null or country_code ~ '^[A-Z]{2}$')
);

comment on table public.profiles is
  'Game-facing player identity, one row per auth.users row. Created automatically by the on_auth_user_created trigger.';
comment on column public.profiles.handle is
  'Unique, lowercase, URL-safe public handle. Shown on every message the player sends.';
comment on column public.profiles.is_admin is
  'Session moderation / operations flag. Never grants write access to canonical simulation state.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- player_settings
-- ---------------------------------------------------------------------------

create table public.player_settings (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  -- "Execute routine instructions automatically": the Chief of Staff may submit
  -- low-risk actions without a confirmation step. The confirm_* flags below stay
  -- true by design — financing, M&A, layoffs, share issuance, large contracts and
  -- large spend always require an explicit player confirmation.
  auto_execute_routine boolean not null default false,
  confirm_financing boolean not null default true,
  confirm_m_and_a boolean not null default true,
  confirm_layoffs boolean not null default true,
  confirm_share_issuance boolean not null default true,
  confirm_major_contracts boolean not null default true,
  confirm_large_spend boolean not null default true,
  large_spend_threshold_usd numeric not null default 25000000,
  chief_of_staff_verbosity text not null default 'standard',
  locale text not null default 'en',
  theme text not null default 'terminal',
  notify_quarter_open boolean not null default true,
  notify_deal_proposed boolean not null default true,
  notify_message boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint player_settings_large_spend_nonneg
    check (large_spend_threshold_usd >= 0),
  constraint player_settings_verbosity
    check (chief_of_staff_verbosity in ('terse', 'standard', 'detailed')),
  constraint player_settings_theme
    check (theme in ('terminal', 'light', 'dark'))
);

comment on table public.player_settings is
  'Per-player client and Chief of Staff preferences. Never affects canonical simulation outcomes.';
comment on column public.player_settings.auto_execute_routine is
  'When true the Chief of Staff may submit low-risk quarter instructions without a confirmation dialog.';

create trigger player_settings_set_updated_at
  before update on public.player_settings
  for each row execute function public.set_updated_at();

alter table public.player_settings enable row level security;

-- ---------------------------------------------------------------------------
-- auth.users -> profiles bootstrap
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_handle text;
  v_display text;
begin
  v_base := lower(
    regexp_replace(
      coalesce(
        new.raw_user_meta_data ->> 'handle',
        new.raw_user_meta_data ->> 'user_name',
        split_part(coalesce(new.email, ''), '@', 1),
        ''
      ),
      '[^a-zA-Z0-9_]',
      '',
      'g'
    )
  );

  if v_base is null or char_length(v_base) < 3 then
    v_base := 'founder';
  end if;

  -- Deterministic, collision-free: 20 chars of the sanitised base plus 8 hex
  -- characters of the user id.
  v_handle := substr(v_base, 1, 20) || '_' || substr(replace(new.id::text, '-', ''), 1, 8);

  v_display := coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    'Founder'
  );

  insert into public.profiles (id, handle, display_name)
  values (new.id, v_handle, substr(v_display, 1, 60))
  on conflict (id) do nothing;

  insert into public.player_settings (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the public.profiles and public.player_settings rows for a newly registered auth user.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

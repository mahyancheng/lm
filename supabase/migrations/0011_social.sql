-- ===========================================================================
-- 0011_social.sql — Frontier Capital
--
-- Marketing as an information network rather than a single modifier.
--
-- The text of a post may be LLM-generated; reach and effects belong to the
-- engine: credibility x follower graph x relevance x novelty -> engagement ->
-- belief/sentiment change -> possible press amplification -> customer, talent,
-- regulator and investor response.
--
-- This is also the public-information bridge to prices: a rumour moves the
-- market only to the extent participants believe it (market_beliefs), while
-- actual revenue stays actual revenue.
-- ===========================================================================

create type public.social_network as enum (
  'fast_feed',          -- journalists, investors, founders, consumers
  'professional',       -- executives, enterprise customers, employees
  'technical_forum',    -- engineers, researchers, developers
  'community_forum',    -- enthusiasts, critics, customers
  'video',              -- mass consumers and creators
  'finance_community'   -- retail investors, analysts, traders
);

create type public.audience_segment as enum (
  'developers',
  'researchers',
  'enterprise_buyers',
  'consumers',
  'investors',
  'analysts',
  'regulators',
  'media',
  'employees',
  'open_source_community'
);

create type public.post_author_kind as enum ('player', 'npc_character', 'company', 'engine');

-- ---------------------------------------------------------------------------
-- social_accounts
-- ---------------------------------------------------------------------------

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  network public.social_network not null,
  handle text not null,
  display_name text not null,
  owner_character_id uuid references public.characters (id) on delete cascade,
  owner_company_id uuid references public.companies (id) on delete cascade,
  owner_player_id uuid references public.session_players (id) on delete set null,
  followers numeric not null default 0,
  credibility numeric not null default 0.5,
  audience_mix jsonb not null default '{}'::jsonb,
  is_verified boolean not null default false,
  is_official boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_accounts_handle_format check (handle ~ '^[a-z0-9_.]{2,32}$'),
  constraint social_accounts_followers_nonneg check (followers >= 0),
  constraint social_accounts_credibility_range check (credibility between 0 and 1),
  constraint social_accounts_has_owner
    check (owner_character_id is not null or owner_company_id is not null),
  constraint social_accounts_unique_handle unique (session_id, network, handle)
);

comment on table public.social_accounts is
  'Presences on the synthetic networks. Every account is bound to a character or a company: there are no anonymous accounts, which is both a moderation requirement and the reason credibility can be tracked at all.';
comment on column public.social_accounts.credibility is
  'How much weight this voice carries. Denials later shown to be misleading reduce it, which is what makes an investor-relations reputation a real asset.';

create index social_accounts_session_idx on public.social_accounts (session_id);
create index social_accounts_character_idx on public.social_accounts (owner_character_id);
create index social_accounts_company_idx on public.social_accounts (owner_company_id);

create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row execute function public.set_updated_at();

alter table public.social_accounts enable row level security;

-- ---------------------------------------------------------------------------
-- social_posts
-- ---------------------------------------------------------------------------

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  account_id uuid not null references public.social_accounts (id) on delete cascade,
  quarter integer not null,
  author_kind public.post_author_kind not null default 'npc_character',
  body text not null,
  topic text,
  stance numeric not null default 0,
  parent_post_id uuid references public.social_posts (id) on delete set null,
  subject_company_id uuid references public.companies (id) on delete set null,
  subject_character_id uuid references public.characters (id) on delete set null,
  campaign_id uuid,
  is_rumour boolean not null default false,
  rumour_credibility numeric,
  reach numeric not null default 0,
  novelty numeric not null default 0.5,
  sentiment_effects jsonb not null default '{}'::jsonb,
  visibility public.visibility_scope not null default 'public',
  moderation_status text not null default 'visible',
  created_at timestamptz not null default now(),
  constraint social_posts_quarter_positive check (quarter >= 1),
  constraint social_posts_body_len check (char_length(body) between 1 and 2000),
  constraint social_posts_stance_range check (stance between -1 and 1),
  constraint social_posts_reach_nonneg check (reach >= 0),
  constraint social_posts_novelty_range check (novelty between 0 and 1),
  constraint social_posts_rumour_credibility_range
    check (rumour_credibility is null or rumour_credibility between 0 and 1),
  constraint social_posts_rumour_has_credibility
    check ((not is_rumour) or rumour_credibility is not null),
  constraint social_posts_no_self_parent check (parent_post_id is null or parent_post_id <> id),
  constraint social_posts_moderation_values
    check (moderation_status in ('visible', 'flagged', 'hidden', 'removed'))
);

comment on table public.social_posts is
  'Public statements. The LLM may write the words; the engine decides who sees them and what it does to belief. Removed or hidden posts stay in the table for moderation audit but are filtered from client reads.';
comment on column public.social_posts.rumour_credibility is
  'How believable the claim is right now. A 31%-credible leak about a model delay moves the price a little; being caught denying it later collapses the denier''s credibility.';

create index social_posts_session_quarter_idx on public.social_posts (session_id, quarter desc);
create index social_posts_account_idx on public.social_posts (account_id, quarter desc);
create index social_posts_subject_company_idx on public.social_posts (subject_company_id);

alter table public.social_posts enable row level security;

alter table public.market_beliefs
  add constraint market_beliefs_source_post_id_fkey
  foreign key (source_post_id) references public.social_posts (id) on delete set null;

-- ---------------------------------------------------------------------------
-- engagement_events
-- ---------------------------------------------------------------------------

create table public.engagement_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  post_id uuid not null references public.social_posts (id) on delete cascade,
  quarter integer not null,
  audience public.audience_segment not null,
  impressions numeric not null default 0,
  engagements numeric not null default 0,
  amplification numeric not null default 0,
  sentiment_delta numeric not null default 0,
  belief_delta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint engagement_events_quarter_positive check (quarter >= 1),
  constraint engagement_events_impressions_nonneg check (impressions >= 0),
  constraint engagement_events_engagements_nonneg check (engagements >= 0),
  constraint engagement_events_amplification_nonneg check (amplification >= 0),
  constraint engagement_events_sentiment_range check (sentiment_delta between -1 and 1),
  constraint engagement_events_unique unique (post_id, audience)
);

comment on table public.engagement_events is
  'Per-audience simulated response to a post. This is where "open-weight announcement" becomes developer sentiment +12, investor margin concern +5, competitor hostility +4.';

create index engagement_events_post_idx on public.engagement_events (post_id);
create index engagement_events_session_quarter_idx
  on public.engagement_events (session_id, quarter desc);

alter table public.engagement_events enable row level security;

-- ---------------------------------------------------------------------------
-- media_stories
-- ---------------------------------------------------------------------------

create table public.media_stories (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  quarter integer not null,
  outlet text not null,
  journalist_character_id uuid references public.characters (id) on delete set null,
  headline text not null,
  body text,
  angle text,
  subject_company_id uuid references public.companies (id) on delete set null,
  subject_character_id uuid references public.characters (id) on delete set null,
  source_post_id uuid references public.social_posts (id) on delete set null,
  source_event_id uuid,
  credibility numeric not null default 0.6,
  prominence numeric not null default 0.5,
  sentiment numeric not null default 0,
  visibility public.visibility_scope not null default 'public',
  created_at timestamptz not null default now(),
  constraint media_stories_quarter_positive check (quarter >= 1),
  constraint media_stories_headline_len check (char_length(headline) between 1 and 240),
  constraint media_stories_credibility_range check (credibility between 0 and 1),
  constraint media_stories_prominence_range check (prominence between 0 and 1),
  constraint media_stories_sentiment_range check (sentiment between -1 and 1)
);

comment on table public.media_stories is
  'Press amplification. A story reaches audiences a post cannot and is the usual route by which a private failure becomes a public repricing.';

create index media_stories_session_quarter_idx on public.media_stories (session_id, quarter desc);
create index media_stories_subject_company_idx on public.media_stories (subject_company_id);

alter table public.media_stories enable row level security;

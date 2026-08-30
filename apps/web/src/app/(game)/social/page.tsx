'use client';

/**
 * Social — six synthetic networks, one press cycle.
 *
 * Marketing here is an information network, not a modifier. The strict division
 * of labour from `social.ts` is what the screen is built to show: a model may
 * write the words, and only the engine decides what they do. So every figure on
 * a published post comes from `EngagementResult`, the compose preview shows
 * *who is in the room* rather than a reach it cannot know, and every
 * NPC-authored post carries the AI label.
 *
 * Rivals appear only through the redacted projection, and the trending panel is
 * `world.media` — the same four readings every participant sees.
 */

import { useMemo, useState } from 'react';
import type { Audience, MediaStory, NetworkArchetype, SocialPost } from '@frontier/contracts';
import { NETWORK_ARCHETYPES, quarterLabel } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import {
  AiLabel,
  EmptyState,
  Icon,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  SectionHeading,
  StatCard,
  Tag,
} from '@/components/ui';
import { ComposeModal } from '@/components/screens/social/ComposeModal';
import { PostCard } from '@/components/screens/social/PostCard';
import { audienceLabel, countLabel, networkIcon, networkLabel, networkProfile } from '@/components/screens/social/audiences';
import { IconTabs, type IconTabItem } from '@/components/screens/world/IconTabs';
import { useLlm, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

const NARRATIVE_COPY: Readonly<Record<string, string>> = {
  ai_optimism: 'The press is reading every launch as progress.',
  productivity_miracle: 'Coverage is framed around output per worker.',
  bubble_concern: 'Every raise is being read as evidence of a bubble.',
  safety_alarm: 'The same launch that reads as visionary elsewhere reads as reckless now.',
  labour_disruption: 'Employment is the frame; hiring and cuts carry extra weight.',
  concentration_backlash: 'Scale itself is the story. Acquisitions attract scrutiny.',
  geopolitical_race: 'Capability is being covered as national advantage.',
  energy_backlash: 'Datacentre power draw is the angle of the moment.',
  scandal_cycle: 'The cycle is hunting for a villain; a leak travels a long way.',
  neutral: 'No single frame dominates. Stories are being taken on their merits.',
};

export default function SocialPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const llm = useLlm();

  const [network, setNetwork] = useState<NetworkArchetype>('fast_feed');
  const [composing, setComposing] = useState(false);

  const characterById = useMemo(() => new Map(session.characters.map((character) => [character.id, character])), [session.characters]);
  const accountById = useMemo(() => new Map(session.socialAccounts.map((account) => [account.id, account])), [session.socialAccounts]);

  const companyName = useMemo(() => {
    const map = new Map<string, string>();
    map.set(company.id, company.name);
    for (const rival of view.visibleCompanies) {
      if (rival.id !== undefined && rival.name !== undefined) map.set(rival.id, rival.name);
    }
    return map;
  }, [company.id, company.name, view.visibleCompanies]);

  const ownAccounts = useMemo(
    () =>
      session.socialAccounts.filter(
        (account) => account.isActive && (account.ownerCharacterId === founder.id || account.ownerCompanyId === company.id),
      ),
    [session.socialAccounts, founder.id, company.id],
  );

  const byNetwork = useMemo(() => {
    const map = new Map<NetworkArchetype, SocialPost[]>();
    for (const archetype of NETWORK_ARCHETYPES) map.set(archetype, []);
    for (const post of session.socialPosts) map.get(post.network)?.push(post);
    for (const list of map.values()) list.sort((a, b) => b.quarter - a.quarter);
    return map;
  }, [session.socialPosts]);

  const stories: MediaStory[] = useMemo(
    () => [...session.mediaStories].sort((a, b) => b.prominence - a.prominence).slice(0, 8),
    [session.mediaStories],
  );

  const feed = byNetwork.get(network) ?? [];
  const ownFollowing = ownAccounts.reduce((total, account) => total + account.followers, 0);
  const media = session.world.media;

  const tabs: readonly IconTabItem[] = NETWORK_ARCHETYPES.map((archetype) => ({
    id: archetype,
    label: networkLabel(archetype),
    icon: networkIcon(archetype),
    badge: (byNetwork.get(archetype) ?? []).length || undefined,
  }));

  const compose = (
    <>
      <Icon name="plus" size={16} accent="inherit" />
      Compose a post
    </>
  );

  return (
    <>
      <PageHeader
        title="Social"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Six networks, seven audiences and a press cycle that decides which of them hears you."
        actions={
          // From `sm` the action belongs beside the title; on a phone it is the
          // full-width bar below, where a thumb already is.
          <button
            type="button"
            className="btn btn-primary tap-target icon-knockout-brand hidden sm:inline-flex"
            onClick={() => setComposing(true)}
          >
            {compose}
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          iconName="people"
          label="Following"
          value={countLabel(ownFollowing)}
          unit="followers"
          hint={`${ownAccounts.length} account${ownAccounts.length === 1 ? '' : 's'} · ${new Set(ownAccounts.map((a) => a.network)).size} network${
            new Set(ownAccounts.map((a) => a.network)).size === 1 ? '' : 's'
          }`}
        />
        <StatCard
          iconName="chart"
          label="Attention"
          value={formatPct(media.attentionLevel, 0)}
          hint="Share of the news cycle"
          tone={media.attentionLevel > 0.7 ? 'warn' : undefined}
        />
        <StatCard
          iconName="warning"
          label="Controversy"
          value={formatPct(media.controversyIntensity, 0)}
          hint="Heat turns a leak into a story"
          tone={media.controversyIntensity > 0.6 ? 'warn' : undefined}
        />
        <StatCard
          iconName="capitol"
          label="Trust"
          value={formatPct(media.institutionalTrust, 0)}
          hint="Rumours outrun corrections"
          tone={media.institutionalTrust < 0.45 ? 'loss' : undefined}
        />
      </div>

      <IconTabs tabs={tabs} value={network} onChange={(id) => setNetwork(id as NetworkArchetype)} ariaLabel="Networks" />

      {/* The action, directly above the room it posts into. */}
      <button
        type="button"
        className="btn btn-primary btn-lg icon-knockout-brand w-full sm:hidden"
        onClick={() => setComposing(true)}
      >
        {compose}
      </button>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          iconName={networkIcon(network)}
          iconTone="brand"
          title={networkLabel(network)}
          subtitle={`${networkProfile(network).virality.toFixed(2)}x resharing · press affinity ${formatPct(
            networkProfile(network).pressAffinity,
            0,
          )}`}
          flush
        >
          {feed.length === 0 ? (
            <div className="p-3.5">
              <EmptyState
                icon={networkIcon(network)}
                title={`Nothing has been posted on ${networkLabel(network).toLowerCase()} yet`}
                message="Posts appear here once the social phase of a quarter has resolved. Compose one and it is queued for this quarter."
                action={
                  <button type="button" className="btn tap-target" onClick={() => setComposing(true)}>
                    <Icon name="plus" size={15} />
                    Compose a post
                  </button>
                }
              />
            </div>
          ) : (
            <div>
              {feed.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  author={characterById.get(post.authorCharacterId) ?? null}
                  account={accountById.get(post.accountId) ?? null}
                  targetName={post.targetCompanyId === null ? null : (companyName.get(post.targetCompanyId) ?? null)}
                  quarterLabelText={quarterLabel(session.startYear, post.quarter)}
                />
              ))}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel iconName="newspaper" title="Trending narrative" subtitle="The frame every new event is read through">
            <div className="flex flex-col gap-3">
              <div>
                <Tag tone="info" size="md">
                  {media.dominantNarrative.replace(/_/g, ' ')}
                </Tag>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
                  {NARRATIVE_COPY[media.dominantNarrative] ?? 'The press has settled on a frame for the quarter.'}
                </p>
              </div>
              <ProgressBar label="Attention" value={media.attentionLevel} valueLabel={formatPct(media.attentionLevel, 0)} tone="info" />
              <ProgressBar
                label="Controversy"
                value={media.controversyIntensity}
                valueLabel={formatPct(media.controversyIntensity, 0)}
                tone={media.controversyIntensity > 0.6 ? 'warn' : 'brand'}
              />
              <ProgressBar
                label="Institutional trust"
                value={media.institutionalTrust}
                valueLabel={formatPct(media.institutionalTrust, 0)}
                tone={media.institutionalTrust < 0.45 ? 'loss' : 'gain'}
              />
            </div>
          </Panel>

          <Panel iconName="chat" title="Your accounts" subtitle="Credibility is built by being right in public">
            {ownAccounts.length === 0 ? (
              <EmptyState icon="chat" title="No accounts" message="Neither you nor the company holds an active account on any network." compact />
            ) : (
              <ul className="flex flex-col gap-3">
                {ownAccounts.map((account) => (
                  <li key={account.id}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold text-ink">{account.handle}</span>
                      <span className="figure text-[10px] text-ink-faint">{networkLabel(account.network)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
                      <span className="figure">{countLabel(account.followers)} followers</span>
                      {account.verified ? <Tag tone="info">verified</Tag> : <Tag tone="neutral">unverified</Tag>}
                    </div>
                    <div className="mt-1.5">
                      <Meter value={account.credibility * 100} label="Credibility" />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Object.entries(account.audienceMix)
                        .filter(([, share]) => typeof share === 'number' && share > 0)
                        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                        .map(([audience, share]) => (
                          <span key={audience} className="rounded-pill border border-hair bg-raised px-2 py-px text-[10px] text-ink-dim">
                            {audienceLabel(audience as Audience)} {formatPct(share ?? 0, 0)}
                          </span>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel iconName="newspaper" title="Media stories" subtitle="How a private matter becomes a price">
            {stories.length === 0 ? (
              <EmptyState
                icon="newspaper"
                title="The press has not run anything yet"
                message="Stories are generated in the social phase from posts and world events. The first ones appear after a quarter resolves."
                compact
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {stories.map((story) => {
                  const author = story.authorCharacterId === null ? null : characterById.get(story.authorCharacterId);
                  return (
                    <li key={story.id}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[13px] leading-snug font-medium text-ink">{story.headline}</p>
                        <span className="figure shrink-0 text-[10px] text-ink-faint">{quarterLabel(session.startYear, story.quarter)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Tag tone="neutral">{story.angle.replace(/_/g, ' ')}</Tag>
                        <Tag tone={story.sentiment >= 0.2 ? 'gain' : story.sentiment <= -0.2 ? 'loss' : 'neutral'}>
                          sentiment {story.sentiment.toFixed(2)}
                        </Tag>
                        {author === undefined || author === null ? (
                          <span className="text-[10px] text-ink-faint">wire</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] text-ink-faint">
                            {author.name}
                            {author.isPlayer ? null : <AiLabel />}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 grid grid-cols-2 gap-3">
                        <Meter value={story.prominence * 100} label="Prominence" />
                        <Meter value={story.credibility * 100} label="Credibility" />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel iconName="people" title="Who is on each network" subtitle="Published composition from the social subsystem">
            <SectionHeading>{networkLabel(network)}</SectionHeading>
            <ul className="mt-2 flex flex-col gap-1">
              {Object.entries(networkProfile(network).audienceMix)
                .filter(([, share]) => share > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([audience, share]) => (
                  <li key={audience} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="text-ink-dim">{audienceLabel(audience as Audience)}</span>
                    <span className="figure text-ink">{formatPct(share, 0)}</span>
                  </li>
                ))}
            </ul>
          </Panel>
        </div>
      </div>

      {composing ? (
        <ComposeModal
          open
          onClose={() => setComposing(false)}
          founder={founder}
          company={company}
          accounts={session.socialAccounts}
          rivals={view.visibleCompanies}
          sessionId={session.sessionId}
          quarter={session.quarter}
          llmAvailable={llm.available}
          initialNetwork={network}
        />
      ) : null}
    </>
  );
}

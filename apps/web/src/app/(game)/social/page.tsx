'use client';

/**
 * Social — the same feed, narrowed to what people said.
 *
 * There is no second feed in this app. This screen is the universal public
 * record filtered to posts and replies, rendered by the same cards News uses,
 * so a post reads identically wherever you meet it and a thread hangs together
 * on both screens.
 *
 * The strict division of labour from `social.ts` is what the screen shows: a
 * model may write the words, and only the engine decides what they do. Every
 * figure on a card is engine output carried by the projection, the compose
 * preview shows *who is in the room* rather than a reach it cannot know, and
 * every NPC-authored post carries the AI label.
 *
 * What used to be four side panels — trending, your accounts, media stories,
 * network composition — is now a two-line header and a strip: on a phone the
 * feed starts above the fold, and the compose button is a floating action under
 * the thumb rather than a bar somewhere up the page.
 */

import { useMemo, useState } from 'react';
import type { NetworkArchetype, PublicRecordItem, Sector, SimEvent } from '@frontier/contracts';
import { NETWORK_ARCHETYPES, quarterLabel } from '@frontier/contracts';
import { projectPublicRecord } from '@frontier/simulation';
import { formatPct } from '@frontier/shared';
import { AiLabel, Icon, PageHeader, Tag, cx, sectorOf, sectorsPresent } from '@/components/ui';
import { PLAYER_ID, useGame, useLlm, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { allVisibleCompanies } from '@/components/screens/reporting/util';
import { ComposeModal } from '@/components/screens/social/ComposeModal';
import { countLabel, networkIcon, networkLabel } from '@/components/screens/social/audiences';
import { IconTabs, type IconTabItem } from '@/components/screens/world/IconTabs';
import { Feed, countByNetwork, filterFeed, topByReach, type FeedContext } from '@/components/screens/feed';

/** The two kinds this screen shows. A reply is a post that answers another one. */
const POST_KINDS = ['post', 'reply'] as const;

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
  const { lastOutcome } = useGame();

  const [network, setNetwork] = useState<NetworkArchetype | null>(null);
  const [composing, setComposing] = useState(false);

  // Memoised so an empty ledger is the same empty array between renders.
  const ledger = useMemo<readonly SimEvent[]>(() => lastOutcome?.events ?? [], [lastOutcome]);
  const record = useMemo<PublicRecordItem[]>(() => projectPublicRecord(session, PLAYER_ID, { ledger }), [session, ledger]);

  /** Posts and replies only. Everything else on the record lives on News. */
  const posts = useMemo(
    () => filterFeed(record, { kinds: POST_KINDS, sector: null, companyId: null, networks: null }),
    [record],
  );
  const shown = useMemo(
    () => (network === null ? posts : filterFeed(posts, { kinds: null, sector: null, companyId: null, networks: [network] })),
    [posts, network],
  );

  const characters = useMemo(() => new Map(session.characters.map((entry) => [entry.id, entry])), [session.characters]);

  const companyNames = useMemo(() => {
    const map = new Map<string, string>();
    map.set(company.id, company.name);
    for (const entry of allVisibleCompanies(view)) {
      if (entry.id !== undefined && entry.name !== undefined) map.set(entry.id, entry.name);
    }
    return map;
  }, [company.id, company.name, view]);

  const companySectors = useMemo(() => {
    const map = new Map<string, Sector>();
    for (const entry of allVisibleCompanies(view)) {
      if (entry.id !== undefined) map.set(entry.id, sectorOf(entry));
    }
    return map;
  }, [view]);
  const multiSector = useMemo(() => sectorsPresent(allVisibleCompanies(view)).length > 1, [view]);

  const headlines = useMemo(() => new Map(record.map((item) => [item.id, item.headline])), [record]);
  const ledgerById = useMemo(() => new Map(ledger.map((row) => [row.eventId, row])), [ledger]);

  // A fund speaks through its partner, so the feed needs the roster's partner
  // ids to draw an institution's mark on what it publishes. Empty in a world
  // with no institutional layer, which is exactly the gate that keeps the mark
  // off every card in a world-version-1 session.
  const fundPartnerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entity of view.economyReport?.capitalEntities ?? []) {
      if (entity.partnerCharacterId !== null) ids.add(entity.partnerCharacterId);
    }
    return ids;
  }, [view.economyReport]);
  const fundNameByPartnerId = useMemo(() => {
    const names = new Map<string, string>();
    for (const entity of view.economyReport?.capitalEntities ?? []) {
      if (entity.partnerCharacterId !== null) names.set(entity.partnerCharacterId, entity.name);
    }
    return names;
  }, [view.economyReport]);

  const context: FeedContext = useMemo(
    () => ({
      startYear: session.startYear,
      characters,
      companyNames,
      companySectors,
      multiSector,
      playerCharacterId: founder.id,
      playerCompanyId: company.id,
      headlines,
      fundPartnerIds,
      fundNameByPartnerId,
      // Posts carry no pin of their own; the map belongs to News.
      mappedEventIds: new Set<string>(),
    }),
    [session.startYear, characters, companyNames, companySectors, multiSector, founder.id, company.id, headlines, fundPartnerIds, fundNameByPartnerId],
  );

  const ownAccounts = useMemo(
    () =>
      session.socialAccounts.filter(
        (account) => account.isActive && (account.ownerCharacterId === founder.id || account.ownerCompanyId === company.id),
      ),
    [session.socialAccounts, founder.id, company.id],
  );
  const ownFollowing = ownAccounts.reduce((total, account) => total + account.followers, 0);

  const perNetwork = useMemo(() => countByNetwork(posts), [posts]);
  const trending = useMemo(() => topByReach(posts, 3), [posts]);
  const media = session.world.media;

  const tabs: readonly IconTabItem[] = [
    { id: 'all', label: 'All', icon: 'chat', badge: posts.length },
    ...NETWORK_ARCHETYPES.map((archetype) => ({
      id: archetype,
      label: networkLabel(archetype),
      icon: networkIcon(archetype),
      badge: perNetwork.get(archetype) ?? 0,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Social"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Six networks and a press cycle that decides which of them hears you."
      />

      {/* Your accounts, as one line. Followers are whole people. */}
      <div className="scroll-x no-scrollbar -mx-1 px-1">
        <div className="flex w-max items-center gap-1.5">
          <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border border-brand/25 bg-brand-wash px-2.5 text-[11px] font-semibold text-brand">
            <Icon name="people" size={13} accent="inherit" />
            {countLabel(ownFollowing)} following
          </span>
          {ownAccounts.map((account) => (
            <span
              key={account.id}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border border-hair bg-panel px-2.5 text-[11px] text-ink-dim"
            >
              <Icon name={networkIcon(account.network)} size={13} />
              <span className="font-semibold text-ink">{account.handle}</span>
              <span className="figure text-[10px] text-ink-faint">{countLabel(account.followers)}</span>
              {account.verified ? <Icon name="check" size={12} accent="brand" /> : null}
            </span>
          ))}
          {ownAccounts.length === 0 ? (
            <span className="inline-flex h-8 items-center rounded-pill border border-hair bg-panel px-2.5 text-[11px] text-ink-faint">
              No active account yet
            </span>
          ) : null}
        </div>
      </div>

      {/* Trending: the frame the press is using, and the three loudest posts. */}
      <section className="panel-surface px-3 py-2.5" aria-label="Trending">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="info" size="md">
            {media.dominantNarrative.replace(/_/g, ' ')}
          </Tag>
          <span className="figure text-[10px] text-ink-faint">attention {formatPct(media.attentionLevel)}</span>
          <span className="figure text-[10px] text-ink-faint">controversy {formatPct(media.controversyIntensity)}</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ink-dim">
          {NARRATIVE_COPY[media.dominantNarrative] ?? 'The press has settled on a frame for the quarter.'}
        </p>
        {trending.length === 0 ? null : (
          <ol className="mt-2 flex flex-col gap-1.5 border-t border-hair pt-2">
            {trending.map((item, index) => (
              <li key={item.id} className="flex items-baseline gap-2">
                <span className="figure w-4 shrink-0 text-[11px] text-ink-faint">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{item.headline}</span>
                {item.who.isAi ? <AiLabel /> : null}
                <span className="figure shrink-0 text-[10px] text-ink-faint">{countLabel(Math.round(item.reach ?? 0))}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <IconTabs
        ariaLabel="Networks"
        tabs={tabs}
        value={network ?? 'all'}
        onChange={(id) => setNetwork(id === 'all' ? null : (id as NetworkArchetype))}
      />

      <Feed
        items={shown}
        context={context}
        ledgerById={ledgerById}
        emptyIcon="chat"
        emptyTitle={network === null ? 'Nobody has posted yet' : `Nothing on ${networkLabel(network).toLowerCase()} yet`}
        emptyMessage="Posts are published in the social phase when a quarter resolves — yours and everybody else's. Compose one and it is queued for this quarter."
        emptyAction={
          <button type="button" className="btn tap-target" onClick={() => setComposing(true)}>
            <Icon name="plus" size={15} />
            Compose a post
          </button>
        }
      />

      {/* Room for the floating action, so it never covers the last card. */}
      <div aria-hidden="true" className="h-14" />

      {/* The action, where a thumb already is: above the phone's bottom bar, out
          of the way of the last card, and a plain button from `lg`. */}
      <button
        type="button"
        aria-label="Compose a post"
        onClick={() => setComposing(true)}
        // The offset clears the phone's bottom bar the way the action tray does;
        // the notch inset is a margin, so the `lg` override still wins.
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
        className={cx(
          'btn btn-primary icon-knockout-brand fixed right-4 z-20 h-14 gap-2 rounded-pill px-5 shadow-float',
          'bottom-[calc(var(--bottombar-height)+0.75rem)] lg:bottom-6',
        )}
      >
        <Icon name="plus" size={18} accent="inherit" />
        Compose
      </button>

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
          initialNetwork={network ?? 'fast_feed'}
        />
      ) : null}
    </>
  );
}

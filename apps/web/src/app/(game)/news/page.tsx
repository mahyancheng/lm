'use client';

/**
 * News — one feed, and the map it happens on.
 *
 * This screen used to be a dashboard: five stacked panels that partitioned the
 * public record by which table a row came from and labelled every row by who
 * wrote it. That is not how anybody reads news. It is now a **single universal
 * stream** — world events, press coverage, filings, posts and replies, from
 * everyone including the player, in the one reverse-chronological list the
 * engine projects.
 *
 * The rules the screen keeps:
 *
 * - **No partition by author.** The player's own line sits in the stream with a
 *   "you" chip and nothing else. There is no "us" panel and no "others" panel.
 * - **Filters narrow a subject, never a side.** Kind, sector and company; that
 *   is the whole of it, in one sticky row.
 * - **The projection is the truth.** `projectPublicRecord` redacts to this seat
 *   before the screen sees anything, so nothing here re-filters for visibility
 *   and nothing here can widen it.
 * - **Chrome fits above the fold.** Title, two tabs and one filter row on a
 *   390px phone; the first card is on screen.
 *
 * The map is the second tab rather than a hero above the feed, and any event in
 * the stream can still be shown on it. The press wire, the causal chains and
 * the newsroom conditions are gone as panels: a cascade is a "Follows:" line on
 * the item it explains, and the four press readings live under the map.
 */

import { useMemo, useState } from 'react';
import type { PublicRecordItem, Sector, SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { projectPublicRecord } from '@frontier/simulation';
import { formatPct } from '@frontier/shared';
import {
  Icon,
  KeyValueGrid,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  sectorOf,
  sectorsPresent,
} from '@/components/ui';
import { PLAYER_ID, useGame, useLlm, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { WorldMap } from '@/components/scenes/map';
import { QuarterInReview } from '@/components/screens/news/QuarterInReview';
import { IconTabs } from '@/components/screens/world/IconTabs';
import {
  Feed,
  FeedFilterBar,
  companiesInFeed,
  countByKindGroup,
  countBySector,
  filterFeed,
  kindsOfGroup,
  sectorsInFeed,
  type FeedContext,
  type FeedKindGroup,
} from '@/components/screens/feed';
import { allVisibleCompanies, bandLabel, humanise } from '@/components/screens/reporting/util';

type WorldTab = 'feed' | 'map';

export default function NewsPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const llm = useLlm();
  const { lastOutcome } = useGame();

  const [tab, setTab] = useState<WorldTab>('feed');
  const [group, setGroup] = useState<FeedKindGroup | null>(null);
  const [sector, setSector] = useState<Sector | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);

  /* --- the record ---------------------------------------------------------
      One call, already redacted and already ordered. The ledger is the seat's
      own projected rows, which only fills in `ledgerEventIds`; it can never add
      an item the projection withheld. */
  // Memoised, so an empty ledger is the same empty array between renders and the
  // projection is not rebuilt for every keystroke elsewhere in the tree.
  const ledger = useMemo<readonly SimEvent[]>(() => lastOutcome?.events ?? [], [lastOutcome]);
  const items = useMemo<PublicRecordItem[]>(() => projectPublicRecord(session, PLAYER_ID, { ledger }), [session, ledger]);

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

  // The multi-sector test is the world's own shape, never a version number: a
  // single-sector session simply gets no sector chips.
  const multiSector = useMemo(() => sectorsPresent(allVisibleCompanies(view)).length > 1, [view]);

  const headlines = useMemo(() => new Map(items.map((item) => [item.id, item.headline])), [items]);
  const ledgerById = useMemo(() => new Map(ledger.map((row) => [row.eventId, row])), [ledger]);
  const mappedEventIds = useMemo(
    () => new Set(view.activeEvents.filter((event) => event.visibility === 'public').map((event) => event.id)),
    [view.activeEvents],
  );

  /* --- filters ------------------------------------------------------------
      Sector and company narrow the subject; the kind chips then narrow within
      what is left, which is why their counts are taken from `scoped` rather
      than from everything. */
  const scoped = useMemo(
    () => filterFeed(items, { kinds: null, sector, companyId, networks: null }, companySectors),
    [items, sector, companyId, companySectors],
  );
  const shown = useMemo(
    () =>
      group === null
        ? scoped
        : filterFeed(scoped, { kinds: kindsOfGroup(group), sector: null, companyId: null, networks: null }, companySectors),
    [scoped, group, companySectors],
  );

  const kindCounts = useMemo(() => countByKindGroup(scoped), [scoped]);
  const sectorOptions = useMemo(
    () => (multiSector ? sectorsInFeed(items, companySectors) : []),
    [items, companySectors, multiSector],
  );
  const sectorCounts = useMemo(() => countBySector(items, companySectors), [items, companySectors]);
  const companyOptions = useMemo(
    () =>
      companiesInFeed(items).map((entry) => ({
        id: entry.id,
        name: companyNames.get(entry.id) ?? entry.id,
        count: entry.count,
      })),
    [items, companyNames],
  );

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
      mappedEventIds,
      onShowOnMap: (eventId: string) => {
        setFocusEventId(eventId);
        setTab('map');
      },
    }),
    [session.startYear, characters, companyNames, companySectors, multiSector, founder.id, company.id, headlines, mappedEventIds, fundPartnerIds, fundNameByPartnerId],
  );

  const media = view.world.media;
  const unfiltered = group === null && sector === null && companyId === null;

  return (
    <>
      <PageHeader
        title="News"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · the public record`}
        subtitle="Everything said on the record, in one stream. Private facts do not appear until somebody publishes them."
      />

      <IconTabs
        ariaLabel="News view"
        tabs={[
          { id: 'feed', label: 'Feed', icon: 'newspaper', badge: items.length },
          { id: 'map', label: 'Map', icon: 'globe' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as WorldTab)}
      />

      {tab === 'feed' ? (
        <>
          <FeedFilterBar
            group={group}
            onGroupChange={setGroup}
            counts={kindCounts}
            total={scoped.length}
            sectors={sectorOptions}
            sectorCounts={sectorCounts}
            sector={sector}
            onSectorChange={setSector}
            companies={companyOptions}
            companyId={companyId}
            onCompanyChange={setCompanyId}
          />

          <Feed
            items={shown}
            context={context}
            ledgerById={ledgerById}
            // The quarter in review is the first card of the newest quarter, not
            // a panel stacked above the stream. It is suppressed under a filter,
            // where a summary of everything would be the one thing that does not
            // match the filter.
            leadCard={
              unfiltered && lastOutcome !== null ? (
                <div className="panel-surface px-3 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="newspaper" size={16} />
                    <span className="label-caps">Quarter in review</span>
                  </div>
                  <QuarterInReview
                    report={lastOutcome.report}
                    startYear={session.startYear}
                    focusCompanyId={company.id}
                    modelAvailable={llm.available}
                  />
                </div>
              ) : null
            }
          />
        </>
      ) : (
        <>
          <Panel
            iconName="globe"
            iconTone="info"
            title="The world this quarter"
            subtitle="Tap a head office, an agency, a district or an event pin. Drag to pan; the stops zoom."
            flush
          >
            <WorldMap className="rounded-none" focusEventId={focusEventId} onFocusHandled={() => setFocusEventId(null)} />
          </Panel>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              iconName="newspaper"
              label="Narrative"
              value={<span className="text-[15px] leading-tight">{humanise(media.dominantNarrative)}</span>}
              hint="Frames every new event"
            />
            <StatCard iconName="chart" label="Attention" value={formatPct(media.attentionLevel)} hint="Share of the news cycle" />
            <StatCard
              iconName="warning"
              label="Controversy"
              value={bandLabel(media.controversyIntensity, ['Quiet', 'Simmering', 'Active', 'Hot', 'Incendiary'])}
              tone={media.controversyIntensity >= 0.6 ? 'warn' : undefined}
              iconTone={media.controversyIntensity >= 0.6 ? 'warn' : 'neutral'}
              hint={`Intensity ${formatPct(media.controversyIntensity)}`}
            />
            <StatCard iconName="capitol" label="Trust" value={formatPct(media.institutionalTrust)} hint="Rumours outrun corrections" />
          </div>

          <Panel iconName="chat" title="Newsroom conditions" subtitle="What the press is like this quarter.">
            <KeyValueGrid
              columns={1}
              items={[
                { label: 'Narrative', value: humanise(media.dominantNarrative), mono: false },
                { label: 'Attention', value: formatPct(media.attentionLevel) },
                { label: 'Controversy', value: formatPct(media.controversyIntensity) },
                { label: 'Institutional trust', value: formatPct(media.institutionalTrust) },
                { label: 'Public AI trust', value: formatPct(view.world.society.aiTrust) },
                { label: 'Automation anxiety', value: formatPct(view.world.society.automationAnxiety) },
              ]}
            />
            <ProgressBar
              className="mt-3"
              label="Controversy intensity"
              value={media.controversyIntensity}
              tone={media.controversyIntensity >= 0.6 ? 'loss' : media.controversyIntensity >= 0.35 ? 'warn' : 'info'}
              valueLabel={formatPct(media.controversyIntensity)}
            />
            <p className="mt-2 text-[10px] text-ink-faint">
              High controversy raises the chance that a leak becomes a story, which is how a private fact reaches the share price.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

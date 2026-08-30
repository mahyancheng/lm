'use client';

/**
 * World — the map, and the public record underneath it.
 *
 * The screen opens on the place the economy happens: a stylised bay with a head
 * office for every company the player can see, civic buildings for the
 * agencies, sheds for the compute domain, a port for the energy, and the world
 * state painted over the top of it. Every active public event plants a pin
 * where it belongs.
 *
 * Beneath the map is the **chronicle**: world events, press stories and
 * disclosures, interleaved and grouped by the quarter they landed in. Events
 * carry their severity, their duration and, critically, their causal parent — a
 * cascade reads as one story rather than five coincidences. Disclosures carry
 * their credibility; nothing renders `isTruthful`, which is internal and stays
 * that way.
 *
 * The two halves are wired together: any event on the chronicle can be shown on
 * the map, which selects its pin and opens its card.
 *
 * Every NPC-authored line is labelled.
 */

import { useMemo, useRef, useState } from 'react';
import type { PublicDisclosure } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatPct, formatScore } from '@frontier/shared';
import {
  AiLabel,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  TabBar,
  Tag,
  cx,
  type Tone,
} from '@/components/ui';
import { useGame, useLlm, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { WorldMap } from '@/components/scenes/map';
import { QuarterInReview } from '@/components/screens/news/QuarterInReview';
import { bandLabel, companyNameOf, formatCount, humanise } from '@/components/screens/reporting/util';

type RecordKind = 'event' | 'story' | 'disclosure';

interface RecordItem {
  readonly id: string;
  readonly kind: RecordKind;
  readonly quarter: number;
  readonly topic: string;
  readonly title: string;
  readonly body: string;
  readonly tone: Tone;
  readonly weight: number;
  readonly sectors: readonly string[];
  readonly companies: readonly string[];
  readonly causalParentId: string | null;
  readonly severity: number | null;
  readonly credibility: number | null;
  readonly sentiment: number | null;
  readonly durationQuarters: number | null;
  readonly authorName: string | null;
  readonly authorIsAi: boolean;
  /** The event this row can point at on the map, when there is one. */
  readonly mapEventId: string | null;
}

const KIND_LABEL: Readonly<Record<RecordKind, string>> = {
  event: 'World event',
  story: 'Press',
  disclosure: 'Disclosure',
};

const KIND_TONE: Readonly<Record<RecordKind, Tone>> = {
  event: 'warn',
  story: 'info',
  disclosure: 'neutral',
};

/** The filter selects sit in a panel header, which is shorter than a form row. */
const FILTER_STYLE: React.CSSProperties = { height: 24, width: 'auto', paddingTop: 0, paddingBottom: 0, fontSize: 11 };

export default function WorldPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const llm = useLlm();
  const { lastOutcome } = useGame();

  const [kind, setKind] = useState<'all' | RecordKind>('all');
  const [quarter, setQuarter] = useState<'all' | string>('all');
  const [topic, setTopic] = useState<'all' | string>('all');
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);

  const characters = useMemo(() => new Map(session.characters.map((entry) => [entry.id, entry])), [session.characters]);

  /** The events that actually have a pin. Only these get a "show on map". */
  const mappedEventIds = useMemo(
    () => new Set(view.activeEvents.filter((event) => event.visibility === 'public').map((event) => event.id)),
    [view.activeEvents],
  );

  function showOnMap(eventId: string): void {
    setFocusEventId(eventId);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const items = useMemo<RecordItem[]>(() => {
    const out: RecordItem[] = [];

    for (const event of view.activeEvents) {
      if (event.visibility !== 'public') continue;
      out.push({
        id: event.id,
        kind: 'event',
        quarter: event.quarter,
        topic: event.type,
        title: event.title,
        body: event.description,
        tone: event.severity >= 0.6 ? 'loss' : event.severity >= 0.35 ? 'warn' : 'neutral',
        weight: event.severity,
        sectors: event.affectedSectorIds,
        companies: event.affectedCompanyIds,
        causalParentId: event.causalParentId,
        severity: event.severity,
        credibility: null,
        sentiment: null,
        durationQuarters: event.durationQuarters,
        authorName: null,
        authorIsAi: false,
        mapEventId: event.id,
      });
    }

    for (const story of session.mediaStories) {
      const author = story.authorCharacterId === null ? null : characters.get(story.authorCharacterId) ?? null;
      out.push({
        id: story.id,
        kind: 'story',
        quarter: story.quarter,
        topic: story.angle,
        title: story.headline,
        body: story.body,
        tone: story.sentiment <= -0.3 ? 'loss' : story.sentiment >= 0.3 ? 'gain' : 'info',
        weight: story.prominence,
        sectors: [],
        companies: story.subjectCompanyIds,
        causalParentId: story.sourceEventId,
        severity: null,
        credibility: story.credibility,
        sentiment: story.sentiment,
        durationQuarters: null,
        authorName: author?.name ?? 'Wire coverage',
        authorIsAi: author === null ? true : !author.isPlayer,
        // A story points at the event it was written about, when that event is
        // still on the map.
        mapEventId: story.sourceEventId !== null && mappedEventIds.has(story.sourceEventId) ? story.sourceEventId : null,
      });
    }

    for (const disclosure of view.disclosures) {
      const source = disclosure.sourceCharacterId === null ? null : characters.get(disclosure.sourceCharacterId) ?? null;
      out.push({
        id: disclosure.id,
        kind: 'disclosure',
        quarter: disclosure.quarter,
        topic: disclosure.kind,
        title: disclosure.headline,
        body: disclosure.body,
        tone: disclosure.kind === 'leak' || disclosure.kind === 'rumour' ? 'warn' : 'neutral',
        weight: disclosure.credibility,
        sectors: [],
        companies: disclosure.companyId === null ? [] : [disclosure.companyId],
        causalParentId: null,
        severity: null,
        credibility: disclosure.credibility,
        sentiment: null,
        durationQuarters: null,
        authorName: source?.name ?? null,
        authorIsAi: source === null ? false : !source.isPlayer,
        mapEventId: null,
      });
    }

    return out.sort((a, b) => (b.quarter !== a.quarter ? b.quarter - a.quarter : b.weight - a.weight || a.id.localeCompare(b.id)));
  }, [view.activeEvents, view.disclosures, session.mediaStories, characters, mappedEventIds]);

  const topics = useMemo(() => {
    const set = new Set(items.filter((item) => kind === 'all' || item.kind === kind).map((item) => item.topic));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items, kind]);

  const quarters = useMemo(() => {
    const set = new Set(items.map((item) => item.quarter));
    return [...set].sort((a, b) => b - a);
  }, [items]);

  const filtered = items.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      (quarter === 'all' || item.quarter === Number(quarter)) &&
      (topic === 'all' || item.topic === topic),
  );

  const grouped = useMemo(() => {
    const map = new Map<number, RecordItem[]>();
    for (const item of filtered) {
      const bucket = map.get(item.quarter);
      if (bucket === undefined) map.set(item.quarter, [item]);
      else bucket.push(item);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }, [filtered]);

  const eventsById = useMemo(() => new Map(view.activeEvents.map((event) => [event.id, event])), [view.activeEvents]);

  const chains = useMemo(() => {
    const roots = view.activeEvents.filter((event) => event.visibility === 'public' && event.causalParentId === null);
    return roots
      .map((root) => ({
        root,
        children: view.activeEvents.filter((event) => event.causalParentId === root.id),
      }))
      .filter((chain) => chain.children.length > 0);
  }, [view.activeEvents]);

  /** The press wire: the loudest stories, whoever wrote them. */
  const wire = useMemo(
    () =>
      session.mediaStories
        .slice()
        .sort((a, b) => (b.quarter !== a.quarter ? b.quarter - a.quarter : b.prominence - a.prominence || a.id.localeCompare(b.id)))
        .slice(0, 6),
    [session.mediaStories],
  );

  const media = view.world.media;
  const counts = {
    event: items.filter((item) => item.kind === 'event').length,
    story: items.filter((item) => item.kind === 'story').length,
    disclosure: items.filter((item) => item.kind === 'disclosure').length,
  };

  function disclosureMetrics(item: RecordItem): PublicDisclosure | null {
    return view.disclosures.find((entry) => entry.id === item.id) ?? null;
  }

  return (
    <>
      <PageHeader
        title="World"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · the public record`}
        subtitle="The map is the economy as a place. Below it, everything said on the record. Private facts do not appear here until somebody publishes them."
        actions={
          <Tag tone="neutral">
            {counts.event} events · {counts.story} stories · {counts.disclosure} disclosures
          </Tag>
        }
      />

      <div ref={mapRef} className="scroll-mt-4">
        <Panel
          title="The world this quarter"
          subtitle="Tap a head office, an agency, a district or an event pin. Everything here is public information."
          flush
        >
          <WorldMap className="rounded-none" focusEventId={focusEventId} onFocusHandled={() => setFocusEventId(null)} />
        </Panel>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Dominant narrative"
          value={humanise(media.dominantNarrative)}
          hint="Biases how every new event is interpreted"
        />
        <StatCard label="Attention" value={formatPct(media.attentionLevel)} hint="Share of the news cycle the industry occupies" />
        <StatCard
          label="Controversy"
          value={bandLabel(media.controversyIntensity, ['Quiet', 'Simmering', 'Active', 'Hot', 'Incendiary'])}
          tone={media.controversyIntensity >= 0.6 ? 'warn' : undefined}
          hint={`Intensity ${formatPct(media.controversyIntensity)}`}
        />
        <StatCard
          label="Institutional trust"
          value={formatPct(media.institutionalTrust)}
          hint="Low trust makes rumours travel further than corrections"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <TabBar
            ariaLabel="Record kind"
            tabs={[
              { id: 'all', label: 'Everything', badge: items.length },
              { id: 'event', label: 'World events', badge: counts.event },
              { id: 'story', label: 'Press', badge: counts.story },
              { id: 'disclosure', label: 'Disclosures', badge: counts.disclosure },
            ]}
            value={kind}
            onChange={(id) => {
              setKind(id as 'all' | RecordKind);
              setTopic('all');
            }}
          />

          <Panel
            title="The chronicle"
            subtitle={`${filtered.length} item${filtered.length === 1 ? '' : 's'} matching the current filter.`}
            actions={
              <>
                <select className="field" style={FILTER_STYLE} value={quarter} onChange={(event) => setQuarter(event.target.value)}>
                  <option value="all">All quarters</option>
                  {quarters.map((entry) => (
                    <option key={entry} value={String(entry)}>
                      {quarterLabel(session.startYear, entry)}
                    </option>
                  ))}
                </select>
                <select className="field" style={FILTER_STYLE} value={topic} onChange={(event) => setTopic(event.target.value)}>
                  <option value="all">All topics</option>
                  {topics.map((entry) => (
                    <option key={entry} value={entry}>
                      {humanise(entry)}
                    </option>
                  ))}
                </select>
              </>
            }
          >
            {grouped.length === 0 ? (
              <EmptyState
                glyph="NW"
                title="Nothing on the record for this filter"
                message="The world publishes as it resolves: events fire, the press picks them up and companies file. Quarter 0 opens with only what the seed world has already said."
              />
            ) : (
              <div className="flex flex-col gap-5">
                {grouped.map(([groupQuarter, rows]) => (
                  <div key={groupQuarter}>
                    <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-hair pb-1">
                      <span className="label-caps">{quarterLabel(session.startYear, groupQuarter)}</span>
                      <span className="figure text-[10px] text-ink-faint">{rows.length}</span>
                    </div>
                    <ul className="flex flex-col gap-3">
                      {rows.map((item) => {
                        const parent = item.causalParentId === null ? null : eventsById.get(item.causalParentId) ?? null;
                        const disclosure = item.kind === 'disclosure' ? disclosureMetrics(item) : null;
                        return (
                          <li key={item.id} className="raised-surface px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <Tag tone={KIND_TONE[item.kind]} dot>
                                {KIND_LABEL[item.kind]}
                              </Tag>
                              <Tag>{humanise(item.topic)}</Tag>
                              {item.severity === null ? null : (
                                <span className="figure text-[10px] text-ink-faint">severity {formatScore(item.severity * 100)}</span>
                              )}
                              {item.durationQuarters === null ? null : (
                                <span className="figure text-[10px] text-ink-faint">
                                  {item.durationQuarters}q active
                                </span>
                              )}
                              {item.authorIsAi ? <AiLabel /> : null}
                              {item.mapEventId === null ? null : (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost ml-auto"
                                  onClick={() => showOnMap(item.mapEventId ?? '')}
                                >
                                  {item.kind === 'event' ? 'Show on map' : 'Source on map'}
                                </button>
                              )}
                            </div>

                            <p className={cx('mt-1.5 text-[13px] leading-snug font-medium', `tone-${item.tone}`)}>{item.title}</p>
                            <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{item.body}</p>

                            {parent === null ? null : (
                              <p className="mt-1.5 border-l-2 border-hair-strong pl-2 text-[11px] text-ink-faint">
                                Follows from <span className="text-ink-dim">{parent.title}</span> ·{' '}
                                {quarterLabel(session.startYear, parent.quarter)}
                              </p>
                            )}

                            {item.sectors.length > 0 || item.companies.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.sectors.map((sector) => (
                                  <Tag key={sector} tone="neutral">
                                    {humanise(sector)}
                                  </Tag>
                                ))}
                                {item.companies.map((companyId) => (
                                  <Tag key={companyId} tone={companyId === company.id ? 'brand' : 'neutral'}>
                                    {companyNameOf(view, companyId)}
                                  </Tag>
                                ))}
                              </div>
                            ) : null}

                            {item.credibility === null ? null : (
                              <div className="mt-2 flex items-center gap-2">
                                <span className="label-caps-faint shrink-0">Credibility</span>
                                <Meter className="flex-1" value={item.credibility * 100} />
                              </div>
                            )}

                            {item.sentiment === null ? null : (
                              <p className="mt-1 text-[10px] text-ink-faint">
                                Tone toward the subject {item.sentiment >= 0 ? '+' : ''}
                                {item.sentiment.toFixed(2)} · reach{' '}
                                {formatCount(session.mediaStories.find((story) => story.id === item.id)?.reach ?? 0)}
                              </p>
                            )}

                            {disclosure === null || Object.keys(disclosure.metrics).length === 0 ? null : (
                              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-hair pt-2 sm:grid-cols-3">
                                {Object.entries(disclosure.metrics).map(([key, value]) => (
                                  <div key={key} className="flex items-baseline justify-between gap-2">
                                    <dt className="truncate text-[10px] text-ink-faint">{key}</dt>
                                    <dd className="figure text-[10px] text-ink-dim">
                                      {Math.abs(value) >= 1000
                                        ? formatCount(value)
                                        : Number.isInteger(value)
                                          ? String(value)
                                          : value.toFixed(2)}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            )}

                            {item.authorName === null ? null : (
                              <p className="mt-2 text-[10px] text-ink-faint">{item.authorName}</p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Quarter in review" subtitle="Written over the committed report, never over anything else.">
            <QuarterInReview
              report={lastOutcome?.report ?? null}
              startYear={session.startYear}
              focusCompanyId={company.id}
              modelAvailable={llm.available}
            />
          </Panel>

          <Panel title="Press wire" subtitle="The loudest coverage, most recent first.">
            {wire.length === 0 ? (
              <EmptyState
                compact
                title="The wire is quiet"
                message="Stories are written when something happens and the press decides it matters. Resolve a quarter and the newsroom follows."
              />
            ) : (
              <ul className="flex flex-col gap-2.5">
                {wire.map((story) => {
                  const author = story.authorCharacterId === null ? null : characters.get(story.authorCharacterId) ?? null;
                  const tone: Tone = story.sentiment <= -0.3 ? 'loss' : story.sentiment >= 0.3 ? 'gain' : 'info';
                  const mapped = story.sourceEventId !== null && mappedEventIds.has(story.sourceEventId);
                  return (
                    <li key={story.id} className="border-b border-hair pb-2.5 last:border-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Tag tone={tone} dot>
                          {humanise(story.angle)}
                        </Tag>
                        <span className="figure text-[10px] text-ink-faint">
                          {quarterLabel(session.startYear, story.quarter)}
                        </span>
                        {author === null || !author.isPlayer ? <AiLabel /> : null}
                      </div>
                      <p className="mt-1 text-[12px] leading-snug font-medium text-ink">{story.headline}</p>
                      <p className="mt-0.5 text-[10px] text-ink-faint">
                        {author?.name ?? 'Wire coverage'} · reach {formatCount(story.reach)}
                      </p>
                      {mapped && story.sourceEventId !== null ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost mt-1.5"
                          onClick={() => showOnMap(story.sourceEventId ?? '')}
                        >
                          Source on map
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Causal chains" subtitle="One cause, several consequences.">
            {chains.length === 0 ? (
              <EmptyState
                compact
                title="No cascades in flight"
                message="An event that raises the odds of another creates a parent-child chain rather than two unrelated shocks."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {chains.map((chain) => (
                  <li key={chain.root.id}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-ink">{chain.root.title}</p>
                        <p className="text-[10px] text-ink-faint">{quarterLabel(session.startYear, chain.root.quarter)}</p>
                      </div>
                      {mappedEventIds.has(chain.root.id) ? (
                        <button type="button" className="btn btn-sm btn-ghost shrink-0" onClick={() => showOnMap(chain.root.id)}>
                          Map
                        </button>
                      ) : null}
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-1 border-l border-hair-strong pl-3">
                      {chain.children.map((child) => (
                        <li key={child.id} className="text-[11px] text-ink-dim">
                          {child.title}
                          <span className="text-ink-faint"> · {quarterLabel(session.startYear, child.quarter)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Newsroom conditions" subtitle="What the press is like this quarter.">
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
        </div>
      </div>
    </>
  );
}

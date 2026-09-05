'use client';

/**
 * News — the front page of The Frontier Ledger.
 *
 * The public record, printed the way a paper prints it: one edition — the most
 * recently resolved quarter — laid out by importance. The heaviest item leads
 * at display size; the next few form a second tier; everything else is a brief.
 * Earlier quarters are editions, one line each at the bottom, and open on a
 * tap. Nothing from another quarter is mounted on the front page.
 *
 * The rules the screen keeps:
 *
 * - **The projection is the truth.** `projectPublicRecord` redacts to this seat
 *   before the screen sees anything, and writes the headline, the deck and the
 *   kicker. The screen decides sizes and positions, never words.
 * - **Importance is the layout.** Items arrive in engine order — heaviest first
 *   — and the lead, the tier and the briefs are that order made visible. Nothing
 *   here re-sorts.
 * - **No partition by author.** The reader's own lines carry a "you" kicker and
 *   a brand rule; there is no "us" section. "Mine" narrows to them and is the
 *   only narrowing by side, and it is a toggle the reader flips.
 * - **The ledger comes from the store, not from the last resolve.** `useLedger`
 *   is rebuilt by the replay on a reload, so "Sources" lists the same rows after
 *   a refresh as after a resolve. The old screen read `lastOutcome`, which is
 *   null on every fresh load; that is why its "Why" button vanished.
 * - **Sections live in the URL.** `?section=street&mine=1` survives a trip to
 *   another screen and back.
 * - **Chrome fits above the fold.** Masthead and section strip together are
 *   under 120px, so the lead headline is on screen on a 390×844 phone.
 * - **The route is client-rendered.** `useSearchParams` bails the static
 *   prerender out to the client, so `next build` ships the shell and the paper
 *   is laid out in the browser behind the shell's replay overlay. The
 *   unmeasured fallback in the newspaper components covers the first client
 *   render, before the canvas measurer arrives, not a server-rendered page.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicRecordItem, Sector, SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { clipHeadline, headlineFromText, projectEditionIndex, projectPublicRecord } from '@frontier/simulation';
import { sectorOf, sectorsPresent } from '@/components/ui';
import { PLAYER_ID, useLedger, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { LedgerDrawer } from '@/components/screens/reporting/LedgerDrawer';
import { allVisibleCompanies, visibleActiveModifiers } from '@/components/screens/reporting/util';
import { companiesInFeed, countBySector, filterFeed, isOwnItem, sectorsInFeed } from '@/components/screens/feed/filters';
import {
  EarlierEditions,
  FilterSheet,
  FrontPage,
  Masthead,
  SectionStrip,
  StorySheet,
  WorldSection,
  kindsOfSection,
  resolveEdition,
  useElementWidth,
  useNewsParams,
  useTypeMeasure,
  type NewsContext,
  type NewsSection,
} from '@/components/screens/news';

const EMPTY_COPY: Readonly<Record<NewsSection, { readonly title: string; readonly message: string }>> = {
  front: { title: 'Nothing reached the record this quarter', message: 'No event, no coverage, no filing, no post. The next edition prints when a quarter ends.' },
  markets: { title: 'No filings this edition', message: 'Guidance, earnings, press releases, rumours and leaks land here when companies and their sources speak.' },
  press: { title: 'No press this edition', message: 'Stories are written when an event or a post is loud enough for the wire to pick up.' },
  street: { title: 'Nobody posted this edition', message: 'Posts and replies land here in the social phase when a quarter resolves — yours and everybody else\'s.' },
  world: { title: 'No world events this edition', message: 'The world was quiet. The map and the modifiers still in force are below.' },
};

export default function NewsPage(): React.JSX.Element {
  // `useSearchParams` reads the request at render, which the static prerender
  // cannot know; the boundary lets the shell prerender while this route bails
  // out to the client, where the paper is laid out.
  return (
    <Suspense fallback={null}>
      <NewsScreen />
    </Suspense>
  );
}

function NewsScreen(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const ledger = useLedger();
  const [params, setParams] = useNewsParams();
  const { measurer, serif } = useTypeMeasure();
  const [columnRef, widthPx] = useElementWidth<HTMLDivElement>();

  const [selected, setSelected] = useState<PublicRecordItem | null>(null);
  const [openRow, setOpenRow] = useState<SimEvent | null>(null);
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);

  /* --- editions -----------------------------------------------------------
      The cheap index of every quarter on the record, and the one quarter the
      page prints. The full projection runs for that quarter alone. */
  const editions = useMemo(() => projectEditionIndex(session, PLAYER_ID), [session]);
  const quarters = useMemo(() => editions.map((edition) => edition.quarter), [editions]);
  const edition = resolveEdition(params.edition, quarters);

  const items = useMemo<PublicRecordItem[]>(() => {
    if (edition === null) return [];
    return projectPublicRecord(session, PLAYER_ID, { ledger, sinceQuarter: edition, limit: Number.POSITIVE_INFINITY }).filter(
      (item) => item.quarter === edition,
    );
  }, [session, ledger, edition]);

  /* --- lookups ------------------------------------------------------------ */
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

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const ledgerById = useMemo(() => new Map(ledger.map((row) => [row.eventId, row])), [ledger]);

  // Headlines for anything an item can follow from, this edition or another:
  // the same writing rules the projection applies, over the raw tables.
  const headlineOf = useMemo(() => {
    const cache = new Map<string, string>();
    return (id: string): string | null => {
      const here = byId.get(id);
      if (here !== undefined) return here.headline;
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const event = session.activeEvents.find((entry) => entry.id === id);
      const text =
        event !== undefined
          ? clipHeadline(event.title, 90)
          : (session.mediaStories.find((entry) => entry.id === id)?.headline ??
            session.disclosures.find((entry) => entry.id === id)?.headline ??
            (() => {
              const post = session.socialPosts.find((entry) => entry.id === id);
              return post === undefined ? null : headlineFromText(post.text);
            })());
      if (text === null) return null;
      const written = clipHeadline(text, 90);
      cache.set(id, written);
      return written;
    };
  }, [byId, session.activeEvents, session.mediaStories, session.disclosures, session.socialPosts]);

  const quarterOf = useCallback(
    (id: string): number | null =>
      session.activeEvents.find((entry) => entry.id === id)?.quarter ??
      session.mediaStories.find((entry) => entry.id === id)?.quarter ??
      session.disclosures.find((entry) => entry.id === id)?.quarter ??
      session.socialPosts.find((entry) => entry.id === id)?.quarter ??
      null,
    [session.activeEvents, session.mediaStories, session.disclosures, session.socialPosts],
  );

  // Every id the ledger can hold, named for a reader: a company, a person, a
  // record item (by its headline), a fund, an agency, a node on the map. What
  // this cannot name, the Sources list does not print.
  const resolveName = useMemo(() => {
    const funds = new Map<string, string>();
    for (const entity of view.economyReport?.capitalEntities ?? []) funds.set(entity.entityId, entity.name);
    const agencies = new Map(session.agencies.map((agency) => [agency.id, agency.name]));
    const nodes = new Map(session.techGraph.nodes.map((node) => [node.id, node.title]));
    return (id: string): string | null =>
      companyNames.get(id) ?? characters.get(id)?.name ?? funds.get(id) ?? agencies.get(id) ?? nodes.get(id) ?? headlineOf(id);
  }, [companyNames, characters, view.economyReport, session.agencies, session.techGraph.nodes, headlineOf]);

  // The store holds the rows of the quarter that most recently resolved; an
  // earlier edition's items cite nothing, and the sheet says so plainly.
  const ledgerIsCurrent = edition !== null && edition === quarters[0];

  const mappedEventIds = useMemo(
    () => new Set(view.activeEvents.filter((event) => event.visibility === 'public').map((event) => event.id)),
    [view.activeEvents],
  );

  /* --- narrowing ---------------------------------------------------------- */
  const sectionItems = useMemo(() => {
    const kinds = kindsOfSection(params.section);
    const narrowed = filterFeed(items, { kinds, sector: params.sector, companyId: params.companyId, networks: null }, companySectors);
    return params.mine ? narrowed.filter((item) => isOwnItem(item, founder.id, company.id)) : narrowed;
  }, [items, params.section, params.sector, params.companyId, params.mine, companySectors, founder.id, company.id]);

  const sectorOptions = useMemo(() => (multiSector ? sectorsInFeed(items, companySectors) : []), [items, companySectors, multiSector]);
  const sectorCounts = useMemo(() => countBySector(items, companySectors), [items, companySectors]);
  const companyOptions = useMemo(
    () => companiesInFeed(items).map((entry) => ({ id: entry.id, name: companyNames.get(entry.id) ?? entry.id, count: entry.count })),
    [items, companyNames],
  );
  const filterable = sectorOptions.length >= 2 || companyOptions.length >= 2;
  const filterCount = (params.sector === null ? 0 : 1) + (params.companyId === null ? 0 : 1);

  const modifiers = useMemo(() => visibleActiveModifiers(session.activeModifiers, new Set([company.id])), [session.activeModifiers, company.id]);

  /* --- opening a story ---------------------------------------------------- */
  const onOpen = useCallback((item: PublicRecordItem) => setSelected(item), []);

  // "Follows:" opens the parent. On this page it is a lookup; in another
  // edition it is a navigation, and the sheet reopens once that edition's
  // items are on the page.
  const onFollow = useCallback(
    (id: string) => {
      const here = byId.get(id);
      if (here !== undefined) {
        setSelected(here);
        return;
      }
      const quarter = quarterOf(id);
      if (quarter === null) return;
      setPendingOpenId(id);
      setSelected(null);
      setParams({ edition: quarter === quarters[0] ? null : quarter });
    },
    [byId, quarterOf, quarters, setParams],
  );

  useEffect(() => {
    if (pendingOpenId === null) return;
    const item = byId.get(pendingOpenId);
    if (item === undefined) return;
    setSelected(item);
    setPendingOpenId(null);
  }, [pendingOpenId, byId]);

  const onShowOnMap = useCallback(
    (eventId: string) => {
      setSelected(null);
      setFocusEventId(eventId);
      if (params.section !== 'world') setParams({ section: 'world' });
      // After the World section has rendered.
      window.setTimeout(() => worldRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    },
    [params.section, setParams],
  );

  const context = useMemo<NewsContext>(
    () => ({
      startYear: session.startYear,
      characters,
      companyNames,
      multiSector,
      playerCharacterId: founder.id,
      playerCompanyId: company.id,
      headlineOf,
      onOpen,
    }),
    [session.startYear, characters, companyNames, multiSector, founder.id, company.id, headlineOf, onOpen],
  );

  const media = view.world.media;
  const empty = EMPTY_COPY[params.section];

  return (
    <div className="np-paper -mx-3 -mt-4 min-h-dvh px-3 pt-2 pb-6 sm:-mx-5 sm:px-5" data-testid="newspaper">
      <div ref={columnRef} className="mx-auto flex w-full max-w-[720px] flex-col">
        <Masthead startYear={session.startYear} edition={edition} narrative={media.dominantNarrative} controversy={media.controversyIntensity} />
        <SectionStrip
          section={params.section}
          onSection={(section) => setParams({ section })}
          mine={params.mine}
          onMine={(mine) => setParams({ mine })}
          filterCount={filterCount}
          onFilter={() => setFilterOpen(true)}
          filterable={filterable}
        />

        {edition === null ? (
          <div className="py-8">
            <p className="np-headline text-[22px] leading-tight">No edition has gone to press.</p>
            <p className="np-deck mt-2 text-[14px] leading-snug">End a quarter from Command Centre and the first edition prints here: every event, story, filing and post the world made public.</p>
          </div>
        ) : (
          <FrontPage
            items={sectionItems}
            context={context}
            widthPx={widthPx}
            measurer={measurer}
            serif={serif}
            emptyTitle={params.mine ? 'Nothing about you this edition' : empty.title}
            emptyMessage={params.mine ? 'Nothing you or your company said or did reached the public record this quarter.' : empty.message}
          />
        )}

        {params.section === 'world' ? (
          <div className="mt-4">
            <WorldSection ref={worldRef} session={session} modifiers={modifiers} focusEventId={focusEventId} onFocusHandled={() => setFocusEventId(null)} />
          </div>
        ) : null}

        <div className="mt-5">
          <EarlierEditions editions={editions} current={edition} startYear={session.startYear} onOpen={(quarter) => setParams({ edition: quarter })} />
        </div>
      </div>

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        sectors={sectorOptions}
        sectorCounts={sectorCounts}
        sector={params.sector}
        onSector={(sector) => setParams({ sector })}
        companies={companyOptions}
        companyId={params.companyId}
        onCompany={(companyId) => setParams({ companyId })}
      />

      <StorySheet
        item={selected}
        onClose={() => setSelected(null)}
        context={context}
        ledgerById={ledgerById as ReadonlyMap<string, SimEvent>}
        measurer={measurer}
        serif={serif}
        onFollow={onFollow}
        companySectors={companySectors}
        mappedEventIds={mappedEventIds}
        onShowOnMap={onShowOnMap}
        resolveName={resolveName}
        onOpenRow={setOpenRow}
        ledgerIsCurrent={ledgerIsCurrent}
      />

      {/* One committed row in full — the same drawer every report screen opens. */}
      <LedgerDrawer
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        title={openRow === null ? 'Ledger row' : `Ledger row ${openRow.sequence}`}
        subtitle={openRow === null ? undefined : `${quarterLabel(session.startYear, openRow.quarter)} · as committed`}
        events={openRow === null ? [] : [openRow]}
        resolveName={resolveName}
      />
    </div>
  );
}

'use client';

/**
 * World — what is happening outside this company, on one scrolling page.
 *
 * Six cards in the order the plan sets: the paper, social, people, standing,
 * the economy, and the world's own readings folded away. The paper leads
 * because burying the news is the exact complaint Coffee Inc 2 collected: the
 * lead headline of the newest edition is on the tab itself, and the five
 * section chips open the paper already turned to that section.
 *
 * Every figure is derived here from the same functions the sheets read —
 * `projectPublicRecord` for the record, `buildDirectory`/`groupByRing` for the
 * people, the committed `EconomyReport` rows for the economy — and handed to a
 * pure card, so a card cannot disagree with the sheet behind it.
 *
 * The seat is the founder's own: the paper, the standings and the network are
 * about the founding company and the person running it, which is what News,
 * Leaderboard and Network all read.
 */

import { useMemo } from 'react';
import type { LeaderboardBoard } from '@frontier/contracts';
import { quarterLabel, regionTollRowFor, sectorRowFor } from '@frontier/contracts';
import { projectEditionIndex, projectPublicRecord } from '@frontier/simulation';
import { regionLabel, regionOf, sectorLabel, sectorOf, sectorsPresent } from '@/components/ui';
import { PAPER_NAME } from '@/components/screens/news/Masthead';
import { filterFeed, topByReach } from '@/components/screens/feed/filters';
import { buildDirectory } from '@/components/screens/network/directory';
import { groupByRing, type Ring } from '@/components/screens/network/rings';
import { tollCaption } from '@/components/screens/sector/model';
import { companyNameOf } from '@/components/screens/reporting/util';
import {
  PLAYER_ID,
  useConnection,
  useGame,
  useLedger,
  usePlayerCharacter,
  usePlayerCompany,
  usePlayerView,
  useSession,
} from '@/lib/game';
import { EconomyCard, PaperCard, PeopleCard, SocialCard, StandingCard, WorldReadingsCard, type StandingRow } from './cards/world-cards';

/** Items pulled from the newest edition: the lead plus enough for three briefs. */
const EDITION_ITEMS = 6;
/** The loudest posts named on the tab. The whole feed is one tap away. */
const TRENDING_SHOWN = 3;
/** Faces on the People card. */
const PEOPLE_SHOWN = 3;

export function WorldTab(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const connection = useConnection();
  const ledger = useLedger();
  const { previousWorld } = useGame();

  /* --- the paper ----------------------------------------------------------
     The same two calls the News screen makes, bounded to one edition: the
     cheap index of every quarter on the record, then the full projection for
     the newest one alone. Order is the engine's — heaviest first — and the
     lead is that order made visible, never re-sorted here. */

  const editions = useMemo(() => projectEditionIndex(session, PLAYER_ID), [session]);
  const edition = editions.length === 0 ? null : Math.max(...editions.map((entry) => entry.quarter));
  const frontPage = useMemo(() => {
    if (edition === null) return [];
    return projectPublicRecord(session, PLAYER_ID, { ledger, sinceQuarter: edition, limit: EDITION_ITEMS }).filter(
      (item) => item.quarter === edition,
    );
  }, [session, ledger, edition]);

  const masthead =
    edition === null
      ? `${PAPER_NAME} · no edition has printed`
      : `${quarterLabel(session.startYear, edition)} · edition ${edition + 1} · ${editions.length} on the record`;

  /* --- social -------------------------------------------------------------
     The whole record narrowed to what people said, which is what the Social
     screen shows. `topByReach` is the engine's measured audience, not a guess. */

  const record = useMemo(() => projectPublicRecord(session, PLAYER_ID, { ledger }), [session, ledger]);
  const posts = useMemo(() => filterFeed(record, { kinds: ['post', 'reply'], sector: null, companyId: null, networks: null }), [record]);
  const trending = useMemo(
    () =>
      topByReach(posts, TRENDING_SHOWN).map((item) => ({
        id: item.id,
        headline: item.headline,
        author: item.who.name,
        reach: Math.round(item.reach ?? 0),
        isAi: item.who.isAi,
      })),
    [posts],
  );

  const ownAccounts = useMemo(
    () =>
      session.socialAccounts.filter(
        (account) => account.isActive && (account.ownerCharacterId === founder.id || account.ownerCompanyId === company.id),
      ),
    [session.socialAccounts, founder.id, company.id],
  );
  const followers = ownAccounts.reduce((total, account) => total + account.followers, 0);
  const lastPost = useMemo(() => {
    const ids = new Set(ownAccounts.map((account) => account.id));
    let latest: (typeof session.socialPosts)[number] | null = null;
    for (const post of session.socialPosts) {
      if (!ids.has(post.accountId)) continue;
      if (latest === null || post.quarter > latest.quarter) latest = post;
    }
    return latest === null ? null : { text: latest.text, quarterLabel: quarterLabel(session.startYear, latest.quarter) };
  }, [session.socialPosts, session.startYear, ownAccounts]);

  /* --- people -------------------------------------------------------------
     `buildDirectory` runs the validator's own `checkAccess`, and `groupByRing`
     is the geometry the Network screen draws: reachable, one introduction
     away, out of reach. The three faces are the most connected of the ones a
     channel can actually be opened with. */

  const directory = useMemo(() => buildDirectory(session, view, founder.id), [session, view, founder.id]);
  const rings = useMemo(() => groupByRing(directory), [directory]);
  const reach = useMemo(() => {
    const counts: Record<Ring, number> = { inner: 0, middle: 0, outer: 0 };
    for (const group of rings) counts[group.ring] = group.entries.length;
    return counts;
  }, [rings]);
  const people = useMemo(
    () =>
      (rings.find((group) => group.ring === 'inner')?.entries ?? [])
        .slice(0, PEOPLE_SHOWN)
        .map((entry) => entry.character),
    [rings],
  );

  /* --- standing -----------------------------------------------------------
     The four boards the Leaderboard screen puts at its head, read off the
     engine's own committed rows. Null before the first resolution, because a
     rank the engine has not computed is not a rank. */

  const standing = useMemo(() => {
    const rowOf = (board: LeaderboardBoard, subjectId: string): StandingRow => {
      const entry = session.leaderboards.find((item) => item.board === board)?.entries.find((row) => row.subjectId === subjectId) ?? null;
      return entry === null ? { value: null, rank: null } : { value: entry.value, rank: entry.rank };
    };
    return {
      founderIndex: rowOf('founder_index', founder.id),
      companyValue: rowOf('company_value', company.id),
      wealth: rowOf('founder_wealth', founder.id),
      network: rowOf('network', founder.id),
    };
  }, [session.leaderboards, founder.id, company.id]);

  /* --- the economy --------------------------------------------------------- */

  const report = view.economyReport;
  const sector = sectorOf(company);
  const region = regionOf(company);
  const sectorRow = sectorRowFor(report, sector);
  const tollRow = regionTollRowFor(report, region);
  // The Sector sheet's own test for "is this a multi-sector world", so the card
  // and the sheet a tap away answer that question the same way. A missing price
  // row is a quarter that has not resolved, which is a different question.
  const multiSector = useMemo(() => sectorsPresent([company, ...view.visibleCompanies]).length > 1, [company, view.visibleCompanies]);
  const controllerName =
    tollRow === null || tollRow.dominantControllerId === null ? null : companyNameOf(view, tollRow.dominantControllerId);

  return (
    <div className="flex flex-col gap-4">
      <PaperCard
        masthead={masthead}
        lead={frontPage[0] ?? null}
        briefs={frontPage.slice(1)}
        narrative={view.world.media.dominantNarrative}
        controversy={view.world.media.controversyIntensity}
      />

      <SocialCard
        narrative={view.world.media.dominantNarrative}
        attention={view.world.media.attentionLevel}
        controversy={view.world.media.controversyIntensity}
        trending={trending}
        lastPost={lastPost}
        followers={followers}
      />

      <PeopleCard connection={connection} reach={reach} people={people} />

      <StandingCard
        founderIndex={standing.founderIndex}
        companyValue={standing.companyValue}
        wealth={standing.wealth}
        network={standing.network}
      />

      <EconomyCard
        sectorLabel={sectorLabel(sector)}
        regionLabel={regionLabel(region)}
        multiSector={multiSector}
        priceIndex={sectorRow?.priceIndex ?? null}
        shortage={sectorRow?.shortage ?? null}
        supplyUsd={sectorRow?.supplyUsd ?? null}
        tollPct={tollRow?.tollPct ?? null}
        tollCaption={tollRow === null ? null : tollCaption(tollRow.tollPct, tollRow.dominantSharePct, controllerName)}
      />

      <WorldReadingsCard world={session.world} previous={previousWorld} />
    </div>
  );
}

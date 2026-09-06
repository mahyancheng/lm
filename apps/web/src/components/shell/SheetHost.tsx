'use client';

/**
 * One sheet, addressed by the URL.
 *
 * Every screen that used to be a route of its own is now a drill-down over the
 * tab that owns its subject: `/company?sheet=financials`, `/world?sheet=news`.
 * The host is mounted once in `AppShell`, reads `?sheet=`, and renders exactly
 * one `Drawer` at full height with the registry's title in its header.
 *
 * The rules it keeps:
 *
 * - **Back closes it.** A sheet opened from inside the app was pushed, so the
 *   Back control and the phone's back gesture do the same thing. A sheet opened
 *   by a deep link has nothing behind it, so closing it replaces onto the bare
 *   tab rather than leaving the session.
 * - **An address that means nothing is corrected, not rendered.** An unknown
 *   `?sheet=` replaces onto the tab; a sheet asked for over the wrong tab is
 *   moved to the tab that owns it, keeping every other param.
 * - **Resolution owns the screen.** When a quarter starts resolving the sheet
 *   closes: the overlay sits above it, and coming back to a stale drill-down of
 *   the previous quarter is worse than coming back to the tab.
 *
 * Every hook sits above the `sheet === null` return — the host renders on every
 * route, with and without a sheet, and the hook count may not change between
 * the two.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { Drawer, Icon } from '@/components/ui';
import { useResolving } from '@/lib/game';
import { SHEETS, sheetFrom, sheetHref, tabPath, type SheetId, type SheetParams } from '@/lib/sheets';
import { BoardroomScreen } from '@/components/screens/boardroom/BoardroomScreen';
import { CapitalScreen } from '@/components/screens/capital/CapitalScreen';
import { ChiefOfStaffScreen } from '@/components/screens/chief-of-staff/ChiefOfStaffScreen';
import { CompanyScreen } from '@/components/screens/company/CompanyScreen';
import { DealRoomScreen } from '@/components/screens/deal-room/DealRoomScreen';
import { FinancialsScreen } from '@/components/screens/financials/FinancialsScreen';
import { GovernmentScreen } from '@/components/screens/government/GovernmentScreen';
import { GroupScreen } from '@/components/screens/group/GroupScreen';
import { LeaderboardScreen } from '@/components/screens/leaderboard/LeaderboardScreen';
import { MarketsScreen } from '@/components/screens/markets/MarketsScreen';
import { NetworkScreen } from '@/components/screens/network/NetworkScreen';
import { NewsScreen } from '@/components/screens/news/NewsScreen';
import { PeopleScreen } from '@/components/screens/people/PeopleScreen';
import { PortfolioScreen } from '@/components/screens/portfolio/PortfolioScreen';
import { ProductsScreen } from '@/components/screens/products/ProductsScreen';
import { QuarterResolutionScreen } from '@/components/screens/quarter-resolution/QuarterResolutionScreen';
import { ResearchScreen } from '@/components/screens/research/ResearchScreen';
import { SectorScreen } from '@/components/screens/sector/SectorScreen';
import { SocialScreen } from '@/components/screens/social/SocialScreen';
import { StreetScreen } from '@/components/screens/street/StreetScreen';

/** Push a sheet onto the current tab. A `<Link href={sheetHref(...)}>` does the same and is preferred for anchors. */
export function useOpenSheet(): (sheet: SheetId, params?: SheetParams) => void {
  const router = useRouter();
  return useCallback(
    (sheet: SheetId, params?: SheetParams) => {
      router.push(sheetHref(sheet, params));
    },
    [router],
  );
}

/** The twenty bodies, by id. A `switch` rather than a map, so a missing case is a type error. */
function bodyOf(sheet: SheetId): React.JSX.Element {
  switch (sheet) {
    case 'company':
      return <CompanyScreen />;
    case 'group':
      return <GroupScreen />;
    case 'products':
      return <ProductsScreen />;
    case 'people':
      return <PeopleScreen />;
    case 'research':
      return <ResearchScreen />;
    case 'government':
      return <GovernmentScreen />;
    case 'financials':
      return <FinancialsScreen />;
    case 'exchange':
      return <MarketsScreen />;
    case 'capital':
      return <CapitalScreen />;
    case 'portfolio':
      return <PortfolioScreen />;
    case 'street':
      return <StreetScreen />;
    case 'deals':
      return <DealRoomScreen />;
    case 'boardroom':
      return <BoardroomScreen />;
    case 'news':
      return <NewsScreen />;
    case 'social':
      return <SocialScreen />;
    case 'network':
      return <NetworkScreen />;
    case 'leaderboard':
      return <LeaderboardScreen />;
    case 'sector':
      return <SectorScreen />;
    case 'resolution':
      return <QuarterResolutionScreen />;
    case 'chief-of-staff':
      return <ChiefOfStaffScreen />;
  }
}

export function SheetHost(): React.JSX.Element | null {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { resolving } = useResolving();

  const search = searchParams?.toString() ?? '';
  const named = searchParams?.get('sheet') ?? null;
  const sheet = sheetFrom(search);
  const owner = sheet === null ? null : tabPath(SHEETS[sheet].tab);

  /* Whether the host itself was on screen when the sheet appeared. It was, for
     every in-app open — a push — and it was not for a deep link or a reload,
     which have nothing behind them to go back to. */
  const pushedHere = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    pushedHere.current = sheet !== null && mounted.current;
    mounted.current = true;
  }, [sheet]);

  // An address nobody knows how to render: drop the param, keep the tab.
  useEffect(() => {
    if (named !== null && sheet === null) router.replace(pathname, { scroll: false });
  }, [named, sheet, pathname, router]);

  // Asked for over the wrong tab: move to the one that owns it, params intact.
  useEffect(() => {
    if (owner !== null && owner !== pathname) router.replace(`${owner}?${search}`, { scroll: false });
  }, [owner, pathname, search, router]);

  // The resolving overlay owns the screen; a sheet under it is dead weight.
  useEffect(() => {
    if (resolving && sheet !== null) router.replace(pathname, { scroll: false });
  }, [resolving, sheet, pathname, router]);

  const close = useCallback(() => {
    if (pushedHere.current) router.back();
    else if (owner !== null) router.replace(owner, { scroll: false });
  }, [router, owner]);

  if (sheet === null) return null;

  const meta = SHEETS[sheet];
  return (
    <Drawer
      open
      onClose={close}
      height="full"
      title={meta.title}
      subtitle={meta.blurb}
      leading={
        <button type="button" onClick={close} className="btn btn-ghost tap-target -ml-1.5 shrink-0 px-0" aria-label="Back">
          <Icon name="back" size={16} accent="current" />
        </button>
      }
    >
      <div className="flex flex-col gap-4">{bodyOf(sheet)}</div>
    </Drawer>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { TABS, isGamePath, tabFor } from '@/lib/nav';
import { PLAYER_ID, useFounderNetWorth, useGame, useGameActions, useOutcome, useQueuedActions, useSession } from '@/lib/game';
import { Icon, cx } from '@/components/ui';
import { ChiefOfStaffDock } from './ChiefOfStaffDock';
import { NavRail } from './NavRail';
import { SheetHost } from './SheetHost';
import { StatusBar } from './StatusBar';
import { ResolvingOverlay } from './ResolvingOverlay';
import { VerdictScreen, verdictOf } from '@/components/screens/verdict';

/**
 * The application shell.
 *
 * Game routes get the rail, the status bar, the sheet host and the resolving
 * overlay. The landing page and the auth pages get the page and nothing else —
 * they are outside the session.
 *
 * **The phone is the primary layout, and the bottom bar is the whole
 * navigation.** Five tabs, each one scrolling page of cards; every drill-down
 * is a sheet over its tab rather than a route of its own. There is no sub-tab
 * strip and no hamburger: chrome is a 56px header and a 60px bar, and nothing
 * in the game is more than a tab and a card away.
 *
 * From `lg` the same data draws the persistent rail and both bars disappear.
 */
export function AppShell({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const { notice } = useGame();
  const { dismissNotice } = useGameActions();
  const queued = useQueuedActions();
  const session = useSession();
  const outcome = useOutcome();
  const founderNetWorthUsd = useFounderNetWorth();

  if (!isGamePath(pathname)) {
    return <>{children}</>;
  }

  // The seat is closed: there is nothing left to instruct, so the shell shows
  // the verdict instead of a rail full of screens that would refuse every
  // action. The engine decided this, not the screen — `eliminatedQuarter` is set
  // by the quarter that wound the company up.
  const verdict = verdictOf(session, {
    playerId: PLAYER_ID,
    events: outcome?.events ?? [],
    founderNetWorthUsd,
  });
  if (verdict !== null) {
    return <VerdictScreen verdict={verdict} startYear={session.startYear} startHref="/" />;
  }

  const tab = tabFor(pathname);

  return (
    <div className="min-h-dvh bg-base">
      <div className="flex min-h-dvh">
        {/* Desktop rail */}
        <aside
          className="sticky top-0 hidden h-dvh shrink-0 border-r border-hair bg-panel lg:block"
          style={{ width: 'var(--rail-width)' }}
        >
          <div className="flex h-14 items-center gap-2.5 border-b border-hair px-4">
            <span className="flex size-7 items-center justify-center rounded-chip bg-brand-strong text-white shadow-card">
              <Icon name="logo" size={16} accent="current" />
            </span>
            <span className="text-[13px] font-bold tracking-tight text-ink">Frontier Capital</span>
          </div>
          {/* The rail marks the open sheet, so it reads the search params and
              renders behind its own boundary like the host does. */}
          <div className="h-[calc(100dvh-3.5rem)]">
            <Suspense fallback={null}>
              <NavRail />
            </Suspense>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <StatusBar />

          {notice !== null ? (
            <div className="animate-rise flex items-start justify-between gap-3 border-b border-warn/25 bg-warn-wash px-4 py-2.5 text-[11.5px] font-medium text-warn">
              <span className="min-w-0">{notice}</span>
              <button
                type="button"
                onClick={dismissNotice}
                className="tap-target -my-2 flex shrink-0 items-center justify-center rounded-chip opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                <Icon name="close" size={14} accent="current" />
              </button>
            </div>
          ) : null}

          <main className="main-scroll-pad min-w-0 flex-1 px-3 pt-4 sm:px-5">
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">{children}</div>
          </main>
        </div>
      </div>

      {/* The phone's primary navigation: one tab per page. */}
      <nav
        aria-label="Sections"
        className="bottom-nav fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-hair bg-panel/95 backdrop-blur lg:hidden"
      >
        {TABS.map((entry) => {
          const active = tab !== null && tab.id === entry.id;
          const badge = entry.id === 'play' && queued.length > 0 ? queued.length : null;
          return (
            <Link
              key={entry.id}
              href={entry.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'press-pop tap-target relative flex flex-col items-center justify-center gap-1 px-0.5 text-[10px] font-semibold',
                active ? 'icon-knockout-wash text-brand' : 'icon-knockout-panel text-ink-faint',
              )}
            >
              <span
                className={cx(
                  'flex h-6 w-11 items-center justify-center rounded-pill transition-colors',
                  active ? 'bg-brand-wash' : '',
                )}
              >
                <Icon name={entry.icon} size={19} accent="inherit" />
              </span>
              {entry.short}
              {badge !== null ? (
                <span className="figure absolute top-1 right-3 rounded-pill bg-brand px-1 text-[9px] leading-[14px] font-bold text-white">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* One sheet, read from `?sheet=`. `useSearchParams` bails the prerender
          out to the client, so it renders behind its own boundary. */}
      <Suspense fallback={null}>
        <SheetHost />
      </Suspense>

      <ChiefOfStaffDock />
      <ResolvingOverlay />

      {tab === null ? null : <span className="sr-only">{tab.blurb}</span>}
    </div>
  );
}

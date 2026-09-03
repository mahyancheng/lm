'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NAV_GROUPS, isGamePath, navGroupFor, navItemFor, navSiblingsFor, primaryHrefOf } from '@/lib/nav';
import { PLAYER_ID, useFounderNetWorth, useGame, useGameActions, useOutcome, useQueuedActions, useSession } from '@/lib/game';
import { ActionQueueTray, Icon, cx } from '@/components/ui';
import { ChiefOfStaffDock } from './ChiefOfStaffDock';
import { NavRail } from './NavRail';
import { StatusBar } from './StatusBar';
import { ResolvingOverlay } from './ResolvingOverlay';
import { VerdictScreen, verdictOf } from '@/components/screens/verdict';

/**
 * The application shell.
 *
 * Game routes get the rail, the status bar, the action tray and the resolving
 * overlay. The landing page and the auth pages get the page and nothing else —
 * they are outside the session.
 *
 * **The phone is the primary layout.** Below `lg` navigation is two rows that
 * are always where a thumb expects them: a fixed bottom bar of the five
 * groups, and a scrollable strip of that group's screens under the header. A
 * tab takes you to its group's primary screen; the strip then moves you
 * sideways within the group. Eighteen screens never appear at once — the
 * hamburger sheet is the overflow path for jumping across groups.
 *
 * From `lg` the same data draws the persistent rail and both bars disappear.
 */
export function AppShell({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const { notice } = useGame();
  const { dismissNotice } = useGameActions();
  const queued = useQueuedActions();
  const session = useSession();
  const outcome = useOutcome();
  const founderNetWorthUsd = useFounderNetWorth();

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

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

  const screen = navItemFor(pathname);
  const group = navGroupFor(pathname);
  const siblings = navSiblingsFor(pathname);

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
          <div className="h-[calc(100dvh-3.5rem)]">
            <NavRail />
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <StatusBar onOpenNav={() => setNavOpen((open) => !open)} navOpen={navOpen} />

          {/* Sub-tabs: the sibling screens of the group you are in. Phone only —
              the rail already shows all eighteen from `lg`. */}
          {siblings.length > 0 ? (
            <nav
              aria-label={group === null ? 'Screens in this group' : `${group.label} screens`}
              className="sticky z-10 border-b border-hair bg-panel/92 backdrop-blur lg:hidden"
              style={{ top: 'var(--statusbar-height)' }}
            >
              <div className="subtab-strip px-1.5">
                {siblings.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'press-pop flex shrink-0 items-center gap-1.5 rounded-chip px-2.5 text-[11.5px] font-semibold whitespace-nowrap transition-colors',
                        active ? 'icon-knockout-wash bg-brand-wash text-brand' : 'icon-knockout-panel text-ink-dim',
                      )}
                      style={{ minHeight: 'var(--subtab-height)' }}
                    >
                      <Icon name={item.icon} size={16} accent="inherit" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          ) : null}

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

      {/* Mobile sheet: the overflow path across groups. */}
      {navOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-ink/25" onClick={() => setNavOpen(false)} aria-hidden="true" />
          <div
            className="animate-rise absolute inset-x-0 rounded-b-panel border-b border-hair bg-panel shadow-float"
            style={{ top: 'var(--statusbar-height)' }}
          >
            <NavRail variant="sheet" onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      ) : null}

      {/* The phone's primary navigation: one tab per group. */}
      <nav
        aria-label="Sections"
        className="bottom-nav fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-hair bg-panel/95 backdrop-blur lg:hidden"
      >
        {NAV_GROUPS.map((navGroup) => {
          const active = group !== null && group.id === navGroup.id;
          const badge = navGroup.id === 'play' && queued.length > 0 ? queued.length : null;
          return (
            <Link
              key={navGroup.id}
              href={primaryHrefOf(navGroup)}
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
                <Icon name={navGroup.icon} size={19} accent="inherit" />
              </span>
              {navGroup.short}
              {badge !== null ? (
                <span className="figure absolute top-1 right-3 rounded-pill bg-brand px-1 text-[9px] leading-[14px] font-bold text-white">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <ChiefOfStaffDock />
      <ActionQueueTray />
      <ResolvingOverlay />

      {screen === null ? null : <span className="sr-only">{screen.blurb}</span>}
    </div>
  );
}

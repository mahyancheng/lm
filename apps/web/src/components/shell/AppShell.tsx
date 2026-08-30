'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { HOME_ROUTE, isGamePath, navItemFor } from '@/lib/nav';
import { useGame, useGameActions } from '@/lib/game';
import { ActionQueueTray, cx } from '@/components/ui';
import { NavRail } from './NavRail';
import { StatusBar } from './StatusBar';
import { ResolvingOverlay } from './ResolvingOverlay';

/** The four screens the bottom bar keeps one tap away on a phone. */
const QUICK_LINKS = [
  { href: HOME_ROUTE, label: 'Centre', glyph: 'CC' },
  { href: '/chief-of-staff', label: 'Staff', glyph: 'CS' },
  { href: '/end-quarter', label: 'Submit', glyph: 'EQ' },
  { href: '/quarter-resolution', label: 'Result', glyph: 'QR' },
] as const;

/**
 * The application shell.
 *
 * Game routes get the rail, the status bar, the action tray and the resolving
 * overlay. The landing page and the auth pages get the page and nothing else —
 * they are outside the session.
 *
 * Under `lg` the rail becomes a sheet behind a hamburger, and a four-item
 * bottom bar covers the loop: read, instruct, submit, review.
 */
export function AppShell({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const { notice } = useGame();
  const { dismissNotice } = useGameActions();

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  if (!isGamePath(pathname)) {
    return <>{children}</>;
  }

  const screen = navItemFor(pathname);

  return (
    <div className="min-h-dvh bg-base">
      <div className="flex min-h-dvh">
        {/* Desktop rail */}
        <aside
          className="sticky top-0 hidden h-dvh shrink-0 border-r border-hair bg-panel lg:block"
          style={{ width: 'var(--rail-width)' }}
        >
          <div className="flex h-14 items-center gap-2.5 border-b border-hair px-4">
            <span className="figure flex size-7 items-center justify-center rounded-chip bg-brand-strong text-[10px] font-bold text-white shadow-card">
              FC
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

          {notice !== null ? (
            <div className="animate-rise flex items-start justify-between gap-3 border-b border-warn/25 bg-warn-wash px-4 py-2.5 text-[11.5px] font-medium text-warn">
              <span>{notice}</span>
              <button
                type="button"
                onClick={dismissNotice}
                className="tap-target -my-2 shrink-0 rounded-chip opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ) : null}

          <main className="min-w-0 flex-1 px-3 pt-4 pb-24 sm:px-5 lg:pb-8">
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">{children}</div>
          </main>
        </div>
      </div>

      {/* Mobile sheet */}
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

      {/* Mobile bottom bar */}
      <nav
        aria-label="Quick navigation"
        // The height is a token, not a consequence of the padding: the action
        // tray offsets itself by exactly this much so it never covers the bar.
        style={{ height: 'var(--bottombar-height)' }}
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-hair bg-panel/95 backdrop-blur lg:hidden"
      >
        {QUICK_LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'press-pop flex flex-col items-center justify-center gap-1 text-[10px] font-semibold',
                active ? 'text-brand' : 'text-ink-dim',
              )}
            >
              <span
                className={cx(
                  'figure flex h-6 w-9 items-center justify-center rounded-pill text-[9px] font-bold transition-colors',
                  active ? 'bg-brand-wash text-brand' : 'text-ink-faint',
                )}
              >
                {link.glyph}
              </span>
              {link.label}
            </Link>
          );
        })}
      </nav>

      <ActionQueueTray />
      <ResolvingOverlay />

      {screen === null ? null : <span className="sr-only">{screen.blurb}</span>}
    </div>
  );
}

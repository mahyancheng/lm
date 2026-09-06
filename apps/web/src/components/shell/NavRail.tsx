'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { TABS } from '@/lib/nav';
import { SHEETS, sheetFrom, sheetHref, sheetsOfTab } from '@/lib/sheets';
import { useQueuedActions } from '@/lib/game';
import { Icon, cx } from '@/components/ui';

/**
 * The desktop rail: five tabs, and the sheets of the one you are on.
 *
 * A phone navigates with the bottom bar and opens sheets from cards. A desk has
 * room to show the second level as well, so the rail expands the active tab
 * into its drill-downs — the same `?sheet=` addresses the cards use, so the
 * open sheet is marked `aria-current` whichever way it was reached.
 */
export function NavRail(): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queued = useQueuedActions();
  const blocked = queued.filter((entry) => entry.blocked).length;
  const openSheet = sheetFrom(searchParams?.toString() ?? '');

  return (
    <nav aria-label="Screens" className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto px-2.5 pt-3 pb-3">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const badge = tab.id === 'play' && queued.length > 0 ? queued.length : null;
        const sheets = active ? sheetsOfTab(tab.id) : [];
        return (
          <div key={tab.id}>
            <Link
              href={tab.href}
              title={tab.blurb}
              aria-current={active && openSheet === null ? 'page' : undefined}
              className={cx(
                'group flex min-h-9 items-center gap-2.5 rounded-chip px-2 py-1.5 text-[12px] font-medium transition-colors',
                active ? 'bg-brand-wash font-semibold text-brand' : 'text-ink-dim hover:bg-raised hover:text-ink',
              )}
            >
              <span
                className={cx(
                  'flex size-6 shrink-0 items-center justify-center rounded-chip transition-colors',
                  active
                    ? 'icon-knockout-brand bg-brand-strong text-white'
                    : 'icon-knockout-raised bg-raised text-ink-faint group-hover:text-ink-dim',
                )}
              >
                <Icon name={tab.icon} size={15} accent="inherit" />
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.label}</span>
              {badge !== null ? (
                <span
                  className={cx(
                    'figure rounded-pill px-1.5 text-[10px] leading-[16px] font-bold',
                    blocked > 0 ? 'bg-warn-wash text-warn' : 'bg-raised text-ink-dim',
                  )}
                >
                  {badge}
                </span>
              ) : null}
            </Link>
            {sheets.length === 0 ? null : (
              <ul className="mt-px mb-1 space-y-px border-l border-hair pl-3 ml-4">
                {sheets.map((id) => {
                  const meta = SHEETS[id];
                  return (
                    <li key={id}>
                      <Link
                        href={sheetHref(id)}
                        title={meta.blurb}
                        aria-current={openSheet === id ? 'page' : undefined}
                        className={cx(
                          'flex min-h-8 items-center gap-2 rounded-chip px-2 py-1 text-[11.5px] transition-colors',
                          openSheet === id ? 'bg-brand-wash font-semibold text-brand' : 'text-ink-dim hover:bg-raised hover:text-ink',
                        )}
                      >
                        <Icon name={meta.icon} size={13} accent="inherit" className="icon-knockout-panel shrink-0 text-ink-faint" />
                        <span className="min-w-0 flex-1 truncate">{meta.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { PLAN_ACTION, TABS } from '@/lib/nav';
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
  const openSheet = sheetFrom(searchParams?.toString() ?? '');

  return (
    <nav aria-label="Screens" className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto px-3 pt-5 pb-4">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const sheets = active ? sheetsOfTab(tab.id) : [];
        return (
          <div key={tab.id}>
            <Link
              href={tab.href}
              title={tab.blurb}
              aria-current={active && openSheet === null ? 'page' : undefined}
              className={cx(
                'group flex min-h-9 items-center gap-2.5 rounded-chip px-2 py-1.5 text-[12px] font-medium transition-colors',
                active ? 'bg-white/12 font-semibold text-white' : 'text-white/65 hover:bg-white/8 hover:text-white',
              )}
            >
              <span
                className={cx(
                  'flex size-6 shrink-0 items-center justify-center rounded-chip transition-colors',
                    active ? 'icon-knockout-brand bg-brand text-white' : 'icon-knockout-raised bg-white/8 text-white/65 group-hover:text-white',
                )}
              >
                <Icon name={tab.icon} size={15} accent="inherit" />
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.label}</span>
            </Link>
            {sheets.length === 0 ? null : (
              <ul className="mt-1 mb-2 ml-4 space-y-px border-l border-white/15 pl-3">
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
                          openSheet === id ? 'bg-white/10 font-semibold text-white' : 'text-white/55 hover:bg-white/8 hover:text-white',
                        )}
                      >
                        <Icon name={meta.icon} size={13} accent="inherit" className="shrink-0" />
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
      <div className="mt-auto border-t border-white/12 pt-4">
        <Link href={PLAN_ACTION.href} className="press-pop flex min-h-12 items-center gap-3 rounded-card bg-warn-strong px-3 font-bold text-white shadow-pop" aria-current={pathname === PLAN_ACTION.href ? 'page' : undefined}>
          <Icon name={PLAN_ACTION.icon} size={18} accent="current" />
          <span className="flex-1">{PLAN_ACTION.label}</span>
          {queued.length > 0 ? <span className="figure rounded-pill bg-ink/40 px-2 py-0.5 text-[10px]">{queued.length}</span> : null}
        </Link>
        <p className="px-2 pt-2 text-[10px] leading-snug text-white/45">Review decisions and close the quarter.</p>
      </div>
    </nav>
  );
}

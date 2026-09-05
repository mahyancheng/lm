'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_GROUPS } from '@/lib/nav';
import { newsHref, useQueuedActions } from '@/lib/game';
import { Icon, cx } from '@/components/ui';
import { useNewsSearch } from './useNewsSearch';

export interface NavRailProps {
  /** `rail` is the persistent desktop column; `sheet` is the mobile overlay. */
  readonly variant?: 'rail' | 'sheet';
  /** Called after a link is followed, so the mobile sheet can close itself. */
  readonly onNavigate?: () => void;
}

/**
 * The eighteen screens, grouped.
 *
 * Every screen is named by its flat mark rather than by two capital letters:
 * the icon is the thing you recognise at a glance in a column of eighteen, and
 * "CO" and "CA" were never distinguishable at any speed.
 *
 * The queue badge sits on End Quarter because that is the screen that reads
 * it, and a player who has queued twelve actions and forgotten should be told
 * from anywhere in the game.
 */
export function NavRail({ variant = 'rail', onNavigate }: NavRailProps): React.JSX.Element {
  const pathname = usePathname();
  const queued = useQueuedActions();
  const blocked = queued.filter((entry) => entry.blocked).length;
  const newsSearch = useNewsSearch(pathname);

  return (
    <nav
      aria-label="Screens"
      className={cx(
        'flex min-h-0 flex-col gap-4 overflow-y-auto px-2.5 pt-3',
        variant === 'rail' ? 'h-full pb-3' : 'safe-pb-3 max-h-[calc(100dvh-var(--statusbar-height))]',
      )}
    >
      {NAV_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="icon-knockout-panel flex items-center gap-1.5 px-2 pb-1.5 text-ink-faint">
            <Icon name={group.icon} size={14} accent="inherit" />
            <span className="label-caps-faint">{group.label}</span>
          </div>
          <ul className={cx('space-y-px', variant === 'sheet' ? 'grid grid-cols-2 gap-1 space-y-0 sm:grid-cols-3' : '')}>
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const badge = item.href === '/end-quarter' && queued.length > 0 ? queued.length : null;
              return (
                <li key={item.href}>
                  <Link
                    href={newsHref(item.href, newsSearch)}
                    onClick={onNavigate}
                    title={item.blurb}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'group flex items-center gap-2.5 rounded-chip px-2 py-1.5 text-[12px] font-medium transition-colors',
                      variant === 'sheet' ? 'tap-target' : 'min-h-9',
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
                      <Icon name={item.icon} size={15} accent="inherit" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

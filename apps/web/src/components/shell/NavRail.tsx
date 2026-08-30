'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_GROUPS } from '@/lib/nav';
import { useQueuedActions } from '@/lib/game';
import { cx } from '@/components/ui';

export interface NavRailProps {
  /** `rail` is the persistent desktop column; `sheet` is the mobile overlay. */
  readonly variant?: 'rail' | 'sheet';
  /** Called after a link is followed, so the mobile sheet can close itself. */
  readonly onNavigate?: () => void;
}

/**
 * The eighteen screens, grouped.
 *
 * The queue badge sits on End Quarter because that is the screen that consumes
 * it, and a player who has queued twelve actions and forgotten should be told
 * from anywhere in the game.
 */
export function NavRail({ variant = 'rail', onNavigate }: NavRailProps): React.JSX.Element {
  const pathname = usePathname();
  const queued = useQueuedActions();
  const blocked = queued.filter((entry) => entry.blocked).length;

  return (
    <nav
      aria-label="Screens"
      className={cx(
        'flex min-h-0 flex-col gap-4 overflow-y-auto px-2.5 py-3',
        variant === 'rail' ? 'h-full' : 'max-h-[calc(100dvh-var(--statusbar-height))]',
      )}
    >
      {NAV_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="label-caps-faint px-2 pb-1.5">{group.label}</div>
          <ul className="space-y-px">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const badge = item.href === '/end-quarter' && queued.length > 0 ? queued.length : null;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    title={item.blurb}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'group flex min-h-9 items-center gap-2.5 rounded-chip px-2 py-1.5 text-[12px] font-medium transition-colors',
                      active ? 'bg-brand-wash font-semibold text-brand' : 'text-ink-dim hover:bg-raised hover:text-ink',
                    )}
                  >
                    <span
                      className={cx(
                        'figure flex size-6 shrink-0 items-center justify-center rounded-chip text-[8.5px] font-bold transition-colors',
                        active ? 'bg-brand-strong text-white' : 'bg-raised text-ink-faint group-hover:text-ink-dim',
                      )}
                    >
                      {item.glyph}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {badge !== null ? (
                      <span
                        className={cx(
                          'figure rounded-pill px-1.5 text-[10px] font-bold leading-[16px]',
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

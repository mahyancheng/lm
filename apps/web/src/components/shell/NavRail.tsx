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
                      'group flex items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors',
                      active ? 'bg-raised text-ink' : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                    )}
                  >
                    <span
                      className={cx(
                        'figure flex size-5 shrink-0 items-center justify-center rounded-[3px] border text-[8.5px] font-semibold',
                        active ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair text-ink-faint group-hover:text-ink-dim',
                      )}
                    >
                      {item.glyph}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {badge !== null ? (
                      <span
                        className={cx(
                          'figure rounded-full px-1.5 text-[10px] leading-[15px]',
                          blocked > 0 ? 'bg-warn-wash text-warn' : 'bg-hair text-ink-dim',
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

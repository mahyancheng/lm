'use client';

import Link from 'next/link';
import { useState } from 'react';
import { labelFor } from '@frontier/simulation';
import { useQueuedActions, useGameActions, useResolving } from '@/lib/game';
import { Tag } from './Tag';
import { toneOfStatus } from './ValidationBanner';
import { cx } from './tokens';

/**
 * The floating action queue.
 *
 * Screens add to it; End Quarter consumes it. It is deliberately always
 * visible while non-empty, because the whole quarter is a set of commitments a
 * player should be able to see the size of without leaving what they are doing.
 *
 * Blocked entries — a `CONFIRMATION_REQUIRED_ACTIONS` type without an explicit
 * human confirmation — are called out here and again on End Quarter, which
 * refuses to submit while any remain.
 */
export function ActionQueueTray(): React.JSX.Element | null {
  const entries = useQueuedActions();
  const { unqueueAction, confirmAction, clearQueue } = useGameActions();
  const { resolving } = useResolving();
  const [open, setOpen] = useState(false);

  if (entries.length === 0 || resolving) return null;

  const blocked = entries.filter((entry) => entry.blocked).length;
  const rejected = entries.filter((entry) => entry.validation.status === 'rejected').length;

  return (
    // Below `lg` the fixed quick-nav owns the bottom of the viewport, so the
    // tray sits above it: the pill used to cover the Submit and Result tabs at
    // a higher z-index, which is exactly when a player has something queued.
    <div className="pointer-events-none fixed right-3 bottom-[calc(var(--bottombar-height)+0.75rem)] z-30 flex w-[min(360px,calc(100vw-24px))] flex-col items-end gap-2 lg:right-4 lg:bottom-4">
      {open ? (
        <div className="animate-rise pointer-events-auto max-h-[52dvh] w-full overflow-hidden rounded-[8px] border border-hair-strong bg-panel shadow-2xl shadow-black/60">
          <header className="flex items-center justify-between border-b border-hair px-3 py-2">
            <span className="label-caps">Action queue</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearQueue}>
              Clear all
            </button>
          </header>
          <ul className="max-h-[38dvh] divide-y divide-hair overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.action.actionId} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-ink">{labelFor(entry.action.intent)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Tag tone={toneOfStatus(entry.validation.status)} dot>
                      {entry.validation.status}
                    </Tag>
                    {entry.blocked ? (
                      <button type="button" className="btn btn-sm" onClick={() => confirmAction(entry.action.actionId)}>
                        Confirm
                      </button>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove ${labelFor(entry.action.intent)}`}
                  onClick={() => unqueueAction(entry.action.actionId)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <footer className="flex items-center justify-between gap-2 border-t border-hair bg-base/40 px-3 py-2">
            <span className="text-[10px] text-ink-faint">Nothing is committed until the quarter is submitted.</span>
            <Link href="/end-quarter" className="btn btn-primary btn-sm">
              Review
            </Link>
          </footer>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'pointer-events-auto flex items-center gap-2 rounded-full border px-3.5 py-2 text-[12px] shadow-lg shadow-black/40 transition-colors',
          blocked > 0 || rejected > 0 ? 'border-warn/40 bg-warn-wash text-warn' : 'border-hair-strong bg-raised text-ink',
        )}
      >
        <span className="figure font-semibold">{entries.length}</span>
        <span>queued</span>
        {blocked > 0 ? <span className="figure text-[10px]">· {blocked} unconfirmed</span> : null}
        {rejected > 0 ? <span className="figure text-[10px]">· {rejected} rejected</span> : null}
        <span className="text-[9px] opacity-70">{open ? '▼' : '▲'}</span>
      </button>
    </div>
  );
}

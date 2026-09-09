'use client';

/**
 * The decision surface directly under the company scene.
 *
 * Home has one job before it becomes a dashboard: make the next real decision
 * obvious.  This is deliberately a single tactile surface, not another menu
 * card.  The most urgent engine-derived line gets the whole first tap; the
 * queue is a supporting state with a direct path to the desk.  The remaining
 * signals stay available behind a native disclosure so a quiet phone does not
 * start with a wall of rows.
 */

import Link from 'next/link';
import { EmptyState, Icon, IconChip, TONE_VAR, Tag, cx } from '@/components/ui';
import { legacyHref, tabPath } from '@/lib/sheets';
import type { FeedItem } from '../command-centre/feed';

/** Lines shown when the founder asks to expand the decision surface. */
export const FEED_LIMIT = 4;

export interface NeedsDecidingProps {
  readonly items: readonly FeedItem[];
  readonly queued: number;
  readonly unconfirmed: number;
}

function DecisionLink({ item, featured = false }: { readonly item: FeedItem; readonly featured?: boolean }): React.JSX.Element {
  return (
    <Link
      href={legacyHref(item.href)}
      className={cx(
        'press-pop tap-target relative flex items-center gap-3 transition-colors',
        featured ? 'rounded-card border border-hair bg-panel px-3.5 py-3 shadow-card hover:border-hair-strong hover:bg-raised' : 'raised-surface px-3 py-2 hover:border-hair-strong',
      )}
    >
      <span className={cx('flex shrink-0 items-center justify-center rounded-pill', featured ? 'size-8' : 'size-6')} style={{ backgroundColor: TONE_VAR[item.tone] }} aria-hidden="true">
        <Icon name={featured ? 'warning' : 'chevronRight'} size={featured ? 16 : 12} accent="current" className="text-ink" />
      </span>
      <span className="min-w-0 flex-1">
        {featured ? <span className="label-caps-faint block">Act this quarter</span> : null}
        <span className={cx('block text-[12.5px] leading-snug font-medium', item.tone === 'loss' ? 'text-loss' : 'text-ink')}>{item.text}</span>
      </span>
      {item.meta === undefined ? null : <span className="figure shrink-0 text-[11px] text-ink-faint">{item.meta}</span>}
      <Icon name="chevronRight" size={15} accent="current" className="shrink-0 text-ink-faint" />
    </Link>
  );
}

export function NeedsDeciding({ items, queued, unconfirmed }: NeedsDecidingProps): React.JSX.Element {
  const shown = items.slice(0, FEED_LIMIT);
  const primary = shown[0] ?? null;
  const remaining = shown.slice(1);
  const hidden = items.length - shown.length;
  const queueTone = unconfirmed > 0 ? 'warn' : queued > 0 ? 'brand' : 'neutral';

  return (
    <section className="panel-surface animate-pop-in overflow-hidden" aria-labelledby="next-decision-title">
      <div className="flex items-center justify-between gap-3 border-b border-hair bg-raised px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip name={primary === null ? 'check' : 'bell'} tone={primary === null ? 'gain' : queueTone} />
          <div className="min-w-0">
            <h2 id="next-decision-title" className="label-caps">{primary === null ? 'Quarter is clear' : 'Your next decision'}</h2>
            <p className="text-[11.5px] leading-snug text-ink-faint">{primary === null ? 'No committed matter requires your answer.' : 'Start with the item that can change this quarter.'}</p>
          </div>
        </div>
        <Tag tone={queueTone} dot>{unconfirmed > 0 ? 'confirmation needed' : queued > 0 ? `${queued} queued` : 'ready'}</Tag>
      </div>

      <div className="p-3">
        {primary === null ? (
          <EmptyState compact icon="check" title="Nothing is asking for you" message="Set the quarter’s direction, or advance when you are ready." />
        ) : (
          <>
            <DecisionLink item={primary} featured />
            {remaining.length === 0 && hidden === 0 ? null : (
              <details className="group mt-2.5">
                <summary className="tap-target flex cursor-pointer list-none items-center gap-2 px-1 text-[12px] font-medium text-ink-dim">
                  <Icon name="chevronDown" size={15} accent="current" className="transition-transform group-open:rotate-180" />
                  {remaining.length + hidden} more signal{remaining.length + hidden === 1 ? '' : 's'}
                </summary>
                <div className="mt-2 flex flex-col gap-1.5">
                  {remaining.map((item) => <DecisionLink key={item.id} item={item} />)}
                  {hidden > 0 ? <p className="px-1 text-[11px] text-ink-faint">{hidden} additional signal{hidden === 1 ? '' : 's'} remain on the desk.</p> : null}
                </div>
              </details>
            )}
          </>
        )}

        <Link href={tabPath('play')} className="press-pop tap-target mt-3 flex items-center gap-2.5 rounded-card border border-hair px-3 py-2.5 transition-colors hover:bg-raised">
          <IconChip name="stamp" tone={queueTone} size="sm" />
          <span className="min-w-0 flex-1 text-[12.5px] text-ink">
            <span className="font-medium">Quarter desk</span>
            <span className="text-ink-faint"> · <span className="figure">{queued}</span> queued{unconfirmed > 0 ? ` · ${unconfirmed} need confirmation` : ''}</span>
          </span>
          <span className="text-[11px] font-medium text-brand">Review</span>
          <Icon name="chevronRight" size={14} accent="current" className="text-ink-faint" />
        </Link>
      </div>
    </section>
  );
}

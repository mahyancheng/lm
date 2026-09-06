'use client';

/**
 * Needs deciding — the queue first, then everything else asking for an answer.
 *
 * The first row is the desk: how many instructions are queued and how many of
 * them are still unconfirmed, one tap from the Play tab that seals the quarter.
 * Under it is the derived feed, capped at `FEED_LIMIT` so that a busy quarter
 * cannot push the rest of Home off the phone; the remainder is counted and
 * points at the same desk.
 *
 * Pure in its props. Every feed line carries the address of the screen that
 * resolves it, written when the feed was built and still an old route, so
 * `AlertFeed` puts each one through `legacyHref` before it renders.
 */

import Link from 'next/link';
import { Icon, IconChip, Panel, Tag } from '@/components/ui';
import { tabPath } from '@/lib/sheets';
import { AlertFeed } from '../command-centre/AlertFeed';
import type { FeedItem } from '../command-centre/feed';

/** Lines shown on Home. The rest are counted, not listed. */
export const FEED_LIMIT = 4;

export interface NeedsDecidingProps {
  readonly items: readonly FeedItem[];
  /** Instructions queued for this quarter. */
  readonly queued: number;
  /** Of those, the ones still needing an explicit confirmation. */
  readonly unconfirmed: number;
}

export function NeedsDeciding({ items, queued, unconfirmed }: NeedsDecidingProps): React.JSX.Element {
  const shown = items.slice(0, FEED_LIMIT);
  const hidden = items.length - shown.length;

  return (
    <Panel
      title="Needs deciding"
      iconName="bell"
      iconTone={unconfirmed > 0 ? 'warn' : 'neutral'}
      subtitle="Everything in committed state asking for an answer."
      actions={<Tag tone={unconfirmed > 0 ? 'warn' : 'neutral'}>{items.length === 1 ? '1 line' : `${items.length} lines`}</Tag>}
    >
      <Link
        href={tabPath('play')}
        className="raised-surface press-pop tap-target mb-2.5 flex items-center gap-2.5 px-3 py-2 transition-colors hover:border-hair-strong"
      >
        <IconChip name="stamp" tone={unconfirmed > 0 ? 'warn' : 'brand'} size="sm" />
        <span className="min-w-0 flex-1 text-[12.5px] text-ink">
          <span className="figure">{queued}</span> queued · <span className="figure">{unconfirmed}</span> unconfirmed
        </span>
        <Tag tone="neutral">Open the desk</Tag>
        <span className="shrink-0 text-ink-faint">
          <Icon name="chevronRight" size={13} accent="current" />
        </span>
      </Link>

      {/* Flat on Home: three headings over four rows is a filing system, and
          every row already carries its tone and the sheet that resolves it. */}
      <AlertFeed items={shown} grouped={false} />

      {hidden > 0 ? (
        <Link href={tabPath('play')} className="tap-target mt-2 flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-dim">
          {hidden} more · open the desk
          <Icon name="chevronRight" size={12} accent="current" />
        </Link>
      ) : null}
    </Panel>
  );
}

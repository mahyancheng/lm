'use client';

/**
 * TODAY.
 *
 * Every line is a condition that exists in committed state, and every line
 * links to the screen that resolves it. A quiet feed is information: it means
 * nothing in the session currently needs an answer from you.
 *
 * A line is a **card row**, not a table row: on a phone it is the thing a thumb
 * has to hit, so it clears 44px, carries its own tone dot and says where it
 * goes with a chevron rather than leaving the player to guess.
 */

import Link from 'next/link';
import { EmptyState, Icon, TONE_VAR, cx } from '@/components/ui';
import type { FeedItem } from './feed';
import type { IconName } from '@/components/ui';

const GROUP_LABEL: Readonly<Record<FeedItem['group'], string>> = {
  company: 'Your company',
  world: 'The world',
  competition: 'Competition',
};

const GROUP_ICON: Readonly<Record<FeedItem['group'], IconName>> = {
  company: 'building',
  world: 'globe',
  competition: 'trophy',
};

export interface AlertFeedProps {
  readonly items: readonly FeedItem[];
}

export function AlertFeed({ items }: AlertFeedProps): React.JSX.Element {
  if (items.length === 0) {
    return (
      <EmptyState
        icon="check"
        compact
        title="Nothing is asking for you"
        message="No board matters, no closing procurements, no severe events and nothing blocked in the queue. Open the Chief of Staff and set the quarter's direction."
      />
    );
  }

  const groups: FeedItem['group'][] = ['company', 'world', 'competition'];

  return (
    <div className="flex flex-col gap-3.5">
      {groups.map((group) => {
        const rows = items.filter((item) => item.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group}>
            <div className="label-caps-faint mb-1.5 flex items-center gap-1.5">
              <Icon name={GROUP_ICON[group]} size={14} accent="current" />
              {GROUP_LABEL[group]}
            </div>
            <ul className="flex flex-col gap-1.5">
              {rows.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="raised-surface press-pop tap-target flex items-center gap-2.5 px-3 py-2 transition-colors hover:border-hair-strong"
                  >
                    <span
                      className="inline-block size-2 shrink-0 rounded-pill"
                      style={{ backgroundColor: TONE_VAR[item.tone] }}
                      aria-hidden="true"
                    />
                    <span className={cx('min-w-0 flex-1 text-[12.5px] leading-snug', item.tone === 'loss' ? 'text-loss' : 'text-ink-dim')}>
                      {item.text}
                    </span>
                    {item.meta === undefined ? null : (
                      <span className="figure shrink-0 text-[10.5px] text-ink-faint">{item.meta}</span>
                    )}
                    <span className="shrink-0 text-ink-faint">
                      <Icon name="chevronRight" size={13} accent="current" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

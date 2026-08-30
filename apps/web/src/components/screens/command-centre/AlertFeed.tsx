'use client';

/**
 * TODAY.
 *
 * Every line is a condition that exists in committed state, and every line
 * links to the screen that resolves it. A quiet feed is information: it means
 * nothing in the session currently needs an answer from you.
 */

import Link from 'next/link';
import { EmptyState, TONE_VAR, cx } from '@/components/ui';
import type { FeedItem } from './feed';

const GROUP_LABEL: Readonly<Record<FeedItem['group'], string>> = {
  company: 'Your company',
  world: 'The world',
  competition: 'Competition',
};

export interface AlertFeedProps {
  readonly items: readonly FeedItem[];
}

export function AlertFeed({ items }: AlertFeedProps): React.JSX.Element {
  if (items.length === 0) {
    return (
      <EmptyState
        glyph="•"
        compact
        title="Nothing is asking for you"
        message="No board matters, no closing procurements, no severe events and nothing blocked in the queue. Open the Chief of Staff and set the quarter's direction."
      />
    );
  }

  const groups: FeedItem['group'][] = ['company', 'world', 'competition'];

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const rows = items.filter((item) => item.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group}>
            <div className="label-caps-faint mb-1">{GROUP_LABEL[group]}</div>
            <ul className="flex flex-col">
              {rows.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-start justify-between gap-3 border-b border-hair/60 py-1.5 transition-colors last:border-b-0 hover:bg-raised"
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      <span
                        className="mt-[5px] inline-block size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: TONE_VAR[item.tone] }}
                        aria-hidden="true"
                      />
                      <span className={cx('text-[12px] leading-snug', item.tone === 'loss' ? 'text-loss' : 'text-ink-dim')}>
                        {item.text}
                      </span>
                    </span>
                    {item.meta === undefined ? null : (
                      <span className="figure shrink-0 pt-px text-[10px] text-ink-faint">{item.meta}</span>
                    )}
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

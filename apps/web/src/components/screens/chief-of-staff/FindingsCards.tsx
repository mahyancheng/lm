'use client';

/**
 * What the Chief of Staff went and looked up, above the words it wrote.
 *
 * One card per lookup, one primary figure per card, and two or three lines under
 * it. The cards come first because they are the *evidence*: the reply below them
 * is the assistant's reading of these figures, and a founder who disagrees with
 * the reading can still see what it was reading.
 *
 * A line that carries an action links to the screen that owns it rather than
 * queueing from here. That is deliberate. Approving is a per-row step on the
 * interpretation card below, with the validator's verdict on it and the
 * confirmation gate on the always-confirm set; a second, lighter path to the
 * same commitment would be exactly the shortcut this whole surface is built to
 * avoid. The link carries the founder to the control that already exists, with
 * the counterparty named on the way.
 */

import Link from 'next/link';
import type { LookupResult } from '@frontier/contracts';
import { Icon, Tag, cx } from '@/components/ui';
import { ROUTE_OF_ACTION } from './InterpretationCard';
import { cardFor } from './findings';

export interface FindingsCardsProps {
  readonly findings: readonly LookupResult[];
  /** Compact framing for the drawer. */
  readonly dense?: boolean;
}

export function FindingsCards({ findings, dense = false }: FindingsCardsProps): React.JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Icon name="search" size={14} accent="brand" />
        <span className="label-caps-faint">What I found</span>
      </div>
      <div className={cx('grid gap-2', dense ? 'grid-cols-1' : 'sm:grid-cols-2')}>
        {findings.map((finding) => {
          const card = cardFor(finding);
          return (
            <div key={card.kind} className="rounded-card border border-hair bg-panel-soft p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold text-ink">{card.title}</span>
                <Tag tone="neutral">{card.kind.replace(/_/g, ' ')}</Tag>
              </div>
              <p className="figure mt-1 text-[19px] leading-tight text-ink">{card.figure}</p>
              <p className="text-[11px] leading-snug text-ink-faint">{card.caption}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {card.lines.map((line) => {
                  const route = line.intent == null ? null : ROUTE_OF_ACTION[line.intent.type];
                  const body = (
                    <>
                      <span className="min-w-0 flex-1 truncate text-ink-soft">{line.label}</span>
                      <span className={cx('figure shrink-0', line.warn === true ? 'tone-loss' : 'text-ink')}>{line.value}</span>
                    </>
                  );
                  return (
                    <li key={`${line.label}:${line.value}`}>
                      {route === null ? (
                        <div className="flex items-center gap-2 text-[11px]">{body}</div>
                      ) : (
                        <Link
                          href={route}
                          className="press-pop tap-target flex w-full items-center gap-2 rounded-input px-1 text-left text-[11px] hover:bg-panel"
                          aria-label={`Open the control for ${line.label}`}
                        >
                          {body}
                          <Icon name="chevronRight" size={12} accent="current" />
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

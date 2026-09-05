'use client';

/**
 * In brief: everything else in the edition, one paragraph each.
 *
 * A bold sans lead-in — the person for a post, the company for anything else,
 * or the kind word when the item names none — then the headline run in as
 * serif, hairlines between. A reply runs in under whom it answers. The reader's own lines carry the brand rule on the
 * left and a "you" lead-in. Tapping a brief opens it in full.
 */

import { memo } from 'react';
import type { PublicRecordItem } from '@frontier/contracts';
import { AiLabel, cx } from '@/components/ui';
import { followsId } from './layout';
import { SectionRule, isOwn, type NewsContext } from './pieces';

export interface BriefsProps {
  readonly items: readonly PublicRecordItem[];
  readonly context: NewsContext;
  readonly title?: string;
}

export const Briefs = memo(function Briefs({ items, context, title = 'In brief' }: BriefsProps): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col" data-testid="briefs">
      <SectionRule right={`${items.length}`}>{title}</SectionRule>
      <ul className="flex flex-col">
        {items.map((item) => (
          <Brief key={item.id} item={item} context={context} />
        ))}
      </ul>
    </section>
  );
});

/**
 * The lead-in: who is speaking. For a post or a reply that is the person — a
 * first-person line led in with a company name reads as a corporate statement
 * ("Lumen Household 14% down and I have never been more certain"). For a
 * filing, a story or an event it is the company, else the kind word. "You" on
 * the reader's own.
 */
export function leadInOf(item: PublicRecordItem, context: Pick<NewsContext, 'playerCharacterId' | 'playerCompanyId'>): string {
  if (isOwn(item, context)) return 'You';
  if (item.kind === 'post' || item.kind === 'reply') return item.who.name;
  return item.kicker.company ?? item.kicker.word;
}

/**
 * Whether to print the lead-in at all: not when the headline already carries
 * the name anywhere in it — "Harbourline Freight · Jun Park talks up
 * Harbourline Freight's prospects" names the company twice in one line.
 */
export function showsLeadIn(item: PublicRecordItem, leadIn: string, own: boolean): boolean {
  if (own) return true;
  return !item.headline.toLowerCase().includes(leadIn.toLowerCase());
}

const Brief = memo(function Brief({ item, context }: { readonly item: PublicRecordItem; readonly context: NewsContext }): React.JSX.Element {
  const own = isOwn(item, context);
  const parentId = followsId(item);
  const parent = parentId === null ? null : context.headlineOf(parentId);
  const leadIn = leadInOf(item, context);
  const showLeadIn = showsLeadIn(item, leadIn, own);
  return (
    <li className={cx('np-rule', own && 'border-l-2 border-l-brand pl-2.5')}>
      <button type="button" onClick={() => context.onOpen(item)} className="tap-target block w-full py-2.5 text-left" data-testid="brief">
        <p className="text-[14px] leading-[1.35]">
          {showLeadIn ? <span className={cx('mr-1.5 font-sans text-[12px] font-bold tracking-tight', own ? 'text-brand' : 'text-ink')}>{leadIn}</span> : null}
          <span className="np-deck text-ink">{item.headline}</span>
          {item.who.isAi ? <AiLabel className="ml-1.5 align-middle" /> : null}
        </p>
        {item.kind === 'reply' && parent !== null ? (
          <p className="mt-0.5 truncate text-[11px] text-ink-faint">
            <span aria-hidden="true">↳ </span>replying to <span className="text-ink-dim">{parent}</span>
          </p>
        ) : null}
        {item.whyItMatters === null ? null : <p className="mt-0.5 text-[11px] font-semibold text-brand">{item.whyItMatters}</p>}
      </button>
    </li>
  );
});

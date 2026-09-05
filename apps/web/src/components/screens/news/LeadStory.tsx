'use client';

/**
 * The lead: the heaviest item of the edition, set the way a paper sets its
 * splash. Kicker, a display-size serif headline balanced across at most three
 * lines, a one-line deck, the byline, and the body's opening paragraph cut at
 * a measured line boundary with a drop cap and a "Continued" link. Tapping the
 * headline, the deck or the link opens the story in full.
 */

import { memo } from 'react';
import type { PublicRecordItem } from '@frontier/contracts';
import { Icon, cx } from '@/components/ui';
import { cutAtLines, type Measurer } from '@/lib/text/measure';
import { FittedHeadline, LEAD_SIZES } from './Headline';
import { Byline, ForYou, Kicker, isOwn, type NewsContext } from './pieces';

/** The body face on the front page. */
export const BODY_FONT = { weight: 400, sizePx: 15, leading: 1.5 } as const;
/** The lead prints this many lines of its body before "Continued". */
export const LEAD_BODY_LINES = 6;

export interface LeadStoryProps {
  readonly item: PublicRecordItem;
  readonly context: NewsContext;
  readonly widthPx: number;
  readonly measurer: Measurer | null;
  readonly serif: string;
}

/**
 * The text the lead's opening paragraph is cut from.
 *
 * A post's headline is its own first sentence, so printing the body from its
 * start would set that sentence twice, once in display type and once under it.
 * The paragraph therefore begins where the headline stopped — unless the
 * headline was cut mid-sentence (it ends in an ellipsis), in which case the
 * body carries on from its start so the sentence is read whole.
 */
export function openingTextOf(item: Pick<PublicRecordItem, 'kind' | 'headline' | 'body'>): string {
  if (item.kind !== 'post' && item.kind !== 'reply') return item.body;
  if (item.headline.endsWith('…')) return item.body;
  const body = item.body.replace(/\s+/g, ' ').trim();
  const headline = item.headline.trim();
  if (!body.toLowerCase().startsWith(headline.toLowerCase())) return body;
  // Drop the sentence's own terminal punctuation and any closing quote after it.
  return body.slice(headline.length).replace(/^[.!?…"')\]]+/, '').trim();
}

/**
 * A drop cap is set on a letter. On a numeral it is a misprint — "14% down"
 * becomes a display-size 1 beside a small "4% down" — and a quotation mark or
 * a figure opening a paragraph is set at body size like any other character.
 */
export function takesDropCap(text: string): boolean {
  return /^\p{L}/u.test(text);
}

export const LeadStory = memo(function LeadStory({ item, context, widthPx, measurer, serif }: LeadStoryProps): React.JSX.Element {
  const own = isOwn(item, context);
  const openingText = openingTextOf(item);
  const opening = cutAtLines(openingText, { family: serif, ...BODY_FONT }, widthPx, LEAD_BODY_LINES, measurer);
  const open = (): void => context.onOpen(item);
  const headlineId = `lead-${item.id}`;

  return (
    <article className={cx('flex flex-col gap-2 pt-3 pb-4', own && 'border-l-2 border-l-brand pl-2.5')} aria-labelledby={headlineId} data-testid="lead-story">
      <Kicker item={item} context={context} />
      {/* The headline and the deck are targets too. A one-line headline is 32px
          and a deck 20px, so each carries padding folded back with a negative
          margin: the hit area clears 44px without moving a pixel of the layout. */}
      <button type="button" onClick={open} className="-my-1.5 block w-full py-1.5 text-left">
        <FittedHeadline
          id={headlineId}
          as="h2"
          text={item.headline}
          sizes={LEAD_SIZES}
          maxLines={3}
          widthPx={widthPx}
          measurer={measurer}
          serif={serif}
          leading={1.08}
        />
      </button>
      {item.deck === null ? null : (
        <button type="button" onClick={open} className="-my-3 block w-full py-3 text-left">
          <p className="np-deck text-[15px] leading-[1.35]">{item.deck}</p>
        </button>
      )}
      <Byline item={item} context={context} size="md" className="mt-0.5" />
      <ForYou text={item.whyItMatters} />
      {opening.shown.length === 0 ? null : (
        <p
          className={cx('np-body mt-1', takesDropCap(opening.shown) && 'np-dropcap')}
          style={{ fontSize: BODY_FONT.sizePx, lineHeight: BODY_FONT.leading }}
          data-testid="lead-opening"
        >
          {opening.shown}
        </p>
      )}
      <button type="button" onClick={open} className="tap-target -my-2 inline-flex items-center gap-1 self-start text-[12px] font-semibold text-brand">
        {/* "Read in full" promises more than the headline; a one-sentence post
            has nothing more, so the link says only what it does. */}
        {opening.cut ? 'Continued' : openingText.length === 0 ? 'Open' : 'Read in full'}
        <Icon name="chevronRight" size={13} accent="current" />
      </button>
    </article>
  );
});

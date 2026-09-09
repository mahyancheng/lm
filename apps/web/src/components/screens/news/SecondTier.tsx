'use client';

/**
 * The second tier: the next two to four items after the lead.
 *
 * Each is a kicker, a 17–20px serif headline, a byline and a two-line deck —
 * no body. Whether two sit side by side or stack is decided in `layout.ts` by
 * measuring both headlines at half width; this only draws the rows it is
 * handed, with a hairline between rows and a vertical hairline between a pair.
 */

import { memo } from 'react';
import type { PublicRecordItem } from '@frontier/contracts';
import { cx } from '@/components/ui';
import { cutAtLines, type Measurer } from '@/lib/text/measure';
import { FittedHeadline, TIER_SIZES } from './Headline';
import { Byline, ForYou, Kicker, isOwn, type NewsContext } from './pieces';

export const TIER_GAP_PX = 14;
const DECK_FONT = { weight: 400, sizePx: 13, leading: 1.4 } as const;

export interface SecondTierProps {
  readonly rows: readonly (readonly PublicRecordItem[])[];
  readonly context: NewsContext;
  readonly widthPx: number;
  readonly measurer: Measurer | null;
  readonly serif: string;
}

export const SecondTier = memo(function SecondTier({ rows, context, widthPx, measurer, serif }: SecondTierProps): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Second tier" className="flex flex-col" data-testid="second-tier">
      {rows.map((row) => {
        const paired = row.length === 2;
        const columnWidth = paired ? Math.floor((widthPx - TIER_GAP_PX) / 2) : widthPx;
        return (
          <div key={row.map((item) => item.id).join('+')} className={cx('np-rule grid', paired ? 'grid-cols-2' : 'grid-cols-1')} style={{ columnGap: TIER_GAP_PX }}>
            {row.map((item, index) => (
              <TierStory
                key={item.id}
                item={item}
                context={context}
                widthPx={columnWidth}
                paired={paired}
                measurer={measurer}
                serif={serif}
                className={paired && index === 1 ? 'border-l border-rule pl-3.5' : ''}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
});

const TierStory = memo(function TierStory({
  item,
  context,
  widthPx,
  paired,
  measurer,
  serif,
  className,
}: {
  readonly item: PublicRecordItem;
  readonly context: NewsContext;
  readonly widthPx: number;
  readonly paired: boolean;
  readonly measurer: Measurer | null;
  readonly serif: string;
  readonly className?: string;
}): React.JSX.Element {
  const own = isOwn(item, context);
  // The paired column is narrower by its own left padding.
  const innerWidth = className !== undefined && className.length > 0 ? widthPx - 14 : widthPx;
  const deck = item.deck === null ? null : cutAtLines(item.deck, { family: serif, ...DECK_FONT }, innerWidth, 2, measurer);
  const open = (): void => context.onOpen(item);
  return (
    <article className={cx('flex min-w-0 flex-col gap-1.5 py-3', own && 'border-l-2 border-l-brand pl-2.5', className)} data-testid="tier-story">
      <Kicker item={item} context={context} compact={paired} />
      <button type="button" onClick={open} className="block w-full text-left">
        <FittedHeadline
          as="h3"
          text={item.headline}
          sizes={paired ? TIER_SIZES.slice(1) : TIER_SIZES}
          maxLines={paired ? 4 : 3}
          widthPx={innerWidth}
          measurer={measurer}
          serif={serif}
          leading={1.15}
        />
      </button>
      <Byline item={item} context={context} />
      {deck === null ? null : (
        <button type="button" onClick={open} className="block w-full text-left">
          <p className="np-deck text-[13px] leading-[1.4]" style={{ fontSize: DECK_FONT.sizePx }}>
            {deck.shown}
            {deck.cut ? '…' : ''}
          </p>
        </button>
      )}
      <ForYou text={item.whyItMatters} />
    </article>
  );
});

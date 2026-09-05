'use client';

/**
 * One edition of one section, laid out as a front page: the lead, the second
 * tier, the briefs. The arithmetic is `layout.ts`; this draws it. Every tier is
 * memoised, so a store change that leaves the items alone re-renders nothing
 * below this line.
 */

import { memo, useMemo } from 'react';
import type { PublicRecordItem } from '@frontier/contracts';
import { EmptyState } from '@/components/ui';
import type { Measurer } from '@/lib/text/measure';
import { Briefs } from './Briefs';
import { TIER_SIZES } from './Headline';
import { LeadStory } from './LeadStory';
import { SecondTier, TIER_GAP_PX } from './SecondTier';
import { layoutFrontPage, type TierMeasure } from './layout';
import type { NewsContext } from './pieces';

export interface FrontPageProps {
  /** This edition's items for this section, in engine order. */
  readonly items: readonly PublicRecordItem[];
  readonly context: NewsContext;
  readonly widthPx: number;
  readonly measurer: Measurer | null;
  readonly serif: string;
  readonly emptyTitle: string;
  readonly emptyMessage: string;
}

export const FrontPage = memo(function FrontPage({ items, context, widthPx, measurer, serif, emptyTitle, emptyMessage }: FrontPageProps): React.JSX.Element {
  const measure = useMemo<TierMeasure>(
    () => ({
      measurer,
      widthPx,
      gapPx: TIER_GAP_PX,
      family: serif,
      weight: 700,
      sizePx: TIER_SIZES[1] ?? 19,
      leading: 1.15,
      maxPairedLines: 4,
    }),
    [measurer, widthPx, serif],
  );
  const layout = useMemo(() => layoutFrontPage(items, measure), [items, measure]);

  if (layout.lead === null) {
    return (
      <div className="py-6">
        <EmptyState compact icon="newspaper" title={emptyTitle} message={emptyMessage} />
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="front-page">
      <LeadStory item={layout.lead} context={context} widthPx={widthPx} measurer={measurer} serif={serif} />
      <SecondTier rows={layout.secondTier} context={context} widthPx={widthPx} measurer={measurer} serif={serif} />
      <Briefs items={layout.briefs} context={context} />
    </div>
  );
});

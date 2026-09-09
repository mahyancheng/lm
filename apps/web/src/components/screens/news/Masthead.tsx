'use client';

/**
 * The masthead: nameplate, dateline, double rule, and the index box.
 *
 * "The Frontier Ledger" is the outlet the world already names — its senior
 * correspondent sits in the scenario roster — so the paper is that paper. The
 * index box at the right carries the two figures the projection says frame
 * every event, the way a paper carries the weather: the dominant narrative and
 * the controversy band. Nothing else.
 *
 * Two rows, because a phone is 366px wide: the nameplate alone on the first,
 * the dateline and the index box sharing the second. The whole thing is a fixed
 * height, so the strip below it and the lead headline sit where the layout
 * test says they do.
 */

import { memo } from 'react';
import type { DominantNarrative } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { bandLabel, narrativeLabel } from '@/components/screens/reporting/util';

/** The paper's name, as the world's own journalists carry it on their cards. */
export const PAPER_NAME = 'The Frontier Ledger';

/** The masthead's height, including its rule. Budgeted with the strip to stay under 120px. */
export const MASTHEAD_HEIGHT_PX = 64;

/* Row one: the nameplate (~250px at 26px) and the edition number (~65px) sit
   together inside a 336px column. Row two: the quarter (~55px) leaves the index
   box ~270px, enough for "Narrative · Concentration backlash" without a cut. */

export interface MastheadProps {
  readonly startYear: number;
  /** The quarter this edition covers, or null before any has resolved. */
  readonly edition: number | null;
  readonly narrative: DominantNarrative;
  readonly controversy: number;
}

export const CONTROVERSY_BANDS = ['Quiet', 'Simmering', 'Active', 'Hot', 'Incendiary'] as const;

export const Masthead = memo(function Masthead({ startYear, edition, narrative, controversy }: MastheadProps): React.JSX.Element {
  return (
    <header className="flex flex-col justify-end" style={{ height: MASTHEAD_HEIGHT_PX }} data-testid="masthead">
      {/* Row one: the nameplate, and the edition number where a paper prints its price. */}
      <div className="flex items-end justify-between gap-3">
        <h1 className="np-nameplate min-w-0 truncate text-[26px] leading-[26px]">{PAPER_NAME}</h1>
        <p className="np-kicker shrink-0 pb-0.5 leading-[13px]">{edition === null ? 'No edition yet' : `Edition ${edition + 1}`}</p>
      </div>
      {/* Row two: the date on the left, the index box on the right — the two
          figures that frame every event, the way a paper carries the weather. */}
      <div className="mt-1 flex items-end justify-between gap-3 pb-1">
        <p className="np-kicker shrink-0 leading-[13px]">{edition === null ? quarterLabel(startYear, 0) : quarterLabel(startYear, edition)}</p>
        <dl className="np-kicker min-w-0 text-right leading-[13px]" aria-label="Index">
          <div className="flex justify-end gap-1">
            <dt className="shrink-0">Narrative ·</dt>
            <dd className="max-w-[200px] truncate text-ink">{narrativeLabel(narrative)}</dd>
          </div>
          <div className="flex justify-end gap-1">
            <dt className="shrink-0">Controversy ·</dt>
            <dd className="truncate text-ink">{bandLabel(controversy, CONTROVERSY_BANDS)}</dd>
          </div>
        </dl>
      </div>
      <div className="np-rule-double" />
    </header>
  );
});

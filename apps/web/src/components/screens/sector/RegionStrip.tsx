'use client';

/**
 * The per-region strip: three whole-number indices, and the freight toll.
 *
 * The map layer's contribution to §6.1 — "state macro indicators beside the
 * map" — lands here rather than on the map itself, because the toll is the
 * thing that makes a region worth reading and the toll is a *regional* figure
 * while the map is drawn by district. Three indices per region (talent cost,
 * energy cost, procurement appetite, all `REGION_META` fields printed bare
 * against a baseline of 100), and beside them the committed `RegionTollRow`:
 * who dominates the freight there, what share they hold and what everyone else
 * pays on their inputs.
 *
 * Nothing is computed. The indices are table lookups and the toll is the row
 * `priceSectors` wrote.
 */

import type { EconomyReport, Region } from '@frontier/contracts';
import { REGIONS, REGION_INDEX_BASELINE, REGION_META, TOLL_MAX_PCT } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { Icon, RegionBadge, Tag, cx, regionIcon } from '@/components/ui';
import { indexLabel, tollCaption } from './model';

export interface RegionStripProps {
  readonly report: EconomyReport | null;
  /** The player's own region, highlighted — it is the one they pay in. */
  readonly ownRegion: Region;
  /** Names for controller ids, so a toll says who is charging it. */
  readonly controllerNames: ReadonlyMap<string, string>;
  /** The player's own ultimate controller, so "your group" can be said plainly. */
  readonly ownControllerId: string | null;
  readonly className?: string;
}

export function RegionStrip({ report, ownRegion, controllerNames, ownControllerId, className }: RegionStripProps): React.JSX.Element {
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {REGIONS.map((region) => {
        const meta = REGION_META[region];
        const toll = report?.regionTolls.find((row) => row.region === region) ?? null;
        const yours = toll !== null && ownControllerId !== null && toll.dominantControllerId === ownControllerId;
        const controllerName = toll?.dominantControllerId == null ? null : (controllerNames.get(toll.dominantControllerId) ?? null);
        const caption = toll === null ? null : tollCaption(toll.tollPct, toll.dominantSharePct, yours ? 'Your group' : controllerName);

        return (
          <section
            key={region}
            className={cx('raised-surface px-3 py-2.5', region === ownRegion && 'border border-brand/35')}
          >
            <header className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <Icon name={regionIcon(region)} size={15} accent="current" className="shrink-0 text-ink-dim" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink">{meta.label}</span>
                  <span className="block truncate text-[10px] text-ink-faint">{meta.tagline}</span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {region === ownRegion ? <Tag tone="brand" size="sm">you</Tag> : null}
                {toll === null || toll.tollPct <= 0 ? null : (
                  <Tag tone={yours ? 'gain' : 'loss'} dot>
                    {yours ? `charging ${toll.tollPct}%` : `toll ${toll.tollPct}%`}
                  </Tag>
                )}
              </span>
            </header>

            <div className="mt-2 grid grid-cols-3 gap-2">
              <Index label="Talent cost" value={meta.talentCostIndex} invert />
              <Index label="Energy cost" value={meta.energyCostIndex} invert />
              <Index label="Procurement" value={meta.procurementAppetite} />
            </div>

            {toll === null ? null : (
              <div className="mt-2 border-t border-hair pt-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[10px] text-ink-faint">
                  <span>
                    Freight here <span className="figure text-ink-dim">{formatMoney(toll.logisticsRevenueUsd)}</span> a year
                  </span>
                  <span>
                    Largest group <span className="figure text-ink-dim">{toll.dominantSharePct}%</span>
                  </span>
                  <span>
                    Ceiling <span className="figure text-ink-dim">{TOLL_MAX_PCT}%</span>
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] leading-snug text-ink-faint">
                  {caption ?? `Nobody holds the 40% of this region's freight a toll starts at, so every input here is bought at the market.`}
                </p>
              </div>
            )}
          </section>
        );
      })}
      <p className="text-[10.5px] leading-relaxed text-ink-faint">
        Every index is a whole number against a baseline of {indexLabel(REGION_INDEX_BASELINE)}. Cheap talent and cheap
        power are low numbers; a deep procurement appetite is a high one.
      </p>
    </div>
  );
}

function Index({ label, value, invert = false }: { readonly label: string; readonly value: number; readonly invert?: boolean }): React.JSX.Element {
  const better = invert ? value < REGION_INDEX_BASELINE : value > REGION_INDEX_BASELINE;
  const tone = value === REGION_INDEX_BASELINE ? 'neutral' : better ? 'gain' : 'loss';
  return (
    <div className="min-w-0">
      <span className="label-caps-faint block truncate">{label}</span>
      <span className={cx('figure text-[15px]', tone === 'neutral' ? 'text-ink-dim' : `tone-${tone}`)}>{indexLabel(value)}</span>
    </div>
  );
}

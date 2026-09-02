'use client';

/**
 * Where this company sits in the economy, and what that costs.
 *
 * Two questions the multi-sector world made askable and nothing on the Company
 * screen answered:
 *
 * - **who do I depend on, and who depends on me?** The supply graph in
 *   `SECTOR_META` is declared from both ends, so "buys from" and "sells to" are
 *   read straight off it rather than derived here. A shortage upstream is the
 *   reason a good quarter went wrong, and this is where a player finds out
 *   which upstream to watch.
 * - **what does being based here do to me?** Region indices are whole numbers
 *   around a baseline of 100 — 130 talent means engineers cost thirty per cent
 *   more than the session baseline — so they print bare, with the direction of
 *   "good" carried by colour rather than by a minus sign.
 *
 * Nothing here is a lever. The panel states the terrain; the levers are on
 * Products, People and Capital.
 */

import type { Company } from '@frontier/contracts';
import { REGION_INDEX_BASELINE, SECTOR_META } from '@frontier/contracts';
import { formatCount, formatPct } from '@frontier/shared';
import {
  EmptyState,
  Icon,
  KeyValueGrid,
  Panel,
  RegionBadge,
  SectionHeading,
  SectorBadge,
  cx,
  readingTone,
  regionOf,
  regionReadings,
  sectorOf,
} from '@/components/ui';

export interface SectorPanelProps {
  readonly company: Company;
  readonly className?: string;
}

/** One half of the supply graph, or a plain sentence when that half is empty. */
function SupplyRow({
  label,
  sectors,
  empty,
}: {
  readonly label: string;
  readonly sectors: readonly (keyof typeof SECTOR_META)[];
  readonly empty: string;
}): React.JSX.Element {
  return (
    <div>
      <div className="label-caps-faint">{label}</div>
      {sectors.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{empty}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sectors.map((entry) => (
            <SectorBadge key={entry} sector={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SectorPanel({ company, className }: SectorPanelProps): React.JSX.Element {
  const sector = sectorOf(company);
  const region = regionOf(company);
  const meta = SECTOR_META[sector];
  const readings = regionReadings(region, sector);

  return (
    <Panel
      className={className}
      iconName="globe"
      iconTone="brand"
      title="Sector and region"
      subtitle={meta.tagline}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SectorBadge sector={sector} size="md" />
        <RegionBadge region={region} size="md" />
      </div>

      {/* --- the supply chain ------------------------------------------------ */}
      <div className="mt-4">
        <SectionHeading rule>Supply chain</SectionHeading>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <SupplyRow
            label="Buys from"
            sectors={meta.inputs}
            empty="This sector buys nothing the model tracks; its costs are its own."
          />
          <SupplyRow
            label="Sells to"
            sectors={meta.outputs}
            empty="Demand here comes from customers rather than from another sector, so nothing downstream can squeeze it."
          />
        </div>
        <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
          <Icon name="warning" size={13} accent="current" className="mt-px" />
          A shortage in a sector you buy from cuts what you can actually deliver; a squeeze in a sector you sell to arrives
          as demand that never turns up. Surplus upstream buys nothing extra.
        </p>
      </div>

      {/* --- the sector's own economics -------------------------------------- */}
      <div className="mt-4">
        <SectionHeading rule>What this sector is like</SectionHeading>
        <KeyValueGrid
          className="mt-2"
          columns={2}
          items={[
            {
              label: 'Capital intensity',
              value: formatCount(meta.capexIntensity),
              hint: 'Share of revenue that goes back in as plant, on a 0-100 index',
            },
            {
              label: 'Demand cycle',
              value: `${formatCount(meta.demandCycleQuarters)} quarters`,
              mono: false,
              hint: 'One full turn from trough to trough. Each sector runs its own.',
            },
            {
              label: 'Sustainable margin',
              value: `${formatCount(meta.grossMarginBandPct[0])}-${formatCount(meta.grossMarginBandPct[1])}%`,
              hint: 'Gross margin the sector supports over a cycle',
            },
            {
              label: 'Revenue multiple',
              value: `${formatCount(meta.revenueMultipleBand[0])}-${formatCount(meta.revenueMultipleBand[1])}x`,
              hint: 'The band the valuation anchor works within here',
            },
          ]}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Your gross margin this quarter is {formatPct(company.fundamentals.grossMarginPct)}
          {company.fundamentals.grossMarginPct * 100 < meta.grossMarginBandPct[0]
            ? ' — under the band this sector supports, which the valuation anchor scores against you.'
            : company.fundamentals.grossMarginPct * 100 > meta.grossMarginBandPct[1]
              ? ' — above the band this sector usually supports, which the anchor rewards in full.'
              : ' — inside the band this sector supports.'}
        </p>
      </div>

      {/* --- what the region does -------------------------------------------- */}
      <div className="mt-4">
        <SectionHeading rule>What being in {company.headquartersCity} costs</SectionHeading>
        {readings.length === 0 ? (
          <EmptyState compact className="mt-2" icon="globe" title="No region recorded" message="This company has no region on file." />
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {readings.map((reading) => {
              const tone = readingTone(reading);
              return (
                <li key={reading.label} className="flex items-baseline justify-between gap-3 border-b border-hair pb-1.5 last:border-0">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] text-ink">{reading.label}</span>
                    <span className="block truncate text-[10px] text-ink-faint">{reading.hint}</span>
                  </span>
                  <span
                    className={cx(
                      'figure shrink-0 text-[13px]',
                      tone === 'gain' ? 'tone-gain' : tone === 'loss' ? 'tone-loss' : 'text-ink-dim',
                    )}
                  >
                    {formatCount(reading.value)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Every figure is an index against a baseline of {formatCount(REGION_INDEX_BASELINE)}. Green is the direction that
          helps you: cheap talent and cheap power are low numbers, deep capital and a good sector fit are high ones.
        </p>
      </div>
    </Panel>
  );
}

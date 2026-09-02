'use client';

/**
 * Sector and region, as an interface vocabulary.
 *
 * World version 2 spans six sectors and six regions, and every screen that
 * shows a company has to say which. This file is the one place that decides how
 * that looks, so a sector badge on Markets is the same badge on the Leaderboard
 * and on a map drawer.
 *
 * Three rules it keeps.
 *
 * 1. **Sector colour means "different", never "good".** The six tone tokens are
 *    reserved for meaning — gain, loss, warning, information — so a sector is
 *    tinted from the pop palette instead, exactly as `CompanyChip` tints an
 *    archetype. A green sector is not a healthy sector.
 * 2. **Nothing is invented.** Labels, taglines, icons, cost indices and the
 *    supply graph all come from `SECTOR_META` / `REGION_META` in
 *    `@frontier/contracts`. This file adds a tint and a React element.
 * 3. **A world-version-1 company still renders.** `sector` and `region` carry
 *    schema defaults, but a redacted rival arrives as `Partial<Company>` where
 *    both are optional, so every accessor here is total.
 *
 * Region indices print bare: they are whole numbers around a baseline of 100,
 * and `REGION_INDEX_BASELINE` is what "normal" means.
 */

import type { Company, Region, Sector } from '@frontier/contracts';
import {
  DEFAULT_REGION,
  DEFAULT_SECTOR,
  REGIONS,
  REGION_INDEX_BASELINE,
  REGION_META,
  SECTORS,
  SECTOR_META,
  isRegion,
  isSector,
  regionSectorAffinity,
} from '@frontier/contracts';
import { Icon, isIconName, type IconName } from './icons';
import { cx } from './tokens';

/* -------------------------------------------------------------------------- */
/*  Tints                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One pop colour per sector, in `SECTORS` order.
 *
 * These are the same eight pastels the company glyph draws an archetype with.
 * They separate six lanes on a chart and six groups in a list; they carry no
 * judgement about any of them.
 */
export const SECTOR_TINT: Readonly<Record<Sector, string>> = {
  ai: 'var(--color-pop-5)',
  robotics: 'var(--color-pop-1)',
  manufacturing: 'var(--color-pop-2)',
  energy: 'var(--color-pop-4)',
  logistics: 'var(--color-pop-8)',
  consumer: 'var(--color-pop-3)',
};

/* -------------------------------------------------------------------------- */
/*  Total accessors                                                            */
/* -------------------------------------------------------------------------- */

/** The sector of any company-shaped thing, redacted rivals included. */
export function sectorOf(company: Pick<Partial<Company>, 'sector'>): Sector {
  return isSector(company.sector) ? company.sector : DEFAULT_SECTOR;
}

/** The region of any company-shaped thing, redacted rivals included. */
export function regionOf(company: Pick<Partial<Company>, 'region'>): Region {
  return isRegion(company.region) ? company.region : DEFAULT_REGION;
}

export function sectorLabel(sector: Sector): string {
  return SECTOR_META[sector].label;
}

export function regionLabel(region: Region): string {
  return REGION_META[region].label;
}

/**
 * The mark for a sector.
 *
 * `SECTOR_META.icon` is a plain string in contracts — contracts cannot depend on
 * the app's icon set — so it is checked against `ICON_NAMES` here and falls back
 * to the neutral building rather than rendering nothing.
 */
export function sectorIcon(sector: Sector): IconName {
  const name = SECTOR_META[sector].icon;
  return isIconName(name) ? name : 'building';
}

export function regionIcon(region: Region): IconName {
  const name = REGION_META[region].icon;
  return isIconName(name) ? name : 'globe';
}

/**
 * The distinct sectors present in a list of companies, in `SECTORS` order.
 *
 * This is the test every grouping surface uses: a world-version-1 session has
 * exactly one sector here, so the screen draws its list plainly instead of
 * putting one group heading above everything and five empty panels below it.
 */
export function sectorsPresent(companies: readonly Pick<Partial<Company>, 'sector'>[]): readonly Sector[] {
  const seen = new Set<Sector>();
  for (const company of companies) seen.add(sectorOf(company));
  return SECTORS.filter((sector) => seen.has(sector));
}

/** The distinct regions present in a list of companies, in `REGIONS` order. */
export function regionsPresent(companies: readonly Pick<Partial<Company>, 'region'>[]): readonly Region[] {
  const seen = new Set<Region>();
  for (const company of companies) seen.add(regionOf(company));
  return REGIONS.filter((region) => seen.has(region));
}

/* -------------------------------------------------------------------------- */
/*  Region readings                                                            */
/* -------------------------------------------------------------------------- */

export interface RegionReading {
  readonly label: string;
  /** The whole-number index, printed bare. 100 is the session baseline. */
  readonly value: number;
  /** True when a *higher* index is worse for the company that lives there. */
  readonly invert: boolean;
  readonly hint: string;
}

/**
 * What a region does to a company in that sector, as five whole numbers.
 *
 * Every figure is an index against `REGION_INDEX_BASELINE`; `invert` says which
 * direction is good, because a cheap talent market and a deep capital market
 * are both advantages and one of them is a low number.
 */
export function regionReadings(region: Region, sector: Sector): readonly RegionReading[] {
  const meta = REGION_META[region];
  return [
    { label: 'Talent cost', value: meta.talentCostIndex, invert: true, hint: 'What engineers and researchers cost here.' },
    { label: 'Energy cost', value: meta.energyCostIndex, invert: true, hint: 'What electricity costs here.' },
    { label: 'Capital depth', value: meta.capitalDepth, invert: false, hint: 'How much private and public money is reachable.' },
    { label: 'Procurement', value: meta.procurementAppetite, invert: false, hint: 'How much government work is on offer.' },
    {
      label: `Fit for ${SECTOR_META[sector].label.toLowerCase()}`,
      value: regionSectorAffinity(region, sector),
      invert: false,
      hint: 'Above 100 the region is unusually good at this sector.',
    },
  ];
}

/** `gain` when this reading helps the company, `loss` when it hurts, else neutral. */
export function readingTone(reading: RegionReading): 'gain' | 'loss' | 'neutral' {
  if (reading.value === REGION_INDEX_BASELINE) return 'neutral';
  const better = reading.invert ? reading.value < REGION_INDEX_BASELINE : reading.value > REGION_INDEX_BASELINE;
  return better ? 'gain' : 'loss';
}

/* -------------------------------------------------------------------------- */
/*  Badges                                                                     */
/* -------------------------------------------------------------------------- */

export interface SectorBadgeProps {
  readonly sector: Sector;
  readonly size?: 'sm' | 'md';
  /** Drop the word and keep the mark, for a dense table cell. */
  readonly iconOnly?: boolean;
  readonly className?: string;
}

/**
 * A sector, as a tinted pill.
 *
 * The tint is a 14% wash of the sector's pop colour with the colour itself on
 * the border and the text, which reads on the panel and on the raised surface
 * without a second set of tokens.
 */
export function SectorBadge({ sector, size = 'sm', iconOnly = false, className }: SectorBadgeProps): React.JSX.Element {
  const meta = SECTOR_META[sector];
  return (
    <span
      title={meta.tagline}
      className={cx(
        'inline-flex items-center gap-1 rounded-pill border font-semibold whitespace-nowrap',
        size === 'sm' ? 'px-2 py-px text-[10px] leading-[17px]' : 'px-2.5 py-0.5 text-[11px]',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${SECTOR_TINT[sector]} 30%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${SECTOR_TINT[sector]} 12%, var(--color-panel))`,
        color: `color-mix(in srgb, ${SECTOR_TINT[sector]} 78%, var(--color-ink))`,
      }}
    >
      <Icon name={sectorIcon(sector)} size={size === 'sm' ? 11 : 13} accent="current" />
      {iconOnly ? <span className="sr-only">{meta.label}</span> : meta.label}
    </span>
  );
}

export interface RegionBadgeProps {
  readonly region: Region;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * A region, as a quiet pill.
 *
 * Region is *where*, not *what*, so it stays neutral beside the tinted sector
 * badge rather than competing with it for the eye.
 */
export function RegionBadge({ region, size = 'sm', className }: RegionBadgeProps): React.JSX.Element {
  const meta = REGION_META[region];
  return (
    <span
      title={meta.tagline}
      className={cx(
        'inline-flex items-center gap-1 rounded-pill border border-hair bg-raised font-semibold whitespace-nowrap text-ink-dim',
        size === 'sm' ? 'px-2 py-px text-[10px] leading-[17px]' : 'px-2.5 py-0.5 text-[11px]',
        className,
      )}
    >
      <Icon name={regionIcon(region)} size={size === 'sm' ? 11 : 13} accent="current" />
      {meta.label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Filter                                                                     */
/* -------------------------------------------------------------------------- */

export interface SectorFilterProps {
  /** Which sectors to offer, usually `sectorsPresent(...)`. */
  readonly sectors: readonly Sector[];
  /** `null` is "every sector". */
  readonly value: Sector | null;
  readonly onChange: (sector: Sector | null) => void;
  /** How many rows each sector holds, shown as a count beside its name. */
  readonly counts?: Readonly<Partial<Record<Sector, number>>>;
  readonly totalLabel?: string;
  readonly className?: string;
}

/**
 * The one control that narrows a list to one sector.
 *
 * A scrolling row of pills rather than a segmented bar: seven options across a
 * 390px phone would shrink each one below the touch floor, and a `select` hides
 * the counts that make the row worth reading. The row scrolls inside itself, so
 * the page body never scrolls sideways.
 *
 * It renders nothing at all when the session has one sector — a world-version-1
 * save gets its old, unfiltered list instead of a control with a single option.
 */
export function SectorFilter({
  sectors,
  value,
  onChange,
  counts,
  totalLabel = 'All sectors',
  className,
}: SectorFilterProps): React.JSX.Element | null {
  if (sectors.length < 2) return null;
  const total = sectors.reduce((sum, sector) => sum + (counts?.[sector] ?? 0), 0);
  return (
    <div className={cx('scroll-x -mx-1 px-1', className)} role="group" aria-label="Filter by sector">
      <div className="flex w-max items-center gap-1.5 py-0.5">
        <FilterPill active={value === null} onClick={() => onChange(null)} count={counts === undefined ? undefined : total}>
          {totalLabel}
        </FilterPill>
        {sectors.map((sector) => (
          <FilterPill
            key={sector}
            active={value === sector}
            onClick={() => onChange(value === sector ? null : sector)}
            count={counts?.[sector]}
            tint={SECTOR_TINT[sector]}
            icon={sectorIcon(sector)}
          >
            {SECTOR_META[sector].label}
          </FilterPill>
        ))}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  count,
  tint,
  icon,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly count?: number;
  readonly tint?: string;
  readonly icon?: IconName;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'tap-target inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-3 text-[12px] font-semibold transition-colors sm:min-h-0 sm:py-1',
        active ? 'text-ink' : 'border-hair bg-panel text-ink-dim hover:bg-raised',
      )}
      style={
        active
          ? {
              borderColor: `color-mix(in srgb, ${tint ?? 'var(--color-brand)'} 45%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${tint ?? 'var(--color-brand)'} 14%, var(--color-panel))`,
            }
          : undefined
      }
    >
      {icon === undefined ? null : <Icon name={icon} size={13} accent="current" />}
      {children}
      {count === undefined ? null : <span className="figure text-[10px] text-ink-faint">{count}</span>}
    </button>
  );
}

/** Sector then region, in that order, for a card or a drawer header. */
export function SectorRegionBadges({
  company,
  size = 'sm',
  className,
}: {
  readonly company: Pick<Partial<Company>, 'sector' | 'region'>;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}): React.JSX.Element {
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-1', className)}>
      <SectorBadge sector={sectorOf(company)} size={size} />
      <RegionBadge region={regionOf(company)} size={size} />
    </span>
  );
}

/**
 * The primitive set.
 *
 * ```tsx
 * import { Panel, StatCard, DataTable, DeltaBadge } from '@/components/ui';
 * ```
 *
 * Every primitive is a client component, so a screen may pass handlers to any
 * of them. Props are documented in `apps/web/SCREEN_GUIDE.md`; that file is the
 * contract, and these are its implementation.
 */

export { ICON_NAMES, Icon, IconChip } from './icons';
export type { IconAccent, IconChipProps, IconName, IconProps } from './icons';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export { PageHeader, SectionHeading } from './SectionHeading';
export type { PageHeaderProps, SectionHeadingProps } from './SectionHeading';

export { StatCard } from './StatCard';
export type { StatCardProps } from './StatCard';

export { DataTable } from './DataTable';
export type { Column, DataTableProps } from './DataTable';

export { BarChart, BarSeries, LineChart, Sparkline, StackedBars } from './Charts';
export type {
  BarChartProps,
  BarDatum,
  BarSeriesCategory,
  BarSeriesDefinition,
  BarSeriesProps,
  LineChartProps,
  LineSeries,
  SparklineProps,
  StackedBarDatum,
  StackedBarsProps,
  StackedSegment,
} from './Charts';

export { DeltaBadge } from './DeltaBadge';
export type { DeltaBadgeProps } from './DeltaBadge';

export { AiLabel, Tag } from './Tag';
export type { TagProps } from './Tag';

export { TabBar } from './TabBar';
export type { TabBarProps, TabItem } from './TabBar';

export { Modal } from './Modal';
export type { ModalProps } from './Modal';

export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps, ConfirmTerm } from './ConfirmDialog';

export { Drawer } from './Drawer';
export type { DrawerProps } from './Drawer';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { KeyValueGrid } from './KeyValueGrid';
export type { KeyValueGridProps, KeyValueItem } from './KeyValueGrid';

export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps } from './ProgressBar';

export { Meter } from './Meter';
export type { MeterProps } from './Meter';

export { SliderField } from './SliderField';
export type { SliderFieldProps } from './SliderField';

export { NowAfter } from './NowAfter';
export type { NowAfterProps, NowAfterRow } from './NowAfter';

export { CashAfter, cashAfterOf } from './CashAfter';
export type { CashAfterProps } from './CashAfter';
export { chipStops, openCeiling, roundStep, snapToStep } from './sliderMath';
export type { ChipStop } from './sliderMath';

export { AccessBadge, CompanyChip, PersonChip, initialsOf } from './Chips';
export type { AccessBadgeProps, CompanyChipProps, CompanyLike, PersonChipProps, PersonLike } from './Chips';

export {
  RegionBadge,
  SECTOR_TINT,
  SectorBadge,
  SectorFilter,
  SectorRegionBadges,
  readingTone,
  regionIcon,
  regionLabel,
  regionOf,
  regionReadings,
  regionsPresent,
  sectorIcon,
  sectorLabel,
  sectorOf,
  sectorsPresent,
} from './sector';
export type { RegionBadgeProps, RegionReading, SectorBadgeProps } from './sector';

export { ADVISORY_CODES, ValidationBanner, hasAdvisory, labelOfStatus, toneOfStatus } from './ValidationBanner';
export type { ValidationBannerProps } from './ValidationBanner';

export { ActionQueueTray } from './ActionQueueTray';

export {
  TONE_CHIP,
  TONE_FILL,
  TONE_SOLID,
  TONE_TEXT,
  TONE_VAR,
  TONE_WASH,
  cx,
  isActivationKey,
  nextTrapIndex,
  toneOfDelta,
  toneOfLine,
} from './tokens';
export type { Tone } from './tokens';

export { useDialogFocus } from './focusTrap';
export type { DialogFocusOptions } from './focusTrap';

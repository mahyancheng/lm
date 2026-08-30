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

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export { PageHeader, SectionHeading } from './SectionHeading';
export type { PageHeaderProps, SectionHeadingProps } from './SectionHeading';

export { StatCard } from './StatCard';
export type { StatCardProps } from './StatCard';

export { DataTable } from './DataTable';
export type { Column, DataTableProps } from './DataTable';

export { BarChart, LineChart, Sparkline } from './Charts';
export type { BarChartProps, BarDatum, LineChartProps, LineSeries, SparklineProps } from './Charts';

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

export { AccessBadge, CompanyChip, PersonChip, initialsOf } from './Chips';
export type { AccessBadgeProps, CompanyChipProps, CompanyLike, PersonChipProps, PersonLike } from './Chips';

export { ValidationBanner, labelOfStatus, toneOfStatus } from './ValidationBanner';
export type { ValidationBannerProps } from './ValidationBanner';

export { ActionQueueTray } from './ActionQueueTray';

export { TONE_CHIP, TONE_FILL, TONE_TEXT, TONE_VAR, cx, toneOfDelta, toneOfLine } from './tokens';
export type { Tone } from './tokens';

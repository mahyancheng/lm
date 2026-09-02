'use client';

/**
 * Charts, drawn as inline SVG.
 *
 * No charting library: three shapes, flat fills, and every colour read from a
 * CSS variable so the palette owns them. Every chart is deterministic in its
 * layout, so a re-render never reshuffles a series.
 */

import { useId, useMemo } from 'react';
import { formatCount, formatPct } from '@frontier/shared';
import { TONE_VAR, cx, type Tone } from './tokens';

/* -------------------------------------------------------------------------- */
/*  Shared geometry                                                            */
/* -------------------------------------------------------------------------- */

interface Extent {
  readonly min: number;
  readonly max: number;
}

function extentOf(values: readonly number[], includeZero: boolean): Extent {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const pad = Math.abs(min) < 1e-9 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function project(value: number, extent: Extent, height: number, padTop: number, padBottom: number): number {
  const span = extent.max - extent.min;
  const usable = height - padTop - padBottom;
  return padTop + usable - ((value - extent.min) / span) * usable;
}

/* -------------------------------------------------------------------------- */
/*  Sparkline                                                                  */
/* -------------------------------------------------------------------------- */

export interface SparklineProps {
  readonly values: readonly number[];
  readonly width?: number;
  readonly height?: number;
  /** Defaults to gain/loss from the first-to-last direction. */
  readonly tone?: Tone;
  /** Fill the area under the line with a faint wash. */
  readonly area?: boolean;
  /** Mark the last point. */
  readonly marker?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
}

/** A bare trend line, sized to sit inside a `StatCard` or a table cell. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  tone,
  area = true,
  marker = true,
  className,
  ariaLabel,
}: SparklineProps): React.JSX.Element | null {
  const gradientId = useId();
  const points = useMemo(() => values.filter((value) => Number.isFinite(value)), [values]);
  if (points.length < 2) return null;

  const first = points[0] ?? 0;
  const last = points[points.length - 1] ?? 0;
  const resolved: Tone = tone ?? (last > first ? 'gain' : last < first ? 'loss' : 'neutral');
  const colour = TONE_VAR[resolved];
  const extent = extentOf(points, false);
  const step = width / (points.length - 1);

  const coords = points.map((value, index) => {
    const x = index * step;
    const y = project(value, extent, height, 2, 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const path = `M ${coords.join(' L ')}`;
  const lastCoord = coords[coords.length - 1]?.split(',') ?? ['0', '0'];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx('overflow-visible', className)}
      role="img"
      aria-label={ariaLabel ?? 'Trend'}
      preserveAspectRatio="none"
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity="0.20" />
              <stop offset="100%" stopColor={colour} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={`${path} L ${width},${height} L 0,${height} Z`} fill={`url(#${gradientId})`} stroke="none" />
        </>
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={colour}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {marker ? (
        <circle
          cx={Number(lastCoord[0])}
          cy={Number(lastCoord[1])}
          r="2.4"
          fill={colour}
          stroke="var(--color-panel)"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Line chart                                                                 */
/* -------------------------------------------------------------------------- */

export interface LineSeries {
  readonly id: string;
  readonly label: string;
  readonly values: readonly number[];
  readonly tone?: Tone;
  /** Dashed line, for a projection or a benchmark. */
  readonly dashed?: boolean;
}

export interface LineChartProps {
  readonly series: readonly LineSeries[];
  /** One label per point; rendered thinned to fit. */
  readonly xLabels?: readonly string[];
  readonly height?: number;
  /** Format for the y axis ticks. Defaults to a trimmed number. */
  readonly formatValue?: (value: number) => string;
  /** Force the y axis to include zero. */
  readonly includeZero?: boolean;
  readonly showLegend?: boolean;
  readonly className?: string;
}

const SERIES_TONES: readonly Tone[] = ['brand', 'info', 'warn', 'gain', 'loss', 'neutral'];

/**
 * A multi-series line chart with axis labels.
 *
 * Responsive by construction: the SVG scales to its container width while the
 * text stays legible, because labels are drawn in a fixed gutter.
 */
export function LineChart({
  series,
  xLabels,
  height = 180,
  formatValue,
  includeZero = false,
  showLegend = true,
  className,
}: LineChartProps): React.JSX.Element {
  const width = 640;
  const padLeft = 52;
  const padRight = 10;
  const padTop = 10;
  const padBottom = xLabels === undefined ? 12 : 24;

  const all = series.flatMap((entry) => [...entry.values]);
  const extent = extentOf(all, includeZero);
  const pointCount = Math.max(...series.map((entry) => entry.values.length), 2);
  const step = (width - padLeft - padRight) / Math.max(1, pointCount - 1);
  const format = formatValue ?? ((value: number) => (Math.abs(value) < 1 && value !== 0 ? formatPct(value) : formatCount(value)));

  const ticks = [extent.max, (extent.max + extent.min) / 2, extent.min];

  return (
    <div className={cx('w-full', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={series.map((entry) => entry.label).join(', ')}
        preserveAspectRatio="none"
      >
        {ticks.map((tick, index) => {
          const y = project(tick, extent, height, padTop, padBottom);
          return (
            <g key={`tick-${index}`}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--color-hair)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="var(--color-ink-faint)"
                fontFamily="var(--font-mono)"
              >
                {format(tick)}
              </text>
            </g>
          );
        })}

        {series.map((entry, seriesIndex) => {
          const tone = entry.tone ?? SERIES_TONES[seriesIndex % SERIES_TONES.length] ?? 'brand';
          const colour = TONE_VAR[tone];
          const coords = entry.values
            .filter((value) => Number.isFinite(value))
            .map((value, index) => `${(padLeft + index * step).toFixed(2)},${project(value, extent, height, padTop, padBottom).toFixed(2)}`);
          if (coords.length === 0) return null;
          return (
            <path
              key={entry.id}
              d={`M ${coords.join(' L ')}`}
              fill="none"
              stroke={colour}
              strokeWidth="2"
              strokeDasharray={entry.dashed === true ? '4 3' : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {xLabels === undefined
          ? null
          : xLabels.map((label, index) => {
              const stride = Math.max(1, Math.ceil(xLabels.length / 8));
              if (index % stride !== 0 && index !== xLabels.length - 1) return null;
              return (
                <text
                  key={`x-${label}-${index}`}
                  x={padLeft + index * step}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--color-ink-faint)"
                  fontFamily="var(--font-mono)"
                >
                  {label}
                </text>
              );
            })}
      </svg>

      {showLegend && series.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((entry, index) => {
            const tone = entry.tone ?? SERIES_TONES[index % SERIES_TONES.length] ?? 'brand';
            return (
              <span key={entry.id} className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                <span className="inline-block h-[3px] w-3.5 rounded-full" style={{ backgroundColor: TONE_VAR[tone] }} />
                {entry.label}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Bar chart                                                                  */
/* -------------------------------------------------------------------------- */

export interface BarDatum {
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
  /** Optional secondary caption under the label. */
  readonly caption?: string;
}

export interface BarChartProps {
  readonly data: readonly BarDatum[];
  /** Horizontal bars read better for long category labels; the default. */
  readonly orientation?: 'horizontal' | 'vertical';
  readonly formatValue?: (value: number) => string;
  readonly height?: number;
  /** Force the axis maximum, e.g. 1 for a 0..1 capability score. */
  readonly max?: number;
  readonly className?: string;
}

/** A categorical comparison. Twelve capability areas, five audiences, ten boards. */
export function BarChart({
  data,
  orientation = 'horizontal',
  formatValue,
  height = 180,
  max,
  className,
}: BarChartProps): React.JSX.Element {
  const format = formatValue ?? ((value: number) => (Math.abs(value) < 1 && value !== 0 ? formatPct(value) : formatCount(value)));
  const ceiling = max ?? Math.max(...data.map((datum) => Math.abs(datum.value)), 1e-9);

  if (orientation === 'horizontal') {
    return (
      <div className={cx('flex flex-col gap-1.5', className)}>
        {data.map((datum) => {
          const tone = datum.tone ?? 'brand';
          const pct = Math.max(0, Math.min(100, (Math.abs(datum.value) / ceiling) * 100));
          return (
            <div key={datum.label} className="grid grid-cols-[minmax(88px,34%)_1fr_auto] items-center gap-2">
              <div className="min-w-0">
                <div className="truncate text-[11px] text-ink-dim">{datum.label}</div>
                {datum.caption !== undefined ? <div className="truncate text-[10px] text-ink-faint">{datum.caption}</div> : null}
              </div>
              <div className="h-3 min-w-0 overflow-hidden rounded-pill bg-raised">
                <div className="h-full rounded-pill" style={{ width: `${pct}%`, backgroundColor: TONE_VAR[tone] }} />
              </div>
              <div className="figure w-14 text-right text-[11px] text-ink">{format(datum.value)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  const width = 640;
  const padBottom = 26;
  const padTop = 8;
  const slot = width / Math.max(1, data.length);
  const barWidth = Math.min(36, slot * 0.62);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      className={className}
      role="img"
      aria-label="Bar chart"
      preserveAspectRatio="none"
    >
      {data.map((datum, index) => {
        const tone = datum.tone ?? 'brand';
        const usable = height - padTop - padBottom;
        const barHeight = Math.max(1, (Math.abs(datum.value) / ceiling) * usable);
        const x = index * slot + (slot - barWidth) / 2;
        const y = height - padBottom - barHeight;
        return (
          <g key={`${datum.label}-${index}`}>
            <rect x={x} y={y} width={barWidth} height={barHeight} rx="5" fill={TONE_VAR[tone]} />
            <text
              x={index * slot + slot / 2}
              y={height - 14}
              textAnchor="middle"
              fontSize="9"
              fill="var(--color-ink-faint)"
              fontFamily="var(--font-mono)"
            >
              {format(datum.value)}
            </text>
            <text x={index * slot + slot / 2} y={height - 3} textAnchor="middle" fontSize="9" fill="var(--color-ink-dim)">
              {datum.label.length > 12 ? `${datum.label.slice(0, 11)}…` : datum.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

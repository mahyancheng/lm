'use client';

/**
 * The picture: wires and the hub in one SVG, pills and headers as HTML on top.
 *
 * Hook-free on purpose. Everything it draws is a pure function of a model and
 * a layout, so the whole diagram renders to static markup in a test — which is
 * how the privacy assertions can search the last thing before the screen
 * rather than a model two steps upstream of it.
 *
 * Text is HTML rather than SVG `<text>` wherever it has to wrap: an SVG string
 * has no line box, and a supplier called "Northwind Semiconductor Works" would
 * run off the side of a 130-point column. The SVG carries only what has to be
 * drawn — wires, the hub disc, the margin disc — and the words sit above it.
 *
 * No pan, no zoom, no horizontal scroll. The page scrolls when a column is
 * tall; the picture never does.
 */

import { CompanyGlyph, companyTint, cx } from '@/components/ui';
import { ConnectionPill } from './ConnectionPill';
import { MARGIN_R, type ConnectionsLayout, type LaidWire } from './layout';
import type { ConnectionsModel, PillAction, PillModel } from './model';

export interface ConnectionsDiagramProps {
  readonly model: ConnectionsModel;
  readonly layout: ConnectionsLayout;
  readonly onAct?: (action: PillAction) => void;
}

/** Stroke, width and dash per wire tone. Brand at 0.6 is my own line's own output. */
function wireStyle(wire: LaidWire): { stroke: string; width: number; opacity: number } {
  if (wire.tone === 'blocked') return { stroke: 'var(--color-loss)', width: 1.5, opacity: 0.75 };
  if (wire.tone === 'own') return { stroke: 'var(--color-brand)', width: 1.5, opacity: 0.6 };
  if (wire.tone === 'possible') return { stroke: 'var(--color-hair-strong)', width: 1, opacity: 0.45 };
  return { stroke: 'var(--color-hair-strong)', width: 1.5, opacity: 1 };
}

export function ConnectionsDiagram({ model, layout, onAct }: ConnectionsDiagramProps): React.JSX.Element {
  const boxes = new Map(layout.pills.map((pill) => [pill.key, pill]));
  const headers = new Map(layout.headers.map((header) => [header.key, header]));
  const pills: readonly PillModel[] = [...model.left, ...model.right].flatMap((group) => group.pills);
  const hub = model.hub;
  const hubAction: PillAction | null = hub?.action ?? null;
  const { marginAnchor } = layout.hub;

  return (
    <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }} data-testid="connections">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="absolute left-0 top-0"
        role="presentation"
        aria-hidden="true"
      >
        {layout.wires.map((wire) => {
          const style = wireStyle(wire);
          return (
            <path
              key={wire.key}
              d={wire.path}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeOpacity={style.opacity}
              strokeLinecap="round"
              strokeDasharray={wire.dashed ? '4 4' : undefined}
            />
          );
        })}

        {hub === null ? null : (
          <g data-testid="conn-hub">
            <circle
              cx={layout.hub.x + layout.hub.size / 2}
              cy={layout.hub.y + layout.hub.size / 2}
              r={layout.hub.size / 2}
              fill="var(--color-panel)"
              stroke={hub.own ? 'var(--color-brand)' : 'var(--color-hair-strong)'}
              strokeWidth={2}
            />
            <g transform={`translate(${layout.hub.x + 9} ${layout.hub.y + 9})`}>
              <CompanyGlyph tint={companyTint(hub.archetype, hub.own)} size="sm" />
            </g>
          </g>
        )}

        {/* The margin badge rides `marginAnchor` — the junction — rather than
            halfway along the trunk, which at this channel width would overlap
            the hub's own ring and read as part of the company instead of as a
            fact about the wire leaving it. */}
        {hub === null || hub.marginPct === null || !hub.showOutput ? null : (
          <g data-testid="conn-margin">
            <circle
              cx={marginAnchor.x}
              cy={marginAnchor.y}
              r={MARGIN_R}
              fill={hub.marginPct < 0 ? 'var(--color-loss-strong)' : 'var(--color-gain-strong)'}
            />
            <text
              x={marginAnchor.x}
              y={marginAnchor.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fontWeight={700}
              fill="#ffffff"
            >
              {`${hub.marginPct}%`}
            </text>
          </g>
        )}
      </svg>

      {/* --- the hub's words, above and below the disc ---------------------- */}
      {hub === null ? null : (
        <>
          <div
            className="absolute flex items-end justify-center"
            style={{ left: layout.hub.labelBox.x, top: layout.hub.labelBox.y, width: layout.hub.labelBox.width, height: layout.hub.labelBox.height }}
          >
            <span className="line-clamp-2 rounded-chip bg-panel px-1.5 py-0.5 text-center text-[10.5px] font-semibold leading-tight text-ink shadow-[0_0_0_1px_var(--color-hair)] [overflow-wrap:anywhere]">
              {hub.name}
            </span>
          </div>
          {/* Testid: the phone drive reads this box alone to prove a rival's hub
              carries no cost, price or ask — a figure on a wire I am on is
              legitimate, so the assertion cannot be made against the whole picture. */}
          <div
            data-testid="conn-hub-figures"
            className="absolute flex flex-col items-center justify-start gap-px text-center"
            style={{ left: layout.hub.figuresBox.x, top: layout.hub.figuresBox.y, width: layout.hub.figuresBox.width, height: layout.hub.figuresBox.height }}
          >
            {hub.figures.map((figure) => (
              <span key={figure} className="figure block max-w-full truncate text-[10px] leading-tight text-ink-faint">
                {figure}
              </span>
            ))}
          </div>
          {hubAction === null ? null : (
            <button
              type="button"
              data-testid="conn-hub-tap"
              aria-label={hub.ariaLabel}
              className="absolute rounded-pill"
              style={{ left: layout.hub.x - 2, top: layout.hub.y - 2, width: layout.hub.size + 4, height: layout.hub.size + 4 }}
              onClick={() => onAct?.(hubAction)}
            />
          )}
        </>
      )}

      {/* --- group headers -------------------------------------------------- */}
      {[...model.left, ...model.right].map((group) => {
        const box = headers.get(group.key);
        if (box === undefined) return null;
        const align = box.side === 'right' ? 'justify-start' : 'justify-end';
        return (
          <div
            key={`h:${group.key}`}
            data-testid="conn-header"
            className={cx('absolute flex flex-col overflow-hidden', box.side === 'right' ? 'items-start' : 'items-end')}
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          >
            {/* The slot's own name, at 8.5 points rather than the shared
                `label-caps` 10, because "COMPANY-WIDE" plus "+2 more" is 19
                characters and the column is 130 points. */}
            <div className={cx('flex w-full min-w-0 items-baseline gap-1 whitespace-nowrap', align)}>
              <span data-testid="conn-header-name" className="min-w-0 truncate text-[8.5px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                {box.text}
              </span>
              {group.required ? <span className="shrink-0 text-[8.5px] font-bold text-loss">*</span> : null}
              {group.moreLabel === null ? null : <span className="shrink-0 text-[8.5px] text-ink-faint">{group.moreLabel}</span>}
            </div>
            {box.subtext === null ? null : (
              // The recipe — how much of this input one unit consumes — on its
              // own line, because it is the sentence the picture is read by and
              // it does not fit beside the slot's name at any legible size.
              <span
                data-testid="conn-header-recipe"
                className={cx('w-full min-w-0 truncate text-[8.5px] leading-[10px] text-ink-faint', box.side === 'right' ? 'text-left' : 'text-right')}
              >
                {box.subtext}
              </span>
            )}
          </div>
        );
      })}

      {/* --- the pills ------------------------------------------------------ */}
      {pills.map((pill) => {
        const box = boxes.get(pill.key);
        if (box === undefined) return null;
        return <ConnectionPill key={pill.key} pill={pill} box={box} onAct={onAct} />;
      })}
    </div>
  );
}

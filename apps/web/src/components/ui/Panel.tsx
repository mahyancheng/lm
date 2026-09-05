'use client';

import type { ReactNode } from 'react';
import { IconChip, isIconName, type IconName } from './icons';
import { TONE_CHIP, cx, type Tone } from './tokens';

export interface PanelProps {
  /** Small-caps heading. Omit for an unlabelled surface. */
  readonly title?: ReactNode;
  /** One line under the title. */
  readonly subtitle?: ReactNode;
  /** Right-aligned controls in the header row: buttons, tabs, a filter. */
  readonly actions?: ReactNode;
  /**
   * A flat vector glyph in a tinted rounded square, left of the title.
   * Optional and additive: a panel without one is unchanged.
   */
  readonly icon?: ReactNode;
  /**
   * The usual way to give a panel its mark: a name from the icon set, drawn in
   * a tinted square. Takes precedence over `icon` when both are given.
   */
  readonly iconName?: IconName;
  /** Tint for the icon chip. Defaults to the quiet neutral. */
  readonly iconTone?: Tone;
  /** Remove the body padding, e.g. when the body is a `DataTable`. */
  readonly flush?: boolean;
  /** Tighter padding for dense metric grids. */
  readonly dense?: boolean;
  /** Cap the body height and scroll inside it. */
  readonly maxBodyHeight?: number;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children?: ReactNode;
}

/**
 * The unit every screen is built from: a white rounded card with a hairline, a
 * soft diffuse shadow and an optional header row.
 *
 * A page is a header row plus a grid of panels. Panels do not nest.
 */
export function Panel({
  title,
  subtitle,
  actions,
  icon,
  iconName,
  iconTone = 'neutral',
  flush = false,
  dense = false,
  maxBodyHeight,
  className,
  bodyClassName,
  children,
}: PanelProps): React.JSX.Element {
  const hasHeader = title !== undefined || actions !== undefined || subtitle !== undefined;
  // `icon` predates the icon set and takes a node; a bare name is understood
  // too, so both `icon="flask"` and `iconName="flask"` draw the flask.
  const mark = iconName ?? (isIconName(icon) ? icon : undefined);
  return (
    <section className={cx('panel-surface animate-pop-in flex min-w-0 flex-col overflow-hidden', className)}>
      {hasHeader ? (
        // The header WRAPS. A phone-width panel with two buttons in the actions
        // slot used to push them past the card's right edge and widen the
        // document; now the row breaks and the buttons sit under the title.
        <header className="flex min-h-[44px] shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-hair px-4 py-2.5">
          <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
            {mark !== undefined ? (
              <IconChip name={mark} tone={iconTone} />
            ) : icon !== undefined ? (
              <span
                aria-hidden="true"
                className={cx(
                  'flex size-7 shrink-0 items-center justify-center rounded-chip border text-[13px] leading-none',
                  TONE_CHIP[iconTone],
                )}
              >
                {icon}
              </span>
            ) : null}
            <div className="min-w-0">
              {title !== undefined ? <h2 className="label-caps truncate">{title}</h2> : null}
              {subtitle !== undefined ? <p className="mt-0.5 truncate text-[11px] text-ink-faint">{subtitle}</p> : null}
            </div>
          </div>
          {actions !== undefined ? <div className="flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={cx(
          'min-w-0 flex-1',
          flush ? '' : dense ? 'p-3' : 'p-4',
          maxBodyHeight !== undefined ? 'overflow-y-auto' : '',
          bodyClassName,
        )}
        style={maxBodyHeight !== undefined ? { maxHeight: maxBodyHeight } : undefined}
      >
        {children}
      </div>
    </section>
  );
}

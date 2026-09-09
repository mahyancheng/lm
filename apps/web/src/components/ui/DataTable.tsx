'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './icons';
import { cx, isActivationKey } from './tokens';

export interface Column<T> {
  /** Stable key; also the sort key. */
  readonly key: string;
  readonly header: ReactNode;
  /** Cell contents. Format figures with `@frontier/shared` before passing them. */
  readonly render: (row: T, index: number) => ReactNode;
  readonly align?: 'left' | 'right' | 'center';
  /** Fixed column width, e.g. `'96px'` or `'22%'`. */
  readonly width?: string;
  /** Enable sorting on this column. Provide `sortValue` for anything but a plain string cell. */
  readonly sortable?: boolean;
  readonly sortValue?: (row: T) => number | string;
  /** Render the cell in the tabular monospace face. Default for right-aligned columns. */
  readonly mono?: boolean;
  /** Hide below the `md` breakpoint, for columns a phone does not need. */
  readonly hideOnMobile?: boolean;
  /**
   * The label this column's value carries in card mode. Defaults to `header` —
   * set it where the header is an abbreviation that only reads above a column
   * of figures.
   */
  readonly cardLabel?: ReactNode;
  /** Leave this column out of the card entirely. */
  readonly cardHidden?: boolean;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T, index: number) => string;
  /** Navigate on row click. */
  readonly rowHref?: (row: T) => string | null;
  /** Handle a row click directly. Ignored when `rowHref` returns a value. */
  readonly onRowClick?: (row: T) => void;
  /** Highlight a row, e.g. the player's own company. */
  readonly isHighlighted?: (row: T) => boolean;
  readonly dense?: boolean;
  /** Column key to sort by initially. */
  readonly initialSort?: { readonly key: string; readonly direction: 'asc' | 'desc' };
  readonly empty?: ReactNode;
  readonly className?: string;
  /** Cap the height and scroll the body under a sticky header. */
  readonly maxHeight?: number;
  /**
   * `auto` — below `sm` each row is drawn as a stacked label/value card, and
   * the table itself only appears from `sm` up. Six columns of figures do not
   * fit across a 390px phone, and a table that has to be scrolled sideways to
   * be read is a table nobody reads.
   *
   * `off` (the default) keeps the table at every width, inside its own
   * horizontal scroller.
   */
  readonly cardMode?: 'auto' | 'off';
  /**
   * The column whose cell titles the card. Defaults to the first column that
   * is not `cardHidden`.
   */
  readonly cardTitleKey?: string;
}

/**
 * The dense, sortable table every list screen uses.
 *
 * Wide tables scroll inside their own container: the page body never scrolls
 * horizontally. Right-aligned columns are monospaced and tabular by default, so
 * decimals line up down a column.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  isHighlighted,
  dense = false,
  initialSort,
  empty,
  className,
  maxHeight,
  cardMode = 'off',
  cardTitleKey,
}: DataTableProps<T>): React.JSX.Element {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((entry) => entry.key === sort.key);
    if (column === undefined || column.sortable !== true) return rows;
    const value = column.sortValue ?? ((row: T) => String(column.render(row, 0) ?? ''));
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [rows, columns, sort]);

  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" message="This table has no rows for the current quarter." />}</>;
  }

  function toggleSort(key: string): void {
    setSort((current) => {
      if (current === null || current.key !== key) return { key, direction: 'desc' };
      return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
    });
  }

  const cards = cardMode === 'auto' ? columns.filter((column) => column.cardHidden !== true) : [];
  const titleColumn = cards.find((column) => column.key === cardTitleKey) ?? cards[0] ?? null;

  return (
    <>
      {cardMode === 'auto' ? (
        // The phone presentation. Same rows, same order, same handlers — the
        // row simply stops being a row and becomes a stack of label/value
        // pairs under whatever names it.
        <ul
          className={cx('flex flex-col gap-2 p-3 sm:hidden', maxHeight !== undefined ? 'overflow-y-auto' : '')}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
        >
          {sorted.map((row, index) => {
            const href = rowHref?.(row) ?? null;
            const highlighted = isHighlighted?.(row) === true;
            const body = (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1 text-[12.5px] font-semibold text-ink">
                    {titleColumn === null ? null : titleColumn.render(row, index)}
                  </div>
                  {href !== null || onRowClick !== undefined ? (
                    <span className="shrink-0 text-ink-faint">
                      <Icon name="chevronRight" size={13} accent="current" />
                    </span>
                  ) : null}
                </div>
                <dl className="mt-1.5 flex flex-col gap-1">
                  {cards
                    .filter((column) => column.key !== titleColumn?.key)
                    .map((column) => (
                      <div key={column.key} className="flex items-baseline justify-between gap-3">
                        <dt className="label-caps-faint shrink-0">{column.cardLabel ?? column.header}</dt>
                        <dd
                          className={cx(
                            'min-w-0 text-right text-[12px] text-ink',
                            (column.mono ?? column.align === 'right') ? 'figure' : '',
                          )}
                        >
                          {column.render(row, index)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </>
            );
            const shell = cx(
              'tap-target block w-full rounded-card border px-3 py-2.5 text-left',
              highlighted ? 'border-brand/25 bg-brand-wash' : 'border-hair bg-panel',
            );
            if (href !== null) {
              return (
                <li key={rowKey(row, index)}>
                  <Link href={href} className={cx(shell, 'press-pop')}>
                    {body}
                  </Link>
                </li>
              );
            }
            if (onRowClick !== undefined) {
              return (
                <li key={rowKey(row, index)}>
                  <button type="button" onClick={() => onRowClick(row)} className={cx(shell, 'press-pop')}>
                    {body}
                  </button>
                </li>
              );
            }
            return (
              <li key={rowKey(row, index)} className={shell}>
                {body}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div
        className={cx(
          'scroll-x',
          cardMode === 'auto' ? 'hidden sm:block' : '',
          maxHeight !== undefined ? 'overflow-y-auto' : '',
          className,
        )}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        <table className={cx('data-table', dense ? 'dense' : '')}>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort !== null && sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    style={column.width === undefined ? undefined : { width: column.width }}
                    className={cx(
                      column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left',
                      column.hideOnMobile === true ? 'hidden md:table-cell' : '',
                    )}
                  >
                    {column.sortable === true ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cx('inline-flex items-center gap-1 hover:text-ink', active ? 'text-ink' : '')}
                      >
                        {column.header}
                        <span className="text-[8px] opacity-70">{active ? (sort.direction === 'desc' ? '▼' : '▲') : '↕'}</span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => {
              const href = rowHref?.(row) ?? null;
              const clickable = href !== null || onRowClick !== undefined;
              // A clickable row is a control, so it takes focus, answers Enter and
              // Space, and says what it is. Twelve tables across eight screens
              // navigate from a row — on Markets it is the only way to reach the
              // trade ticket at all — and a bare `onClick` on a `<tr>` is
              // unreachable without a pointer.
              const activate = (): void => {
                if (href !== null) router.push(href);
                else onRowClick?.(row);
              };
              return (
                <tr
                  key={rowKey(row, index)}
                  data-clickable={clickable ? 'true' : 'false'}
                  // The highlight paints the cells, not the row: zebra striping
                  // sets a `td` background, and a `tr` background would sit under
                  // it. `.data-table` orders stripe < highlight < hover.
                  data-highlight={isHighlighted?.(row) === true ? 'true' : undefined}
                  role={clickable ? (href !== null ? 'link' : 'button') : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? activate : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (!isActivationKey(event.key)) return;
                          // Space would otherwise scroll the page under the row.
                          event.preventDefault();
                          activate();
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cx(
                        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left',
                        (column.mono ?? column.align === 'right') ? 'figure' : '',
                        column.hideOnMobile === true ? 'hidden md:table-cell' : '',
                      )}
                    >
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })}
            </tbody>
        </table>
      </div>
    </>
  );
}

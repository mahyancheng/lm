'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { cx } from './tokens';

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

  return (
    <div
      className={cx('scroll-x', maxHeight !== undefined ? 'overflow-y-auto' : '', className)}
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
            return (
              <tr
                key={rowKey(row, index)}
                data-clickable={clickable ? 'true' : 'false'}
                onClick={
                  clickable
                    ? () => {
                        if (href !== null) router.push(href);
                        else onRowClick?.(row);
                      }
                    : undefined
                }
                className={isHighlighted?.(row) === true ? 'bg-brand-wash/40' : undefined}
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
  );
}

'use client';

import type { ReactNode } from 'react';
import { cx } from './tokens';

export interface EmptyStateProps {
  readonly title: string;
  readonly message?: ReactNode;
  /** A single control that resolves the emptiness, e.g. "Open the Deal Room". */
  readonly action?: ReactNode;
  /** Two or three characters, drawn faintly above the title. */
  readonly glyph?: string;
  readonly compact?: boolean;
  readonly className?: string;
}

/**
 * What a surface says when it has nothing to show.
 *
 * Empty is information: no open proposals is a fact about the board, not a
 * loading state. Say what would fill it.
 */
export function EmptyState({ title, message, action, glyph, compact = false, className }: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center rounded-card border border-dashed border-hair-strong bg-raised/50 text-center',
        compact ? 'gap-1.5 px-4 py-6' : 'gap-2.5 px-6 py-12',
        className,
      )}
    >
      {glyph !== undefined ? (
        <div className="figure animate-bob-slow flex size-10 items-center justify-center rounded-pill bg-panel text-[16px] text-ink-faint shadow-card">
          {glyph}
        </div>
      ) : null}
      <p className="text-[13px] font-semibold text-ink-dim">{title}</p>
      {message !== undefined ? <p className="max-w-md text-[11px] text-ink-faint">{message}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

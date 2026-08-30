'use client';

import { RESOLUTION_PHASES } from '@frontier/contracts';
import { useLoading, useResolving } from '@/lib/game';

const PHASE_LABELS: readonly string[] = RESOLUTION_PHASES.map((phase) =>
  phase.replace(/_/g, ' ').replace(/^\w/, (character) => character.toUpperCase()),
);

/**
 * Shown while the engine resolves a quarter in this tab — or replays a save.
 *
 * The engine is synchronous and fast, but it is real work on the main thread:
 * the store yields a frame before calling it so this paints first, and a replay
 * yields between quarters for the same reason. The phase list is the actual
 * pipeline order, because that order is the drama.
 */
export function ResolvingOverlay(): React.JSX.Element | null {
  const { resolving, status } = useResolving();
  const { loading, progress } = useLoading();
  if (!resolving && !loading) return null;

  const heading = resolving ? 'Resolving quarter' : 'Replaying your session';
  const detail = resolving
    ? status === ''
      ? 'Working'
      : status
    : progress === null
      ? 'Reading the save'
      : `Quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`;
  const share = !resolving && progress !== null && progress.total > 0 ? progress.completed / progress.total : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-base/92 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="animate-fade-in w-[min(420px,calc(100vw-32px))] px-6 text-center">
        <div className="label-caps mb-2 tracking-[0.24em] text-brand">{heading}</div>
        <p className="text-[13px] text-ink">{detail}</p>

        <div className="mt-5 h-px w-full overflow-hidden bg-hair">
          {share === null ? (
            <div className="h-full w-1/3 animate-[fc-fade-in_1.1s_ease-in-out_infinite] bg-brand" />
          ) : (
            <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round(share * 100)}%` }} />
          )}
        </div>

        {resolving ? (
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-left text-[10px] text-ink-faint">
            {PHASE_LABELS.map((label) => (
              <li key={label} className="truncate">
                {label}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-5 text-[10px] text-ink-faint">
          Same state, same decisions, same seed — the same outcome, every time.
        </p>
      </div>
    </div>
  );
}

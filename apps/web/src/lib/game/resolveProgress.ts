/**
 * The resolving overlay's progress list, formatted.
 *
 * `endQuarter` (in `provider.tsx`) builds one `ProgressRow` per model call it
 * is making this quarter — the World Director, each priority-ordered
 * strategist, the deterministic engine pass, the social author loop — and
 * calls `formatProgressStatus` every time a row changes state or a ticking
 * timer fires, dispatching the result as `resolveStatus`. Pulled out here,
 * pure and separate from the store, so the format itself — what "done (Ns)"
 * or "on policy (budget)" actually renders as — is unit-testable without
 * mounting the provider or a network mock.
 *
 * `resolveStatus` stays exactly the `string` field it has always been: this
 * is formatting, not a new piece of state. The first line is always the
 * existing four-way headline `ResolvingOverlay`'s `stageOfStatus` already
 * recognises by `startsWith`; every line after it is one row.
 */

export type ProgressRowState = 'pending' | 'running' | 'done' | 'skipped';

/**
 * Mutable on purpose: `endQuarter` holds one of these per model call and
 * flips its fields in place as the call moves through its lifecycle — there
 * is exactly one write site per transition, and a fresh object per state
 * change would only make the call sites noisier for no benefit `Object.freeze`
 * would give real protection against here.
 */
export interface ProgressRow {
  label: string;
  state: ProgressRowState;
  /** When this row left `pending`, or null while it still is. */
  startedAt: number | null;
  /** When this row reached `done`, or null while it has not. */
  doneAt: number | null;
  /** Set only on `skipped`, e.g. `'on policy (budget)'`. */
  note: string | null;
}

/** Elapsed time from `startedAt` to `doneAt ?? now`, in whole tenths of a second. */
export function elapsedSeconds(row: Pick<ProgressRow, 'startedAt' | 'doneAt'>, now: number): number {
  if (row.startedAt === null) return 0;
  return Math.round(((row.doneAt ?? now) - row.startedAt) / 100) / 10;
}

/** One row, formatted as `ResolvingOverlay` renders it: `"label"`, `"label · Ns"`, `"label · done (Ns)"`, or `"label · <note>"`. */
export function formatProgressLine(row: ProgressRow, now: number): string {
  if (row.state === 'pending') return row.label;
  if (row.state === 'skipped') return `${row.label} · ${row.note ?? 'skipped'}`;
  const seconds = elapsedSeconds(row, now);
  return row.state === 'running' ? `${row.label} · ${seconds}s` : `${row.label} · done (${seconds}s)`;
}

/**
 * The whole `resolveStatus` string: the headline `ResolvingOverlay` stage-detects
 * on line one, then one line per row, in the order given.
 */
export function formatProgressStatus(headline: string, rows: readonly ProgressRow[], now: number): string {
  return [headline, ...rows.map((row) => formatProgressLine(row, now))].join('\n');
}

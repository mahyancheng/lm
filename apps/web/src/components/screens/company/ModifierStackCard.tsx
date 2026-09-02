'use client';

/**
 * V1 — a price or a cost, shown as a base figure and a signed list.
 *
 * This is the single most transferable idea in Plutocracy and the single thing
 * Plutocracy does worst: the modifiers exist, and the causal chain never
 * surfaces (§1.13). Here every row is one line the resolver committed, and
 * **tapping it opens the ledger row it came from** — the drill-down the study
 * says Plutocracy never built.
 *
 * The card computes nothing. `baseUsd`, every row's signed dollars and whole
 * percentage, and `totalUsd` are all written by `resolveFinancials`, and the
 * reconciliation line under the total is an assertion about the engine's own
 * arithmetic rather than a sum this component performed to render the figure.
 */

import type { CompanyModifierStack } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { EmptyState, Icon, cx } from '@/components/ui';
import { renderedStackRows, signedPct, stackReconciles } from '../sector/model';

export interface ModifierStackCardProps {
  readonly stack: CompanyModifierStack | null;
  /** What the base figure is called on this side of the statement. */
  readonly baseLabel: string;
  readonly totalLabel: string;
  /** Opens the committed ledger row behind a modifier. Omit to render rows inert. */
  readonly onOpenCause?: (eventId: string) => void;
  /** Copy for the case where the quarter wrote no stack at all. */
  readonly emptyMessage: string;
}

export function ModifierStackCard({
  stack,
  baseLabel,
  totalLabel,
  onOpenCause,
  emptyMessage,
}: ModifierStackCardProps): React.JSX.Element {
  const rows = renderedStackRows(stack);

  if (stack === null) {
    return <EmptyState compact icon="ledger" title="Nothing itemised yet" message={emptyMessage} />;
  }

  return (
    <div className="flex flex-col">
      {/* The base is the anchor the whole stack deviates from, so it is the
          first thing the eye lands on and the only bold figure above the total. */}
      <div className="flex items-baseline justify-between gap-3 border-b border-hair pb-2">
        <span className="label-caps-faint">{baseLabel}</span>
        <span className="figure text-[16px] font-bold text-ink">{formatMoney(stack.baseUsd)}</span>
      </div>

      {rows.length === 0 ? (
        <p className="py-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          Nothing moved this figure last quarter. The chain price sat at its baseline and no toll, accord or shortage
          reached you.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const openable = onOpenCause !== undefined && row.causeEventId !== null;
            const body = (
              <>
                <span
                  className={cx(
                    'flex size-7 shrink-0 items-center justify-center rounded-chip',
                    row.tone === 'gain' ? 'bg-gain-wash' : row.tone === 'loss' ? 'bg-loss-wash' : 'bg-raised',
                  )}
                >
                  <Icon name={row.icon} size={14} accent="current" />
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink">{row.label}</span>
                <span className={cx('figure shrink-0 text-[12px] tabular-nums', `tone-${row.tone}`)}>
                  {row.isExemption ? 'exempt' : row.pctLabel}
                </span>
                <span className={cx('figure w-[86px] shrink-0 text-right text-[12px] tabular-nums', `tone-${row.tone}`)}>
                  {row.isExemption ? '—' : row.amountLabel}
                </span>
                {openable ? <Icon name="chevronRight" size={13} accent="current" className="shrink-0 text-ink-faint" /> : null}
              </>
            );
            return (
              <li key={row.key} className="border-b border-hair last:border-0">
                {openable ? (
                  <button
                    type="button"
                    className="tap-target flex w-full items-center gap-2 px-0 py-1.5 text-left transition-colors hover:bg-raised sm:min-h-0"
                    onClick={() => onOpenCause?.(row.causeEventId as string)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex w-full items-center gap-2 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-1 flex items-baseline justify-between gap-3 border-t-2 border-hair-strong pt-2">
        <span className="label-caps-faint">{totalLabel}</span>
        <span className="flex items-baseline gap-2">
          <span className="figure text-[11px] text-ink-faint">{signedPct(stack.netPct)}</span>
          <span className="figure text-[16px] font-bold text-ink">{formatMoney(stack.totalUsd)}</span>
        </span>
      </div>

      <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
        {stackReconciles(stack)
          ? 'Base plus every row is the total, to the dollar. Tap a row to open the committed ledger entry it came from.'
          : 'These rows do not sum to the total, which is an engine defect rather than a rounding one. The ledger rows are the record.'}
      </p>
    </div>
  );
}

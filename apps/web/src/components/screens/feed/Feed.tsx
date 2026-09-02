'use client';

/**
 * The feed: one stream, full width, vertical scroll only.
 *
 * There is no "us and them" here and no table anywhere. Everything public is in
 * the one list, in the order the engine decided — newest quarter first, loudest
 * first within a quarter — with a divider where a quarter ends and a thread
 * hung under the post it answers.
 *
 * The component is deliberately dumb. It filters nothing, sorts nothing and
 * fetches nothing: `filters.ts` does the arithmetic, `projectPublicRecord` does
 * the redaction, and this draws the result. The one piece of state it owns is
 * which item's ledger rows are open.
 */

import { useMemo, useState } from 'react';
import type { PublicRecordItem, SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { EmptyState, type IconName } from '@/components/ui';
import { LedgerDrawer } from '@/components/screens/reporting/LedgerDrawer';
import { FeedItem, type FeedContext } from './FeedItem';
import { groupByQuarter, threadFeed, type FeedQuarter } from './filters';

export interface FeedProps {
  /** Already filtered, in engine order. */
  readonly items: readonly PublicRecordItem[];
  readonly context: FeedContext;
  /**
   * Committed rows for the quarters on show, keyed by `eventId`.
   *
   * Supplying them turns on the "Why" button; without them a card simply does
   * not offer one, because a ledger sheet with nothing in it explains nothing.
   */
  readonly ledgerById?: ReadonlyMap<string, SimEvent>;
  /**
   * A card pinned above the newest quarter's items — the quarter in review.
   * It is the first thing in the stream, not a panel stacked over it.
   */
  readonly leadCard?: React.ReactNode;
  readonly emptyTitle?: string;
  readonly emptyMessage?: string;
  readonly emptyIcon?: IconName;
  readonly emptyAction?: React.ReactNode;
}

export function Feed({
  items,
  context,
  ledgerById,
  leadCard,
  emptyTitle = 'Nothing on the record for this filter',
  emptyMessage = 'The world publishes as it resolves: events fire, the press picks them up, companies file and people post. Clear a filter, or end a quarter.',
  emptyIcon = 'globe',
  emptyAction,
}: FeedProps): React.JSX.Element {
  const [ledgerFor, setLedgerFor] = useState<PublicRecordItem | null>(null);

  const quarters: FeedQuarter[] = useMemo(() => groupByQuarter(threadFeed(items)), [items]);

  // The ledger button only exists when there are rows to open, so the context
  // the cards get carries the handler only when this feed was given a ledger.
  const cardContext: FeedContext = useMemo(
    () => (ledgerById === undefined ? { ...context, onOpenLedger: undefined } : { ...context, onOpenLedger: setLedgerFor }),
    [context, ledgerById],
  );

  const ledgerRows: readonly SimEvent[] = useMemo(() => {
    if (ledgerFor === null || ledgerById === undefined) return [];
    const rows: SimEvent[] = [];
    for (const id of ledgerFor.ledgerEventIds) {
      const row = ledgerById.get(id);
      if (row !== undefined) rows.push(row);
    }
    return rows.sort((a, b) => a.sequence - b.sequence);
  }, [ledgerFor, ledgerById]);

  if (quarters.length === 0) {
    return (
      <>
        {leadCard}
        <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} action={emptyAction} />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {quarters.map((group, index) => (
          <section key={group.quarter} className="flex flex-col gap-2.5" aria-label={quarterLabel(context.startYear, group.quarter)}>
            <div className="flex items-center gap-2">
              <span className="label-caps shrink-0">{quarterLabel(context.startYear, group.quarter)}</span>
              <span className="h-px flex-1 bg-hair" />
              <span className="figure shrink-0 text-[10px] text-ink-faint">{countOf(group)}</span>
            </div>

            {index === 0 ? leadCard : null}

            {group.threads.map((thread) => (
              <div key={thread.item.id} className="flex flex-col gap-1.5">
                <FeedItem item={thread.item} context={cardContext} />
                {thread.replies.map((reply) => (
                  <FeedItem key={reply.id} item={reply} context={cardContext} indented />
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>

      <LedgerDrawer
        open={ledgerFor !== null}
        onClose={() => setLedgerFor(null)}
        title="Why this happened"
        subtitle={ledgerFor?.headline}
        events={ledgerRows}
        emptyMessage="The rows behind this item are not in the ledger this session is holding. The ledger is kept from the moment a quarter resolves."
      />
    </>
  );
}

/** Cards in a quarter, replies included: what the divider counts. */
function countOf(group: FeedQuarter): number {
  return group.threads.reduce((total, thread) => total + 1 + thread.replies.length, 0);
}

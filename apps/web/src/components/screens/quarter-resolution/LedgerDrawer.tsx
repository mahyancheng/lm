'use client';

/**
 * The ledger rows behind one line.
 *
 * > **INVARIANT: every resolution line references at least one committed
 * > event.** Nothing on this screen is narrative invention.
 *
 * So every line is clickable and this is what opens: the actual `SimEvent`
 * rows, with their sequence, their visibility, their actor and target and their
 * payload printed verbatim. "Why did my stock fall?" is answered from committed
 * facts, decomposed, never by asking a model to invent a reason.
 */

import type { ResolutionLine, SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { Drawer, EmptyState, Tag } from '@/components/ui';
import { humanise } from '@/components/screens/reporting/util';

export interface LedgerDrawerProps {
  readonly line: ResolutionLine | null;
  readonly events: readonly SimEvent[];
  readonly startYear: number;
  readonly onClose: () => void;
}

const VISIBILITY_TONE: Readonly<Record<SimEvent['visibility'], 'gain' | 'info' | 'warn' | 'neutral'>> = {
  public: 'gain',
  sector: 'info',
  company: 'warn',
  private: 'neutral',
};

export function LedgerDrawer({ line, events, startYear, onClose }: LedgerDrawerProps): React.JSX.Element | null {
  if (line === null) return null;

  const referenced = line.refEventIds
    .map((id) => events.find((event) => event.eventId === id) ?? null)
    .filter((event): event is SimEvent => event !== null);

  return (
    <Drawer
      open
      onClose={onClose}
      title="What is behind this line"
      subtitle={`${humanise(line.phase)} · ${line.refEventIds.length} ledger row${line.refEventIds.length === 1 ? '' : 's'}`}
      width={560}
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-card border border-hair bg-raised px-3 py-2.5 text-[12.5px] leading-relaxed text-ink">
          {line.text}
          {line.deltaLabel === null ? null : <span className="figure ml-2 text-ink-dim">{line.deltaLabel}</span>}
        </p>

        {referenced.length === 0 ? (
          <EmptyState
            title="The rows are no longer in this batch"
            message="This line references committed events outside the window returned with the report. The append-only ledger still holds them."
            compact
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {referenced.map((event) => (
              <li key={event.eventId} className="raised-surface px-3 py-2.5">
                {/* The machine name of the row (`event.type`) is deliberately not
                    shown: the line's own text says what happened, and the
                    payload below carries the detail. */}
                <div className="flex items-center gap-1.5">
                  <Tag tone={VISIBILITY_TONE[event.visibility]}>{event.visibility}</Tag>
                  <span className="figure text-[10px] text-ink-faint">#{event.sequence}</span>
                </div>

                {/* One column on a phone: an id truncated to eight characters
                    tells nobody anything. Two from `sm`, as before. */}
                <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  <Row label="Quarter" value={quarterLabel(startYear, event.quarter)} />
                  <Row label="Actor" value={event.actorId ?? '—'} />
                  <Row label="Target" value={event.targetId ?? '—'} />
                  <Row label="Event id" value={event.eventId} />
                </dl>

                <div className="mt-2">
                  <div className="label-caps-faint mb-1">Payload</div>
                  <pre className="scroll-x figure max-h-56 overflow-y-auto rounded-card border border-hair bg-base px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-dim">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </div>

                <div className="mt-1.5 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <Row label="Hash before" value={event.stateHashBefore.slice(0, 16)} />
                  <Row label="Hash after" value={event.stateHashAfter.slice(0, 16)} />
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[10px] leading-relaxed text-ink-faint">
          Rows are never updated and never deleted. The hashes either side make a tampered ledger detectable, which is why a number on this
          screen can be trusted without trusting the interface that drew it.
        </p>
      </div>
    </Drawer>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-hair/60 pb-0.5">
      <dt className="label-caps-faint shrink-0">{label}</dt>
      <dd className="figure min-w-0 truncate text-[10px] text-ink-dim">{value}</dd>
    </div>
  );
}

'use client';

/**
 * The ledger rows behind a figure.
 *
 * Every economic mutation in the game creates a `SimEvent`, and every derived
 * number on a reporting screen can open the rows that produced it. This is the
 * component that shows them: the type, the actor, the target and the payload
 * exactly as committed, with the sequence numbers that place them in the
 * ledger.
 */

import type { SimEvent } from '@frontier/contracts';
import { Drawer, EmptyState, Tag, type Tone } from '@/components/ui';
import { humanise } from './util';

const VISIBILITY_TONE: Readonly<Record<string, Tone>> = {
  public: 'info',
  sector: 'brand',
  company: 'warn',
  private: 'loss',
};

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e4) / 1e4);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface LedgerDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly events: readonly SimEvent[];
  /** Copy shown when the selection matched no committed rows. */
  readonly emptyMessage?: string;
}

export function LedgerDrawer({ open, onClose, title, subtitle, events, emptyMessage }: LedgerDrawerProps): React.JSX.Element {
  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle} width={520}>
      {events.length === 0 ? (
        <EmptyState
          glyph="LGR"
          compact
          title="No ledger rows in this tab"
          message={
            emptyMessage ??
            'The ledger for a quarter is held from the moment it resolves. Resolve a quarter and this figure will open its committed rows.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.eventId} className="raised-surface px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink">{humanise(event.type)}</span>
                <span className="flex items-center gap-1.5">
                  <Tag tone={VISIBILITY_TONE[event.visibility] ?? 'neutral'} dot>
                    {event.visibility}
                  </Tag>
                  <span className="figure text-[10px] text-ink-faint">#{event.sequence}</span>
                </span>
              </div>

              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-ink-faint">
                <span>
                  Quarter <span className="figure text-ink-dim">{event.quarter}</span>
                </span>
                {event.actorId !== null ? (
                  <span>
                    Actor <span className="figure text-ink-dim">{event.actorId}</span>
                  </span>
                ) : null}
                {event.targetId !== null ? (
                  <span>
                    Target <span className="figure text-ink-dim">{event.targetId}</span>
                  </span>
                ) : null}
              </div>

              {Object.keys(event.payload).length > 0 ? (
                <dl className="mt-2 grid grid-cols-[minmax(0,40%)_minmax(0,60%)] gap-x-3 gap-y-1 border-t border-hair pt-2">
                  {Object.entries(event.payload).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="truncate text-[10px] text-ink-faint">{key}</dt>
                      <dd className="figure truncate text-[10px] text-ink-dim" title={renderValue(value)}>
                        {renderValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <p className="mt-2 truncate text-[9px] text-ink-faint" title={`${event.stateHashBefore} → ${event.stateHashAfter}`}>
                {event.stateHashBefore.slice(0, 10)} → {event.stateHashAfter.slice(0, 10)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

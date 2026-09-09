'use client';

/**
 * What the World section carries besides its events: the map, and the active
 * modifiers under a section rule. Nothing else — the four readings and the
 * "newsroom conditions" grid the old World block repeated are gone; the two
 * figures that frame every event sit in the masthead's index box.
 */

import { forwardRef, memo } from 'react';
import type { ActiveModifier, SessionState } from '@frontier/contracts';
import { EmptyState } from '@/components/ui';
import { WorldMap } from '@/components/scenes/map';
import { targetPathLabel } from '@/components/screens/reporting/util';
import { SectionRule } from './pieces';

export interface WorldSectionProps {
  readonly session: SessionState;
  readonly modifiers: readonly ActiveModifier[];
  readonly focusEventId: string | null;
  readonly onFocusHandled: () => void;
}

export const WorldSection = memo(
  forwardRef<HTMLDivElement, WorldSectionProps>(function WorldSection({ session, modifiers, focusEventId, onFocusHandled }, ref): React.JSX.Element {
    return (
      <div ref={ref} className="flex flex-col gap-3" data-testid="world-section">
        <section aria-label="The map">
          <SectionRule>The map</SectionRule>
          <p className="mt-1 mb-2 text-[11.5px] text-ink-dim">Tap a head office, an agency, a district or an event pin. Drag to pan; the stops zoom.</p>
          <div className="overflow-hidden border border-rule">
            <WorldMap className="rounded-none" focusEventId={focusEventId} onFocusHandled={onFocusHandled} />
          </div>
        </section>

        <section aria-label="Active modifiers">
          <SectionRule right={modifiers.length === 0 ? undefined : `${modifiers.length}`}>Active modifiers</SectionRule>
          {modifiers.length === 0 ? (
            <EmptyState
              compact
              icon="gauge"
              title="Nothing in effect"
              message="No modifier this seat may see is live. A modifier that privately targets a rival stays withheld, like any other private fact."
            />
          ) : (
            <ul className="flex flex-col">
              {modifiers.map((modifier) => (
                <li key={modifier.id} className="np-rule flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[12.5px] leading-snug font-semibold text-ink">{targetPathLabel(modifier.target, session)}</p>
                    <p className="np-deck mt-0.5 text-[12.5px] leading-snug">{modifier.reason}</p>
                  </div>
                  <span className={`np-kicker shrink-0 pt-0.5 ${modifier.remainingQuarters <= 1 ? 'text-warn' : ''}`}>
                    {modifier.remainingQuarters} qtr{modifier.remainingQuarters === 1 ? '' : 's'} left
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }),
);

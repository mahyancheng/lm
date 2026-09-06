'use client';

/**
 * Objectives — explicit goals, with no fixed victory screen.
 *
 * Each row is the label, the standing in the metric's own units
 * (`objectiveReading`) and the bar. The one-line description keeps the "why"
 * on the page; it is clipped rather than wrapped so that three objectives stay
 * three rows on a phone, and the full sentence is on the row's title.
 */

import type { PlayerView } from '@frontier/contracts';
import { EmptyState, Panel, ProgressBar } from '@/components/ui';
import { objectiveReading } from './objectives';

export interface ObjectivesCardProps {
  readonly objectives: PlayerView['objectives'];
}

export function ObjectivesCard({ objectives }: ObjectivesCardProps): React.JSX.Element {
  return (
    <Panel title="Objectives" iconName="trophy" subtitle="Explicit goals. There is no fixed victory screen.">
      {objectives.length === 0 ? (
        <EmptyState compact icon="trophy" title="No objectives set" message="This session was created without explicit objectives." />
      ) : (
        <div className="flex flex-col gap-3">
          {objectives.map((objective) => (
            <div key={objective.id} title={objective.description}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[13px] font-medium text-ink">{objective.label}</span>
                <span className="figure text-[11.5px] text-ink-dim">
                  {objectiveReading(objective.metric, objective.currentValue, objective.targetValue)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11.5px] text-ink-faint">{objective.description}</p>
              {/* No value label: the reading above already states the standing
                  in the metric's own units, and a second figure over every bar
                  is a row of noise on a phone. */}
              <ProgressBar className="mt-1.5" value={objective.progress} tone={objective.completedQuarter !== null ? 'gain' : 'brand'} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

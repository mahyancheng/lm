'use client';

/**
 * The Founder Index, taken apart.
 *
 * The composite consumes eight percentiles, never raw dollars, so that wealth
 * cannot eventually overwhelm every other dimension. Six of them are published
 * on boards of their own and are read from there; two are recomputed with the
 * same helper the engine uses, and only ever for the player's own founder.
 *
 * The panel states its own working: the weighted sum against the value the
 * engine published. If those two ever disagree, it says so rather than quietly
 * rendering the prettier number.
 */

import type { PlayerView, SessionState } from '@frontier/contracts';
import type { FounderIndexComponent } from '@frontier/contracts';
import { formatPct, formatScore } from '@frontier/shared';
import { EmptyState, Meter, SectionHeading, Tag } from '@/components/ui';
import { founderIndexBreakdown } from './founderIndexBreakdown';

const COMPONENT_LABEL: Readonly<Record<FounderIndexComponent, string>> = {
  wealth: 'Founder wealth',
  enterprise: 'Enterprise value',
  innovation: 'Innovation',
  reputation: 'Reputation',
  network: 'Network',
  government: 'Government standing',
  financialResilience: 'Financial resilience',
  sessionObjectives: 'Session objectives',
};

const COMPONENT_SOURCE: Readonly<Record<FounderIndexComponent, string>> = {
  wealth: 'founder_wealth board',
  enterprise: 'company_value board',
  innovation: 'innovation board',
  reputation: 'reputation board',
  network: 'network board',
  government: 'government board',
  financialResilience: 'recomputed from runway',
  sessionObjectives: 'recomputed from objectives',
};

export interface FounderIndexPanelProps {
  readonly session: SessionState;
  readonly view: PlayerView;
  readonly founderId: string;
  readonly founderName: string;
  readonly companyId: string;
}

export function FounderIndexPanel({
  session,
  view,
  founderId,
  founderName,
  companyId,
}: FounderIndexPanelProps): React.JSX.Element {
  const breakdown = founderIndexBreakdown(session, founderId, companyId);

  if (breakdown === null) {
    return (
      <EmptyState
        glyph="FI"
        title="The composite has not been computed yet"
        message="Leaderboards are rebuilt from state in the sixteenth phase of every resolution. Resolve a quarter and the eight components appear here."
      />
    );
  }

  const { published, components, computed, reconciles, weakest } = breakdown;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="label-caps-faint">{founderName}</div>
          <div className="flex items-baseline gap-2">
            <span className="figure text-[19px] font-medium text-ink">{formatScore(published.value * 100, 1)}</span>
            <span className="text-[11px] text-ink-faint">index · rank #{published.rank}</span>
          </div>
        </div>
        <Tag tone={reconciles ? 'gain' : 'warn'} dot title="The weighted sum of the eight components against the published composite.">
          {reconciles ? 'Components reconcile' : `Off by ${formatScore((computed - published.value) * 100, 2)}`}
        </Tag>
      </div>

      <div className="flex flex-col gap-3">
        {components.map((component) => (
          <div key={component.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[12px] text-ink">{COMPONENT_LABEL[component.key]}</span>
              <span className="flex items-baseline gap-3">
                <span className="figure text-[10px] text-ink-faint">weight {formatPct(component.weight, 0)}</span>
                <span className="figure text-[12px] text-ink">{formatPct(component.percentile, 0)}</span>
              </span>
            </div>
            <Meter value={component.percentile * 100} showValue={false} className="mt-1" />
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-ink-faint">{COMPONENT_SOURCE[component.key]}</span>
              <span className="figure text-[10px] text-ink-faint">contributes {formatScore(component.contribution * 100, 1)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-hair pt-3">
        <SectionHeading>What is holding you back</SectionHeading>
        <p className="mt-1 text-[12px] text-ink-dim">
          {weakest === null
            ? 'No component is scored yet.'
            : `${COMPONENT_LABEL[weakest.key]} sits at the ${formatPct(weakest.percentile, 0)} percentile and carries ${formatPct(
                weakest.weight,
                0,
              )} of the composite. It is the cheapest point on the index to move.`}
        </p>
        <p className="mt-2 text-[10px] text-ink-faint">
          Every input is a percentile within this session, never a raw dollar amount. The weights are session data read from
          FOUNDER_INDEX_WEIGHTS, not interface constants. Objectives visible to you: {view.objectives.length}.
        </p>
      </div>
    </div>
  );
}

'use client';

/**
 * Why one founder outranks another.
 *
 * `ConnectionLevelInputs` exists so this panel can be honest: ten percentile
 * inputs, each with a published weight, and the level they produce. It is
 * emphatically not follower count — `publicFollowing` carries 0.05 of 1.0 and
 * the quality of a few real mutual relationships carries 0.12, and a player who
 * can see that will play the network differently.
 *
 * The engine blends the computed level into the standing one with inertia and a
 * step limit, so the two numbers differ by design; both are shown.
 */

import type { ConnectionLevelInputs } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import { CONNECTION_INERTIA, CONNECTION_WEIGHTS, MAX_CONNECTION_STEP, connectionContribution } from '@frontier/simulation';
import { DeltaBadge, Meter, SectionHeading } from '@/components/ui';

type InputKey = keyof typeof CONNECTION_WEIGHTS;

const LABELS: Readonly<Record<InputKey, string>> = {
  founderReputation: 'Founder reputation',
  companySignificance: 'Company significance',
  personalWealth: 'Personal wealth',
  boardPositions: 'Board positions',
  investorRelationships: 'Investor relationships',
  governmentCredibility: 'Government credibility',
  mediaInfluence: 'Media influence',
  priorExits: 'Prior exits',
  publicFollowing: 'Public following',
  mutualRelationshipQuality: 'Mutual relationship quality',
};

const ORDER: readonly InputKey[] = [
  'companySignificance',
  'founderReputation',
  'mutualRelationshipQuality',
  'personalWealth',
  'boardPositions',
  'investorRelationships',
  'governmentCredibility',
  'mediaInfluence',
  'priorExits',
  'publicFollowing',
];

export interface ConnectionBreakdownProps {
  readonly inputs: ConnectionLevelInputs | null;
  /** The level the character actually carries this quarter. */
  readonly standingLevel: number;
}

export function ConnectionBreakdown({ inputs, standingLevel }: ConnectionBreakdownProps): React.JSX.Element {
  if (inputs === null) {
    return <p className="text-[11px] text-ink-faint">No connection inputs are available for this character.</p>;
  }

  const drift = inputs.computedLevel - standingLevel;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <div className="label-caps-faint">Standing level</div>
          <div className="figure text-[19px] leading-none text-ink">{Math.round(standingLevel)}</div>
        </div>
        <div>
          <div className="label-caps-faint">Computed from inputs</div>
          <div className="figure text-[19px] leading-none text-ink">{Math.round(inputs.computedLevel)}</div>
        </div>
        <div>
          <div className="label-caps-faint">Pull next quarter</div>
          <div className="mt-1">
            <DeltaBadge value={drift} format="rank" />
          </div>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-dim">
        Each input is a percentile within this session, never a raw dollar amount. Standing moves slowly:{' '}
        {formatPct(CONNECTION_INERTIA)} of last quarter's level survives and no level may move more than {MAX_CONNECTION_STEP} points in one
        quarter.
      </p>

      <SectionHeading rule>The ten inputs</SectionHeading>

      <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {ORDER.map((key) => {
          const percentile = inputs[key];
          const weight = CONNECTION_WEIGHTS[key];
          const share = connectionContribution(inputs, key);
          return (
            <div key={key}>
              <Meter
                value={percentile * 100}
                label={
                  <span>
                    {LABELS[key]}
                    <span className="ml-1.5 text-ink-faint">w {formatPct(weight)}</span>
                  </span>
                }
              />
              <div className="mt-0.5 text-[10px] text-ink-faint">
                {formatPct(percentile)} percentile · explains {formatPct(share)} of the level
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

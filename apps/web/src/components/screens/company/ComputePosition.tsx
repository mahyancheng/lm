'use client';

/**
 * The compute position panel.
 *
 * Every figure here is either read straight off `ComputeHoldings` or derived by
 * the engine's own exported functions — `heldComputeUnits`, `servingComputeUnits`
 * and `customersPerUnit`. Nothing on this panel is estimated by the interface.
 *
 * The reading a player needs in one glance is *capacity against demand on both
 * sides of the split*: training capacity against the compute the running
 * research programmes have claimed, and serving capacity against what the
 * installed customer base actually consumes. Selling past serving capacity is a
 * churn event; letting a reservation lapse into a shortage is how sessions are
 * lost.
 */

import type { Company, ResearchProject, SessionState } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { customersPerUnit, heldComputeUnits, servingComputeUnits } from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import { KeyValueGrid, Panel, ProgressBar, Tag } from '@/components/ui';

export interface ComputePositionProps {
  readonly session: SessionState;
  readonly company: Company;
  /** The player's own programmes, secret ones included. */
  readonly projects: readonly ResearchProject[];
}

/** Accelerator-equivalents the running research programmes have claimed. */
export function researchComputeDemand(projects: readonly ResearchProject[]): number {
  return projects
    .filter((project) => project.status === 'active' || project.status === 'paused')
    .reduce((total, project) => total + project.computeAllocated, 0);
}

/** Accelerator-equivalents the installed customer base consumes to be served. */
export function inferenceComputeDemand(session: SessionState, company: Company): number {
  return company.products
    .filter((product) => product.isActive)
    .reduce((total, product) => {
      const perUnit = customersPerUnit(session, product.computeIntensity);
      return total + (perUnit <= 0 ? 0 : product.activeCustomers / perUnit);
    }, 0);
}

/**
 * Accelerator counts, grouped in threes. Deliberately not `toLocaleString`:
 * every figure in this interface is formatted by code that reads the same way
 * in every locale, and `@frontier/shared` has no count formatter.
 */
const units = (value: number): string => String(Math.round(Math.max(0, value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function ComputePosition({ session, company, projects }: ComputePositionProps): React.JSX.Element {
  const holdings = company.compute;
  const held = heldComputeUnits(session, company);
  const serving = servingComputeUnits(session, company);
  const training = Math.max(0, held - serving);
  const cloudUnits = Math.max(0, held - holdings.ownedAccelerators - holdings.reservedAccelerators);

  const researchDemand = researchComputeDemand(projects);
  const inferenceDemand = inferenceComputeDemand(session, company);

  const expiry = holdings.reservationExpiryQuarter;
  const quartersToExpiry = expiry === null ? null : expiry - session.quarter;
  const expiryTone = quartersToExpiry === null ? 'neutral' : quartersToExpiry <= 2 ? 'warn' : 'neutral';

  const trainingShort = researchDemand > training;
  const servingShort = inferenceDemand > serving;

  return (
    <Panel
      title="Compute position"
      subtitle={`${units(held)} accelerator-equivalents held`}
      actions={
        holdings.reservedAccelerators > 0 && quartersToExpiry !== null && quartersToExpiry <= 2 ? (
          <Tag tone="warn" dot>
            Reservation lapsing
          </Tag>
        ) : undefined
      }
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Owned', value: units(holdings.ownedAccelerators), hint: 'Depreciating capital, immune to spot price' },
          { label: 'Reserved', value: units(holdings.reservedAccelerators), hint: 'Held under multi-quarter reservation' },
          {
            label: 'Reservation expiry',
            value: expiry === null ? 'None held' : quarterLabel(session.startYear, expiry),
            tone: expiryTone,
            hint: quartersToExpiry === null ? 'Nothing reserved' : `${Math.max(0, quartersToExpiry)} quarters remaining`,
          },
          { label: 'Cloud spend', value: formatMoney(holdings.cloudSpendQuarterly), hint: `≈ ${units(cloudUnits)} units at spot` },
          { label: 'Utilisation', value: formatPct(holdings.computeUtilisation), hint: 'Fraction of held capacity in use' },
          { label: 'Training share', value: formatPct(holdings.trainingAllocation), hint: 'Serving takes the remainder' },
        ]}
      />

      <div className="mt-4 space-y-3">
        <ProgressBar
          label="Training capacity vs research demand"
          value={Math.min(researchDemand, training)}
          max={Math.max(training, researchDemand, 1)}
          ghostValue={training}
          tone={trainingShort ? 'warn' : 'brand'}
          valueLabel={`${units(researchDemand)} / ${units(training)}`}
        />
        <ProgressBar
          label="Serving capacity vs inference demand"
          value={Math.min(inferenceDemand, serving)}
          max={Math.max(serving, inferenceDemand, 1)}
          ghostValue={serving}
          tone={servingShort ? 'loss' : 'gain'}
          valueLabel={`${units(inferenceDemand)} / ${units(serving)}`}
        />
      </div>

      <p className="mt-3 text-[10px] text-ink-faint">
        {servingShort
          ? 'Inference demand exceeds serving capacity: customers churn out of the shortfall before the next quarter closes.'
          : trainingShort
            ? 'Research programmes have claimed more capacity than the training split holds. Progress stalls at the lower figure.'
            : 'Held capacity covers both sides of the split at the current allocation.'}
      </p>
    </Panel>
  );
}

'use client';

/**
 * The compute drawer — what the server room opens.
 *
 * The Compute position panel answers "what do we hold". This answers the
 * question a player asks *after* clicking the racks: how the fleet was procured,
 * which side of the training/serving split is short, and how long the
 * reservation that props it up has left.
 *
 * Every figure is read off `ComputeHoldings` or produced by the engine's own
 * exported functions — `heldComputeUnits`, `servingComputeUnits`,
 * `customersPerUnit` (through `inferenceComputeDemand`). Nothing here is
 * estimated by the interface, and the two demand helpers are shared with the
 * panel so the drawer and the panel can never disagree.
 */

import Link from 'next/link';
import type { Company, ResearchProject, SessionState } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { heldComputeUnits, servingComputeUnits } from '@frontier/simulation';
import { formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import { Drawer, Icon, KeyValueGrid, ProgressBar, SectionHeading, Tag } from '@/components/ui';
import { inferenceComputeDemand, researchComputeDemand } from './ComputePosition';

/** Accelerator counts, grouped in threes. Same rendering as the panel. */
const units = (value: number): string => String(Math.round(Math.max(0, value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export interface ComputeDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: SessionState;
  readonly company: Company;
  /** The player's own programmes, secret ones included. */
  readonly projects: readonly ResearchProject[];
}

export function ComputeDrawer({ open, onClose, session, company, projects }: ComputeDrawerProps): React.JSX.Element {
  const holdings = company.compute;
  const held = heldComputeUnits(session, company);
  const serving = servingComputeUnits(session, company);
  const training = Math.max(0, held - serving);
  const fleet = holdings.ownedAccelerators + holdings.reservedAccelerators;
  const cloudUnits = Math.max(0, held - fleet);

  const researchDemand = researchComputeDemand(projects);
  const inferenceDemand = inferenceComputeDemand(session, company);
  const trainingShort = researchDemand > training;
  const servingShort = inferenceDemand > serving;

  const expiry = holdings.reservationExpiryQuarter;
  const quartersToExpiry = expiry === null ? null : expiry - session.quarter;
  const lapsing = holdings.reservedAccelerators > 0 && quartersToExpiry !== null && quartersToExpiry <= 2;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Server room"
      subtitle={`${units(held)} accelerator-equivalents held · ${formatPct(holdings.computeUtilisation)} utilised`}
      footer={
        <>
          <Link className="btn tap-target flex-1 gap-1.5 sm:flex-none" href="/research">
            <Icon name="flask" size={16} accent="current" />
            Research
          </Link>
          <Link className="btn btn-primary tap-target flex-1 gap-1.5 sm:flex-none" href="/products">
            <Icon name="box" size={16} accent="current" />
            Product demand
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <SectionHeading rule>How the fleet was procured</SectionHeading>
          <div className="mt-2">
            <KeyValueGrid
              columns={2}
              items={[
                {
                  label: 'Owned',
                  value: units(holdings.ownedAccelerators),
                  hint: 'Depreciating capital, immune to the spot price',
                },
                {
                  label: 'Reserved',
                  value: units(holdings.reservedAccelerators),
                  hint: 'Held under multi-quarter reservation',
                  tone: lapsing ? 'warn' : undefined,
                },
                {
                  label: 'Cloud spend',
                  value: formatMoney(holdings.cloudSpendQuarterly),
                  hint: `≈ ${units(cloudUnits)} units at the current spot price`,
                },
                {
                  label: 'Held capacity',
                  value: units(held),
                  hint: 'Owned plus reserved plus what the cloud spend buys',
                },
              ]}
            />
          </div>
        </div>

        <div>
          <SectionHeading rule>Reservation</SectionHeading>
          <div className="mt-2">
            {holdings.reservedAccelerators === 0 ? (
              <p className="text-[11px] text-ink-faint">
                Nothing is reserved. The fleet is owned capital and on-demand cloud, so it carries no expiry risk and full
                exposure to the spot price.
              </p>
            ) : (
              <>
                <KeyValueGrid
                  columns={2}
                  items={[
                    {
                      label: 'Expires',
                      value: expiry === null ? '—' : quarterLabel(session.startYear, expiry),
                      tone: lapsing ? 'warn' : undefined,
                    },
                    {
                      label: 'Remaining',
                      value: quartersToExpiry === null ? '—' : formatQuarterCount(Math.max(0, quartersToExpiry)),
                      tone: lapsing ? 'warn' : undefined,
                    },
                  ]}
                />
                {lapsing ? (
                  <p className="mt-2 text-[11px] tone-warn">
                    {units(holdings.reservedAccelerators)} reserved units lapse within two quarters. Letting them go while
                    serving demand is this high turns into a customer shortfall the quarter after.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div>
          <SectionHeading
            rule
            actions={
              servingShort ? <Tag tone="loss" dot>Serving short</Tag> : trainingShort ? <Tag tone="warn" dot>Training short</Tag> : <Tag tone="gain" dot>Covered</Tag>
            }
          >
            Capacity against demand
          </SectionHeading>
          <div className="mt-2 space-y-3">
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
            <ProgressBar
              label="Training share of the split"
              value={holdings.trainingAllocation}
              max={1}
              tone="info"
              valueLabel={`${formatPct(holdings.trainingAllocation)} training · ${formatPct(1 - holdings.trainingAllocation)} serving`}
            />
          </div>
          <p className="mt-3 text-[11px] text-ink-faint">
            {servingShort
              ? 'Inference demand exceeds serving capacity: customers churn out of the shortfall before the next quarter closes.'
              : trainingShort
                ? 'Research programmes have claimed more capacity than the training split holds. Progress stalls at the lower figure.'
                : 'Held capacity covers both sides of the split at the current allocation.'}
          </p>
        </div>
      </div>
    </Drawer>
  );
}

'use client';

/**
 * The sites drawer — what the lobby opens.
 *
 * The lobby wall carries the company's name and tier, so the lobby is the right
 * place to ask what the company physically *is*: how many sites, how many seats
 * those sites hold against the headcount trying to sit in them, and what the
 * occupancy costs every quarter.
 *
 * Nothing here is derived beyond summing `Office.headcountCapacity` and
 * `Office.quarterlyCostUsd`, both of which are committed state.
 */

import Link from 'next/link';
import type { Company, SessionState } from '@frontier/contracts';
import { STAFF_ROLES, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { Drawer, EmptyState, KeyValueGrid, ProgressBar, SectionHeading, Tag } from '@/components/ui';

export interface SitesDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: SessionState;
  readonly company: Company;
}

export function SitesDrawer({ open, onClose, session, company }: SitesDrawerProps): React.JSX.Element {
  const headcount = STAFF_ROLES.reduce((total, role) => total + company.employees[role], 0);
  const capacity = company.offices.reduce((total, office) => total + office.headcountCapacity, 0);
  const quarterlyCost = company.offices.reduce((total, office) => total + office.quarterlyCostUsd, 0);
  const overCapacity = capacity > 0 && headcount > capacity;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={company.name}
      subtitle={`${company.headquartersCity} · ${company.tier} tier · ${company.isPublic ? `listed as ${company.ticker ?? '—'}` : 'privately held'}`}
      footer={
        <Link className="btn btn-sm btn-primary" href="/people">
          Headcount plan
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Sites', value: company.offices.length },
            { label: 'Seats', value: capacity, tone: overCapacity ? 'warn' : undefined },
            { label: 'People', value: headcount },
            { label: 'Open roles', value: company.employees.openRoles, hint: 'Recruiting, not yet filled' },
            { label: 'Occupancy', value: formatMoney(quarterlyCost), hint: 'Fixed cost, every quarter', wide: true },
          ]}
        />

        {capacity > 0 ? (
          <ProgressBar
            label="Seats taken"
            value={Math.min(headcount, capacity)}
            max={Math.max(capacity, headcount, 1)}
            ghostValue={capacity}
            tone={overCapacity ? 'warn' : 'brand'}
            valueLabel={`${headcount} / ${capacity}`}
          />
        ) : null}

        {overCapacity ? (
          <p className="text-[11px] tone-warn">
            There are {headcount - capacity} more people than seats. Growth is constrained until another site opens.
          </p>
        ) : null}

        <div>
          <SectionHeading rule>Sites</SectionHeading>
          <div className="mt-2 space-y-2">
            {company.offices.length === 0 ? (
              <EmptyState
                compact
                title="No physical office"
                message="Headcount growth is uncapped and fixed occupancy cost is zero."
              />
            ) : (
              company.offices.map((office) => {
                const share = office.headcountCapacity === 0 ? 0 : Math.min(1, headcount / office.headcountCapacity);
                return (
                  <div key={office.id} className="raised-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-ink">{office.city}</div>
                        <div className="text-[10px] text-ink-faint">
                          Opened {quarterLabel(session.startYear, office.openedQuarter)} · {office.headcountCapacity} seats
                        </div>
                      </div>
                      {office.isHeadquarters ? <Tag tone="brand">HQ</Tag> : null}
                    </div>
                    <div className="mt-2.5">
                      <ProgressBar
                        label="Capacity used"
                        value={share}
                        tone={share > 0.9 ? 'warn' : 'brand'}
                        valueLabel={formatPct(share, 0)}
                      />
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="label-caps-faint">Quarterly cost</span>
                      <span className="figure text-[12px] text-ink">{formatMoney(office.quarterlyCostUsd)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
}

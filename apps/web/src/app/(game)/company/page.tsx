'use client';

/**
 * Company — the operating overview.
 *
 * What the company *is*: archetype, posture, people, sites, compute and
 * standing with five separate audiences. Nothing here is a control surface;
 * every lever that changes these figures lives on Products, People, Research or
 * Capital, and this screen links to them.
 *
 * Information boundary: everything on this screen is the player's own company,
 * read from `SessionState`. The one place rivals appear — the group structure
 * panel — reads `usePlayerView().visibleCompanies`, so an acquired subsidiary
 * shows its identity and nothing operational.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { StaffRole } from '@frontier/contracts';
import { STAFF_ROLES, quarterLabel } from '@frontier/contracts';
import { requiredCompUsd } from '@frontier/simulation';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import {
  BarChart,
  CompanyChip,
  DataTable,
  Drawer,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  PersonChip,
  ProgressBar,
  SectionHeading,
  StatCard,
  Tag,
  type Column,
} from '@/components/ui';
import { ComputePosition } from '@/components/screens/company/ComputePosition';
import {
  ARCHETYPE_BLURB,
  ARCHETYPE_LABEL,
  POSTURE_BLURB,
  POSTURE_LABEL,
  REPUTATION_AUDIENCES,
  ROLE_BLURB,
  ROLE_LABEL,
  capabilityLabel,
} from '@/components/screens/company/labels';
import { useCompanyMetrics, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

interface RoleRow {
  readonly role: StaffRole;
  readonly headcount: number;
  readonly share: number;
  readonly marketCompUsd: number;
}

export default function CompanyPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const metrics = useCompanyMetrics();
  const [openRole, setOpenRole] = useState<StaffRole | null>(null);

  const employees = company.employees;
  const headcount = STAFF_ROLES.reduce((total, role) => total + employees[role], 0);

  const roleRows = useMemo<RoleRow[]>(
    () =>
      STAFF_ROLES.map((role) => ({
        role,
        headcount: employees[role],
        share: headcount === 0 ? 0 : employees[role] / headcount,
        marketCompUsd: requiredCompUsd(session, role),
      })),
    [employees, headcount, session],
  );

  const capacity = company.offices.reduce((total, office) => total + office.headcountCapacity, 0);
  const siteCost = company.offices.reduce((total, office) => total + office.quarterlyCostUsd, 0);

  const capabilities = useMemo(
    () =>
      Object.entries(company.techCapabilities)
        .map(([area, strength]) => ({ label: capabilityLabel(area), value: strength, tone: 'brand' as const }))
        .sort((a, b) => b.value - a.value),
    [company.techCapabilities],
  );

  const executives = useMemo(
    () => session.characters.filter((character) => character.companyId === company.id && character.isActive),
    [session.characters, company.id],
  );

  const subsidiaries = useMemo(
    () => view.visibleCompanies.filter((rival) => rival.parentCompanyId === company.id),
    [view.visibleCompanies, company.id],
  );
  const parent = useMemo(
    () => (company.parentCompanyId === null ? null : (view.visibleCompanies.find((rival) => rival.id === company.parentCompanyId) ?? null)),
    [view.visibleCompanies, company.parentCompanyId],
  );

  const columns: readonly Column<RoleRow>[] = [
    {
      key: 'role',
      header: 'Function',
      render: (row) => <span className="text-ink">{ROLE_LABEL[row.role]}</span>,
      sortable: true,
      sortValue: (row) => ROLE_LABEL[row.role],
    },
    { key: 'headcount', header: 'Headcount', align: 'right', render: (row) => row.headcount, sortable: true, sortValue: (row) => row.headcount },
    {
      key: 'share',
      header: 'Share',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatPct(row.share, 0),
      sortable: true,
      sortValue: (row) => row.share,
    },
    {
      key: 'market',
      header: 'Market comp',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatMoney(row.marketCompUsd),
      sortable: true,
      sortValue: (row) => row.marketCompUsd,
    },
    {
      key: 'leaving',
      header: 'Leaving next quarter',
      align: 'right',
      render: (row) => Math.round(row.headcount * employees.attrition),
      sortable: true,
      sortValue: (row) => row.headcount * employees.attrition,
    },
  ];

  const drawerRole = openRole === null ? null : (roleRows.find((row) => row.role === openRole) ?? null);

  return (
    <>
      <PageHeader
        title={company.name}
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · Company`}
        subtitle={`${ARCHETYPE_LABEL[company.archetype]} · ${company.headquartersCity} · ${company.isPublic ? `listed as ${company.ticker ?? '—'}` : 'privately held'}`}
        actions={
          <>
            <Tag tone="brand">{POSTURE_LABEL[company.posture]}</Tag>
            <Tag tone="neutral">{company.tier} tier</Tag>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Headcount" value={headcount} unit="FTE" hint={`${employees.openRoles} roles open`} href="/people" />
        <StatCard
          label="Morale"
          value={formatScore(employees.morale)}
          tone={employees.morale >= 70 ? 'gain' : employees.morale >= 45 ? undefined : 'warn'}
          hint={`Attrition ${formatPct(employees.attrition)} per quarter`}
          href="/people"
        />
        <StatCard
          label="Quarterly payroll"
          value={formatMoney(company.financials.payroll)}
          hint={`Average comp ${formatMoney(employees.avgComp)}`}
          href="/financials"
        />
        <StatCard
          label="Runway"
          value={metrics === null ? '—' : formatQuarterCount(metrics.runwayQuarters)}
          tone={metrics !== null && metrics.runwayQuarters < 6 ? 'loss' : undefined}
          hint={metrics === null ? 'Computed when the first quarter resolves' : `Burn ${formatMoney(Math.abs(company.financials.quarterlyBurn))} a quarter`}
          href="/capital"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Charter" subtitle={ARCHETYPE_BLURB[company.archetype]}>
          <KeyValueGrid
            columns={1}
            items={[
              { label: 'Archetype', value: ARCHETYPE_LABEL[company.archetype], mono: false },
              { label: 'Sector', value: company.sectorId.replace(/_/g, ' '), mono: false },
              { label: 'Posture', value: POSTURE_LABEL[company.posture], mono: false, hint: POSTURE_BLURB[company.posture] },
              { label: 'Risk tolerance', value: formatPct(company.riskTolerance, 0), hint: 'Variance this company will accept for upside' },
              { label: 'Founded', value: quarterLabel(session.startYear, company.foundedQuarter) },
              { label: 'Headquarters', value: company.headquartersCity, mono: false },
              {
                label: 'Listing',
                value: company.isPublic ? `Public — ${company.ticker ?? 'unticked'}` : 'Private',
                mono: false,
                hint: company.isPublic ? 'Quarterly disclosure, priced every quarter' : 'No quote; valued from the fundamental anchor',
              },
              {
                label: 'Government record',
                value: formatScore(company.governmentPastPerformance),
                hint: 'Formal procurement past-performance score',
              },
            ]}
          />
        </Panel>

        <Panel title="Reputation" subtitle="Five audiences, five separate reputations">
          <div className="space-y-3">
            {REPUTATION_AUDIENCES.map((audience) => (
              <div key={audience.key}>
                <Meter value={company.reputation[audience.key]} label={audience.label} />
                <p className="mt-1 text-[10px] text-ink-faint">{audience.blurb}</p>
              </div>
            ))}
          </div>
        </Panel>

        <ComputePosition session={session} company={company} projects={view.ownResearchProjects} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Organisation"
          subtitle={`${headcount} people across ${STAFF_ROLES.length} functions`}
          className="lg:col-span-2"
          flush
        >
          <DataTable
            columns={columns}
            rows={roleRows}
            rowKey={(row) => row.role}
            onRowClick={(row) => setOpenRole(row.role)}
            initialSort={{ key: 'headcount', direction: 'desc' }}
            dense
          />
        </Panel>

        <Panel title="Culture" subtitle="What the org feels, and what it costs">
          <div className="space-y-3">
            <Meter value={employees.morale} label="Morale" benchmark={70} benchmarkLabel="Healthy band" />
            <ProgressBar
              label="Attrition against a 15% ceiling"
              value={employees.attrition}
              max={0.15}
              tone={employees.attrition > 0.06 ? 'loss' : employees.attrition > 0.035 ? 'warn' : 'gain'}
              valueLabel={formatPct(employees.attrition)}
            />
            <ProgressBar
              label="Site capacity used"
              value={Math.min(headcount, capacity)}
              max={Math.max(capacity, headcount, 1)}
              tone={headcount > capacity ? 'warn' : 'brand'}
              valueLabel={`${headcount} / ${capacity}`}
            />
          </div>
          <div className="mt-4">
            <SectionHeading rule>Leadership</SectionHeading>
            <div className="mt-2 space-y-1.5">
              {executives.length === 0 ? (
                <EmptyState compact title="No named executives" message="Nobody in this session holds a post here yet." />
              ) : (
                executives.map((character) => (
                  <PersonChip
                    key={character.id}
                    character={character}
                    subtitle={character.title}
                    right={
                      character.id === company.ceoCharacterId ? (
                        <Tag tone="brand" size="sm">
                          CEO
                        </Tag>
                      ) : undefined
                    }
                  />
                ))
              )}
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Offices" subtitle={`${company.offices.length} site${company.offices.length === 1 ? '' : 's'} · ${formatMoney(siteCost)} a quarter`}>
          {company.offices.length === 0 ? (
            <EmptyState title="No sites" message="This company has no physical office. Headcount growth is uncapped and fixed cost is zero." />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {company.offices.map((office) => {
                const share = office.headcountCapacity === 0 ? 0 : Math.min(1, headcount / office.headcountCapacity);
                return (
                  <div key={office.id} className="raised-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{office.city}</div>
                        <div className="text-[10px] text-ink-faint">Opened {quarterLabel(session.startYear, office.openedQuarter)}</div>
                      </div>
                      {office.isHeadquarters ? <Tag tone="brand">HQ</Tag> : null}
                    </div>
                    <div className="mt-2.5">
                      <ProgressBar
                        label="Capacity"
                        value={share}
                        tone={share > 0.9 ? 'warn' : 'brand'}
                        valueLabel={`${office.headcountCapacity} seats`}
                      />
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="label-caps-faint">Quarterly cost</span>
                      <span className="figure text-[12px] text-ink">{formatMoney(office.quarterlyCostUsd)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Technical capability" subtitle="Strength by area, 0 absent to 1 world leading">
          {capabilities.length === 0 ? (
            <EmptyState title="No capability recorded" message="Capability accrues from delivered research and hired specialists." />
          ) : (
            <BarChart data={capabilities} max={1} formatValue={(value) => value.toFixed(2)} />
          )}
        </Panel>
      </div>

      <Panel title="Group structure" subtitle="Subsidiaries and parents, as the public register shows them">
        {parent === null && subsidiaries.length === 0 ? (
          <EmptyState
            title="No group companies"
            message="Nothing has been acquired and this company is nobody's subsidiary. An acquisition that clears the board appears here as a subsidiary the quarter it completes."
            action={
              <Link className="btn btn-sm" href="/deal-room">
                Open the Deal Room
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            {parent === null ? null : (
              <div>
                <SectionHeading rule>Parent</SectionHeading>
                <div className="mt-2">
                  <CompanyChip company={parent} subtitle="Holds this company as a subsidiary" />
                </div>
              </div>
            )}
            {subsidiaries.length === 0 ? null : (
              <div>
                <SectionHeading rule>Subsidiaries</SectionHeading>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {subsidiaries.map((subsidiary) => (
                    <CompanyChip
                      key={subsidiary.id ?? subsidiary.name}
                      company={subsidiary}
                      right={subsidiary.isPublic === true ? <Tag tone="info">listed</Tag> : <Tag>private</Tag>}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Drawer
        open={drawerRole !== null}
        onClose={() => setOpenRole(null)}
        title={drawerRole === null ? '' : ROLE_LABEL[drawerRole.role]}
        subtitle={drawerRole === null ? undefined : ROLE_BLURB[drawerRole.role]}
        footer={
          <Link className="btn btn-primary btn-sm" href="/people">
            Open the headcount plan
          </Link>
        }
      >
        {drawerRole === null ? null : (
          <KeyValueGrid
            columns={1}
            items={[
              { label: 'Headcount', value: drawerRole.headcount },
              { label: 'Share of company', value: formatPct(drawerRole.share, 0) },
              { label: 'Market compensation', value: formatMoney(drawerRole.marketCompUsd), hint: 'Annual, at the current salary pressure' },
              {
                label: 'Company average',
                value: formatMoney(employees.avgComp),
                tone: employees.avgComp < drawerRole.marketCompUsd ? 'warn' : 'gain',
                hint: employees.avgComp < drawerRole.marketCompUsd ? 'Below the market rate for this role' : 'At or above the market rate',
              },
              {
                label: 'Expected departures',
                value: Math.round(drawerRole.headcount * employees.attrition),
                hint: `At the current attrition of ${formatPct(employees.attrition)}`,
              },
              { label: 'Open roles company-wide', value: employees.openRoles },
            ]}
          />
        )}
      </Drawer>
    </>
  );
}

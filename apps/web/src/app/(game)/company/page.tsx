'use client';

/**
 * Company — the operating overview, anchored on the office itself.
 *
 * The screen opens on the place rather than the table: a flat isometric-lite
 * floor plan whose rooms are the real headcount by function, whose server room
 * is the real accelerator fleet, and whose people wear the company's real
 * morale. Every room is a control — engineering opens the headcount plan,
 * research opens the frontier, sales opens the product book, the racks open the
 * compute drawer, an executive's desk opens their card.
 *
 * Underneath it, unchanged in substance, sits the drill-down layer: charter,
 * reputation, compute position, organisation, culture, sites, capability and
 * group structure. Nothing on this screen is a lever; every lever it points at
 * lives on Products, People, Research or Capital.
 *
 * Information boundary: everything above the group-structure panel is the
 * player's own company, read from `SessionState`. The one place rivals appear —
 * group structure — reads `usePlayerView().visibleCompanies`, so an acquired
 * subsidiary shows its identity and nothing operational.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { SimEvent, StaffRole } from '@frontier/contracts';
import {
  REGION_META,
  SECTOR_META,
  STAFF_ROLES,
  costStackFor,
  exposureFor,
  priceStackFor,
  quarterLabel,
} from '@frontier/contracts';
import { SOLVENCY_NEGATIVE_QUARTERS, negativeCashQuarters, requiredCompUsd } from '@frontier/simulation';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import {
  BarChart,
  CompanyChip,
  DataTable,
  Drawer,
  EmptyState,
  Icon,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  PersonChip,
  ProgressBar,
  RegionBadge,
  SectionHeading,
  SectorBadge,
  StatCard,
  Tag,
  regionOf,
  sectorOf,
  sectorsPresent,
  type Column,
} from '@/components/ui';
import { OfficeScene, type OfficeDrawerId } from '@/components/scenes/office';
import { LedgerDrawer } from '@/components/screens/reporting/LedgerDrawer';
import { ExposureCard } from '@/components/screens/company/ExposureCard';
import { ModifierStackCard } from '@/components/screens/company/ModifierStackCard';
import { ComputeDrawer } from '@/components/screens/company/ComputeDrawer';
import { ComputePosition } from '@/components/screens/company/ComputePosition';
import { ExecutiveDrawer } from '@/components/screens/company/ExecutiveDrawer';
import { SectorPanel } from '@/components/screens/company/SectorPanel';
import { SitesDrawer } from '@/components/screens/company/SitesDrawer';
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
import { useCompanyMetrics, useGame, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

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

  const { lastOutcome } = useGame();

  const [openRole, setOpenRole] = useState<StaffRole | null>(null);
  const [openDrawer, setOpenDrawer] = useState<OfficeDrawerId | null>(null);
  const [openExecutive, setOpenExecutive] = useState<string | null>(null);
  const [cause, setCause] = useState<string | null>(null);

  /* --- the priced economy (V1, V8) ---------------------------------------
     Committed rows or nothing: a single-sector session writes no economy
     report, so these render exactly as they did before the priced chain
     existed — which is to say, not at all. */
  const report = view.economyReport;
  const multiSector = useMemo(
    () => sectorsPresent([company, ...view.visibleCompanies]).length > 1,
    [company, view.visibleCompanies],
  );
  const priceStack = priceStackFor(report, company.id);
  const costStack = costStackFor(report, company.id);
  const exposure = exposureFor(report, company.id);

  const causeEvents = useMemo<readonly SimEvent[]>(() => {
    if (lastOutcome === null || cause === null) return [];
    return lastOutcome.events.filter((event) => event.eventId === cause);
  }, [lastOutcome, cause]);

  const employees = company.employees;
  const headcount = STAFF_ROLES.reduce((total, role) => total + employees[role], 0);
  // Read off the filed statements, not stored: consecutive closed quarters below
  // zero. Two of them and the company is wound up.
  const negativeQuarters = negativeCashQuarters(company);

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

  const executive = useMemo(
    () => (openExecutive === null ? null : (executives.find((character) => character.id === openExecutive) ?? null)),
    [executives, openExecutive],
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
      render: (row) => formatPct(row.share),
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
      cardLabel: 'Leaving next quarter',
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
            <SectorBadge sector={sectorOf(company)} size="md" />
            <RegionBadge region={regionOf(company)} size="md" />
            <Tag tone="brand">{POSTURE_LABEL[company.posture]}</Tag>
            <Tag tone="neutral">{company.tier} tier</Tag>
          </>
        }
      />

      {/* --- the office ------------------------------------------------------
          The scene is the screen's anchor: one floor, seven rooms, all of it
          read from committed state. It contains its own width — on a phone the
          frame pans sideways and the page body does not move. */}
      <Panel
        title="Headquarters"
        iconName="building"
        iconTone="brand"
        subtitle="Every room is drawn from committed state, and every room opens the screen that operates it."
        actions={
          <>
            {/* The office is one company's floor, so the sector mark belongs on
                its header rather than on every room inside it. */}
            <SectorBadge sector={sectorOf(company)} />
            <RegionBadge region={regionOf(company)} />
            <Tag tone="neutral">
              {headcount} people · morale {formatScore(employees.morale)}
            </Tag>
          </>
        }
        flush
      >
        <OfficeScene onOpenDrawer={setOpenDrawer} onOpenCharacter={setOpenExecutive} className="rounded-t-none" />
      </Panel>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Headcount" iconName="people" value={headcount} unit="FTE" hint={`${employees.openRoles} roles open`} href="/people" />
        <StatCard
          label="Morale"
          iconName="gauge"
          value={formatScore(employees.morale)}
          tone={employees.morale >= 70 ? 'gain' : employees.morale >= 45 ? undefined : 'warn'}
          hint={`Attrition ${formatPct(employees.attrition)} per quarter`}
          href="/people"
        />
        <StatCard
          label="Payroll"
          iconName="coins"
          value={formatMoney(company.financials.payroll)}
          hint={`Average comp ${formatMoney(employees.avgComp)}`}
          href="/financials"
        />
        <StatCard
          label="Solvency"
          iconName="warning"
          value={`${negativeQuarters} of ${SOLVENCY_NEGATIVE_QUARTERS}`}
          tone={negativeQuarters >= SOLVENCY_NEGATIVE_QUARTERS ? 'loss' : negativeQuarters > 0 ? 'warn' : undefined}
          hint={`Cash ${formatMoney(company.financials.cash)} · quarters below zero, out of ${SOLVENCY_NEGATIVE_QUARTERS}`}
          href="/financials"
        />
        <StatCard
          label="Runway"
          iconName="vault"
          value={metrics === null ? '—' : formatQuarterCount(metrics.runwayQuarters)}
          tone={metrics !== null && metrics.runwayQuarters < 6 ? 'loss' : undefined}
          hint={metrics === null ? 'Computed when the first quarter resolves' : `Burn ${formatMoney(Math.abs(company.financials.quarterlyBurn))} a quarter`}
          href="/capital"
        />
      </div>

      {/* --- the drill-down layer -------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Charter" iconName="stamp" subtitle={ARCHETYPE_BLURB[company.archetype]}>
          <KeyValueGrid
            columns={1}
            items={[
              { label: 'Archetype', value: ARCHETYPE_LABEL[company.archetype], mono: false },
              // Two different things called "sector": what the company does,
              // and the bucket the market prices it in. Both are shown, named.
              { label: 'Sector', value: SECTOR_META[sectorOf(company)].label, mono: false, hint: 'What this company does' },
              { label: 'Market bucket', value: company.sectorId.replace(/_/g, ' '), mono: false, hint: 'How the exchange groups it for beta and multiples' },
              { label: 'Region', value: REGION_META[regionOf(company)].label, mono: false, hint: REGION_META[regionOf(company)].tagline },
              { label: 'Posture', value: POSTURE_LABEL[company.posture], mono: false, hint: POSTURE_BLURB[company.posture] },
              { label: 'Risk tolerance', value: formatPct(company.riskTolerance), hint: 'Variance this company will accept for upside' },
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

        <Panel title="Reputation" iconName="people" iconTone="info" subtitle="Five audiences, five separate reputations">
          <div className="flex flex-col gap-3.5">
            {REPUTATION_AUDIENCES.map((audience) => (
              <div key={audience.key}>
                <Meter value={company.reputation[audience.key]} label={audience.label} />
                <p className="mt-1 text-[11px] text-ink-faint">{audience.blurb}</p>
              </div>
            ))}
          </div>
        </Panel>

        <ComputePosition session={session} company={company} projects={view.ownResearchProjects} />
      </div>

      {/* --- V1: the itemised stacks, V8: the brake --------------------------
          "If the engine multiplied it, the screen names it and signs it, and
          tapping the row shows the event that caused it." Every row below is a
          committed `ModifierRow`; the card adds nothing up. */}
      {multiSector ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            iconName="coins"
            iconTone="gain"
            title="What you were paid"
            subtitle="Gross revenue, and every modifier the chain put on it."
          >
            <ModifierStackCard
              stack={priceStack}
              baseLabel="Product and contract revenue"
              totalLabel="Recognised"
              onOpenCause={setCause}
              emptyMessage="The price stack is written when a quarter resolves. Nothing has repriced your revenue yet."
            />
          </Panel>

          <Panel
            iconName="ledger"
            iconTone="loss"
            title="What it cost to serve"
            subtitle="Cash cost of goods at a neutral energy basis, and every modifier on top of it."
          >
            <ModifierStackCard
              stack={costStack}
              baseLabel="Cost of serving"
              totalLabel="Cash cost of goods"
              onOpenCause={setCause}
              emptyMessage="The cost stack is written when a quarter resolves. Nothing upstream has moved your input costs yet."
            />
          </Panel>

          <ExposureCard exposure={exposure} />
        </div>
      ) : null}

      <SectorPanel company={company} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Organisation"
          iconName="desk"
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
            cardMode="auto"
            cardTitleKey="role"
            dense
          />
        </Panel>

        <Panel title="Culture" iconName="people" subtitle="What the org feels, and what it costs">
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
                    className="tap-target"
                    subtitle={character.title}
                    onClick={() => setOpenExecutive(character.id)}
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
        <Panel
          title="Offices"
          iconName="building"
          subtitle={`${company.offices.length} site${company.offices.length === 1 ? '' : 's'} · ${formatMoney(siteCost)} a quarter`}
          actions={
            <button type="button" className="btn btn-ghost tap-target gap-1.5 px-2" onClick={() => setOpenDrawer('sites')}>
              <Icon name="building" size={15} accent="current" />
              Open sites
            </button>
          }
        >
          {company.offices.length === 0 ? (
            <EmptyState icon="building" title="No sites" message="This company has no physical office. Headcount growth is uncapped and fixed cost is zero." />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {company.offices.map((office) => {
                const share = office.headcountCapacity === 0 ? 0 : Math.min(1, headcount / office.headcountCapacity);
                return (
                  <div key={office.id} className="raised-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{office.city}</div>
                        <div className="text-[11px] text-ink-faint">Opened {quarterLabel(session.startYear, office.openedQuarter)}</div>
                      </div>
                      {office.isHeadquarters ? (
                        <Tag tone="brand" className="gap-1">
                          <Icon name="building" size={11} accent="current" />
                          Head office
                        </Tag>
                      ) : null}
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

        <Panel title="Technical capability" iconName="flask" subtitle="Strength by area, 0 absent to 1 world leading">
          {capabilities.length === 0 ? (
            <EmptyState icon="flask" title="No capability recorded" message="Capability accrues from delivered research and hired specialists." />
          ) : (
            <BarChart data={capabilities} max={1} formatValue={formatPct} />
          )}
        </Panel>
      </div>

      <Panel
        title="Group structure"
        iconName="network"
        subtitle="Subsidiaries and parents, as the public register shows them"
        actions={
          <Link href="/portfolio" className="btn btn-ghost btn-sm tap-target gap-1.5 sm:min-h-0">
            <Icon name="portfolio" size={13} accent="current" />
            What they cost
          </Link>
        }
      >
        {parent === null && subsidiaries.length === 0 ? (
          <EmptyState
            icon="handshake"
            title="No group companies"
            message="Nothing has been acquired and this company is nobody's subsidiary. An acquisition that clears the board appears here as a subsidiary the quarter it completes."
            action={
              <Link className="btn tap-target gap-1.5" href="/deal-room">
                <Icon name="handshake" size={16} accent="current" />
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
                      badges="both"
                      right={subsidiary.isPublic === true ? <Tag tone="info">listed</Tag> : <Tag>private</Tag>}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* --- drill-downs the scene opens -------------------------------------- */}
      <ComputeDrawer
        open={openDrawer === 'compute'}
        onClose={() => setOpenDrawer(null)}
        session={session}
        company={company}
        projects={view.ownResearchProjects}
      />

      <SitesDrawer open={openDrawer === 'sites'} onClose={() => setOpenDrawer(null)} session={session} company={company} />

      <ExecutiveDrawer
        open={executive !== null}
        onClose={() => setOpenExecutive(null)}
        character={executive}
        isCeo={executive !== null && executive.id === company.ceoCharacterId}
      />

      <Drawer
        open={drawerRole !== null}
        onClose={() => setOpenRole(null)}
        title={drawerRole === null ? '' : ROLE_LABEL[drawerRole.role]}
        subtitle={drawerRole === null ? undefined : ROLE_BLURB[drawerRole.role]}
        footer={
          <Link className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" href="/people">
            <Icon name="people" size={16} accent="current" />
            Open the headcount plan
          </Link>
        }
      >
        {drawerRole === null ? null : (
          <KeyValueGrid
            columns={1}
            items={[
              { label: 'Headcount', value: drawerRole.headcount },
              { label: 'Share of company', value: formatPct(drawerRole.share) },
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

      <LedgerDrawer
        open={cause !== null}
        onClose={() => setCause(null)}
        title="Why this modifier"
        subtitle={
          lastOutcome === null
            ? 'No quarter has resolved in this tab yet.'
            : `${quarterLabel(session.startYear, lastOutcome.report.quarter)} · ${causeEvents.length} committed row${causeEvents.length === 1 ? '' : 's'}`
        }
        events={causeEvents}
        emptyMessage="The row that caused this modifier was committed in an earlier quarter than the one held in this tab."
      />
    </>
  );
}

'use client';

/**
 * Government — opportunities, bids, contracts and the record they build.
 *
 * The design claim this screen serves: **winning is not automatically good.** An
 * award brings backlog, credibility and stable demand, and with it compliance
 * cost, capacity lock-in, export restrictions, employee unease and cost-overrun
 * risk. So the contractor record sits permanently in the header — it is an input
 * to every future bid — and every opportunity states its weights and its gates
 * before the composer opens.
 *
 * Connections change which opportunities a company sees and what it knows about
 * them. They never touch scoring: there is no relationship term in the model and
 * no hidden bribery statistic anywhere in the engine.
 */

import { useMemo, useState } from 'react';
import type { ContractMilestone, GovernmentContract, ProcurementOpportunity } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatScore } from '@frontier/shared';
import { checkAccess } from '@frontier/simulation';
import {
  AccessBadge,
  DataTable,
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
import { BidBuilder } from '@/components/screens/government/BidBuilder';
import { OpportunityCard } from '@/components/screens/government/OpportunityCard';
import { usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

const MILESTONE_TONE: Readonly<Record<ContractMilestone['status'], 'neutral' | 'gain' | 'warn' | 'loss' | 'info'>> = {
  pending: 'neutral',
  in_progress: 'info',
  delivered: 'gain',
  late: 'warn',
  failed: 'loss',
  waived: 'neutral',
};

export default function GovernmentPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const [composing, setComposing] = useState<ProcurementOpportunity | null>(null);

  const agencyName = useMemo(() => new Map(session.agencies.map((agency) => [agency.id, agency.shortName])), [session.agencies]);

  const openOpportunities = useMemo(
    () => view.opportunities.filter((opportunity) => opportunity.status === 'open' && opportunity.closeQuarter >= session.quarter),
    [view.opportunities, session.quarter],
  );

  const ownBids = useMemo(
    () => session.governmentBids.filter((bid) => bid.bidderCompanyId === company.id),
    [session.governmentBids, company.id],
  );

  const contracts = view.contracts;
  const aggregate = session.contractorReputations.find((row) => row.companyId === company.id && row.agencyId === null) ?? null;
  const byAgency = session.contractorReputations.filter((row) => row.companyId === company.id && row.agencyId !== null);

  const backlog = contracts.reduce((total, contract) => total + Math.max(0, contract.totalValueUsd - contract.recognisedToDateUsd), 0);
  const penalties = contracts.reduce((total, contract) => total + contract.penaltiesUsd, 0);
  const compliance = contracts.reduce((total, contract) => total + contract.complianceBurdenQuarterlyUsd, 0);

  const contractColumns: readonly Column<GovernmentContract>[] = [
    {
      key: 'programme',
      header: 'Contract',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-ink">{row.opportunityId}</div>
          <div className="text-[10px] text-ink-faint">
            {agencyName.get(row.agencyId) ?? row.agencyId} · awarded {quarterLabel(session.startYear, row.awardedQuarter)}
          </div>
        </div>
      ),
      sortable: true,
      sortValue: (row) => row.opportunityId,
    },
    {
      key: 'value',
      header: 'Ceiling',
      align: 'right',
      render: (row) => formatMoney(row.totalValueUsd),
      sortable: true,
      sortValue: (row) => row.totalValueUsd,
    },
    {
      key: 'recognised',
      header: 'Recognised',
      align: 'right',
      render: (row) => formatMoney(row.recognisedToDateUsd),
      sortable: true,
      sortValue: (row) => row.recognisedToDateUsd,
    },
    {
      key: 'performance',
      header: 'Performance',
      width: '18%',
      render: (row) => <Meter value={row.performanceToDate} showValue />,
      sortable: true,
      sortValue: (row) => row.performanceToDate,
    },
    {
      key: 'penalties',
      header: 'Penalties',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatMoney(row.penaltiesUsd),
      sortable: true,
      sortValue: (row) => row.penaltiesUsd,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (row) => (
        <Tag tone={row.status === 'active' ? 'info' : row.status === 'completed' ? 'gain' : 'loss'}>{row.status}</Tag>
      ),
      sortable: true,
      sortValue: (row) => row.status,
    },
  ];

  return (
    <>
      <PageHeader
        title="Government"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · procurement`}
        subtitle="Opportunity weights, hard gates, and what an award actually costs. Connections change what you see; they never change what scores."
        actions={
          <Tag tone={company.governmentPastPerformance >= 55 ? 'gain' : company.governmentPastPerformance >= 40 ? 'warn' : 'loss'} dot>
            Past performance {formatScore(company.governmentPastPerformance)}
          </Tag>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Past performance"
          value={formatScore(company.governmentPastPerformance)}
          tone={company.governmentPastPerformance >= 55 ? 'gain' : 'warn'}
          hint="An evaluation input on every future bid"
        />
        <StatCard label="Open competitions" value={openOpportunities.length} hint={`${ownBids.length} bid${ownBids.length === 1 ? '' : 's'} on file`} />
        <StatCard label="Contracted backlog" value={formatMoney(backlog)} hint={`${contracts.length} live contract${contracts.length === 1 ? '' : 's'}`} href="/financials" />
        <StatCard
          label="Compliance burden"
          value={formatMoney(compliance)}
          unit="/ quarter"
          deltaInvert
          tone={compliance > 0 ? 'warn' : undefined}
          hint={penalties > 0 ? `${formatMoney(penalties)} of penalties incurred` : 'Audit, clearance, reporting, segregation'}
        />
      </div>

      <Panel title="Opportunities" subtitle="What is open, how it will be judged, and whether this company qualifies" bodyClassName="space-y-3.5">
        {openOpportunities.length === 0 ? (
          <EmptyState
            title="No open competition"
            message="Agencies open competitions from their quarterly budget and the world's procurement conditions. Nothing is biddable this quarter."
          />
        ) : (
          openOpportunities.map((opportunity) => (
            <OpportunityCard
              key={opportunity.id}
              session={session}
              company={company}
              view={view}
              opportunity={opportunity}
              agencyName={agencyName.get(opportunity.agencyId) ?? opportunity.agencyId}
              alreadyBid={ownBids.some((bid) => bid.opportunityId === opportunity.id && bid.status !== 'withdrawn')}
              onCompose={setComposing}
            />
          ))
        )}
      </Panel>

      {ownBids.length === 0 ? null : (
        <Panel title="Bids on file" subtitle="Submitted, and what the evaluators did with them" flush>
          <DataTable
            columns={[
              {
                key: 'programme',
                header: 'Programme',
                render: (row) => view.opportunities.find((opportunity) => opportunity.id === row.opportunityId)?.programme ?? row.opportunityId,
              },
              { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.price) },
              { key: 'submitted', header: 'Submitted', align: 'right', render: (row) => quarterLabel(session.startYear, row.submittedQuarter) },
              {
                key: 'status',
                header: 'Status',
                align: 'right',
                render: (row) => (
                  <Tag tone={row.status === 'won' ? 'gain' : row.status === 'lost' || row.status === 'disqualified' ? 'loss' : 'info'}>{row.status}</Tag>
                ),
              },
              {
                key: 'reason',
                header: 'Note',
                hideOnMobile: true,
                render: (row) => <span className="text-[11px] text-ink-faint">{row.disqualificationReason ?? '—'}</span>,
              },
            ]}
            rows={ownBids}
            rowKey={(row) => row.id}
            dense
          />
        </Panel>
      )}

      <Panel title="Active contracts" subtitle="Milestones, performance and the standing cost of delivery" flush>
        <DataTable
          columns={contractColumns}
          rows={contracts}
          rowKey={(row) => row.id}
          dense
          empty={
            <div className="p-4">
              <EmptyState
                title="No contract in flight"
                message="An award creates backlog, not revenue: revenue is recognised milestone by milestone, and each milestone moves the past-performance score in one direction or the other."
              />
            </div>
          }
        />
      </Panel>

      {contracts.length === 0 ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          {contracts.map((contract) => (
            <Panel key={contract.id} title={contract.opportunityId} subtitle={`${agencyName.get(contract.agencyId) ?? contract.agencyId} · ${contract.contractForm.replace(/_/g, ' ')}`}>
              <ProgressBar
                label="Recognised against ceiling"
                value={contract.recognisedToDateUsd}
                max={Math.max(1, contract.totalValueUsd)}
                tone="brand"
                valueLabel={`${formatMoney(contract.recognisedToDateUsd)} / ${formatMoney(contract.totalValueUsd)}`}
              />

              <div className="mt-3">
                <SectionHeading rule>Milestones</SectionHeading>
                <div className="mt-2 space-y-1.5">
                  {contract.milestones.length === 0 ? (
                    <p className="text-[11px] text-ink-faint">No milestones are recorded on this contract.</p>
                  ) : (
                    contract.milestones.map((milestone) => (
                      <div key={milestone.id} className="raised-surface flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] text-ink">{milestone.label}</div>
                          <div className="text-[10px] text-ink-faint">
                            due {quarterLabel(session.startYear, milestone.dueQuarter)} · {milestone.computeRequiredUnits} units required
                          </div>
                        </div>
                        <span className="figure text-[11px] text-ink-dim">{formatMoney(milestone.valueUsd)}</span>
                        <Tag tone={MILESTONE_TONE[milestone.status]} dot>
                          {milestone.status.replace(/_/g, ' ')}
                        </Tag>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="mt-3">
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Performance to date', value: formatScore(contract.performanceToDate) },
                    { label: 'Penalties', value: formatMoney(contract.penaltiesUsd), tone: contract.penaltiesUsd > 0 ? 'loss' : undefined },
                    { label: 'Compliance', value: `${formatMoney(contract.complianceBurdenQuarterlyUsd)} / quarter` },
                    { label: 'Controversy', value: formatPct(contract.publicControversyLevel, 0), tone: contract.publicControversyLevel > 0.5 ? 'warn' : undefined },
                    {
                      label: 'Export restricted',
                      value: contract.exportRestricted ? 'Yes — limits foreign sale' : 'No',
                      mono: false,
                      tone: contract.exportRestricted ? 'warn' : undefined,
                      wide: true,
                    },
                  ]}
                />
              </div>
            </Panel>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Contractor record" subtitle="Slow to build, quick to damage">
          {aggregate === null ? (
            <>
              <Meter value={company.governmentPastPerformance} label="Government-wide past performance" />
              <p className="mt-2 text-[11px] text-ink-faint">
                No procurement record has been opened for this company yet. The first bid creates one, and the first delivered milestone starts moving
                it. Until then the score on file is the company&apos;s own starting figure.
              </p>
            </>
          ) : (
            <>
              <Meter value={aggregate.pastPerformanceScore} label="Government-wide past performance" />
              <div className="mt-3">
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'On-time delivery', value: formatPct(aggregate.onTimeDeliveryPct) },
                    { label: 'Cost overrun', value: formatPct(aggregate.costOverrunPct), tone: aggregate.costOverrunPct > 0 ? 'warn' : 'gain' },
                    { label: 'Contracts won', value: aggregate.contractsWon.toString() },
                    { label: 'Competitions lost', value: aggregate.contractsLost.toString() },
                    { label: 'Security incidents', value: aggregate.securityIncidents.toString(), tone: aggregate.securityIncidents > 0 ? 'loss' : undefined },
                    {
                      label: 'Terminations for default',
                      value: aggregate.terminationsForDefault.toString(),
                      tone: aggregate.terminationsForDefault > 0 ? 'loss' : undefined,
                      hint: 'Close to disqualifying for the largest programmes',
                    },
                  ]}
                />
              </div>
            </>
          )}

          {byAgency.length === 0 ? null : (
            <div className="mt-3 border-t border-hair pt-3">
              <SectionHeading>By agency</SectionHeading>
              <div className="mt-2 space-y-2.5">
                {byAgency.map((row) => (
                  <Meter key={row.agencyId ?? 'aggregate'} value={row.pastPerformanceScore} label={agencyName.get(row.agencyId ?? '') ?? row.agencyId ?? ''} />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Agencies" subtitle="What each buyer is for, and who you can reach">
          <div className="space-y-3">
            {session.agencies.map((agency) => {
              const contacts = agency.contactCharacterIds
                .map((id) => session.characters.find((character) => character.id === id) ?? null)
                .filter((character): character is NonNullable<typeof character> => character !== null);
              return (
                <div key={agency.id} className="raised-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-ink">{agency.name}</div>
                      <div className="text-[10px] text-ink-faint">
                        {agency.shortName} · {agency.jurisdiction.replace(/_/g, ' ')}
                      </div>
                    </div>
                    {agency.clearanceAuthority ? <Tag tone="info">sponsors clearances</Tag> : null}
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-dim">{agency.mission}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {agency.priorities.map((priority) => (
                      <Tag key={priority}>{priority.replace(/_/g, ' ')}</Tag>
                    ))}
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="label-caps-faint">Quarterly budget</span>
                    <span className="figure text-[12px] text-ink">{formatMoney(agency.budgetQuarterlyUsd)}</span>
                  </div>
                  {contacts.length === 0 ? (
                    <p className="mt-2 text-[10px] text-ink-faint">No named official is reachable at this agency.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {contacts.map((contact) => {
                        const access = checkAccess(session, founder.id, contact.id);
                        return (
                          <PersonChip
                            key={contact.id}
                            character={contact}
                            size="sm"
                            subtitle={contact.title}
                            right={<AccessBadge state={access.allowed ? (access.overrideId === null ? 'open' : 'override') : 'blocked'} gap={Math.round(access.gap)} />}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <BidBuilder session={session} company={company} view={view} opportunity={composing} onClose={() => setComposing(null)} />
    </>
  );
}

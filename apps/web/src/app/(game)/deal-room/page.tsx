'use client';

/**
 * Deal Room — structured agreements, and the desk that buys companies.
 *
 * The distinction the whole subsystem exists for is the distinction this screen
 * leads with: **binding obligations are enforced every quarter; statements of
 * intent are recorded and never enforced.** Free text does not write state, so
 * there is no free-text term anywhere in the builder — eight typed obligation
 * kinds and nothing else.
 *
 * Rivals reach this screen only through the redacted projection. The distress
 * radar is therefore built from what a listed company actually discloses — its
 * posture, its filed cash and burn, and the analyst notes in the public record —
 * and says so on the panel, because a radar that quietly read private state
 * would be the most valuable cheat in the game.
 */

import { useMemo, useState } from 'react';
import type { Company, DealProposal } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatQuarterCount } from '@frontier/shared';
import {
  CompanyChip,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SectionHeading,
  StatCard,
  Tag,
  sectorOf,
  type Column,
} from '@/components/ui';
import { AcquisitionDesk, type AcquisitionTarget } from '@/components/screens/deal-room/AcquisitionDesk';
import { DealBuilder, type CounterpartyOption, type NamedOption } from '@/components/screens/deal-room/DealBuilder';
import { DealDrawer } from '@/components/screens/deal-room/DealDrawer';
import { marketCapOf, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

const STATUS_TONE: Readonly<Record<DealProposal['status'], 'neutral' | 'info' | 'gain' | 'loss' | 'warn'>> = {
  draft: 'neutral',
  proposed: 'info',
  accepted: 'gain',
  rejected: 'loss',
  expired: 'neutral',
  executed: 'gain',
};

interface DistressRow {
  readonly company: Partial<Company>;
  readonly marketCapUsd: number;
  /** Runway implied by filed cash and filed burn, or null when it files no burn. */
  readonly runwayQuarters: number | null;
  readonly signals: readonly string[];
}

export default function DealRoomPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();

  const [selected, setSelected] = useState<string | null>(null);
  const [radarPick, setRadarPick] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    map.set(company.id, company.name);
    for (const rival of view.visibleCompanies) {
      if (rival.id !== undefined) map.set(rival.id, rival.name ?? rival.id);
    }
    for (const character of session.characters) map.set(character.id, character.name);
    for (const player of session.players) map.set(player.playerId, player.displayName);
    return (id: string): string => map.get(id) ?? id;
  }, [company.id, company.name, view.visibleCompanies, session.characters, session.players]);

  /* --- deals --------------------------------------------------------------- */

  const deals = view.deals;
  const inbound = deals.filter((deal) => deal.counterpartyId === company.id && deal.status === 'proposed');
  const outbound = deals.filter((deal) => deal.proposerId === company.id && deal.status === 'proposed');
  const live = deals.filter((deal) => deal.status === 'accepted' && deal.binding);
  const lapsing = deals.filter((deal) => deal.status === 'proposed' && deal.expiresQuarter <= session.quarter);

  /* --- builder inputs ------------------------------------------------------ */

  const counterparties: readonly CounterpartyOption[] = useMemo(() => {
    const companyOptions: CounterpartyOption[] = view.visibleCompanies
      .filter((rival) => rival.id !== undefined && rival.isActive !== false)
      .map((rival) => ({ id: rival.id ?? '', label: rival.name ?? (rival.id ?? ''), kind: 'company' as const }));
    const characterOptions: CounterpartyOption[] = session.characters
      .filter((character) => character.isActive && character.companyId !== company.id)
      .map((character) => ({ id: character.id, label: `${character.name} — ${character.title}`, kind: 'character' as const }));
    return [...companyOptions, ...characterOptions];
  }, [view.visibleCompanies, session.characters, company.id]);

  const securities: readonly NamedOption[] = useMemo(() => {
    const listed = new Set(view.visibleCompanies.filter((rival) => rival.isPublic === true).map((rival) => rival.id));
    return session.securities
      .filter((security) => security.companyId === company.id || listed.has(security.companyId))
      .map((security) => ({ id: security.id, label: `${nameOf(security.companyId)}${security.symbol === null ? '' : ` (${security.symbol})`}` }));
  }, [session.securities, view.visibleCompanies, company.id, nameOf]);

  const opportunities: readonly NamedOption[] = useMemo(
    () => view.opportunities.filter((entry) => entry.status === 'open').map((entry) => ({ id: entry.id, label: entry.programme })),
    [view.opportunities],
  );

  const techNodes: readonly NamedOption[] = useMemo(
    () => view.techGraph.nodes.map((node) => ({ id: node.id, label: node.title })),
    [view.techGraph.nodes],
  );

  const products: readonly NamedOption[] = useMemo(
    () => company.products.map((product) => ({ id: product.id, label: product.name })),
    [company.products],
  );

  /* --- acquisition targets and the distress radar --------------------------- */

  const targets: readonly AcquisitionTarget[] = useMemo(
    () =>
      view.visibleCompanies
        .filter((rival) => rival.id !== undefined && rival.isActive !== false)
        .map((rival) => ({
          id: rival.id ?? '',
          name: rival.name ?? (rival.id ?? ''),
          marketCapUsd: marketCapOf(session, rival.id ?? ''),
          isPublic: rival.isPublic === true,
          sector: sectorOf(rival),
        })),
    [view.visibleCompanies, session],
  );

  const distress: readonly DistressRow[] = useMemo(() => {
    const rows: DistressRow[] = [];
    for (const rival of view.visibleCompanies) {
      if (rival.id === undefined) continue;
      const signals: string[] = [];

      if (rival.posture === 'survival') signals.push('Filed posture: survival — the company is preserving cash.');

      const financials = rival.financials ?? null;
      let runway: number | null = null;
      if (financials !== null && financials.quarterlyBurn < 0) {
        runway = financials.cash / Math.abs(financials.quarterlyBurn);
        if (runway < 8) signals.push(`Filed cash of ${formatMoney(financials.cash)} against ${formatMoney(Math.abs(financials.quarterlyBurn))} of quarterly burn.`);
      }

      for (const disclosure of view.disclosures) {
        if (disclosure.companyId !== rival.id) continue;
        if (disclosure.beliefTopic !== 'fundraise_needed') continue;
        signals.push(`Public record: ${disclosure.headline}`);
      }

      if (signals.length === 0) continue;
      rows.push({ company: rival, marketCapUsd: marketCapOf(session, rival.id), runwayQuarters: runway, signals });
    }
    return rows.sort((a, b) => (a.runwayQuarters ?? 99) - (b.runwayQuarters ?? 99));
  }, [view.visibleCompanies, view.disclosures, session]);

  /* --- table --------------------------------------------------------------- */

  const columns: readonly Column<DealProposal>[] = [
    {
      key: 'counterparty',
      header: 'Counterparty',
      width: '24%',
      render: (row) => {
        const otherId = row.proposerId === company.id ? row.counterpartyId : row.proposerId;
        return (
          <div className="min-w-0">
            <div className="truncate text-[12px] text-ink">{nameOf(otherId)}</div>
            <div className="text-[11px] text-ink-faint">{row.proposerId === company.id ? 'you proposed' : 'they proposed'}</div>
          </div>
        );
      },
      sortable: true,
      sortValue: (row) => nameOf(row.proposerId === company.id ? row.counterpartyId : row.proposerId),
    },
    {
      key: 'summary',
      header: 'Terms',
      cardLabel: 'What is on the table',
      render: (row) => <span className="text-[12.5px] leading-relaxed text-ink-dim sm:text-[11px]">{row.summary}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '112px',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          <Tag tone={STATUS_TONE[row.status]} dot>
            {row.status}
          </Tag>
          {row.binding ? null : <Tag tone="warn">intent</Tag>}
        </div>
      ),
      sortable: true,
      sortValue: (row) => row.status,
    },
    {
      key: 'confidentiality',
      header: 'Visibility',
      width: '88px',
      hideOnMobile: true,
      render: (row) => <span className="text-[11px] text-ink-dim">{row.confidentiality}</span>,
    },
    {
      key: 'expires',
      header: 'Lapses',
      align: 'right',
      width: '92px',
      render: (row) => quarterLabel(session.startYear, row.expiresQuarter),
      sortable: true,
      sortValue: (row) => row.expiresQuarter,
    },
  ];

  const selectedDeal = selected === null ? null : (deals.find((deal) => deal.id === selected) ?? null);

  return (
    <>
      <PageHeader
        title="Deal Room"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Eight obligation kinds, two sides, and a hard line between what is contracted and what was merely said."
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard iconName="bell" label="To answer" value={String(inbound.length)} tone={inbound.length > 0 ? 'warn' : undefined} hint="Offers made to you, unanswered" />
        <StatCard iconName="export" label="Outstanding" value={String(outbound.length)} hint="Your offers, out with counterparties" />
        <StatCard iconName="handshake" label="Live deals" value={String(live.length)} hint="Binding, re-checked every quarter" />
        <StatCard
          iconName="warning"
          label="Lapsing"
          value={String(lapsing.length)}
          tone={lapsing.length > 0 ? 'loss' : undefined}
          hint="An unanswered offer expires; silence is an answer"
        />
      </div>

      <Panel
        iconName="handshake"
        iconTone="brand"
        title="Deals"
        subtitle={`${deals.length} agreement${deals.length === 1 ? '' : 's'} you are party to`}
        flush
      >
        <DataTable
          columns={columns}
          rows={deals}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelected(row.id)}
          dense
          cardMode="auto"
          cardTitleKey="counterparty"
          initialSort={{ key: 'expires', direction: 'asc' }}
          empty={
            <div className="p-3.5">
              <EmptyState
                icon="handshake"
                title="No deals yet"
                message="Nothing has been proposed to you and you have proposed nothing. Build one below: a deal is a set of typed obligations, and only an accepted binding one enters the ledger."
              />
            </div>
          }
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          iconName="stamp"
          title="Build a deal"
          subtitle="What you contract is enforced. What you say is recorded and is not."
        >
          <DealBuilder
            counterparties={counterparties}
            securities={securities}
            opportunities={opportunities}
            techNodes={techNodes}
            products={products}
            quarter={session.quarter}
            startYear={session.startYear}
            availableCashUsd={company.financials.cash}
          />
        </Panel>

        {/* `min-w-0` is load-bearing: without it this column's min-content
            widens the single implicit track a phone collapses the grid into,
            and the whole page starts scrolling sideways. */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel iconName="briefcase" title="M&A desk" subtitle="An offer is an attempt; the board and the target both get a say">
            <AcquisitionDesk
              targets={targets}
              preselectedId={radarPick}
              availableCashUsd={company.financials.cash}
              hasBoard={company.boardId !== null}
            />
          </Panel>

          <Panel iconName="search" title="Distress radar" subtitle="Built only from what a listed company discloses">
            {distress.length === 0 ? (
              <EmptyState
                icon="search"
                title="Nobody is visibly in trouble"
                message="This radar reads filed posture, filed cash against filed burn, and the public analyst record. A private company discloses none of it."
                compact
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {distress.map((row) => (
                  <li key={row.company.id}>
                    <CompanyChip
                      company={row.company}
                      size="sm"
                      badges="sector"
                      subtitle={`${formatMoney(row.marketCapUsd)}${
                        row.runwayQuarters === null ? '' : ` · ${formatQuarterCount(row.runwayQuarters)} of runway`
                      }`}
                      right={
                        row.runwayQuarters !== null && row.runwayQuarters < 6 ? (
                          <Tag tone="loss">under six</Tag>
                        ) : (
                          <Tag tone="warn">watch</Tag>
                        )
                      }
                    />
                    <ul className="mt-1 flex flex-col gap-0.5 pl-1">
                      {row.signals.map((signal, index) => (
                        <li key={index} className="text-[12px] leading-relaxed text-ink-faint sm:text-[10px]">
                          {signal}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="btn btn-sm tap-target mt-2 w-full sm:w-auto sm:min-h-0"
                      onClick={() => setRadarPick(row.company.id ?? null)}
                    >
                      Take it to the M&amp;A desk
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <SectionHeading className="mt-3.5" rule>
              What this cannot see
            </SectionHeading>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint sm:text-[10px]">
              A private rival files nothing, so it never appears here however badly it is doing. Secret research, unannounced rounds and
              internal forecasts are absent by construction rather than hidden by the interface.
            </p>
          </Panel>
        </div>
      </div>

      <DealDrawer
        deal={selectedDeal}
        ownCompanyId={company.id}
        nameOf={nameOf}
        startYear={session.startYear}
        quarter={session.quarter}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

'use client';

/**
 * Sector — the whole economy on one screen, one tap from the rail.
 *
 * Railway Empire's "flow of goods" overlay, adapted to a phone: the chain with
 * its prices (V6), the market-share ladder per sector (V2), the regions with
 * their indices and freight tolls, and the one lever this screen owns — the
 * toll dial your group has earned.
 *
 * Everything on it is a rendering of rows the resolver committed onto
 * `PlayerView.economyReport`, already redacted to this seat. The screen holds
 * no arithmetic: `components/screens/sector/model.ts` maps committed figures
 * onto tones, labels, orderings and bar widths, and the tests beside it pin
 * that boundary.
 *
 * World version 1 ran one sector and priced nothing, so it gets a plain
 * statement of that fact rather than six empty tiles.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { SimEvent, Sector } from '@frontier/contracts';
import { SECTOR_META, quarterLabel } from '@frontier/contracts';
import { ultimateControllerId } from '@frontier/simulation';
import { formatMoney } from '@frontier/shared';
import {
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  SectorFilter,
  StatCard,
  TabBar,
  Tag,
  regionOf,
  sectorOf,
  sectorsPresent,
} from '@/components/ui';
import { LedgerDrawer } from '@/components/screens/reporting/LedgerDrawer';
import { RegionStrip, SectorFlow, SectorLadder, TollTicket } from '@/components/screens/sector';
import { laddersPresent, sectorLadderRows, visibleAccordMembers } from '@/components/screens/sector/model';
import { useGame, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

type TabId = 'flow' | 'ladder' | 'regions';

export default function SectorPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const { lastOutcome } = useGame();

  const [tab, setTab] = useState<TabId>('flow');
  const [cause, setCause] = useState<string | null>(null);
  const [focus, setFocus] = useState<Sector | null>(null);

  const report = view.economyReport;
  const everyone = useMemo(() => [company, ...view.visibleCompanies], [company, view.visibleCompanies]);
  const multiSector = sectorsPresent(everyone).length > 1;

  /* --- the group ---------------------------------------------------------
     "Your group" is the ultimate controller the engine walks the parent chain
     to, so a subsidiary in another sector counts as an internal link exactly
     the way the cost side counts it. */
  const ownControllerId = useMemo(() => ultimateControllerId(session, company), [session, company]);
  const ownSectors = useMemo(() => {
    const sectors = new Set<Sector>([sectorOf(company)]);
    for (const rival of session.companies) {
      if (!rival.isActive) continue;
      if (ultimateControllerId(session, rival) === ownControllerId) sectors.add(sectorOf(rival));
    }
    return sectors;
  }, [session, company, ownControllerId]);

  const controllerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of everyone) {
      if (entry.id !== undefined && entry.name !== undefined) names.set(entry.id, entry.name);
    }
    for (const character of session.characters) names.set(character.id, character.name);
    return names;
  }, [everyone, session.characters]);

  const ladderSectors = useMemo(() => laddersPresent(everyone), [everyone]);
  const shown = focus ?? sectorOf(company);

  const ladder = useMemo(() => {
    const row = report?.sectorPrices.find((entry) => entry.sector === shown) ?? null;
    return {
      supplyUsd: row?.supplyUsd ?? 0,
      rows: sectorLadderRows(everyone, shown, row?.supplyUsd ?? 0, company.id, visibleAccordMembers(view.deals, shown)),
    };
  }, [report, shown, everyone, company.id, view.deals]);

  const causeEvents = useMemo<readonly SimEvent[]>(() => {
    if (lastOutcome === null || cause === null) return [];
    return lastOutcome.events.filter((event) => event.eventId === cause);
  }, [lastOutcome, cause]);

  const ownRow = report?.sectorPrices.find((entry) => entry.sector === sectorOf(company)) ?? null;
  const ownToll = report?.regionTolls.find((entry) => entry.region === regionOf(company)) ?? null;

  if (!multiSector) {
    return (
      <>
        <PageHeader
          title="Sector"
          eyebrow={`${quarterLabel(session.startYear, session.quarter)} · Economy`}
          subtitle="The six-sector chain, its prices and the regional freight tolls."
        />
        <Panel iconName="globe" title="One sector in this world">
          <EmptyState
            icon="globe"
            title="This session runs a single sector"
            message="Sector goods prices, the freight toll, price accords and the shortage counter all belong to the multi-sector world. A session founded before it ran one industry and one price, and it replays exactly as it always did."
            action={
              <Link className="btn tap-target gap-1.5" href="/company">
                <Icon name="building" size={16} accent="current" />
                Back to the company
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Sector"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · Economy`}
        subtitle="Six sectors, one price each, and the freight that moves between them. Everything here was committed by the resolver in the world phase."
        actions={
          <>
            <Tag tone="neutral">{SECTOR_META[sectorOf(company)].label}</Tag>
            <Link href="/financials" className="btn btn-sm tap-target sm:min-h-0">
              What it cost you
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          iconName="globe"
          label="Your sector price"
          value={ownRow === null ? '—' : String(ownRow.priceIndex)}
          tone={ownRow === null ? undefined : ownRow.priceIndex >= 100 ? 'gain' : 'warn'}
          hint={ownRow === null ? 'Set when the first quarter resolves' : `Baseline 100 · was ${ownRow.priceIndexBefore}`}
        />
        <StatCard
          iconName="warning"
          label="Shortage"
          value={ownRow === null || ownRow.shortage === 0 ? 'None' : `${ownRow.shortage}%`}
          tone={ownRow !== null && ownRow.shortage > 0 ? 'loss' : undefined}
          hint={ownRow === null ? 'Deepens by ten, heals by five' : `Delivery gate ${ownRow.gatePct}%`}
        />
        <StatCard
          iconName="network"
          label="Freight toll here"
          value={ownToll === null || ownToll.tollPct === 0 ? 'None' : `${ownToll.tollPct}%`}
          tone={ownToll !== null && ownToll.tollPct > 0 ? (ownToll.dominantControllerId === ownControllerId ? 'gain' : 'loss') : undefined}
          hint={
            ownToll === null
              ? 'Nobody dominates the freight yet'
              : ownToll.dominantControllerId === ownControllerId
                ? 'Your group charges it; you ride free'
                : `Paid on your cash cost of goods`
          }
        />
        <StatCard
          iconName="chart"
          label="Sector supply"
          value={ownRow === null ? '—' : formatMoney(ownRow.supplyUsd)}
          hint={ownRow === null ? 'Annualised revenue of everyone here' : `Demand ${formatMoney(ownRow.demandUsd)}`}
        />
      </div>

      <TabBar
        className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
        variant="segmented"
        ariaLabel="Economy view"
        tabs={[
          { id: 'flow', label: 'Flow' },
          { id: 'ladder', label: 'Share' },
          { id: 'regions', label: 'Regions' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as TabId)}
      />

      {tab === 'flow' ? (
        <Panel
          iconName="globe"
          iconTone="brand"
          title="The chain"
          subtitle="Demand over supply, the imbalance is the price, and a shortage takes over where the price stops moving."
        >
          <SectorFlow report={report} ownSectors={ownSectors} onOpenCause={setCause} />
        </Panel>
      ) : null}

      {tab === 'ladder' ? (
        <Panel
          iconName="chart"
          iconTone="brand"
          title="Who holds this sector"
          subtitle="One bar per company against the sector's committed supply, with the fifty per cent line drawn on the axis."
          actions={
            <SectorFilter
              sectors={ladderSectors}
              value={focus}
              onChange={setFocus}
              totalLabel={SECTOR_META[sectorOf(company)].label}
            />
          }
        >
          <SectorLadder sector={shown} rows={ladder.rows} supplyUsd={ladder.supplyUsd} />
        </Panel>
      ) : null}

      {tab === 'regions' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel iconName="globe" title="Regions" subtitle="Three indices and the freight toll, per region.">
            <RegionStrip
              report={report}
              ownRegion={regionOf(company)}
              controllerNames={controllerNames}
              ownControllerId={ownControllerId}
            />
          </Panel>
          <Panel
            iconName="network"
            iconTone="warn"
            title="Your freight toll"
            subtitle="What your group charges everybody else in its own region. Your own companies never pay it."
          >
            <TollTicket session={session} company={company} />
          </Panel>
        </div>
      ) : null}

      <LedgerDrawer
        open={cause !== null}
        onClose={() => setCause(null)}
        title="Why this figure"
        subtitle={
          lastOutcome === null
            ? 'No quarter has resolved in this tab yet.'
            : `${quarterLabel(session.startYear, lastOutcome.report.quarter)} · ${causeEvents.length} committed row${causeEvents.length === 1 ? '' : 's'}`
        }
        events={causeEvents}
        emptyMessage="The row that caused this figure was committed in an earlier quarter than the one held in this tab."
      />
    </>
  );
}

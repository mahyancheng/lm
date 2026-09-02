'use client';

/**
 * Markets — the in-world exchange.
 *
 * The tape, what every name is trading against, why the last move happened,
 * what the market currently believes, what has been said on the record, and the
 * positions you hold. The reference tape appears only when the session enables
 * it, and is read-only by construction.
 */

import { useMemo, useState } from 'react';
import type { Sector } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatMultiple, formatPct } from '@frontier/shared';
import {
  DataTable,
  DeltaBadge,
  EmptyState,
  Icon,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  RegionBadge,
  SectorBadge,
  SectorFilter,
  Sparkline,
  StatCard,
  Tag,
  regionOf,
  sectorOf,
  sectorsPresent,
  type Column,
} from '@/components/ui';
import { useGame, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { InstrumentDrawer } from '@/components/screens/markets/InstrumentDrawer';
import { decompositionsFrom, type DecompositionView } from '@/components/screens/markets/decomposition';
import { ShortInterestCard, shortInterestBadge } from '@/components/screens/street';
import {
  registerRows,
  sectorCounts,
  sectorRollups,
  type RegisterRow,
} from '@/components/screens/reporting/register';
import {
  anchorInputRows,
  anchorOf,
  capTableRows,
  companyNameOf,
  disclosuresFor,
  formatCount,
  humanise,
  instrumentRows,
  issuedSharesOf,
  perSharePrice,
  type InstrumentRow,
} from '@/components/screens/reporting/util';

interface PositionRow {
  readonly key: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly holderLabel: string;
  readonly shares: number;
  readonly economicPct: number;
  readonly costBasisUsd: number;
  readonly valueUsd: number;
  readonly basis: 'quote' | 'anchor' | 'none';
  readonly thresholdLabel: string | null;
  readonly isDisclosed: boolean;
  readonly lockupUntilQuarter: number | null;
}

export default function MarketsPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const { lastOutcome } = useGame();
  const [openId, setOpenId] = useState<string | null>(null);
  const [tapeSector, setTapeSector] = useState<Sector | null>(null);
  const [registerSector, setRegisterSector] = useState<Sector | null>(null);

  const rows = useMemo(() => instrumentRows(session, view), [session, view]);
  const decompositions = useMemo<Map<string, DecompositionView>>(
    () => (lastOutcome === null ? new Map() : decompositionsFrom(lastOutcome.events)),
    [lastOutcome],
  );

  const selected: InstrumentRow | null = openId === null ? null : rows.find((row) => row.instrument.id === openId) ?? null;
  const selectedQuarters = useMemo(
    () =>
      openId === null
        ? []
        : session.quotes
            .filter((quote) => quote.instrumentId === openId)
            .sort((a, b) => a.quarter - b.quarter)
            .map((quote) => quote.quarter),
    [session.quotes, openId],
  );

  const indices = rows.filter((row) => row.instrument.kind === 'in_world_index');
  const equities = rows.filter((row) => row.instrument.kind === 'in_world_equity');
  // World 1 lists FCAI and FCSC; world 2 lists FCW and FCIN. Nothing on this
  // screen may name an index id, so both cards read off whatever the session
  // actually has and fall back to a world reading when it has only one.
  const primaryIndex = indices[0] ?? null;
  const secondaryIndex = indices[1] ?? null;
  const ownAnchor = anchorOf(session, company.id);

  /* --- the register: every company, listed or not -------------------------- */

  const register = useMemo(() => registerRows(session, view), [session, view]);
  const rollups = useMemo(() => sectorRollups(register), [register]);
  const counts = useMemo(() => sectorCounts(register), [register]);
  const presentSectors = useMemo(() => sectorsPresent(register), [register]);
  const multiSector = presentSectors.length > 1;

  const tapeRows = useMemo(
    () =>
      tapeSector === null
        ? rows
        : rows.filter((row) => row.company !== null && sectorOf(row.company) === tapeSector),
    [rows, tapeSector],
  );
  const registerFiltered = useMemo(
    () => (registerSector === null ? register : register.filter((row) => row.sector === registerSector)),
    [register, registerSector],
  );

  /**
   * How many instruments each sector has on the tape.
   *
   * The tape filter offers only the sectors that actually have a listed name,
   * so it can never be narrowed to an empty table: a sector whose companies are
   * all private is on the register below, not on the exchange.
   */
  const tapeCounts = useMemo(() => {
    const out: Partial<Record<Sector, number>> = {};
    for (const row of rows) {
      if (row.company === null) continue;
      const sector = sectorOf(row.company);
      out[sector] = (out[sector] ?? 0) + 1;
    }
    return out;
  }, [rows]);
  const tapeSectors = useMemo(() => presentSectors.filter((entry) => (tapeCounts[entry] ?? 0) > 0), [presentSectors, tapeCounts]);

  /* --- positions ---------------------------------------------------------- */

  const positions = useMemo<PositionRow[]>(() => {
    const mine = new Set([company.id, founder.id, view.playerId]);
    const out: PositionRow[] = [];
    for (const table of session.capTables) {
      const issued = issuedSharesOf(table);
      const price = perSharePrice(session, table.companyId);
      for (const row of capTableRows(session, table)) {
        if (!mine.has(row.holderId)) continue;
        out.push({
          key: row.holdingId,
          companyId: table.companyId,
          companyName: companyNameOf(view, table.companyId),
          holderLabel: row.label,
          shares: row.shares,
          economicPct: issued === 0 ? 0 : row.shares / issued,
          costBasisUsd: row.costBasisUsd,
          valueUsd: row.shares * price.value,
          basis: price.basis,
          thresholdLabel: row.threshold?.label ?? null,
          isDisclosed: row.isDisclosed,
          lockupUntilQuarter: row.lockupUntilQuarter,
        });
      }
    }
    return out.sort((a, b) => b.valueUsd - a.valueUsd);
  }, [session, view, company.id, founder.id]);

  /* --- the institutional side --------------------------------------------- */

  const shortRows = useMemo(() => view.economyReport?.shortInterest ?? [], [view.economyReport]);
  const anySqueeze = shortRows.some((short) => shortInterestBadge(short).risk === 'fired');
  const entityNameOf = useMemo(() => {
    const names = new Map((view.economyReport?.capitalEntities ?? []).map((entry) => [entry.entityId, entry.name] as const));
    return (entityId: string): string => names.get(entityId) ?? entityId;
  }, [view.economyReport]);

  /* --- tables ------------------------------------------------------------- */

  const tapeColumns: readonly Column<InstrumentRow>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      width: '92px',
      render: (row) => (
        <span
          className={`figure inline-flex h-5 min-w-11 items-center justify-center rounded-pill border px-1.5 text-[10px] font-semibold ${
            row.instrument.companyId === company.id
              ? 'border-brand/40 bg-brand-wash text-brand'
              : 'border-hair bg-raised text-ink-dim'
          }`}
        >
          {row.instrument.symbol}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.instrument.symbol,
    },
    {
      key: 'name',
      header: 'Instrument',
      render: (row) => (
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-ink sm:text-[12px]">{row.companyName}</span>
          {row.company === null ? (
            <span className="block truncate text-[10px] text-ink-faint">
              {humanise(row.instrument.kind)}
              {row.instrument.sectorId === null ? '' : ` · ${humanise(row.instrument.sectorId)}`}
            </span>
          ) : (
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              <SectorBadge sector={sectorOf(row.company)} />
              <RegionBadge region={regionOf(row.company)} />
            </span>
          )}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.companyName,
    },
    {
      key: 'sector',
      header: 'Sector',
      cardHidden: true,
      hideOnMobile: true,
      width: '112px',
      mono: false,
      render: (row) =>
        row.company === null ? <span className="text-[10px] text-ink-faint">Index</span> : <SectorBadge sector={sectorOf(row.company)} />,
      sortable: true,
      sortValue: (row) => (row.company === null ? 'zz_index' : sectorOf(row.company)),
    },
    {
      key: 'trend',
      header: 'Trend',
      cardLabel: 'Since listing',
      width: '84px',
      hideOnMobile: true,
      render: (row) =>
        row.history.length < 2 ? (
          <span className="text-[10px] text-ink-faint">—</span>
        ) : (
          <Sparkline values={row.history} width={64} height={20} ariaLabel={`${row.instrument.symbol} history`} />
        ),
    },
    {
      key: 'price',
      header: 'Close',
      align: 'right',
      render: (row) => (row.quote === null ? '—' : formatMoney(row.quote.price)),
      sortable: true,
      sortValue: (row) => row.quote?.price ?? 0,
    },
    {
      key: 'return',
      header: 'Quarter',
      cardLabel: 'This quarter',
      align: 'right',
      render: (row) => (row.quote === null ? '—' : <DeltaBadge value={row.quote.return} format="percent" bare />),
      sortable: true,
      sortValue: (row) => row.quote?.return ?? 0,
    },
    {
      key: 'cap',
      header: 'Market cap',
      align: 'right',
      hideOnMobile: true,
      cardHidden: true,
      render: (row) => (row.quote === null || row.quote.marketCapUsd === 0 ? '—' : formatMoney(row.quote.marketCapUsd)),
      sortable: true,
      sortValue: (row) => row.quote?.marketCapUsd ?? 0,
    },
    {
      key: 'revenue',
      header: 'Revenue',
      cardLabel: 'Trailing revenue',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (row.fundamentals === null ? '—' : formatMoney(row.fundamentals.revenueTtmUsd)),
      sortable: true,
      sortValue: (row) => row.fundamentals?.revenueTtmUsd ?? 0,
    },
    {
      key: 'growth',
      header: 'Growth',
      cardLabel: 'Revenue growth, year on year',
      align: 'right',
      hideOnMobile: true,
      render: (row) =>
        row.fundamentals === null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <DeltaBadge value={row.fundamentals.revenueGrowthYoY} format="percent" bare />
        ),
      sortable: true,
      sortValue: (row) => row.fundamentals?.revenueGrowthYoY ?? 0,
    },
    {
      key: 'margin',
      header: 'Margin',
      cardLabel: 'Gross margin',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (row.fundamentals === null ? '—' : formatPct(row.fundamentals.grossMarginPct)),
      sortable: true,
      sortValue: (row) => row.fundamentals?.grossMarginPct ?? 0,
    },
    {
      key: 'multiple',
      header: 'Multiple',
      cardLabel: 'Capitalisation over revenue',
      align: 'right',
      render: (row) => (row.revenueMultiple === null ? '—' : `${formatCount(row.revenueMultiple)}x`),
      sortable: true,
      sortValue: (row) => row.revenueMultiple ?? 0,
    },
    {
      key: 'anchor',
      header: 'Anchor / share',
      align: 'right',
      hideOnMobile: true,
      cardHidden: true,
      render: (row) => (row.anchorPerShareUsd === null ? '—' : formatMoney(row.anchorPerShareUsd)),
      sortable: true,
      sortValue: (row) => row.anchorPerShareUsd ?? 0,
    },
    {
      key: 'premium',
      header: 'Premium',
      cardLabel: 'Premium to anchor',
      align: 'right',
      render: (row) =>
        row.premiumToAnchor === null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <DeltaBadge value={row.premiumToAnchor} format="percent" bare arrow={false} tone={row.premiumToAnchor >= 0 ? 'warn' : 'info'} />
        ),
      sortable: true,
      sortValue: (row) => row.premiumToAnchor ?? 0,
    },
    {
      key: 'beta',
      header: 'Beta',
      align: 'right',
      hideOnMobile: true,
      cardHidden: true,
      render: (row) => formatPct(row.instrument.beta),
      sortable: true,
      sortValue: (row) => row.instrument.beta,
    },
  ];

  const positionColumns: readonly Column<PositionRow>[] = [
    { key: 'company', header: 'Company', render: (row) => <span className="text-ink">{row.companyName}</span>, sortable: true, sortValue: (row) => row.companyName },
    { key: 'holder', header: 'Held by', render: (row) => <span className="text-ink-dim">{row.holderLabel}</span>, hideOnMobile: true },
    { key: 'shares', header: 'Shares', align: 'right', render: (row) => formatCount(row.shares), sortable: true, sortValue: (row) => row.shares },
    { key: 'pct', header: 'Stake', align: 'right', render: (row) => formatPct(row.economicPct), sortable: true, sortValue: (row) => row.economicPct },
    {
      key: 'threshold',
      header: 'Threshold',
      render: (row) =>
        row.thresholdLabel === null ? (
          <span className="text-[10px] text-ink-faint">below 5%</span>
        ) : (
          <Tag tone={row.thresholdLabel === 'control' ? 'brand' : 'warn'}>{humanise(row.thresholdLabel)}</Tag>
        ),
      hideOnMobile: true,
    },
    { key: 'cost', header: 'Cost basis', align: 'right', render: (row) => formatMoney(row.costBasisUsd), hideOnMobile: true, cardHidden: true },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) => (
        <span title={row.basis === 'anchor' ? 'Marked at the fundamental anchor: this name is not listed.' : 'Marked at the last close.'}>
          {formatMoney(row.valueUsd)}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.valueUsd,
    },
    {
      key: 'disclosed',
      header: 'Public',
      render: (row) => (
        <Tag tone={row.isDisclosed ? 'info' : 'neutral'} dot>
          {row.isDisclosed ? 'disclosed' : 'undisclosed'}
        </Tag>
      ),
      hideOnMobile: true,
    },
  ];

  /* --- the register table -------------------------------------------------- */

  const registerColumns: readonly Column<RegisterRow>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => (
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`truncate text-[13px] sm:text-[12px] ${row.isOwn ? 'font-semibold text-brand' : 'text-ink'}`}>{row.name}</span>
            {row.ticker === null ? null : <span className="figure shrink-0 text-[10px] text-ink-faint">{row.ticker}</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <SectorBadge sector={row.sector} />
            <RegionBadge region={row.region} />
          </span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.name,
    },
    {
      key: 'listing',
      header: 'Listing',
      width: '92px',
      mono: false,
      render: (row) => <Tag tone={row.isPublic ? 'info' : 'neutral'} dot>{row.isPublic ? 'listed' : 'private'}</Tag>,
      sortable: true,
      sortValue: (row) => (row.isPublic ? 0 : 1),
    },
    {
      key: 'value',
      header: 'Value',
      cardLabel: 'Market value',
      align: 'right',
      render: (row) =>
        row.valueUsd === null ? (
          <span
            className="text-ink-faint"
            title="Privately held: no quote exists and a private company's anchor is not public information."
          >
            undisclosed
          </span>
        ) : (
          <span title={row.valueBasis === 'quote' ? 'Last quoted capitalisation.' : 'Your own fundamental anchor.'}>
            {formatMoney(row.valueUsd)}
          </span>
        ),
      sortable: true,
      sortValue: (row) => row.valueUsd ?? -1,
    },
    {
      key: 'revenue',
      header: 'Revenue',
      cardLabel: 'Trailing revenue',
      align: 'right',
      render: (row) => (row.revenueTtmUsd === null ? '—' : formatMoney(row.revenueTtmUsd)),
      sortable: true,
      sortValue: (row) => row.revenueTtmUsd ?? -1,
    },
    {
      key: 'growth',
      header: 'Growth',
      cardLabel: 'Revenue growth, year on year',
      align: 'right',
      hideOnMobile: true,
      render: (row) =>
        row.revenueGrowthYoY === null ? <span className="text-ink-faint">—</span> : <DeltaBadge value={row.revenueGrowthYoY} format="percent" bare />,
      sortable: true,
      sortValue: (row) => row.revenueGrowthYoY ?? -1,
    },
    {
      key: 'margin',
      header: 'Margin',
      cardLabel: 'Gross margin',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (row.grossMarginPct === null ? '—' : formatPct(row.grossMarginPct)),
      sortable: true,
      sortValue: (row) => row.grossMarginPct ?? -1,
    },
    {
      key: 'multiple',
      header: 'Multiple',
      cardLabel: 'Value over revenue',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (row.revenueMultiple === null ? '—' : `${formatCount(row.revenueMultiple)}x`),
      sortable: true,
      sortValue: (row) => row.revenueMultiple ?? -1,
    },
  ];

  const allBeliefs = session.beliefs
    .slice()
    .sort((a, b) => Math.abs(b.probability - b.priorProbability) - Math.abs(a.probability - a.priorProbability));
  const recentDisclosures = disclosuresFor(view, null).slice(0, 8);

  return (
    <>
      <PageHeader
        title="Markets"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · in-world exchange`}
        subtitle="Prices reflect what the market believes, not what the database knows. Open any name for the working."
        actions={
          <Tag tone="neutral">
            {register.length} companies · {equities.length} listed · {indices.length} indices
          </Tag>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard
          iconName="chart"
          label={primaryIndex === null ? 'Market index' : primaryIndex.instrument.symbol}
          value={primaryIndex === null || primaryIndex.quote === null ? '—' : formatCount(primaryIndex.quote.price)}
          delta={primaryIndex?.quote?.return}
          spark={primaryIndex?.history}
          hint={primaryIndex === null ? 'Capitalisation-weighted' : primaryIndex.instrument.name}
        />
        {secondaryIndex === null ? (
          <StatCard
            iconName="gauge"
            label="Volatility regime"
            value={formatPct(view.world.capitalMarkets.volatility)}
            hint="Feeds the noise term of every quarterly return"
          />
        ) : (
          <StatCard
            iconName="network"
            label={secondaryIndex.instrument.symbol}
            value={secondaryIndex.quote === null ? '—' : formatCount(secondaryIndex.quote.price)}
            delta={secondaryIndex.quote?.return}
            spark={secondaryIndex.history}
            hint={secondaryIndex.instrument.name}
          />
        )}
        <StatCard
          iconName="ledger"
          label="Sector multiples"
          value={formatMultiple(view.world.capitalMarkets.sectorMultiples)}
          hint="What a dollar of revenue is worth this quarter"
        />
        <StatCard
          iconName="coins"
          label="Your valuation"
          value={formatMoney(ownAnchor?.anchorValueUsd ?? 0)}
          hint={company.instrumentId === null ? 'Unlisted — fundamental anchor' : 'Anchor, not price'}
        />
      </div>

      {/* --- the economy, by sector -------------------------------------------
          Only where there is more than one sector to compare. A world-version-1
          save has a single sector, and a table of one row above the tape would
          be a heading with nothing under it. */}
      {!multiSector ? null : (
        <Panel
          iconName="globe"
          iconTone="brand"
          title="The economy by sector"
          flush
          subtitle="Aggregates cover the public figures only: a private company contributes a name and nothing else."
        >
          <DataTable
            columns={[
              {
                key: 'sector',
                header: 'Sector',
                mono: false,
                render: (row) => <SectorBadge sector={row.sector} size="md" />,
                sortable: true,
                sortValue: (row) => row.sector,
              },
              {
                key: 'companies',
                header: 'Companies',
                align: 'right',
                render: (row) => `${formatCount(row.companies)}`,
                sortable: true,
                sortValue: (row) => row.companies,
              },
              {
                key: 'listed',
                header: 'Listed',
                align: 'right',
                hideOnMobile: true,
                render: (row) => formatCount(row.listed),
                sortable: true,
                sortValue: (row) => row.listed,
              },
              {
                key: 'cap',
                header: 'Market cap',
                cardLabel: 'Listed market cap',
                align: 'right',
                render: (row) => (row.marketCapUsd === 0 ? '—' : formatMoney(row.marketCapUsd)),
                sortable: true,
                sortValue: (row) => row.marketCapUsd,
              },
              {
                key: 'revenue',
                header: 'Revenue',
                cardLabel: 'Disclosed revenue',
                align: 'right',
                render: (row) => (row.revenueTtmUsd === 0 ? '—' : formatMoney(row.revenueTtmUsd)),
                sortable: true,
                sortValue: (row) => row.revenueTtmUsd,
              },
              {
                key: 'margin',
                header: 'Margin',
                align: 'right',
                hideOnMobile: true,
                render: (row) => (row.grossMarginPct === null ? '—' : formatPct(row.grossMarginPct)),
                sortable: true,
                sortValue: (row) => row.grossMarginPct ?? 0,
              },
              {
                key: 'multiple',
                header: 'Multiple',
                cardLabel: 'Cap over revenue',
                align: 'right',
                render: (row) => (row.blendedMultiple === null ? '—' : `${formatCount(row.blendedMultiple)}x`),
                sortable: true,
                sortValue: (row) => row.blendedMultiple ?? 0,
              },
            ]}
            rows={rollups}
            rowKey={(row) => row.sector}
            onRowClick={(row) => setRegisterSector((current) => (current === row.sector ? null : row.sector))}
            isHighlighted={(row) => row.sector === registerSector}
            dense
            cardMode="auto"
            cardTitleKey="sector"
            initialSort={{ key: 'cap', direction: 'desc' }}
          />
        </Panel>
      )}

      <Panel
        iconName="chart"
        iconTone="brand"
        title="Exchange"
        flush
        subtitle="Quarterly closes. Premium is price against the anchor's per-share value."
        actions={
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <Icon name="chevronRight" size={13} accent="current" />
            <span className="sm:hidden">Tap a name for the working and the ticket</span>
            <span className="hidden sm:inline">Select a row for the decomposition and the ticket</span>
          </span>
        }
      >
        {!multiSector ? null : (
          <div className="border-b border-hair px-3 pt-3 pb-2">
            <SectorFilter sectors={tapeSectors} value={tapeSector} onChange={setTapeSector} counts={tapeCounts} totalLabel="Everything" />
          </div>
        )}
        <DataTable
          columns={tapeColumns}
          rows={tapeRows}
          rowKey={(row) => row.instrument.id}
          onRowClick={(row) => setOpenId(row.instrument.id)}
          isHighlighted={(row) => row.instrument.companyId === company.id}
          dense
          cardMode="auto"
          cardTitleKey="name"
          initialSort={{ key: 'cap', direction: 'desc' }}
          empty={
            <EmptyState
              icon="chart"
              title={tapeSector === null ? 'No instruments' : 'Nothing listed in this sector'}
              message={
                tapeSector === null
                  ? 'This session has no in-world exchange.'
                  : 'Every company in this sector is privately held. They are all on the register below.'
              }
            />
          }
        />
      </Panel>

      {/* --- the register ------------------------------------------------------
          The tape only carries the companies that are listed. This is everyone
          the player can see, which in the multi-sector world is most of the
          economy: private rivals show a name, a sector and a region, and their
          figures are absent rather than invented. */}
      <Panel
        iconName="building"
        iconTone="info"
        title="Company register"
        flush
        subtitle="Every company on the public register. A private company discloses nothing beyond what it does and where it is."
        actions={
          <Tag tone="neutral">
            {registerFiltered.length} of {register.length}
          </Tag>
        }
      >
        {!multiSector ? null : (
          <div className="border-b border-hair px-3 pt-3 pb-2">
            <SectorFilter sectors={presentSectors} value={registerSector} onChange={setRegisterSector} counts={counts} />
          </div>
        )}
        <DataTable
          columns={registerColumns}
          rows={registerFiltered}
          rowKey={(row) => row.companyId}
          isHighlighted={(row) => row.isOwn}
          dense
          cardMode="auto"
          cardTitleKey="company"
          initialSort={{ key: 'value', direction: 'desc' }}
          empty={<EmptyState compact icon="building" title="No companies on the register" message="Nothing is visible to this company yet." />}
        />
      </Panel>

      <Panel
        iconName="briefcase"
        title="Your positions"
        flush
        subtitle="Every stake held by you or by your company, with the highest ownership threshold each has crossed."
      >
        <DataTable
          columns={positionColumns}
          rows={positions}
          rowKey={(row) => row.key}
          dense
          cardMode="auto"
          cardTitleKey="company"
          initialSort={{ key: 'value', direction: 'desc' }}
          empty={
            <EmptyState
              compact
              icon="coins"
              title="No positions outside your own company"
              message="Accumulating a stake in a rival starts on any row above. Crossing 5% makes the position public."
            />
          }
        />
      </Panel>

      {/* --- the short book ---------------------------------------------------
          One row per instrument with an open book: short interest as a whole
          percentage against the cap, the borrow fee beside it, and a warning
          badge where the squeeze condition is live. Absent entirely in a world
          with no institutional layer — an empty panel would say something
          untrue about a session that simply has no shorts in it. */}
      {shortRows.length === 0 ? null : (
        <Panel
          iconName="chart"
          iconTone="warn"
          title="Short interest"
          subtitle="What it costs to stay short rises with how crowded the trade is, which is why nobody sits short forever waiting to be right."
          actions={<Tag tone={anySqueeze ? 'loss' : 'neutral'}>{shortRows.length} with an open book</Tag>}
        >
          <div className="grid gap-2.5 sm:grid-cols-2">
            {shortRows.map((short) => (
              <ShortInterestCard
                key={short.instrumentId}
                row={short}
                companyName={companyNameOf(view, short.companyId)}
                entityNameOf={entityNameOf}
              />
            ))}
          </div>
        </Panel>
      )}

      {company.instrumentId === null ? (
        <Panel iconName="building" title="Your company is not listed" subtitle="Private companies are marked to their fundamental anchor.">
          {ownAnchor === null ? (
            <EmptyState compact icon="building" title="No anchor yet" message="An anchor is computed for every active company at each resolution." />
          ) : (
            <>
              <KeyValueGrid
                columns={4}
                items={[
                  { label: 'Method', value: humanise(ownAnchor.method), mono: false },
                  { label: 'Anchor value', value: formatMoney(ownAnchor.anchorValueUsd) },
                  { label: 'Per share', value: ownAnchor.perShareValueUsd === null ? '—' : formatMoney(ownAnchor.perShareValueUsd) },
                  { label: 'Confidence', value: formatPct(ownAnchor.confidence) },
                ]}
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {anchorInputRows(ownAnchor).map((input) => (
                  <div key={input.key} className="flex items-baseline justify-between gap-2 border-b border-hair pb-1">
                    <span className="truncate text-[10px] text-ink-faint">{input.label}</span>
                    <span className="figure text-[11px] text-ink-dim">{input.value}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] text-ink-faint">
                Listing is a board matter and needs an open window; the world&apos;s listing window currently reads{' '}
                {formatPct(view.world.capitalMarkets.ipoWindow)}.
              </p>
            </>
          )}
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel iconName="gauge" iconTone="info" title="Market beliefs" subtitle="The only path from private reality to a share price runs through these.">
          {allBeliefs.length === 0 ? (
            <EmptyState compact icon="gauge" title="No live beliefs" message="Beliefs form as disclosures, leaks and results arrive." />
          ) : (
            <ul className="flex flex-col gap-3.5">
              {allBeliefs.map((belief) => (
                <li key={belief.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] text-ink sm:text-[12px]">
                      {belief.subjectKind === 'company' ? companyNameOf(view, belief.subjectId) : humanise(belief.subjectId)}
                      <span className="text-ink-faint"> · {humanise(belief.topic)}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="figure text-[13px] text-ink sm:text-[12px]">{formatPct(belief.probability)}</span>
                      <DeltaBadge value={belief.probability - belief.priorProbability} format="points" bare invert />
                    </span>
                  </div>
                  <ProgressBar className="mt-1" value={belief.probability} ghostValue={belief.priorProbability} tone="info" />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel iconName="newspaper" title="Public disclosures" subtitle="What has been said on the record, and how much weight the market gives it.">
          {recentDisclosures.length === 0 ? (
            <EmptyState compact icon="newspaper" title="Nothing published" message="Guidance, earnings, leaks and analyst notes appear here." />
          ) : (
            <ul className="flex flex-col gap-3">
              {recentDisclosures.map((disclosure) => (
                <li key={disclosure.id} className="border-b border-hair pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <Tag tone={disclosure.kind === 'leak' || disclosure.kind === 'rumour' ? 'warn' : 'neutral'}>
                        {humanise(disclosure.kind)}
                      </Tag>
                      <span className="text-[11px] text-ink-faint">{companyNameOf(view, disclosure.companyId)}</span>
                    </span>
                    <span className="figure text-[10px] text-ink-faint">
                      {quarterLabel(session.startYear, disclosure.quarter)}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-dim sm:text-[12px]">{disclosure.headline}</p>
                  <Meter className="mt-1.5" label="Credibility" value={disclosure.credibility * 100} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {session.config.enableReferenceMarket ? (
        <Panel
          iconName="globe"
          title="Reference tape"
          subtitle="Real-world instruments. Read-only: no modifier, no event and no action may change them."
          className="border-dashed"
        >
          <EmptyState
            compact
            icon="globe"
            title="No reference feed connected"
            message="The market-data adapter supplies this panel. It is display-only in every configuration."
          />
        </Panel>
      ) : null}

      <InstrumentDrawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        row={selected}
        session={session}
        view={view}
        decomposition={openId === null ? null : decompositions.get(openId) ?? null}
        quarters={selectedQuarters}
      />
    </>
  );
}

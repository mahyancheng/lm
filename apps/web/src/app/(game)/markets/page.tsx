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
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import {
  DataTable,
  DeltaBadge,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  Sparkline,
  StatCard,
  Tag,
  type Column,
} from '@/components/ui';
import { useGame, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { InstrumentDrawer } from '@/components/screens/markets/InstrumentDrawer';
import { decompositionsFrom, type DecompositionView } from '@/components/screens/markets/decomposition';
import {
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
  const aiIndex = indices.find((row) => row.instrument.symbol === 'FCAI') ?? indices[0] ?? null;
  const semiIndex = indices.find((row) => row.instrument.symbol === 'FCSC') ?? indices[1] ?? null;
  const ownAnchor = anchorOf(session, company.id);

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

  /* --- tables ------------------------------------------------------------- */

  const tapeColumns: readonly Column<InstrumentRow>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      width: '92px',
      render: (row) => (
        <span
          className={`figure inline-flex h-5 min-w-11 items-center justify-center rounded-[3px] border px-1 text-[10px] ${
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
          <span className="block truncate text-[12px] text-ink">{row.companyName}</span>
          <span className="block truncate text-[10px] text-ink-faint">
            {humanise(row.instrument.kind)}
            {row.instrument.sectorId === null ? '' : ` · ${humanise(row.instrument.sectorId)}`}
          </span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.companyName,
    },
    {
      key: 'trend',
      header: 'Trend',
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
      render: (row) => (row.quote === null || row.quote.marketCapUsd === 0 ? '—' : formatMoney(row.quote.marketCapUsd)),
      sortable: true,
      sortValue: (row) => row.quote?.marketCapUsd ?? 0,
    },
    {
      key: 'anchor',
      header: 'Anchor / share',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (row.anchorPerShareUsd === null ? '—' : formatMoney(row.anchorPerShareUsd)),
      sortable: true,
      sortValue: (row) => row.anchorPerShareUsd ?? 0,
    },
    {
      key: 'premium',
      header: 'Premium',
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
      render: (row) => row.instrument.beta.toFixed(2),
      sortable: true,
      sortValue: (row) => row.instrument.beta,
    },
  ];

  const positionColumns: readonly Column<PositionRow>[] = [
    { key: 'company', header: 'Company', render: (row) => <span className="text-ink">{row.companyName}</span>, sortable: true, sortValue: (row) => row.companyName },
    { key: 'holder', header: 'Held by', render: (row) => <span className="text-ink-dim">{row.holderLabel}</span>, hideOnMobile: true },
    { key: 'shares', header: 'Shares', align: 'right', render: (row) => formatCount(row.shares), sortable: true, sortValue: (row) => row.shares },
    { key: 'pct', header: 'Stake', align: 'right', render: (row) => formatPct(row.economicPct, 2), sortable: true, sortValue: (row) => row.economicPct },
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
    { key: 'cost', header: 'Cost basis', align: 'right', render: (row) => formatMoney(row.costBasisUsd), hideOnMobile: true },
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
            {equities.length} equities · {indices.length} indices
          </Tag>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={aiIndex === null ? 'AI index' : aiIndex.instrument.name}
          value={aiIndex === null || aiIndex.quote === null ? '—' : aiIndex.quote.price.toFixed(2)}
          delta={aiIndex?.quote?.return}
          spark={aiIndex?.history}
          hint="Capitalisation-weighted, decomposed like any name"
        />
        <StatCard
          label={semiIndex === null ? 'Compute index' : semiIndex.instrument.name}
          value={semiIndex === null || semiIndex.quote === null ? '—' : semiIndex.quote.price.toFixed(2)}
          delta={semiIndex?.quote?.return}
          spark={semiIndex?.history}
          hint="Semiconductors and compute"
        />
        <StatCard
          label="Volatility regime"
          value={formatPct(view.world.capitalMarkets.volatility)}
          hint="Feeds the noise term of every quarterly return"
        />
        <StatCard
          label="Your valuation"
          value={formatMoney(ownAnchor?.anchorValueUsd ?? 0)}
          hint={company.instrumentId === null ? 'Unlisted — fundamental anchor' : 'Anchor, not price'}
        />
      </div>

      <Panel
        title="Exchange"
        flush
        subtitle="Quarterly closes. Premium is price against the anchor's per-share value."
        actions={<span className="text-[10px] text-ink-faint">Select a row for the decomposition and the ticket</span>}
      >
        <DataTable
          columns={tapeColumns}
          rows={rows}
          rowKey={(row) => row.instrument.id}
          onRowClick={(row) => setOpenId(row.instrument.id)}
          isHighlighted={(row) => row.instrument.companyId === company.id}
          dense
          initialSort={{ key: 'cap', direction: 'desc' }}
          empty={<EmptyState title="No instruments" message="This session has no in-world exchange." />}
        />
      </Panel>

      {company.instrumentId === null ? (
        <Panel title="Your company is not listed" subtitle="Private companies are marked to their fundamental anchor.">
          {ownAnchor === null ? (
            <EmptyState compact title="No anchor yet" message="An anchor is computed for every active company at each resolution." />
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
                {Object.entries(ownAnchor.inputs).map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-2 border-b border-hair/50 pb-1">
                    <span className="truncate text-[10px] text-ink-faint">{key}</span>
                    <span className="figure text-[11px] text-ink-dim">
                      {Math.abs(value) >= 1000 ? formatMoney(value) : value.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-ink-faint">
                Listing is a board matter and needs an open window; the world&apos;s listing window currently reads{' '}
                {formatPct(view.world.capitalMarkets.ipoWindow)}.
              </p>
            </>
          )}
        </Panel>
      ) : null}

      <Panel
        title="Your positions"
        flush
        subtitle="Every stake held by you or by your company, with the highest ownership threshold each has crossed."
      >
        <DataTable
          columns={positionColumns}
          rows={positions}
          rowKey={(row) => row.key}
          dense
          initialSort={{ key: 'value', direction: 'desc' }}
          empty={
            <EmptyState
              compact
              glyph="POS"
              title="No positions outside your own company"
              message="Accumulating a stake in a rival starts on any row above. Crossing 5% makes the position public."
            />
          }
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Market beliefs" subtitle="The only path from private reality to a share price runs through these.">
          {allBeliefs.length === 0 ? (
            <EmptyState compact title="No live beliefs" message="Beliefs form as disclosures, leaks and results arrive." />
          ) : (
            <ul className="flex flex-col gap-3">
              {allBeliefs.map((belief) => (
                <li key={belief.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[12px] text-ink">
                      {belief.subjectKind === 'company' ? companyNameOf(view, belief.subjectId) : humanise(belief.subjectId)}
                      <span className="text-ink-faint"> · {humanise(belief.topic)}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="figure text-[12px] text-ink">{formatPct(belief.probability)}</span>
                      <DeltaBadge value={belief.probability - belief.priorProbability} format="points" bare invert />
                    </span>
                  </div>
                  <ProgressBar className="mt-1" value={belief.probability} ghostValue={belief.priorProbability} tone="info" />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Public disclosures" subtitle="What has been said on the record, and how much weight the market gives it.">
          {recentDisclosures.length === 0 ? (
            <EmptyState compact title="Nothing published" message="Guidance, earnings, leaks and analyst notes appear here." />
          ) : (
            <ul className="flex flex-col gap-2">
              {recentDisclosures.map((disclosure) => (
                <li key={disclosure.id} className="border-b border-hair/60 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <Tag tone={disclosure.kind === 'leak' || disclosure.kind === 'rumour' ? 'warn' : 'neutral'}>
                        {humanise(disclosure.kind)}
                      </Tag>
                      <span className="text-[10px] text-ink-faint">{companyNameOf(view, disclosure.companyId)}</span>
                    </span>
                    <span className="figure text-[10px] text-ink-faint">
                      {quarterLabel(session.startYear, disclosure.quarter)}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink-dim">{disclosure.headline}</p>
                  <Meter className="mt-1" label="Credibility" value={disclosure.credibility * 100} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {session.config.enableReferenceMarket ? (
        <Panel
          title="Reference tape"
          subtitle="Real-world instruments. Read-only: no modifier, no event and no action may change them."
          className="border-dashed"
        >
          <EmptyState
            compact
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

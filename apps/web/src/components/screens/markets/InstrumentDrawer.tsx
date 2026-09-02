'use client';

/**
 * One instrument, decomposed.
 *
 * The rolling price history, the seven-component explanation of the last move,
 * the anchor the price is being pulled toward with the inputs that produced it,
 * what the market currently believes, what has been said on the record, your
 * own position, and the ticket that changes it.
 *
 * Nothing here is narrative: the decomposition comes out of the `market_priced`
 * ledger row and reconciles to the applied return.
 */

import type { PlayerView, SessionState } from '@frontier/contracts';
import { controlRowsFor, quarterLabel } from '@frontier/contracts';
import { formatDelta, formatMoney, formatPct } from '@frontier/shared';
import {
  AiLabel,
  BarChart,
  DeltaBadge,
  Drawer,
  EmptyState,
  KeyValueGrid,
  LineChart,
  Meter,
  ProgressBar,
  RegionBadge,
  SectionHeading,
  SectorBadge,
  Tag,
  regionOf,
  sectorOf,
  toneOfDelta,
  type BarDatum,
} from '@/components/ui';
import { anchorInputRows, anchorOf, disclosuresFor, formatCount, humanise, issuedSharesOf } from '../reporting/util';
import type { InstrumentRow } from '../reporting/util';
import type { DecompositionView } from './decomposition';
import { TradeTicket } from './TradeTicket';

export interface InstrumentDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly row: InstrumentRow | null;
  readonly session: SessionState;
  readonly view: PlayerView;
  readonly decomposition: DecompositionView | null;
  /** Quarters of price history to label the chart with. */
  readonly quarters: readonly number[];
}

export function InstrumentDrawer({
  open,
  onClose,
  row,
  session,
  view,
  decomposition,
  quarters,
}: InstrumentDrawerProps): React.JSX.Element | null {
  if (row === null) return null;

  const companyId = row.instrument.companyId;
  const beliefs = companyId === null ? [] : session.beliefs.filter((belief) => belief.subjectId === companyId);
  const disclosures = companyId === null ? [] : disclosuresFor(view, companyId).slice(0, 6);
  const anchor = companyId === null ? null : anchorOf(session, companyId);
  const capTable = companyId === null ? null : session.capTables.find((entry) => entry.companyId === companyId) ?? null;
  const security = session.securities.find((entry) => entry.instrumentId === row.instrument.id) ?? null;

  const heldShares =
    capTable === null || security === null
      ? 0
      : capTable.holdings
          .filter((holding) => holding.securityId === security.id && holding.holderId === view.ownCompany.id)
          .reduce((total, holding) => total + holding.shares, 0);
  const issued = capTable === null ? 0 : issuedSharesOf(capTable);

  // The free float, summed exactly as the validator sums it when it cuts a
  // purchase down: the ticket's buy slider must not offer shares no one is
  // holding out for sale.
  const floatShares =
    capTable === null || security === null
      ? 0
      : capTable.holdings
          .filter((holding) => holding.securityId === security.id && holding.holderKind === 'public_float')
          .reduce((total, holding) => total + holding.shares, 0);

  const bars: BarDatum[] =
    decomposition === null
      ? []
      : decomposition.components.map((component) => ({
          label: component.label,
          value: component.value,
          tone: toneOfDelta(component.value),
          caption: component.note,
        }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`${row.instrument.symbol} · ${row.companyName}`}
      subtitle={`${humanise(row.instrument.kind)} · beta ${formatPct(row.instrument.beta)}${
        row.instrument.sectorId === null ? '' : ` · ${humanise(row.instrument.sectorId)}`
      }`}
      width={560}
    >
      <div className="flex flex-col gap-5">
        {/* --- what and where ------------------------------------------------
            An index stands for a basket, so it gets no sector badge; a company
            gets both, because with twenty-five names the first question about
            an unfamiliar ticker is what business it is in. */}
        {row.company === null ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <SectorBadge sector={sectorOf(row.company)} size="md" />
            <RegionBadge region={regionOf(row.company)} size="md" />
          </div>
        )}

        {/* --- price ------------------------------------------------------- */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="figure text-[19px] font-medium text-ink">{row.quote === null ? '—' : formatMoney(row.quote.price)}</span>
            {row.quote === null ? null : <DeltaBadge value={row.quote.return} format="percent" />}
          </div>
          {row.history.length >= 2 ? (
            <LineChart
              className="mt-2"
              series={[{ id: row.instrument.id, label: row.instrument.symbol, values: row.history, tone: 'brand' }]}
              xLabels={quarters.map((quarter) => quarterLabel(session.startYear, quarter))}
              formatValue={(value) => formatMoney(value)}
              showLegend={false}
              height={150}
            />
          ) : (
            <p className="mt-2 text-[13px] text-ink-faint sm:text-[11px]">
              One close on the tape so far. A second quarter draws the series.
            </p>
          )}
          <KeyValueGrid
            className="mt-3"
            columns={2}
            items={[
              { label: 'Market cap', value: row.quote === null ? '—' : formatMoney(row.quote.marketCapUsd) },
              { label: 'Volume', value: row.quote === null ? '—' : formatCount(row.quote.volume) },
              {
                label: 'Shares outstanding',
                value: row.instrument.sharesOutstanding === null ? '—' : formatCount(row.instrument.sharesOutstanding),
              },
              {
                label: 'Premium to anchor',
                value: row.premiumToAnchor === null ? '—' : formatPct(row.premiumToAnchor),
                tone: row.premiumToAnchor === null ? undefined : row.premiumToAnchor >= 0 ? 'warn' : 'info',
                hint: row.premiumToAnchor === null ? 'No published anchor' : 'Price against fundamental value per share',
              },
            ]}
          />
        </div>

        {/* --- fundamentals --------------------------------------------------
            The figures the price is meant to be anchored to. Present only where
            the company files them: a private rival's are absent, not hidden. */}
        {row.fundamentals === null ? null : (
          <div>
            <SectionHeading rule>Fundamentals</SectionHeading>
            <KeyValueGrid
              className="mt-2"
              columns={2}
              items={[
                { label: 'Trailing revenue', value: formatMoney(row.fundamentals.revenueTtmUsd) },
                { label: 'Growth, year on year', value: formatPct(row.fundamentals.revenueGrowthYoY) },
                { label: 'Gross margin', value: formatPct(row.fundamentals.grossMarginPct) },
                {
                  label: 'Trailing net income',
                  value: formatMoney(row.fundamentals.netIncomeTtmUsd),
                  tone: row.fundamentals.netIncomeTtmUsd < 0 ? 'loss' : undefined,
                },
                { label: 'Shares in issue', value: formatCount(row.fundamentals.sharesOutstanding) },
                {
                  label: 'Value over revenue',
                  value: row.revenueMultiple === null ? '—' : `${formatCount(row.revenueMultiple)}x`,
                  hint: 'Capitalisation divided by trailing revenue',
                },
              ]}
            />
          </div>
        )}

        {/* --- position and ticket -------------------------------------------
            The action sits directly under the price on purpose: on a phone the
            drawer is a bottom sheet, and the one control a player came here to
            use should be inside the first thumb-reach, not eight sections
            down. */}
        {security === null || !security.isTradable ? (
          <p className="text-[13px] leading-relaxed text-ink-faint sm:text-[11px]">
            This instrument has no tradable security attached, so there is nothing to buy or sell here.
          </p>
        ) : (
          <div>
            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Your position', value: formatCount(heldShares) },
                { label: 'Stake', value: issued === 0 ? '—' : formatPct(heldShares / issued) },
              ]}
            />
            <div className="mt-4">
              <TradeTicket
                securityId={security.id}
                companyName={row.companyName}
                symbol={row.instrument.symbol}
                lastPrice={row.quote?.price ?? 0}
                heldShares={heldShares}
                issuedShares={issued}
                floatShares={floatShares}
                control={
                  companyId === null
                    ? null
                    : (controlRowsFor(view.economyReport, companyId).find((entry) => entry.holderId === view.ownCompany.id) ?? null)
                }
              />
            </div>
          </div>
        )}

        {/* --- decomposition ----------------------------------------------- */}
        <div>
          <SectionHeading rule>Why it moved</SectionHeading>
          {decomposition === null ? (
            <EmptyState
              compact
              className="mt-2"
              icon="chart"
              title="No priced quarter in this tab"
              message="The seven components of a move are read from the market_priced ledger row. Resolve a quarter and the whole explanation appears here."
            />
          ) : (
            <div className="mt-2">
              <BarChart data={bars} formatValue={(value) => formatDelta(value, 'percent')} />
              <dl className="mt-3 divide-y divide-hair rounded-card border border-hair bg-raised/60">
                <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="label-caps-faint">Components sum</dt>
                  <dd className="figure text-[12px] text-ink-dim">{formatDelta(decomposition.sum, 'percent')}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="label-caps-faint">Applied return</dt>
                  <dd className="figure text-[12px] text-ink">{formatDelta(decomposition.total, 'percent')}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="label-caps-faint">Reconciles</dt>
                  <dd>
                    <Tag tone={decomposition.reconciles ? 'gain' : 'loss'} dot>
                      {decomposition.reconciles ? 'Exact' : 'Mismatch'}
                    </Tag>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="label-caps-faint">Price path</dt>
                  <dd className="figure text-[12px] text-ink-dim">
                    {formatMoney(decomposition.priceBefore)} → {formatMoney(decomposition.priceAfter)}
                    {decomposition.floored ? ' (floored)' : ''}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[10px] text-ink-faint">
                Ledger row <span className="figure">{decomposition.eventId}</span>, quarter{' '}
                {quarterLabel(session.startYear, decomposition.quarter)}.
              </p>
            </div>
          )}
        </div>

        {/* --- anchor ------------------------------------------------------- */}
        <div>
          <SectionHeading rule>Valuation anchor</SectionHeading>
          {anchor === null ? (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-faint sm:text-[11px]">
              No anchor is published for this instrument. Anchors are derived from what a company files; a private rival does not
              file.
            </p>
          ) : (
            <>
              <KeyValueGrid
                className="mt-2"
                columns={2}
                items={[
                  { label: 'Method', value: humanise(anchor.method), mono: false },
                  { label: 'Anchor value', value: formatMoney(anchor.anchorValueUsd) },
                  { label: 'Per share', value: anchor.perShareValueUsd === null ? '—' : formatMoney(anchor.perShareValueUsd) },
                  { label: 'Quarter', value: quarterLabel(session.startYear, anchor.quarter) },
                ]}
              />
              <Meter className="mt-2" label="Market weight on this anchor" value={anchor.confidence * 100} />
              <div className="mt-2">
                <div className="label-caps-faint mb-1">Inputs</div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {anchorInputRows(anchor).map((input) => (
                    <div key={input.key} className="flex items-baseline justify-between gap-2 border-b border-hair pb-1">
                      <dt className="truncate text-[10px] text-ink-faint">{input.label}</dt>
                      <dd className="figure text-[11px] text-ink-dim">{input.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
        </div>

        {/* --- beliefs ------------------------------------------------------ */}
        <div>
          <SectionHeading rule>What the market believes</SectionHeading>
          {beliefs.length === 0 ? (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-faint sm:text-[11px]">
              No live belief is attached to this name. Markets price beliefs, so a name with none is priced on factors and
              fundamentals alone.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {beliefs.map((belief) => (
                <li key={belief.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] text-ink sm:text-[12px]">{humanise(belief.topic)}</span>
                    <span className="flex items-baseline gap-2">
                      <span className="figure text-[12px] text-ink">{formatPct(belief.probability)}</span>
                      <DeltaBadge value={belief.probability - belief.priorProbability} format="points" bare invert />
                    </span>
                  </div>
                  <ProgressBar
                    className="mt-1"
                    value={belief.probability}
                    ghostValue={belief.priorProbability}
                    tone="info"
                    valueLabel={`prior ${formatPct(belief.priorProbability)}`}
                  />
                  {belief.evidenceDisclosureIds.length > 0 ? (
                    <p className="mt-1 truncate text-[10px] text-ink-faint">
                      Evidence: {belief.evidenceDisclosureIds.join(', ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* --- disclosures --------------------------------------------------- */}
        <div>
          <SectionHeading rule>On the record</SectionHeading>
          {disclosures.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-faint sm:text-[11px]">Nothing has been published about this name yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {disclosures.map((disclosure) => {
                const source =
                  disclosure.sourceCharacterId === null
                    ? null
                    : session.characters.find((character) => character.id === disclosure.sourceCharacterId) ?? null;
                return (
                  <li key={disclosure.id} className="raised-surface px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Tag tone={disclosure.kind === 'leak' || disclosure.kind === 'rumour' ? 'warn' : 'neutral'}>
                        {humanise(disclosure.kind)}
                      </Tag>
                      <span className="figure text-[10px] text-ink-faint">
                        {quarterLabel(session.startYear, disclosure.quarter)}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink sm:text-[12px]">{disclosure.headline}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="label-caps-faint shrink-0">Credibility</span>
                      <Meter className="flex-1" value={disclosure.credibility * 100} showValue />
                    </div>
                    {source === null ? null : (
                      <p className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-faint">
                        {source.name}
                        {source.isPlayer ? null : <AiLabel />}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

      </div>
    </Drawer>
  );
}

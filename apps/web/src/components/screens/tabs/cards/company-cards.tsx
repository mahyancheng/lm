'use client';

/**
 * The Company tab's cards: what you operate, one card per subject.
 *
 * Seven cards in the order a founder reads them — the floor, the lines, the
 * people, research, government, the books, and the group when there is one.
 * Each states its figures here and opens one sheet; nothing on this page is a
 * control, because every control lives in the sheet the card opens.
 *
 * Pure by construction: every figure arrives as a prop, already derived by
 * `CompanyTab` from the engine's own functions. Nothing here computes an
 * economic number, so nothing here can disagree with the sheet behind it.
 */

import type { ReactNode } from 'react';
import { formatCount, formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import { EmptyState, KeyValueGrid, Meter, Tag } from '@/components/ui';
import { sheetHref } from '@/lib/sheets';
import { DrillRow, TabCard } from './shell';

/* -------------------------------------------------------------------------- */
/*  The floor                                                                  */
/* -------------------------------------------------------------------------- */

export interface FloorCardProps {
  readonly companyName: string;
  /** `humanise(archetype)` · headquarters — the one line under the title. */
  readonly summary: string;
  /** `OfficeSceneCompact`, supplied by the tab so this card stays hook-free. */
  readonly scene: ReactNode;
  readonly headcount: number;
  readonly morale: number;
  readonly payrollUsd: number;
  readonly runwayQuarters: number | null;
}

export function FloorCard({ companyName, summary, scene, headcount, morale, payrollUsd, runwayQuarters }: FloorCardProps): React.JSX.Element {
  return (
    <TabCard sheet="company" title={companyName} subtitle={summary} iconTone="brand">
      {scene}
      <KeyValueGrid
        className="mt-3"
        columns={2}
        items={[
          { label: 'Headcount', value: formatCount(headcount) },
          { label: 'Payroll', value: formatMoney(payrollUsd), hint: 'Includes the loaded cost of open roles' },
          { label: 'Morale', value: formatScore(morale), tone: morale >= 70 ? 'gain' : morale >= 45 ? undefined : 'warn' },
          {
            label: 'Runway',
            value: runwayQuarters === null ? '—' : formatQuarterCount(runwayQuarters),
            tone: runwayQuarters === null ? undefined : runwayQuarters < 3 ? 'loss' : runwayQuarters < 6 ? 'warn' : undefined,
          },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Connections — the lines                                                    */
/* -------------------------------------------------------------------------- */

/** One line as the card prints it: the price and the margin, and nothing else. */
export interface LineRow {
  readonly productId: string;
  readonly name: string;
  readonly priceUsd: number;
  readonly unitLabel: string;
  readonly marginPct: number;
}

export interface LinesCardProps {
  readonly lineCount: number;
  readonly revenueUsd: number;
  readonly grossProfitUsd: number;
  /** Serving capacity less what the installed base draws. Negative is a shortfall. */
  readonly headroomUnits: number;
  /** At most `TOP_ROWS`; the rest are behind the sheet. */
  readonly lines: readonly LineRow[];
}

export function LinesCard({ lineCount, revenueUsd, grossProfitUsd, headroomUnits, lines }: LinesCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="products"
      subtitle="What you make, what it sells for, and what is left of the capacity that serves it."
      badges={<Tag tone={lineCount === 0 ? 'warn' : 'neutral'}>{lineCount === 1 ? '1 line' : `${lineCount} lines`}</Tag>}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Revenue', value: formatMoney(revenueUsd), hint: 'This quarter, at today’s prices' },
          { label: 'Gross profit', value: formatMoney(grossProfitUsd), tone: grossProfitUsd < 0 ? 'loss' : undefined },
          {
            label: 'Capacity headroom',
            value: formatCount(Math.round(headroomUnits)),
            tone: headroomUnits < 0 ? 'loss' : headroomUnits < 1 ? 'warn' : undefined,
            hint: headroomUnits < 0 ? 'Selling past capacity — the shortfall becomes churn' : 'Serving units still free',
          },
          { label: 'Lines', value: formatCount(lineCount) },
        ]}
      />

      {lines.length === 0 ? (
        <EmptyState
          className="mt-3"
          compact
          icon="box"
          title="No line open"
          message="A company with no line makes nothing and books no revenue. Open one and the picture fills in around it."
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {lines.map((line) => (
            <li key={line.productId}>
              {/* Tap 2 of "raise a price": the sheet opens with this line
                  selected and the price control in the first screenful. */}
              <DrillRow
                href={sheetHref('products', { line: line.productId })}
                name={line.name}
                detail={`margin ${formatPct(line.marginPct)}`}
                figure={formatMoney(line.priceUsd, 'full')}
                figureHint={`per ${line.unitLabel}`}
              />
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

export interface RoleRow {
  readonly role: string;
  readonly label: string;
  readonly count: number;
}

export interface PeopleCardProps {
  readonly headcount: number;
  readonly openRoles: number;
  readonly morale: number;
  readonly attrition: number;
  readonly avgCompUsd: number;
  /** The headcount-weighted market rate this company is judged against. */
  readonly marketCompUsd: number;
  readonly roles: readonly RoleRow[];
}

export function PeopleCard({ headcount, openRoles, morale, attrition, avgCompUsd, marketCompUsd, roles }: PeopleCardProps): React.JSX.Element {
  const competitiveness = marketCompUsd === 0 ? 1 : avgCompUsd / marketCompUsd;
  return (
    <TabCard
      sheet="people"
      subtitle="Who you employ, what they cost against the market, and who is leaving."
      badges={openRoles > 0 ? <Tag tone="warn">{openRoles === 1 ? '1 role open' : `${openRoles} roles open`}</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Headcount', value: formatCount(headcount) },
          { label: 'Open roles', value: formatCount(openRoles), tone: openRoles > 0 ? 'warn' : undefined },
          { label: 'Morale', value: formatScore(morale), tone: morale >= 70 ? 'gain' : morale >= 45 ? undefined : 'warn' },
          {
            label: 'Attrition',
            value: formatPct(attrition),
            tone: attrition > 0.06 ? 'loss' : attrition > 0.035 ? 'warn' : 'gain',
            hint: `≈ ${Math.round(headcount * attrition)} people next quarter`,
          },
          {
            label: 'Average pay',
            value: formatMoney(avgCompUsd),
            tone: competitiveness >= 1 ? 'gain' : 'warn',
            hint: `Market ${formatMoney(marketCompUsd)} · ${formatPct(competitiveness - 1)} against it`,
            wide: true,
          },
        ]}
      />

      <ul className="mt-3 flex flex-col gap-2">
        {roles.map((row) => (
          <li key={row.role}>
            {/* Tap 2 of "hire": the sheet opens scrolled to the headcount plan,
                where every band carries its own slider and its own ticket. */}
            <DrillRow href={sheetHref('people', { hash: 'headcount' })} name={row.label} figure={formatCount(row.count)} figureHint="in post" />
          </li>
        ))}
      </ul>
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Research                                                                   */
/* -------------------------------------------------------------------------- */

export interface ResearchCardProps {
  readonly programmes: number;
  readonly envelopeUsd: number;
  readonly researchers: number;
  /** Nodes one programme away, or null in a world with no node map. */
  readonly readyToStart: number | null;
}

export function ResearchCard({ programmes, envelopeUsd, researchers, readyToStart }: ResearchCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="research"
      subtitle="What you hold, what is one programme away, and what it would let you sell."
      badges={readyToStart === null || readyToStart === 0 ? null : <Tag tone="info">{readyToStart} ready to start</Tag>}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Programmes', value: formatCount(programmes), hint: 'Running now' },
          { label: 'Envelope', value: formatMoney(envelopeUsd), hint: 'What a quarter of research is funded at' },
          { label: 'Researchers', value: formatCount(researchers) },
          { label: 'Ready to start', value: readyToStart === null ? '—' : formatCount(readyToStart), hint: 'Every requirement already held' },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

export interface GovernmentCardProps {
  readonly pastPerformance: number;
  readonly openCompetitions: number;
  readonly backlogUsd: number;
  readonly complianceUsd: number;
}

export function GovernmentCard({ pastPerformance, openCompetitions, backlogUsd, complianceUsd }: GovernmentCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="government"
      subtitle="An award brings backlog and credibility, and with them compliance cost and capacity lock-in."
      badges={openCompetitions > 0 ? <Tag tone="info">{openCompetitions === 1 ? '1 open' : `${openCompetitions} open`}</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Past performance', value: formatScore(pastPerformance), hint: 'Procurement record, 0–100' },
          { label: 'Open competitions', value: formatCount(openCompetitions) },
          { label: 'Backlog', value: formatMoney(backlogUsd), hint: 'Awarded and not yet recognised' },
          { label: 'Compliance', value: formatMoney(complianceUsd), tone: complianceUsd > 0 ? 'warn' : undefined, hint: 'Every quarter, for as long as you hold the contracts' },
        ]}
      />
      <Meter className="mt-3" value={pastPerformance} label="Contractor record" benchmark={50} benchmarkLabel="Industry midpoint" />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Financials                                                                 */
/* -------------------------------------------------------------------------- */

export interface FinancialsCardProps {
  readonly revenueUsd: number;
  readonly operatingIncomeUsd: number;
  /** `quarterlyBurn`: positive is cash generated, negative is cash consumed. */
  readonly cashMovementUsd: number;
  /** Principal plus interest the engine takes next quarter. */
  readonly debtServiceUsd: number;
  /** Cash left after that service. Negative is the forced-bridge condition. */
  readonly serviceHeadroomUsd: number;
}

export function FinancialsCard({
  revenueUsd,
  operatingIncomeUsd,
  cashMovementUsd,
  debtServiceUsd,
  serviceHeadroomUsd,
}: FinancialsCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="financials"
      subtitle="The quarter's accounts, and what next quarter's debt takes before anything else."
      badges={serviceHeadroomUsd < 0 ? <Tag tone="loss">short of the service</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Revenue', value: formatMoney(revenueUsd) },
          { label: 'Operating income', value: formatMoney(operatingIncomeUsd), tone: operatingIncomeUsd < 0 ? 'loss' : 'gain' },
          {
            label: 'Cash movement',
            value: formatMoney(cashMovementUsd),
            tone: cashMovementUsd < 0 ? 'loss' : 'gain',
            hint: cashMovementUsd < 0 ? 'Net cash consumed' : 'Cash generative',
          },
          {
            label: 'Debt service',
            value: formatMoney(debtServiceUsd),
            tone: serviceHeadroomUsd < 0 ? 'loss' : undefined,
            hint: `Next quarter · leaves ${formatMoney(serviceHeadroomUsd)}`,
          },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Group                                                                      */
/* -------------------------------------------------------------------------- */

export interface GroupCardProps {
  readonly companies: number;
  readonly revenueUsd: number;
  readonly cashUsd: number;
  readonly enterpriseValueUsd: number;
  readonly headcount: number;
}

export function GroupCard({ companies, revenueUsd, cashUsd, enterpriseValueUsd, headcount }: GroupCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="group"
      subtitle="Every company you direct, folded into one set of accounts."
      badges={<Tag tone="neutral">{companies} companies</Tag>}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Consolidated revenue', value: formatMoney(revenueUsd) },
          { label: 'Consolidated cash', value: formatMoney(cashUsd), tone: cashUsd <= 0 ? 'loss' : undefined },
          { label: 'Market value', value: formatMoney(enterpriseValueUsd), hint: 'Consolidated enterprise value' },
          { label: 'Headcount', value: formatCount(headcount) },
        ]}
      />
    </TabCard>
  );
}

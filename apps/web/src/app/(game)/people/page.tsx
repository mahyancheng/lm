'use client';

/**
 * People — headcount, compensation, culture and the leadership layer.
 *
 * The screen is built around one uncomfortable number: attrition. It is priced
 * forward by the engine from morale, pay competitiveness and talent scarcity,
 * and the decomposition panel restates that pricing with the engine's own
 * published coefficients so a player can see which term is hurting them.
 *
 * Rivals appear only as *people* — characters are public, their employers'
 * operating figures are not. Nothing on this screen reads a rival company's
 * headcount, compute or product economics.
 */

import { useMemo } from 'react';
import { STAFF_ROLES, quarterLabel } from '@frontier/contracts';
import {
  ATTRITION_BOUNDS,
  BASE_ATTRITION,
  COMP_ATTRITION_COEFFICIENT,
  COMP_BAND_RETENTION,
  MORALE_ATTRITION_COEFFICIENT,
  SCARCITY_ATTRITION_COEFFICIENT,
} from '@frontier/simulation';
import { clamp, formatMoney, formatPct, formatScore } from '@frontier/shared';
import {
  BarChart,
  DeltaBadge,
  KeyValueGrid,
  LineChart,
  Meter,
  PageHeader,
  Panel,
  StatCard,
  Tag,
} from '@/components/ui';
import { ExecutivePanel } from '@/components/screens/people/ExecutivePanel';
import { HeadcountPlan } from '@/components/screens/people/HeadcountPlan';
import { ROLE_LABEL, blendedMarketCompUsd, headcountOf, talentReputationOf } from '@/components/screens/people/labels';
import { usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

const OUTLOOK_QUARTERS = 4;

export default function PeoplePage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();

  const employees = company.employees;
  const headcount = headcountOf(company);
  const marketComp = blendedMarketCompUsd(session, company);
  const competitiveness = marketComp === 0 ? 1 : employees.avgComp / marketComp;
  const talentReputation = talentReputationOf(company);

  const preferredBand = competitiveness >= 1.15 ? 'above_market' : competitiveness <= 0.9 ? 'below_market' : 'market';

  const drivers = useMemo(() => {
    const base = BASE_ATTRITION;
    const morale = MORALE_ATTRITION_COEFFICIENT * (1 - employees.morale / 100);
    const pay = COMP_ATTRITION_COEFFICIENT * Math.max(0, 1 - competitiveness);
    const scarcity = SCARCITY_ATTRITION_COEFFICIENT * (1 - session.world.talent.researcherSupply);
    const retention = COMP_BAND_RETENTION[preferredBand];
    const modelled = clamp(base + morale + pay + scarcity - retention, ATTRITION_BOUNDS.min, ATTRITION_BOUNDS.max);
    return { base, morale, pay, scarcity, retention, modelled };
  }, [employees.morale, competitiveness, session.world.talent.researcherSupply, preferredBand]);

  const outlook = useMemo(() => {
    const values: number[] = [headcount];
    let running = headcount;
    for (let index = 0; index < OUTLOOK_QUARTERS; index += 1) {
      running = running * (1 - employees.attrition);
      values.push(Math.max(0, running));
    }
    return values;
  }, [headcount, employees.attrition]);

  const departures = STAFF_ROLES.map((role) => ({
    label: ROLE_LABEL[role],
    value: company.employees[role] * employees.attrition,
    tone: 'loss' as const,
    caption: `${company.employees[role]} in post`,
  }));

  return (
    <>
      <PageHeader
        title="People"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Headcount, compensation, culture and the leadership layer. Hiring is an attempt: fill rates depend on supply, standing and the band."
        actions={
          <Tag tone={employees.morale >= 70 ? 'gain' : employees.morale >= 45 ? 'info' : 'warn'} dot>
            Morale {formatScore(employees.morale)}
          </Tag>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Headcount" iconName="people" value={headcount} unit="FTE" hint={`${employees.openRoles} roles open`} />
        <StatCard
          label="Attrition"
          iconName="warning"
          value={formatPct(employees.attrition)}
          deltaInvert
          tone={employees.attrition > 0.06 ? 'loss' : employees.attrition > 0.035 ? 'warn' : 'gain'}
          hint={`≈ ${Math.round(headcount * employees.attrition)} people next quarter`}
        />
        <StatCard
          label="Average pay"
          iconName="coins"
          value={formatMoney(employees.avgComp)}
          hint={`Market ${formatMoney(marketComp)} · ${formatPct(competitiveness - 1)} against it`}
          tone={competitiveness >= 1 ? 'gain' : 'warn'}
        />
        <StatCard
          label="Payroll"
          iconName="ledger"
          value={formatMoney(company.financials.payroll)}
          hint="Includes the loaded cost of open roles"
          href="/financials"
        />
      </div>

      <HeadcountPlan session={session} company={company} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Compensation against the market" iconName="coins" subtitle="What the talent market charges this company">
          <KeyValueGrid
            columns={1}
            items={[
              { label: 'Company average', value: formatMoney(employees.avgComp) },
              { label: 'Blended market rate', value: formatMoney(marketComp), hint: 'Headcount-weighted across the five functions' },
              {
                label: 'Competitiveness',
                value: `${(competitiveness * 100).toFixed(0)}%`,
                tone: competitiveness >= 1.15 ? 'gain' : competitiveness <= 0.9 ? 'loss' : 'info',
                hint: `Reads as the ${preferredBand.replace(/_/g, ' ')} band`,
              },
              {
                label: 'Salary pressure',
                value: session.world.talent.salaryPressure.toFixed(2),
                tone: session.world.talent.salaryPressure > 1.2 ? 'warn' : undefined,
                hint: 'World multiplier on every market rate',
              },
            ]}
          />
          <div className="mt-3 space-y-3">
            <Meter value={session.world.talent.researcherSupply * 100} label="Researcher supply" />
            <Meter value={session.world.talent.engineerSupply * 100} label="Engineer supply" />
            <Meter value={session.world.talent.immigrationAccess * 100} label="Immigration access" />
            <Meter value={talentReputation} label="Standing with the talent market" benchmark={50} benchmarkLabel="Industry midpoint" />
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            The talent audience is 45% developer reputation, 35% public and 20% investor. It multiplies every fill rate on this screen.
          </p>
        </Panel>

        <Panel title="Attrition, decomposed" iconName="chart" iconTone="warn" subtitle="The engine's own coefficients, term by term">
          <BarChart
            data={[
              { label: 'Baseline', value: drivers.base, tone: 'neutral' },
              { label: 'Morale gap', value: drivers.morale, tone: drivers.morale > 0.02 ? 'loss' : 'warn' },
              { label: 'Pay gap', value: drivers.pay, tone: drivers.pay > 0 ? 'loss' : 'neutral' },
              { label: 'Talent scarcity', value: drivers.scarcity, tone: 'warn' },
              { label: 'Band retention', value: drivers.retention, tone: 'gain', caption: 'Subtracted' },
            ]}
            formatValue={(value) => formatPct(value, 1)}
          />
          <div className="mt-3 border-t border-hair pt-2.5">
            <div className="flex items-baseline justify-between">
              <span className="label-caps-faint">Priced for next quarter</span>
              <span className="figure text-[16px] text-ink">{formatPct(drivers.modelled)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="label-caps-faint">Currently stored</span>
              <span className="figure text-[13px] text-ink-dim">{formatPct(employees.attrition)}</span>
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">
              The stored rate is what this quarter&apos;s leavers were priced at. A queued reduction adds its own term when the quarter resolves.
            </p>
          </div>
        </Panel>

        <Panel title="Attrition outlook" iconName="gauge" subtitle="Headcount at today's rate, with no hiring">
          <LineChart
            series={[{ id: 'headcount', label: 'Headcount', values: outlook, tone: 'warn', dashed: true }]}
            xLabels={outlook.map((_, index) => quarterLabel(session.startYear, session.quarter + index))}
            height={150}
            formatValue={(value) => Math.round(value).toString()}
            showLegend={false}
          />
          <div className="mt-3">
            <div className="label-caps mb-2">Expected departures by function</div>
            <BarChart data={departures} formatValue={(value) => value.toFixed(1)} />
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-hair pt-2.5">
            <DeltaBadge value={-(headcount - (outlook[outlook.length - 1] ?? headcount)) / Math.max(1, headcount)} format="percent" />
            <span className="text-[12px] text-ink-dim">of the company over four quarters if nothing is replaced</span>
          </div>
        </Panel>
      </div>

      <ExecutivePanel session={session} company={company} founder={founder} view={view} />
    </>
  );
}

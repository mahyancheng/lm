'use client';

/**
 * Company — what you operate, on one scrolling page.
 *
 * Seven cards in the order the plan sets: the floor, the lines, the people,
 * research, government, the books, and the group when there is one. Each card
 * states its figures here and opens one sheet, so a founder answers "how is the
 * company" without a tap and acts in exactly one more.
 *
 * The two tap paths this page exists to shorten:
 *
 * - **Raise a price** — Company (1) → the line's row on the Connections card
 *   (2), which opens `?sheet=products&line=` with the price control in the
 *   first screenful → slider → Queue (3).
 * - **Hire** — Company (1) → the role band's row on the People card (2), which
 *   opens `?sheet=people#headcount` scrolled to the headcount plan → slider →
 *   Queue (3).
 *
 * Every figure is derived here from the engine's own functions and handed to a
 * pure card, so a card cannot disagree with the sheet behind it. Government
 * sits on this tab rather than on World because delivery capacity and the
 * contractor record are operating facts about this company.
 *
 * The company is `useActiveCompany` — the company the seat is directing — which
 * is what every sheet on this tab reads.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { STAFF_ROLES } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import {
  consolidatedEnterpriseValueOf,
  groupStatementOf,
  groupStatementsSupported,
  isNodeEconomyWorld,
  researchEnvelopeUsd,
  researchMapFor,
  researchProjectsForCompany,
  servingComputeUnits,
} from '@frontier/simulation';
import { OfficeSceneCompact } from '@/components/scenes/office';
import { askChief } from '@/components/screens/chief-of-staff/composerBus';
import { Panel } from '@/components/ui';
import { debtServiceView } from '@/components/screens/financials/headroom';
import { ROLE_LABEL, blendedMarketCompUsd, headcountOf } from '@/components/screens/people/labels';
import { productServingUnits } from '@/components/screens/products/labels';
import { archetypeLabel, incomeStatementOf } from '@/components/screens/reporting/util';
import { PLAYER_ID, controlledCompanyRows, hasGroup, useActiveCompany, useCompanyMetrics, usePlayerView, useSession } from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import {
  FinancialsCard,
  FloorCard,
  floorFocusFor,
  GovernmentCard,
  GroupCard,
  LinesCard,
  PeopleCard,
  ResearchCard,
} from './cards/company-cards';
import { lineGrossProfitUsd, lineRevenueUsd, topLines } from './cards/lines';

export function CompanyTab(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = useActiveCompany();
  const metrics = useCompanyMetrics(company.id);

  /* --- the lines ---------------------------------------------------------- */

  const active = useMemo(() => company.products.filter((product) => product.isActive), [company.products]);
  const lineRevenue = active.reduce((total, product) => total + lineRevenueUsd(product), 0);
  const lineGrossProfit = active.reduce((total, product) => total + lineGrossProfitUsd(product), 0);
  const headroomUnits = useMemo(
    () => servingComputeUnits(session, company) - active.reduce((total, product) => total + productServingUnits(session, product), 0),
    [session, company, active],
  );

  // Largest first, capped at three: the rest are one tap away inside the sheet.
  const lines = useMemo(() => topLines(active), [active]);

  /* --- people -------------------------------------------------------------- */

  const employees = company.employees;
  const headcount = headcountOf(company);
  const marketComp = useMemo(() => blendedMarketCompUsd(session, company), [session, company]);
  const roles = useMemo(
    () =>
      STAFF_ROLES.map((role) => ({ role, label: ROLE_LABEL[role], count: employees[role] }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
        .slice(0, 3),
    [employees],
  );

  // The first card should offer the pressure that matters now, rather than a
  // generic menu. Each destination is an existing sheet control.
  const floorFocus = floorFocusFor({
    headroomUnits,
    runwayQuarters: metrics?.runwayQuarters ?? null,
    openRoles: employees.openRoles,
    featuredLineId: lines[0]?.productId ?? null,
  });

  /* --- research ------------------------------------------------------------ */

  // `researchProjectsForCompany` also returns rivals' *published* programmes, so
  // the count re-filters to this company's own; the map is handed the whole list
  // because that is what `ResearchConnectionsScreen` hands it, and a programme
  // dropped from it would put its own target node back on the "ready" list.
  const projects = useMemo(() => researchProjectsForCompany(session, company.id), [session, company.id]);
  const programmes = projects.filter((project) => project.companyId === company.id && project.status === 'active');
  const leadingProgramme = programmes[0] ?? null;
  const leadingNode = leadingProgramme === null ? null : session.techGraph.nodes.find((node) => node.id === leadingProgramme.targetNodeId) ?? null;
  const envelopeUsd = useMemo(() => researchEnvelopeUsd(company, []), [company]);
  // The node map is world 3's; in an older world there is no "one programme
  // away" list to count, and a zero would read as a fact rather than an absence.
  const readyToStart = useMemo(
    () => (isNodeEconomyWorld(session) ? researchMapFor(session, company, projects).options.length : null),
    [session, company, projects],
  );

  /* --- government ---------------------------------------------------------- */

  const openCompetitions = useMemo(
    () => view.opportunities.filter((opportunity) => opportunity.status === 'open' && opportunity.closeQuarter >= session.quarter).length,
    [view.opportunities, session.quarter],
  );
  const backlogUsd = view.contracts.reduce((total, contract) => total + Math.max(0, contract.totalValueUsd - contract.recognisedToDateUsd), 0);
  const complianceUsd = view.contracts.reduce((total, contract) => total + contract.complianceBurdenQuarterlyUsd, 0);

  /* --- the books ----------------------------------------------------------- */

  const pnl = useMemo(() => incomeStatementOf(company.financials), [company.financials]);
  const debtService = useMemo(
    () => debtServiceView(company.financials.cash, company.financials.debt, company.financials.interestExpense),
    [company.financials],
  );

  /* --- the group ----------------------------------------------------------- */

  const group = hasGroup(session, PLAYER_ID) && groupStatementsSupported(session);
  const groupRows = useMemo(() => (group ? controlledCompanyRows(session, PLAYER_ID) : []), [group, session]);
  const groupStatement = useMemo(() => (group ? groupStatementOf(session, PLAYER_ID) : null), [group, session]);
  const groupFounding = groupRows.find((row) => row.isFounding)?.company ?? null;
  const groupValueUsd = useMemo(
    () => (groupFounding === null ? 0 : consolidatedEnterpriseValueOf(session, groupFounding)),
    [session, groupFounding],
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="px-1 pt-1">
        <p className="label-caps text-brand">Build</p>
        <h1 className="mt-1 font-serif text-3xl leading-none text-ink sm:text-4xl">Make the next thing matter.</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">Your operating portfolio, production constraints, and the capabilities that unlock what comes next.</p>
      </header>

      <section aria-labelledby="build-journey">
        <h2 id="build-journey" className="mb-2 px-1 font-serif text-xl text-ink">Idea to market</h2>
        <Panel subtitle="Three real moves carry an idea from the table into the operating portfolio.">
          <ol className="grid gap-3 md:grid-cols-3">
            <li className="rounded-card border border-hair bg-raised p-3">
              <span className="label-caps text-brand">1 · Frame the idea</span>
              <p className="mt-2 min-h-10 text-sm text-ink-dim">Describe the customer, problem, and advantage. Your chief of staff will pressure-test it against this world.</p>
              <button type="button" onClick={() => askChief('I have a new product idea. Help me define the customer, capability, and launch path.')} className="btn btn-ghost tap-target mt-3 w-full">Describe an idea</button>
            </li>
            <li className="rounded-card border border-hair bg-raised p-3">
              <span className="label-caps text-brand">2 · Build capability</span>
              <p className="mt-2 min-h-10 text-sm text-ink-dim">{leadingProgramme === null ? (readyToStart !== null && readyToStart > 0 ? `${readyToStart} research paths are ready to start.` : 'Choose a research path whose prerequisites you can support.') : `${leadingNode?.title ?? 'Active programme'} · ${formatPct(leadingProgramme.progress)} progress.`}</p>
              <Link href={sheetHref('research')} className="btn btn-primary tap-target mt-3 w-full">{leadingProgramme === null ? 'Choose next capability' : 'Open research pipeline'}</Link>
            </li>
            <li className="rounded-card border border-hair bg-raised p-3">
              <span className="label-caps text-brand">3 · Launch and learn</span>
              <p className="mt-2 min-h-10 text-sm text-ink-dim">{active.length === 0 ? 'No line is active. Turn a held capability into an offer.' : `${active.length} active line${active.length === 1 ? '' : 's'} producing ${lineRevenue === 0 ? 'no booked revenue yet' : 'booked revenue this quarter'}.`}</p>
              <Link href={sheetHref('products')} className="btn btn-ghost tap-target mt-3 w-full">{active.length === 0 ? 'Plan first launch' : 'Manage products'}</Link>
            </li>
          </ol>
        </Panel>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <LinesCard lineCount={active.length} revenueUsd={lineRevenue} grossProfitUsd={lineGrossProfit} headroomUnits={headroomUnits} lines={lines} />
          <ResearchCard programmes={programmes.length} envelopeUsd={envelopeUsd} researchers={employees.researchers} readyToStart={readyToStart} />
        </div>
      </section>
      <section aria-labelledby="build-company">
        <h2 id="build-company" className="mb-2 px-1 font-serif text-xl text-ink">Keep the machine moving</h2>
        <FloorCard companyName={company.name} summary={`${archetypeLabel(company.archetype)} · ${company.headquartersCity}`} scene={<OfficeSceneCompact href={sheetHref('company')} />} headcount={headcount} morale={employees.morale} payrollUsd={company.financials.payroll} runwayQuarters={metrics?.runwayQuarters ?? null} focus={floorFocus} />
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <PeopleCard headcount={headcount} openRoles={employees.openRoles} morale={employees.morale} attrition={employees.attrition} avgCompUsd={employees.avgComp} marketCompUsd={marketComp} roles={roles} roleCount={STAFF_ROLES.length} />
          <FinancialsCard revenueUsd={pnl.revenue} operatingIncomeUsd={pnl.operatingIncome} cashMovementUsd={company.financials.quarterlyBurn} debtServiceUsd={debtService.totalUsd} serviceHeadroomUsd={debtService.headroomUsd} />
        </div>
      </section>

      <details className="rounded-card border border-hair bg-panel p-3">
        <summary className="tap-target cursor-pointer font-semibold text-ink">More operations{openCompetitions > 0 ? ` · ${openCompetitions} open government ${openCompetitions === 1 ? 'opportunity' : 'opportunities'}` : ''}</summary>
        <div className="mt-3 grid gap-4 xl:grid-cols-2">
          <GovernmentCard pastPerformance={company.governmentPastPerformance} openCompetitions={openCompetitions} backlogUsd={backlogUsd} complianceUsd={complianceUsd} />
          {groupStatement === null ? null : <GroupCard companies={groupRows.length} revenueUsd={groupStatement.income.revenueUsd} cashUsd={groupStatement.balance.cashUsd} enterpriseValueUsd={groupValueUsd} headcount={groupRows.reduce((total, row) => total + row.headcount, 0)} />}
        </div>
      </details>
    </div>
  );
}

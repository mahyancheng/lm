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

import { useMemo } from 'react';
import { STAFF_ROLES } from '@frontier/contracts';
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
import { debtServiceView } from '@/components/screens/financials/headroom';
import { ROLE_LABEL, blendedMarketCompUsd, headcountOf } from '@/components/screens/people/labels';
import { productServingUnits } from '@/components/screens/products/labels';
import { archetypeLabel, incomeStatementOf } from '@/components/screens/reporting/util';
import { PLAYER_ID, controlledCompanyRows, hasGroup, useActiveCompany, useCompanyMetrics, usePlayerView, useSession } from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import {
  FinancialsCard,
  FloorCard,
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
    () => STAFF_ROLES.map((role) => ({ role, label: ROLE_LABEL[role], count: employees[role] })),
    [employees],
  );

  /* --- research ------------------------------------------------------------ */

  // `researchProjectsForCompany` also returns rivals' *published* programmes, so
  // the count re-filters to this company's own; the map is handed the whole list
  // because that is what `ResearchConnectionsScreen` hands it, and a programme
  // dropped from it would put its own target node back on the "ready" list.
  const projects = useMemo(() => researchProjectsForCompany(session, company.id), [session, company.id]);
  const programmes = projects.filter((project) => project.companyId === company.id && project.status === 'active');
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
    <div className="flex flex-col gap-4">
      <FloorCard
        companyName={company.name}
        summary={`${archetypeLabel(company.archetype)} · ${company.headquartersCity}`}
        scene={<OfficeSceneCompact href={sheetHref('company')} />}
        headcount={headcount}
        morale={employees.morale}
        payrollUsd={company.financials.payroll}
        runwayQuarters={metrics?.runwayQuarters ?? null}
      />

      <LinesCard
        lineCount={active.length}
        revenueUsd={lineRevenue}
        grossProfitUsd={lineGrossProfit}
        headroomUnits={headroomUnits}
        lines={lines}
      />

      <PeopleCard
        headcount={headcount}
        openRoles={employees.openRoles}
        morale={employees.morale}
        attrition={employees.attrition}
        avgCompUsd={employees.avgComp}
        marketCompUsd={marketComp}
        roles={roles}
      />

      <ResearchCard
        programmes={programmes.length}
        envelopeUsd={envelopeUsd}
        researchers={employees.researchers}
        readyToStart={readyToStart}
      />

      <GovernmentCard
        pastPerformance={company.governmentPastPerformance}
        openCompetitions={openCompetitions}
        backlogUsd={backlogUsd}
        complianceUsd={complianceUsd}
      />

      <FinancialsCard
        revenueUsd={pnl.revenue}
        operatingIncomeUsd={pnl.operatingIncome}
        cashMovementUsd={company.financials.quarterlyBurn}
        debtServiceUsd={debtService.totalUsd}
        serviceHeadroomUsd={debtService.headroomUsd}
      />

      {groupStatement === null ? null : (
        <GroupCard
          companies={groupRows.length}
          revenueUsd={groupStatement.income.revenueUsd}
          cashUsd={groupStatement.balance.cashUsd}
          enterpriseValueUsd={groupValueUsd}
          headcount={groupRows.reduce((total, row) => total + row.headcount, 0)}
        />
      )}
    </div>
  );
}

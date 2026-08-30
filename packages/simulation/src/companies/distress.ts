/**
 * @frontier/simulation — companies/distress.ts
 *
 * What happens after a company cannot pay its bills.
 *
 * `financial_resolution` floors cash at zero, dumps the shortfall into payables
 * and queues a forced bridge round (`queueBridgeRound`). This module is the
 * other half of that loop, and it runs at the **top** of the same phase, one
 * quarter later:
 *
 * ```text
 * quarter t     shortfall -> payables, posture survival, bridge queued `open`
 * quarter t+1   settleForcedBridges: the bridge clears or it fails
 *                 cleared -> cash in, shares out, cap table diluted
 *                 failed  -> a strike against the company
 * after three consecutive failed bridges -> administration
 * ```
 *
 * ## Two ways to die
 *
 * The failed-bridge count is the *sudden* death: nobody will fund the company,
 * three times running, and it is wound up. On its own it made the opposite case
 * immortal. A company with no revenue whose bridges keep *clearing* never takes
 * a strike, so it could be rescued forever on somebody else's money and never
 * fail — the zombie the playtest found. `chronicallyRescued` is the slow death
 * beside it: six quarters in which every quarter needed rescue capital while
 * revenue never came near the wage bill is not a company having a bad year, it
 * is a payroll being financed, and it goes into the same administration.
 *
 * Why it lives here rather than in `capital_resolution`: the bridge is created
 * in phase eleven and capital is phase six, so a bridge queued this quarter
 * cannot be funded until the next one anyway. Settling it at the start of the
 * financial phase puts the rescue cash on the balance sheet before the quarter's
 * obligations are settled against it, which is what a rescue is for.
 *
 * ## Administration
 *
 * A company that cannot be rescued is wound down rather than left to run forever
 * on zero cash and unbounded payables. Products are sunset, the staff are
 * released into the talent market, the compute is surrendered, the estate is
 * realised at a haircut and the creditors take what is left, which marks equity
 * to about nothing. The husk stays `isActive` so it can still be bought — a
 * distressed acquisition is the point of a distressed company — but it has no
 * revenue, no payroll and no capacity, so it stops accumulating obligations.
 *
 * Determinism: no clock, no `Math.random`. Whether a bridge clears is a function
 * of the world's capital markets and the company's own standing; the insolvency
 * trigger counts failed bridges inside a fixed window.
 */

import type { CapTable, Company, FundingRound, ResolverContext, Security, SessionState, ShareClass } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { addShares, setIssued } from '../resolver/capital';
import {
  ADMINISTRATION_ASSET_RECOVERY,
  BRIDGE_APPETITE_FLOOR,
  BRIDGE_MAX_DILUTION,
  CHRONIC_DISTRESS_QUARTERS,
  CHRONIC_DISTRESS_REVENUE_FLOOR,
  INSOLVENCY_FAILED_BRIDGES,
  TALENT_RELEASE_SUPPLY_LIFT,
} from './balance';
import { activeCompanies, emitEvent, money, ratio, signedMoney, totalHeadcount, unit, usdLabel } from './util';

/* -------------------------------------------------------------------------- */
/*  Appetite                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Investor appetite for rescuing this company, 0..1.
 *
 * The same blend `resolveFundingRounds` prices an ordinary raise with — venture
 * liquidity, risk appetite, the company's standing with investors — because a
 * bridge is financed by the same people. It is compared against a higher floor:
 * a forced bridge is the one round where everybody already knows why it exists.
 */
export function bridgeAppetite(draft: SessionState, company: Company): number {
  return unit(
    0.5 * draft.world.capitalMarkets.ventureLiquidity +
      0.3 * draft.world.capitalMarkets.riskAppetite +
      0.2 * (company.reputation.investor / 100),
  );
}

/** Bridges that failed inside the window that decides insolvency. */
export function recentFailedBridges(draft: SessionState, companyId: string, quarter: number): FundingRound[] {
  return draft.fundingRounds.filter(
    (round) =>
      round.companyId === companyId &&
      round.stage === 'bridge' &&
      round.status === 'failed' &&
      round.closedQuarter > quarter - INSOLVENCY_FAILED_BRIDGES,
  );
}

/* -------------------------------------------------------------------------- */
/*  Chronic distress                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How long this company has been living on rescue capital, in quarters, counting
 * to `quarter`. Zero when it is not in a rescue episode at all.
 *
 * The dates come from the rounds themselves, which carry exactly the two things
 * the phase does to one: `queueBridgeRound` stamps the quarter it opened the
 * round in, and `closeBridge`/`failBridge` restamp it with the quarter it
 * settled. What is measured is the *span* of the current episode rather than a
 * count of the quarters a bridge was signed in, because a bridge is deliberately
 * sized to cover several quarters: a company kept alive continuously signs one
 * every few quarters, so counting signatures would show a run of two and no
 * zombie would ever trip the trigger.
 *
 * One window does both jobs, which is what makes the rule coherent:
 * `CHRONIC_DISTRESS_QUARTERS` without needing rescue capital is long enough to
 * say the company got out, and it ends the episode; `CHRONIC_DISTRESS_QUARTERS`
 * spent inside one is long enough to say it never will.
 *
 * Derived from the rounds rather than counted into a field on the company: there
 * is no per-company counter in `SessionState` to keep in step with the ledger,
 * and a figure reconstructed from the rounds cannot drift away from them.
 */
export function rescueQuartersRunning(draft: SessionState, companyId: string, quarter: number): number {
  const dates: number[] = [];
  for (const round of draft.fundingRounds) {
    if (round.companyId !== companyId || round.stage !== 'bridge' || round.closedQuarter > quarter) continue;
    if (!dates.includes(round.closedQuarter)) dates.push(round.closedQuarter);
  }
  dates.sort((a, b) => b - a);

  const latest = dates[0];
  // Nothing recent enough to be what the company is currently living on.
  if (latest === undefined || quarter - latest >= CHRONIC_DISTRESS_QUARTERS) return 0;

  let earliest = latest;
  for (const date of dates) {
    if (earliest - date >= CHRONIC_DISTRESS_QUARTERS) break;
    earliest = date;
  }
  return quarter - earliest + 1;
}

/**
 * A husk: a company administration has already been through. It keeps its books
 * and can still be bought, but there is nothing left to wind up, so neither
 * trigger may reach it again.
 */
export function isWoundUp(company: Company): boolean {
  return totalHeadcount(company) === 0 && !company.products.some((product) => product.isActive);
}

/**
 * Whether the company is a zombie: rescued quarter after quarter while its
 * revenue never approached its own wage bill.
 *
 * Both halves matter. The run of rescues says the company has not paid for
 * itself in a year and a half; the revenue test says there is no business under
 * the rescues to recover — a company earning less than
 * `CHRONIC_DISTRESS_REVENUE_FLOOR` of its payroll is not trading its way out of
 * anything. A real business having a terrible year clears the second test and is
 * financed rather than wound up.
 *
 * The wage bill also identifies a live company: a husk already in administration
 * has no payroll, so it can never be wound up twice by this route.
 */
export function chronicallyRescued(draft: SessionState, company: Company, quarter: number): boolean {
  const payroll = company.financials.payroll;
  if (payroll <= 0) return false;
  if (company.financials.revenueQuarterly >= payroll * CHRONIC_DISTRESS_REVENUE_FLOOR) return false;
  return rescueQuartersRunning(draft, company.id, quarter) >= CHRONIC_DISTRESS_QUARTERS;
}

/* -------------------------------------------------------------------------- */
/*  Settling a forced bridge                                                   */
/* -------------------------------------------------------------------------- */

interface IssuanceTarget {
  readonly table: CapTable;
  readonly security: Security;
  readonly shareClass: ShareClass;
}

function issuanceTargetFor(draft: SessionState, company: Company): IssuanceTarget | null {
  const table = draft.capTables.find((t) => t.companyId === company.id) ?? null;
  const security = draft.securities.find((s) => s.id === company.primarySecurityId) ?? null;
  if (table === null || security === null) return null;
  const shareClass = table.shareClasses.find((c) => c.id === security.shareClassId) ?? table.shareClasses[0] ?? null;
  return shareClass === null ? null : { table, security, shareClass };
}

/** Shares a forced bridge would have to issue, and whether the class authorises them. */
function issuanceFor(target: IssuanceTarget, amountUsd: number, preMoneyUsd: number): { shares: number; pricePerShare: number; headroom: number } {
  const pricePerShare = target.table.fullyDilutedShares > 0 ? Math.max(1, preMoneyUsd) / target.table.fullyDilutedShares : 1;
  return {
    shares: Math.max(1, Math.round(amountUsd / Math.max(pricePerShare, 1e-6))),
    pricePerShare,
    headroom: Math.max(0, target.shareClass.authorisedShares - target.shareClass.issuedShares),
  };
}

/** Fund the round: cash onto the balance sheet, shares onto the cap table. */
function closeBridge(draft: SessionState, ctx: ResolverContext, company: Company, round: FundingRound, target: IssuanceTarget): void {
  const { table, security, shareClass } = target;
  const preMoney = Math.max(1, round.preMoney);
  const wanted = issuanceFor(target, money(round.amount), preMoney);
  // Nobody may issue past the class authorisation, so a company that has nearly
  // exhausted it is rescued only as far as its remaining shares reach.
  const newShares = Math.min(wanted.shares, wanted.headroom);
  const pricePerShare = wanted.pricePerShare;
  const amount = money(newShares * pricePerShare);
  const holderId = makeId('fund', 'bridge', company.id);

  addShares(table, {
    securityId: security.id,
    holderId,
    holderKind: 'fund',
    shares: newShares,
    costUsd: amount,
    quarter: ctx.quarter,
    lockupUntilQuarter: null,
  });
  setIssued(table, shareClass, shareClass.issuedShares + newShares, ctx.quarter);

  company.financials.cash = money(company.financials.cash + amount);
  company.balanceSheet.assets.cash = money(company.balanceSheet.assets.cash + amount);
  company.balanceSheet.equity = signedMoney(company.balanceSheet.equity + amount);

  round.status = 'closed';
  round.closedQuarter = ctx.quarter;
  round.amount = amount;
  round.pricePerShareUsd = money(pricePerShare);
  round.postMoney = money(preMoney + amount);
  round.dilution = unit(ratio(amount, preMoney + amount));
  round.participantHolderIds = [holderId];

  const eventId = emitEvent(
    draft,
    ctx,
    'funding_round_closed',
    company.id,
    round.id,
    {
      stage: round.stage,
      amountUsd: amount,
      preMoney: money(preMoney),
      postMoney: round.postMoney,
      dilution: round.dilution,
      pricePerShareUsd: round.pricePerShareUsd,
      newShares,
      forced: true,
    },
    'public',
  );
  emitEvent(
    draft,
    ctx,
    'shares_issued',
    company.id,
    security.id,
    { shares: newShares, holderId, shareClassId: shareClass.id, reason: 'forced_bridge', roundId: round.id },
    'public',
  );
  ctx.log({
    phase: 'financial_resolution',
    text: `${company.name}'s forced bridge cleared: ${usdLabel(amount)} at a ${usdLabel(preMoney)} pre-money, selling ${(round.dilution * 100).toFixed(1)}% of the company.`,
    deltaLabel: `-${(round.dilution * 100).toFixed(1)}% holders`,
    refEventIds: [eventId],
    tone: 'warning',
    subjectId: company.id,
  });
}

/** Refuse the round: nobody funded it, and that is a strike against the company. */
function failBridge(draft: SessionState, ctx: ResolverContext, company: Company, round: FundingRound, reason: string): void {
  round.status = 'failed';
  round.closedQuarter = ctx.quarter;
  const strikes = recentFailedBridges(draft, company.id, ctx.quarter).length;

  const eventId = emitEvent(
    draft,
    ctx,
    'funding_round_failed',
    company.id,
    round.id,
    {
      stage: round.stage,
      soughtUsd: money(round.amount),
      preMoney: money(round.preMoney),
      appetite: Math.round(bridgeAppetite(draft, company) * 1000) / 1000,
      reason,
      consecutiveFailures: strikes,
    },
    'public',
  );
  ctx.log({
    phase: 'financial_resolution',
    text: `${company.name}'s forced bridge of ${usdLabel(round.amount)} found no funder (${reason.replace(/_/g, ' ')}); ${strikes} of ${INSOLVENCY_FAILED_BRIDGES} rescues have now failed.`,
    deltaLabel: `${strikes}/${INSOLVENCY_FAILED_BRIDGES}`,
    refEventIds: [eventId],
    tone: 'negative',
    subjectId: company.id,
  });
}

/* -------------------------------------------------------------------------- */
/*  Administration                                                             */
/* -------------------------------------------------------------------------- */

/** Why a company was wound up. Both routes take the same path through the estate. */
export type AdministrationCause = 'failed_rescues' | 'chronic_distress';

/**
 * Wind the company down: products off, people out, compute surrendered, estate
 * realised and creditors paid what there is. Every movement is double entry, so
 * the closing sheet still reconciles.
 *
 * `cause` changes what the row and the report line say and nothing else: a
 * company nobody would rescue and a company everybody kept rescuing are wound up
 * by the same code, through the same estate, onto the same ledger row.
 */
export function enterAdministration(
  draft: SessionState,
  ctx: ResolverContext,
  company: Company,
  cause: AdministrationCause = 'failed_rescues',
): void {
  // Read before the wind-up zeroes them: the row explains why this company died.
  const lastRevenue = company.financials.revenueQuarterly;
  const lastPayroll = company.financials.payroll;
  const rescuedQuarters = rescueQuartersRunning(draft, company.id, ctx.quarter);
  const failedBridges = recentFailedBridges(draft, company.id, ctx.quarter).length;

  /* --- products --------------------------------------------------------- */
  for (const product of company.products) {
    if (!product.isActive) continue;
    const lost = product.activeCustomers;
    product.isActive = false;
    product.activeCustomers = 0;
    product.churnQuarterly = 1;
    product.growthQuarterly = -1;
    emitEvent(
      draft,
      ctx,
      'product_sunset',
      company.id,
      product.id,
      { productId: product.id, reason: 'administration', customersLost: lost, windDownQuarters: 1 },
      'public',
    );
  }

  /* --- people ----------------------------------------------------------- */
  const released = totalHeadcount(company);
  company.employees.engineers = 0;
  company.employees.researchers = 0;
  company.employees.sales = 0;
  company.employees.ops = 0;
  company.employees.execs = 0;
  company.employees.openRoles = 0;
  company.employees.morale = 0;
  for (const character of draft.characters) {
    if (character.companyId === company.id) character.companyId = null;
  }
  company.ceoCharacterId = null;

  // The people do not vanish: they are on the market next quarter, which is
  // what makes a failure somebody else's hiring opportunity.
  const industryHeadcount = draft.companies.reduce((sum, c) => sum + (c.isActive ? totalHeadcount(c) : 0), 0);
  const lift = TALENT_RELEASE_SUPPLY_LIFT * unit(ratio(released, Math.max(1, industryHeadcount)));
  draft.world.talent.engineerSupply = unit(draft.world.talent.engineerSupply + lift);
  draft.world.talent.researcherSupply = unit(draft.world.talent.researcherSupply + lift);

  emitEvent(
    draft,
    ctx,
    'departure',
    company.id,
    null,
    { kind: 'administration', count: released, talentSupplyLift: Math.round(lift * 10_000) / 10_000 },
    'public',
  );

  /* --- programmes and obligations ---------------------------------------- */
  // Everything the company was in the middle of stops, so the husk cannot keep
  // accruing costs it has no way of paying. Instructions queued earlier this
  // quarter are dropped with the rest: a company in administration is not
  // executing anybody's plan.
  draft.pendingActions = draft.pendingActions.filter((action) => action.actorCompanyId !== company.id);
  for (const project of draft.researchProjects) {
    if (project.companyId !== company.id || (project.status !== 'active' && project.status !== 'paused')) continue;
    project.status = 'abandoned';
    project.budgetQuarterly = 0;
    project.talentAllocated = 0;
    project.computeAllocated = 0;
  }
  for (const contract of draft.governmentContracts) {
    if (contract.primeCompanyId !== company.id || contract.status === 'completed' || contract.status === 'terminated') continue;
    contract.status = 'terminated';
    emitEvent(
      draft,
      ctx,
      'contract_terminated',
      company.id,
      contract.id,
      { reason: 'administration', agencyId: contract.agencyId, recognisedToDateUsd: contract.recognisedToDateUsd },
      'public',
    );
  }

  /* --- capacity ---------------------------------------------------------- */
  company.compute.ownedAccelerators = 0;
  company.compute.reservedAccelerators = 0;
  company.compute.reservationExpiryQuarter = null;
  company.compute.cloudSpendQuarterly = 0;
  company.compute.computeUtilisation = 0;

  /* --- the estate -------------------------------------------------------- */
  const sheet = company.balanceSheet;
  // Two movements, and both belong to the shareholders. Realising the estate at
  // a haircut destroys value: goodwill is worth nothing in a wind-up and the
  // rest fetches `ADMINISTRATION_ASSET_RECOVERY` of its carrying value. Paying
  // creditors only what the estate covers releases the remainder, which is a
  // gain. The net of the two is the whole equity movement this function makes,
  // and it is stated on the ledger row below so the quarter's closing equity is
  // explained by the ledger rather than by this function having written it.
  const impairment = money(
    sheet.assets.goodwill + (sheet.assets.ppe + sheet.assets.receivables + sheet.assets.investments) * (1 - ADMINISTRATION_ASSET_RECOVERY),
  );
  // The stakes the company held go into the estate with everything else. The
  // carrying value that leaves the investments line is stated on the row below,
  // because `financial_integrity` otherwise reads a fall in that line as a stake
  // sold at a loss and charges the shareholders for the same money twice.
  const investmentsRealised = sheet.assets.investments;
  const realisable =
    sheet.assets.cash +
    (sheet.assets.ppe + sheet.assets.receivables + sheet.assets.investments) * ADMINISTRATION_ASSET_RECOVERY;
  sheet.assets.ppe = 0;
  sheet.assets.goodwill = 0;
  sheet.assets.investments = 0;
  sheet.assets.receivables = 0;
  sheet.assets.cash = money(realisable);

  // Creditors are paid out of the estate in order — debt, then trade payables,
  // then the deferred obligations — and write off whatever is not covered.
  let remaining = sheet.assets.cash;
  const settle = (owed: number): number => {
    const paid = Math.min(owed, remaining);
    remaining -= paid;
    return paid;
  };
  const debtPaid = settle(sheet.liabilities.debt);
  const payablesPaid = settle(sheet.liabilities.payables);
  const deferredPaid = settle(sheet.liabilities.deferredRevenue);
  const writtenOff = money(
    sheet.liabilities.debt - debtPaid + (sheet.liabilities.payables - payablesPaid) + (sheet.liabilities.deferredRevenue - deferredPaid),
  );
  sheet.liabilities.debt = 0;
  sheet.liabilities.payables = 0;
  sheet.liabilities.deferredRevenue = 0;
  sheet.assets.cash = money(remaining);
  // Every movement above was matched: assets written down against equity,
  // liabilities discharged or written off against equity. The residual is what
  // the shareholders are left with, which is approximately nothing.
  sheet.equity = signedMoney(sheet.assets.cash);

  company.financials = {
    revenueQuarterly: 0,
    cogs: 0,
    payroll: 0,
    marketing: 0,
    rdSpend: 0,
    capex: 0,
    interestExpense: 0,
    cash: sheet.assets.cash,
    debt: 0,
    quarterlyBurn: 0,
    deferredRevenue: 0,
    backlogUsd: 0,
  };
  company.posture = 'survival';
  company.tier = 'background';

  const eventId = emitEvent(
    draft,
    ctx,
    'information_revealed',
    company.id,
    null,
    {
      kind: 'administration',
      cause,
      failedBridges,
      rescuedQuarters,
      lastRevenueUsd: money(lastRevenue),
      lastPayrollUsd: money(lastPayroll),
      staffReleased: released,
      creditorsWrittenOffUsd: writtenOff,
      assetsImpairedUsd: impairment,
      // The carrying value the investments line lost to the estate. Read by
      // `financial_integrity`, which would otherwise count it a second time as a
      // stake sold.
      investmentsRealisedUsd: money(investmentsRealised),
      // The equity flow the wind-up caused, stated from its two causes rather
      // than read back off the sheet: creditors released, less the value the
      // estate lost being realised. `financial_integrity` adds this to the
      // opening equity, so a wind-up whose arithmetic does not match its own
      // account of itself fails the gate instead of committing.
      equityMovementUsd: signedMoney(writtenOff - impairment),
      residualEquityUsd: sheet.equity,
    },
    'public',
  );
  const because =
    cause === 'failed_rescues'
      ? `after ${failedBridges} failed rescues`
      : `after ${rescuedQuarters} quarters financed by rescue capital on ${usdLabel(lastRevenue)} of revenue against a ${usdLabel(lastPayroll)} wage bill`;
  ctx.log({
    phase: 'financial_resolution',
    text: `${company.name} went into administration ${because}: its products are sunset, ${released} people are on the market, and ${usdLabel(writtenOff)} of obligations were written off. What remains can be bought.`,
    deltaLabel: 'administration',
    refEventIds: [eventId],
    tone: 'negative',
    subjectId: company.id,
  });
}

/* -------------------------------------------------------------------------- */
/*  Phase entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Settle every forced bridge left open by an earlier quarter, then wind up the
 * companies that could not be rescued — and the ones that could, over and over,
 * without ever becoming businesses. Called first thing in
 * `financial_resolution`, so the rescue cash is on the balance sheet before this
 * quarter's obligations are settled against it.
 */
export function resolveDistress(draft: SessionState, ctx: ResolverContext): void {
  for (const company of activeCompanies(draft)) {
    const open = draft.fundingRounds
      .filter((r) => r.companyId === company.id && r.stage === 'bridge' && r.status === 'open' && r.closedQuarter < ctx.quarter)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const round of open) {
      const target = issuanceTargetFor(draft, company);
      const appetite = bridgeAppetite(draft, company);
      const impliedDilution = ratio(round.amount, Math.max(1, round.preMoney) + round.amount, 1);

      if (target === null) {
        failBridge(draft, ctx, company, round, 'no_share_class');
      } else if (appetite < BRIDGE_APPETITE_FLOOR) {
        failBridge(draft, ctx, company, round, 'no_clearing_bid');
      } else if (impliedDilution > BRIDGE_MAX_DILUTION) {
        failBridge(draft, ctx, company, round, 'dilution_ceiling');
      } else if (issuanceFor(target, money(round.amount), Math.max(1, round.preMoney)).headroom <= 0) {
        // Rescue after rescue eventually exhausts the class the shares come out
        // of. Nobody may issue past the authorisation, so there is nothing left
        // to sell and the company is one strike closer to being wound up.
        failBridge(draft, ctx, company, round, 'exceeds_authorised_shares');
      } else {
        closeBridge(draft, ctx, company, round, target);
      }
    }

    // A husk has already been through administration: no staff, no live product,
    // nothing left to realise. Its bridges still settle above — that is how its
    // creditors and its cap table stay honest — but it is never wound up twice.
    if (isWoundUp(company)) continue;

    // Both triggers are read for every company, not only for one that had a
    // bridge to settle this quarter: a rescue is sized to last several quarters,
    // so the quarter a company's episode finally runs too long is usually a
    // quarter in which nothing was signed.
    if (recentFailedBridges(draft, company.id, ctx.quarter).length >= INSOLVENCY_FAILED_BRIDGES) {
      enterAdministration(draft, ctx, company, 'failed_rescues');
    } else if (chronicallyRescued(draft, company, ctx.quarter)) {
      // Every rescue cleared and the company is still not a business. Nobody
      // refuses it money, so nothing else in this file would ever stop it.
      enterAdministration(draft, ctx, company, 'chronic_distress');
    }
  }
}

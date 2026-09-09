/**
 * @frontier/simulation — fills.ts
 *
 * What the world is expected to give, for an instruction that asks for more
 * than it holds.
 *
 * From world version 2 the validator refuses only what is malformed or
 * impossible. Everything that is merely *scarce* — engineers on the market,
 * accelerators the fabs can free, shares in a thin float, researchers already
 * on another programme — is realised at resolution: the action runs, takes what
 * exists, and the quarter report says what was asked, what was got and why.
 *
 * That leaves one question two different places need the same answer to. The
 * validator wants it so a preview can say "expect 6 of 40" while the founder is
 * still deciding; the screens want it so a slider is not lying about what a
 * number will buy. `expectedFill` is that single answer. It is pure, reads
 * nothing but the session, draws no RNG, and is deliberately the *only* place
 * an expectation is computed: a second copy would drift, and a preview that
 * drifts from the engine is worse than no preview.
 *
 * An expectation is not a promise. The talent market is a probability the
 * seeded RNG realises; a seller's spare capacity is a fact of the quarter the
 * order clears in, not of the quarter it is written in. `expected` is what the
 * engine would give if nothing moved between now and resolution, which is what
 * a founder can plan against and nothing more.
 */

import type { ActionIntent, Company, SessionState, StaffRole } from '@frontier/contracts';
import { fillRate } from './companies/hiring';
import { resolveCloudSeller, resolveComputeSeller } from './companies/sellers';
import { isMultiSectorWorld } from './economy/sectors';
import {
  MIN_RESERVABLE_UNITS,
  RESERVABLE_SHARE_OF_INSTALLED_BASE,
} from './validator/balance';
import {
  findCapTable,
  findCompany,
  findSecurity,
  floatShares,
  heldShares,
  installedComputeBase,
  researchComputeHeadroom,
  researchersCommitted,
} from './validator/context';

/* -------------------------------------------------------------------------- */
/*  Shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One instruction's ask against what the world is expected to give it.
 *
 * `expected === asked` with a null reason is the ordinary case: nothing about
 * this instruction is predictably short, either because the world can fill it
 * or because the action has no fillable quantity at all.
 */
export interface ExpectedFill {
  /** What the instruction asked for, in `unit`s. */
  readonly asked: number;
  /** What the world is expected to give, in the same units. Never above `asked`. */
  readonly expected: number;
  /** Plural noun for the quantity, for report and interface copy. */
  readonly unit: string;
  /** Why the rest is not expected to arrive, in plain words, or null when it is. */
  readonly reason: string | null;
}

/** No predictable shortfall: the action either fills or has nothing to fill. */
const whole = (asked: number, unit: string): ExpectedFill => ({ asked, expected: asked, unit, reason: null });

const short = (asked: number, expected: number, unit: string, reason: string): ExpectedFill => ({
  asked,
  expected: Math.max(0, Math.min(asked, expected)),
  unit,
  reason,
});

/** True when the fill is worth telling the founder about. */
export function isShortFill(fill: ExpectedFill): boolean {
  return fill.reason !== null && fill.expected < fill.asked;
}

/** The advisory sentence a note or a report line carries. */
export function shortFillLine(fill: ExpectedFill): string {
  return `Asked for ${Math.round(fill.asked)} ${fill.unit}; expect ${Math.round(fill.expected)}. ${fill.reason ?? ''}`.trim();
}

/* -------------------------------------------------------------------------- */
/*  Compute supply                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Accelerator-equivalents the market could free for one new reservation.
 *
 * Lives here rather than in the validator because the validator, the compute
 * phase and the interface all have to agree on it; `validator/rules.ts`
 * re-exports it so its own import surface is unchanged.
 */
export function reservableUnits(draft: SessionState): number {
  const installed = installedComputeBase(draft);
  const supply = draft.world.compute.acceleratorSupply;
  return Math.max(MIN_RESERVABLE_UNITS, Math.round(installed * RESERVABLE_SHARE_OF_INSTALLED_BASE * supply));
}

/* -------------------------------------------------------------------------- */
/*  The one function                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What `intent` is expected to be filled to, for `companyId`, on this session.
 *
 * Pure. Never rejects, never clamps, never mutates: an instruction that names
 * something that does not exist simply has nothing to be short of, and the
 * validator's structural rules are what refuse it.
 */
export function expectedFill(session: SessionState, companyId: string, intent: ActionIntent): ExpectedFill {
  const company = findCompany(session, companyId);
  if (company === null) return whole(0, 'units');
  switch (intent.type) {
    case 'hire':
      return hireFill(session, company, intent.role, intent.compBand, intent.count);
    case 'layoff':
      return layoffFill(company, intent.role, intent.count);
    case 'reserve_compute':
      return reservationFill(session, company, intent.units, intent.providerCompanyId ?? null);
    case 'buy_accelerators':
      return acceleratorFill(session, company, intent.units, intent.sellerCompanyId);
    case 'buy_cloud_capacity':
      return cloudFill(session, company, intent.quarterlySpendUsd, intent.providerCompanyId);
    case 'buy_shares':
      return buyFill(session, company, intent.securityId, intent.shares, intent.targetPct);
    case 'sell_shares':
      return sellFill(session, company, intent.securityId, intent.shares);
    case 'issue_shares':
      return issueFill(session, company, intent.shareClassId, intent.shares);
    case 'start_research_project':
      return researchFill(session, company, intent.researchersAssigned, intent.computeUnits, 0, 0);
    case 'adjust_research_project': {
      const project = session.researchProjects.find((candidate) => candidate.id === intent.projectId) ?? null;
      if (project === null || project.companyId !== company.id) return whole(intent.researchersAssigned, 'researchers');
      return researchFill(session, company, intent.researchersAssigned, intent.computeUnits, project.talentAllocated, project.computeAllocated);
    }
    default:
      return whole(0, 'units');
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-action expectations                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Requisitions against the talent market.
 *
 * Nothing bounds how many roles a company may open — the validator has no gate
 * on `hire` at all beyond "at least one" — so the whole of this is an
 * expectation. `fillRate` is the same function the talent phase draws against,
 * and the phase realises it: the expectation is its mean, and the draw is what
 * actually lands.
 */
function hireFill(
  session: SessionState,
  company: Company,
  role: StaffRole,
  band: Parameters<typeof fillRate>[3],
  count: number,
): ExpectedFill {
  if (count <= 0) return whole(Math.max(0, count), 'roles');
  const rate = fillRate(session, company, role, band);
  const expected = Math.floor(count * rate);
  if (expected >= count) return whole(count, 'roles');
  return short(
    count,
    expected,
    'roles',
    `At ${Math.round(rate * 100)}% fill this quarter the market answers about ${expected} of them; the rest stay open and are worked again next quarter.`,
  );
}

/** A reduction can only cut people who are there. */
function layoffFill(company: Company, role: StaffRole, count: number): ExpectedFill {
  const inRole = company.employees[role];
  if (count <= inRole) return whole(Math.max(0, count), 'roles');
  return short(count, inRole, 'roles', `${company.name} employs ${inRole} in ${role}; that is the whole team.`);
}

/** A reservation takes what the market frees and what one counterparty holds spare. */
function reservationFill(session: SessionState, company: Company, units: number, providerId: string | null): ExpectedFill {
  if (units <= 0) return whole(Math.max(0, units), 'accelerators');
  const market = reservableUnits(session);
  const provider = resolveComputeSeller(session, 'reservation', providerId, company.id, units);
  const cap = provider === null ? market : Math.min(market, provider.sellableUnits);
  if (units <= cap) return whole(units, 'accelerators');
  return short(
    units,
    cap,
    'accelerators',
    provider === null || provider.sellableUnits > market
      ? `At an accelerator supply of ${session.world.compute.acceleratorSupply.toFixed(2)} the market can free ${cap} this quarter.`
      : `${provider.company.name} holds ${cap} beyond its own use.`,
  );
}

/** An order ships what the manufacturer can build this quarter. */
function acceleratorFill(session: SessionState, company: Company, units: number, sellerId: string | null): ExpectedFill {
  if (units <= 0) return whole(Math.max(0, units), 'accelerators');
  const seller = resolveComputeSeller(session, 'accelerators', sellerId, company.id, units);
  if (seller === null) return short(units, 0, 'accelerators', 'No manufacturer is selling accelerators outright this quarter.');
  if (units <= seller.sellableUnits) return whole(units, 'accelerators');
  return short(units, seller.sellableUnits, 'accelerators', `${seller.company.name} can ship ${seller.sellableUnits} this quarter.`);
}

/** Cloud is bought in dollars, so the capacity ceiling arrives as a spend ceiling. */
function cloudFill(session: SessionState, company: Company, spendUsd: number, providerId: string | null): ExpectedFill {
  if (spendUsd <= 0) return whole(Math.max(0, spendUsd), 'dollars a quarter');
  const seller = resolveCloudSeller(session, providerId, company.id, spendUsd);
  if (seller === null) return whole(spendUsd, 'dollars a quarter');
  const ceiling = Math.round(seller.sellableUnits * seller.unitPriceUsd);
  if (spendUsd <= ceiling) return whole(spendUsd, 'dollars a quarter');
  return short(
    spendUsd,
    ceiling,
    'dollars a quarter',
    `${seller.company.name} has ${seller.sellableUnits} units spare, which is everything it holds beyond its own use.`,
  );
}

/** A purchase takes what the float actually holds. */
function buyFill(
  session: SessionState,
  company: Company,
  securityId: string,
  shares: number | null,
  targetPct: number | null,
): ExpectedFill {
  const security = findSecurity(session, securityId);
  if (security === null) return whole(Math.max(0, shares ?? 0), 'shares');
  const table = findCapTable(session, security.companyId);
  const issued = table?.shareClasses.find((c) => c.id === security.shareClassId)?.issuedShares ?? 0;
  const held = heldShares(session, security.id, company.id);
  const wanted = shares !== null ? shares : Math.max(0, Math.ceil((targetPct ?? 0) * issued) - held);
  if (wanted <= 0) return whole(Math.max(0, wanted), 'shares');
  const available = floatShares(session, security.id);
  if (wanted <= available) return whole(wanted, 'shares');
  return short(wanted, available, 'shares', `The free float is ${available} shares; the rest sits with holders who have to be dealt with, not bought from.`);
}

/** A sale can only deliver the position that exists. */
function sellFill(session: SessionState, company: Company, securityId: string, shares: number): ExpectedFill {
  const security = findSecurity(session, securityId);
  if (security === null) return whole(Math.max(0, shares), 'shares');
  const held = heldShares(session, security.id, company.id);
  if (shares <= held) return whole(Math.max(0, shares), 'shares');
  return short(shares, held, 'shares', `${company.name} holds ${held} shares in that security; that is the whole position.`);
}

/** A primary issue draws on the authorisation a share class has left. */
function issueFill(session: SessionState, company: Company, shareClassId: string, shares: number): ExpectedFill {
  const table = findCapTable(session, company.id);
  const shareClass = table?.shareClasses.find((c) => c.id === shareClassId);
  if (shareClass === undefined) return whole(Math.max(0, shares), 'shares');
  const headroom = Math.max(0, shareClass.authorisedShares - shareClass.issuedShares);
  if (shares <= headroom) return whole(Math.max(0, shares), 'shares');
  return short(
    shares,
    headroom,
    'shares',
    `Class ${shareClass.label} has ${headroom} shares of unissued authorisation; issuing more of it is a matter for the board to authorise first.`,
  );
}

/**
 * A programme is resourced with the researchers and accelerators that are free.
 *
 * Two axes, one answer: whichever is shorter in proportion is the one reported,
 * because that is the one that will bind when the programme runs. `heldBack` is
 * what a programme already holds and hands back before free capacity is
 * counted — zero when the programme is being opened rather than re-resourced.
 */
function researchFill(
  session: SessionState,
  company: Company,
  researchers: number,
  computeUnits: number,
  researchersHeld: number,
  computeHeld: number,
): ExpectedFill {
  const freeResearchers = Math.max(0, company.employees.researchers - researchersCommitted(session, company.id) + researchersHeld);
  const freeCompute = Math.max(0, Math.floor(researchComputeHeadroom(session, company)) + computeHeld);
  const researcherShare = researchers <= 0 ? 1 : Math.min(1, freeResearchers / researchers);
  const computeShare = computeUnits <= 0 ? 1 : Math.min(1, freeCompute / computeUnits);
  if (researcherShare >= 1 && computeShare >= 1) return whole(Math.max(0, researchers), 'researchers');
  if (researcherShare <= computeShare) {
    return short(
      researchers,
      freeResearchers,
      'researchers',
      `${freeResearchers} of ${company.employees.researchers} researchers are free; the rest are on other programmes and stay there.`,
    );
  }
  return short(
    computeUnits,
    freeCompute,
    'accelerators',
    `${freeCompute} accelerator-equivalents are free for research; the rest are committed elsewhere.`,
  );
}

/* -------------------------------------------------------------------------- */
/*  World gate                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether availability is realised at resolution rather than refused up front.
 *
 * World version 2 only. World 1 keeps every clamp and refusal it has always
 * had, byte for byte, because a frozen save replays through the same rules.
 */
export function realisesAvailability(session: SessionState): boolean {
  return isMultiSectorWorld(session);
}

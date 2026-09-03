/**
 * @frontier/simulation — companies/hiring.ts
 *
 * The talent phase (`talent_resolution`, phase 8).
 *
 * Fills open roles against the world's talent supply, resolves approaches to
 * other companies' senior people, applies attrition and moves morale and
 * compensation. Nothing here is a coin flip on its own: every draw from the
 * seeded RNG is a realisation of a probability the state already implied.
 *
 * ## Phase contract with `financial_resolution`
 *
 * This phase is the sole author of `company.financials.payroll` for the quarter.
 * It writes the full figure — recurring employment cost, the loaded cost of open
 * requisitions, recruiting fees and severance — for **every** active company, so
 * the financial phase never sees a stale value. The financial phase reads it and
 * settles the cash.
 */

import type { CompBand, Company, ResolverContext, SessionState, StaffRole } from '@frontier/contracts';
import { effectivePolicy } from './archetypes';
import { emitPartialFill } from './partialFill';
import { isMultiSectorWorld } from '../economy/sectors';
import { canReach } from '../validator/context';
import { companyTalentCostFactor } from '../economy/regions';
import {
  ATTRITION_BOUNDS,
  ATTRITION_REALISATION_BAND,
  BASE_ATTRITION,
  COMP_ATTRITION_COEFFICIENT,
  COMP_BAND_FILL_FACTOR,
  COMP_BAND_MULTIPLIER,
  COMP_BAND_RETENTION,
  COMP_EXPECTATION_DRIFT,
  LAYOFF_MORALE_SHOCK,
  LAYOFF_PUBLIC_REPUTATION_SHOCK,
  MARKET_BASE_COMP_USD,
  MORALE_ATTRITION_COEFFICIENT,
  MORALE_BASELINE,
  MORALE_DRIFT,
  OPEN_ROLE_BACKLOG_CAP_SHARE,
  OPEN_ROLE_BACKLOG_FLOOR,
  OPEN_ROLE_EXPIRY_RATE,
  OPEN_ROLE_LOADED_FACTOR,
  POACH_BASE_PROBABILITY,
  POACH_MORALE_SHOCK,
  POACH_PREMIUM_SATURATION,
  POACH_PREMIUM_WEIGHT,
  POACH_PROBABILITY_BOUNDS,
  POACH_PUBLIC_APPROACH_BONUS,
  POACH_RELATIONSHIP_WEIGHT,
  POACH_REPUTATION_WEIGHT,
  POACH_RETENTION_WEIGHT,
  RECRUITING_FEE_FRACTION,
  ROLE_BASE_FILL_RATE,
  ROLE_SUPPLY_SOURCE,
  SCARCITY_ATTRITION_COEFFICIENT,
  SEVERANCE_MORALE_RELIEF,
} from './balance';
import {
  activeCompanies,
  clamp,
  companyActions,
  count,
  emitEvent,
  intentsOfType,
  money,
  pctLabel,
  ratio,
  roleHeadcount,
  score,
  setRoleHeadcount,
  talentReputation,
  totalHeadcount,
  unit,
  usdLabel,
} from './util';

const ROLES: readonly StaffRole[] = ['engineers', 'researchers', 'sales', 'ops', 'execs'] as const;

/** Market compensation for a role this quarter, given the world's salary pressure. */
export function requiredCompUsd(draft: SessionState, role: StaffRole): number {
  return MARKET_BASE_COMP_USD[role] * draft.world.talent.salaryPressure;
}

/** The offer a compensation band represents for a role, in annual dollars. */
export function offerCompUsd(draft: SessionState, role: StaffRole, band: CompBand): number {
  return requiredCompUsd(draft, role) * COMP_BAND_MULTIPLIER[band];
}

/**
 * What a role costs *this company*, where it is.
 *
 * The world's salary pressure sets the trend; the region sets the level, from
 * South Asia at 55 to North America at 130. Exactly `requiredCompUsd` in world
 * version 1, which is why no legacy payroll moves.
 */
export function regionalCompUsd(draft: SessionState, company: Company, role: StaffRole): number {
  return requiredCompUsd(draft, role) * companyTalentCostFactor(draft, company);
}

/** `offerCompUsd`, priced where the company actually hires. */
export function regionalOfferCompUsd(draft: SessionState, company: Company, role: StaffRole, band: CompBand): number {
  return regionalCompUsd(draft, company, role) * COMP_BAND_MULTIPLIER[band];
}

/** Supply of the kind of person a role needs, 0..1. */
function roleSupply(draft: SessionState, role: StaffRole): number {
  const talent = draft.world.talent;
  const source = ROLE_SUPPLY_SOURCE[role];
  if (source === 'engineer') return talent.engineerSupply;
  if (source === 'researcher') return talent.researcherSupply;
  return (talent.engineerSupply + talent.researcherSupply) / 2;
}

/**
 * Share of an open requisition that fills this quarter.
 *
 * `docs/ECONOMY.md` §3: `fillRate = base(role) × supply × repFactor × bandFactor`,
 * with cross-border hiring access as a fourth gate.
 */
export function fillRate(draft: SessionState, company: Company, role: StaffRole, band: CompBand): number {
  const rep = talentReputation(company) / 100;
  const repFactor = 0.55 + 0.9 * rep;
  const access = 0.7 + 0.3 * draft.world.talent.immigrationAccess;
  return unit(ROLE_BASE_FILL_RATE[role] * roleSupply(draft, role) * repFactor * COMP_BAND_FILL_FACTOR[band] * access);
}

/**
 * Probability that an approach to `targetCharacterId` succeeds.
 *
 * Exported because the behaviour it encodes — that money matters, that standing
 * matters, and that a person who already dislikes you is expensive to move — is
 * exactly what the tests pin down.
 */
export function poachProbability(
  draft: SessionState,
  hirer: Company,
  targetCharacterId: string,
  approachingCharacterId: string,
  compPremiumPct: number,
  approach: 'private' | 'public',
): number {
  const target = draft.characters.find((c) => c.id === targetCharacterId);
  const employerId = target === undefined ? null : target.companyId;
  const employer = employerId === null ? undefined : draft.companies.find((c) => c.id === employerId);

  const premiumTerm = unit(compPremiumPct / POACH_PREMIUM_SATURATION) * POACH_PREMIUM_WEIGHT;
  const reputationTerm = (talentReputation(hirer) / 100) * POACH_REPUTATION_WEIGHT;

  const relationship = draft.relationships.find((r) => r.fromId === targetCharacterId && r.toId === approachingCharacterId);
  const relationshipScore =
    relationship === undefined ? 0.35 : unit((0.5 * relationship.trust + 0.5 * relationship.respect - 0.6 * relationship.hostility) / 100 + 0.35);
  const relationshipTerm = relationshipScore * POACH_RELATIONSHIP_WEIGHT;

  const retention = employer === undefined ? 0.4 : employer.employees.morale / 100;
  const retentionTerm = retention * POACH_RETENTION_WEIGHT;

  // A person who is hard to impress is hard to move: status sensitivity makes a
  // private approach less persuasive and a public one more so.
  const status = target === undefined ? 0.5 : target.stableTraits.statusSensitivity / 100;
  const approachTerm = approach === 'public' ? POACH_PUBLIC_APPROACH_BONUS * (0.5 + status) : 0.02 * (1 - status);

  const raw = POACH_BASE_PROBABILITY + premiumTerm + reputationTerm + relationshipTerm + approachTerm - retentionTerm;
  return clamp(raw, POACH_PROBABILITY_BOUNDS.min, POACH_PROBABILITY_BOUNDS.max);
}

/** Blended market compensation for the company's actual role mix. */
function blendedMarketCompUsd(draft: SessionState, company: Company): number {
  const head = totalHeadcount(company);
  if (head === 0) return regionalCompUsd(draft, company, 'engineers');
  let sum = 0;
  for (const role of ROLES) sum += roleHeadcount(company, role) * regionalCompUsd(draft, company, role);
  return sum / head;
}

/** Morale target implied by pay, standing, workload and the controversy cycle. */
function moraleTarget(company: Company, competitiveness: number, controversy: number): number {
  const head = totalHeadcount(company);
  const understaffed = unit(ratio(company.employees.openRoles, head + 1) * 2);
  const overworked = unit(Math.max(0, company.compute.computeUtilisation - 0.85) * 4);
  const workload = unit(0.6 * understaffed + 0.4 * overworked);
  return score(
    MORALE_BASELINE +
      26 * clamp(competitiveness - 1, -1, 1) +
      14 * (company.reputation.public / 100 - 0.5) * 2 -
      22 * workload -
      18 * controversy,
  );
}

/** How much public controversy the company's own work is generating this quarter. */
function controversyLevel(draft: SessionState, company: Company): number {
  let contractControversy = 0;
  let n = 0;
  for (const contract of draft.governmentContracts) {
    if (contract.primeCompanyId !== company.id || contract.status !== 'active') continue;
    contractControversy += contract.publicControversyLevel;
    n += 1;
  }
  const own = n === 0 ? 0 : contractControversy / n;
  return unit(0.55 * draft.world.media.controversyIntensity + 0.45 * own);
}

/**
 * Resolve hiring, layoffs, approaches, attrition, morale and compensation for
 * every active company, then stage the quarter's payroll.
 */
export function resolveHiring(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng;

  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);
    let oneOffPeopleCostUsd = 0;
    let layoffFraction = 0;
    // Requisitions carried in from earlier quarters. This quarter's own hires
    // are resolved against their own fill rate below; what is left standing
    // afterwards is worked separately, so a backlog can shrink as well as grow.
    const carriedOpenRoles = company.employees.openRoles;

    /* --- hires ------------------------------------------------------------ */
    for (const { intent } of intentsOfType(actions, 'hire')) {
      if (intent.count <= 0) continue;
      const rate = fillRate(draft, company, intent.role, intent.compBand);
      const expected = intent.count * rate;
      const whole = Math.floor(expected);
      const remainder = expected - whole;
      const filled = Math.min(intent.count, whole + (rng.next() < remainder ? 1 : 0));
      const unfilled = intent.count - filled;
      const offer = regionalOfferCompUsd(draft, company, intent.role, intent.compBand);

      if (filled > 0) {
        const head = totalHeadcount(company);
        const blendedComp = (head * company.employees.avgComp + filled * offer) / (head + filled);
        company.employees.avgComp = money(blendedComp);
        setRoleHeadcount(company, intent.role, roleHeadcount(company, intent.role) + filled);
      }
      company.employees.openRoles = count(company.employees.openRoles + unfilled);

      // A rich offer resets what everyone already inside expects to be paid.
      if (offer > company.employees.avgComp * 1.1) {
        const pull = (offer / Math.max(1, company.employees.avgComp) - 1) * COMP_EXPECTATION_DRIFT;
        company.employees.avgComp = money(company.employees.avgComp * (1 + clamp(pull, 0, 0.12)));
      }

      const fee = money(filled * offer * RECRUITING_FEE_FRACTION);
      oneOffPeopleCostUsd += fee;

      const eventId = emitEvent(
        draft,
        ctx,
        'hire_completed',
        company.id,
        null,
        {
          role: intent.role,
          requested: intent.count,
          filled,
          unfilled,
          compBand: intent.compBand,
          offerCompUsd: money(offer),
          fillRate: rate,
          recruitingFeeUsd: fee,
        },
        'company',
      );
      ctx.log({
        phase: 'talent_resolution',
        text: `${company.name} filled ${filled} of ${intent.count} ${intent.role} roles at ${intent.compBand.replace(/_/g, ' ')} pay.`,
        deltaLabel: `${filled}/${intent.count}`,
        refEventIds: [eventId],
        tone: filled >= intent.count ? 'positive' : filled === 0 ? 'warning' : 'neutral',
        subjectId: company.id,
      });
    }

    /* --- layoffs ---------------------------------------------------------- */
    for (const { intent } of intentsOfType(actions, 'layoff')) {
      const available = roleHeadcount(company, intent.role);
      const cut = Math.min(intent.count, available);
      if (cut < intent.count) {
        // World 2 only: world 1's validator already clamped `intent.count` to
        // `available`, so `cut` always equals `intent.count` there and this
        // never fires. From world 2 the reduction was accepted whole and the
        // shortfall — a team smaller than the order — is stated here.
        emitPartialFill(draft, ctx, company.id, {
          actionType: 'layoff',
          asked: intent.count,
          got: cut,
          unit: 'roles',
          reason: `${company.name} employs ${available} in ${intent.role}; that is the whole team.`,
          phase: 'talent_resolution',
        });
      }
      if (cut <= 0) continue;
      const headBefore = totalHeadcount(company);
      setRoleHeadcount(company, intent.role, available - cut);

      const severance = money(cut * (company.employees.avgComp / 4) * intent.severanceQuartersOfPay);
      oneOffPeopleCostUsd += severance;

      const fraction = ratio(cut, headBefore);
      layoffFraction += fraction;
      const relief = 1 - SEVERANCE_MORALE_RELIEF * unit(intent.severanceQuartersOfPay / 2);
      company.employees.morale = score(company.employees.morale - LAYOFF_MORALE_SHOCK * fraction * relief);
      company.reputation.public = score(company.reputation.public - LAYOFF_PUBLIC_REPUTATION_SHOCK * fraction * relief);

      const eventId = emitEvent(
        draft,
        ctx,
        'departure',
        company.id,
        null,
        {
          kind: 'layoff',
          role: intent.role,
          count: cut,
          severanceQuartersOfPay: intent.severanceQuartersOfPay,
          severanceUsd: severance,
          moraleAfter: company.employees.morale,
        },
        'public',
      );
      ctx.log({
        phase: 'talent_resolution',
        text: `${company.name} cut ${cut} ${intent.role} roles with ${intent.severanceQuartersOfPay} quarters of severance; morale fell to ${company.employees.morale.toFixed(0)}.`,
        deltaLabel: pctLabel(-fraction),
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: company.id,
      });
    }

    /* --- approaches to other companies' people ---------------------------- */
    for (const { action, intent } of intentsOfType(actions, 'poach_executive')) {
      const target = draft.characters.find((c) => c.id === intent.targetCharacterId);
      if (target === undefined || !target.isActive) continue;
      const fromCompanyId = target.companyId;
      if (fromCompanyId === company.id) continue;

      // World 2 only: the validator no longer refuses a private approach to
      // somebody out of network reach — it is attempted and fails here, on the
      // same `canReach` the validator would have judged it by, rather than
      // never happening. World 1 still refuses it at validation, so this path
      // is never reached there and the reservation always paid for a real shot.
      const reach = intent.approach === 'private' ? canReach(draft, action.actorCharacterId, intent.targetCharacterId) : null;
      const unreachable = reach !== null && !reach.allowed;

      const probability = unreachable
        ? 0
        : poachProbability(draft, company, intent.targetCharacterId, action.actorCharacterId, intent.compPremiumPct, intent.approach);
      const succeeded = unreachable ? false : rng.next() < probability;

      const eventId = emitEvent(
        draft,
        ctx,
        'poach_attempted',
        company.id,
        intent.targetCharacterId,
        {
          approachedByCharacterId: action.actorCharacterId,
          fromCompanyId,
          compPremiumPct: intent.compPremiumPct,
          approach: intent.approach,
          probability,
          succeeded,
          unreachable,
        },
        intent.approach === 'public' ? 'public' : 'company',
      );

      if (unreachable) {
        ctx.log({
          phase: 'talent_resolution',
          text: `${company.name}'s approach to ${target.name} never got through: ${reach?.reason ?? 'no path to them exists.'}`,
          deltaLabel: 'no reach',
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: company.id,
        });
        continue;
      }

      if (succeeded) {
        const previousEmployer = fromCompanyId === null ? undefined : draft.companies.find((c) => c.id === fromCompanyId);
        target.companyId = company.id;
        target.title = `Executive — ${company.name}`;
        setRoleHeadcount(company, 'execs', roleHeadcount(company, 'execs') + 1);
        const newComp = money(company.employees.avgComp * (1 + intent.compPremiumPct));
        oneOffPeopleCostUsd += money(newComp * RECRUITING_FEE_FRACTION);

        if (previousEmployer !== undefined) {
          setRoleHeadcount(previousEmployer, 'execs', Math.max(0, roleHeadcount(previousEmployer, 'execs') - 1));
          previousEmployer.employees.morale = score(previousEmployer.employees.morale - POACH_MORALE_SHOCK);
          if (previousEmployer.ceoCharacterId === target.id) previousEmployer.ceoCharacterId = null;
        }

        const departureId = emitEvent(
          draft,
          ctx,
          'departure',
          fromCompanyId,
          intent.targetCharacterId,
          { kind: 'poached', toCompanyId: company.id, approach: intent.approach },
          intent.approach === 'public' ? 'public' : 'company',
        );
        emitEvent(
          draft,
          ctx,
          'compensation_changed',
          company.id,
          intent.targetCharacterId,
          { annualCompUsd: newComp, premiumPct: intent.compPremiumPct },
          'company',
        );
        ctx.log({
          phase: 'talent_resolution',
          text: `${target.name} left ${previousEmployer?.name ?? 'their post'} for ${company.name} on a ${(intent.compPremiumPct * 100).toFixed(0)}% premium.`,
          deltaLabel: pctLabel(intent.compPremiumPct),
          refEventIds: [eventId, departureId],
          tone: 'positive',
          subjectId: company.id,
        });
      } else {
        ctx.log({
          phase: 'talent_resolution',
          text: `${company.name}'s approach to ${target.name} was declined.`,
          deltaLabel: `${(probability * 100).toFixed(0)}% odds`,
          refEventIds: [eventId],
          tone: 'neutral',
          subjectId: company.id,
        });
      }
    }

    /* --- the standing requisition backlog --------------------------------- */
    // `openRoles` is a real recruiting pipeline, not a tally: every quarter some
    // of it fills, some of it is withdrawn, and what is left is capped against
    // headcount. Without this it only ever rises, and a company pays the morale
    // and payroll cost of requisitions nobody is working for the whole session.
    if (carriedOpenRoles > 0) {
      const policy = effectivePolicy(company.archetype, company.posture);
      const role = policy.hiringPriority[0] ?? 'engineers';
      const rate = fillRate(draft, company, role, policy.compBand);
      const filledFromBacklog = Math.min(carriedOpenRoles, Math.floor(carriedOpenRoles * rate));
      const standing = carriedOpenRoles - filledFromBacklog;
      // At least one requisition lapses whenever any is standing, so a backlog
      // that fills nothing still drains rather than rounding to a permanent one.
      const lapsed = standing <= 0 ? 0 : Math.min(standing, Math.max(1, Math.round(standing * OPEN_ROLE_EXPIRY_RATE)));

      if (filledFromBacklog > 0) {
        const offer = regionalOfferCompUsd(draft, company, role, policy.compBand);
        const head = totalHeadcount(company);
        company.employees.avgComp = money((head * company.employees.avgComp + filledFromBacklog * offer) / (head + filledFromBacklog));
        setRoleHeadcount(company, role, roleHeadcount(company, role) + filledFromBacklog);
        oneOffPeopleCostUsd += money(filledFromBacklog * offer * RECRUITING_FEE_FRACTION);
      }

      company.employees.openRoles = count(company.employees.openRoles - filledFromBacklog - lapsed);
      if (filledFromBacklog > 0 || lapsed > 0) {
        const eventId = emitEvent(
          draft,
          ctx,
          'hire_completed',
          company.id,
          null,
          {
            kind: 'requisition_backlog',
            role,
            carried: carriedOpenRoles,
            filled: filledFromBacklog,
            withdrawn: lapsed,
            fillRate: rate,
            openRolesAfter: company.employees.openRoles,
          },
          'company',
        );
        ctx.log({
          phase: 'talent_resolution',
          text: `${company.name} worked its recruiting backlog: ${filledFromBacklog} of ${carriedOpenRoles} standing ${role} requisitions filled and ${lapsed} were withdrawn, leaving ${company.employees.openRoles} open.`,
          deltaLabel: `-${filledFromBacklog + lapsed} open`,
          refEventIds: [eventId],
          tone: filledFromBacklog > 0 ? 'positive' : 'neutral',
          subjectId: company.id,
        });
      }
    }


    /* --- attrition, morale and compensation ------------------------------- */
    const controversy = controversyLevel(draft, company);
    const marketComp = blendedMarketCompUsd(draft, company);
    const competitiveness = ratio(company.employees.avgComp, marketComp, 1);

    // The stored attrition rate is forward-looking: it is what this quarter's
    // leavers were priced at last quarter. Realise it, then reprice it.
    const realisation = rng.range(ATTRITION_REALISATION_BAND.min, ATTRITION_REALISATION_BAND.max);
    let departures = 0;
    for (const role of ROLES) {
      const head = roleHeadcount(company, role);
      if (head === 0) continue;
      const leavers = Math.min(head, Math.round(head * company.employees.attrition * realisation));
      if (leavers <= 0) continue;
      setRoleHeadcount(company, role, head - leavers);
      departures += leavers;
    }

    // World 1: unconditional and silent, exactly as this cap has always run —
    // touching it would move the frozen world's hash.
    //
    // World 2: a recruiting function that is not player-directed still cannot
    // carry an unbounded pipeline, and the withdrawal is reported rather than
    // silent, because nothing the engine drops goes unstated from world 2. A
    // player who keeps a requisition open is making a decision, not
    // generating noise the engine has to protect itself from — `hire` has no
    // headcount gate at all, and the same freedom holds for the backlog it
    // leaves behind, carried instead in the player's own CashAfter and payroll
    // lines.
    if (!isMultiSectorWorld(draft)) {
      const backlogCap = Math.round(Math.max(OPEN_ROLE_BACKLOG_FLOOR, totalHeadcount(company) * OPEN_ROLE_BACKLOG_CAP_SHARE));
      if (company.employees.openRoles > backlogCap) company.employees.openRoles = count(backlogCap);
    } else if (company.controllerPlayerId === null) {
      const backlogCap = Math.round(Math.max(OPEN_ROLE_BACKLOG_FLOOR, totalHeadcount(company) * OPEN_ROLE_BACKLOG_CAP_SHARE));
      if (company.employees.openRoles > backlogCap) {
        const before = company.employees.openRoles;
        company.employees.openRoles = count(backlogCap);
        emitPartialFill(draft, ctx, company.id, {
          actionType: 'hire',
          asked: before,
          got: backlogCap,
          unit: 'open roles',
          reason: `${company.name}'s recruiting function cannot work a backlog past ${backlogCap} standing requisitions; the rest lapsed.`,
          phase: 'talent_resolution',
        });
      }
    }

    const target = moraleTarget(company, competitiveness, controversy);
    company.employees.morale = score(company.employees.morale + (target - company.employees.morale) * MORALE_DRIFT);

    const preferredBand: CompBand = competitiveness >= 1.15 ? 'above_market' : competitiveness <= 0.9 ? 'below_market' : 'market';
    const nextAttrition = clamp(
      BASE_ATTRITION +
        MORALE_ATTRITION_COEFFICIENT * (1 - company.employees.morale / 100) +
        COMP_ATTRITION_COEFFICIENT * Math.max(0, 1 - competitiveness) +
        SCARCITY_ATTRITION_COEFFICIENT * (1 - draft.world.talent.researcherSupply) +
        0.05 * layoffFraction -
        COMP_BAND_RETENTION[preferredBand],
      ATTRITION_BOUNDS.min,
      ATTRITION_BOUNDS.max,
    );
    company.employees.attrition = nextAttrition;

    // Compensation drifts toward the market rather than snapping to it.
    company.employees.avgComp = money(company.employees.avgComp + (marketComp - company.employees.avgComp) * 0.18);

    if (departures > 0) {
      const eventId = emitEvent(
        draft,
        ctx,
        'departure',
        company.id,
        null,
        {
          kind: 'attrition',
          count: departures,
          realisedRate: company.employees.attrition,
          moraleAfter: company.employees.morale,
          nextAttrition,
        },
        'company',
      );
      ctx.log({
        phase: 'talent_resolution',
        text: `${company.name} lost ${departures} people to attrition; morale ${company.employees.morale.toFixed(0)}, next-quarter attrition ${(nextAttrition * 100).toFixed(1)}%.`,
        deltaLabel: pctLabel(-ratio(departures, Math.max(1, totalHeadcount(company) + departures))),
        refEventIds: [eventId],
        tone: departures > totalHeadcount(company) * 0.08 ? 'warning' : 'neutral',
        subjectId: company.id,
      });
    }

    /* --- stage payroll for the financial phase ---------------------------- */
    const head = totalHeadcount(company);
    const recurring = (head * company.employees.avgComp) / 4;
    const openRoleCost = ((company.employees.openRoles * company.employees.avgComp) / 4) * OPEN_ROLE_LOADED_FACTOR;
    const payroll = money(recurring + openRoleCost + oneOffPeopleCostUsd);
    company.financials.payroll = payroll;

    if (oneOffPeopleCostUsd > 0) {
      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        { kind: 'people_one_off', amountUsd: money(oneOffPeopleCostUsd), payrollUsd: payroll },
        'company',
      );
      ctx.log({
        phase: 'talent_resolution',
        text: `${company.name} booked ${usdLabel(oneOffPeopleCostUsd)} of recruiting fees and severance on top of payroll.`,
        deltaLabel: usdLabel(oneOffPeopleCostUsd),
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }
}

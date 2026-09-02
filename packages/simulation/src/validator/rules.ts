/**
 * @frontier/simulation — validator/rules.ts
 *
 * One rule per action type. All thirty-seven of them, in the order
 * `ACTION_TYPES` declares them.
 *
 * The table is a `Record<ActionType, Rule>`, so the compiler refuses to build
 * this file if the union gains a member and this table does not. An action type
 * can never be silently unvalidated: that is the point of doing it as a table
 * rather than as a switch with a `default`.
 *
 * What a rule may do:
 *
 * - **reject** — the action does not run at all. Reserved for things that are
 *   impossible or illegal, not for things that are merely expensive.
 * - **clamp** — the action runs in the reduced form the company could actually
 *   execute. Preferred wherever a smaller version of the instruction is still
 *   recognisably the instruction: hiring six people instead of ten, reserving
 *   the capacity the market can free rather than the capacity you asked for.
 * - **note** — record an explanation without changing the outcome.
 *
 * What a rule may not do: touch the draft. Validation is read-only over state.
 * Resolution happens later, in the phase that owns the action.
 */

import type {
  ActionIntent,
  ActionType,
  Character,
  Company,
  ProductSegment,
  SessionState,
  StaffRole,
} from '@frontier/contracts';
import { ANTITRUST_EXPOSURE_WEIGHTS, DIVIDEND_MAX_PAYOUT_PCT, TOLL_FLOOR_SHARE } from '@frontier/contracts';
import { maxTollForCompany } from '../economy/prices';
import { lastQuarterNetIncomeUsd } from '../companies/financials';
import {
  COMP_BAND_MULTIPLIER,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  HIRING_CASH_COVER_QUARTERS,
  MARKET_BASE_COMP_USD,
  MAX_IPO_FLOAT_PCT,
  MAX_ROUND_DILUTION_PCT,
  MIN_INTRODUCTION_PURPOSE_CHARS,
  MIN_IPO_FLOAT_PCT,
  MIN_RESERVABLE_UNITS,
  PRICE_MOVE_BAND,
  RESERVABLE_SHARE_OF_INSTALLED_BASE,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
} from './balance';
import {
  BatchBudget,
  Verdict,
  canReach,
  computeCommitted,
  findCapTable,
  findCharacter,
  findCompany,
  findDeal,
  findOpportunity,
  findSecurity,
  floatShares,
  heldShares,
  installedComputeBase,
  lockupUntil,
  researchersCommitted,
  type ValidationActor,
} from './context';

/* -------------------------------------------------------------------------- */
/*  Rule shape                                                                 */
/* -------------------------------------------------------------------------- */

/** Everything a rule may read. Deliberately excludes any means of writing. */
export interface RuleContext {
  readonly draft: SessionState;
  readonly actor: ValidationActor;
  readonly company: Company;
  readonly character: Character | null;
  readonly budget: BatchBudget;
  /** Reservations staged by this action, applied only if it survives validation. */
  readonly reservations: (() => void)[];
}

type IntentOf<K extends ActionType> = Extract<ActionIntent, { type: K }>;
type Rule<K extends ActionType> = (intent: IntentOf<K>, verdict: Verdict<IntentOf<K>>, ctx: RuleContext) => void;
type LooseRule = (intent: ActionIntent, verdict: Verdict<ActionIntent>, ctx: RuleContext) => void;

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const money = (value: number): string => {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2).replace(/\.?0+$/, '')}bn`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2).replace(/\.?0+$/, '')}m`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1).replace(/\.?0+$/, '')}k`;
  return `${sign}$${Math.round(abs)}`;
};

const heldCompute = (company: Company): number => company.compute.ownedAccelerators + company.compute.reservedAccelerators;

/** Quarterly fully loaded cost of one hire in a role at a band. */
export function quarterlyHireCostUsd(draft: SessionState, role: StaffRole, band: keyof typeof COMP_BAND_MULTIPLIER): number {
  const base = MARKET_BASE_COMP_USD[role];
  const pressure = draft.world.talent.salaryPressure;
  return (base * COMP_BAND_MULTIPLIER[band] * pressure) / 4;
}

/** Accelerator-equivalents the market could free for one new reservation. */
export function reservableUnits(draft: SessionState): number {
  const installed = installedComputeBase(draft);
  const supply = draft.world.compute.acceleratorSupply;
  return Math.max(MIN_RESERVABLE_UNITS, Math.round(installed * RESERVABLE_SHARE_OF_INSTALLED_BASE * supply));
}

/**
 * Reserve `amountUsd` against the company's uncommitted cash, clamping the
 * action down to what is left when it asks for more. Returns what was reserved.
 *
 * The reservation is staged rather than applied: an action that is later
 * transformed into a board proposal spends nothing this quarter, so its
 * reservations must be discardable.
 */
function affordable<T extends ActionIntent>(
  ctx: RuleContext,
  verdict: Verdict<T>,
  amountUsd: number,
  label: string,
  apply: (draft: T, allowed: number) => void,
): number {
  const available = ctx.budget.availableCash(ctx.company);
  if (amountUsd <= available) {
    ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, amountUsd));
    return amountUsd;
  }
  if (available <= 0) {
    verdict.reject('insufficient_cash', `${label} needs ${money(amountUsd)} and the company has no uncommitted cash this quarter.`);
    return 0;
  }
  verdict.clamp(
    (draft) => apply(draft, available),
    'insufficient_cash',
    `${label} reduced from ${money(amountUsd)} to ${money(available)}: that is the cash left uncommitted this quarter.`,
  );
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, available));
  return available;
}

/* -------------------------------------------------------------------------- */
/*  Research                                                                   */
/* -------------------------------------------------------------------------- */

const setResearchBudget: Rule<'set_research_budget'> = (intent, verdict, ctx) => {
  affordable(ctx, verdict, intent.budgetUsd, 'The research budget', (draft, allowed) => {
    draft.budgetUsd = allowed;
  });
};

const startResearchProject: Rule<'start_research_project'> = (intent, verdict, ctx) => {
  const node = ctx.draft.techGraph.nodes.find((n) => n.id === intent.targetNodeId);
  if (node === undefined) {
    verdict.reject('unknown_target', `No node "${intent.targetNodeId}" exists on the Frontier Map.`);
    return;
  }
  if (node.status === 'achieved' && node.achievedByCompanyId === ctx.company.id) {
    verdict.reject('requirement_not_met', `${ctx.company.name} has already demonstrated ${node.title}.`);
    return;
  }
  const duplicate = ctx.draft.researchProjects.some(
    (p) => p.companyId === ctx.company.id && p.targetNodeId === intent.targetNodeId && (p.status === 'active' || p.status === 'paused'),
  );
  if (duplicate) {
    verdict.reject('duplicate_action', `A programme against ${node.title} is already running.`);
    return;
  }

  const freeResearchers = Math.max(0, ctx.budget.availableStaff(ctx.company, 'researchers') - researchersCommitted(ctx.draft, ctx.company.id));
  if (intent.researchersAssigned > freeResearchers) {
    if (freeResearchers <= 0) {
      verdict.reject('insufficient_headcount', 'Every researcher is already assigned to another programme.');
      return;
    }
    verdict.clamp(
      (draft) => {
        draft.researchersAssigned = freeResearchers;
      },
      'insufficient_headcount',
      `Researchers reduced from ${intent.researchersAssigned} to ${freeResearchers}: the rest are on other programmes.`,
    );
  }

  const freeCompute = Math.max(0, ctx.budget.availableCompute(ctx.company) - computeCommitted(ctx.draft, ctx.company.id));
  if (intent.computeUnits > freeCompute) {
    verdict.clamp(
      (draft) => {
        draft.computeUnits = Math.max(0, freeCompute);
      },
      'insufficient_compute',
      `Compute reduced from ${intent.computeUnits} to ${Math.max(0, freeCompute)} accelerator-equivalents: the rest is committed elsewhere.`,
    );
  }

  affordable(ctx, verdict, intent.budgetUsd, 'The programme budget', (draft, allowed) => {
    draft.budgetUsd = allowed;
  });

  const assigned = verdict.current.researchersAssigned;
  const compute = verdict.current.computeUnits;
  ctx.reservations.push(() => {
    ctx.budget.commitStaff(ctx.company.id, 'researchers', assigned);
    ctx.budget.commitCompute(ctx.company.id, compute);
  });
};

const proposeInnovation: Rule<'propose_innovation'> = (intent, verdict, ctx) => {
  if (!ctx.draft.config.allowPlayerInnovation) {
    verdict.reject('requirement_not_met', 'Player innovation is disabled in this session.');
    return;
  }
  const known = new Set(ctx.draft.techGraph.nodes.map((node) => node.id));
  const unknown = intent.proposal.dependencies.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    verdict.clamp(
      (draft) => {
        draft.proposal.dependencies = draft.proposal.dependencies.filter((id) => known.has(id));
      },
      'unknown_target',
      `Dropped ${unknown.length} dependency id(s) that are not on the Frontier Map: ${unknown.join(', ')}.`,
    );
  }
  const clash = ctx.draft.techGraph.nodes.find((node) => node.title.toLowerCase() === intent.proposal.title.toLowerCase());
  if (clash !== undefined) {
    verdict.reject('duplicate_action', `"${clash.title}" is already a node on the Frontier Map.`);
  }
};

const publishResearch: Rule<'publish_research'> = (intent, verdict, ctx) => {
  const node = ctx.draft.techGraph.nodes.find((n) => n.id === intent.nodeId);
  if (node === undefined) {
    verdict.reject('unknown_target', `No node "${intent.nodeId}" exists on the Frontier Map.`);
    return;
  }
  const owns =
    node.achievedByCompanyId === ctx.company.id ||
    ctx.draft.researchProjects.some((p) => p.companyId === ctx.company.id && p.targetNodeId === node.id && p.status === 'succeeded');
  if (!owns) {
    verdict.reject('requirement_not_met', `${ctx.company.name} has no result on ${node.title} to publish.`);
  }
};

/* -------------------------------------------------------------------------- */
/*  Product                                                                    */
/* -------------------------------------------------------------------------- */

const setProductPrice: Rule<'set_product_price'> = (intent, verdict, ctx) => {
  const product = ctx.company.products.find((p) => p.id === intent.productId);
  if (product === undefined) {
    verdict.reject('unknown_target', `${ctx.company.name} has no product "${intent.productId}".`);
    return;
  }
  if (!product.isActive) {
    verdict.reject('requirement_not_met', `${product.name} has been sunset and cannot be repriced.`);
    return;
  }

  // A price may move a long way over a year and only so far in one quarter. The
  // band is the range the demand model's elasticity is defined on: outside it
  // customers stop responding and revenue rises with the price for nothing.
  if (product.pricePerSeat <= 0) return;
  const floor = product.pricePerSeat * PRICE_MOVE_BAND.min;
  const ceiling = product.pricePerSeat * PRICE_MOVE_BAND.max;
  if (intent.pricePerSeatUsd >= floor && intent.pricePerSeatUsd <= ceiling) return;

  const bounded = Math.round(Math.min(ceiling, Math.max(floor, intent.pricePerSeatUsd)) * 100) / 100;
  verdict.clamp(
    (draft) => {
      draft.pricePerSeatUsd = bounded;
    },
    'illegal_value',
    `${product.name} repriced to ${money(bounded)} rather than ${money(intent.pricePerSeatUsd)}: a price may move between ${
      PRICE_MOVE_BAND.min
    }x and ${PRICE_MOVE_BAND.max}x of its current ${money(product.pricePerSeat)} in one quarter, and a bigger move than that is a different product.`,
  );
};

const launchProduct: Rule<'launch_product'> = (intent, verdict, ctx) => {
  const clash = ctx.company.products.find((p) => p.name.toLowerCase() === intent.name.trim().toLowerCase() && p.isActive);
  if (clash !== undefined) {
    verdict.reject('duplicate_action', `${ctx.company.name} already sells a product called ${clash.name}.`);
    return;
  }
  affordable(ctx, verdict, intent.launchMarketingUsd, 'Launch marketing', (draft, allowed) => {
    draft.launchMarketingUsd = allowed;
  });
};

const sunsetProduct: Rule<'sunset_product'> = (intent, verdict, ctx) => {
  const product = ctx.company.products.find((p) => p.id === intent.productId);
  if (product === undefined) {
    verdict.reject('unknown_target', `${ctx.company.name} has no product "${intent.productId}".`);
    return;
  }
  if (!product.isActive) verdict.reject('duplicate_action', `${product.name} has already been sunset.`);
};

/* -------------------------------------------------------------------------- */
/*  Marketing                                                                  */
/* -------------------------------------------------------------------------- */

const setMarketingBudget: Rule<'set_marketing_budget'> = (intent, verdict, ctx) => {
  type Allocation = IntentOf<'set_marketing_budget'>['allocations'][number];
  const merged = new Map<ProductSegment, Allocation>();
  let duplicated = false;
  for (const allocation of intent.allocations) {
    const existing = merged.get(allocation.segment);
    if (existing === undefined) {
      merged.set(allocation.segment, { segment: allocation.segment, budgetUsd: Math.max(0, allocation.budgetUsd) });
    } else {
      duplicated = true;
      existing.budgetUsd += Math.max(0, allocation.budgetUsd);
    }
  }
  if (duplicated) {
    const allocations = [...merged.values()];
    verdict.clamp(
      (draft) => {
        draft.allocations = allocations.map((allocation) => ({ ...allocation }));
      },
      'duplicate_action',
      'Merged repeated segments into one allocation each.',
    );
  }

  const total = [...merged.values()].reduce((running, allocation) => running + allocation.budgetUsd, 0);
  const available = ctx.budget.availableCash(ctx.company);
  if (total > available) {
    const scale = available <= 0 ? 0 : available / total;
    verdict.clamp(
      (draft) => {
        for (const allocation of draft.allocations) allocation.budgetUsd = Math.floor(allocation.budgetUsd * scale);
      },
      'insufficient_cash',
      `Marketing scaled to ${Math.round(scale * 100)}% of the request: ${money(available)} is the cash left uncommitted this quarter.`,
    );
    ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, Math.max(0, available)));
    return;
  }
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, total));
};

const marketingCampaign: Rule<'marketing_campaign'> = (intent, verdict, ctx) => {
  const perQuarter = intent.budgetUsd / Math.max(1, intent.quarters);
  affordable(ctx, verdict, perQuarter, "This quarter's share of the campaign", (draft, allowed) => {
    draft.budgetUsd = allowed * Math.max(1, intent.quarters);
  });
};

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

const hire: Rule<'hire'> = (intent, verdict, ctx) => {
  if (intent.count <= 0) {
    verdict.reject('illegal_value', 'A hiring action must open at least one role.');
    return;
  }
  const perHire = quarterlyHireCostUsd(ctx.draft, intent.role, intent.compBand) * HIRING_CASH_COVER_QUARTERS;
  const available = ctx.budget.availableCash(ctx.company);
  const affordableCount = perHire <= 0 ? intent.count : Math.floor(available / perHire);

  if (affordableCount <= 0) {
    verdict.reject(
      'insufficient_cash',
      `A single ${intent.role.replace(/s$/, '')} at ${intent.compBand.replace(/_/g, ' ')} costs ${money(perHire)} a quarter and the company has ${money(available)} uncommitted.`,
    );
    return;
  }
  const count = Math.min(intent.count, affordableCount);
  if (count < intent.count) {
    verdict.clamp(
      (draft) => {
        draft.count = count;
      },
      'insufficient_cash',
      `Requisitions reduced from ${intent.count} to ${count}: that is what ${money(available)} of uncommitted cash funds at this band.`,
    );
  }
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, count * perHire));
};

const layoff: Rule<'layoff'> = (intent, verdict, ctx) => {
  const inRole = ctx.budget.availableStaff(ctx.company, intent.role);
  if (inRole <= 0) {
    verdict.reject('insufficient_headcount', `${ctx.company.name} employs nobody in ${intent.role}.`);
    return;
  }
  let count = intent.count;
  if (count > inRole) {
    count = inRole;
    verdict.clamp(
      (draft) => {
        draft.count = inRole;
      },
      'insufficient_headcount',
      `Reduction capped at ${inRole}: that is the whole ${intent.role} team.`,
    );
  }

  const perHead = quarterlyHireCostUsd(ctx.draft, intent.role, 'market') * intent.severanceQuartersOfPay;
  const available = ctx.budget.availableCash(ctx.company);
  if (perHead > 0 && count * perHead > available) {
    const affordableCount = Math.floor(available / perHead);
    if (affordableCount <= 0) {
      verdict.reject('insufficient_cash', `Severance of ${money(perHead)} a head is unaffordable: ${money(available)} is uncommitted.`);
      return;
    }
    count = Math.min(count, affordableCount);
    verdict.clamp(
      (draft) => {
        draft.count = count;
      },
      'insufficient_cash',
      `Reduction cut to ${count}: severance at ${intent.severanceQuartersOfPay} quarters of pay is what the cash covers.`,
    );
  }
  const finalCount = count;
  ctx.reservations.push(() => {
    ctx.budget.commitStaff(ctx.company.id, intent.role, finalCount);
    ctx.budget.spendCash(ctx.company.id, finalCount * perHead);
  });
};

const poachExecutive: Rule<'poach_executive'> = (intent, verdict, ctx) => {
  const target = findCharacter(ctx.draft, intent.targetCharacterId);
  if (target === null) {
    verdict.reject('unknown_target', `No such person: ${intent.targetCharacterId}.`);
    return;
  }
  if (target.companyId === ctx.company.id) {
    verdict.reject('illegal_value', `${target.name} already works for ${ctx.company.name}.`);
    return;
  }
  if (!target.isActive) {
    verdict.reject('requirement_not_met', `${target.name} has left the industry.`);
    return;
  }
  const reach = canReach(ctx.draft, ctx.actor.characterId, target.id);
  if (!reach.allowed && intent.approach === 'private') {
    verdict.reject('target_not_reachable', `${reach.reason} A public approach would still be possible.`);
    return;
  }

  const base = quarterlyHireCostUsd(ctx.draft, 'execs', 'market');
  const offer = base * (1 + intent.compPremiumPct);
  const available = ctx.budget.availableCash(ctx.company);
  if (offer > available) {
    if (base > available) {
      verdict.reject('insufficient_cash', `A senior offer costs at least ${money(base)} a quarter and ${money(available)} is uncommitted.`);
      return;
    }
    const premium = Math.max(0, available / base - 1);
    verdict.clamp(
      (draft) => {
        draft.compPremiumPct = premium;
      },
      'insufficient_cash',
      `Premium cut from ${Math.round(intent.compPremiumPct * 100)}% to ${Math.round(premium * 100)}%: that is what the uncommitted cash supports.`,
    );
    ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, available));
    return;
  }
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, offer));
};

const appointExecutive: Rule<'appoint_executive'> = (intent, verdict, ctx) => {
  const person = findCharacter(ctx.draft, intent.characterId);
  if (person === null) {
    verdict.reject('unknown_target', `No such person: ${intent.characterId}.`);
    return;
  }
  if (!person.isActive) {
    verdict.reject('requirement_not_met', `${person.name} has left the industry.`);
    return;
  }
  affordable(ctx, verdict, intent.annualCompUsd / 4, 'The first quarter of the package', (draft, allowed) => {
    draft.annualCompUsd = allowed * 4;
  });
};

/* -------------------------------------------------------------------------- */
/*  Compute                                                                    */
/* -------------------------------------------------------------------------- */

const reserveCompute: Rule<'reserve_compute'> = (intent, verdict, ctx) => {
  if (intent.units <= 0) {
    verdict.reject('illegal_value', 'A reservation must be for at least one accelerator-equivalent.');
    return;
  }
  const marketCap = reservableUnits(ctx.draft);
  let units = intent.units;
  if (units > marketCap) {
    units = marketCap;
    verdict.clamp(
      (draft) => {
        draft.units = marketCap;
      },
      'insufficient_compute',
      `Reservation cut from ${intent.units} to ${marketCap} units: at an accelerator supply of ${ctx.draft.world.compute.acceleratorSupply.toFixed(
        2,
      )} that is what the market can free.`,
    );
  }

  const unitCost = RESERVED_UNIT_COST_USD_PER_QUARTER * ctx.draft.world.compute.reservedPrice;
  const available = ctx.budget.availableCash(ctx.company);
  const firstQuarterCost = units * unitCost;
  if (firstQuarterCost > available) {
    const affordableUnits = unitCost <= 0 ? units : Math.floor(available / unitCost);
    if (affordableUnits <= 0) {
      verdict.reject('insufficient_cash', `Reserved capacity costs ${money(unitCost)} per unit per quarter and ${money(available)} is uncommitted.`);
      return;
    }
    units = affordableUnits;
    verdict.clamp(
      (draft) => {
        draft.units = affordableUnits;
      },
      'insufficient_cash',
      `Reservation cut to ${affordableUnits} units: that is what ${money(available)} covers for the first quarter.`,
    );
  }
  const finalUnits = units;
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, finalUnits * unitCost));
};

const buyCloudCapacity: Rule<'buy_cloud_capacity'> = (intent, verdict, ctx) => {
  if (intent.providerCompanyId !== null) {
    const provider = findCompany(ctx.draft, intent.providerCompanyId);
    if (provider === null || !provider.isActive) {
      verdict.clamp(
        (draft) => {
          draft.providerCompanyId = null;
        },
        'unknown_target',
        `No active provider "${intent.providerCompanyId}"; buying at market instead.`,
      );
    }
  }
  affordable(ctx, verdict, intent.quarterlySpendUsd, 'Cloud spend', (draft, allowed) => {
    draft.quarterlySpendUsd = allowed;
  });
};

const allocateCompute: Rule<'allocate_compute'> = (_intent, verdict, ctx) => {
  const held = heldCompute(ctx.company) + Math.round(ctx.company.compute.cloudSpendQuarterly / CLOUD_UNIT_COST_USD_PER_QUARTER);
  if (held <= 0) verdict.reject('insufficient_compute', `${ctx.company.name} holds no capacity to allocate.`);
};

/* -------------------------------------------------------------------------- */
/*  Capital                                                                    */
/* -------------------------------------------------------------------------- */

const raiseRound: Rule<'raise_round'> = (intent, verdict, _ctx) => {
  if (intent.targetAmountUsd <= 0) {
    verdict.reject('illegal_value', 'A raise must seek a positive amount.');
    return;
  }
  if (intent.maxDilutionPct > MAX_ROUND_DILUTION_PCT) {
    verdict.clamp(
      (draft) => {
        draft.maxDilutionPct = MAX_ROUND_DILUTION_PCT;
      },
      'illegal_value',
      `Dilution ceiling cut to ${Math.round(MAX_ROUND_DILUTION_PCT * 100)}%: no single round may sell more of the company than that.`,
    );
  }
};

const issueDebt: Rule<'issue_debt'> = (intent, verdict, ctx) => {
  if (intent.amountUsd <= 0) {
    verdict.reject('illegal_value', 'A debt issue must seek a positive principal.');
    return;
  }
  if (ctx.draft.world.capitalMarkets.debtAvailability <= 0.02) {
    verdict.reject('requirement_not_met', 'Credit markets are shut: no lender is extending to AI companies this quarter.');
  }
};

const buyback: Rule<'buyback'> = (intent, verdict, ctx) => {
  if (ctx.company.primarySecurityId === null) {
    verdict.reject('requirement_not_met', `${ctx.company.name} has no security to repurchase.`);
    return;
  }
  affordable(ctx, verdict, intent.budgetUsd, 'The repurchase budget', (draft, allowed) => {
    draft.budgetUsd = allowed;
  });
};

const issueShares: Rule<'issue_shares'> = (intent, verdict, ctx) => {
  const table = findCapTable(ctx.draft, ctx.company.id);
  const shareClass = table?.shareClasses.find((c) => c.id === intent.shareClassId);
  if (table === null || shareClass === undefined) {
    verdict.reject('unknown_target', `${ctx.company.name} has no share class "${intent.shareClassId}".`);
    return;
  }
  const headroom = Math.max(0, shareClass.authorisedShares - shareClass.issuedShares - ctx.budget.claimedShares(shareClass.id));
  if (headroom <= 0) {
    verdict.reject('exceeds_authorised_shares', `Class ${shareClass.label} has no unissued authorisation left.`);
    return;
  }
  let shares = intent.shares;
  if (shares > headroom) {
    shares = headroom;
    verdict.clamp(
      (draft) => {
        draft.shares = headroom;
      },
      'exceeds_authorised_shares',
      `Issue cut from ${intent.shares} to ${headroom} shares: that is the unissued authorisation in ${shareClass.label}.`,
    );
  }
  const claimed = shares;
  ctx.reservations.push(() => ctx.budget.claimShares(shareClass.id, claimed));
};

const ipo: Rule<'ipo'> = (intent, verdict, ctx) => {
  if (ctx.company.isPublic) {
    verdict.reject('duplicate_action', `${ctx.company.name} is already listed.`);
    return;
  }
  if (intent.floatPct > MAX_IPO_FLOAT_PCT || intent.floatPct < MIN_IPO_FLOAT_PCT) {
    const floatPct = Math.min(MAX_IPO_FLOAT_PCT, Math.max(MIN_IPO_FLOAT_PCT, intent.floatPct));
    verdict.clamp(
      (draft) => {
        draft.floatPct = floatPct;
      },
      'illegal_value',
      `Float adjusted to ${Math.round(floatPct * 100)}%: a listing offers between ${Math.round(MIN_IPO_FLOAT_PCT * 100)}% and ${Math.round(
        MAX_IPO_FLOAT_PCT * 100,
      )}% of the company.`,
    );
  }
};

const setDividendPolicy: Rule<'set_dividend_policy'> = (intent, verdict, ctx) => {
  if (intent.payoutPct > DIVIDEND_MAX_PAYOUT_PCT) {
    verdict.clamp(
      (draft) => {
        draft.payoutPct = DIVIDEND_MAX_PAYOUT_PCT;
      },
      'illegal_value',
      `Payout cut to ${DIVIDEND_MAX_PAYOUT_PCT}%: no board authorises paying out more of a quarter's earnings than that.`,
    );
  }
  // Nothing is reserved. The payout is struck on *last* quarter's net income in
  // the capital phase and capped at half of cash there, so a policy set today
  // cannot overspend cash committed to something else today.
  const basis = Math.max(0, lastQuarterNetIncomeUsd(ctx.company));
  if (basis <= 0 && verdict.current.payoutPct > 0) {
    verdict.note('requirement_not_met', `${ctx.company.name} made no profit last quarter, so the policy stands but pays nothing until it does.`);
  }
};

const setLogisticsToll: Rule<'set_logistics_toll'> = (intent, verdict, ctx) => {
  // A dial, not a right. Below the dominance floor the ceiling is zero, and the
  // instruction is clamped rather than refused: the player's intent survives, and
  // it starts charging the moment their group actually dominates the region.
  const ceiling = maxTollForCompany(ctx.draft, ctx.company, intent.region);
  if (intent.tollPct <= ceiling) return;
  verdict.clamp(
    (draft) => {
      draft.tollPct = ceiling;
    },
    'requirement_not_met',
    ceiling <= 0
      ? `${ctx.company.name}'s group does not dominate freight in ${intent.region.replace(/_/g, ' ')}, so the toll is 0%. Below ${Math.round(
          TOLL_FLOOR_SHARE * 100,
        )}% of a region's logistics revenue nobody pays you anything.`
      : `Toll cut from ${intent.tollPct}% to ${ceiling}%: that is what your group's share of ${intent.region.replace(/_/g, ' ')} freight earns.`,
  );
};

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

const buyShares: Rule<'buy_shares'> = (intent, verdict, ctx) => {
  const security = findSecurity(ctx.draft, intent.securityId);
  if (security === null) {
    verdict.reject('unknown_target', `No security "${intent.securityId}" exists in this session.`);
    return;
  }
  if (security.companyId === ctx.company.id) {
    verdict.reject('illegal_value', 'A company buys its own shares through a buyback, not on the open market.');
    return;
  }
  if (!security.isTradable) {
    verdict.reject('requirement_not_met', 'That security does not trade on the in-world exchange.');
    return;
  }
  if (intent.shares === null && intent.targetPct === null) {
    verdict.reject('illegal_value', 'Specify either a share count or a target percentage.');
    return;
  }
  if (intent.maxPricePerShareUsd <= 0) {
    verdict.reject('illegal_value', 'A purchase needs a positive price limit.');
    return;
  }

  const table = findCapTable(ctx.draft, security.companyId);
  const shareClass = table?.shareClasses.find((c) => c.id === security.shareClassId);
  const issued = shareClass?.issuedShares ?? 0;
  const alreadyHeld = heldShares(ctx.draft, security.id, ctx.company.id);

  let wanted = intent.shares ?? 0;
  if (intent.shares === null && intent.targetPct !== null) {
    wanted = Math.max(0, Math.ceil(intent.targetPct * issued) - alreadyHeld);
    const resolved = wanted;
    verdict.clamp(
      (draft) => {
        draft.shares = resolved;
        draft.targetPct = null;
      },
      'requirement_not_met',
      `Target of ${Math.round((intent.targetPct ?? 0) * 100)}% resolved to ${resolved} shares against ${issued} issued.`,
    );
  } else if (intent.shares !== null && intent.targetPct !== null) {
    verdict.clamp(
      (draft) => {
        draft.targetPct = null;
      },
      'illegal_value',
      'Both a share count and a target percentage were given; the share count is used.',
    );
  }

  if (wanted <= 0) {
    verdict.reject('illegal_value', 'The position already meets or exceeds the requested size.');
    return;
  }

  const available = floatShares(ctx.draft, security.id);
  if (wanted > available) {
    if (available <= 0) {
      verdict.reject('requirement_not_met', 'There is no free float in that security to buy.');
      return;
    }
    wanted = available;
    const limited = available;
    verdict.clamp(
      (draft) => {
        draft.shares = limited;
      },
      'requirement_not_met',
      `Purchase cut to ${limited} shares: that is the whole free float.`,
    );
  }

  const cost = wanted * intent.maxPricePerShareUsd;
  const cash = ctx.budget.availableCash(ctx.company);
  if (cost > cash) {
    const affordableShares = Math.floor(cash / intent.maxPricePerShareUsd);
    if (affordableShares <= 0) {
      verdict.reject('insufficient_cash', `Buying at ${money(intent.maxPricePerShareUsd)} a share needs cash the company has not got.`);
      return;
    }
    wanted = affordableShares;
    verdict.clamp(
      (draft) => {
        draft.shares = affordableShares;
      },
      'insufficient_cash',
      `Purchase cut to ${affordableShares} shares: that is what ${money(cash)} buys at the price limit.`,
    );
  }
  const finalShares = wanted;
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, finalShares * intent.maxPricePerShareUsd));
};

const sellShares: Rule<'sell_shares'> = (intent, verdict, ctx) => {
  const security = findSecurity(ctx.draft, intent.securityId);
  if (security === null) {
    verdict.reject('unknown_target', `No security "${intent.securityId}" exists in this session.`);
    return;
  }
  const held = heldShares(ctx.draft, security.id, ctx.company.id);
  if (held <= 0) {
    verdict.reject('requirement_not_met', `${ctx.company.name} holds no shares in that security.`);
    return;
  }
  const lockup = lockupUntil(ctx.draft, security.id, ctx.company.id);
  if (lockup !== null && lockup > ctx.draft.quarter) {
    verdict.reject('lockup_active', `The position is locked up until quarter ${lockup}.`);
    return;
  }
  if (intent.shares > held) {
    verdict.clamp(
      (draft) => {
        draft.shares = held;
      },
      'requirement_not_met',
      `Sale cut from ${intent.shares} to ${held} shares: that is the whole position.`,
    );
  }
};

const acquireCompany: Rule<'acquire_company'> = (intent, verdict, ctx) => {
  const target = findCompany(ctx.draft, intent.targetCompanyId);
  if (target === null) {
    verdict.reject('unknown_target', `No company "${intent.targetCompanyId}" exists in this session.`);
    return;
  }
  if (target.id === ctx.company.id) {
    verdict.reject('illegal_value', 'A company cannot acquire itself.');
    return;
  }
  if (!target.isActive) {
    verdict.reject('requirement_not_met', `${target.name} has already been absorbed or wound up.`);
    return;
  }
  if (intent.offerValueUsd <= 0) {
    verdict.reject('illegal_value', 'An offer must carry a positive value.');
    return;
  }

  const total = intent.cashPct + intent.stockPct;
  let cashPct = intent.cashPct;
  if (Math.abs(total - 1) > 1e-6) {
    cashPct = total <= 0 ? 1 : intent.cashPct / total;
    const stockPct = total <= 0 ? 0 : intent.stockPct / total;
    verdict.clamp(
      (draft) => {
        draft.cashPct = cashPct;
        draft.stockPct = stockPct;
      },
      'illegal_value',
      `Consideration normalised to ${Math.round(cashPct * 100)}% cash and ${Math.round(stockPct * 100)}% stock.`,
    );
  }

  const cashNeeded = intent.offerValueUsd * cashPct;
  const available = ctx.budget.availableCash(ctx.company);
  if (cashNeeded > available) {
    verdict.reject(
      'insufficient_cash',
      `The cash component is ${money(cashNeeded)} and ${money(available)} is uncommitted. Raise first, or shift consideration into stock.`,
    );
    return;
  }
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, cashNeeded));
};

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

const submitBoardProposal: Rule<'submit_board_proposal'> = (intent, verdict, ctx) => {
  if (ctx.company.boardId === null) {
    verdict.reject('requirement_not_met', `${ctx.company.name} has no board to table a matter to.`);
    return;
  }
  if (intent.targetCompanyId !== null && findCompany(ctx.draft, intent.targetCompanyId) === null) {
    verdict.reject('unknown_target', `No company "${intent.targetCompanyId}" exists in this session.`);
    return;
  }
  if (intent.kind === 'ceo_dismissal' && ctx.actor.characterId !== null && ctx.actor.characterId === ctx.company.ceoCharacterId) {
    verdict.reject('illegal_value', 'A proposal to dismiss the chief executive is not tabled by the chief executive.');
    return;
  }
  const duplicate = ctx.draft.boardProposals.some(
    (p) =>
      p.companyId === ctx.company.id &&
      p.kind === intent.kind &&
      p.title === intent.title &&
      p.quarterProposed === ctx.draft.quarter &&
      (p.status === 'tabled' || p.status === 'draft'),
  );
  if (duplicate) verdict.reject('duplicate_action', `"${intent.title}" is already on this quarter's agenda.`);
};

const lobbyDirector: Rule<'lobby_director'> = (intent, verdict, ctx) => {
  const board = ctx.draft.boards.find((b) => b.id === ctx.company.boardId);
  if (board === undefined) {
    verdict.reject('requirement_not_met', `${ctx.company.name} has no board.`);
    return;
  }
  const director = board.directors.find((d) => d.characterId === intent.directorCharacterId);
  if (director === undefined) {
    verdict.reject('unknown_target', `${intent.directorCharacterId} does not sit on this board.`);
    return;
  }
  const proposal = ctx.draft.boardProposals.find((p) => p.id === intent.proposalId);
  if (proposal === undefined || proposal.companyId !== ctx.company.id) {
    verdict.reject('unknown_target', `No proposal "${intent.proposalId}" is before this board.`);
    return;
  }
  if (proposal.status !== 'tabled' && proposal.status !== 'draft') {
    verdict.reject('requirement_not_met', `"${proposal.title}" has already been decided.`);
    return;
  }
  const reach = canReach(ctx.draft, ctx.actor.characterId, director.characterId);
  if (!reach.allowed) verdict.reject('target_not_reachable', reach.reason);
};

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

const bidGovernment: Rule<'bid_government'> = (intent, verdict, ctx) => {
  if (intent.opportunityId !== intent.bid.opportunityId) {
    verdict.reject(
      'illegal_value',
      `The action names opportunity ${intent.opportunityId} and the bid names ${intent.bid.opportunityId}. A mismatch is refused rather than guessed at.`,
    );
    return;
  }
  const opportunity = findOpportunity(ctx.draft, intent.opportunityId);
  if (opportunity === null) {
    verdict.reject('unknown_target', `No opportunity "${intent.opportunityId}" exists in this session.`);
    return;
  }
  if (opportunity.status !== 'open' || ctx.draft.quarter > opportunity.closeQuarter) {
    verdict.reject('opportunity_closed', `${opportunity.programme} is no longer accepting bids.`);
    return;
  }
  if (opportunity.visibility === 'invited' && !opportunity.invitedCompanyIds.includes(ctx.company.id)) {
    verdict.reject('requirement_not_met', `${opportunity.programme} is an invited competition and ${ctx.company.name} was not invited.`);
    return;
  }
  if (ctx.company.governmentPastPerformance < opportunity.requirements.minimumPastPerformance) {
    verdict.reject(
      'requirement_not_met',
      `${opportunity.programme} requires a past-performance score of ${opportunity.requirements.minimumPastPerformance}; ${ctx.company.name} holds ${Math.round(
        ctx.company.governmentPastPerformance,
      )}.`,
    );
    return;
  }
  const duplicate = ctx.draft.governmentBids.some(
    (bid) => bid.bidderCompanyId === ctx.company.id && bid.opportunityId === opportunity.id && bid.status !== 'withdrawn',
  );
  if (duplicate) {
    verdict.reject('duplicate_action', `${ctx.company.name} has already bid on ${opportunity.programme}.`);
    return;
  }
  if (!ctx.budget.claimOnce(`bid:${ctx.company.id}:${opportunity.id}`)) {
    verdict.reject('duplicate_action', `${ctx.company.name} already submitted a bid for ${opportunity.programme} this quarter.`);
    return;
  }

  const staff = intent.bid.staffCommitment;
  const engineers = ctx.budget.availableStaff(ctx.company, 'engineers');
  const researchers = ctx.budget.availableStaff(ctx.company, 'researchers');
  if (staff.engineers > engineers || staff.researchers > researchers) {
    verdict.clamp(
      (draft) => {
        draft.bid.staffCommitment.engineers = Math.min(staff.engineers, engineers);
        draft.bid.staffCommitment.researchers = Math.min(staff.researchers, researchers);
      },
      'insufficient_headcount',
      `Staff commitment reduced to ${Math.min(staff.engineers, engineers)} engineers and ${Math.min(
        staff.researchers,
        researchers,
      )} researchers: that is who exists to assign.`,
    );
  }

  const freeCompute = ctx.budget.availableCompute(ctx.company);
  if (intent.bid.computeCommitment.acceleratorUnits > freeCompute) {
    verdict.clamp(
      (draft) => {
        draft.bid.computeCommitment.acceleratorUnits = freeCompute;
      },
      'insufficient_compute',
      `Compute commitment reduced to ${freeCompute} accelerator-equivalents: the rest is not held.`,
    );
  }

  const unknownPartners = intent.bid.consortiumMemberIds.filter((id) => findCompany(ctx.draft, id) === null);
  if (unknownPartners.length > 0) {
    verdict.clamp(
      (draft) => {
        draft.bid.consortiumMemberIds = draft.bid.consortiumMemberIds.filter((id) => findCompany(ctx.draft, id) !== null);
      },
      'unknown_target',
      `Dropped ${unknownPartners.length} consortium member(s) that do not exist: ${unknownPartners.join(', ')}.`,
    );
  }
  if (!opportunity.allowsConsortium && verdict.current.bid.consortiumMemberIds.length > 0) {
    verdict.clamp(
      (draft) => {
        draft.bid.consortiumMemberIds = [];
      },
      'requirement_not_met',
      `${opportunity.programme} does not permit joint bids; the consortium was dropped.`,
    );
  }

  const committedCompute = verdict.current.bid.computeCommitment.acceleratorUnits;
  ctx.reservations.push(() => {
    ctx.budget.commitCompute(ctx.company.id, committedCompute);
    ctx.budget.commitStaff(ctx.company.id, 'engineers', verdict.current.bid.staffCommitment.engineers);
    ctx.budget.commitStaff(ctx.company.id, 'researchers', verdict.current.bid.staffCommitment.researchers);
  });
};

const declineOpportunity: Rule<'decline_opportunity'> = (intent, verdict, ctx) => {
  const opportunity = findOpportunity(ctx.draft, intent.opportunityId);
  if (opportunity === null) {
    verdict.reject('unknown_target', `No opportunity "${intent.opportunityId}" exists in this session.`);
    return;
  }
  if (opportunity.status !== 'open') verdict.reject('opportunity_closed', `${opportunity.programme} is no longer open.`);
};

const formConsortium: Rule<'form_consortium'> = (intent, verdict, ctx) => {
  const opportunity = findOpportunity(ctx.draft, intent.opportunityId);
  if (opportunity === null) {
    verdict.reject('unknown_target', `No opportunity "${intent.opportunityId}" exists in this session.`);
    return;
  }
  if (opportunity.status !== 'open' || ctx.draft.quarter > opportunity.closeQuarter) {
    verdict.reject('opportunity_closed', `${opportunity.programme} is no longer open.`);
    return;
  }
  if (!opportunity.allowsConsortium) {
    verdict.reject('requirement_not_met', `${opportunity.programme} must be bid by a single prime contractor.`);
    return;
  }
  const unknown = intent.inviteeCompanyIds.filter((id) => findCompany(ctx.draft, id) === null);
  if (unknown.length === intent.inviteeCompanyIds.length) {
    verdict.reject('unknown_target', `None of the invited companies exist: ${unknown.join(', ')}.`);
    return;
  }
  if (unknown.length > 0) {
    verdict.clamp(
      (draft) => {
        draft.inviteeCompanyIds = draft.inviteeCompanyIds.filter((id) => findCompany(ctx.draft, id) !== null);
      },
      'unknown_target',
      `Dropped ${unknown.length} invitee(s) that do not exist: ${unknown.join(', ')}.`,
    );
  }
  const leadIsParty = intent.leadCompanyId === ctx.company.id || verdict.current.inviteeCompanyIds.includes(intent.leadCompanyId);
  if (!leadIsParty) verdict.reject('illegal_value', 'The prime contractor must be this company or one of the invitees.');
};

const meetRegulator: Rule<'meet_regulator'> = (intent, verdict, ctx) => {
  const regulator = findCharacter(ctx.draft, intent.regulatorCharacterId);
  if (regulator === null) {
    verdict.reject('unknown_target', `No such person: ${intent.regulatorCharacterId}.`);
    return;
  }
  if (regulator.role !== 'regulator' && regulator.role !== 'official') {
    verdict.reject('illegal_value', `${regulator.name} is not a regulator or a public official.`);
    return;
  }
  const reach = canReach(ctx.draft, ctx.actor.characterId, regulator.id);
  if (!reach.allowed) verdict.reject('target_not_reachable', reach.reason);
};

/* -------------------------------------------------------------------------- */
/*  Social                                                                     */
/* -------------------------------------------------------------------------- */

const socialPost: Rule<'social_post'> = (intent, verdict, ctx) => {
  const author = findCharacter(ctx.draft, intent.draft.authorCharacterId);
  if (author === null) {
    verdict.reject('unknown_target', `No such person: ${intent.draft.authorCharacterId}.`);
    return;
  }
  if (author.companyId !== ctx.company.id && author.id !== ctx.actor.characterId) {
    verdict.reject('not_controller_of_company', `${author.name} does not speak for ${ctx.company.name}.`);
    return;
  }
  const account = ctx.draft.socialAccounts.find(
    (a) => a.isActive && a.network === intent.draft.network && (a.ownerCharacterId === author.id || a.ownerCompanyId === ctx.company.id),
  );
  if (account === undefined) {
    verdict.reject('requirement_not_met', `Neither ${author.name} nor ${ctx.company.name} has an account on ${intent.draft.network.replace(/_/g, ' ')}.`);
    return;
  }
  if (intent.draft.targetCompanyId !== null && findCompany(ctx.draft, intent.draft.targetCompanyId) === null) {
    verdict.clamp(
      (draft) => {
        draft.draft.targetCompanyId = null;
      },
      'unknown_target',
      `No company "${intent.draft.targetCompanyId}"; the post was made general.`,
    );
  }
};

const giveGuidance: Rule<'give_guidance'> = (intent, verdict, ctx) => {
  if (!ctx.company.isPublic) {
    verdict.reject('requirement_not_met', `${ctx.company.name} is private and does not give public guidance.`);
    return;
  }
  if (intent.quarter < ctx.draft.quarter) {
    verdict.reject('illegal_value', 'Guidance cannot be given for a quarter that has already resolved.');
    return;
  }
  if (!ctx.budget.claimOnce(`guidance:${ctx.company.id}:${intent.metric}:${intent.quarter}`)) {
    verdict.reject('duplicate_action', `${ctx.company.name} has already guided ${intent.metric.replace(/_/g, ' ')} for that quarter.`);
  }
};

const respondCrisis: Rule<'respond_crisis'> = (intent, verdict, ctx) => {
  const known =
    ctx.draft.activeEvents.some((event) => event.id === intent.crisisEventId) ||
    ctx.draft.mediaStories.some((story) => story.id === intent.crisisEventId) ||
    ctx.draft.disclosures.some((disclosure) => disclosure.id === intent.crisisEventId);
  if (!known) verdict.reject('unknown_target', `Nothing in this session matches "${intent.crisisEventId}" to respond to.`);
};

/* -------------------------------------------------------------------------- */
/*  Deals and people                                                           */
/* -------------------------------------------------------------------------- */

const proposeDeal: Rule<'propose_deal'> = (intent, verdict, ctx) => {
  const { counterpartyId, counterpartyKind } = intent.proposal;
  const exists =
    counterpartyKind === 'company'
      ? findCompany(ctx.draft, counterpartyId) !== null
      : counterpartyKind === 'character'
        ? findCharacter(ctx.draft, counterpartyId) !== null
        : ctx.draft.players.some((player) => player.playerId === counterpartyId);
  if (!exists) {
    verdict.reject('unknown_target', `No ${counterpartyKind} "${counterpartyId}" exists in this session.`);
    return;
  }
  if (counterpartyId === ctx.company.id || counterpartyId === ctx.actor.characterId || counterpartyId === ctx.actor.playerId) {
    verdict.reject('illegal_value', 'A deal needs a counterparty other than yourself.');
    return;
  }
  if (intent.proposal.expiresQuarter < ctx.draft.quarter) {
    verdict.reject('illegal_value', 'The offer expires before the quarter it was made in.');
    return;
  }

  for (const obligation of [...intent.proposal.gives, ...intent.proposal.gets]) {
    switch (obligation.kind) {
      case 'equity_transfer':
        if (findSecurity(ctx.draft, obligation.securityId) === null) {
          verdict.reject('unknown_target', `No security "${obligation.securityId}" exists to transfer.`);
        }
        break;
      case 'investment':
        if (findSecurity(ctx.draft, obligation.securityId) === null) {
          verdict.reject('unknown_target', `No security "${obligation.securityId}" exists to invest in.`);
        }
        break;
      case 'consortium_membership':
        if (findOpportunity(ctx.draft, obligation.opportunityId) === null) {
          verdict.reject('unknown_target', `No opportunity "${obligation.opportunityId}" exists to form a consortium for.`);
        }
        break;
      case 'tech_license':
        if (obligation.techNodeId !== null && !ctx.draft.techGraph.nodes.some((node) => node.id === obligation.techNodeId)) {
          verdict.reject('unknown_target', `No Frontier Map node "${obligation.techNodeId}" exists to license.`);
        }
        break;
      case 'compute_supply':
        if (obligation.units > ctx.budget.availableCompute(ctx.company) && intent.proposal.gives.includes(obligation)) {
          verdict.note(
            'insufficient_compute',
            `The offer promises ${obligation.units} accelerator-equivalents a quarter and ${ctx.company.name} holds ${ctx.budget.availableCompute(
              ctx.company,
            )}. Failing to deliver is a breach.`,
          );
        }
        break;
      case 'price_accord': {
        // Every member has to be a real, active company in the sector the accord
        // names, and the proposer has to be one of them. A mixed-sector accord is
        // not a cartel, it is a misunderstanding.
        const members = obligation.memberCompanyIds.map((id) => findCompany(ctx.draft, id));
        const missing = obligation.memberCompanyIds.filter((id, index) => members[index] === null || members[index]?.isActive !== true);
        if (missing.length > 0) {
          verdict.reject('unknown_target', `An accord cannot bind companies that do not exist or are no longer operating: ${missing.join(', ')}.`);
          break;
        }
        const wrongSector = members.filter((member) => member !== null && (member.sector ?? 'ai') !== obligation.sector).map((member) => member?.id ?? '');
        if (wrongSector.length > 0) {
          verdict.reject('illegal_value', `A price accord covers one sector. These members do not operate in ${obligation.sector}: ${wrongSector.join(', ')}.`);
          break;
        }
        if (!obligation.memberCompanyIds.includes(ctx.company.id)) {
          verdict.reject('illegal_value', `${ctx.company.name} is proposing an accord it is not a member of. Every party to a price accord is bound by it.`);
          break;
        }
        if (!obligation.memberCompanyIds.includes(intent.proposal.counterpartyId)) {
          verdict.reject('illegal_value', 'The counterparty must be a member of the accord it is being asked to sign.');
          break;
        }
        verdict.note(
          'requirement_not_met',
          `Signing this accord adds ${ANTITRUST_EXPOSURE_WEIGHTS.accord} points of antitrust exposure every quarter it is in force, for every member.`,
        );
        break;
      }
      default:
        break;
    }
  }
};

const acceptDeal: Rule<'accept_deal'> = (intent, verdict, ctx) => {
  const deal = findDeal(ctx.draft, intent.dealId);
  if (deal === null) {
    verdict.reject('unknown_target', `No deal "${intent.dealId}" exists in this session.`);
    return;
  }
  const isCounterparty =
    deal.counterpartyId === ctx.company.id || deal.counterpartyId === ctx.actor.characterId || deal.counterpartyId === ctx.actor.playerId;
  if (!isCounterparty) {
    verdict.reject('illegal_value', 'This offer was not made to you.');
    return;
  }
  if (deal.status !== 'proposed') {
    verdict.reject('requirement_not_met', `That deal is ${deal.status} and can no longer be accepted.`);
    return;
  }
  if (deal.expiresQuarter < ctx.draft.quarter) verdict.reject('requirement_not_met', 'The offer lapsed before it was answered.');
};

const rejectDeal: Rule<'reject_deal'> = (intent, verdict, ctx) => {
  const deal = findDeal(ctx.draft, intent.dealId);
  if (deal === null) {
    verdict.reject('unknown_target', `No deal "${intent.dealId}" exists in this session.`);
    return;
  }
  const isCounterparty =
    deal.counterpartyId === ctx.company.id || deal.counterpartyId === ctx.actor.characterId || deal.counterpartyId === ctx.actor.playerId;
  if (!isCounterparty) {
    verdict.reject('illegal_value', 'This offer was not made to you.');
    return;
  }
  if (deal.status !== 'proposed') verdict.reject('requirement_not_met', `That deal is ${deal.status} and can no longer be rejected.`);
};

const requestIntroduction: Rule<'request_introduction'> = (intent, verdict, ctx) => {
  const via = findCharacter(ctx.draft, intent.viaCharacterId);
  const target = findCharacter(ctx.draft, intent.targetCharacterId);
  if (via === null) {
    verdict.reject('unknown_target', `No such person: ${intent.viaCharacterId}.`);
    return;
  }
  if (target === null) {
    verdict.reject('unknown_target', `No such person: ${intent.targetCharacterId}.`);
    return;
  }
  if (via.id === target.id) {
    verdict.reject('illegal_value', 'An introduction needs three people, not two.');
    return;
  }
  if (target.id === ctx.actor.characterId) {
    verdict.reject('illegal_value', 'You do not need an introduction to yourself.');
    return;
  }
  const toVia = canReach(ctx.draft, ctx.actor.characterId, via.id);
  if (!toVia.allowed) {
    verdict.reject('target_not_reachable', `You cannot reach ${via.name} to ask. ${toVia.reason}`);
    return;
  }
  const viaToTarget = canReach(ctx.draft, via.id, target.id);
  if (!viaToTarget.allowed) {
    verdict.reject('target_not_reachable', `${via.name} cannot reach ${target.name} either. ${viaToTarget.reason}`);
    return;
  }
  if (intent.purpose.trim().length < MIN_INTRODUCTION_PURPOSE_CHARS) {
    verdict.reject('requirement_not_met', 'Say what the meeting is for. Vague requests are refused.');
  }
};

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every action type, mapped to its rule. The type of this constant is what
 * makes the validator exhaustive: adding a member to `ActionIntent` without
 * adding a rule here is a compile error.
 */
export const RULES: { readonly [K in ActionType]: Rule<K> } = {
  set_research_budget: setResearchBudget,
  start_research_project: startResearchProject,
  propose_innovation: proposeInnovation,
  publish_research: publishResearch,
  set_product_price: setProductPrice,
  launch_product: launchProduct,
  sunset_product: sunsetProduct,
  set_marketing_budget: setMarketingBudget,
  marketing_campaign: marketingCampaign,
  hire,
  layoff,
  poach_executive: poachExecutive,
  appoint_executive: appointExecutive,
  reserve_compute: reserveCompute,
  buy_cloud_capacity: buyCloudCapacity,
  allocate_compute: allocateCompute,
  raise_round: raiseRound,
  issue_debt: issueDebt,
  buyback,
  issue_shares: issueShares,
  ipo,
  set_dividend_policy: setDividendPolicy,
  set_logistics_toll: setLogisticsToll,
  buy_shares: buyShares,
  sell_shares: sellShares,
  acquire_company: acquireCompany,
  submit_board_proposal: submitBoardProposal,
  lobby_director: lobbyDirector,
  bid_government: bidGovernment,
  decline_opportunity: declineOpportunity,
  form_consortium: formConsortium,
  meet_regulator: meetRegulator,
  social_post: socialPost,
  give_guidance: giveGuidance,
  respond_crisis: respondCrisis,
  propose_deal: proposeDeal,
  accept_deal: acceptDeal,
  reject_deal: rejectDeal,
  request_introduction: requestIntroduction,
};

/**
 * Run the rule for one action.
 *
 * An intent whose `type` is not in the table is **rejected**, never ignored:
 * schema validation should have caught it upstream, and something that reached
 * the engine unvalidated is exactly what must not be allowed to run.
 */
export function applyTypeRules(intent: ActionIntent, verdict: Verdict<ActionIntent>, ctx: RuleContext): void {
  const rule = (RULES as Record<string, LooseRule | undefined>)[intent.type];
  if (rule === undefined) {
    verdict.reject('illegal_value', `"${String(intent.type)}" is not an action this engine knows how to resolve.`);
    return;
  }
  rule(intent, verdict, ctx);
}

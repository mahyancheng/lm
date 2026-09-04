/**
 * @frontier/simulation — validator/rules.ts
 *
 * One rule per action type, in the order `ACTION_TYPES` declares them.
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
import {
  ANTITRUST_EXPOSURE_WEIGHTS,
  DIVIDEND_MAX_PAYOUT_PCT,
  ECONOMIC_NODES_BY_ID,
  TOLL_FLOOR_SHARE,
  canProduce,
  defaultCategoryFor,
  holdsNode,
  resolveCategory,
} from '@frontier/contracts';
import { maxTollForCompany } from '../economy/prices';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { lastQuarterNetIncomeUsd } from '../companies/financials';
import { solvencyCommitmentNote } from '../companies/solvency';
import { resolveCloudSeller, resolveComputeSeller } from '../companies/sellers';
import { categoryOf } from '../companies/categories';
import { dependencySatisfied } from '../research/nodes';
import { unheldRequirements } from '../research/ownership';
import { launchNodeIdFor } from '../companies/products';
import { LICENCE_ROYALTY_BOUNDS, boundedRoyaltyPct, licenceUpfrontUsd, licenceFrom, ownsNodeOutright } from '../graph/licensing';
import { cloudRentUsd, lineNodeIdOf, reservedRentUsd } from '../graph/lines';
import { expectedFill, isShortFill, realisesAvailability, reservableUnits, shortFillLine } from '../fills';
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
  researchComputeHeadroom,
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

// Defined in `../fills` so the validator, the compute phase and the interface
// all read one number; re-exported here because this module is where callers
// have always imported it from.
export { reservableUnits };

/**
 * Record what the world is expected to give, without touching the instruction.
 *
 * The world-2 shape of an availability bound: the action stays `accepted`, the
 * note carries `partial_fill_expected`, and the phase that owns the action
 * fills what it can and writes the shortfall row. One source — `expectedFill` —
 * so the note, the screen's preview and the report cannot disagree.
 */
function noteExpectedFill(ctx: RuleContext, verdict: Verdict<ActionIntent>, intent: ActionIntent): void {
  const fill = expectedFill(ctx.draft, ctx.company.id, intent);
  if (isShortFill(fill)) verdict.note('partial_fill_expected', shortFillLine(fill));
}

/**
 * The research-specific shape of the same note.
 *
 * `expectedFill`'s `researchFill` is deliberately pure over the session alone,
 * so it cannot see what an earlier `start_research_project` in the *same*
 * batch already reserved against `ctx.budget` — a batch of two programmes,
 * both asking for the last of the compute, would otherwise have the second
 * note say the ask fits, because in isolation it would. This reads the
 * batch-aware free counts the rule already computed, so the note the founder
 * sees agrees with what `ctx.budget` actually holds committed by the time it
 * fires — the one thing `expectedFill` cannot promise across a batch.
 */
function noteResearchFill(
  verdict: Verdict<ActionIntent>,
  researchersAsked: number,
  freeResearchers: number,
  computeAsked: number,
  freeCompute: number,
): void {
  if (researchersAsked <= freeResearchers && computeAsked <= freeCompute) return;
  const researchersShort = researchersAsked > freeResearchers;
  const line = researchersShort
    ? `${Math.max(0, freeResearchers)} of ${researchersAsked} researchers are free; the rest are on other programmes.`
    : `${Math.max(0, freeCompute)} of ${computeAsked} accelerator-equivalents are free; the rest are committed elsewhere.`;
  verdict.note('partial_fill_expected', line);
}

/**
 * Whether cash is advisory rather than binding.
 *
 * The owner's rule, from world version 2 on: an instruction is never refused or
 * shrunk for want of cash. The founder is free to overdraw; two quarter-ends
 * below zero and the company is wound up. World 1 keeps the clamps it has always
 * had, byte for byte.
 */
const solvencyWorld = (ctx: RuleContext): boolean => isMultiSectorWorld(ctx.draft);

/**
 * Take the cash and say where it lands.
 *
 * The reservation still happens — the batch budget is how a second action in the
 * same submission sees what the first committed, and how the previews and the
 * ledger know what was promised — but the verdict carries a note, not a
 * rejection and not a clamp. `insufficient_cash` stays on the note as an
 * advisory code so the interface can colour it.
 */
function commitCashWithNote<T extends ActionIntent>(ctx: RuleContext, verdict: Verdict<T>, amountUsd: number): void {
  const from = ctx.budget.uncommittedCash(ctx.company);
  verdict.note('insufficient_cash', solvencyCommitmentNote(from, from - amountUsd, money));
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, amountUsd));
}

/**
 * Reserve `amountUsd` against the company's uncommitted cash, clamping the
 * action down to what is left when it asks for more. Returns what was reserved.
 *
 * The reservation is staged rather than applied: an action that is later
 * transformed into a board proposal spends nothing this quarter, so its
 * reservations must be discardable.
 *
 * From world version 2 nothing is clamped here: the full amount is reserved and
 * the shortfall becomes a note about the solvency clock.
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
  if (solvencyWorld(ctx)) {
    commitCashWithNote(ctx, verdict, amountUsd);
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
  // World 3: ownership is per company, so "already done" is a question about
  // this company, and a programme is refused OUTRIGHT when the company does not
  // hold what the node requires. Structural, so refused rather than clamped —
  // no bigger cheque and no smaller team works around not owning the thing
  // underneath it — and it is refused at the start, which is what closes world
  // 2's money pit: there, a programme blocked on a dependency ran to progress
  // 0.98 and charged its budget for ever with no way out.
  if (isNodeEconomyWorld(ctx.draft)) {
    if (holdsNode(ctx.company, intent.targetNodeId, ctx.draft.quarter)) {
      verdict.reject('requirement_not_met', `${ctx.company.name} can already make ${node.title}.`);
      return;
    }
    const missing = unheldRequirements(ctx.draft, ctx.company, intent.targetNodeId);
    if (missing.length > 0) {
      const names = missing.map((id) => ECONOMIC_NODES_BY_ID[id]?.label ?? id).join(', ');
      verdict.reject(
        'requirement_not_met',
        `${ctx.company.name} cannot work on ${node.title} without ${names}. Research that first, licence it, or buy a company that has it.`,
      );
      return;
    }
  }
  const duplicate = ctx.draft.researchProjects.some(
    (p) => p.companyId === ctx.company.id && p.targetNodeId === intent.targetNodeId && (p.status === 'active' || p.status === 'paused'),
  );
  if (duplicate) {
    verdict.reject('duplicate_action', `A programme against ${node.title} is already running.`);
    return;
  }

  const freeResearchers = Math.max(0, ctx.budget.availableStaff(ctx.company, 'researchers') - researchersCommitted(ctx.draft, ctx.company.id));
  // Headroom is what the company holds (cloud included from world version 2)
  // less running programmes; what earlier actions in this batch already put on
  // new programmes comes off on top of that.
  const freeCompute = Math.max(0, researchComputeHeadroom(ctx.draft, ctx.company) - ctx.budget.committedCompute(ctx.company.id));

  if (solvencyWorld(ctx)) {
    // World 2: a company free of researchers or compute is not malformed —
    // the programme opens on the ask, and `ensureResearchProjects` resources it
    // with whatever is actually free when the quarter resolves, reporting the
    // shortfall as a `partial_fill`. Neither headcount nor compute gates the
    // instruction here.
    noteResearchFill(verdict, intent.researchersAssigned, freeResearchers, intent.computeUnits, freeCompute);
  } else {
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
    if (intent.computeUnits > freeCompute) {
      verdict.clamp(
        (draft) => {
          draft.computeUnits = Math.max(0, freeCompute);
        },
        'insufficient_compute',
        `Compute reduced from ${intent.computeUnits} to ${Math.max(0, freeCompute)} accelerator-equivalents: the rest is committed elsewhere.`,
      );
    }
  }

  affordable(ctx, verdict, intent.budgetUsd, 'The programme budget', (draft, allowed) => {
    draft.budgetUsd = allowed;
  });

  // What is actually reserved against this batch's budget is always the
  // expectation, never the unclamped ask: a second research action in the same
  // batch has to see the researchers and compute this one is really going to
  // take, not the larger number world 2 left on the verdict.
  const assigned = Math.min(verdict.current.researchersAssigned, freeResearchers);
  const compute = Math.min(verdict.current.computeUnits, freeCompute);
  ctx.reservations.push(() => {
    ctx.budget.commitStaff(ctx.company.id, 'researchers', assigned);
    ctx.budget.commitCompute(ctx.company.id, compute);
  });
};

/**
 * Re-resource a running programme.
 *
 * The bounds are the ones a programme starts under, with one difference that
 * matters: the programme hands back what it already holds before free capacity
 * is counted. Without that, raising a programme from four researchers to ten
 * would be measured against a pool the programme's own four had already been
 * taken out of, and every repair would be clamped back to where it started.
 */
const adjustResearchProject: Rule<'adjust_research_project'> = (intent, verdict, ctx) => {
  const project = ctx.draft.researchProjects.find((p) => p.id === intent.projectId);
  if (project === undefined) {
    verdict.reject('unknown_target', `No research programme "${intent.projectId}" exists.`);
    return;
  }
  if (project.companyId !== ctx.company.id) {
    verdict.reject('not_controller_of_company', `That programme belongs to another company, not ${ctx.company.name}.`);
    return;
  }
  if (project.status !== 'active' && project.status !== 'paused') {
    verdict.reject('requirement_not_met', `The programme is ${project.status} and can no longer be re-resourced.`);
    return;
  }
  const freeResearchers = Math.max(
    0,
    ctx.budget.availableStaff(ctx.company, 'researchers') - researchersCommitted(ctx.draft, ctx.company.id) + project.talentAllocated,
  );
  const freeCompute = Math.max(
    0,
    researchComputeHeadroom(ctx.draft, ctx.company) - ctx.budget.committedCompute(ctx.company.id) + project.computeAllocated,
  );

  if (solvencyWorld(ctx)) {
    // World 2: the re-resourcing runs whole; `applyResearchAdjustments` gives
    // the programme what is actually free and reports a `partial_fill` for the
    // rest, exactly as opening a programme does.
    noteResearchFill(verdict, intent.researchersAssigned, freeResearchers, intent.computeUnits, freeCompute);
  } else {
    if (intent.researchersAssigned > freeResearchers) {
      verdict.clamp(
        (draft) => {
          draft.researchersAssigned = freeResearchers;
        },
        'insufficient_headcount',
        `Researchers reduced from ${intent.researchersAssigned} to ${freeResearchers}: the rest are on other programmes.`,
      );
    }
    if (intent.computeUnits > freeCompute) {
      verdict.clamp(
        (draft) => {
          draft.computeUnits = freeCompute;
        },
        'insufficient_compute',
        `Compute reduced from ${intent.computeUnits} to ${freeCompute} accelerator-equivalents: the rest is committed elsewhere.`,
      );
    }
  }

  // Only the increase is a new call on cash: the programme was already going to
  // draw what it draws today.
  const extra = Math.max(0, intent.budgetUsd - project.budgetQuarterly);
  if (extra > 0) {
    affordable(ctx, verdict, extra, 'The increase in programme budget', (draft, allowed) => {
      draft.budgetUsd = project.budgetQuarterly + allowed;
    });
  }

  const assigned = Math.min(verdict.current.researchersAssigned, freeResearchers);
  const compute = Math.min(verdict.current.computeUnits, freeCompute);
  ctx.reservations.push(() => {
    ctx.budget.commitStaff(ctx.company.id, 'researchers', Math.max(0, assigned - project.talentAllocated));
    ctx.budget.commitCompute(ctx.company.id, Math.max(0, compute - project.computeAllocated));
  });
};

/**
 * Close a programme for good.
 *
 * Structural only: it must be this company's, and it must still be open.
 * Nothing is clamped — abandoning is a decision, and a decision the engine
 * either carries out or refuses.
 */
const abandonResearchProject: Rule<'abandon_research_project'> = (intent, verdict, ctx) => {
  const project = ctx.draft.researchProjects.find((p) => p.id === intent.projectId);
  if (project === undefined) {
    verdict.reject('unknown_target', `No research programme "${intent.projectId}" exists.`);
    return;
  }
  if (project.companyId !== ctx.company.id) {
    verdict.reject('not_controller_of_company', `That programme belongs to another company, not ${ctx.company.name}.`);
    return;
  }
  if (project.status !== 'active' && project.status !== 'paused') {
    verdict.reject('duplicate_action', `That programme is already ${project.status}.`);
  }
};

/**
 * Change how hard this company collects from its own customers.
 *
 * Nothing to bound: the three positions are the schema, and every one of them
 * is legal. Setting the level you are already on is refused as a duplicate
 * rather than burning a decision on nothing.
 */
const setDataPolicy: Rule<'set_data_policy'> = (intent, verdict, ctx) => {
  if (!isNodeEconomyWorld(ctx.draft)) {
    verdict.reject('requirement_not_met', 'Customer data is only collected in the node economy.');
    return;
  }
  if ((ctx.company.dataPolicy ?? 'standard') === intent.collectionLevel) {
    verdict.reject('duplicate_action', `${ctx.company.name} already collects at the ${intent.collectionLevel} level.`);
  }
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
  if (intent.pricePerSeatUsd < 0) {
    verdict.reject('illegal_value', 'A price cannot be negative.');
    return;
  }

  // World 1: a price may move a long way over a year and only so far in one
  // quarter, and the band is enforced here because it is where the frozen
  // world always enforced it.
  //
  // World 2: "a price cut is a price cut" — a founder may reprice to anything,
  // including zero. There is no band to clamp to. The consequence is realised
  // in the demand model instead: `priceSaturationDecay` and the unbounded
  // `priceMoveShock` in `companies/products.ts` make a move big enough to
  // leave the model's defined range cost the base its customers over a few
  // quarters, rather than being refused or reduced here.
  if (isMultiSectorWorld(ctx.draft)) return;

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

  // World 2: a launch resolves to a real catalogue category — the company's
  // own choice, or the deterministic sector/segment default when it left the
  // choice to the engine — and that category's requiresNodeIds is a structural
  // gate: not something a bigger cheque or a smaller launch works around, so
  // it is refused rather than clamped, exactly as stage 1's table refuses only
  // the impossible. World 1 has no catalogue, so nothing here ever runs for it.
  // World 3: a launch names a NODE, and the only question asked is whether this
  // company may produce it — `canProduce`, which is about the company alone.
  // The world-2 branch below is never reached, so `dependencySatisfied`'s global
  // test, which locked nearly every line for everybody on turn one, is not on
  // any world-3 path.
  if (isNodeEconomyWorld(ctx.draft)) {
    const requested = intent.categoryId;
    if (requested !== null && ECONOMIC_NODES_BY_ID[requested] !== undefined && !canProduce(ctx.company, requested, ctx.draft.quarter)) {
      const node = ECONOMIC_NODES_BY_ID[requested];
      const missing = [requested, ...(node?.requires ?? [])].filter((id) => !holdsNode(ctx.company, id, ctx.draft.quarter));
      const names = missing.map((id) => ECONOMIC_NODES_BY_ID[id]?.label ?? id).join(', ');
      verdict.reject(
        'requirement_not_met',
        `${ctx.company.name} cannot make ${node?.label ?? requested}: it does not own ${names}. Research it, licence it, or buy a company that has it.`,
      );
      return;
    }
    const resolved = launchNodeIdFor(ctx.company, requested, intent.segment);
    if (resolved === null) {
      verdict.reject('requirement_not_met', `${ctx.company.name} owns nothing it could put on sale.`);
      return;
    }
    if (requested !== resolved) {
      verdict.clamp(
        (draft) => {
          draft.categoryId = resolved;
        },
        'unknown_target',
        `Launching ${ECONOMIC_NODES_BY_ID[resolved]?.label ?? resolved}, the highest thing ${ctx.company.name} can make for this segment.`,
      );
    }
    // Suppliers named at launch must name an input this node actually consumes;
    // an entry that does not is dropped rather than failing the whole launch.
    const node = ECONOMIC_NODES_BY_ID[resolved];
    const kept = intent.supply.filter((entry) => node?.consumes.some((input) => input.nodeId === entry.inputCategoryId) === true);
    if (kept.length !== intent.supply.length) {
      verdict.clamp(
        (draft) => {
          draft.supply = kept;
        },
        'unknown_target',
        `${intent.supply.length - kept.length} supplier choice${intent.supply.length - kept.length === 1 ? '' : 's'} named an input ${
          node?.label ?? resolved
        } does not use, and ${intent.supply.length - kept.length === 1 ? 'was' : 'were'} dropped.`,
      );
    }
    return;
  }

  if (isMultiSectorWorld(ctx.draft)) {
    const category = resolveCategory(intent.categoryId, ctx.company.sector, intent.segment);
    const missing = category.requiresNodeIds.filter((nodeId) => !dependencySatisfied(ctx.draft, nodeId, ctx.company.id));
    if (missing.length > 0) {
      const titles = missing
        .map((nodeId) => ctx.draft.techGraph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId)
        .join(', ');
      verdict.reject(
        'requirement_not_met',
        `${ctx.company.name} cannot launch into ${category.label} without ${titles}: achieve it, or have public access to it, first.`,
      );
      return;
    }
    if (intent.categoryId === null) {
      verdict.clamp(
        (draft) => {
          draft.categoryId = category.id;
        },
        'unknown_target',
        `No category chosen; launching into ${category.label}, the default line for ${ctx.company.name}'s sector and this segment.`,
      );
    } else if (intent.categoryId !== category.id) {
      // Named an id the catalogue does not have: resolved to the same default
      // a null would have picked, and said so.
      verdict.clamp(
        (draft) => {
          draft.categoryId = category.id;
        },
        'unknown_target',
        `"${intent.categoryId}" is not a product category; launching into ${category.label} instead.`,
      );
    }

    // Suppliers named at launch: structural checks only, the same ones
    // choose_supplier runs — an input the category does not declare, a
    // supplier that does not exist or is closed to this buyer, or the launch
    // naming itself. An invalid entry is dropped rather than failing the
    // whole launch; a founder who got one supplier wrong should not lose the
    // product over it.
    const validSupply = intent.supply.filter((entry) => {
      const input = category.inputs.find((candidate) => candidate.categoryId === entry.inputCategoryId);
      if (input === undefined) return false;
      if (entry.supplierCompanyId === null) return true;
      const supplierCompany = ctx.draft.companies.find((candidate) => candidate.id === entry.supplierCompanyId);
      if (supplierCompany === undefined || !supplierCompany.isActive) return false;
      const supplierProduct = supplierCompany.products.find((candidate) => candidate.id === entry.supplierProductId && candidate.isActive);
      if (supplierProduct === undefined) return false;
      const supplierCategory = categoryOf(supplierCompany, supplierProduct);
      if (supplierCategory.id !== entry.inputCategoryId || !supplierCategory.canSupply) return false;
      const terms = supplierProduct.supplyTerms ?? null;
      if (terms === null || terms.blockedCustomerIds.includes(ctx.company.id)) return false;
      if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(ctx.company.id)) return false;
      return true;
    });
    if (validSupply.length !== intent.supply.length) {
      verdict.clamp(
        (draft) => {
          draft.supply = validSupply;
        },
        'unknown_target',
        `${intent.supply.length - validSupply.length} named supplier(s) could not be resolved and were dropped; the rest of the launch went ahead.`,
      );
    }
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
  if (total > available && solvencyWorld(ctx)) {
    commitCashWithNote(ctx, verdict, total);
    return;
  }
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

  if (affordableCount < intent.count && solvencyWorld(ctx)) {
    // The requisition opens in full; the wage bill is the founder's problem and
    // the solvency clock is where it becomes one.
    commitCashWithNote(ctx, verdict, intent.count * perHire);
    return;
  }
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

  if (!solvencyWorld(ctx)) {
    // World 1: refuse and clamp exactly as this rule always has, byte for byte.
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
    return;
  }

  // World 2: nobody employed in the role, or fewer than asked, is availability
  // — not malformed — so the instruction is accepted whole. `hiring.ts` cuts
  // whoever is actually there and reports the shortfall as a `partial_fill`
  // row; headcount is never the gate here, only cash still notes the solvency
  // clock, and only for the cut the world is expected to actually make.
  noteExpectedFill(ctx, verdict, intent);
  const expected = Math.min(Math.max(0, intent.count), inRole);
  const perHead = quarterlyHireCostUsd(ctx.draft, intent.role, 'market') * intent.severanceQuartersOfPay;
  const available = ctx.budget.availableCash(ctx.company);
  if (perHead > 0 && expected * perHead > available) {
    commitCashWithNote(ctx, verdict, expected * perHead);
  } else {
    ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, expected * perHead));
  }
  ctx.reservations.push(() => ctx.budget.commitStaff(ctx.company.id, intent.role, expected));
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
    // World 2: reach is availability, not permission — the approach is made
    // and fails at resolution, on the same check, with its own report line and
    // the cash it cost. World 1 still refuses it here.
    if (solvencyWorld(ctx)) {
      verdict.note('target_not_reachable', `${reach.reason} The approach will be attempted anyway and is expected to fail; a public approach would still reach.`);
    } else {
      verdict.reject('target_not_reachable', `${reach.reason} A public approach would still be possible.`);
      return;
    }
  }

  const base = quarterlyHireCostUsd(ctx.draft, 'execs', 'market');
  const offer = base * (1 + intent.compPremiumPct);
  const available = ctx.budget.availableCash(ctx.company);
  if (offer > available && solvencyWorld(ctx)) {
    commitCashWithNote(ctx, verdict, offer);
    return;
  }
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
  // Whose capacity. Null resolves to the cheapest infrastructure company with
  // room; a named provider that is not selling falls through to the same one,
  // and the clamp says so rather than quietly changing counterparty. Always null
  // in world version 1, which reserves from the index.
  const named = intent.providerCompanyId ?? null;
  const provider = resolveComputeSeller(ctx.draft, 'reservation', named, ctx.company.id, intent.units);
  // A substitution the founder did not ask for is a clamp: they named somebody
  // and are getting somebody else. Leaving the choice open is not — the market
  // resolves it the same way at resolution, and a clamp for that would mark
  // every ordinary reservation as reduced.
  if (provider !== null && named !== null && provider.company.id !== named) {
    verdict.clamp(
      (draft) => {
        draft.providerCompanyId = provider.company.id;
      },
      'unknown_target',
      `${named} has no capacity to reserve; reserving from ${provider.company.name} at ${money(provider.unitPriceUsd)} per unit per quarter instead.`,
    );
  }

  // Two ceilings, and the tighter one binds: what the market as a whole could
  // free, and what this one counterparty is holding spare.
  const marketCap = provider === null ? reservableUnits(ctx.draft) : Math.min(reservableUnits(ctx.draft), provider.sellableUnits);
  let units = intent.units;
  const expected = Math.min(units, marketCap);
  if (units > marketCap) {
    if (solvencyWorld(ctx)) {
      // World 2: the market's capacity is availability, not a limit on what may
      // be asked for. The reservation is accepted whole; `resolveComputeOrders`
      // reserves what the market actually frees this quarter and reports the
      // rest as a `partial_fill` row. The note here is the same expectation,
      // computed once by `expectedFill` and read by the screen's preview too.
      noteExpectedFill(ctx, verdict, intent);
    } else {
      units = marketCap;
      verdict.clamp(
        (draft) => {
          draft.units = marketCap;
        },
        'insufficient_compute',
        provider === null || provider.sellableUnits > reservableUnits(ctx.draft)
          ? `Reservation cut from ${intent.units} to ${marketCap} units: at an accelerator supply of ${ctx.draft.world.compute.acceleratorSupply.toFixed(
              2,
            )} that is what the market can free.`
          : `Reservation cut from ${intent.units} to ${marketCap} units: that is what ${provider.company.name} holds beyond its own use.`,
      );
    }
  }

  const unitCost = provider === null ? reservedRentUsd(ctx.draft) : provider.unitPriceUsd;
  const available = ctx.budget.availableCash(ctx.company);
  // The cash reserved tracks what the market is expected to actually fill, not
  // the whole ask: billing at resolution is struck on the units that clear, and
  // reserving cash against units that will not clear would starve some other
  // action in the same batch of a balance it could really have used.
  const firstQuarterCost = expected * unitCost;
  if (firstQuarterCost > available && solvencyWorld(ctx)) {
    // Supply still binds — the note above stands — but the price does not.
    commitCashWithNote(ctx, verdict, firstQuarterCost);
    return;
  }
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
  // World 2 leaves `units` (the verdict) at the full ask when supply was the
  // only thing short — only cash clamps it — so the cash actually reserved has
  // to be struck on `expected`, the same figure the note and the resolver's
  // own cap agree on, not on the unclamped ask.
  const finalUnits = solvencyWorld(ctx) ? Math.min(units, expected) : units;
  ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, finalUnits * unitCost));
};

const buyCloudCapacity: Rule<'buy_cloud_capacity'> = (intent, verdict, ctx) => {
  const seller = resolveCloudSeller(ctx.draft, intent.providerCompanyId, ctx.company.id, intent.quarterlySpendUsd);
  if (seller === null) {
    // World 1, or a world with nobody left renting: the old behaviour, which is
    // to fall back to the index rather than to refuse.
    if (intent.providerCompanyId !== null) {
      const named = findCompany(ctx.draft, intent.providerCompanyId);
      if (named === null || !named.isActive) {
        verdict.clamp(
          (draft) => {
            draft.providerCompanyId = null;
          },
          'unknown_target',
          `No active provider "${intent.providerCompanyId}"; buying at market instead.`,
        );
      }
    }
  } else {
    if (intent.providerCompanyId !== null && intent.providerCompanyId !== seller.company.id) {
      verdict.clamp(
        (draft) => {
          draft.providerCompanyId = seller.company.id;
        },
        'unknown_target',
        `${intent.providerCompanyId} has no capacity to sell; buying from ${seller.company.name} at ${money(seller.unitPriceUsd)} per unit per quarter instead.`,
      );
    }
    // A provider can only sell what it is not using itself, and cloud is bought
    // in dollars, so the capacity ceiling arrives as a spending ceiling.
    const ceiling = Math.round(seller.sellableUnits * seller.unitPriceUsd);
    if (intent.quarterlySpendUsd > ceiling) {
      verdict.clamp(
        (draft) => {
          draft.quarterlySpendUsd = ceiling;
        },
        'insufficient_compute',
        `Cloud spend cut from ${money(intent.quarterlySpendUsd)} to ${money(ceiling)} a quarter: that buys ${seller.sellableUnits} units, which is everything ${seller.company.name} holds beyond its own use.`,
      );
    }
  }
  affordable(ctx, verdict, verdict.current.quarterlySpendUsd, 'Cloud spend', (draft, allowed) => {
    draft.quarterlySpendUsd = allowed;
  });
};

/**
 * Buy accelerators outright.
 *
 * World version 2 only: world 1 has no manufacturers to buy from, and inventing
 * a seller for it would move the frozen world. Everything else is the ordinary
 * shape — reject what is impossible, clamp to what the seller can actually ship,
 * and *note* the cash rather than refusing it, because from world 2 an
 * instruction is never refused for want of money.
 *
 * The price limit is deliberately not checked here. What a seller is asking is
 * a fact of the quarter the order clears in, not of the quarter it is written
 * in, so an order above the limit fails at resolution and says so, exactly as a
 * reservation does.
 */
const buyAccelerators: Rule<'buy_accelerators'> = (intent, verdict, ctx) => {
  if (!solvencyWorld(ctx)) {
    verdict.reject('requirement_not_met', 'Buying accelerators outright is not available in this world.');
    return;
  }
  if (intent.units <= 0) {
    verdict.reject('illegal_value', 'An order must be for at least one accelerator.');
    return;
  }
  const seller = resolveComputeSeller(ctx.draft, 'accelerators', intent.sellerCompanyId, ctx.company.id, intent.units);
  if (seller === null) {
    verdict.reject('unknown_target', 'No manufacturer has accelerators to sell this quarter.');
    return;
  }
  if (intent.sellerCompanyId !== null && seller.company.id !== intent.sellerCompanyId) {
    verdict.clamp(
      (draft) => {
        draft.sellerCompanyId = seller.company.id;
      },
      'unknown_target',
      `${intent.sellerCompanyId} is not selling accelerators this quarter; the order goes to ${seller.company.name} at ${money(seller.unitPriceUsd)} a unit.`,
    );
  }

  // This action exists in world 2 only (rejected above in world 1), so there is
  // no frozen hash to keep: what a manufacturer can ship is availability, not a
  // limit on the order — accepted whole, and `resolveComputeOrders` ships what
  // the seller actually has and reports the rest, exactly as it already does
  // for a seller with nothing to sell at all.
  if (intent.units > seller.sellableUnits) noteExpectedFill(ctx, verdict, intent);
  const expected = Math.min(intent.units, seller.sellableUnits);

  const cost = expected * seller.unitPriceUsd;
  const available = ctx.budget.availableCash(ctx.company);
  if (cost > available) commitCashWithNote(ctx, verdict, cost);
  else ctx.reservations.push(() => ctx.budget.spendCash(ctx.company.id, cost));
};

const allocateCompute: Rule<'allocate_compute'> = (_intent, verdict, ctx) => {
  // World 3 reads what an accelerator-quarter of cloud costs off the node
  // table; worlds 1 and 2 divide by exactly the constant they always divided by.
  const cloudUnitUsd = isNodeEconomyWorld(ctx.draft) ? cloudRentUsd(ctx.draft) : CLOUD_UNIT_COST_USD_PER_QUARTER;
  const held = heldCompute(ctx.company) + Math.round(ctx.company.compute.cloudSpendQuarterly / cloudUnitUsd);
  if (held <= 0) verdict.reject('insufficient_compute', `${ctx.company.name} holds no capacity to allocate.`);
};

/**
 * Build plant, fleet or grid capacity. World version 2 only, for the same
 * reason `buy_accelerators` is: nothing in world 1 reads a capacity kind but
 * compute, so inventing one there would move the frozen world. Cash is *noted*
 * rather than refused or clamped, exactly as every other world-2 capital
 * commitment: "a price cut is a price cut" extends to "a capex commitment is a
 * capex commitment" — the solvency clock is the consequence, not a refusal
 * here.
 */
const investCapacity: Rule<'invest_capacity'> = (intent, verdict, ctx) => {
  if (!solvencyWorld(ctx)) {
    verdict.reject('requirement_not_met', 'Building capacity outright is not available in this world.');
    return;
  }
  if (intent.amountUsd <= 0) {
    verdict.reject('illegal_value', 'A capacity investment must be for a positive amount.');
    return;
  }
  affordable(ctx, verdict, intent.amountUsd, `${intent.kind[0]?.toUpperCase()}${intent.kind.slice(1)} investment`, (draft, allowed) => {
    draft.amountUsd = allowed;
  });
};

/* -------------------------------------------------------------------------- */
/*  Supply chain                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Publish, reprice or close a product's supply terms. Structural refusals
 * only, per stage 1's rule: an unknown product, a category that cannot
 * supply anything, or a `blockedCustomerIds`/`exclusiveCustomerIds` entry
 * naming a company that does not exist. Everything else — a price far from
 * reference, closing to everyone — is a real decision the owner's cash and
 * customers answer for, not the validator's to refuse.
 */
const setSupplyTerms: Rule<'set_supply_terms'> = (intent, verdict, ctx) => {
  if (!solvencyWorld(ctx)) {
    verdict.reject('requirement_not_met', 'Publishing supply terms is not available in this world.');
    return;
  }
  const product = ctx.company.products.find((candidate) => candidate.id === intent.productId);
  if (product === undefined) {
    verdict.reject('unknown_target', `${ctx.company.name} has no product "${intent.productId}".`);
    return;
  }
  const category = categoryOf(ctx.company, product);
  if (!category.canSupply) {
    verdict.reject('requirement_not_met', `${category.label} is not a line other companies can build on.`);
    return;
  }
  if (intent.terms.pricePerUnitUsd < 0) {
    verdict.reject('illegal_value', 'A supply price cannot be negative.');
    return;
  }
  const unknown = [...intent.terms.exclusiveCustomerIds, ...intent.terms.blockedCustomerIds].find(
    (companyId) => !ctx.draft.companies.some((candidate) => candidate.id === companyId),
  );
  if (unknown !== undefined) {
    verdict.reject('unknown_target', `"${unknown}" is not a company in this session.`);
    return;
  }
};

/**
 * Choose, or switch away from, a named supplier for one input.
 *
 * Structural refusals only: an unknown product, an input the launch
 * category does not declare, a supplier that does not exist or whose line
 * is closed to this buyer, or a product naming itself as its own supplier —
 * the one cycle a single action can create (the catalogue's own
 * `requiredSupplyGraphIsAcyclic` already proves no `required` chain of
 * categories can loop back on itself). Everything else — a required input
 * left deliberately unsupplied, a switch that costs a quarter of quality —
 * realises rather than refuses.
 */
const chooseSupplier: Rule<'choose_supplier'> = (intent, verdict, ctx) => {
  if (!solvencyWorld(ctx)) {
    verdict.reject('requirement_not_met', 'Choosing a supplier is not available in this world.');
    return;
  }
  const product = ctx.company.products.find((candidate) => candidate.id === intent.productId);
  if (product === undefined) {
    verdict.reject('unknown_target', `${ctx.company.name} has no product "${intent.productId}".`);
    return;
  }
  // World 3: an input is a NODE the line's own node consumes, and a supplier is
  // a company running a line on that node. World 2's catalogue answers neither
  // question — its `categoryOf` resolves a product category, and every world-3
  // input id is a node id — so both tests are made against the table here. The
  // two id spaces are disjoint (every node id carries a table prefix), so the
  // branch below cannot capture a world-2 action.
  const nodeEconomy = isNodeEconomyWorld(ctx.draft);
  const lineNodeId = nodeEconomy ? lineNodeIdOf(product) : null;
  if (nodeEconomy) {
    const lineNode = lineNodeId === null ? undefined : ECONOMIC_NODES_BY_ID[lineNodeId];
    if (lineNode === undefined) {
      verdict.reject('unknown_target', `${product.name} does not produce a node, so it has no inputs to wire.`);
      return;
    }
    if (!lineNode.consumes.some((entry) => entry.nodeId === intent.inputCategoryId)) {
      verdict.reject(
        'unknown_target',
        `${lineNode.label} does not consume ${ECONOMIC_NODES_BY_ID[intent.inputCategoryId]?.label ?? intent.inputCategoryId.replace(/_/g, ' ')}.`,
      );
      return;
    }
  } else {
    const category = categoryOf(ctx.company, product);
    const input = category.inputs.find((entry) => entry.categoryId === intent.inputCategoryId);
    if (input === undefined) {
      verdict.reject('unknown_target', `${category.label} is not built on ${intent.inputCategoryId.replace(/_/g, ' ')}.`);
      return;
    }
  }
  if (intent.supplierCompanyId === null) return; // the open market, or a deliberate refusal — always legal
  if (intent.supplierCompanyId === ctx.company.id && intent.supplierProductId === intent.productId) {
    verdict.reject('illegal_value', `${product.name} cannot supply itself.`);
    return;
  }
  const supplierCompany = ctx.draft.companies.find((candidate) => candidate.id === intent.supplierCompanyId);
  if (supplierCompany === undefined || !supplierCompany.isActive) {
    verdict.reject('unknown_target', `"${intent.supplierCompanyId}" is not an active company in this session.`);
    return;
  }
  const supplierProduct = supplierCompany.products.find((candidate) => candidate.id === intent.supplierProductId && candidate.isActive);
  if (supplierProduct === undefined) {
    verdict.reject('unknown_target', `${supplierCompany.name} has no active product "${intent.supplierProductId}".`);
    return;
  }
  if (nodeEconomy) {
    // A seller of a node is a company running a line on it. There is no
    // `canSupply` flag in world 3: anything anybody makes, they can sell, which
    // is what makes the one node table one market rather than two.
    if (lineNodeIdOf(supplierProduct) !== intent.inputCategoryId) {
      verdict.reject(
        'unknown_target',
        `${supplierProduct.name} does not make ${ECONOMIC_NODES_BY_ID[intent.inputCategoryId]?.label ?? intent.inputCategoryId.replace(/_/g, ' ')}.`,
      );
      return;
    }
  } else {
    const supplierCategory = categoryOf(supplierCompany, supplierProduct);
    if (supplierCategory.id !== intent.inputCategoryId || !supplierCategory.canSupply) {
      verdict.reject('unknown_target', `${supplierProduct.name} does not supply ${intent.inputCategoryId.replace(/_/g, ' ')}.`);
      return;
    }
  }
  const terms = supplierProduct.supplyTerms ?? null;
  if (terms === null) {
    verdict.reject('unknown_target', `${supplierProduct.name} has not published supply terms.`);
    return;
  }
  if (terms.blockedCustomerIds.includes(ctx.company.id)) {
    verdict.reject('requirement_not_met', `${supplierCompany.name} has blocked ${ctx.company.name} from ${supplierProduct.name}.`);
    return;
  }
  if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(ctx.company.id)) {
    verdict.reject('requirement_not_met', `${supplierProduct.name} is not open to ${ctx.company.name}.`);
    return;
  }
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
    // World 2: shut credit markets are availability, not impossibility — a
    // founder may always try to raise debt. `resolveDebtIssues` already prices
    // the attempt against `debtAvailability` and reports a failed placement
    // with "no lender" when it does not clear; refusing here would just be a
    // second, earlier copy of that same check.
    if (isMultiSectorWorld(ctx.draft)) {
      verdict.note('requirement_not_met', 'Credit markets are shut this quarter: lenders are unlikely to extend, and the attempt may not clear.');
      return;
    }
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

  // World 2: unissued authorisation is availability, not a hard ceiling on the
  // instruction — a founder may ask to issue more than a share class currently
  // authorises. `resolveShareIssues` issues what the class allows and reports
  // the rest as a `partial_fill`; a genuine "authorise more shares" board
  // matter is a follow-on mechanic this pass does not build, so the shortfall
  // is stated rather than silently absorbed.
  if (solvencyWorld(ctx)) {
    if (intent.shares > headroom) noteExpectedFill(ctx, verdict, intent);
    const claimed = Math.max(0, Math.min(intent.shares, headroom));
    ctx.reservations.push(() => ctx.budget.claimShares(shareClass.id, claimed));
    return;
  }

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

  // World 2: the float is availability, not a limit on what may be ordered.
  // `runSettlement` already reads the order fresh off `pendingActions` and
  // fills what the float, the absorbable volume and the limit price allow —
  // it always has, independently of anything the validator does here — so the
  // instruction is accepted whole and the same expectation is only noted.
  // World 1 keeps the clamp, because `runSettlement`'s own execution has
  // always run against whatever the validator left it, and moving that now
  // would move the frozen world's hash.
  const available = floatShares(ctx.draft, security.id);
  if (wanted > available) {
    if (false && solvencyWorld(ctx)) {
      noteExpectedFill(ctx, verdict, { ...intent, shares: wanted, targetPct: null });
    } else if (available <= 0) {
      verdict.reject('requirement_not_met', 'There is no free float in that security to buy.');
      return;
    } else {
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
  }

  const cost = wanted * intent.maxPricePerShareUsd;
  const cash = ctx.budget.availableCash(ctx.company);
  if (cost > cash && solvencyWorld(ctx)) {
    // The float still binds — the clamp above stands — but the balance does not.
    commitCashWithNote(ctx, verdict, cost);
    return;
  }
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
  const lockup = lockupUntil(ctx.draft, security.id, ctx.company.id);
  if (lockup !== null && lockup > ctx.draft.quarter) {
    verdict.reject('lockup_active', `The position is locked up until quarter ${lockup}.`);
    return;
  }

  // World 2: the position held is availability, not a limit on what may be
  // offered — `runSettlement` reads the order fresh off `pendingActions` and
  // reports "nothing to sell" or "sale reduced" itself, exactly as it always
  // has. World 1 keeps refusing and clamping here, because that settlement has
  // always run against whatever the validator left it.
  if (false && solvencyWorld(ctx)) {
    if (intent.shares > held) noteExpectedFill(ctx, verdict, intent);
    return;
  }
  if (held <= 0) {
    verdict.reject('requirement_not_met', `${ctx.company.name} holds no shares in that security.`);
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
  if (cashNeeded > available && solvencyWorld(ctx)) {
    commitCashWithNote(ctx, verdict, cashNeeded);
    return;
  }
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
/*  Group control (world 2)                                                    */
/* -------------------------------------------------------------------------- */

const transferBetweenGroup: Rule<'transfer_between_group'> = (intent, verdict, ctx) => {
  if (intent.fromCompanyId !== ctx.company.id) {
    verdict.reject('not_controller_of_company', 'A group transfer is submitted from the company sending it.');
    return;
  }
  if (intent.toCompanyId === intent.fromCompanyId) {
    verdict.reject('illegal_value', 'A transfer needs two different companies.');
    return;
  }
  const to = findCompany(ctx.draft, intent.toCompanyId);
  if (to === null || !to.isActive) {
    verdict.reject('unknown_target', `No active company "${intent.toCompanyId}" exists in this session.`);
    return;
  }
  // Both ends have to answer to the same seat: this moves resources inside one
  // controller's own group, never between two different owners' companies.
  if (ctx.actor.playerId === null || to.controllerPlayerId !== ctx.actor.playerId) {
    verdict.reject('not_controller_of_company', `${to.name} is not directed by the same seat, so nothing may move to it as a group transfer.`);
    return;
  }

  const cash = intent.cashUsd;
  const units = intent.acceleratorUnits;
  if ((cash === null) === (units === null)) {
    verdict.reject('illegal_value', 'A group transfer moves cash or accelerator units — exactly one of the two, not neither and not both.');
    return;
  }
  if (cash !== null) {
    if (cash <= 0) {
      verdict.reject('illegal_value', 'A cash transfer must be a positive amount.');
      return;
    }
    affordable(ctx, verdict, cash, 'The transfer', (draft, allowed) => {
      draft.cashUsd = allowed;
    });
    return;
  }
  if (units !== null) {
    if (units <= 0) {
      verdict.reject('illegal_value', 'An accelerator transfer must move a positive number of units.');
      return;
    }
    const held = ctx.company.compute.ownedAccelerators;
    if (units > held) {
      verdict.clamp(
        (draft) => {
          draft.acceleratorUnits = held;
        },
        'insufficient_compute',
        `Transfer cut to ${held} accelerators: that is all ${ctx.company.name} owns outright.`,
      );
    }
  }
};

const mergeSubsidiary: Rule<'merge_subsidiary'> = (intent, verdict, ctx) => {
  const target = findCompany(ctx.draft, intent.subsidiaryCompanyId);
  if (target === null) {
    verdict.reject('unknown_target', `No company "${intent.subsidiaryCompanyId}" exists in this session.`);
    return;
  }
  if (!target.isActive || target.parentCompanyId !== ctx.company.id) {
    verdict.reject('requirement_not_met', `${target.name} is not a subsidiary of ${ctx.company.name}.`);
    return;
  }
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
  if (!reach.allowed) {
    // World 2: the approach is made anyway and fails at resolution — the same
    // "not there yet" outcome the director would give any founder they had
    // never heard from — with its own report line; the director's stance is
    // never registered. World 1 still refuses it here.
    if (solvencyWorld(ctx)) {
      verdict.note('target_not_reachable', `${reach.reason} The approach will be attempted anyway and is expected to fail.`);
    } else {
      verdict.reject('target_not_reachable', reach.reason);
    }
  }
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
  if (!reach.allowed) {
    // World 2: the request is made anyway and the office simply never takes
    // the call at resolution — `reactToRegulatorMeeting` gives it its own,
    // negative-sentiment outcome instead of the ordinary one. World 1 still
    // refuses it here.
    if (solvencyWorld(ctx)) verdict.note('target_not_reachable', `${reach.reason} The request will be made anyway and is expected to go nowhere.`);
    else verdict.reject('target_not_reachable', reach.reason);
  }
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
/*  Licensing (world 3)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ask the owner of a node for the right to produce it.
 *
 * Structural refusals only, and every one of them is a fact the founder cannot
 * spend their way past: a node that is not in the table, an owner that does not
 * own it outright, a request to licence what you already own, and a licence
 * that is still running. The royalty is CLAMPED into the band rather than
 * refused, so an offer of one percent becomes an offer of two and says so; what
 * the owner then makes of it is the owner's business, not the validator's.
 *
 * The signing fee is deliberately not a cash gate: from world 2 on, spending
 * more than you hold is a solvency problem the clock answers, never a refusal.
 */
const licenseNode: Rule<'license_node'> = (intent, verdict, ctx) => {
  if (!isNodeEconomyWorld(ctx.draft)) {
    verdict.reject('requirement_not_met', 'Nodes are only owned, and therefore only licensed, in the node economy.');
    return;
  }
  const node = ECONOMIC_NODES_BY_ID[intent.nodeId];
  if (node === undefined) {
    verdict.reject('unknown_target', `There is no node "${intent.nodeId}" in the economy.`);
    return;
  }
  if (intent.ownerCompanyId === ctx.company.id) {
    verdict.reject('illegal_value', `${ctx.company.name} cannot licence ${node.label} from itself.`);
    return;
  }
  const owner = ctx.draft.companies.find((candidate) => candidate.id === intent.ownerCompanyId);
  if (owner === undefined || !owner.isActive) {
    verdict.reject('unknown_target', `"${intent.ownerCompanyId}" is not a company that could grant a licence.`);
    return;
  }
  if (!ownsNodeOutright(owner, node.id)) {
    verdict.reject(
      'requirement_not_met',
      `${owner.name} does not own ${node.label} outright, so it has nothing to grant: a licensee cannot licence on what it licensed.`,
    );
    return;
  }
  if (ownsNodeOutright(ctx.company, node.id)) {
    verdict.reject('duplicate_action', `${ctx.company.name} already owns ${node.label}.`);
    return;
  }
  const existing = licenceFrom(ctx.company, node.id, owner.id);
  if (existing !== undefined && existing.expiryQuarter > ctx.draft.quarter) {
    verdict.reject(
      'duplicate_action',
      `${ctx.company.name} already licenses ${node.label} from ${owner.name} until quarter ${existing.expiryQuarter}. Renew it when it runs out.`,
    );
    return;
  }
  const bounded = boundedRoyaltyPct(intent.royaltyPct);
  if (bounded !== intent.royaltyPct) {
    verdict.clamp(
      (draft) => {
        draft.royaltyPct = bounded;
      },
      'illegal_value',
      `A royalty runs from ${LICENCE_ROYALTY_BOUNDS.min}% to ${LICENCE_ROYALTY_BOUNDS.max}%, so the offer to ${owner.name} is ${bounded}%. The signing fee is ${Math.round(
        licenceUpfrontUsd(node) / 1_000_000,
      )} million either way.`,
    );
  }
};

/**
 * Advertise what you will licence one of your own nodes for.
 *
 * Owning it outright is the only requirement — publishing terms for something
 * you licence yourself would be sublicensing, which no licence permits — and
 * the royalty is clamped into the same band a request is.
 */
const publishLicenceTerms: Rule<'publish_licence_terms'> = (intent, verdict, ctx) => {
  if (!isNodeEconomyWorld(ctx.draft)) {
    verdict.reject('requirement_not_met', 'Nodes are only owned, and therefore only licensed, in the node economy.');
    return;
  }
  const node = ECONOMIC_NODES_BY_ID[intent.nodeId];
  if (node === undefined) {
    verdict.reject('unknown_target', `There is no node "${intent.nodeId}" in the economy.`);
    return;
  }
  if (!ownsNodeOutright(ctx.company, node.id)) {
    verdict.reject(
      'requirement_not_met',
      `${ctx.company.name} does not own ${node.label} outright, so it has nothing to offer: a licensee cannot licence on what it licensed.`,
    );
    return;
  }
  const bounded = boundedRoyaltyPct(intent.royaltyPct);
  const published = (ctx.company.licenceOffers ?? []).find((offer) => offer.nodeId === node.id);
  if (published !== undefined && published.royaltyPct === bounded && published.openToAll === intent.openToAll) {
    verdict.reject('duplicate_action', `${ctx.company.name} already offers ${node.label} on exactly those terms.`);
    return;
  }
  if (bounded !== intent.royaltyPct) {
    verdict.clamp(
      (draft) => {
        draft.royaltyPct = bounded;
      },
      'illegal_value',
      `A royalty runs from ${LICENCE_ROYALTY_BOUNDS.min}% to ${LICENCE_ROYALTY_BOUNDS.max}%, so ${node.label} is published at ${bounded}%.`,
    );
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
  adjust_research_project: adjustResearchProject,
  abandon_research_project: abandonResearchProject,
  set_data_policy: setDataPolicy,
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
  buy_accelerators: buyAccelerators,
  invest_capacity: investCapacity,
  set_supply_terms: setSupplyTerms,
  choose_supplier: chooseSupplier,
  transfer_between_group: transferBetweenGroup,
  merge_subsidiary: mergeSubsidiary,
  license_node: licenseNode,
  publish_licence_terms: publishLicenceTerms,
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

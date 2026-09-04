/**
 * @frontier/simulation — validator/availability.ts
 *
 * What a company can actually do this quarter, derived from the validator
 * rather than described alongside it.
 *
 * The Chief of Staff is only useful if it knows what it is allowed to propose.
 * The temptation is to hand-write that list — "raising needs a board", "hiring
 * needs a quarter of pay in the bank" — and the problem with a hand-written
 * list is that it is a second copy of `rules.ts` that drifts from the first one
 * the next time a constant moves. So nothing here is asserted. Every entry is
 * produced by *probing the real validator*:
 *
 * 1. Build a representative intent for the type, at the most this company could
 *    plausibly ask for, using the same balancing constants the rules use.
 * 2. Run `validateAction` on it, with a fresh `BatchBudget` per probe so one
 *    type's reservation never makes the next one look unaffordable.
 * 3. Read the verdict back:
 *    - **rejected** — the action is unavailable, and the validator's own first
 *      sentence is the reason the founder is shown.
 *    - **clamped into `submit_board_proposal`** — available, but it becomes a
 *      board matter rather than executing.
 *    - **clamped otherwise** — available, and every numeric field the clamp
 *      reduced tightens the bound to what the validator would actually accept.
 *    - **accepted** — available at the bound as proposed.
 *
 * That third case is what makes the bounds honest rather than optimistic: the
 * maximum reported for `hire.count` is the number the validator did not reduce,
 * because it *was* the number the validator reduced it to.
 *
 * Pure and read-only: no RNG, no clock, no mutation of the draft. Probing runs
 * the same code a submission runs, so this is safe to call on the open quarter
 * as often as a screen likes.
 */

import type {
  ActionIntent,
  ActionType,
  CosAvailableAction,
  CosBound,
  CosTarget,
  SessionState,
} from '@frontier/contracts';
import {
  ACTION_TYPES,
  DATA_COLLECTION_LEVELS,
  DIVIDEND_MAX_PAYOUT_PCT,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  TOLL_MAX_PCT,
  nodeMarketPriceUsd,
  holdsNode,
  requiresClosure,
  requiresExplicitConfirmation,
} from '@frontier/contracts';
import { isNodeEconomyWorld } from '../economy/sectors';
import { BatchBudget, findCompany, floatShares, type ValidationActor } from './context';
import { validateAction } from './index';
import {
  HIRING_CASH_COVER_QUARTERS,
  MAX_IPO_FLOAT_PCT,
  MAX_ROUND_DILUTION_PCT,
  MIN_INTRODUCTION_PURPOSE_CHARS,
  MIN_IPO_FLOAT_PCT,
} from './balance';
import { quarterlyHireCostUsd, reservableUnits } from './rules';
import { sellersFor } from '../companies/sellers';
import { LICENCE_ROYALTY_BOUNDS, NPC_LICENCE_ROYALTY_FLOOR_PCT, licenceOfferOf, ownsNodeOutright } from '../graph/licensing';
import { launchableNodes, lineNodeIdOf, reservedRentUsd } from '../graph/lines';
import { categoryOf } from '../companies/categories';
import { defaultSupplyTerms, suppliersFor } from '../companies/supply';

/* -------------------------------------------------------------------------- */
/*  Probe shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One type's probe.
 *
 * `intent` null means there is nothing legal to probe with — no product to
 * reprice, no opportunity open, no deal awaiting an answer — which is itself an
 * honest answer, so the entry is reported unavailable carrying `reason`.
 */
interface Probe {
  readonly intent: ActionIntent | null;
  /** Why no probe could be built. Required whenever `intent` is null. */
  readonly reason?: string;
  readonly bounds: readonly CosBound[];
  readonly targets: readonly CosTarget[];
  /** Cash this action would commit at the probed size, or null when it commits none. */
  readonly maxCashUsd: number | null;
}

const NOTHING: Omit<Probe, 'intent' | 'reason'> = { bounds: [], targets: [], maxCashUsd: null };

const usdBound = (field: string, label: string, max: number | null, min = 0): CosBound => ({ field, label, min, max, unit: 'usd' });
const countBound = (field: string, label: string, max: number | null, min = 0): CosBound => ({ field, label, min, max, unit: 'count' });
const fractionBound = (field: string, label: string, min: number, max: number): CosBound => ({ field, label, min, max, unit: 'fraction' });
const quarterBound = (field: string, label: string, min: number, max: number): CosBound => ({ field, label, min, max, unit: 'quarters' });
const percentBound = (field: string, label: string, min: number, max: number): CosBound => ({ field, label, min, max, unit: 'percent' });

/* -------------------------------------------------------------------------- */
/*  Probe construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the probe for one action type.
 *
 * Every number here comes from the company's own position or from the
 * validator's balancing constants. Nothing is a guess at what "reasonable"
 * means, because the validator will clamp whatever is optimistic and the clamp
 * is what gets reported.
 */
function probeFor(type: ActionType, draft: SessionState, actor: ValidationActor): Probe {
  const company = findCompany(draft, actor.companyId);
  if (company === null) return { intent: null, reason: 'No such company in this session.', ...NOTHING };

  const cash = Math.max(0, company.financials.cash);
  const heldCompute = company.compute.ownedAccelerators + company.compute.reservedAccelerators;
  const activeProducts = company.products.filter((product) => product.isActive);
  const staff = company.employees;
  // What running programmes already hold, so a re-resourcing probe can hand a
  // programme's own allocation back before counting what is free.
  const onProgrammes = draft.researchProjects.filter(
    (project) => project.companyId === company.id && (project.status === 'active' || project.status === 'paused'),
  );
  const startedCompute = onProgrammes.reduce((total, project) => total + project.computeAllocated, 0);
  const startedResearchers = onProgrammes.reduce((total, project) => total + project.talentAllocated, 0);

  switch (type) {
    /* --------------------------- research --------------------------- */
    case 'set_research_budget':
      return {
        intent: { type, budgetUsd: cash },
        bounds: [usdBound('budgetUsd', 'Quarterly research budget', cash)],
        targets: [],
        maxCashUsd: cash,
      };

    case 'start_research_project': {
      const started = new Set(
        draft.researchProjects
          .filter((project) => project.companyId === company.id && (project.status === 'active' || project.status === 'paused'))
          .map((project) => project.targetNodeId),
      );
      const nodes = draft.techGraph.nodes.filter((node) => !started.has(node.id) && node.achievedByCompanyId !== company.id);
      const node = nodes[0];
      if (node === undefined) {
        return { intent: null, reason: 'Every node on the Frontier Map is already achieved or already has a programme running against it.', ...NOTHING };
      }
      return {
        intent: {
          type,
          targetNodeId: node.id,
          budgetUsd: cash,
          computeUnits: heldCompute,
          researchersAssigned: staff.researchers,
          secret: false,
        },
        bounds: [
          usdBound('budgetUsd', 'Cash per quarter', cash),
          countBound('computeUnits', 'Accelerator-equivalents', heldCompute),
          countBound('researchersAssigned', 'Researchers assigned', staff.researchers),
        ],
        targets: nodes.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.title })),
        maxCashUsd: cash,
      };
    }

    case 'adjust_research_project': {
      const running = draft.researchProjects.filter(
        (project) => project.companyId === company.id && (project.status === 'active' || project.status === 'paused'),
      );
      const project = running[0];
      if (project === undefined) {
        return { intent: null, reason: `${company.name} has no running research programme to re-resource.`, ...NOTHING };
      }
      // The programme hands its own allocation back before free capacity is
      // counted, exactly as the rule does.
      const freeCompute = heldCompute - startedCompute + project.computeAllocated;
      const freeResearchers = staff.researchers - startedResearchers + project.talentAllocated;
      return {
        intent: {
          type,
          projectId: project.id,
          budgetUsd: Math.max(cash, project.budgetQuarterly),
          computeUnits: Math.max(0, freeCompute),
          researchersAssigned: Math.max(0, freeResearchers),
        },
        bounds: [
          usdBound('budgetUsd', 'Cash per quarter', null),
          countBound('computeUnits', 'Accelerator-equivalents', Math.max(0, freeCompute)),
          countBound('researchersAssigned', 'Researchers assigned', Math.max(0, freeResearchers)),
        ],
        targets: running.slice(0, 24).map((entry) => ({
          id: entry.id,
          label: draft.techGraph.nodes.find((node) => node.id === entry.targetNodeId)?.title ?? entry.targetNodeId,
        })),
        maxCashUsd: cash,
      };
    }

    case 'propose_innovation': {
      if (!draft.config.allowPlayerInnovation) {
        return { intent: null, reason: 'Player innovation is disabled in this session.', ...NOTHING };
      }
      return {
        intent: {
          type,
          proposal: {
            nodeType: 'player_hypothesis',
            // A probe title nothing on the map can clash with. The founder's
            // real proposal is written by the innovation interpreter.
            title: `Availability probe ${company.id}`,
            summary: 'A probe of the validator, never submitted. It exists so the available-actions list is derived rather than asserted.',
            novelty: 0.5,
            plausibility: 0.5,
            requiredCapabilities: [],
            estimatedCost: cash,
            estimatedQuarters: 4,
            dependencies: [],
            initialVisibility: 'company_private',
            rationale: 'Probing the validator so the Chief of Staff can say honestly whether a new node may be proposed at all.',
          },
        },
        bounds: [usdBound('proposal.estimatedCost', 'Estimated programme cost', null)],
        targets: [],
        maxCashUsd: null,
      };
    }

    case 'publish_research': {
      const owned = draft.techGraph.nodes.filter(
        (node) =>
          node.achievedByCompanyId === company.id ||
          draft.researchProjects.some((project) => project.companyId === company.id && project.targetNodeId === node.id && project.status === 'succeeded'),
      );
      const node = owned[0];
      if (node === undefined) {
        return { intent: null, reason: `${company.name} has no completed research result to publish.`, ...NOTHING };
      }
      return {
        intent: { type, nodeId: node.id, mode: 'paper', rationale: 'Probe.' },
        bounds: [],
        targets: owned.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.title })),
        maxCashUsd: null,
      };
    }

    /* ---------------------------- product --------------------------- */
    case 'set_product_price': {
      const product = activeProducts[0];
      if (product === undefined) return { intent: null, reason: `${company.name} sells nothing to reprice.`, ...NOTHING };
      // The band is the validator's own; probing at the ceiling makes the clamp
      // report the exact ceiling for this product.
      return {
        intent: { type, productId: product.id, pricePerSeatUsd: product.pricePerSeat * 8 },
        bounds: [usdBound('pricePerSeatUsd', `Price per seat (${product.name})`, product.pricePerSeat * 8, 0)],
        targets: activeProducts.map((entry) => ({ id: entry.id, label: `${entry.name} at ${Math.round(entry.pricePerSeat)} per seat` })),
        maxCashUsd: null,
      };
    }

    case 'launch_product': {
      // World 3: a launch names a NODE this company may produce, and the probe
      // offers exactly those — the same `launchableNodes` list the screen and
      // the `launchable_lines` lookup read, so an option the Chief of Staff
      // offers is an option the validator accepts. World 1 and 2 keep the
      // segment-shaped probe with no targets, which is all their catalogue
      // could answer.
      const openNodes = isNodeEconomyWorld(draft)
        ? launchableNodes(draft, company).filter((entry) => !entry.locked && !entry.alreadySold)
        : [];
      const first = openNodes[0] ?? null;
      return {
        intent: {
          type,
          name: `Availability probe ${company.id}`,
          segment: first?.node.buyerSegment ?? 'enterprise',
          categoryId: first?.node.id ?? null,
          pricePerSeatUsd: first === null ? 1_000 : Math.max(1, Math.round(nodeMarketPriceUsd(draft, first.node.id))),
          computeIntensity: 0.5,
          launchMarketingUsd: cash,
          targetQuality: 0.5,
          supply: [],
        },
        bounds: [
          usdBound('launchMarketingUsd', 'Launch marketing', cash),
          usdBound('pricePerSeatUsd', isNodeEconomyWorld(draft) ? 'Launch price per unit' : 'Launch price per seat', null),
        ],
        targets: openNodes
          .slice(0, 24)
          .map((entry) => ({ id: entry.node.id, label: `${entry.node.label} — ${Math.round(nodeMarketPriceUsd(draft, entry.node.id))} a ${entry.node.unitLabel} on the market` })),
        maxCashUsd: cash,
      };
    }

    case 'sunset_product': {
      const product = activeProducts[0];
      if (product === undefined) return { intent: null, reason: `${company.name} has no active product to retire.`, ...NOTHING };
      return {
        intent: { type, productId: product.id, windDownQuarters: 4 },
        bounds: [quarterBound('windDownQuarters', 'Wind-down given to customers', 1, 8)],
        targets: activeProducts.map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: null,
      };
    }

    /* --------------------------- marketing -------------------------- */
    case 'set_marketing_budget':
      return {
        intent: { type, allocations: [{ segment: 'enterprise', budgetUsd: cash }] },
        bounds: [usdBound('allocations[].budgetUsd', 'Total marketing across segments', cash)],
        targets: [],
        maxCashUsd: cash,
      };

    case 'marketing_campaign':
      return {
        // One quarter, so the affordability test is the whole budget rather
        // than a per-quarter share; the clamp then reports the true ceiling.
        intent: { type, theme: 'brand', segment: 'enterprise', budgetUsd: cash, quarters: 1 },
        bounds: [usdBound('budgetUsd', 'Campaign spend per quarter', cash), quarterBound('quarters', 'Campaign length', 1, 8)],
        targets: [],
        maxCashUsd: cash,
      };

    /* ----------------------------- people --------------------------- */
    case 'hire': {
      const perHire = quarterlyHireCostUsd(draft, 'engineers', 'market') * HIRING_CASH_COVER_QUARTERS;
      const affordable = perHire <= 0 ? 0 : Math.floor(cash / perHire);
      return {
        intent: { type, role: 'engineers', count: Math.max(1, affordable), compBand: 'market' },
        bounds: [countBound('count', 'Engineers at market pay', Math.max(1, affordable), 1)],
        targets: [],
        maxCashUsd: Math.max(1, affordable) * perHire,
      };
    }

    case 'layoff': {
      const role = (['engineers', 'researchers', 'sales', 'ops'] as const).find((entry) => staff[entry] > 0);
      if (role === undefined) return { intent: null, reason: `${company.name} employs nobody outside the executive team.`, ...NOTHING };
      return {
        intent: { type, role, count: staff[role], severanceQuartersOfPay: 1 },
        bounds: [countBound('count', `Roles cut (${role})`, staff[role], 1), quarterBound('severanceQuartersOfPay', 'Severance in quarters of pay', 0, 4)],
        targets: (['engineers', 'researchers', 'sales', 'ops', 'execs'] as const)
          .filter((entry) => staff[entry] > 0)
          .map((entry) => ({ id: entry, label: `${entry} — ${staff[entry]} people` })),
        maxCashUsd: null,
      };
    }

    case 'poach_executive': {
      const candidates = draft.characters.filter(
        (character) => character.isActive && character.companyId !== company.id && character.id !== actor.characterId,
      );
      const target = candidates[0];
      if (target === undefined) return { intent: null, reason: 'There is nobody outside this company to approach.', ...NOTHING };
      const base = quarterlyHireCostUsd(draft, 'execs', 'market');
      return {
        // Public: a private approach is refused outright when the connection gap
        // is too wide, and this list is about what *can* be done, not what the
        // cheapest form of it is.
        intent: { type, targetCharacterId: target.id, compPremiumPct: 3, approach: 'public' },
        bounds: [fractionBound('compPremiumPct', 'Premium over their current pay', 0, 3)],
        targets: candidates.slice(0, 24).map((entry) => ({ id: entry.id, label: `${entry.name}${entry.title === '' ? '' : ` — ${entry.title}`}` })),
        maxCashUsd: base * 4,
      };
    }

    case 'appoint_executive': {
      const candidates = draft.characters.filter((character) => character.isActive && character.companyId === company.id);
      const target = candidates[0];
      if (target === undefined) return { intent: null, reason: `${company.name} employs nobody who could take a C-suite post.`, ...NOTHING };
      return {
        intent: { type, characterId: target.id, executiveRole: 'coo', annualCompUsd: cash * 4 },
        bounds: [usdBound('annualCompUsd', 'Annual package', cash * 4)],
        targets: candidates.slice(0, 24).map((entry) => ({ id: entry.id, label: `${entry.name}${entry.title === '' ? '' : ` — ${entry.title}`}` })),
        maxCashUsd: cash,
      };
    }

    /* ---------------------------- compute --------------------------- */
    case 'reserve_compute': {
      const marketCap = reservableUnits(draft);
      const unitCost = reservedRentUsd(draft);
      const affordable = unitCost <= 0 ? marketCap : Math.min(marketCap, Math.floor(cash / unitCost));
      return {
        intent: { type, units: Math.max(1, affordable), quarters: 4, maxPricePerUnitUsd: Math.round(unitCost * 1.2), providerCompanyId: null },
        bounds: [
          countBound('units', 'Accelerator-equivalents', Math.max(1, affordable), 1),
          quarterBound('quarters', 'Reservation term', 1, 16),
          usdBound('maxPricePerUnitUsd', 'Price ceiling per unit per quarter', null),
        ],
        targets: [],
        maxCashUsd: Math.max(1, affordable) * unitCost,
      };
    }

    case 'buy_cloud_capacity':
      return {
        intent: { type, quarterlySpendUsd: cash, providerCompanyId: null, commitmentQuarters: 0 },
        bounds: [usdBound('quarterlySpendUsd', 'Cloud spend this quarter', cash), quarterBound('commitmentQuarters', 'Quarters committed', 0, 12)],
        targets: draft.companies
          .filter((entry) => entry.isActive && entry.id !== company.id)
          .slice(0, 24)
          .map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: cash,
      };

    case 'buy_accelerators': {
      // Probed against the market rather than against the cash: from world
      // version 2 cash notes an order, it never refuses one, so the honest
      // ceiling is what the cheapest manufacturer can actually ship.
      const market = sellersFor(draft, 'accelerators', company.id);
      const seller = market[0];
      if (seller === undefined) {
        return { intent: null, reason: 'No manufacturer has accelerators to sell this quarter.', ...NOTHING };
      }
      return {
        intent: {
          type,
          units: seller.sellableUnits,
          maxPricePerUnitUsd: Math.round(seller.unitPriceUsd * 1.1),
          sellerCompanyId: seller.company.id,
        },
        bounds: [
          countBound('units', 'Accelerators', seller.sellableUnits, 1),
          usdBound('maxPricePerUnitUsd', 'Price ceiling per accelerator', null),
        ],
        targets: market.slice(0, 24).map((entry) => ({
          id: entry.company.id,
          label: `${entry.company.name} — ${entry.sellableUnits} units at ${Math.round(entry.unitPriceUsd)} each`,
        })),
        maxCashUsd: Math.round(seller.sellableUnits * seller.unitPriceUsd),
      };
    }

    case 'invest_capacity':
      return {
        intent: { type, kind: 'plant', amountUsd: cash },
        bounds: [usdBound('amountUsd', 'Capacity investment', cash)],
        targets: [
          { id: 'plant', label: 'Plant' },
          { id: 'fleet', label: 'Fleet' },
          { id: 'grid', label: 'Grid' },
        ],
        maxCashUsd: cash,
      };

    case 'set_supply_terms': {
      const suppliable = activeProducts.find((product) => categoryOf(company, product).canSupply);
      if (suppliable === undefined) {
        return { intent: null, reason: `Nothing ${company.name} sells can be published as another company's input.`, ...NOTHING };
      }
      const category = categoryOf(company, suppliable);
      const terms = suppliable.supplyTerms ?? defaultSupplyTerms(category);
      return {
        intent: { type, productId: suppliable.id, terms: { ...terms, exclusiveCustomerIds: [...terms.exclusiveCustomerIds], blockedCustomerIds: [...terms.blockedCustomerIds] } },
        bounds: [usdBound('terms.pricePerUnitUsd', `Price per unit (${suppliable.name})`, null)],
        targets: activeProducts.filter((product) => categoryOf(company, product).canSupply).map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: null,
      };
    }

    case 'choose_supplier': {
      // World 3: an input is a NODE the company's own line consumes, so the
      // probe walks the table rather than the world-2 catalogue. Both branches
      // end in the same `suppliersFor` call, which is itself node-aware in
      // world 3 — one lookup, two id spaces, and they cannot be confused
      // because every node id carries a table prefix.
      if (isNodeEconomyWorld(draft)) {
        const line = activeProducts.find((product) => {
          const nodeId = lineNodeIdOf(product);
          return nodeId !== null && (ECONOMIC_NODES_BY_ID[nodeId]?.consumes.length ?? 0) > 0;
        });
        const lineNodeId = line === undefined ? null : lineNodeIdOf(line);
        const inputNode = lineNodeId === null ? undefined : ECONOMIC_NODES_BY_ID[lineNodeId]?.consumes[0];
        if (line === undefined || inputNode === undefined) {
          return { intent: null, reason: `Nothing ${company.name} makes consumes an input somebody else could supply.`, ...NOTHING };
        }
        const nodeOffers = suppliersFor(draft, company.id, inputNode.nodeId);
        const bestNode = nodeOffers[0] ?? null;
        return {
          intent: {
            type,
            productId: line.id,
            inputCategoryId: inputNode.nodeId,
            supplierCompanyId: bestNode?.company.id ?? null,
            supplierProductId: bestNode?.product.id ?? null,
          },
          bounds: [],
          targets: nodeOffers
            .slice(0, 24)
            .map((entry) => ({ id: entry.company.id, label: `${entry.company.name} — ${ECONOMIC_NODES_BY_ID[inputNode.nodeId]?.label ?? inputNode.nodeId} at ${Math.round(entry.pricePerUnitUsd)} a unit` })),
          maxCashUsd: null,
        };
      }
      const withInputs = activeProducts.find((product) => categoryOf(company, product).inputs.length > 0);
      if (withInputs === undefined) {
        return { intent: null, reason: `Nothing ${company.name} sells is built on another company's input.`, ...NOTHING };
      }
      const category = categoryOf(company, withInputs);
      const input = category.inputs[0]!;
      const offers = suppliersFor(draft, company.id, input.categoryId);
      const best = offers[0] ?? null;
      return {
        intent: {
          type,
          productId: withInputs.id,
          inputCategoryId: input.categoryId,
          supplierCompanyId: best?.company.id ?? null,
          supplierProductId: best?.product.id ?? null,
        },
        bounds: [],
        targets: offers.slice(0, 24).map((entry) => ({ id: entry.company.id, label: `${entry.company.name} — ${entry.product.name} at ${Math.round(entry.pricePerUnitUsd)} a unit` })),
        maxCashUsd: null,
      };
    }

    case 'allocate_compute':
      return {
        intent: { type, trainingFraction: 0.5 },
        bounds: [fractionBound('trainingFraction', 'Share pointed at training', 0, 1)],
        targets: [],
        maxCashUsd: null,
      };

    /* ---------------------------- capital --------------------------- */
    case 'raise_round':
      return {
        intent: { type, stage: 'series_c', targetAmountUsd: Math.max(1, cash), maxDilutionPct: MAX_ROUND_DILUTION_PCT },
        bounds: [usdBound('targetAmountUsd', 'Amount sought', null, 1), fractionBound('maxDilutionPct', 'Dilution ceiling', 0, MAX_ROUND_DILUTION_PCT)],
        targets: [],
        maxCashUsd: null,
      };

    case 'issue_debt':
      return {
        intent: { type, amountUsd: Math.max(1, cash), maxRatePct: 0.12, termQuarters: 12 },
        bounds: [
          usdBound('amountUsd', 'Principal sought', null, 1),
          fractionBound('maxRatePct', 'Coupon ceiling', 0, 0.5),
          quarterBound('termQuarters', 'Term', 1, 40),
        ],
        targets: [],
        maxCashUsd: null,
      };

    case 'buyback':
      return {
        intent: { type, budgetUsd: cash, maxPricePerShareUsd: 1_000_000 },
        bounds: [usdBound('budgetUsd', 'Repurchase budget', cash)],
        targets: [],
        maxCashUsd: cash,
      };

    case 'issue_shares': {
      const table = draft.capTables.find((entry) => entry.companyId === company.id) ?? null;
      const shareClass = table?.shareClasses[0];
      if (table === null || shareClass === undefined) {
        return { intent: null, reason: `${company.name} has no share class to issue into.`, ...NOTHING };
      }
      const headroom = Math.max(0, shareClass.authorisedShares - shareClass.issuedShares);
      return {
        intent: { type, shares: Math.max(1, headroom), shareClassId: shareClass.id, minPricePerShareUsd: 1 },
        bounds: [countBound('shares', `Unissued authorisation in ${shareClass.label}`, Math.max(1, headroom), 1)],
        targets: table.shareClasses.map((entry) => ({ id: entry.id, label: entry.label })),
        maxCashUsd: null,
      };
    }

    case 'ipo':
      return {
        intent: { type, targetRaiseUsd: Math.max(1, cash), floatPct: MAX_IPO_FLOAT_PCT, minPricePerShareUsd: 1 },
        bounds: [usdBound('targetRaiseUsd', 'Primary capital sought', null, 1), fractionBound('floatPct', 'Fraction offered', MIN_IPO_FLOAT_PCT, MAX_IPO_FLOAT_PCT)],
        targets: [],
        maxCashUsd: null,
      };

    case 'set_dividend_policy':
      return {
        intent: { type, payoutPct: DIVIDEND_MAX_PAYOUT_PCT },
        bounds: [percentBound('payoutPct', 'Share of net income paid out', 0, DIVIDEND_MAX_PAYOUT_PCT)],
        targets: [],
        maxCashUsd: null,
      };

    case 'set_logistics_toll':
      return {
        intent: { type, region: company.region, tollPct: TOLL_MAX_PCT },
        bounds: [percentBound('tollPct', `Toll charged in ${company.region.replace(/_/g, ' ')}`, 0, TOLL_MAX_PCT)],
        targets: [],
        maxCashUsd: null,
      };

    /* --------------------------- ownership -------------------------- */
    case 'buy_shares': {
      const securities = draft.securities.filter((security) => security.isTradable && security.companyId !== company.id);
      const security = securities[0];
      if (security === undefined) return { intent: null, reason: 'Nothing else trades on the exchange to accumulate.', ...NOTHING };
      // A nominal price limit, so the clamp reports the free float rather than
      // what a made-up price would have made affordable. The founder's real
      // limit is their own; `maxCashUsd` is what constrains it.
      const wanted = Math.max(1, floatShares(draft, security.id));
      return {
        intent: { type, securityId: security.id, targetPct: null, shares: wanted, maxPricePerShareUsd: 1 },
        bounds: [countBound('shares', 'Shares available to buy', wanted, 1), usdBound('maxPricePerShareUsd', 'Price ceiling per share', null, 1)],
        targets: securities.slice(0, 24).map((entry) => ({ id: entry.id, label: nameOfSecurity(draft, entry.companyId, entry.id) })),
        maxCashUsd: cash,
      };
    }

    case 'sell_shares': {
      const held = draft.capTables.flatMap((table) =>
        table.holdings.filter((holding) => holding.holderId === company.id && holding.shares > 0).map((holding) => ({ table, holding })),
      );
      const first = held[0];
      if (first === undefined) return { intent: null, reason: `${company.name} holds no shares in anybody else.`, ...NOTHING };
      return {
        intent: { type, securityId: first.holding.securityId, shares: first.holding.shares, minPricePerShareUsd: 0 },
        bounds: [countBound('shares', 'Shares to sell', first.holding.shares, 1)],
        targets: held
          .slice(0, 24)
          .map((entry) => ({ id: entry.holding.securityId, label: `${nameOfSecurity(draft, entry.table.companyId, entry.holding.securityId)} — ${entry.holding.shares} held` })),
        maxCashUsd: null,
      };
    }

    case 'acquire_company': {
      const targets = draft.companies.filter((entry) => entry.isActive && entry.id !== company.id);
      const target = targets[0];
      if (target === undefined) return { intent: null, reason: 'There is no other operating company to acquire.', ...NOTHING };
      return {
        // All-stock, so the probe is not refused for a cash component the
        // company has not got. The cash bound below reports what it does have.
        intent: { type, targetCompanyId: target.id, offerValueUsd: Math.max(1, cash), cashPct: 0, stockPct: 1 },
        bounds: [
          usdBound('offerValueUsd', 'Offer value', null, 1),
          fractionBound('cashPct', 'Paid in cash', 0, 1),
          fractionBound('stockPct', 'Paid in stock', 0, 1),
        ],
        targets: targets.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: cash,
      };
    }

    /* ----------------------------- boards --------------------------- */
    case 'submit_board_proposal':
      return {
        intent: {
          type,
          kind: 'annual_plan',
          title: `Availability probe ${company.id}`,
          summary: 'A probe of the validator, never tabled.',
          amountUsd: null,
          targetCompanyId: null,
          stockComponentPct: null,
        },
        bounds: [usdBound('amountUsd', 'Headline size', null)],
        targets: [],
        maxCashUsd: null,
      };

    case 'lobby_director': {
      const board = draft.boards.find((entry) => entry.id === company.boardId) ?? null;
      const proposal = draft.boardProposals.find(
        (entry) => entry.companyId === company.id && (entry.status === 'tabled' || entry.status === 'draft'),
      );
      if (board === null) return { intent: null, reason: `${company.name} has no board to lobby.`, ...NOTHING };
      if (proposal === undefined) return { intent: null, reason: 'No matter is before the board to lobby anybody about.', ...NOTHING };
      const director = board.directors[0];
      if (director === undefined) return { intent: null, reason: 'The board has no seated directors.', ...NOTHING };
      return {
        intent: { type, directorCharacterId: director.characterId, proposalId: proposal.id, concessions: [], message: 'Probe.' },
        bounds: [],
        targets: board.directors.map((entry) => ({ id: entry.characterId, label: nameOfCharacter(draft, entry.characterId) })),
        maxCashUsd: null,
      };
    }

    /* --------------------------- government ------------------------- */
    case 'bid_government': {
      const open = draft.procurementOpportunities.filter(
        (entry) =>
          entry.status === 'open' &&
          draft.quarter <= entry.closeQuarter &&
          (entry.visibility === 'public' || entry.invitedCompanyIds.includes(company.id)) &&
          !draft.governmentBids.some((bid) => bid.bidderCompanyId === company.id && bid.opportunityId === entry.id && bid.status !== 'withdrawn'),
      );
      const opportunity = open[0];
      if (opportunity === undefined) return { intent: null, reason: 'No procurement this company can see is still accepting bids.', ...NOTHING };
      return {
        intent: {
          type,
          opportunityId: opportunity.id,
          bid: {
            opportunityId: opportunity.id,
            price: opportunity.maxValue,
            technicalScoreInputs: {
              modelCapability: 0.5,
              architectureQuality: 0.5,
              securityPosture: 0.5,
              reliabilityCommitment: 0.5,
              responsibleAiCommitment: 0.5,
            },
            computeCommitment: { acceleratorUnits: heldCompute, quarters: 4 },
            staffCommitment: { engineers: staff.engineers, researchers: staff.researchers, clearedStaff: 0 },
            timeline: { deliveryQuarters: 4, milestoneCount: 4 },
            subcontractors: [],
            ipConcessions: 'none',
            auditRights: 'annual',
            domesticSourcingPct: 1,
            consortiumMemberIds: [],
            narrative: '',
          },
        },
        bounds: [
          usdBound('bid.price', 'Total bid price', opportunity.maxValue),
          countBound('bid.computeCommitment.acceleratorUnits', 'Accelerators committed', heldCompute),
          countBound('bid.staffCommitment.engineers', 'Engineers committed', staff.engineers),
          countBound('bid.staffCommitment.researchers', 'Researchers committed', staff.researchers),
        ],
        targets: open.slice(0, 24).map((entry) => ({ id: entry.id, label: `${entry.programme} — ceiling ${Math.round(entry.maxValue)}` })),
        maxCashUsd: null,
      };
    }

    case 'decline_opportunity': {
      const open = draft.procurementOpportunities.filter((entry) => entry.status === 'open');
      const opportunity = open[0];
      if (opportunity === undefined) return { intent: null, reason: 'Nothing is open to decline.', ...NOTHING };
      return {
        intent: { type, opportunityId: opportunity.id, reason: 'Probe.' },
        bounds: [],
        targets: open.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.programme })),
        maxCashUsd: null,
      };
    }

    case 'form_consortium': {
      const open = draft.procurementOpportunities.filter(
        (entry) => entry.status === 'open' && draft.quarter <= entry.closeQuarter && entry.allowsConsortium,
      );
      const opportunity = open[0];
      const partner = draft.companies.find((entry) => entry.isActive && entry.id !== company.id);
      if (opportunity === undefined) return { intent: null, reason: 'No open procurement permits a joint bid.', ...NOTHING };
      if (partner === undefined) return { intent: null, reason: 'There is no other company to bid jointly with.', ...NOTHING };
      return {
        intent: { type, opportunityId: opportunity.id, inviteeCompanyIds: [partner.id], leadCompanyId: company.id, sharePct: 0.5 },
        bounds: [fractionBound('sharePct', 'Your share of the contract', 0, 1)],
        targets: open.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.programme })),
        maxCashUsd: null,
      };
    }

    case 'meet_regulator': {
      const regulators = draft.characters.filter((character) => character.isActive && (character.role === 'regulator' || character.role === 'official'));
      const regulator = regulators[0];
      if (regulator === undefined) return { intent: null, reason: 'No regulator or public official exists in this session.', ...NOTHING };
      return {
        intent: { type, regulatorCharacterId: regulator.id, topic: 'model_rules', posture: 'informational', concessionsOffered: [] },
        bounds: [],
        targets: regulators.slice(0, 24).map((entry) => ({ id: entry.id, label: `${entry.name}${entry.title === '' ? '' : ` — ${entry.title}`}` })),
        maxCashUsd: null,
      };
    }

    /* ----------------------------- social --------------------------- */
    case 'social_post': {
      const account = draft.socialAccounts.find(
        (entry) => entry.isActive && (entry.ownerCompanyId === company.id || entry.ownerCharacterId === actor.characterId),
      );
      if (account === undefined || actor.characterId === null) {
        return { intent: null, reason: `Neither ${company.name} nor its founder holds an account on any network.`, ...NOTHING };
      }
      return {
        intent: {
          type,
          draft: { authorCharacterId: actor.characterId, network: account.network, text: 'Probe.', intent: 'announce', targetCompanyId: null },
        },
        bounds: [],
        targets: draft.socialAccounts
          .filter((entry) => entry.isActive && (entry.ownerCompanyId === company.id || entry.ownerCharacterId === actor.characterId))
          .slice(0, 24)
          .map((entry) => ({ id: entry.network, label: entry.network.replace(/_/g, ' ') })),
        maxCashUsd: null,
      };
    }

    case 'give_guidance':
      return {
        intent: { type, metric: 'revenue', value: company.financials.revenueQuarterly, quarter: draft.quarter },
        bounds: [],
        targets: [],
        maxCashUsd: null,
      };

    case 'respond_crisis': {
      const crises = [
        ...draft.activeEvents.map((entry) => ({ id: entry.id, label: entry.title })),
        ...draft.mediaStories.map((entry) => ({ id: entry.id, label: entry.headline })),
      ];
      const crisis = crises[0];
      if (crisis === undefined) return { intent: null, reason: 'Nothing public is running that would need a response.', ...NOTHING };
      return {
        intent: { type, crisisEventId: crisis.id, responseKind: 'acknowledge', statement: 'Probe.' },
        bounds: [],
        targets: crises.slice(0, 24),
        maxCashUsd: null,
      };
    }

    /* ------------------------ deals and people ---------------------- */
    case 'propose_deal': {
      const counterparty = draft.companies.find((entry) => entry.isActive && entry.id !== company.id);
      if (counterparty === undefined) return { intent: null, reason: 'There is no counterparty to make an offer to.', ...NOTHING };
      return {
        intent: {
          type,
          proposal: {
            counterpartyId: counterparty.id,
            counterpartyKind: 'company',
            gives: [],
            gets: [],
            confidentiality: 'private',
            expiresQuarter: draft.quarter + 2,
            binding: false,
            intentStatements: [],
            summary: 'A probe of the validator, never sent to anybody.',
          },
        },
        bounds: [],
        targets: draft.companies
          .filter((entry) => entry.isActive && entry.id !== company.id)
          .slice(0, 24)
          .map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: null,
      };
    }

    case 'accept_deal':
    case 'reject_deal': {
      const open = draft.deals.filter(
        (deal) =>
          deal.status === 'proposed' &&
          deal.expiresQuarter >= draft.quarter &&
          (deal.counterpartyId === company.id || deal.counterpartyId === actor.characterId || deal.counterpartyId === actor.playerId),
      );
      const deal = open[0];
      if (deal === undefined) return { intent: null, reason: 'No offer is awaiting an answer.', ...NOTHING };
      return {
        intent: type === 'accept_deal' ? { type, dealId: deal.id } : { type, dealId: deal.id, reason: 'Probe.' },
        bounds: [],
        targets: open.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.summary })),
        maxCashUsd: null,
      };
    }

    case 'request_introduction': {
      const others = draft.characters.filter((character) => character.isActive && character.id !== actor.characterId);
      const via = others[0];
      const target = others[1];
      if (via === undefined || target === undefined) {
        return { intent: null, reason: 'An introduction needs three people and this world has fewer.', ...NOTHING };
      }
      return {
        intent: {
          type,
          viaCharacterId: via.id,
          targetCharacterId: target.id,
          purpose: 'A stated purpose long enough to be taken seriously by the person being asked.',
        },
        bounds: [countBound('purpose', 'Characters of stated purpose', null, MIN_INTRODUCTION_PURPOSE_CHARS)],
        targets: others.slice(0, 24).map((entry) => ({ id: entry.id, label: `${entry.name}${entry.title === '' ? '' : ` — ${entry.title}`}` })),
        maxCashUsd: null,
      };
    }

    /* --------------------------- group control (world 2) ------------ */
    case 'transfer_between_group': {
      const targets =
        company.controllerPlayerId === null
          ? []
          : draft.companies.filter((entry) => entry.isActive && entry.id !== company.id && entry.controllerPlayerId === company.controllerPlayerId);
      const target = targets[0];
      if (target === undefined) return { intent: null, reason: `${company.name} does not control another company to move anything to.`, ...NOTHING };
      return {
        intent: { type, fromCompanyId: company.id, toCompanyId: target.id, cashUsd: Math.max(1, cash), acceleratorUnits: null },
        bounds: [usdBound('cashUsd', 'Cash to move', cash, 1)],
        targets: targets.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: cash,
      };
    }

    case 'merge_subsidiary': {
      const targets = draft.companies.filter((entry) => entry.isActive && entry.parentCompanyId === company.id);
      const target = targets[0];
      if (target === undefined) return { intent: null, reason: `${company.name} has no subsidiary to absorb.`, ...NOTHING };
      return {
        intent: { type, subsidiaryCompanyId: target.id },
        bounds: [],
        targets: targets.slice(0, 24).map((entry) => ({ id: entry.id, label: entry.name })),
        maxCashUsd: null,
      };
    }

    /* --------------------------- world 3 ----------------------------- */
    case 'abandon_research_project': {
      const open = draft.researchProjects.filter(
        (project) => project.companyId === company.id && (project.status === 'active' || project.status === 'paused'),
      );
      const project = open[0];
      if (project === undefined) return { intent: null, reason: `${company.name} has no open research programme to close.`, ...NOTHING };
      return {
        intent: { type, projectId: project.id },
        bounds: [],
        targets: open.slice(0, 24).map((entry) => ({ id: entry.id, label: draft.techGraph.nodes.find((node) => node.id === entry.targetNodeId)?.title ?? entry.targetNodeId })),
        maxCashUsd: null,
      };
    }

    case 'set_data_policy': {
      if (!isNodeEconomyWorld(draft)) return { intent: null, reason: 'Customer data is only collected in the node economy.', ...NOTHING };
      // The offer is the position the company is not already on, so the probe
      // never proposes a no-op the validator would refuse as a duplicate.
      const current = company.dataPolicy ?? 'standard';
      const level = current === 'standard' ? 'aggressive' : 'standard';
      return {
        intent: { type, collectionLevel: level },
        bounds: [],
        targets: DATA_COLLECTION_LEVELS.filter((entry) => entry !== current).map((entry) => ({ id: entry, label: entry })),
        maxCashUsd: null,
      };
    }

    case 'license_node': {
      if (!isNodeEconomyWorld(draft)) return { intent: null, reason: 'Nodes are only owned, and therefore only licensed, in the node economy.', ...NOTHING };
      // The licence worth offering is the one that unblocks something this
      // company is already trying to sell, so the wanted set is walked first
      // and everything else somebody owns comes after it.
      const wanted = new Set<string>();
      for (const product of company.products) {
        if (!product.isActive) continue;
        const nodeId = lineNodeIdOf(product);
        if (nodeId === null) continue;
        for (const required of requiresClosure(nodeId)) wanted.add(required);
      }
      const candidates: { nodeId: string; label: string; owner: string; ownerName: string; royaltyPct: number; needed: boolean }[] = [];
      for (const node of ECONOMIC_NODES) {
        if (holdsNode(company, node.id, draft.quarter)) continue;
        const owner = draft.companies.find((candidate) => candidate.isActive && candidate.id !== company.id && ownsNodeOutright(candidate, node.id));
        if (owner === undefined) continue;
        const offer = licenceOfferOf(owner, node.id);
        candidates.push({
          nodeId: node.id,
          label: node.label,
          owner: owner.id,
          ownerName: owner.name,
          royaltyPct: offer?.royaltyPct ?? NPC_LICENCE_ROYALTY_FLOOR_PCT,
          needed: wanted.has(node.id),
        });
      }
      const ordered = [...candidates.filter((entry) => entry.needed), ...candidates.filter((entry) => !entry.needed)];
      const best = ordered[0];
      if (best === undefined) return { intent: null, reason: 'Nobody else owns a node this company could licence.', ...NOTHING };
      return {
        intent: { type, nodeId: best.nodeId, ownerCompanyId: best.owner, royaltyPct: best.royaltyPct },
        bounds: [percentBound('royaltyPct', 'Royalty', LICENCE_ROYALTY_BOUNDS.min, LICENCE_ROYALTY_BOUNDS.max)],
        targets: ordered.slice(0, 24).map((entry) => ({ id: entry.nodeId, label: `${entry.label} — ${entry.ownerName}` })),
        maxCashUsd: null,
      };
    }

    case 'publish_licence_terms': {
      if (!isNodeEconomyWorld(draft)) return { intent: null, reason: 'Nodes are only owned, and therefore only licensed, in the node economy.', ...NOTHING };
      const owned = ECONOMIC_NODES.filter((node) => ownsNodeOutright(company, node.id));
      // The offer proposed is one this company is not already making, so the
      // probe never suggests the no-op the validator refuses as a duplicate.
      const fresh = owned.find((node) => {
        const offer = licenceOfferOf(company, node.id);
        return offer === null || offer.royaltyPct !== NPC_LICENCE_ROYALTY_FLOOR_PCT || !offer.openToAll;
      });
      if (fresh === undefined) return { intent: null, reason: `${company.name} already publishes terms for everything it owns.`, ...NOTHING };
      return {
        intent: { type, nodeId: fresh.id, royaltyPct: NPC_LICENCE_ROYALTY_FLOOR_PCT, openToAll: true },
        bounds: [percentBound('royaltyPct', 'Royalty', LICENCE_ROYALTY_BOUNDS.min, LICENCE_ROYALTY_BOUNDS.max)],
        targets: owned.slice(0, 24).map((node) => ({ id: node.id, label: node.label })),
        maxCashUsd: null,
      };
    }

    default: {
      // Exhaustive by construction: `ACTION_TYPES` and the switch are the same
      // union, and the compiler proves it here.
      const exhaustive: never = type;
      return { intent: null, reason: `No probe for ${String(exhaustive)}.`, ...NOTHING };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading a clamp back into a bound                                          */
/* -------------------------------------------------------------------------- */

/** Read a dotted path such as `bid.staffCommitment.engineers` off an intent. */
function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split('.')) {
    // Array-element bounds (`allocations[].budgetUsd`) describe a total rather
    // than one slot, so they are never tightened from a clamp.
    if (segment.endsWith('[]')) return undefined;
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Tighten a bound to what the validator actually allowed.
 *
 * Only ever downward: a clamp is the validator saying "not that much", and a
 * bound that grew because of one would be a lie in the direction that matters.
 */
function tightenedBounds(bounds: readonly CosBound[], clamped: ActionIntent | null): CosBound[] {
  if (clamped === null) return [...bounds];
  return bounds.map((bound) => {
    const value = readPath(clamped, bound.field);
    if (typeof value !== 'number' || !Number.isFinite(value)) return bound;
    if (bound.max !== null && value >= bound.max) return bound;
    return { ...bound, max: value };
  });
}

/* -------------------------------------------------------------------------- */
/*  The list                                                                   */
/* -------------------------------------------------------------------------- */

/** Who the availability question is being asked on behalf of. */
export interface AvailabilityActor {
  readonly playerId: string;
  readonly companyId: string;
  readonly characterId: string;
}

/**
 * Every action type, with what this company could do with it right now.
 *
 * Ordered by `ACTION_TYPES`, so the same state always produces the same list in
 * the same order — a dossier is hashed into an `AgentRunRecord`, and a list
 * that reordered itself would make two identical calls look different.
 */
export function availableActionsFor(draft: SessionState, actor: AvailabilityActor): CosAvailableAction[] {
  const validationActor: ValidationActor = {
    playerId: actor.playerId,
    companyId: actor.companyId,
    characterId: actor.characterId,
    // The question is "would this work?", not "has a human confirmed it?" — the
    // confirmation gate is enforced for real on submission, and reporting every
    // always-confirm action as unavailable here would be useless.
    confirmedByHuman: true,
  };

  return ACTION_TYPES.map((type) => {
    const probe = probeFor(type, draft, validationActor);
    const requiresConfirmation = requiresExplicitConfirmation(type);

    if (probe.intent === null) {
      return {
        type,
        available: false,
        reason: probe.reason ?? 'Nothing in this session makes that action possible right now.',
        becomesBoardMatter: false,
        requiresConfirmation,
        bounds: [...probe.bounds],
        targets: [...probe.targets],
        maxCashUsd: probe.maxCashUsd,
      };
    }

    // A fresh budget per probe: these are alternatives the founder might pick
    // between, not a submission where the first spends the second's cash.
    const result = validateAction(draft, probe.intent, validationActor, new BatchBudget(), `probe_${type}`);
    const rejected = result.status === 'rejected';
    const becomesBoardMatter = result.clampedAction?.type === 'submit_board_proposal' && type !== 'submit_board_proposal';

    return {
      type,
      available: !rejected,
      reason: rejected ? (result.reasons[0] ?? 'The validator refused it.') : null,
      becomesBoardMatter,
      requiresConfirmation,
      // A board matter executes nothing this quarter, so its probe's clamps
      // describe a proposal rather than the action; the declared bounds stand.
      bounds: becomesBoardMatter ? [...probe.bounds] : tightenedBounds(probe.bounds, result.clampedAction),
      targets: [...probe.targets],
      maxCashUsd: probe.maxCashUsd,
    };
  });
}

/** Just the types this company could act on today. */
export function availableActionTypes(draft: SessionState, actor: AvailabilityActor): ActionType[] {
  return availableActionsFor(draft, actor)
    .filter((entry) => entry.available)
    .map((entry) => entry.type);
}

/* -------------------------------------------------------------------------- */
/*  Small lookups                                                              */
/* -------------------------------------------------------------------------- */

function nameOfSecurity(draft: SessionState, companyId: string, securityId: string): string {
  const company = draft.companies.find((entry) => entry.id === companyId);
  return company === undefined ? securityId : `${company.name} equity`;
}

function nameOfCharacter(draft: SessionState, characterId: string): string {
  const character = draft.characters.find((entry) => entry.id === characterId);
  return character === undefined ? characterId : character.name;
}

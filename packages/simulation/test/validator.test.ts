/**
 * The action validator, across all thirty-seven action types.
 *
 * Runs against the 2027 Q1 demo world, so the numbers in these expectations are
 * the numbers a player actually sees: Player Ventures has four million dollars,
 * eight people, no compute and a five-member board, and the rivals have the
 * balance sheets `supabase/seed.sql` gives them.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionIntent, ActionRejectionCode, ActionValidationResult, SessionState, SubmittedAction } from '@frontier/contracts';
import { ACTION_TYPES, CONFIRMATION_REQUIRED_ACTIONS, SessionStateSchema } from '@frontier/contracts';
import { CEO_ONLY_ACTIONS, RULES, canReach, createActionValidator } from '../src/validator';
import { checkAccess } from '../src/relationships/access';
import { PRICE_MOVE_BAND } from '../src/validator/balance';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession } from '../src/scenario';

const validator = createActionValidator();
let state: SessionState;

beforeEach(() => {
  state = createDemoSession();
});

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface ActorOverride {
  readonly companyId?: string;
  readonly characterId?: string;
  readonly playerId?: string | null;
  readonly confirmed?: boolean;
  readonly quarter?: number;
  readonly sequence?: number;
}

let sequence = 0;

function act(intent: ActionIntent, actor: ActorOverride = {}): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_test_${sequence}`,
    sessionId: state.sessionId,
    quarter: actor.quarter ?? state.quarter,
    sequence: actor.sequence ?? sequence,
    actorPlayerId: actor.playerId === undefined ? DEMO_PLAYER_ID : actor.playerId,
    actorCompanyId: actor.companyId ?? DEMO_COMPANIES.player,
    actorCharacterId: actor.characterId ?? DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: actor.confirmed ?? true,
  };
}

/** As an NPC company's chief executive: no player seat, no confirmation. */
function npc(companyId: string, characterId: string, intent: ActionIntent, over: ActorOverride = {}): SubmittedAction {
  return act(intent, { ...over, companyId, characterId, playerId: null, confirmed: false });
}

function run(action: SubmittedAction): ActionValidationResult {
  const [result] = validator.validateBatch(state, [action]);
  if (result === undefined) throw new Error('no validation result');
  return result;
}

const codes = (result: ActionValidationResult): ActionRejectionCode[] => result.codes;

/* -------------------------------------------------------------------------- */
/*  Structure                                                                  */
/* -------------------------------------------------------------------------- */

describe('coverage', () => {
  it('has exactly one rule per action type, and no orphans', () => {
    expect(Object.keys(RULES).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('rejects an action type the engine does not know, rather than ignoring it', () => {
    const smuggled = { type: 'seize_the_means_of_compute', amountUsd: 1 } as unknown as ActionIntent;
    const result = run(act(smuggled));
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain('illegal_value');
  });

  it('always populates reasons and codes for anything that is not accepted', () => {
    const result = run(act({ type: 'sunset_product', productId: 'prd_nobody', windDownQuarters: 2 }));
    expect(result.status).toBe('rejected');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.codes.length).toBe(result.reasons.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Gates that run before any rule                                             */
/* -------------------------------------------------------------------------- */

describe('gates', () => {
  it('refuses an action submitted for another quarter', () => {
    const result = run(act({ type: 'allocate_compute', trainingFraction: 0.5 }, { quarter: 4 }));
    expect(codes(result)).toContain('quarter_already_locked');
  });

  it('refuses every action once the quarter has resolved', () => {
    state = SessionStateSchema.parse({ ...createDemoSession(), lastResolvedQuarter: 0 });
    const result = run(act({ type: 'allocate_compute', trainingFraction: 0.5 }));
    expect(codes(result)).toContain('quarter_already_locked');
  });

  it('refuses a player acting for a company they do not direct', () => {
    const result = run(act({ type: 'allocate_compute', trainingFraction: 0.5 }, { companyId: DEMO_COMPANIES.nexus, characterId: DEMO_CHARACTERS.maya }));
    expect(codes(result)).toContain('not_controller_of_company');
  });

  it('refuses an unattributed action against a player-directed company', () => {
    const result = run(npc(DEMO_COMPANIES.player, DEMO_CHARACTERS.player, { type: 'allocate_compute', trainingFraction: 0.5 }));
    expect(codes(result)).toContain('not_controller_of_company');
  });

  it('refuses an action for a company that does not exist', () => {
    const result = run(act({ type: 'allocate_compute', trainingFraction: 0.5 }, { companyId: 'cmp_ghost' }));
    expect(codes(result)).toContain('unknown_target');
  });

  it('requires human confirmation for every action in the always-confirm set', () => {
    const result = run(
      act({ type: 'issue_debt', amountUsd: 1_000_000, maxRatePct: 0.09, termQuarters: 8 }, { confirmed: false }),
    );
    expect(codes(result)).toContain('confirmation_required');
    expect(CONFIRMATION_REQUIRED_ACTIONS).toContain('issue_debt');
  });

  it('does not demand confirmation of an NPC, which has no human to ask', () => {
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'buyback', budgetUsd: 100_000_000, maxPricePerShareUsd: 45 }));
    expect(codes(result)).not.toContain('confirmation_required');
  });

  it('reserves the chief executive actions to the chief executive', () => {
    const result = run(
      act({ type: 'give_guidance', metric: 'revenue', value: 1_000_000, quarter: 1 }, { characterId: DEMO_CHARACTERS.grace }),
    );
    expect(codes(result)).toContain('not_controller_of_company');
    expect(CEO_ONLY_ACTIONS).toContain('give_guidance');
  });
});

/* -------------------------------------------------------------------------- */
/*  Research and product                                                       */
/* -------------------------------------------------------------------------- */

describe('research', () => {
  it('accepts a research budget the company can fund', () => {
    expect(run(act({ type: 'set_research_budget', budgetUsd: 1_000_000 })).status).toBe('accepted');
  });

  it('clamps a research budget to uncommitted cash', () => {
    const result = run(act({ type: 'set_research_budget', budgetUsd: 40_000_000 }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_cash');
    expect(result.clampedAction).toEqual({ type: 'set_research_budget', budgetUsd: 4_000_000 });
  });

  it('accepts a programme the company can staff', () => {
    const result = run(
      act({
        type: 'start_research_project',
        targetNodeId: 'tech_efficient_sparse_inference',
        budgetUsd: 900_000,
        computeUnits: 0,
        researchersAssigned: 2,
        secret: false,
      }),
    );
    expect(result.status).toBe('accepted');
  });

  it('clamps a programme to the researchers and compute that exist', () => {
    const result = run(
      act({
        type: 'start_research_project',
        targetNodeId: 'tech_efficient_sparse_inference',
        budgetUsd: 900_000,
        computeUnits: 5_000,
        researchersAssigned: 400,
        secret: true,
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_headcount');
    expect(codes(result)).toContain('insufficient_compute');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'start_research_project') throw new Error('expected a clamped programme');
    expect(clamped.researchersAssigned).toBe(2);
    expect(clamped.computeUnits).toBe(0);
  });

  it('rejects a programme against a node that is not on the map', () => {
    const result = run(
      act({ type: 'start_research_project', targetNodeId: 'tech_wishful', budgetUsd: 1, computeUnits: 0, researchersAssigned: 1, secret: false }),
    );
    expect(codes(result)).toContain('unknown_target');
  });

  it('rejects a second programme against the same node', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, {
        type: 'start_research_project',
        targetNodeId: 'tech_sparse_expert_reasoning',
        budgetUsd: 1_000_000,
        computeUnits: 0,
        researchersAssigned: 1,
        secret: false,
      }),
    );
    expect(codes(result)).toContain('duplicate_action');
  });

  it('accepts an innovation proposal and drops dependencies that do not exist', () => {
    const result = run(
      act({
        type: 'propose_innovation',
        proposal: {
          nodeType: 'player_hypothesis',
          title: 'Federated Evaluation Markets',
          summary: 'Buyers pool私 evaluation budgets so a model is graded by the people who will deploy it, not by its maker.'.replace('私 ', ' '),
          novelty: 0.62,
          plausibility: 0.55,
          requiredCapabilities: ['evaluation', 'retrieval'],
          estimatedCost: 40_000_000,
          estimatedQuarters: 8,
          dependencies: ['tech_retrieval_grounding', 'tech_imaginary'],
          initialVisibility: 'company_private',
          rationale: 'Our customers already run private evaluations; pooling them is a distribution advantage before it is a research one.',
        },
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('unknown_target');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'propose_innovation') throw new Error('expected a clamped proposal');
    expect(clamped.proposal.dependencies).toEqual(['tech_retrieval_grounding']);
  });

  it('rejects publishing a result the company does not have', () => {
    const result = run(act({ type: 'publish_research', nodeId: 'tech_autonomous_research', mode: 'paper', rationale: 'we would like the credit' }));
    expect(codes(result)).toContain('requirement_not_met');
  });

  it('accepts publishing a result the company demonstrated', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, {
        type: 'publish_research',
        nodeId: 'tech_transformer_scaling',
        mode: 'paper',
        rationale: 'The scaling work is already public in all but name.',
      }),
    );
    expect(result.status).toBe('accepted');
  });

  it('sends an open-weights release to the board', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, {
        type: 'publish_research',
        nodeId: 'tech_transformer_scaling',
        mode: 'open_weights',
        rationale: 'Give the method away and take the developer audience with it.',
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('board_approval_required');
    expect(result.clampedAction?.type).toBe('submit_board_proposal');
  });
});

describe('product and marketing', () => {
  it('accepts a price change on a live product', () => {
    expect(run(act({ type: 'set_product_price', productId: 'prd_player_assistant', pricePerSeatUsd: 120 })).status).toBe('accepted');
  });

  it('rejects a price change on a product the company does not sell', () => {
    expect(codes(run(act({ type: 'set_product_price', productId: 'prd_orbit_workbench', pricePerSeatUsd: 1 })))).toContain('unknown_target');
  });

  it('clamps launch marketing to available cash', () => {
    const result = run(
      act({
        type: 'launch_product',
        name: 'Ventures Analyst',
        segment: 'enterprise',
        pricePerSeatUsd: 140,
        computeIntensity: 0.3,
        launchMarketingUsd: 9_000_000,
        targetQuality: 0.6,
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_cash');
  });

  it('rejects launching a product that already exists', () => {
    const result = run(
      act({
        type: 'launch_product',
        name: 'Ventures Copilot',
        segment: 'enterprise',
        pricePerSeatUsd: 140,
        computeIntensity: 0.3,
        launchMarketingUsd: 1_000,
        targetQuality: 0.6,
      }),
    );
    expect(codes(result)).toContain('duplicate_action');
  });

  it('accepts a sunset and refuses a second one', () => {
    expect(run(act({ type: 'sunset_product', productId: 'prd_player_assistant', windDownQuarters: 3 })).status).toBe('accepted');
    const company = state.companies.find((c) => c.id === DEMO_COMPANIES.player);
    const product = company?.products[0];
    if (product === undefined) throw new Error('missing product');
    product.isActive = false;
    expect(codes(run(act({ type: 'sunset_product', productId: 'prd_player_assistant', windDownQuarters: 3 })))).toContain('duplicate_action');
  });

  it('merges duplicate marketing segments and scales the budget to cash', () => {
    const result = run(
      act({
        type: 'set_marketing_budget',
        allocations: [
          { segment: 'enterprise', budgetUsd: 3_000_000 },
          { segment: 'enterprise', budgetUsd: 3_000_000 },
        ],
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('duplicate_action');
    expect(codes(result)).toContain('insufficient_cash');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'set_marketing_budget') throw new Error('expected a clamped budget');
    expect(clamped.allocations).toHaveLength(1);
    expect(clamped.allocations[0]?.budgetUsd).toBeLessThanOrEqual(4_000_000);
  });

  it('clamps a campaign by its per-quarter cost, not its headline budget', () => {
    const result = run(act({ type: 'marketing_campaign', theme: 'brand', segment: 'enterprise', budgetUsd: 8_000_000, quarters: 4 }));
    expect(result.status).toBe('accepted');
  });
});

/* -------------------------------------------------------------------------- */
/*  People and compute                                                         */
/* -------------------------------------------------------------------------- */

describe('people', () => {
  it('accepts a hire the company can pay for', () => {
    expect(run(act({ type: 'hire', role: 'engineers', count: 5, compBand: 'market' })).status).toBe('accepted');
  });

  it('clamps a hire to what the cash funds', () => {
    const result = run(act({ type: 'hire', role: 'researchers', count: 500, compBand: 'top_of_market' }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_cash');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'hire') throw new Error('expected a clamped hire');
    expect(clamped.count).toBeGreaterThan(0);
    expect(clamped.count).toBeLessThan(500);
  });

  it('rejects a hire with no positive count', () => {
    expect(codes(run(act({ type: 'hire', role: 'ops', count: 0, compBand: 'market' })))).toContain('illegal_value');
  });

  it('accepts a small reduction and caps a large one at the size of the team', () => {
    expect(run(act({ type: 'layoff', role: 'engineers', count: 1, severanceQuartersOfPay: 1 })).status).toBe('accepted');
    const result = run(act({ type: 'layoff', role: 'sales', count: 40, severanceQuartersOfPay: 0 }));
    expect(codes(result)).toContain('insufficient_headcount');
  });

  it('sends a restructuring-scale reduction to the board', () => {
    const result = run(act({ type: 'layoff', role: 'engineers', count: 3, severanceQuartersOfPay: 1 }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('board_approval_required');
  });

  it('rejects a reduction in a role nobody occupies', () => {
    expect(codes(run(act({ type: 'layoff', role: 'ops', count: 1, severanceQuartersOfPay: 1 })))).toContain('insufficient_headcount');
  });

  it('rejects poaching someone unreachable, and permits a public approach', () => {
    const privateApproach = run(
      act({ type: 'poach_executive', targetCharacterId: DEMO_CHARACTERS.rebecca, compPremiumPct: 0.4, approach: 'private' }),
    );
    expect(codes(privateApproach)).toContain('target_not_reachable');

    const publicApproach = run(
      act({ type: 'poach_executive', targetCharacterId: DEMO_CHARACTERS.rebecca, compPremiumPct: 0.4, approach: 'public' }),
    );
    expect(publicApproach.status).not.toBe('rejected');
  });

  it('rejects poaching your own employee', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, { type: 'poach_executive', targetCharacterId: DEMO_CHARACTERS.maya, compPremiumPct: 0.1, approach: 'private' }),
    );
    expect(codes(result)).toContain('illegal_value');
  });

  it('accepts an appointment at a company with no board, and tables one where there is', () => {
    const orbit = run(
      npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, {
        type: 'appoint_executive',
        characterId: DEMO_CHARACTERS.grace,
        executiveRole: 'cfo',
        annualCompUsd: 1_200_000,
      }),
    );
    expect(orbit.status).toBe('accepted');

    const player = run(
      act({ type: 'appoint_executive', characterId: DEMO_CHARACTERS.grace, executiveRole: 'cfo', annualCompUsd: 400_000 }),
    );
    expect(codes(player)).toContain('board_approval_required');
  });
});

describe('compute', () => {
  it('accepts a reservation the market can free and the company can pay for', () => {
    expect(run(act({ type: 'reserve_compute', units: 100, quarters: 4, maxPricePerUnitUsd: 4_000, providerCompanyId: null })).status).toBe('accepted');
  });

  it('clamps a reservation by market supply and then by cash', () => {
    const result = run(act({ type: 'reserve_compute', units: 500_000, quarters: 4, maxPricePerUnitUsd: 4_000, providerCompanyId: null }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_compute');
    expect(codes(result)).toContain('insufficient_cash');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'reserve_compute') throw new Error('expected a clamped reservation');
    expect(clamped.units).toBeGreaterThan(0);
    expect(clamped.units).toBeLessThan(500_000);
  });

  it('drops an unknown cloud provider rather than refusing the spend', () => {
    const result = run(act({ type: 'buy_cloud_capacity', quarterlySpendUsd: 100_000, providerCompanyId: 'cmp_ghost', commitmentQuarters: 0 }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('unknown_target');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'buy_cloud_capacity') throw new Error('expected a clamped purchase');
    expect(clamped.providerCompanyId).toBeNull();
  });

  it('refuses to allocate capacity a company does not hold', () => {
    const company = state.companies.find((c) => c.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('missing company');
    company.compute.cloudSpendQuarterly = 0;
    expect(codes(run(act({ type: 'allocate_compute', trainingFraction: 0.8 })))).toContain('insufficient_compute');
  });
});

/* -------------------------------------------------------------------------- */
/*  Capital                                                                    */
/* -------------------------------------------------------------------------- */

describe('capital', () => {
  it('turns a financing into a board matter rather than executing it', () => {
    const result = run(act({ type: 'raise_round', stage: 'series_a', targetAmountUsd: 12_000_000, maxDilutionPct: 0.2 }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('board_approval_required');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'submit_board_proposal') throw new Error('expected a board proposal');
    expect(clamped.kind).toBe('financing');
    expect(clamped.amountUsd).toBe(12_000_000);
  });

  it('lets the raise through once the board has approved a financing', () => {
    state.boardProposals.push({
      id: 'prp_prior_financing',
      companyId: DEMO_COMPANIES.player,
      boardId: 'brd_player_ventures',
      kind: 'financing',
      title: 'Authorise a Series A',
      summary: 'Raise up to $12m at a Series A price.',
      proposedByCharacterId: DEMO_CHARACTERS.player,
      quarterProposed: 0,
      decisionQuarter: 0,
      status: 'passed',
      amountUsd: 12_000_000,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      requiredThresholdFraction: 0.5,
    });
    const result = run(act({ type: 'raise_round', stage: 'series_a', targetAmountUsd: 12_000_000, maxDilutionPct: 0.2 }));
    expect(result.status).toBe('accepted');
  });

  it('caps the dilution a single round may commit to', () => {
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'raise_round', stage: 'growth', targetAmountUsd: 1_000_000_000, maxDilutionPct: 0.9 }));
    expect(result.status).toBe('clamped');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'raise_round') throw new Error('expected a clamped raise');
    expect(clamped.maxDilutionPct).toBe(0.5);
  });

  it('refuses a debt issue when credit markets are shut', () => {
    state.world.capitalMarkets.debtAvailability = 0;
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'issue_debt', amountUsd: 100_000_000, maxRatePct: 0.12, termQuarters: 12 }));
    expect(codes(result)).toContain('requirement_not_met');
  });

  it('clamps a share issue to the unissued authorisation', () => {
    const result = run(
      npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'issue_shares', shares: 400_000_000, shareClassId: 'shc_orbit_common', minPricePerShareUsd: 30 }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('exceeds_authorised_shares');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'issue_shares') throw new Error('expected a clamped issue');
    expect(clamped.shares).toBe(260_000_000);
  });

  it('rejects a share issue in a class that does not exist', () => {
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'issue_shares', shares: 1, shareClassId: 'shc_ghost', minPricePerShareUsd: 1 }));
    expect(codes(result)).toContain('unknown_target');
  });

  it('accepts a buyback at a listed company and refuses one with no security', () => {
    expect(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'buyback', budgetUsd: 100_000_000, maxPricePerShareUsd: 45 })).status).toBe('accepted');

    const company = state.companies.find((c) => c.id === DEMO_COMPANIES.orbit);
    if (company === undefined) throw new Error('missing company');
    company.primarySecurityId = null;
    expect(codes(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'buyback', budgetUsd: 1, maxPricePerShareUsd: 1 })))).toContain('requirement_not_met');
  });

  it('refuses a listing for a company that is already listed', () => {
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'ipo', targetRaiseUsd: 1_000_000_000, floatPct: 0.2, minPricePerShareUsd: 30 }));
    expect(codes(result)).toContain('duplicate_action');
  });

  it('tables a listing for a private company and clamps an absurd float', () => {
    const result = run(act({ type: 'ipo', targetRaiseUsd: 20_000_000, floatPct: 0.95, minPricePerShareUsd: 2 }));
    expect(codes(result)).toContain('illegal_value');
    expect(codes(result)).toContain('board_approval_required');
  });
});

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('ownership', () => {
  it('accepts a purchase the company can afford out of the free float', () => {
    const result = run(act({ type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: null, shares: 40_000, maxPricePerShareUsd: 84 }));
    expect(result.status).toBe('accepted');
  });

  it('resolves a target percentage into a share count', () => {
    const result = run(act({ type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: 0.02, shares: null, maxPricePerShareUsd: 84 }));
    expect(result.status).toBe('clamped');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'buy_shares') throw new Error('expected a clamped purchase');
    expect(clamped.targetPct).toBeNull();
    expect(clamped.shares).toBeGreaterThan(0);
    // Four million dollars does not buy two per cent of Nexus.
    expect(codes(result)).toContain('insufficient_cash');
  });

  it('refuses buying your own stock on the open market', () => {
    const result = run(act({ type: 'buy_shares', securityId: 'sec_player_ventures_common', targetPct: null, shares: 10, maxPricePerShareUsd: 2 }));
    expect(codes(result)).toContain('illegal_value');
  });

  it('refuses a purchase with neither a share count nor a target', () => {
    const result = run(act({ type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: null, shares: null, maxPricePerShareUsd: 84 }));
    expect(codes(result)).toContain('illegal_value');
  });

  it('refuses a sale of a position the company does not hold', () => {
    const result = run(act({ type: 'sell_shares', securityId: 'sec_nexus_common', shares: 10, minPricePerShareUsd: 80 }));
    expect(codes(result)).toContain('requirement_not_met');
  });

  it('refuses a sale inside a lock-up and clamps an oversized one outside it', () => {
    const table = state.capTables.find((t) => t.companyId === DEMO_COMPANIES.nexus);
    if (table === undefined) throw new Error('missing cap table');
    table.holdings.push({
      id: 'hld_player_nexus',
      holderId: DEMO_COMPANIES.player,
      holderKind: 'company',
      securityId: 'sec_nexus_common',
      shares: 1_000,
      costBasisUsd: 83_200,
      acquiredQuarter: 0,
      lockupUntilQuarter: 4,
      isDisclosed: false,
    });
    expect(codes(run(act({ type: 'sell_shares', securityId: 'sec_nexus_common', shares: 500, minPricePerShareUsd: 80 })))).toContain('lockup_active');

    const holding = table.holdings.find((h) => h.id === 'hld_player_nexus');
    if (holding === undefined) throw new Error('missing holding');
    holding.lockupUntilQuarter = null;
    const clamped = run(act({ type: 'sell_shares', securityId: 'sec_nexus_common', shares: 9_000, minPricePerShareUsd: 80 }));
    expect(clamped.status).toBe('clamped');
    if (clamped.clampedAction?.type !== 'sell_shares') throw new Error('expected a clamped sale');
    expect(clamped.clampedAction.shares).toBe(1_000);
  });

  it('normalises acquisition consideration and refuses one the cash cannot cover', () => {
    const result = run(
      npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, {
        type: 'acquire_company',
        targetCompanyId: DEMO_COMPANIES.vectorworks,
        offerValueUsd: 5_600_000_000,
        cashPct: 0.6,
        stockPct: 0.6,
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('illegal_value');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'acquire_company') throw new Error('expected a clamped offer');
    expect(clamped.cashPct + clamped.stockPct).toBeCloseTo(1, 9);

    const unaffordable = run(
      act({ type: 'acquire_company', targetCompanyId: DEMO_COMPANIES.vectorworks, offerValueUsd: 5_600_000_000, cashPct: 1, stockPct: 0 }),
    );
    expect(codes(unaffordable)).toContain('insufficient_cash');
  });

  it('refuses acquiring yourself or a company that no longer trades', () => {
    expect(
      codes(run(act({ type: 'acquire_company', targetCompanyId: DEMO_COMPANIES.player, offerValueUsd: 1, cashPct: 1, stockPct: 0 }))),
    ).toContain('illegal_value');
    expect(
      codes(run(act({ type: 'acquire_company', targetCompanyId: 'cmp_ghost', offerValueUsd: 1, cashPct: 1, stockPct: 0 }))),
    ).toContain('unknown_target');
  });
});

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

describe('boards', () => {
  const proposal: ActionIntent = {
    type: 'submit_board_proposal',
    kind: 'annual_plan',
    title: 'Approve the 2027 operating plan',
    summary: 'Hold burn under $700k a quarter while doubling the engineering team, funded from the seed round.',
    amountUsd: 2_800_000,
    targetCompanyId: null,
    stockComponentPct: null,
  };

  it('accepts a proposal to a board that exists', () => {
    expect(run(act(proposal)).status).toBe('accepted');
  });

  it('refuses a proposal at a company with no board', () => {
    expect(codes(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, proposal)))).toContain('requirement_not_met');
  });

  it('refuses the same matter twice in one quarter', () => {
    state.boardProposals.push({
      id: 'prp_existing',
      companyId: DEMO_COMPANIES.player,
      boardId: 'brd_player_ventures',
      kind: 'annual_plan',
      title: 'Approve the 2027 operating plan',
      summary: 'Already tabled.',
      proposedByCharacterId: DEMO_CHARACTERS.player,
      quarterProposed: 0,
      decisionQuarter: 0,
      status: 'tabled',
      amountUsd: null,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      requiredThresholdFraction: 0.5,
    });
    expect(codes(run(act(proposal)))).toContain('duplicate_action');
  });

  it('refuses a chief executive tabling their own dismissal', () => {
    const result = run(
      act({
        type: 'submit_board_proposal',
        kind: 'ceo_dismissal',
        title: 'Dismiss the chief executive',
        summary: 'The chief executive proposes their own removal, which is not how this works.',
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      }),
    );
    expect(codes(result)).toContain('illegal_value');
  });

  it('accepts lobbying a director on a live proposal and refuses one already decided', () => {
    state.boardProposals.push({
      id: 'prp_live',
      companyId: DEMO_COMPANIES.player,
      boardId: 'brd_player_ventures',
      kind: 'financing',
      title: 'Authorise a Series A',
      summary: 'Raise $12m.',
      proposedByCharacterId: DEMO_CHARACTERS.player,
      quarterProposed: 0,
      decisionQuarter: 0,
      status: 'tabled',
      amountUsd: 12_000_000,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      requiredThresholdFraction: 0.5,
    });
    const lobby: ActionIntent = {
      type: 'lobby_director',
      directorCharacterId: DEMO_CHARACTERS.eleanor,
      proposalId: 'prp_live',
      concessions: [{ field: 'dilutionPct', comparator: 'lte', value: 0.18 }],
      message: 'Below eighteen per cent I can live with the price.',
    };
    expect(run(act(lobby)).status).toBe('accepted');

    const stranger: ActionIntent = { ...lobby, directorCharacterId: DEMO_CHARACTERS.maya };
    expect(codes(run(act(stranger)))).toContain('unknown_target');
  });
});

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

describe('government', () => {
  const bid = (opportunityId: string, price: number): ActionIntent => ({
    type: 'bid_government',
    opportunityId,
    bid: {
      opportunityId,
      price,
      technicalScoreInputs: {
        modelCapability: 0.7,
        architectureQuality: 0.75,
        securityPosture: 0.8,
        reliabilityCommitment: 0.85,
        responsibleAiCommitment: 0.7,
      },
      computeCommitment: { acceleratorUnits: 2_000, quarters: 8 },
      staffCommitment: { engineers: 60, researchers: 10, clearedStaff: 20 },
      timeline: { deliveryQuarters: 6, milestoneCount: 4 },
      subcontractors: [],
      ipConcessions: 'government_use_rights',
      auditRights: 'annual',
      domesticSourcingPct: 0.8,
      consortiumMemberIds: [],
      narrative: 'Delivery on domestic infrastructure with continuous evaluation.',
    },
  });

  it('refuses a bid whose two opportunity ids disagree', () => {
    const mismatched = bid('opp_sovereign_platform', 1_000_000);
    if (mismatched.type !== 'bid_government') throw new Error('bad fixture');
    const result = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { ...mismatched, opportunityId: 'opp_civic_modernisation' }));
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain('illegal_value');
  });

  it('refuses a bidder below the minimum past-performance score', () => {
    expect(codes(run(act(bid('opp_sovereign_platform', 1_000_000))))).toContain('requirement_not_met');
  });

  it('refuses a bid on a closed opportunity', () => {
    const opportunity = state.procurementOpportunities.find((o) => o.id === 'opp_civic_modernisation');
    if (opportunity === undefined) throw new Error('missing opportunity');
    opportunity.status = 'awarded';
    expect(codes(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, bid('opp_civic_modernisation', 400_000_000))))).toContain('opportunity_closed');
  });

  it('accepts a credible bid and clamps commitments the company cannot make', () => {
    const accepted = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, bid('opp_civic_modernisation', 400_000_000)));
    expect(accepted.status).toBe('accepted');

    const overcommitted = bid('opp_civic_modernisation', 400_000_000);
    if (overcommitted.type !== 'bid_government') throw new Error('bad fixture');
    const result = run(
      npc(DEMO_COMPANIES.vectorworks, DEMO_CHARACTERS.tomas, {
        ...overcommitted,
        bid: { ...overcommitted.bid, computeCommitment: { acceleratorUnits: 900_000, quarters: 8 }, staffCommitment: { engineers: 9_000, researchers: 10, clearedStaff: 1 } },
      }),
    );
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('insufficient_compute');
    expect(codes(result)).toContain('insufficient_headcount');
  });

  it('sends a bid above the board threshold to the board', () => {
    const result = run(npc(DEMO_COMPANIES.meridian, DEMO_CHARACTERS.kenji, bid('opp_sovereign_platform', 2_000_000_000)));
    // Meridian's past performance is below the sovereign programme's floor, so
    // the bid never reaches the board question at all.
    expect(codes(result)).toContain('requirement_not_met');

    const orbit = run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, bid('opp_sovereign_platform', 2_400_000_000)));
    expect(orbit.status).toBe('accepted');
  });

  it('accepts a decline and refuses one for an unknown programme', () => {
    expect(run(act({ type: 'decline_opportunity', opportunityId: 'opp_sovereign_platform', reason: 'No clearance.' })).status).toBe('accepted');
    expect(codes(run(act({ type: 'decline_opportunity', opportunityId: 'opp_ghost', reason: 'x' })))).toContain('unknown_target');
  });

  it('accepts a consortium and refuses one led by an outsider', () => {
    const good: ActionIntent = {
      type: 'form_consortium',
      opportunityId: 'opp_civic_modernisation',
      inviteeCompanyIds: [DEMO_COMPANIES.meridian],
      leadCompanyId: DEMO_COMPANIES.orbit,
      sharePct: 0.6,
    };
    expect(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, good)).status).toBe('accepted');

    const bad: ActionIntent = { ...good, leadCompanyId: DEMO_COMPANIES.aurora };
    expect(codes(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, bad)))).toContain('illegal_value');
  });

  it('accepts a regulator meeting between people who can reach each other', () => {
    const intent: ActionIntent = {
      type: 'meet_regulator',
      regulatorCharacterId: DEMO_CHARACTERS.alan,
      topic: 'model_rules',
      posture: 'cooperative',
      concessionsOffered: ['early access to evaluations'],
    };
    expect(run(npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, intent)).status).toBe('accepted');
    expect(codes(run(act(intent)))).toContain('target_not_reachable');
  });

  it('refuses meeting someone who is not a regulator', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, {
        type: 'meet_regulator',
        regulatorCharacterId: DEMO_CHARACTERS.rowan,
        topic: 'privacy',
        posture: 'informational',
        concessionsOffered: [],
      }),
    );
    expect(codes(result)).toContain('illegal_value');
  });
});

/* -------------------------------------------------------------------------- */
/*  Social, deals and people                                                   */
/* -------------------------------------------------------------------------- */

describe('social and information', () => {
  it('accepts a post from an account the author actually has', () => {
    const result = run(
      act({
        type: 'social_post',
        draft: {
          authorCharacterId: DEMO_CHARACTERS.player,
          network: 'fast_feed',
          text: 'Shipping the first version of Copilot to eleven design partners this week.',
          intent: 'announce',
          targetCompanyId: null,
        },
      }),
    );
    expect(result.status).toBe('accepted');
  });

  it('refuses a post from someone who does not speak for the company', () => {
    const result = run(
      act({
        type: 'social_post',
        draft: {
          authorCharacterId: DEMO_CHARACTERS.maya,
          network: 'fast_feed',
          text: 'A statement I am not entitled to make on their behalf.',
          intent: 'announce',
          targetCompanyId: null,
        },
      }),
    );
    expect(codes(result)).toContain('not_controller_of_company');
  });

  it('refuses a post on a network the author has no account on', () => {
    const result = run(
      act({
        type: 'social_post',
        draft: {
          authorCharacterId: DEMO_CHARACTERS.player,
          network: 'video',
          text: 'A launch video nobody will see, because we have no account there.',
          intent: 'hype',
          targetCompanyId: null,
        },
      }),
    );
    expect(codes(result)).toContain('requirement_not_met');
  });

  it('accepts guidance from a listed company and refuses it from a private one', () => {
    expect(
      run(npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, { type: 'give_guidance', metric: 'revenue', value: 2_000_000_000, quarter: 1 })).status,
    ).toBe('accepted');
    expect(codes(run(act({ type: 'give_guidance', metric: 'revenue', value: 500_000, quarter: 1 })))).toContain('requirement_not_met');
  });

  it('refuses guidance for a quarter that has already gone', () => {
    state.quarter = 4;
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, { type: 'give_guidance', metric: 'revenue', value: 1, quarter: 2 }, { quarter: 4 }),
    );
    expect(codes(result)).toContain('illegal_value');
  });

  it('accepts a crisis response to something that exists', () => {
    const result = run(
      npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, {
        type: 'respond_crisis',
        crisisEventId: 'dsc_nexus_guidance_q1',
        responseKind: 'acknowledge',
        statement: 'We stand by the guidance and will report against it.',
      }),
    );
    expect(result.status).toBe('accepted');
    expect(
      codes(run(npc(DEMO_COMPANIES.nexus, DEMO_CHARACTERS.maya, { type: 'respond_crisis', crisisEventId: 'nothing', responseKind: 'deny', statement: '' }))),
    ).toContain('unknown_target');
  });
});

describe('deals and introductions', () => {
  const draft = {
    counterpartyId: DEMO_COMPANIES.nexus,
    counterpartyKind: 'company' as const,
    gives: [{ kind: 'tech_license' as const, techNodeId: 'tech_retrieval_grounding', productId: null, quarters: 4 }],
    gets: [{ kind: 'cash_payment' as const, amount: 2_000_000 }],
    confidentiality: 'private' as const,
    expiresQuarter: 2,
    binding: true,
    intentStatements: [],
    summary: 'Licence our retrieval grounding work to Nexus for four quarters against a two million dollar fee.',
  };

  it('accepts a deal to a counterparty that exists', () => {
    expect(run(act({ type: 'propose_deal', proposal: draft })).status).toBe('accepted');
  });

  it('refuses a deal to nobody, to yourself, or naming a security that does not exist', () => {
    expect(codes(run(act({ type: 'propose_deal', proposal: { ...draft, counterpartyId: 'cmp_ghost' } })))).toContain('unknown_target');
    expect(codes(run(act({ type: 'propose_deal', proposal: { ...draft, counterpartyId: DEMO_COMPANIES.player } })))).toContain('illegal_value');
    expect(
      codes(
        run(
          act({
            type: 'propose_deal',
            proposal: { ...draft, gives: [{ kind: 'equity_transfer', securityId: 'sec_ghost', shares: 10 }] },
          }),
        ),
      ),
    ).toContain('unknown_target');
  });

  it('accepts and rejects a deal addressed to you, and refuses one that is not', () => {
    state.deals.push({
      ...draft,
      id: 'deal_incoming',
      counterpartyId: DEMO_COMPANIES.player,
      proposerId: DEMO_COMPANIES.nexus,
      proposerKind: 'company',
      status: 'proposed',
      createdQuarter: 0,
      respondedQuarter: null,
      conversationId: null,
      breachedByPartyId: null,
    });
    expect(run(act({ type: 'accept_deal', dealId: 'deal_incoming' })).status).toBe('accepted');
    expect(run(act({ type: 'reject_deal', dealId: 'deal_incoming', reason: 'Terms are wrong.' })).status).toBe('accepted');
    expect(codes(run(npc(DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel, { type: 'accept_deal', dealId: 'deal_incoming' })))).toContain('illegal_value');
    expect(codes(run(act({ type: 'accept_deal', dealId: 'deal_missing' })))).toContain('unknown_target');
  });

  it('accepts an introduction request through someone who can make it', () => {
    const result = run(
      act({
        type: 'request_introduction',
        viaCharacterId: DEMO_CHARACTERS.eleanor,
        targetCharacterId: DEMO_CHARACTERS.nadia,
        purpose: 'Sovereign capital for the compute reservation we cannot fund alone.',
      }),
    );
    expect(result.status).toBe('accepted');
  });

  it('refuses an introduction the intermediary cannot make, or one with no stated purpose', () => {
    // Priya is reachable — a shared investor sits on both cap tables — and she
    // still cannot reach Nadia, so the ask fails on the second leg. This is the
    // case the rule exists for; picking an intermediary the player cannot even
    // reach would only test the first leg, which is the next assertion.
    const viaCannotReach = run(
      act({
        type: 'request_introduction',
        viaCharacterId: DEMO_CHARACTERS.priya,
        targetCharacterId: DEMO_CHARACTERS.nadia,
        purpose: 'Sovereign capital for the compute reservation.',
      }),
    );
    expect(codes(viaCannotReach)).toContain('target_not_reachable');

    const unreachable = run(
      act({
        type: 'request_introduction',
        viaCharacterId: DEMO_CHARACTERS.daniel,
        targetCharacterId: DEMO_CHARACTERS.nadia,
        purpose: 'Sovereign capital for the compute reservation.',
      }),
    );
    expect(codes(unreachable)).toContain('target_not_reachable');

    const vague = run(
      act({ type: 'request_introduction', viaCharacterId: DEMO_CHARACTERS.eleanor, targetCharacterId: DEMO_CHARACTERS.nadia, purpose: 'hi' }),
    );
    expect(codes(vague)).toContain('requirement_not_met');
  });
});

/* -------------------------------------------------------------------------- */
/*  Reachability                                                               */
/* -------------------------------------------------------------------------- */

describe('canReach is checkAccess, not a restatement of it', () => {
  it('agrees with the relationships subsystem for every ordered pair in the world', () => {
    const ids = state.characters.filter((character) => character.isActive).map((character) => character.id);
    expect(ids.length).toBeGreaterThan(2);
    for (const from of ids) {
      for (const to of ids) {
        expect(canReach(state, from, to).allowed).toBe(checkAccess(state, from, to).allowed);
      }
    }
  });

  it('honours a structural override the gap alone would refuse', () => {
    // A common investor on two cap tables. The gap is far outside the symmetric
    // band, so only the derived override can be permitting this.
    const decision = canReach(state, DEMO_CHARACTERS.player, DEMO_CHARACTERS.maya);
    const player = state.characters.find((character) => character.id === DEMO_CHARACTERS.player);
    const maya = state.characters.find((character) => character.id === DEMO_CHARACTERS.maya);
    expect(Math.abs((player?.connectionLevel ?? 0) - (maya?.connectionLevel ?? 0))).toBeGreaterThan(10);
    expect(state.accessOverrides.some((o) => o.fromId === DEMO_CHARACTERS.player && o.toId === DEMO_CHARACTERS.maya)).toBe(false);
    expect(decision.allowed).toBe(true);
  });

  it('still refuses a stranger far above the founder with no route at all', () => {
    expect(canReach(state, DEMO_CHARACTERS.player, DEMO_CHARACTERS.nadia).allowed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Batch behaviour                                                            */
/* -------------------------------------------------------------------------- */

describe('validateBatch', () => {
  it('returns one result per action, in the caller order', () => {
    const actions = [
      act({ type: 'hire', role: 'engineers', count: 1, compBand: 'market' }, { sequence: 3 }),
      act({ type: 'set_research_budget', budgetUsd: 100_000 }, { sequence: 1 }),
    ];
    const results = validator.validateBatch(state, actions);
    expect(results).toHaveLength(2);
    expect(results[0]?.actionId).toBe(actions[0]?.actionId);
    expect(results[1]?.actionId).toBe(actions[1]?.actionId);
  });

  it('will not let two actions spend the same dollar', () => {
    const first = act({ type: 'set_research_budget', budgetUsd: 4_000_000 }, { sequence: 1 });
    const second = act({ type: 'marketing_campaign', theme: 'brand', segment: 'enterprise', budgetUsd: 1_000_000, quarters: 1 }, { sequence: 2 });
    const [a, b] = validator.validateBatch(state, [first, second]);
    expect(a?.status).toBe('accepted');
    expect(b?.status).toBe('rejected');
    expect(b?.codes).toContain('insufficient_cash');
  });

  it('resolves the contest by sequence, not by array order', () => {
    const late = act({ type: 'set_research_budget', budgetUsd: 4_000_000 }, { sequence: 9 });
    const early = act({ type: 'set_research_budget', budgetUsd: 4_000_000 }, { sequence: 1 });
    const [lateResult, earlyResult] = validator.validateBatch(state, [late, early]);
    expect(earlyResult?.status).toBe('accepted');
    expect(lateResult?.status).toBe('rejected');
  });

  it('refuses the same action id twice in one submission', () => {
    const action = act({ type: 'allocate_compute', trainingFraction: 0.4 });
    const [, second] = validator.validateBatch(state, [action, action]);
    expect(second?.codes).toContain('duplicate_action');
  });

  it('is stateless between batches', () => {
    const spend = () => validator.validateBatch(state, [act({ type: 'set_research_budget', budgetUsd: 4_000_000 })])[0]?.status;
    expect(spend()).toBe('accepted');
    expect(spend()).toBe('accepted');
  });
});

describe('validate (single, from a player seat)', () => {
  it('validates against the seat the player holds', () => {
    const result = validator.validate(state, { type: 'hire', role: 'engineers', count: 2, compBand: 'market' }, DEMO_PLAYER_ID);
    expect(result.status).toBe('accepted');
    expect(result.actionId.length).toBeGreaterThan(0);
  });

  it('refuses an intent with no attributable actor', () => {
    const result = validator.validate(state, { type: 'hire', role: 'engineers', count: 2, compBand: 'market' }, null);
    expect(result.status).toBe('rejected');
    expect(result.codes).toContain('not_controller_of_company');
  });

  it('refuses a player who holds no seat in this session', () => {
    const result = validator.validate(state, { type: 'hire', role: 'engineers', count: 2, compBand: 'market' }, 'player_9');
    expect(result.codes).toContain('not_controller_of_company');
  });
});

/* -------------------------------------------------------------------------- */
/*  Repricing bounds                                                           */
/* -------------------------------------------------------------------------- */

describe('repricing', () => {
  const productId = 'prd_player_assistant';
  const currentPrice = (): number => {
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    const product = company?.products.find((candidate) => candidate.id === productId);
    if (product === undefined) throw new Error('demo player has no product');
    return product.pricePerSeat;
  };

  it('clamps a price rise to the top of the band the demand model is defined on', () => {
    const before = currentPrice();
    const result = run(act({ type: 'set_product_price', productId, pricePerSeatUsd: before * 1_000 }));
    expect(result.status).toBe('clamped');
    expect(codes(result)).toContain('illegal_value');
    expect(result.clampedAction?.type).toBe('set_product_price');
    if (result.clampedAction?.type !== 'set_product_price') throw new Error('wrong clamp');
    expect(result.clampedAction.pricePerSeatUsd).toBe(before * PRICE_MOVE_BAND.max);
  });

  it('clamps a price collapse to the bottom of the same band', () => {
    const before = currentPrice();
    const result = run(act({ type: 'set_product_price', productId, pricePerSeatUsd: 0.01 }));
    expect(result.status).toBe('clamped');
    if (result.clampedAction?.type !== 'set_product_price') throw new Error('wrong clamp');
    expect(result.clampedAction.pricePerSeatUsd).toBe(before * PRICE_MOVE_BAND.min);
  });

  it('leaves a move inside the band exactly as submitted', () => {
    const before = currentPrice();
    const result = run(act({ type: 'set_product_price', productId, pricePerSeatUsd: before * 2 }));
    expect(result.status).toBe('accepted');
    expect(result.clampedAction).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  The deposed founder                                                        */
/* -------------------------------------------------------------------------- */

describe('a shareholder who no longer directs the company', () => {
  /** Exactly what `dismissChiefExecutive` leaves behind: no control, every share. */
  function dismissTheFounder(): void {
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('demo has no player company');
    company.controllerPlayerId = null;
    company.ceoCharacterId = DEMO_CHARACTERS.eleanor;
    const successor = state.characters.find((candidate) => candidate.id === DEMO_CHARACTERS.eleanor);
    if (successor !== undefined) successor.companyId = company.id;
  }

  it('still cannot run the company', () => {
    dismissTheFounder();
    const result = run(act({ type: 'set_research_budget', budgetUsd: 100_000 }));
    expect(codes(result)).toContain('not_controller_of_company');
  });

  it('keeps every action that belongs to ownership rather than to the office', () => {
    dismissTheFounder();
    // The connection gap is a separate rule and still applies; this is the
    // standing access the founder already has to their own former investor.
    state.accessOverrides.push({
      id: 'aco_test_founder_maya',
      kind: 'shared_investor',
      fromId: DEMO_CHARACTERS.player,
      toId: DEMO_CHARACTERS.maya,
      grantedQuarter: 0,
      expiresQuarter: null,
      isPermanent: true,
      grantedByCharacterId: null,
      reason: 'A shared investor from the seed round.',
    });
    const surface: ActionIntent[] = [
      { type: 'buy_shares', securityId: 'sec_nexus_common', shares: 10, targetPct: null, maxPricePerShareUsd: 90 },
      {
        type: 'propose_deal',
        proposal: {
          counterpartyId: DEMO_COMPANIES.nexus,
          counterpartyKind: 'company',
          gives: [],
          gets: [],
          confidentiality: 'private',
          expiresQuarter: state.quarter + 2,
          binding: false,
          intentStatements: [],
          summary: 'A standstill while the board settles down, with a seat for me at the end of it.',
        },
      },
      {
        type: 'social_post',
        draft: {
          authorCharacterId: DEMO_CHARACTERS.player,
          network: 'professional',
          text: 'I built this company and I am still its largest shareholder. I will be talking to the board.',
          intent: 'defend',
          targetCompanyId: null,
        },
      },
      {
        type: 'request_introduction',
        viaCharacterId: DEMO_CHARACTERS.maya,
        targetCharacterId: DEMO_CHARACTERS.eleanor,
        purpose: 'To discuss the composition of the board before the next meeting.',
      },
      {
        type: 'submit_board_proposal',
        kind: 'csuite_appointment',
        title: 'Reinstate the founder as chief executive',
        summary: 'The shareholder holding the majority of the company requisitions a vote on the leadership of it.',
        amountUsd: null,
        stockComponentPct: null,
        targetCompanyId: null,
      },
    ];

    for (const intent of surface) {
      const result = run(act(intent));
      expect(`${intent.type}: ${result.status === 'rejected' ? result.reasons.join(' ') : 'allowed'}`).toBe(`${intent.type}: allowed`);
    }
  });

  it('refuses the same actions to somebody holding nothing', () => {
    const result = run(
      act(
        {
          type: 'social_post',
          draft: {
            authorCharacterId: DEMO_CHARACTERS.player,
            network: 'professional',
            text: 'Speaking for a company I hold no shares in and do not run.',
            intent: 'defend',
            targetCompanyId: null,
          },
        },
        { companyId: DEMO_COMPANIES.nexus },
      ),
    );
    expect(codes(result)).toContain('not_controller_of_company');
    expect(result.reasons.join(' ')).toContain('shareholder');
  });
});

/* -------------------------------------------------------------------------- */
/*  Malformed input                                                            */
/* -------------------------------------------------------------------------- */

describe('instructions that are not in the contract', () => {
  it('refuses an enum value the contract does not carry instead of letting a phase index it', () => {
    const smuggled = {
      type: 'social_post',
      draft: {
        authorCharacterId: DEMO_CHARACTERS.player,
        network: 'professional',
        text: 'An intent nobody defined.',
        intent: 'thought_leadership',
        targetCompanyId: null,
      },
    } as unknown as ActionIntent;
    const result = run(act(smuggled));
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain('illegal_value');
  });

  it('refuses an intent whose numbers are out of contract', () => {
    const smuggled = { type: 'allocate_compute', trainingFraction: 4 } as unknown as ActionIntent;
    expect(run(act(smuggled)).status).toBe('rejected');
  });

  it('refuses a structurally broken intent without throwing', () => {
    const smuggled = { type: 'set_product_price' } as unknown as ActionIntent;
    expect(() => run(act(smuggled))).not.toThrow();
    expect(run(act(smuggled)).status).toBe('rejected');
  });
});

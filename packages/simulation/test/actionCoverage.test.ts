/**
 * @frontier/simulation — every action type has to *do* something.
 *
 * The engine accepts forty-four kinds of instruction. Accepting one, writing
 * an `action_accepted` row for it and then having no phase read it is worse than
 * refusing it: the player is told their decision was taken, is charged nothing,
 * and nothing about the world differs. Five action types were in exactly that
 * state — the whole compute pillar among them — and nothing in the suite noticed.
 *
 * So this file is a table over `ACTION_TYPES`. For each one it resolves the same
 * quarter twice, once with a valid instance of that action and once without, and
 * requires the two runs to differ: either the committed state is different, or
 * the ledger carries a row the baseline does not. A board-routed action passes on
 * the second count — the proposal it becomes is itself the trace.
 *
 * When a new action type is added to the contract, this test fails until the
 * engine actually consumes it.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, ActionType, SessionState, SimEvent, SubmittedAction } from '@frontier/contracts';
import { ACTION_TYPES } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession } from '../src/scenario';

/* -------------------------------------------------------------------------- */
/*  A world in which every action is legal                                     */
/* -------------------------------------------------------------------------- */

/**
 * The demo world, with the player given the money, capacity, standing and
 * counterparties every action needs. Nothing here changes the rules: each action
 * still goes through the same validator, and an action that is refused fails
 * this test as loudly as one that is ignored.
 */
function stageWorld(): SessionState {
  const state = createDemoSession();
  const player = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
  if (player === undefined) throw new Error('demo has no player company');

  player.financials.cash = 4_000_000_000;
  player.balanceSheet.assets.cash = 4_000_000_000;
  // The position staged below is carried at cost, like any other investment.
  player.balanceSheet.assets.investments += 2_000_000;
  player.balanceSheet.equity =
    player.balanceSheet.assets.cash +
    player.balanceSheet.assets.ppe +
    player.balanceSheet.assets.goodwill +
    player.balanceSheet.assets.investments +
    player.balanceSheet.assets.receivables -
    (player.balanceSheet.liabilities.debt + player.balanceSheet.liabilities.payables + player.balanceSheet.liabilities.deferredRevenue);
  player.employees.engineers = 400;
  player.employees.researchers = 200;
  player.employees.ops = 60;
  player.employees.execs = 8;
  player.compute.ownedAccelerators = 20_000;
  player.governmentPastPerformance = 70;
  player.reputation.government = 70;

  // Reachability is its own rule and is exercised elsewhere; here every person
  // the founder needs to speak to is already within reach.
  for (const character of state.characters) {
    if (character.id === DEMO_CHARACTERS.player) continue;
    state.accessOverrides.push({
      id: `aco_coverage_${character.id}`,
      kind: 'shared_investor',
      fromId: DEMO_CHARACTERS.player,
      toId: character.id,
      grantedQuarter: 0,
      expiresQuarter: null,
      isPermanent: true,
      grantedByCharacterId: null,
      reason: 'Staged for the action-coverage table.',
    });
  }

  // A position to sell: shares moved out of the float, so the class still
  // reconciles to the number issued.
  const nexusTable = state.capTables.find((table) => table.companyId === DEMO_COMPANIES.nexus);
  const float = nexusTable?.holdings.find((holding) => holding.holderKind === 'public_float');
  if (nexusTable !== undefined && float !== undefined) {
    float.shares -= 40_000;
    nexusTable.holdings.push({
      id: 'hld_coverage_player_nexus',
      holderId: DEMO_COMPANIES.player,
      holderKind: 'company',
      securityId: 'sec_nexus_common',
      shares: 40_000,
      costBasisUsd: 2_000_000,
      acquiredQuarter: 0,
      lockupUntilQuarter: null,
      isDisclosed: false,
    });
  }

  // A programme already running, so `adjust_research_project` has something to
  // re-resource. It targets a node no other coverage intent touches.
  const runningTarget = state.techGraph.nodes[3];
  if (runningTarget !== undefined) {
    state.researchProjects.push({
      id: 'rsp_coverage_player',
      companyId: DEMO_COMPANIES.player,
      targetNodeId: runningTarget.id,
      budgetQuarterly: 1_000_000,
      computeAllocated: 400,
      talentAllocated: 6,
      progress: 0.2,
      internalConfidence: 0.5,
      quartersElapsed: 2,
      expectedQuarters: 8,
      isSecret: false,
      status: 'active',
      cumulativeSpendUsd: 2_000_000,
      setbacks: 0,
      startedQuarter: 0,
    });
  }

  // Something to publish, something to bid on, something to respond to, a deal
  // on the table and a matter before the board.
  const node = state.techGraph.nodes[0];
  if (node !== undefined) {
    node.achievedByCompanyId = DEMO_COMPANIES.player;
    node.achievedQuarter = 0;
    node.status = 'achieved';
  }
  for (const opportunity of state.procurementOpportunities) {
    opportunity.requirements.minimumPastPerformance = 0;
    opportunity.requirements.clearanceLevel = 'none';
    opportunity.requirements.domesticInference = false;
    opportunity.requirements.dataSovereignty = false;
    opportunity.requirements.modelAudit = false;
    opportunity.allowsConsortium = true;
    opportunity.closeQuarter = state.quarter + 2;
  }
  state.deals.push({
    id: 'deal_coverage_offer',
    proposerId: DEMO_COMPANIES.nexus,
    proposerKind: 'company',
    counterpartyId: DEMO_COMPANIES.player,
    counterpartyKind: 'company',
    gives: [],
    gets: [],
    confidentiality: 'private',
    expiresQuarter: state.quarter + 4,
    binding: false,
    intentStatements: [],
    summary: 'A standing offer of inference capacity at cost, in exchange for early access to the evaluation harness.',
    status: 'proposed',
    createdQuarter: state.quarter,
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
  });
  state.mediaStories.push({
    id: 'sty_coverage_crisis',
    quarter: state.quarter,
    headline: 'Questions raised over an evaluation the industry relies on',
    body: 'Two customers say the benchmark the company publishes is not the benchmark it runs internally.',
    angle: 'scandal',
    prominence: 0.4,
    subjectCompanyIds: [DEMO_COMPANIES.player],
    subjectCharacterIds: [],
    sourcePostIds: [],
    sourceEventId: null,
    credibility: 0.6,
    sentiment: -0.5,
    reach: 240_000,
    authorCharacterId: null,
  });
  const board = state.boards.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
  const director = board?.directors[0];
  if (board !== undefined && director !== undefined) {
    state.boardProposals.push({
      id: 'prp_coverage_plan',
      companyId: DEMO_COMPANIES.player,
      boardId: board.id,
      kind: 'annual_plan',
      title: 'The plan for the coming year',
      summary: 'The operating plan, the hiring plan and the compute commitments that go with them.',
      proposedByCharacterId: DEMO_CHARACTERS.player,
      quarterProposed: state.quarter,
      decisionQuarter: state.quarter + 1,
      status: 'tabled',
      amountUsd: null,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      requiredThresholdFraction: 0.5,
    });
  }

  return state;
}

/** The one intent used to prove each action type is consumed. */
function intentFor(type: ActionType, state: SessionState): ActionIntent {
  const board = state.boards.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
  const directorId = board?.directors[0]?.characterId ?? DEMO_CHARACTERS.marcus;
  const opportunityId = state.procurementOpportunities[0]?.id ?? 'opp_sovereign_platform';
  const nodeId = state.techGraph.nodes[0]?.id ?? 'tech_unknown';
  const regulator = state.characters.find((character) => character.role === 'regulator' || character.role === 'official');

  switch (type) {
    case 'set_research_budget':
      return { type, budgetUsd: 2_000_000 };
    case 'start_research_project':
      return { type, targetNodeId: state.techGraph.nodes[1]?.id ?? nodeId, budgetUsd: 1_500_000, computeUnits: 200, researchersAssigned: 8, secret: false };
    case 'adjust_research_project':
      return { type, projectId: 'rsp_coverage_player', budgetUsd: 1_500_000, computeUnits: 500, researchersAssigned: 9 };
    case 'propose_innovation':
      return {
        type,
        proposal: {
          nodeType: 'player_hypothesis',
          title: 'Continuous Evaluation Harnesses',
          summary: 'Standing adversarial evaluation run continuously against a deployed model, with the results fed back into training.',
          novelty: 0.55,
          plausibility: 0.7,
          requiredCapabilities: ['evaluation'],
          estimatedCost: 40_000_000,
          estimatedQuarters: 6,
          dependencies: [nodeId],
          initialVisibility: 'company_private',
          rationale: 'We already sell into buyers who audit us; the harness is the product they keep asking for.',
        },
      };
    case 'publish_research':
      return { type, nodeId, mode: 'paper', rationale: 'The result is out of date commercially and worth the standing.' };
    case 'set_product_price':
      return { type, productId: 'prd_player_assistant', pricePerSeatUsd: 220 };
    case 'launch_product':
      return {
        type,
        name: 'Ventures Reviewer',
        segment: 'enterprise',
        categoryId: null,
        pricePerSeatUsd: 180,
        computeIntensity: 0.3,
        launchMarketingUsd: 400_000,
        targetQuality: 0.6,
        supply: [],
      };
    case 'sunset_product':
      return { type, productId: 'prd_player_assistant', windDownQuarters: 4 };
    case 'set_marketing_budget':
      return { type, allocations: [{ segment: 'enterprise', budgetUsd: 900_000 }] };
    case 'marketing_campaign':
      return { type, theme: 'brand', segment: 'enterprise', budgetUsd: 800_000, quarters: 2 };
    case 'hire':
      return { type, role: 'engineers', count: 12, compBand: 'above_market' };
    case 'layoff':
      return { type, role: 'ops', count: 4, severanceQuartersOfPay: 1 };
    case 'poach_executive':
      return { type, targetCharacterId: DEMO_CHARACTERS.ines, compPremiumPct: 0.5, approach: 'public' };
    case 'appoint_executive':
      return { type, characterId: DEMO_CHARACTERS.rowan, executiveRole: 'cfo', annualCompUsd: 900_000 };
    case 'reserve_compute':
      return { type, units: 2_000, quarters: 6, maxPricePerUnitUsd: 20_000, providerCompanyId: null };
    case 'buy_cloud_capacity':
      return { type, quarterlySpendUsd: 3_000_000, providerCompanyId: null, commitmentQuarters: 2 };
    case 'allocate_compute':
      return { type, trainingFraction: 0.9 };
    case 'buy_accelerators':
      // World 1 has no manufacturers, so this is the one type whose coverage
      // intent is expected to be refused rather than executed. It is here so the
      // table stays exhaustive; the world-2 behaviour is tested in sellers.test.ts.
      return { type, units: 10, maxPricePerUnitUsd: 100_000, sellerCompanyId: null };
    case 'invest_capacity':
      // World 1 has no capacity kind but compute, so this is refused there for
      // the same reason buy_accelerators is; world-2 behaviour is tested in
      // capacityInvestment.test.ts.
      return { type, kind: 'plant', amountUsd: 5_000_000 };
    case 'set_supply_terms':
      // World 1 has no product categories and no canSupply lines, so this is
      // refused there for the same reason buy_accelerators is; world-2
      // behaviour is tested in supplyChain.test.ts.
      return {
        type,
        productId: 'prd_player_assistant',
        terms: { openToAll: true, pricePerUnitUsd: 100, exclusiveCustomerIds: [], blockedCustomerIds: [] },
      };
    case 'choose_supplier':
      // World 1 has no product categories, so this is refused there for the
      // same reason; world-2 behaviour is tested in supplyChain.test.ts.
      return { type, productId: 'prd_player_assistant', inputCategoryId: 'ai_frontier_models', supplierCompanyId: null, supplierProductId: null };
    case 'raise_round':
      return { type, stage: 'series_a', targetAmountUsd: 25_000_000, maxDilutionPct: 0.2 };
    case 'issue_debt':
      return { type, amountUsd: 10_000_000, maxRatePct: 0.12, termQuarters: 12 };
    case 'buyback':
      return { type, budgetUsd: 1_000_000, maxPricePerShareUsd: 5 };
    case 'issue_shares':
      return { type, shares: 100_000, shareClassId: 'shc_player_ventures_common', minPricePerShareUsd: 1 };
    case 'ipo':
      return { type, targetRaiseUsd: 40_000_000, floatPct: 0.2, minPricePerShareUsd: 4 };
    case 'set_dividend_policy':
      return { type, payoutPct: 30 };
    case 'set_logistics_toll':
      return { type, region: 'north_america', tollPct: 10 };
    case 'buy_shares':
      return { type, securityId: 'sec_nexus_common', targetPct: null, shares: 20_000, maxPricePerShareUsd: 200 };
    case 'sell_shares':
      return { type, securityId: 'sec_nexus_common', shares: 5_000, minPricePerShareUsd: 1 };
    case 'acquire_company':
      return { type, targetCompanyId: DEMO_COMPANIES.meridian, offerValueUsd: 900_000_000, cashPct: 1, stockPct: 0 };
    case 'submit_board_proposal':
      return {
        type,
        kind: 'annual_plan',
        title: 'A second look at the operating plan',
        summary: 'The plan again, with the compute commitments the board asked for last quarter.',
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      };
    case 'lobby_director':
      return {
        type,
        directorCharacterId: directorId,
        proposalId: 'prp_coverage_plan',
        concessions: [],
        message: 'I would like to walk you through the hiring plan before the meeting.',
      };
    case 'bid_government':
      return {
        type,
        opportunityId,
        bid: {
          opportunityId,
          price: 120_000_000,
          technicalScoreInputs: {
            modelCapability: 0.5,
            architectureQuality: 0.5,
            securityPosture: 0.6,
            reliabilityCommitment: 0.8,
            responsibleAiCommitment: 0.6,
          },
          computeCommitment: { acceleratorUnits: 400, quarters: 8 },
          staffCommitment: { engineers: 40, researchers: 10, clearedStaff: 0 },
          timeline: { deliveryQuarters: 8, milestoneCount: 4 },
          subcontractors: [],
          ipConcessions: 'government_use_rights',
          auditRights: 'annual',
          domesticSourcingPct: 0.9,
          consortiumMemberIds: [],
          narrative: 'A small delivery team with an evaluation harness the programme office can run itself.',
        },
      };
    case 'decline_opportunity':
      return { type, opportunityId, reason: 'The compliance burden is not worth the backlog at our size.' };
    case 'form_consortium':
      return { type, opportunityId, inviteeCompanyIds: [DEMO_COMPANIES.meridian], leadCompanyId: DEMO_COMPANIES.player, sharePct: 0.4 };
    case 'meet_regulator':
      return {
        type,
        regulatorCharacterId: regulator?.id ?? DEMO_CHARACTERS.grace,
        topic: 'model_rules',
        posture: 'cooperative',
        concessionsOffered: ['Early access to our evaluation results.'],
      };
    case 'social_post':
      return {
        type,
        draft: {
          authorCharacterId: DEMO_CHARACTERS.player,
          network: 'professional',
          text: 'We are hiring evaluation engineers. The work is unglamorous and it is the whole job.',
          intent: 'recruit',
          targetCompanyId: null,
        },
      };
    case 'give_guidance':
      return { type, metric: 'revenue', value: 500_000, quarter: state.quarter + 1 };
    case 'respond_crisis':
      return { type, crisisEventId: 'sty_coverage_crisis', responseKind: 'acknowledge', statement: 'The evaluation was ours and we are publishing the method.' };
    case 'propose_deal':
      return {
        type,
        proposal: {
          counterpartyId: DEMO_COMPANIES.meridian,
          counterpartyKind: 'company',
          gives: [],
          gets: [],
          confidentiality: 'private',
          expiresQuarter: state.quarter + 3,
          binding: false,
          intentStatements: [],
          summary: 'A data licence for the evaluation corpus, priced off usage rather than seats.',
        },
      };
    case 'accept_deal':
      return { type, dealId: 'deal_coverage_offer' };
    case 'reject_deal':
      return { type, dealId: 'deal_coverage_offer', reason: 'The exclusivity is worth more than the capacity.' };
    case 'request_introduction':
      return {
        type,
        viaCharacterId: DEMO_CHARACTERS.maya,
        targetCharacterId: DEMO_CHARACTERS.nadia,
        purpose: 'To talk about the sovereign programme before the next round opens.',
      };
    case 'transfer_between_group':
      // World 1 has no subsidiary concept at all — every company answers to
      // at most one controller and a seat only ever has one — so this is
      // refused there for the same reason buy_accelerators is; world-2
      // behaviour is tested in groupControl.test.ts.
      return { type, fromCompanyId: DEMO_COMPANIES.player, toCompanyId: DEMO_COMPANIES.meridian, cashUsd: 1_000_000, acceleratorUnits: null };
    case 'merge_subsidiary':
      // World 1 has no live subsidiary to merge — an acquisition there
      // absorbs outright already — so this is refused there for the same
      // reason; world-2 behaviour is tested in groupControl.test.ts.
      return { type, subsidiaryCompanyId: DEMO_COMPANIES.meridian };
    default: {
      const exhaustive: never = type;
      throw new Error(`no coverage intent for ${String(exhaustive)}`);
    }
  }
}

/**
 * Who takes each action. Almost everything is the player; public guidance is
 * given by a listed company, and Player Ventures is private.
 */
function actorFor(type: ActionType): { companyId: string; characterId: string; playerId: string | null } {
  if (type === 'give_guidance') return { companyId: DEMO_COMPANIES.nexus, characterId: DEMO_CHARACTERS.maya, playerId: null };
  return { companyId: DEMO_COMPANIES.player, characterId: DEMO_CHARACTERS.player, playerId: DEMO_PLAYER_ID };
}

function submit(state: SessionState, intent: ActionIntent): SubmittedAction {
  const actor = actorFor(intent.type);
  return {
    actionId: `act_coverage_${intent.type}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence: 0,
    actorPlayerId: actor.playerId,
    actorCompanyId: actor.companyId,
    actorCharacterId: actor.characterId,
    origin: actor.playerId === null ? 'npc_strategist' : 'player_ui',
    intent,
    confirmedByHuman: actor.playerId !== null,
  };
}

/** Ledger rows other than the bookkeeping every quarter writes anyway. */
const BOOKKEEPING = new Set(['quarter_opened', 'quarter_committed', 'snapshot_created', 'action_accepted', 'action_clamped', 'action_rejected']);

function substantiveRows(events: readonly SimEvent[]): string[] {
  return events
    .filter((event) => !BOOKKEEPING.has(event.type))
    .map((event) => `${event.type}|${event.actorId ?? ''}|${event.targetId ?? ''}|${JSON.stringify(event.payload)}`)
    .sort();
}

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Action types world version 1 cannot accept at all. Kept as a named set rather
 * than as a skip inside the loop so the exclusion is one line to audit and the
 * assertion below fails the moment it grows silently.
 */
const WORLD_2_ONLY_ACTIONS = new Set<ActionType>([
  'buy_accelerators',
  'invest_capacity',
  'set_supply_terms',
  'choose_supplier',
  'transfer_between_group',
  'merge_subsidiary',
]);

describe('every accepted action changes something', () => {
  const engine = createDefaultEngine();
  const baseline = engine.resolver.resolveQuarter(stageWorld(), [], null, []);
  const baselineState = JSON.stringify(baseline.nextState);
  const baselineRows = new Set(substantiveRows(baseline.events));

  it('resolves the staged world at all', () => {
    expect(baseline.committed).toBe(true);
  });

  it('covers every action type in the contract', () => {
    // 44 was pinned before transfer_between_group and merge_subsidiary
    // (group control, STAGE 4) were appended.
    expect(ACTION_TYPES.length).toBe(46);
    expect([...WORLD_2_ONLY_ACTIONS]).toEqual([
      'buy_accelerators',
      'invest_capacity',
      'set_supply_terms',
      'choose_supplier',
      'transfer_between_group',
      'merge_subsidiary',
    ]);
  });

  it('refuses the world-2-only actions here rather than silently ignoring them', () => {
    for (const type of WORLD_2_ONLY_ACTIONS) {
      const state = stageWorld();
      const action = submit(state, intentFor(type, state));
      const outcome = engine.resolver.resolveQuarter(state, [action], null, []);
      expect(outcome.committed).toBe(true);
      const verdict = outcome.events.find((event) => event.targetId === action.actionId);
      expect(`${type}: ${String(verdict?.type)}`).toBe(`${type}: action_rejected`);
    }
  });

  for (const type of ACTION_TYPES) {
    // World-1 has no manufacturers and no compute sellers, so an action that
    // exists to name one cannot be accepted here. Its consumption is proved in
    // `sellers.test.ts`, against a world-2 session, to the same standard: the
    // quarter commits, no invariant fails, and the world differs afterwards.
    if (WORLD_2_ONLY_ACTIONS.has(type)) continue;
    it(`${type} is consumed by a phase`, () => {
      const state = stageWorld();
      const action = submit(state, intentFor(type, state));
      const outcome = engine.resolver.resolveQuarter(state, [action], null, []);

      // A quarter that does not commit is a quarter whose effects were rolled
      // back, so consumption could not be proved from it either way.
      expect(`${type}: ${outcome.invariants.filter((result) => !result.passed).map((result) => result.invariant).join(', ')}`).toBe(`${type}: `);
      expect(outcome.committed).toBe(true);
      const verdict = outcome.events.find((event) => event.targetId === action.actionId);
      expect(`${type}: ${String(verdict?.type)}`).not.toBe(`${type}: action_rejected`);

      // Either the world differs, or the ledger carries a row the baseline does
      // not. An action that produces neither was accepted and then ignored.
      const stateChanged = JSON.stringify(outcome.nextState) !== baselineState;
      const newRows = substantiveRows(outcome.events).filter((row) => !baselineRows.has(row));
      expect(`${type}: ${stateChanged || newRows.length > 0 ? 'consumed' : 'inert'}`).toBe(`${type}: consumed`);
    });
  }
});

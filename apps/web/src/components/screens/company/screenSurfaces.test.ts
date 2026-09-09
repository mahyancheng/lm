/**
 * Engine surfaces for the company & institutions cluster.
 *
 * Company, Products, People, Research, Government and Boardroom all render
 * figures produced by pure functions exported from `@frontier/simulation`
 * rather than by arithmetic of their own. This test pins that contract: every
 * one of those functions is called exactly as a screen calls it, against the
 * demo world at quarter 0 and again after three quarters have resolved, so a
 * change to an engine signature breaks here rather than in the browser.
 *
 * It also asserts the one information boundary these screens can violate: the
 * reduced graph handed to the Frontier Map must not carry a rival's private
 * confidence.
 *
 * (Placed in `company/` because it covers the whole cluster; the six screens
 * share these surfaces and one file is easier to keep true than six.)
 */

import { describe, expect, it } from 'vitest';
import {
  assessCostUsd,
  assessPlausibility,
  bidTeam,
  checkAccess,
  costRealism,
  createDefaultEngine,
  createDemoSession,
  customersPerUnit,
  disqualificationReasons,
  engineCostEstimate,
  fillRate,
  heldComputeUnits,
  marketingPlan,
  poachProbability,
  programmeScale,
  reachableCapitalUsd,
  recordPastPerformance,
  researchEnvelopeUsd,
  servingComputeUnits,
  tallyProposal,
  techGraphForCompany,
} from '@frontier/simulation';
import type { SessionState } from '@frontier/contracts';
import { layoutGraph } from '../research/graphLayout';
import { hypotheticalProposal, whipCount } from '../boardroom/whip';
import { initialDraft, toStoredBid } from '../government/bidModel';

const PLAYER = 'cmp_player_ventures';

function player(state: SessionState) {
  const company = state.companies.find((c) => c.controllerPlayerId === 'player_1');
  if (company === undefined) throw new Error('no player company');
  return company;
}

function exercise(state: SessionState, label: string): void {
  const company = player(state);
  const graph = techGraphForCompany(state.techGraph, company.id);

  // research
  const layout = layoutGraph(graph);
  expect(layout.nodes.length).toBe(graph.nodes.length);
  expect(layout.width).toBeGreaterThan(0);
  expect(graph.nodes.some((n) => n.status === 'secret' && n.confidenceByCompany['cmp_nexus'] !== undefined)).toBe(false);
  expect(researchEnvelopeUsd(company, [])).toBeGreaterThanOrEqual(0);
  const proposal = {
    nodeType: 'player_hypothesis' as const,
    title: 'Test Thesis',
    summary: 'A test proposal used only to exercise the assessment helpers the screen calls.',
    novelty: 0.6,
    plausibility: 0.5,
    requiredCapabilities: ['agents'],
    estimatedCost: 100_000_000,
    estimatedQuarters: 8,
    dependencies: [graph.nodes[0]?.id ?? ''],
    initialVisibility: 'company_private' as const,
    rationale: 'Exercising the engine assessment helpers from the research screen.',
  };
  expect(assessPlausibility(state, proposal, graph.nodes.slice(0, 1), company)).toBeGreaterThanOrEqual(0);
  expect(assessCostUsd(proposal)).toBeGreaterThan(0);
  expect(reachableCapitalUsd(company)).toBeGreaterThanOrEqual(0);

  // company / products
  expect(heldComputeUnits(state, company)).toBeGreaterThanOrEqual(0);
  expect(servingComputeUnits(state, company)).toBeGreaterThanOrEqual(0);
  for (const product of company.products) expect(customersPerUnit(state, product.computeIntensity)).toBeGreaterThan(0);
  expect(marketingPlan(company, []).recurringUsd).toBeGreaterThanOrEqual(0);

  // people
  expect(fillRate(state, company, 'engineers', 'market')).toBeGreaterThanOrEqual(0);
  const other = state.characters.find((c) => c.companyId !== null && c.companyId !== company.id);
  const founder = state.characters.find((c) => c.isPlayer);
  if (other !== undefined && founder !== undefined) {
    expect(typeof checkAccess(state, founder.id, other.id).reason).toBe('string');
    expect(poachProbability(state, company, other.id, founder.id, 0.4, 'public')).toBeGreaterThanOrEqual(0);
  }

  // government
  for (const opportunity of state.procurementOpportunities) {
    const draft = initialDraft(opportunity);
    const stored = toStoredBid(opportunity, draft, company.id, state.quarter);
    const team = bidTeam(state, stored);
    const gates = disqualificationReasons(state, opportunity, stored, team);
    expect(Array.isArray(gates)).toBe(true);
    const estimate = engineCostEstimate(state, opportunity, stored, team);
    expect(estimate.estimateUsd).toBeGreaterThan(0);
    expect(costRealism(stored.price, estimate.estimateUsd, opportunity.contractForm)).toBeGreaterThanOrEqual(0);
    expect(programmeScale(opportunity, team).computeUnits).toBeGreaterThan(0);
  }
  expect(recordPastPerformance(state, company, 'agy_defence')).toBeGreaterThanOrEqual(0);

  // boardroom
  const board = state.boards.find((b) => b.companyId === company.id);
  expect(board, `${label}: player board`).toBeDefined();
  if (board !== undefined && founder !== undefined) {
    const hypothetical = hypotheticalProposal(state, board, founder.id, {
      kind: 'financing',
      title: 'Authorise a Series A',
      summary: 'A test matter used only to exercise the whip count.',
      amountUsd: 12_000_000,
      targetCompanyId: null,
      stockComponentPct: null,
    });
    const count = whipCount(state, board, hypothetical);
    expect(count.lines.length).toBe(board.directors.length);
    expect(count.threshold).toBeGreaterThan(0);
  }
  for (const proposalRow of state.boardProposals) {
    expect(tallyProposal(state, proposalRow.id).perDirector.length).toBeGreaterThanOrEqual(0);
  }
}

describe('company & institutions screens: engine surfaces', () => {
  it('every helper the six screens call works at quarter 0', () => {
    const state = createDemoSession();
    expect(player(state).id).toBe(PLAYER);
    exercise(state, 'quarter 0');
  });

  it('and after three resolved quarters', () => {
    const engine = createDefaultEngine();
    let state = createDemoSession();
    for (let index = 0; index < 3; index += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;
    }
    expect(state.quarter).toBe(3);
    expect(state.leaderboards.length).toBeGreaterThan(0);
    exercise(state, 'quarter 3');
  });
});

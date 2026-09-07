import { describe, expect, it } from 'vitest';
import { ECONOMIC_NODES, SECTORS, SessionStateSchema, canProduce, canProduceInSession, economicNodeInSession, type ActionIntent, type InnovationProposal, type ResearchProject, type ResolverContext, type SubmittedAction } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createWorld3Session } from '../src/scenario/world3';
import { createDefaultEngine } from '../src/engine';
import { integrateInnovationProposal, achieveNodes } from '../src/research';
import { INNOVATION_COST_RANGE } from '../src/research/balance';
import { createActionValidator } from '../src/validator';
import { resolveProducts } from '../src/companies/products';
import { nodeMapFor } from '../src/graph/projection';

function fixture() {
  const state = createWorld3Session();
  const company = state.companies.find((c) => c.id === state.players[0]!.companyId)!;
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const ctx: ResolverContext = { quarter: state.quarter, rng: createRng('blueprint-review'), emit: (event) => { events.push(event); return 'event_' + events.length; }, log: () => undefined };
  const submit = (intent: ActionIntent): SubmittedAction => ({ actionId: 'act_blueprint', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
    actorPlayerId: state.players[0]!.playerId, actorCompanyId: company.id, actorCharacterId: state.players[0]!.characterId!, origin: 'player_ui', confirmedByHuman: true, intent });
  const proposal = (nodeId: string): InnovationProposal => ({ nodeType: 'player_hypothesis', title: 'Distinct product invention',
    summary: 'Develop a specific customer workflow through a funded prototype and independent evaluation.', novelty: 0.2, plausibility: 0.9,
    requiredCapabilities: [], estimatedCost: 1, estimatedQuarters: 2, dependencies: [], initialVisibility: 'company_private',
    rationale: 'Test a specific market need with a paid prototype before committing to production.',
    productBlueprint: { nodeId, customerValue: 'A specific customer workflow with an independently evaluated improvement.' } });
  return { state, company, ctx, events, submit, proposal };
}

describe('research-backed products', () => {
  it.each(SECTORS)('makes a costed, gated invention for the %s industry', (sector) => {
    const f = fixture();
    const node = ECONOMIC_NODES.find((n) => n.sector === sector && n.researchable)!;
    expect(node).toBeDefined();
    f.company.ownedNodes = [];
    const proposal = f.proposal(node.id);
    f.state.pendingActions = [f.submit({ type: 'propose_innovation', proposal })];
    const integrated = integrateInnovationProposal(f.state, proposal, f.ctx);
    expect(integrated.accepted, integrated.reasons.join('; ')).toBe(true);
    const tech = f.state.techGraph.nodes.find((n) => n.id === integrated.nodeId)!;
    expect(tech.sector).toBe(sector);
    expect(tech.researchCostRange[0]).toBeGreaterThanOrEqual(node.researchCostRangeUsd[0] - 0.01);
    expect(integrated.adjustedCostUsd).toBeGreaterThanOrEqual(node.researchCostRangeUsd[0] / INNOVATION_COST_RANGE.low - 0.01);
    expect(tech.dependencies).toEqual(expect.arrayContaining([...node.requires]));
    expect(f.company.ownedNodes).toEqual([]);
    expect(SessionStateSchema.safeParse(f.state).success).toBe(true);
  });

  it('a frontier company proves a consumer invention, then launches a linked product', () => {
    const f = fixture();
    const productNode = ECONOMIC_NODES.find((n) => n.id === 'app_consumer_subscription')!;
    expect(f.company.sector).toBe('ai');
    f.company.ownedNodes = [];
    const proposal = f.proposal(productNode.id);
    f.state.pendingActions = [f.submit({ type: 'propose_innovation', proposal })];
    const integrated = integrateInnovationProposal(f.state, proposal, f.ctx);
    expect(integrated.accepted).toBe(true);
    const techId = integrated.nodeId!;
    const project: ResearchProject = { id: 'rsp_blueprint', companyId: f.company.id, targetNodeId: techId, budgetQuarterly: 1000000,
      computeAllocated: 20, talentAllocated: 5, progress: 1, internalConfidence: 0.8, quartersElapsed: 4, expectedQuarters: 4,
      isSecret: true, status: 'active', cumulativeSpendUsd: integrated.adjustedCostUsd, setbacks: 0, startedQuarter: 0 };
    f.state.researchProjects = [project];
    if (productNode.requires.length) {
      achieveNodes(f.state, f.ctx);
      expect(f.company.ownedNodes).not.toContain(techId);
      expect(f.company.ownedNodes).not.toContain(productNode.id);
      expect(project.status).toBe('paused');
    }
    f.company.ownedNodes = [...productNode.requires];
    project.status = 'active';
    project.progress = 1;
    achieveNodes(f.state, f.ctx);
    expect(f.company.ownedNodes).toEqual(expect.arrayContaining([techId, productNode.id]));
    expect(canProduce(f.company, productNode.id, f.state.quarter)).toBe(true);
    const intent: ActionIntent = { type: 'launch_product', name: 'Consumer invention', categoryId: productNode.id, technologyNodeId: techId,
      segment: 'consumer', targetIndustry: 'consumer', pricePerSeatUsd: 20, computeIntensity: 0.5, launchMarketingUsd: 0, targetQuality: 0.75, supply: [], slots: [] };
    const validation = createActionValidator().validateBatch(f.state, [f.submit(intent)])[0]!;
    expect(validation.status, validation.reasons.join('; ')).not.toBe('rejected');
    f.state.pendingActions = [f.submit(validation.clampedAction ?? intent)];
    resolveProducts(f.state, f.ctx);
    expect(f.company.products.find((p) => p.name === intent.name)).toMatchObject({ nodeId: productNode.id, technologyNodeId: techId });
    expect(f.events.some((event) => event.type === 'node_owned' && event.payload.technologyNodeId === techId)).toBe(true);
    expect(SessionStateSchema.safeParse(f.state).success).toBe(true);
  });

  it('rejects unknown/raw-resource product targets and forged launch links', () => {
    for (const id of ['missing_node', ECONOMIC_NODES.find((n) => !n.researchable)!.id]) {
      const f = fixture(); const proposal = f.proposal(id);
      f.state.pendingActions = [f.submit({ type: 'propose_innovation', proposal })];
      expect(integrateInnovationProposal(f.state, proposal, f.ctx).accepted).toBe(false);
    }
    const f = fixture();
    const verdict = createActionValidator().validateBatch(f.state, [f.submit({ type: 'launch_product', name: 'Forged product', categoryId: 'app_consumer_subscription',
      technologyNodeId: 'tech_fake', segment: 'consumer', targetIndustry: 'consumer', pricePerSeatUsd: 20, computeIntensity: 0.5,
      launchMarketingUsd: 0, targetQuality: 0.75, supply: [], slots: [] })])[0]!;
    expect(verdict.status).toBe('rejected');
    expect(verdict.codes).toContain('requirement_not_met');
  });

  it('turns a paid private recipe into an owned, producing consumer line without leaking it publicly', () => {
    const f = fixture();
    const input = [...ECONOMIC_NODES].filter((node) => node.tier < 6).sort((a, b) => a.basePriceUsd - b.basePriceUsd)[0]!;
    const proposal: InnovationProposal = {
      ...f.proposal('app_consumer_subscription'), title: 'Private recipe lifecycle',
      productBlueprint: { customerValue: 'A consumer workflow with a clear measured outcome and recurring willingness to pay.', recipe: {
        label: 'Private Consumer Copilot', sector: 'consumer', customerSegment: 'consumer', unitLabel: 'seat', saleKind: 'recurring', inputNodeIds: [input.id], inputQuantities: [1],
      } },
    };
    f.state.pendingActions = [f.submit({ type: 'propose_innovation', proposal })];
    const integrated = integrateInnovationProposal(f.state, proposal, f.ctx);
    expect(integrated.accepted, integrated.reasons.join('; ')).toBe(true);
    const tech = f.state.techGraph.nodes.find((node) => node.id === integrated.nodeId)!;
    const recipeId = tech.productBlueprint && 'nodeId' in tech.productBlueprint ? tech.productBlueprint.nodeId : null;
    expect(recipeId).not.toBeNull();
    expect(canProduceInSession(f.state, f.company, recipeId!, f.state.quarter)).toBe(false);
    const rival = f.state.companies.find((company) => company.id !== f.company.id)!;
    expect(nodeMapFor(f.state, rival.id).nodes.some((node) => node.nodeId === recipeId)).toBe(false);
    const project: ResearchProject = { id: 'rsp_recipe', companyId: f.company.id, targetNodeId: tech.id, budgetQuarterly: 1_000_000, computeAllocated: 20, talentAllocated: 5,
      progress: 1, internalConfidence: 1, quartersElapsed: 4, expectedQuarters: 4, isSecret: true, status: 'active', cumulativeSpendUsd: integrated.adjustedCostUsd, setbacks: 0, startedQuarter: f.state.quarter };
    f.state.researchProjects = [project];
    achieveNodes(f.state, f.ctx);
    expect(canProduceInSession(f.state, f.company, recipeId!, f.state.quarter)).toBe(true);
    const intent: ActionIntent = { type: 'launch_product', name: 'Private Copilot', technologyNodeId: tech.id, categoryId: recipeId!, segment: 'consumer', targetIndustry: 'consumer', pricePerSeatUsd: 500,
      computeIntensity: 0.5, launchMarketingUsd: 50_000, targetQuality: 0.8, supply: [], slots: [] };
    const verdict = createActionValidator().validateBatch(f.state, [f.submit(intent)])[0]!;
    expect(verdict.status, verdict.reasons.join('; ')).not.toBe('rejected');
    f.state.pendingActions = [f.submit(verdict.clampedAction ?? intent)];
    resolveProducts(f.state, f.ctx);
    const line = f.company.products.find((product) => product.name === intent.name)!;
    expect(line.nodeId).toBe(recipeId);
    expect(line.unitsSoldQuarterly ?? 0).toBeGreaterThan(0);
    expect(line.unitCostUsd ?? Infinity).toBeGreaterThan(0);
    expect(line.pricePerSeat).toBeGreaterThan(line.unitCostUsd ?? Infinity);
    expect(economicNodeInSession(f.state, recipeId!)?.market.customers.consumer).toBe(1);
    expect(SessionStateSchema.safeParse(f.state).success).toBe(true);
    // The actual resolver must commit the custom line through every phase, and
    // replay from the identical pre-quarter state must remain deterministic.
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const initial = clone(f.state);
    const engine = createDefaultEngine();
    const first = engine.resolver.resolveQuarter(initial, [], null, []);
    const replay = engine.resolver.resolveQuarter(clone(f.state), [], null, []);
    expect(first.committed, first.invariants.map((result) => `${result.invariant}: ${result.detail}`).join('; ')).toBe(true);
    expect(first.invariants.every((result) => result.passed), first.invariants.map((result) => result.detail).join('; ')).toBe(true);
    expect(first.nextState.companies.find((company) => company.id === f.company.id)?.products.find((product) => product.id === line.id)?.unitsSoldQuarterly ?? 0).toBeGreaterThan(0);
    expect(replay.committed).toBe(true);
    expect(replay.nextState).toEqual(first.nextState);
  });
});

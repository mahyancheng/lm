import { describe, it, expect } from 'vitest';
import { aiModelNodeId, AI_MODEL_DESIGNS, economicNodeById, canProduce, type SubmittedAction } from '@frontier/contracts';
import { createWorld3Session } from '../src/scenario';
import { createActionValidator } from '../src/validator';
import { createDefaultEngine } from '../src/engine';
import { effortIntent, researchCapacity } from '../src/research/forecast';
import { researchInputUnavailable, resolveFill } from '../src/graph/slots';
import { slotOptions } from '../src/graph/options';
import { effectiveQuality } from '../src/graph/production';
import { unitCostOf } from '../src/graph/cost';

describe('the opening AI boom', () => {
  it('opens in early 2023 with an immature frontier and no free advanced designs', () => {
    const state=createWorld3Session();
    expect(state.startYear).toBe(2023); expect(state.config.startYear).toBe(2023);
    expect(state.world.aiFrontier.benchmarkSaturation).toBeLessThan(0.2);
    for(const design of AI_MODEL_DESIGNS.filter(d=>d.architecture==='moe' || d.output==='video')) {
      expect(state.companies.some(c=>canProduce(c,design.nodeId))).toBe(false);
      expect(state.techGraph.nodes.some(n=>n.id===design.nodeId)).toBe(true);
    }
  });
  it('cannot import an undiscovered model or expose a private model through the market', () => {
    const state=createWorld3Session(); const player=state.companies.find(c=>c.controllerPlayerId!==null)!;
    const id=aiModelNodeId('moe','pretrain','text'); const api=economicNodeById('svc_inference_api')!;
    expect(researchInputUnavailable(state,player.id,id)).toBe(true);
    expect(slotOptions(state,player,api.id).find(s=>s.slotId==='model')!.candidates.find(c=>c.nodeId===id)).toMatchObject({blocked:true,routes:[]});
    const resolved=resolveFill(state,player,null,api,api.slots[0]!,undefined,{fills:[{slotId:'model',nodeId:id,supplierCompanyId:null,supplierProductId:null,changedQuarter:null,cutOffNoticeQuarter:null}]});
    expect(resolved.route).toBe('blocked');
    const rival=state.companies.find(c=>c.controllerPlayerId===null)!;
    rival.ownedNodes=[...(rival.ownedNodes??[]),id];
    expect(researchInputUnavailable(state,player.id,id)).toBe(true);
  });
  it('uses model methods in delivered quality as well as production cost', () => {
    const state=createWorld3Session(); const player=state.companies.find(c=>c.controllerPlayerId!==null)!;
    const product={...player.products[0]!,craftQuality:0.8,qualityScore:0.8};
    const base=economicNodeById(aiModelNodeId('dense','pretrain','text'))!;
    const distilled=economicNodeById(aiModelNodeId('dense','distill','text'))!;
    expect(effectiveQuality(state,player,product,distilled,unitCostOf(state,player,distilled.id))).toBeLessThan(effectiveQuality(state,player,product,base,unitCostOf(state,player,base.id)));
  });
  it('starts paid model research through the actual command and advances deterministically', () => {
    const state=createWorld3Session(); const player=state.companies.find(c=>c.controllerPlayerId!==null)!;
    const node=state.techGraph.nodes.find(n=>n.id===aiModelNodeId('dense','instruction','text'))!;
    player.ownedNodes=[...new Set([...(player.ownedNodes??[]),...node.dependencies])];
    const intent=effortIntent(state,node,'standard',researchCapacity(state,player),false);
    const seat=state.players[0]!;
    const action:SubmittedAction={actionId:'research_early_model',sessionId:state.sessionId,quarter:0,sequence:1,actorPlayerId:seat.playerId,actorCompanyId:player.id,actorCharacterId:seat.characterId,origin:'player_ui',confirmedByHuman:true,intent};
    const verdict=createActionValidator().validateBatch(state,[action])[0]!;
    expect(verdict.status,verdict.reasons.join(' | ')).not.toBe('rejected');
    const engine=createDefaultEngine();
    const outcome=engine.resolver.resolveQuarter(state,[action],null,[]);
    expect(outcome.committed).toBe(true);
    const project=outcome.nextState.researchProjects.find(p=>p.companyId===player.id && p.targetNodeId===node.id);
    expect(project).toBeDefined(); expect(project!.cumulativeSpendUsd).toBeGreaterThan(0);
    expect(engine.resolver.resolveQuarter(state,[action],null,[])).toEqual(outcome);
  });
});

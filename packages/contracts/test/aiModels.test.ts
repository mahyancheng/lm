import { describe, it, expect } from 'vitest';
import { AI_ARCHITECTURES, AI_OUTPUTS, AI_MODEL_DESIGNS, aiModelNodeId, economicNodeById, admissibleNodesFor } from '../src';
describe('composable AI research', () => {
  it('offers every architecture and output, and excludes unsupported combinations', () => {
    for(const a of AI_ARCHITECTURES) expect(AI_MODEL_DESIGNS.some(d=>d.architecture===a.id)).toBe(true);
    for(const o of AI_OUTPUTS) expect(AI_MODEL_DESIGNS.some(d=>d.output===o.id)).toBe(true);
    expect(AI_MODEL_DESIGNS.some(d=>d.architecture==='diffusion' && d.output==='code')).toBe(false);
    expect(new Set(AI_MODEL_DESIGNS.map(d=>d.nodeId)).size).toBe(AI_MODEL_DESIGNS.length);
  });
  it('makes distillation cheaper to research and serve, with lower capability', () => {
    const base = economicNodeById(aiModelNodeId('dense','pretrain','text'))!;
    const student = economicNodeById(aiModelNodeId('dense','distill','text'))!;
    expect(student.requires).toContain(base.id);
    expect(student.capacityDrawPerUnit).toBeLessThan(base.capacityDrawPerUnit);
    expect(student.researchCostRangeUsd[1]).toBeLessThan(base.researchCostRangeUsd[0]);
    expect(AI_MODEL_DESIGNS.find(d=>d.nodeId===student.id)!.qualityFactor).toBeLessThan(AI_MODEL_DESIGNS.find(d=>d.nodeId===base.id)!.qualityFactor);
  });
  it('requires output-specific data and keeps visual models out of a text-token API', () => {
    const code=economicNodeById(aiModelNodeId('dense','pretrain','code'))!;
    const image=economicNodeById(aiModelNodeId('diffusion','pretrain','image'))!;
    expect(code.requires).toContain('dat_model_code'); expect(image.requires).toContain('dat_model_image');
    const ids=admissibleNodesFor('svc_inference_api','model').map(n=>n.id);
    expect(ids).toContain(code.id); expect(ids).not.toContain(image.id);
    const rlhf=economicNodeById(aiModelNodeId('dense','preference','text'))!;
    expect(rlhf.requires).toContain('dat_preference_data');
    expect(rlhf.slots.some(s=>s.defaultNodeId==='dat_preference_data' && s.required)).toBe(true);
  });
});

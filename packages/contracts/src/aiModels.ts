/** AI research designs. Coefficients are game balance, not benchmark claims. */
import { EconomicNodeSchema, type EconomicNode } from './nodes';
export const AI_ARCHITECTURES = [
  { id: 'dense', label: 'Dense Transformer', short: 'Dense', training: 1, serving: 1, risk: 0.92, note: 'A proven baseline; every parameter runs for every request.' },
  { id: 'moe', label: 'Mixture of experts', short: 'MoE', training: 1.7, serving: 0.65, risk: 0.72, note: 'Sparse serving, with harder routing and training.' },
  { id: 'state_space', label: 'State-space model', short: 'State-space', training: 0.8, serving: 0.4, risk: 0.58, note: 'Experimental cheap sequence processing; capability is less certain.' },
  { id: 'diffusion', label: 'Diffusion network', short: 'Diffusion', training: 1.3, serving: 1.6, risk: 0.82, note: 'Iterative visual generation; slower serving buys creative flexibility.' },
] as const;
export const AI_METHODS = [
  { id: 'pretrain', label: 'Pretraining', short: 'Base', cost: 1, data: 1, quality: 0.88, note: 'Build the base model from a large corpus.' },
  { id: 'instruction', label: 'Instruction tuning', short: 'Instruct', cost: 0.22, data: 0.16, quality: 0.96, note: 'Teach a base model to follow instructions with supervised examples.' },
  { id: 'preference', label: 'Human-feedback training', short: 'RLHF', cost: 0.38, data: 0.12, quality: 1, note: 'Graded preferences improve helpfulness; annotation costs more.' },
  { id: 'distill', label: 'Distillation', short: 'Distilled', cost: 0.16, data: 0.22, quality: 0.8, note: 'A smaller student: cheaper serving with a capability trade-off.' },
] as const;
export const AI_OUTPUTS = [
  { id: 'text', label: 'Text', training: 1, demand: 100, price: 400_000, industry: 'consumer' },
  { id: 'code', label: 'Code', training: 1.25, demand: 65, price: 700_000, industry: 'ai' },
  { id: 'image', label: 'Images', training: 1.4, demand: 80, price: 550_000, industry: 'consumer' },
  { id: 'speech', label: 'Speech', training: 1.6, demand: 45, price: 800_000, industry: 'consumer' },
  { id: 'video', label: 'Video', training: 5, demand: 12, price: 2_000_000, industry: 'consumer' },
  { id: 'actions', label: 'Structured actions', training: 2.5, demand: 25, price: 1_200_000, industry: 'robotics' },
] as const;
export type AiArchitecture = typeof AI_ARCHITECTURES[number]['id'];
export type AiMethod = typeof AI_METHODS[number]['id'];
export type AiOutput = typeof AI_OUTPUTS[number]['id'];
export interface AiModelDesign { readonly nodeId: string; readonly architecture: AiArchitecture; readonly method: AiMethod; readonly output: AiOutput; readonly qualityFactor: number; readonly servingFactor: number }
export const aiModelNodeId = (architecture: AiArchitecture, method: AiMethod, output: AiOutput): string => `sys_model_${architecture}_${method}_${output}`;
function compatible(a: AiArchitecture, m: AiMethod, o: AiOutput): boolean {
  if (a === 'diffusion') return (o === 'image' || o === 'video') && (m === 'pretrain' || m === 'distill');
  if (o === 'image' || o === 'video') return false;
  if (a === 'state_space') return (o === 'text' || o === 'code') && (m === 'pretrain' || m === 'distill');
  return a === 'dense' || o === 'text' || o === 'code';
}
export const AI_MODEL_DESIGNS: readonly AiModelDesign[] = AI_ARCHITECTURES.flatMap(a => AI_METHODS.flatMap(m => AI_OUTPUTS.filter(o => compatible(a.id, m.id, o.id)).map(o => ({
  nodeId: aiModelNodeId(a.id, m.id, o.id), architecture: a.id, method: m.id, output: o.id,
  qualityFactor: m.quality * (a.id === 'state_space' ? 0.9 : 1), servingFactor: a.serving * (m.id === 'distill' ? 0.3 : 1),
}))));
export const AI_MODEL_DESIGNS_BY_ID: Readonly<Record<string, AiModelDesign>> = Object.fromEntries(AI_MODEL_DESIGNS.map(d => [d.nodeId, d]));
export const OPENING_AI_MODEL_ID = aiModelNodeId('dense', 'pretrain', 'text');
export function buildAiModelNodes(base: EconomicNode): readonly EconomicNode[] {
  return AI_MODEL_DESIGNS.map(design => {
    const a = AI_ARCHITECTURES.find(v => v.id === design.architecture)!;
    const m = AI_METHODS.find(v => v.id === design.method)!;
    const o = AI_OUTPUTS.find(v => v.id === design.output)!;
    const experimental = a.id === 'state_space' || o.id === 'video' || o.id === 'actions';
    const programme = 2_000_000 * a.training * m.cost * o.training;
    const baseId = aiModelNodeId(a.id, 'pretrain', o.id);
    const slots = base.slots.filter(s => s.id === 'compute' || s.id === 'corpus').map(s => ({ ...s, ...(s.id === 'corpus' ? { accepts: [aiDatasetId(o.id)], defaultNodeId: aiDatasetId(o.id), label: `${o.label} data` } : {}), qtyPerUnit: s.qtyPerUnit * a.training * o.training * (s.id === 'corpus' ? m.data : m.cost) * 0.005 }));
    if (m.id === 'preference') slots.push({ id: 'preferences', role: 'dataset', label: 'Human preferences', qtyPerUnit: 2, required: true, blocking: true, accepts: ['dat_preference_data'], defaultNodeId: 'dat_preference_data', kind: 'input' });
    return EconomicNodeSchema.parse({ ...base, id: design.nodeId,
      label: `${a.short} ${m.short} · ${o.label}`,
      blurb: `${o.label} model. ${a.note}`.slice(0,140),
      maturity: experimental ? 'speculative' : 'emerging',
      requires: m.id === 'pretrain' ? ['svc_training_run', aiDatasetId(o.id)] : [baseId, ...(m.id === 'preference' ? ['dat_preference_data'] : [])],
      slots, basePriceUsd: Math.round(o.price * (m.id === 'distill' ? 0.45 : m.id === 'preference' ? 1.3 : 1)),
      capacityDrawPerUnit: 5 * o.training * design.servingFactor,
      labourPerUnit: 0.8 * a.training * o.training, energyMwhPerUnit: 3 * o.training * design.servingFactor,
      researchCostRangeUsd: [Math.round(programme * 0.65), Math.round(programme * 1.65)],
      researchComputeIntensity: Math.min(1, 0.5 * a.training * m.cost * o.training), dataRequiredPb: 0.08 * o.training * m.data,
      talentAreas: [a.id === 'state_space' || m.id === 'distill' ? 'efficiency' : 'training_systems', o.id === 'text' || o.id === 'code' ? 'reasoning' : 'multimodal', ...(m.id === 'preference' ? ['safety_alignment'] : [])],
      publicConfidence: experimental ? 0.25 : a.risk, plausibility: a.risk, novelty: experimental ? 0.8 : 0.3,
      estimatedWindow: [2023, experimental ? 2028 : 2025],
      endDemandBaseUnits: o.demand, market: { customers: o.id === 'code' ? { developer_api: 0.8, enterprise: 0.2 } : { enterprise: 0.7, developer_api: 0.3 }, industries: { [o.industry]: 1 } },
    });
  });
}

export const AI_BOOM_START_YEAR = 2023;
export const AI_BOOM_SCENARIO_ID = 'chatgpt_boom_2023';
/** Research opportunities exist, but these products are not established suppliers at the opening. */
export const EARLY_AI_LOCKED_NODES = new Set(['svc_agent_harness', 'app_agent_platform', 'app_ai_software_suite', 'sys_humanoid_robot', 'sys_ai_wearable']);
export function availableAtAiBoomOpening(id: string): boolean {
  if (EARLY_AI_LOCKED_NODES.has(id)) return false;
  const design = AI_MODEL_DESIGNS_BY_ID[id];
  return design === undefined || id === OPENING_AI_MODEL_ID;
}
export const aiDatasetId = (output: AiOutput): string => output === 'text' ? 'dat_web_corpus' : `dat_model_${output}`;
export function buildAiDatasets(base: EconomicNode): readonly EconomicNode[] {
  return AI_OUTPUTS.filter(o => o.id !== 'text').map(o => EconomicNodeSchema.parse({ ...base,
    id: aiDatasetId(o.id), label: `${o.label} training data`, blurb: `Curated, rights-cleared ${o.label.toLowerCase()} examples for training and evaluating specialised models.`,
    basePriceUsd: Math.round(12_000 * o.training), endDemandBaseUnits: o.demand * 25,
    researchCostRangeUsd: [Math.round(80_000 * o.training), Math.round(240_000 * o.training)],
    dataRequiredPb: 0.01 * o.training, estimatedWindow: [2023, 2024],
  }));
}

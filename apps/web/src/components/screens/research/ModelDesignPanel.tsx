'use client';
import { useState } from 'react';
import { AI_ARCHITECTURES, AI_METHODS, AI_OUTPUTS, AI_MODEL_DESIGNS, AI_MODEL_DESIGNS_BY_ID, economicNodeById, type AiArchitecture, type AiMethod, type AiOutput } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { Panel } from '@/components/ui';

export function ModelDesignPanel({ onOpenNode }: { readonly onOpenNode: (id: string) => void }): React.JSX.Element {
  const [architecture, setArchitecture] = useState<AiArchitecture>('dense');
  const [method, setMethod] = useState<AiMethod>('instruction');
  const [output, setOutput] = useState<AiOutput>('text');
  const architectureDesigns = AI_MODEL_DESIGNS.filter(d => d.architecture === architecture);
  const methods = AI_METHODS.filter(m => architectureDesigns.some(d => d.method === m.id));
  const effectiveMethod = methods.some(m => m.id === method) ? method : methods[0]!.id;
  const outputs = AI_OUTPUTS.filter(o => architectureDesigns.some(d => d.method === effectiveMethod && d.output === o.id));
  const effectiveOutput = outputs.some(o => o.id === output) ? output : outputs[0]!.id;
  const design = architectureDesigns.find(d => d.method === effectiveMethod && d.output === effectiveOutput)!;
  const node = economicNodeById(design.nodeId)!;
  const arch = AI_ARCHITECTURES.find(a => a.id === architecture)!;
  const training = AI_METHODS.find(m => m.id === effectiveMethod)!;
  const fieldClass = 'mt-1 w-full rounded-lg border border-line bg-paper p-3 text-sm text-ink';
  return <Panel title="Design a model" subtitle="Choose a research direction. Each combination has its own programme, costs and market.">
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm font-semibold">Architecture<select aria-label="Model architecture" className={fieldClass} value={architecture} onChange={e => setArchitecture(e.target.value as AiArchitecture)}>{AI_ARCHITECTURES.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
      <label className="text-sm font-semibold">Training method<select aria-label="Training method" className={fieldClass} value={effectiveMethod} onChange={e => setMethod(e.target.value as AiMethod)}>{methods.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <label className="text-sm font-semibold">Model output<select aria-label="Model output" className={fieldClass} value={effectiveOutput} onChange={e => setOutput(e.target.value as AiOutput)}>{outputs.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
    </div>
    <div className="mt-4 space-y-2 text-sm text-ink-muted"><p>{arch.note}</p><p>{training.note}</p></div>
    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-ink-faint">Programme estimate</dt><dd className="font-semibold">{formatMoney(node.researchCostRangeUsd[0])}–{formatMoney(node.researchCostRangeUsd[1])}</dd></div>
      <div><dt className="text-ink-faint">Serving compute</dt><dd className="font-semibold">{design.servingFactor.toFixed(2)}× dense baseline</dd></div>
      <div><dt className="text-ink-faint">Capability factor</dt><dd className="font-semibold">{design.qualityFactor.toFixed(2)}× before execution and data</dd></div>
      <div><dt className="text-ink-faint">Research outlook</dt><dd className="font-semibold">{node.maturity === 'speculative' ? 'Experimental' : 'Emerging'} · {Math.round(node.publicConfidence * 100)}% public confidence</dd></div>
    </dl>
    <p className="mt-3 text-xs text-ink-faint">Game estimates, not real benchmarks. Duration depends on your budget, team, data and compute. Research must succeed before you can launch or license this model.</p>
    <div className="mt-4"><p className="text-sm font-semibold">Prerequisites</p><div className="mt-2 flex flex-wrap gap-2">{node.requires.map(id => <button key={id} type="button" className="rounded-lg border border-line px-3 py-2 text-sm underline" onClick={() => onOpenNode(id)}>{economicNodeById(id)?.label ?? id}</button>)}</div></div>
    <button type="button" className="mt-4 w-full rounded-xl bg-brand px-4 py-3 font-semibold text-white" onClick={() => onOpenNode(node.id)}>Review {node.label}</button>
  </Panel>;
}

export function ModelDesignSummary({ nodeId }: { readonly nodeId: string }): React.JSX.Element | null {
  const design = AI_MODEL_DESIGNS_BY_ID[nodeId];
  if (!design) return null;
  return <p className="text-sm text-ink-muted">{AI_ARCHITECTURES.find(a => a.id === design.architecture)?.label} · {AI_METHODS.find(m => m.id === design.method)?.label} · {AI_OUTPUTS.find(o => o.id === design.output)?.label}</p>;
}

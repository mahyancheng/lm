'use client';

/**
 * Propose an innovation.
 *
 * Three steps, in this order, with no shortcuts: **write → review → queue.**
 *
 * The player writes a thesis in their own words. The Innovation Interpreter
 * turns it into a typed `InnovationProposal`, which is rendered here field by
 * field for review — never as prose to be skimmed and never as a node that has
 * already happened. Queuing it submits a `propose_innovation` action; the engine
 * assesses plausibility, cost and duration itself and may refuse it outright.
 *
 * When no model is configured the interpreter declines by design, and the
 * guided form below is the deterministic path: the same fields, stated by the
 * player. Either route produces the same object.
 */

import { useMemo, useState } from 'react';
import type {
  ActionValidationResult,
  Company,
  InnovationProposal,
  SessionState,
  TechGraph,
} from '@frontier/contracts';
import { assessCostUsd, assessPlausibility, reachableCapitalUsd } from '@frontier/simulation';
import { formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import {
  DeltaBadge,
  EmptyState,
  KeyValueGrid,
  Panel,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  roundStep,
} from '@/components/ui';
import { useGameActions, useLlm } from '@/lib/game';
import { buildInnovationInput, requestInnovation } from './innovationClient';

export interface InnovationPanelProps {
  readonly session: SessionState;
  readonly company: Company;
  /** The reduced map. Never `session.techGraph`. */
  readonly graph: TechGraph;
  readonly researchEnvelopeUsd: number;
  readonly computeUnits: number;
}

type Mode = 'write' | 'form' | 'review';

const EMPTY_FORM = {
  title: '',
  summary: '',
  novelty: 0.6,
  plausibility: 0.5,
  capabilities: '',
  estimatedCost: '250000000',
  estimatedQuarters: 8,
  visibility: 'company_private' as 'company_private' | 'public',
  rationale: '',
};

export function InnovationPanel({ session, company, graph, researchEnvelopeUsd, computeUnits }: InnovationPanelProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const llm = useLlm();

  const [mode, setMode] = useState<Mode>('write');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [proposal, setProposal] = useState<InnovationProposal | null>(null);
  const [dependencies, setDependencies] = useState<readonly string[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const allowed = session.config.allowPlayerInnovation;

  const costEstimateValue = Math.max(0, Number.parseFloat(form.estimatedCost) || 0);
  const costEstimateMax = Math.max(reachableCapitalUsd(company), costEstimateValue, 1_000_000_000);

  const assessment = useMemo(() => {
    if (proposal === null) return null;
    const known = graph.nodes.filter((node) => proposal.dependencies.includes(node.id));
    return {
      plausibility: assessPlausibility(session, proposal, known, company),
      costUsd: assessCostUsd(proposal),
      reachableUsd: reachableCapitalUsd(company),
    };
  }, [proposal, graph.nodes, session, company]);

  async function interpret(): Promise<void> {
    if (idea.trim().length === 0) return;
    setBusy(true);
    setDeclined(false);
    try {
      const input = buildInnovationInput(session, company, graph, idea.trim(), researchEnvelopeUsd, computeUnits);
      const output = await requestInnovation(input);
      if (output === null) {
        setDeclined(true);
        setForm((current) => ({ ...current, rationale: idea.trim().slice(0, 800) }));
        setMode('form');
      } else {
        setProposal({ ...output, dependencies: output.dependencies.filter((id) => graph.nodes.some((node) => node.id === id)) });
        setDependencies(output.dependencies);
        setMode('review');
      }
    } finally {
      setBusy(false);
    }
  }

  function buildFromForm(): void {
    const cost = Number.parseFloat(form.estimatedCost);
    const built: InnovationProposal = {
      nodeType: 'player_hypothesis',
      title: form.title.trim().slice(0, 120),
      summary: form.summary.trim().slice(0, 1000),
      novelty: form.novelty,
      plausibility: form.plausibility,
      requiredCapabilities: form.capabilities
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 8),
      estimatedCost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      estimatedQuarters: form.estimatedQuarters,
      dependencies: [...dependencies],
      initialVisibility: form.visibility,
      rationale: form.rationale.trim().slice(0, 800),
    };
    setProposal(built);
    setMode('review');
  }

  const formValid = form.title.trim().length >= 3 && form.summary.trim().length >= 20 && form.rationale.trim().length >= 20;

  const preview = proposal === null ? null : validateIntent({ type: 'propose_innovation', proposal });

  function submit(): void {
    if (proposal === null) return;
    const entry = queueAction({ type: 'propose_innovation', proposal });
    setResult(entry.validation);
  }

  function reset(): void {
    setProposal(null);
    setResult(null);
    setDeclined(false);
    setDependencies([]);
    setForm(EMPTY_FORM);
    setMode('write');
  }

  function toggleDependency(id: string): void {
    setDependencies((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id].slice(0, 8)));
  }

  if (!allowed) {
    return (
      <Panel iconName="flask" title="Propose an innovation">
        <EmptyState
          icon="flask"
          title="Player innovation is disabled"
          message="This session was created with allowPlayerInnovation off. The Frontier Map changes only through world events and delivered research."
        />
      </Panel>
    );
  }

  return (
    <Panel
      iconName="flask"
      iconTone="brand"
      title="Propose an innovation"
      subtitle="A technology the Frontier Map has never contained"
      actions={
        mode === 'write' ? (
          <Tag tone={llm.available ? 'brand' : 'neutral'} dot>
            {llm.available ? `Interpreter on ${llm.model ?? 'the configured model'}` : 'Guided form'}
          </Tag>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm tap-target sm:min-h-0" onClick={reset}>
            Start again
          </button>
        )
      }
    >
      {mode === 'write' ? (
        <div className="space-y-2.5">
          <p className="text-[13px] leading-relaxed text-ink-dim sm:text-[11px]">
            Write the idea in your own words — the mechanism, not the marketing. It is interpreted into a typed proposal you review before anything is
            submitted, and the engine assesses it independently of what you claim.
          </p>
          <textarea
            className="field tap-target sm:min-h-0"
            rows={5}
            maxLength={1200}
            placeholder="Millions of agents learning economic behaviour together in persistent simulated environments, so that pricing and negotiation emerge from the population rather than from a reward model…"
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <button type="button" className="btn btn-ghost btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={() => setMode('form')}>
              State the fields myself
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0"
              disabled={busy || idea.trim().length < 12}
              onClick={() => void interpret()}
            >
              {busy ? 'Interpreting…' : 'Interpret'}
            </button>
          </div>
          {!llm.available ? (
            <p className="text-[12px] leading-relaxed text-ink-faint sm:text-[10px]">
              No model is configured, so the interpreter will decline and the guided form opens instead. A node is never added to the map without
              interpretation — stating the fields yourself is that interpretation.
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === 'form' ? (
        <div className="space-y-3">
          {declined ? (
            <div className="rounded-card border border-warn/25 bg-warn-wash px-3.5 py-2.5 text-[11px] text-warn">
              The interpreter declined — no model answered. State the fields yourself; the object you produce is identical.
            </div>
          ) : null}

          <label className="block">
            <span className="label-caps-faint mb-1 block">Title</span>
            <input className="field tap-target sm:min-h-0" maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>

          <label className="block">
            <span className="label-caps-faint mb-1 block">What it is — two to four sentences</span>
            <textarea className="field tap-target sm:min-h-0" rows={3} maxLength={1000} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label-caps-faint mb-1 flex items-baseline justify-between">
                <span>Novelty</span>
                <span className="figure text-ink-dim">{formatPct(form.novelty)}</span>
              </span>
              <input type="range" className="tap-target w-full sm:min-h-0" min={0} max={1} step={0.05} value={form.novelty} onChange={(event) => setForm({ ...form, novelty: Number(event.target.value) })} />
            </label>
            <label className="block">
              <span className="label-caps-faint mb-1 flex items-baseline justify-between">
                <span>Plausibility</span>
                <span className="figure text-ink-dim">{formatPct(form.plausibility)}</span>
              </span>
              <input
                type="range"
                className="tap-target w-full sm:min-h-0"
                min={0}
                max={1}
                step={0.05}
                value={form.plausibility}
                onChange={(event) => setForm({ ...form, plausibility: Number(event.target.value) })}
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block sm:col-span-2">
              <span className="label-caps-faint mb-1 block">Capabilities needed, comma separated</span>
              <input className="field tap-target sm:min-h-0" value={form.capabilities} onChange={(event) => setForm({ ...form, capabilities: event.target.value })} placeholder="agents, training_systems" />
            </label>
            {/* 1..60 is the InnovationProposalSchema bound the same clamp
                enforced when this was a typed field. */}
            <SliderField
              label="Quarters"
              value={form.estimatedQuarters}
              onChange={(next) => setForm({ ...form, estimatedQuarters: Math.max(1, Math.min(60, Math.round(next))) })}
              min={1}
              max={60}
              step={1}
              format={formatQuarterCount}
              exact={false}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* The engine judges the estimate against reachable capital, so
                that is the range worth stating an estimate inside. */}
            <SliderField
              label="Your cost estimate"
              value={costEstimateValue}
              onChange={(next) => setForm({ ...form, estimatedCost: String(next) })}
              min={0}
              max={costEstimateMax}
              step={roundStep(costEstimateMax)}
              format={formatMoney}
            />
            <label className="block">
              <span className="label-caps-faint mb-1 block">Initial visibility</span>
              <select className="field tap-target sm:min-h-0" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value as 'company_private' | 'public' })}>
                <option value="company_private">Company private — keep the thesis secret</option>
                <option value="public">Public — announce it, and surrender surprise</option>
              </select>
            </label>
          </div>

          <div>
            <span className="label-caps-faint mb-1 block">Builds on</span>
            <div className="flex flex-wrap gap-1.5">
              {graph.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`btn btn-sm tap-target sm:min-h-0 ${dependencies.includes(node.id) ? 'btn-primary' : ''}`}
                  onClick={() => toggleDependency(node.id)}
                >
                  {node.title}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="label-caps-faint mb-1 block">Why now, given this company and this world</span>
            <textarea className="field tap-target sm:min-h-0" rows={3} maxLength={800} value={form.rationale} onChange={(event) => setForm({ ...form, rationale: event.target.value })} />
          </label>

          <div className="grid grid-cols-[auto_1fr] gap-2 sm:flex sm:justify-end">
            <button type="button" className="btn btn-sm tap-target sm:min-h-0" onClick={() => setMode('write')}>
              Back
            </button>
            <button type="button" className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0" disabled={!formValid} onClick={buildFromForm}>
              Review the proposal
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'review' && proposal !== null ? (
        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag tone="brand">Player hypothesis</Tag>
              <Tag tone={proposal.initialVisibility === 'public' ? 'info' : 'warn'}>
                {proposal.initialVisibility === 'public' ? 'Public on acceptance' : 'Company private'}
              </Tag>
            </div>
            <h3 className="mt-2 text-[15px] font-semibold text-ink">{proposal.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-dim sm:text-[12px]">{proposal.summary}</p>
          </div>

          <div>
            <SectionHeading rule>What you claimed</SectionHeading>
            <div className="mt-2">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Novelty', value: formatPct(proposal.novelty) },
                  { label: 'Plausibility', value: formatPct(proposal.plausibility) },
                  { label: 'Cost', value: formatMoney(proposal.estimatedCost) },
                  { label: 'Duration', value: `${proposal.estimatedQuarters} quarters` },
                  {
                    label: 'Capabilities',
                    value: proposal.requiredCapabilities.length === 0 ? 'none named' : proposal.requiredCapabilities.join(', '),
                    mono: false,
                    wide: true,
                  },
                  {
                    label: 'Builds on',
                    value:
                      proposal.dependencies.length === 0
                        ? 'nothing on the map'
                        : proposal.dependencies.map((id) => graph.nodes.find((node) => node.id === id)?.title ?? id).join(' · '),
                    mono: false,
                    wide: true,
                  },
                ]}
              />
            </div>
          </div>

          {assessment === null ? null : (
            <div>
              <SectionHeading rule>What the engine makes of it</SectionHeading>
              <div className="mt-2 space-y-2">
                <div className="raised-surface flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="text-[11px] text-ink-dim">Plausibility</span>
                  <span className="figure text-[12px] text-ink">
                    you {formatPct(proposal.plausibility)} <span className="text-ink-faint">→</span> engine {formatPct(assessment.plausibility)}
                  </span>
                  <DeltaBadge value={assessment.plausibility - proposal.plausibility} format="points" />
                </div>
                <div className="raised-surface flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="text-[11px] text-ink-dim">Cost</span>
                  <span className="figure text-[12px] text-ink">
                    you {formatMoney(proposal.estimatedCost)} <span className="text-ink-faint">→</span> engine {formatMoney(assessment.costUsd)}
                  </span>
                  <DeltaBadge
                    value={proposal.estimatedCost === 0 ? 0 : assessment.costUsd / proposal.estimatedCost - 1}
                    format="percent"
                    invert
                  />
                </div>
                <div className="raised-surface flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="text-[11px] text-ink-dim">Capital you can reach</span>
                  <span className="figure text-[12px] text-ink">{formatMoney(assessment.reachableUsd)}</span>
                  <Tag tone={assessment.reachableUsd >= assessment.costUsd ? 'gain' : 'warn'} dot>
                    {assessment.reachableUsd >= assessment.costUsd ? 'Within reach' : 'Beyond this company'}
                  </Tag>
                </div>
                <p className="text-[10px] text-ink-faint">
                  The engine reassesses all three at resolution and returns the adjusted figures with its decision. Duration is assessed there too:
                  a proposal is accepted, adjusted or refused, and the reasons are given in player-readable language.
                </p>
              </div>
            </div>
          )}

          <div>
            <SectionHeading rule>Rationale</SectionHeading>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim sm:text-[11px]">{proposal.rationale}</p>
          </div>

          <p className="text-[13px] text-warn sm:text-[11px]">No binding action has been submitted yet.</p>

          <div className="grid grid-cols-[auto_1fr] gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <button type="button" className="btn btn-sm tap-target sm:min-h-0" onClick={() => setMode('form')}>
              Edit
            </button>
            <button type="button" className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={submit}>
              Queue proposal
            </button>
          </div>

          {result === null && preview !== null ? <ValidationBanner result={preview} compact /> : null}
          {result === null ? null : <ValidationBanner result={result} />}

          {assessment !== null && assessment.plausibility < 0.35 ? (
            <p className="text-[10px] text-ink-faint">A low-plausibility proposal is not refused outright: it becomes a speculative node that is expensive to prove.</p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

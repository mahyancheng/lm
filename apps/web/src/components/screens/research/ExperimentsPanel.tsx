'use client';

import { useEffect, useRef, useState } from 'react';
import type { ActionValidationResult, Company, ExperimentPlan, InnovationProposal, ResearchProject, SessionState, TechGraph } from '@frontier/contracts';
import { ExperimentPlanSchema } from '@frontier/contracts';
import { experimentResources, experimentReviewError, isNodeEconomyWorld } from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { AiLabel, Panel, Tag, ValidationBanner } from '@/components/ui';
import { useGameActions, useLlm, useQueuedActions, useResolving, useSettings } from '@/lib/game';
import { buildInnovationInput, requestInnovation } from './innovationClient';
import { experimentProposal, experimentReviewInput } from './experimentClient';

type Props = { session: SessionState; company: Company; graph: TechGraph; onFollowUp: (idea: string) => void };

export function ExperimentsPanel({ session, company, graph, onFollowUp }: Props): React.JSX.Element | null {
  const { queueAction, validateIntent } = useGameActions();
  const settings = useSettings();
  const llm = useLlm();
  const { resolving } = useResolving();
  const queued = useQueuedActions();
  const free = experimentResources(session, company);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [method, setMethod] = useState('');
  const [budget, setBudget] = useState(Math.max(1, Math.min(100_000, company.financials.cash)));
  const [compute, setCompute] = useState(Math.min(100, free.computeUnits));
  const [researchers, setResearchers] = useState(Math.min(2, free.researchersAssigned));
  const [interval, setInterval] = useState(1);
  const [proposal, setProposal] = useState<InnovationProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [aiDesigned, setAiDesigned] = useState(false);
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const epoch = useRef(0);
  useEffect(() => { epoch.current += 1; setBusy(false); setProposal(null); setResult(null); return () => { epoch.current += 1; }; }, [session.sessionId, company.id, session.quarter]);
  const live = llm.available && settings.useLiveModel;
  const planResult = ExperimentPlanSchema.safeParse({ question: question.trim(), method: method.trim() || question.trim(), budgetUsd: budget, computeUnits: compute, researchersAssigned: researchers, reviewAfterQuarters: interval });
  const plan: ExperimentPlan | null = planResult.success ? planResult.data : null;
  const experiments = session.researchProjects.filter((project) => project.companyId === company.id && project.experiment);
  if (!isNodeEconomyWorld(session)) return null;

  async function design() {
    if (!plan || busy) return;
    const generation = epoch.current;
    setBusy(true); setMessage(''); setResult(null);
    try {
      const input = buildInnovationInput(session, company, graph, plan.question, plan.budgetUsd, plan.computeUnits);
      const output = await requestInnovation({ ...input, experimentMode: 'design', experimentContext: JSON.stringify(plan) });
      if (generation !== epoch.current) return;
      if (!output?.experiment) { setMessage('No experiment design was returned. Your idea is preserved; try again or run it as written.'); return; }
      // Resource choices belong to the founder. The model may suggest a method, never a larger mandate.
      const { experimentReview: _review, ...base } = output;
      setAiDesigned(true);
      setProposal({ ...base, initialVisibility: 'company_private', experiment: { ...plan, method: output.experiment.method } });
    } finally { if (generation === epoch.current) setBusy(false); }
  }
  const preview = proposal ? validateIntent({ type: 'propose_innovation', proposal }) : null;
  const alreadyQueued = proposal && queued.some((entry) => entry.action.intent.type === 'propose_innovation' && entry.action.intent.proposal.title === proposal.title);

  return <>
    <Panel title="Open-ended experiments" iconName="flask" subtitle="Commit resources to a question. Discover what happens before deciding what to build." actions={<button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? 'Close form' : 'New experiment'}</button>}>
      <p className="text-sm text-ink-dim">Spare compute: {formatCount(free.computeUnits)} · Unassigned researchers: {formatCount(free.researchersAssigned)}</p>
      {!session.config.allowPlayerInnovation ? <p className="mt-2 text-sm text-warn">New experiments are disabled by this session’s innovation setting.</p> : null}
      {open ? <div className="mt-4 space-y-3">
        <label className="block text-sm">What do you want to investigate?
          <textarea className="field mt-1" disabled={busy} rows={3} maxLength={1200} value={question} onChange={(event) => { setQuestion(event.target.value); setProposal(null); }} placeholder="Use our spare compute to let black-box agents self-evolve. See whether they develop useful behaviours and test whether the gains generalise." />
        </label>
        <label className="block text-sm">How should the team approach it? (optional)
          <textarea className="field mt-1" disabled={busy} rows={2} maxLength={1200} value={method} onChange={(event) => { setMethod(event.target.value); setProposal(null); }} placeholder="Let the agents suggest variations; keep an independent evaluation and compare against the starting population." />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Cash per quarter<input className="field mt-1" disabled={busy} type="number" min={1} max={1e12} value={budget} onChange={(event) => { setBudget(Number(event.target.value)); setProposal(null); }} /></label>
          <label className="text-sm">Compute units<input className="field mt-1" disabled={busy} type="number" min={0} max={free.computeUnits} value={compute} onChange={(event) => { setCompute(Number(event.target.value)); setProposal(null); }} /></label>
          <label className="text-sm">Researchers<input className="field mt-1" disabled={busy} type="number" min={1} max={free.researchersAssigned} value={researchers} onChange={(event) => { setResearchers(Number(event.target.value)); setProposal(null); }} /></label>
          <label className="text-sm">Review after<select disabled={busy} className="field mt-1" value={interval} onChange={(event) => { setInterval(Number(event.target.value)); setProposal(null); }}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} quarter{value === 1 ? '' : 's'}</option>)}</select></label>
        </div>
        <p className="text-sm text-ink-dim">Cash ceiling for this round: {formatMoney(budget * interval)}. Uses existing compute and staff; their ownership, rental and payroll costs continue. Work pauses at the checkpoint.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={!plan || !live || busy || resolving || !session.config.allowPlayerInnovation} onClick={() => void design()}>{busy ? 'Designing…' : 'Develop with AI'}</button>
          <button type="button" className="btn" disabled={!plan || busy || resolving || !session.config.allowPlayerInnovation} onClick={() => { if (plan) { setAiDesigned(false); setProposal(experimentProposal(plan)); setResult(null); } }}>Run as written</button>
        </div>
        {!live ? <p className="text-sm text-ink-faint">You can start an investigation now. Turn on the live model in Settings to interpret its findings; no findings are invented while it is offline.</p> : null}
        {message ? <p role="status" className="text-sm text-warn">{message}</p> : null}
        {proposal?.experiment ? <div className="rounded-card border border-hair p-3 space-y-2">
          {aiDesigned ? <AiLabel /> : null}<h3 className="font-semibold">{proposal.title}</h3><p className="text-sm">{proposal.experiment.method}</p>
          <p className="text-sm text-ink-dim">Private investigation · {formatMoney(proposal.experiment.budgetUsd * proposal.experiment.reviewAfterQuarters)} cash ceiling · {formatCount(proposal.experiment.computeUnits)} compute units · {formatCount(proposal.experiment.researchersAssigned)} researchers</p>
          <button type="button" className="btn btn-primary" disabled={resolving || busy || !!alreadyQueued || preview?.status === 'rejected'} onClick={() => setResult(queueAction({ type: 'propose_innovation', proposal }).validation)}>{alreadyQueued ? 'Experiment queued' : 'Queue experiment'}</button>
          <ValidationBanner result={result ?? preview} />
        </div> : null}
      </div> : null}
      {experiments.length === 0 && !open ? <p className="mt-3 text-sm text-ink-faint">No experiments yet. An investigation can start with a question that has no entry on the technology map.</p> : null}
    </Panel>
    {experiments.map((project) => <ExperimentCard key={`${project.id}:${project.experiment!.round}`} {...{ session, company, graph, project, onFollowUp, live, resolving }} />)}
  </>;
}

function ExperimentCard({ session, company, graph, project, onFollowUp, live, resolving }: Props & { project: ResearchProject; live: boolean; resolving: boolean }) {
  const { queueAction, validateIntent } = useGameActions();
  const queued = useQueuedActions();
  const experiment = project.experiment!;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<InnovationProposal | null>(null);
  const [direction, setDirection] = useState(experiment.mandate.method);
  const [nextBudget, setNextBudget] = useState(experiment.mandate.budgetUsd);
  const [nextCompute, setNextCompute] = useState(experiment.mandate.computeUnits);
  const [nextResearchers, setNextResearchers] = useState(experiment.mandate.researchersAssigned);
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setBusy(false); setReview(null); setResult(null); return () => { generation.current += 1; }; }, [session.quarter, project.id, experiment.round]);
  const finding = experiment.findings.find((entry) => entry.round === experiment.round);
  const title = graph.nodes.find((entry) => entry.id === project.targetNodeId)?.title ?? experiment.mandate.question;
  const pendingReview = queued.some((entry) => entry.action.intent.type === 'propose_innovation' && entry.action.intent.proposal.experimentReview?.projectId === project.id);
  const pendingChange = queued.some((entry) => (entry.action.intent.type === 'adjust_research_project' || entry.action.intent.type === 'abandon_research_project') && entry.action.intent.projectId === project.id);
  const continuation = { type: 'adjust_research_project' as const, projectId: project.id, budgetUsd: nextBudget, computeUnits: nextCompute, researchersAssigned: nextResearchers, experimentDirection: direction };
  const continuationPreview = finding && direction.trim().length >= 12 ? validateIntent(continuation) : null;

  async function interpret() {
    const token = generation.current;
    setBusy(true); setMessage('');
    try {
      const output = await requestInnovation(experimentReviewInput(session, company, graph, project));
      if (token !== generation.current) return;
      if (!output?.experimentReview) { setMessage('The model did not return findings. The experiment remains paused and its recorded work is saved.'); return; }
      const error = experimentReviewError(session, company.id, output.experimentReview);
      if (error) { setMessage(error); return; }
      const { experiment: _plan, ...base } = output;
      setReview(base);
    } finally { if (token === generation.current) setBusy(false); }
  }
  const output = review?.experimentReview;
  return <Panel title={title} iconName="flask" subtitle={`Round ${experiment.round} · ${project.status === 'abandoned' ? 'Closed' : experiment.awaitingReview ? finding ? 'Findings recorded' : 'Ready for review' : 'Running'}`}>
    <p className="text-sm">{experiment.mandate.method}</p>
    <p className="mt-2 text-sm text-ink-dim">{formatMoney(project.cumulativeSpendUsd)} cash used in total · {formatCount(experiment.computeUsed)} compute-unit quarters this round · {formatCount(experiment.researcherQuarters)} researcher quarters</p>
    {experiment.awaitingReview && !finding && project.status === 'paused' ? <div className="mt-3 space-y-2">
      <p className="text-sm">Spending has stopped and resources are released. Review the work to learn what happened.</p>
      <button type="button" className="btn btn-primary" disabled={!live || busy || resolving || pendingReview || !!output || experiment.roundQuarters === 0} onClick={() => void interpret()}>{busy ? 'Reviewing…' : 'Interpret findings with AI'}</button>
      {!live ? <p className="text-sm text-ink-faint">Enable the live model in Settings to review these findings. Your experiment can wait without spending more.</p> : null}
      {experiment.roundQuarters === 0 ? <p className="text-sm text-warn">No funded work could run. Close this investigation and start one that fits the available resources.</p> : null}
      {output && review ? <div className="rounded-card border border-hair p-3 space-y-2"><AiLabel /><p className="font-medium">Proposed findings · {output.outcome.replaceAll('_', ' ')}</p><p className="text-sm">{output.observation}</p><p className="text-sm text-ink-dim">{output.interpretation}</p><button type="button" className="btn" disabled={pendingReview || resolving} onClick={() => setResult(queueAction({ type: 'propose_innovation', proposal: review }).validation)}>{pendingReview ? 'Findings queued' : 'Record findings next quarter'}</button></div> : null}
    </div> : null}
    {experiment.findings.map((entry) => <div key={entry.round} className="mt-3 rounded-card border border-hair p-3 space-y-2"><div className="flex items-center gap-2"><Tag>Round {entry.round}</Tag><AiLabel /></div><p className="text-sm">{entry.observation}</p><p className="text-sm text-ink-dim">{entry.interpretation}</p>{entry.capabilityGains.map((gain) => <p key={gain.area} className="text-sm">{gain.area}: +{formatPct(gain.gain)}</p>)}<div className="flex flex-col gap-2">{entry.nextDirections.map((next, index) => <button key={index} type="button" className="btn text-left whitespace-normal" onClick={() => setDirection(next)}>{next}</button>)}</div><button type="button" className="btn btn-sm" onClick={() => onFollowUp(`Based on our experiment: ${entry.observation}\nInterpretation: ${entry.interpretation}\nPropose a follow-up technology: ${entry.nextDirections[0]}`.slice(0, 1200))}>Develop a new research proposal</button></div>)}
    {finding && project.status === 'paused' ? <div className="mt-3 space-y-2"><label className="block text-sm">Next direction<textarea className="field mt-1" rows={3} maxLength={1200} value={direction} onChange={(event) => setDirection(event.target.value)} /></label><div className="grid grid-cols-2 gap-3">
      <label className="text-sm">Cash per quarter<input className="field mt-1" type="number" min={1} max={1e12} value={nextBudget} onChange={(event) => setNextBudget(Number(event.target.value))} /></label>
      <label className="text-sm">Compute units<input className="field mt-1" type="number" min={0} max={1e9} value={nextCompute} onChange={(event) => setNextCompute(Number(event.target.value))} /></label>
      <label className="text-sm">Researchers<input className="field mt-1" type="number" min={1} max={1e7} value={nextResearchers} onChange={(event) => setNextResearchers(Number(event.target.value))} /></label>
    </div><p className="text-sm text-ink-dim">Next round ceiling: {formatMoney(nextBudget * experiment.mandate.reviewAfterQuarters)} over {experiment.mandate.reviewAfterQuarters} quarter(s).</p><button type="button" className="btn btn-primary" disabled={resolving || pendingChange || !continuationPreview || continuationPreview.status === 'rejected'} onClick={() => setResult(queueAction(continuation).validation)}>{pendingChange ? 'Change queued' : 'Approve next round'}</button><ValidationBanner result={continuationPreview} /></div> : null}
    {(project.status === 'active' || project.status === 'paused') ? <button type="button" className="btn btn-sm mt-3" disabled={resolving || pendingChange} onClick={() => setResult(queueAction({ type: 'abandon_research_project', projectId: project.id }).validation)}>Close experiment</button> : null}
    {message ? <p role="status" className="mt-2 text-sm text-warn">{message}</p> : null}
    <ValidationBanner result={result} />
  </Panel>;
}

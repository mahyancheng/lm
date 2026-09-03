'use client';

/**
 * One node of the Frontier Map, opened — and answering four questions.
 *
 * **What it unlocks. What it takes. Who else is close. What the risk is.** In
 * that order, in plain words, in whole numbers. Everything else the node carries
 * — novelty, plausibility, visibility, the arrival window, the raw confidence
 * figures — sits behind "Details", because none of it changes what a founder
 * does next.
 *
 * There is **one control**: effort. Light, Standard and All-in are engine-owned
 * presets (`effortIntent`) built from the node's own requirement and the
 * company's free capacity, so the Standard preset is inside the validator's
 * bounds by construction and is never clamped. "Adjust" opens the three sliders
 * for a founder who wants them; the validator's verdict shows live either way,
 * because the validator is the truth and the presets are only a good default.
 *
 * Nothing on this screen computes an economic number. Quarters, cost, risk and
 * the shortfall all come from `programmeForecast` / `runningForecast`.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionIntent, ActionValidationResult, Company, PublicationMode, ResearchProject, SessionState, TechGraph, TechNode } from '@frontier/contracts';
import { categoryById, quarterLabel } from '@frontier/contracts';
import {
  RESEARCH_EFFORTS,
  effortPlan,
  programmeForecast,
  projectRequirements,
  publicVerdict,
  repairPlan,
  researchCapacity,
  rivalProgress,
  runningForecast,
  setbackRiskBand,
  unmetDependencies,
  type ProgrammePlan,
  type ResearchEffort,
} from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import {
  CashAfter,
  Drawer,
  KeyValueGrid,
  Meter,
  ProgressBar,
  SectionHeading,
  SectorBadge,
  SliderField,
  Tag,
  ValidationBanner,
  roundStep,
} from '@/components/ui';
import { setPendingLaunchCategory, useGameActions } from '@/lib/game';
import { STATE_STYLE, VISIBILITY_LABEL } from './graphLayout';
import {
  BOTTLENECK_LABEL,
  EFFORT_BLURB,
  EFFORT_LABEL,
  NODE_STATE_LABEL,
  RISK_LABEL,
  RISK_TONE,
  classifyNode,
  quartersLabel,
  readableArea,
  riskLine,
  rivalsLine,
  shortfallLine,
  unlockLines,
  worldThinksLine,
} from './nodeState';

export interface NodeDrawerProps {
  readonly session: SessionState;
  readonly graph: TechGraph;
  readonly company: Company;
  readonly node: TechNode | null;
  readonly projects: readonly ResearchProject[];
  readonly onClose: () => void;
  readonly onSelect: (nodeId: string) => void;
}

/** The three ways to make a result public, as plain labels with one consequence each. */
const ANNOUNCE_MODES: readonly { readonly mode: PublicationMode; readonly label: string; readonly consequence: string }[] = [
  { mode: 'paper', label: 'Publish a paper', consequence: 'Researchers and developers think better of you. Rivals get the method.' },
  { mode: 'product_demonstration', label: 'Show it in a product', consequence: 'Customers and investors see it work. The method stays yours.' },
  { mode: 'closed_briefing', label: 'Brief government and investors privately', consequence: 'Reaches the people who award contracts and money. The public learns nothing.' },
];

export function NodeDrawer({ session, graph, company, node, projects, onClose, onSelect }: NodeDrawerProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [effort, setEffort] = useState<ResearchEffort>('standard');
  const [adjusting, setAdjusting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [custom, setCustom] = useState<ProgrammePlan | null>(null);
  const [secret, setSecret] = useState(true);
  const [startResult, setStartResult] = useState<ActionValidationResult | null>(null);
  const [fixResult, setFixResult] = useState<ActionValidationResult | null>(null);
  const [publishMode, setPublishMode] = useState<PublicationMode>('paper');
  const [publishResult, setPublishResult] = useState<ActionValidationResult | null>(null);

  const titles = useMemo(() => new Map(graph.nodes.map((entry) => [entry.id, entry.title])), [graph.nodes]);
  const companyNames = useMemo(() => new Map(session.companies.map((entry) => [entry.id, entry.name])), [session.companies]);

  const existing = node === null ? null : (projects.find((project) => project.targetNodeId === node.id && (project.status === 'active' || project.status === 'paused')) ?? null);
  const nodeId = node?.id ?? null;

  /* --- everything the engine says about this node -------------------------- */
  const capacity = useMemo(() => researchCapacity(session, company), [session, company]);
  const requirement = useMemo(() => (node === null ? null : projectRequirements(session, node)), [session, node]);
  const missing = useMemo(
    () => (node === null ? [] : unmetDependencies(session, node, company.id).map((id) => titles.get(id) ?? id)),
    [session, node, company.id, titles],
  );
  const running = useMemo(
    () => (node === null || existing === null ? null : runningForecast(session, existing, node)),
    [session, existing, node],
  );
  const rivals = useMemo(
    () =>
      node === null
        ? []
        : rivalProgress(session, node.id, company.id).map((entry) => ({
            name: companyNames.get(entry.companyId) ?? entry.companyId,
            progressPct: entry.progress * 100,
          })),
    [session, node, company.id, companyNames],
  );

  const achievedByName = node === null || node.achievedByCompanyId === null ? null : (companyNames.get(node.achievedByCompanyId) ?? node.achievedByCompanyId);
  const achievedByYou =
    node !== null &&
    (node.achievedByCompanyId === company.id || projects.some((project) => project.targetNodeId === node.id && project.status === 'succeeded'));
  const state = classifyNode({
    achievedByName: achievedByYou ? null : achievedByName,
    achievedByYou,
    missingTitles: missing,
    running: running === null ? null : { progressPct: running.progress * 100, quartersLeft: running.quartersLeft },
  });

  /* --- the plan the effort control produces ------------------------------- */
  const presetPlan = useMemo(
    () => (node === null ? null : effortPlan(session, node, effort, capacity)),
    [session, node, effort, capacity],
  );
  const plan = custom ?? presetPlan;
  const forecast = useMemo(
    () => (node === null || plan === null ? null : programmeForecast(session, company, node, plan)),
    [session, company, node, plan],
  );

  // A new node resets the control to Standard and drops any hand-set figures:
  // a plan built for one technology means nothing against another.
  useEffect(() => {
    if (nodeId === null) return;
    setEffort('standard');
    setCustom(null);
    setAdjusting(false);
    setDetailsOpen(false);
    setStartResult(null);
    setFixResult(null);
  }, [nodeId]);

  const startIntent: ActionIntent | null =
    node === null || plan === null
      ? null
      : {
          type: 'start_research_project',
          targetNodeId: node.id,
          budgetUsd: plan.budgetUsd,
          computeUnits: plan.computeUnits,
          researchersAssigned: plan.researchersAssigned,
          secret,
        };
  const startPreview = startIntent === null ? null : validateIntent(startIntent);

  const repair = useMemo(
    () => (node === null || existing === null ? null : repairPlan(session, company, existing, node)),
    [session, company, existing, node],
  );

  function setPlanField(field: keyof ProgrammePlan, value: number): void {
    if (plan === null) return;
    setCustom({ ...plan, [field]: Math.max(0, Math.round(value)) });
  }

  function startProject(): void {
    if (startIntent === null) return;
    setStartResult(queueAction(startIntent).validation);
  }

  function applyFix(): void {
    if (existing === null || repair === null) return;
    setFixResult(
      queueAction({
        type: 'adjust_research_project',
        projectId: existing.id,
        budgetUsd: repair.budgetUsd,
        computeUnits: repair.computeUnits,
        researchersAssigned: repair.researchersAssigned,
      }).validation,
    );
  }

  function announce(): void {
    if (node === null) return;
    setPublishResult(
      queueAction({ type: 'publish_research', nodeId: node.id, mode: publishMode, rationale: 'Announced from the Frontier Map.' }).validation,
    );
  }

  function close(): void {
    setStartResult(null);
    setFixResult(null);
    setPublishResult(null);
    onClose();
  }

  const style = node === null ? null : STATE_STYLE[node.status];
  const riskBand = forecast === null ? null : setbackRiskBand(forecast.setbackRisk);
  const ownConfidence = node === null ? undefined : node.confidenceByCompany[company.id];

  const dependentTitles = useMemo(() => {
    if (node === null) return [];
    return graph.nodes.filter((entry) => entry.dependencies.includes(node.id)).map((entry) => entry.title);
  }, [graph.nodes, node]);

  const unlockTitles = useMemo(() => {
    if (node === null) return [];
    const ids = new Set(node.possibleUnlocks);
    for (const edge of graph.edges) {
      if (edge.from === node.id && (edge.kind === 'unlocks' || edge.kind === 'informs')) ids.add(edge.to);
    }
    return [...ids].map((id) => titles.get(id) ?? id);
  }, [graph.edges, node, titles]);

  /* --- product lines this node's achievement gates ------------------------- */
  const unlockedLines = useMemo(() => {
    if (node === null) return [];
    return (node.unlocksCategoryIds ?? []).map((id) => categoryById(id)).filter((category) => category !== undefined);
  }, [node]);

  return (
    <Drawer open={node !== null} onClose={close} title={node?.title ?? ''} subtitle={state.line} width={540}>
      {node === null || style === null ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone={state.kind === 'done' ? 'gain' : state.kind === 'running' ? 'brand' : state.kind === 'available' ? 'info' : 'neutral'} dot>
              {NODE_STATE_LABEL[state.kind]}
            </Tag>
            {node.sector === undefined ? null : <SectorBadge sector={node.sector} />}
            {node.originalProposerId === null ? null : <Tag tone="brand">Invented in this game</Tag>}
            {node.achievedQuarter === null ? null : <Tag tone="gain">{quarterLabel(session.startYear, node.achievedQuarter)}</Tag>}
          </div>

          <p className="text-[12.5px] leading-relaxed text-ink-dim">{node.summary}</p>

          {/* --- 1. what it unlocks ------------------------------------------ */}
          <div>
            <SectionHeading rule>What it gets you</SectionHeading>
            <ul className="mt-2 space-y-1.5">
              {unlockLines({ capabilityAreas: node.talentRequirements, unlockTitles, dependentTitles }).map((line) => (
                <li key={line} className="text-[12px] leading-relaxed text-ink-dim">
                  {line}
                </li>
              ))}
            </ul>
            {unlockTitles.length === 0 && dependentTitles.length === 0 ? null : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...new Set([...unlockTitles, ...dependentTitles])].slice(0, 6).map((title) => {
                  const target = graph.nodes.find((entry) => entry.title === title);
                  return (
                    <button
                      key={title}
                      type="button"
                      className="btn btn-sm tap-target sm:min-h-0"
                      onClick={() => (target === undefined ? undefined : onSelect(target.id))}
                    >
                      {title}
                    </button>
                  );
                })}
              </div>
            )}
            {unlockedLines.length === 0 ? null : (
              <div className="mt-2.5 space-y-1.5">
                <div className="label-caps-faint">Product lines this gates</div>
                {unlockedLines.map((category) => (
                  <div key={category.id} className="flex items-center justify-between gap-2 rounded-chip border border-hair bg-panel px-2.5 py-1.5">
                    <span className="text-[11.5px] text-ink-dim">{category.label}</span>
                    {state.kind === 'done' ? (
                      <Link
                        href="/products"
                        onClick={() => setPendingLaunchCategory(category.id)}
                        className="btn btn-sm tap-target gap-1 sm:min-h-0"
                      >
                        Launch this line
                      </Link>
                    ) : (
                      <span className="text-[10.5px] text-ink-faint">Locked until achieved</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* --- 2. what it takes -------------------------------------------- */}
          {state.kind === 'done' ? null : (
            <div>
              <SectionHeading rule>What it takes</SectionHeading>
              {missing.length > 0 ? (
                <p className="mt-1.5 text-[12px] leading-relaxed tone-warn">
                  Locked until you have {missing.join(', ')}. You can still start a programme; it will be held at the line until then.
                </p>
              ) : null}
              <div className="mt-2">
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Time at this effort', value: forecast === null ? '—' : quartersLabel(forecast.expectedQuarters) },
                    { label: 'Cost each quarter', value: forecast === null ? '—' : formatMoney(forecast.quarterlyCostUsd) },
                    { label: 'Total cash', value: forecast === null ? '—' : formatMoney(forecast.totalCostUsd) },
                    {
                      label: 'Researchers',
                      value: formatCount(plan?.researchersAssigned ?? 0),
                      hint: `${formatCount(requirement?.researchers ?? 0)} is what it wants; ${formatCount(capacity.researchers)} free`,
                    },
                    {
                      label: 'Compute units',
                      value: formatCount(plan?.computeUnits ?? 0),
                      hint: `${formatCount(requirement?.computeUnits ?? 0)} is what it wants; ${formatCount(capacity.computeUnits)} free`,
                    },
                    {
                      label: 'Setback risk',
                      value: riskBand === null ? '—' : RISK_LABEL[riskBand],
                      tone: riskBand === null ? undefined : RISK_TONE[riskBand],
                    },
                  ]}
                />
              </div>
            </div>
          )}

          {/* --- 3. who else is close ---------------------------------------- */}
          <div>
            <SectionHeading rule>Who else is close</SectionHeading>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">{worldThinksLine(publicVerdict(node.publicConfidence))}.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{rivalsLine(rivals)}</p>
            {ownConfidence === undefined || Math.abs(ownConfidence - node.publicConfidence) < 0.05 ? null : (
              <p className="mt-1 text-[11.5px] leading-relaxed tone-brand">
                You rate it {Math.round(Math.abs(ownConfidence - node.publicConfidence) * 100)} points{' '}
                {ownConfidence > node.publicConfidence ? 'higher' : 'lower'} than the market does. That gap is the edge a research bet is made on.
              </p>
            )}
          </div>

          {/* --- 4. risk ----------------------------------------------------- */}
          {forecast === null || riskBand === null || state.kind === 'done' ? null : (
            <div>
              <SectionHeading rule>Risk</SectionHeading>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">{riskLine(riskBand, forecast.setbackRisk)}</p>
              {forecast.bottleneck === null ? (
                <p className="mt-1 text-[11.5px] leading-relaxed tone-gain">This plan gives the work everything it asks for.</p>
              ) : (
                <p className="mt-1 text-[11.5px] leading-relaxed tone-warn">{shortfallLine(forecast.shortfall)}</p>
              )}
            </div>
          )}

          {/* --- the programme, running or not ------------------------------- */}
          {existing !== null && running !== null ? (
            <div>
              <SectionHeading rule>Your programme</SectionHeading>
              <div className="mt-2 space-y-2.5">
                <ProgressBar
                  label="Progress"
                  value={running.progress}
                  tone={running.setbacks > 0 ? 'warn' : 'brand'}
                  valueLabel={`${Math.round(running.progress * 100)}% · ${running.quartersLeft} quarter${running.quartersLeft === 1 ? '' : 's'} left`}
                />
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Quarters run', value: formatCount(running.quartersElapsed) },
                    { label: 'Spent so far', value: formatMoney(running.spentUsd) },
                    { label: 'Cost each quarter', value: formatMoney(running.quarterlyCostUsd) },
                    { label: 'Setbacks', value: formatCount(running.setbacks), tone: running.setbacks > 0 ? 'warn' : undefined },
                  ]}
                />
                {running.bottleneck === null ? (
                  <p className="text-[12px] leading-relaxed tone-gain">Running at full speed: it has everything the work asks for.</p>
                ) : (
                  <div className="raised-surface space-y-2 px-3 py-2.5">
                    <p className="text-[12.5px] leading-relaxed tone-warn">{shortfallLine(running.shortfall)}</p>
                    {repair === null ? null : (
                      <>
                        <p className="text-[11px] leading-relaxed text-ink-faint">
                          Fix sets it to {formatCount(repair.researchersAssigned)} researchers and {formatCount(repair.computeUnits)} compute units —
                          what this technology asks for, as far as you have it free.
                        </p>
                        <button type="button" className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={applyFix}>
                          Fix the shortage of {BOTTLENECK_LABEL[running.bottleneck]}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {existing.isSecret ? <Tag tone="warn" dot>Secret programme</Tag> : <Tag tone="neutral" dot>Publicly known</Tag>}
                {fixResult === null ? null : <ValidationBanner result={fixResult} />}
              </div>
            </div>
          ) : state.kind === 'done' ? null : (
            <div>
              <SectionHeading rule>Start it</SectionHeading>

              {/* One control: how hard you go at it. */}
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {RESEARCH_EFFORTS.map((option) => {
                  const active = effort === option && custom === null;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        setEffort(option);
                        setCustom(null);
                      }}
                      className={`raised-surface tap-target flex flex-col items-start gap-0.5 px-2.5 py-2 text-left transition-colors hover:border-hair-strong ${
                        active ? 'border-brand/40 bg-brand-wash' : ''
                      }`}
                      aria-pressed={active}
                    >
                      <span className="text-[12.5px] font-semibold text-ink">{EFFORT_LABEL[option]}</span>
                      <span className="text-[10px] leading-snug text-ink-faint">{EFFORT_BLURB[option]}</span>
                    </button>
                  );
                })}
              </div>
              {custom === null ? null : (
                <p className="mt-1.5 text-[11px] text-ink-faint">Figures set by hand. Pick an effort above to go back to a preset.</p>
              )}

              {plan === null || forecast === null ? null : (
                <div className="mt-2.5 space-y-2">
                  <KeyValueGrid
                    columns={3}
                    items={[
                      { label: 'Budget / quarter', value: formatMoney(plan.budgetUsd) },
                      { label: 'Compute', value: `${formatCount(plan.computeUnits)} units` },
                      { label: 'Researchers', value: formatCount(plan.researchersAssigned) },
                    ]}
                  />
                  <p className="text-[12px] leading-relaxed text-ink-dim">
                    About {quartersLabel(forecast.expectedQuarters)}, {formatMoney(forecast.totalCostUsd)} of cash in total, {RISK_LABEL[setbackRiskBand(forecast.setbackRisk)].toLowerCase()} risk.
                  </p>
                  <CashAfter company={company} spendUsd={plan.budgetUsd} note="Charged every quarter the programme runs." />
                </div>
              )}

              {/* The three sliders, for a founder who wants them. */}
              <details
                className="mt-2.5"
                open={adjusting}
                onToggle={(event) => setAdjusting((event.target as HTMLDetailsElement).open)}
              >
                <summary className="tap-target cursor-pointer list-none text-[12px] font-medium text-ink-dim sm:min-h-0">Adjust the figures</summary>
                {plan === null ? null : (
                  <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
                    <SliderField
                      label="Budget / quarter"
                      value={plan.budgetUsd}
                      onChange={(next) => setPlanField('budgetUsd', next)}
                      min={0}
                      max={Math.max(company.financials.cash, plan.budgetUsd, 1_000_000)}
                      step={roundStep(Math.max(company.financials.cash, plan.budgetUsd, 1_000_000))}
                      format={formatMoney}
                      chips
                    />
                    <SliderField
                      label="Compute units"
                      value={plan.computeUnits}
                      onChange={(next) => setPlanField('computeUnits', next)}
                      min={0}
                      max={Math.max(capacity.computeUnits, plan.computeUnits, 1)}
                      step={roundStep(Math.max(capacity.computeUnits, plan.computeUnits, 1))}
                      format={formatCount}
                    />
                    <SliderField
                      label="Researchers"
                      value={plan.researchersAssigned}
                      onChange={(next) => setPlanField('researchersAssigned', next)}
                      min={0}
                      max={Math.max(capacity.researchers, plan.researchersAssigned, 1)}
                      step={1}
                      format={formatCount}
                    />
                  </div>
                )}
              </details>

              <label className="tap-target mt-2.5 flex cursor-pointer items-start gap-2.5 py-1 sm:min-h-0 sm:py-0">
                <input
                  type="checkbox"
                  checked={secret}
                  onChange={(event) => setSecret(event.target.checked)}
                  className="mt-1 size-5 shrink-0 accent-[color:var(--color-brand-strong)] sm:mt-0.5 sm:size-4"
                />
                <span className="text-[13px] text-ink-dim sm:text-[12px]">
                  Keep it secret.
                  <span className="block text-[11px] leading-relaxed text-ink-faint">
                    Rivals cannot see the programme exists, and a setback stays out of the share price.
                  </span>
                </span>
              </label>

              <div className="mt-2.5 flex justify-end">
                <button type="button" className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={startProject}>
                  Start the programme
                </button>
              </div>

              {startResult === null && startPreview !== null ? <div className="mt-2"><ValidationBanner result={startPreview} compact /></div> : null}
              {startResult === null ? null : <div className="mt-2"><ValidationBanner result={startResult} /></div>}
            </div>
          )}

          {/* --- announce ---------------------------------------------------- */}
          {!achievedByYou ? null : (
            <div>
              <SectionHeading rule>Announce it</SectionHeading>
              <div className="mt-2 space-y-1.5">
                {ANNOUNCE_MODES.map((option) => (
                  <label
                    key={option.mode}
                    className={`tap-target raised-surface flex cursor-pointer items-start gap-2.5 px-3 py-2 sm:min-h-0 ${
                      publishMode === option.mode ? 'border-brand/40 bg-brand-wash' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="announce-mode"
                      checked={publishMode === option.mode}
                      onChange={() => setPublishMode(option.mode)}
                      className="mt-1 size-4 shrink-0 accent-[color:var(--color-brand-strong)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-ink">{option.label}</span>
                      <span className="block text-[11px] leading-relaxed text-ink-faint">{option.consequence}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={announce}>
                  Announce
                </button>
              </div>
              {publishResult === null ? null : <div className="mt-2"><ValidationBanner result={publishResult} /></div>}
            </div>
          )}

          {/* --- details ----------------------------------------------------- */}
          <details className="border-t border-hair pt-3" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}>
            <summary className="tap-target cursor-pointer list-none text-[12px] font-medium text-ink-dim sm:min-h-0">Details</summary>
            <div className="mt-2 space-y-3">
              <Meter value={node.publicConfidence * 100} label="What the world believes" />
              {ownConfidence === undefined ? null : (
                <Meter value={ownConfidence * 100} label={`What ${company.name} believes`} tone="brand" benchmark={node.publicConfidence * 100} benchmarkLabel="Public" />
              )}
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Epistemic state', value: style.label },
                  { label: 'Visibility', value: VISIBILITY_LABEL[node.visibility] },
                  { label: 'Expected arrival', value: `${node.estimatedWindow[0]}–${node.estimatedWindow[1]}` },
                  { label: 'Compute intensity', value: formatPct(node.computeIntensity) },
                  { label: 'Novelty', value: formatPct(node.novelty), hint: 'Distance from what the world already believes' },
                  { label: 'Plausibility', value: formatPct(node.plausibility), hint: 'Coherence with physics, economics and the frontier' },
                  { label: 'Cost estimate (low)', value: formatMoney(node.researchCostRange[0]) },
                  { label: 'Cost estimate (high)', value: formatMoney(node.researchCostRange[1]) },
                ]}
              />
              <div>
                <div className="label-caps-faint mb-1">Capability areas, and your strength in them</div>
                <div className="flex flex-wrap gap-1.5">
                  {node.talentRequirements.length === 0 ? (
                    <span className="text-[11px] text-ink-faint">No specific area is named.</span>
                  ) : (
                    node.talentRequirements.map((area) => {
                      const strength = company.techCapabilities[area] ?? 0;
                      return (
                        <Tag key={area} tone={strength >= 0.5 ? 'gain' : strength >= 0.25 ? 'warn' : 'loss'}>
                          {readableArea(area)} · {formatPct(strength)}
                        </Tag>
                      );
                    })
                  )}
                </div>
              </div>
              {node.dependencies.length === 0 ? null : (
                <div>
                  <div className="label-caps-faint mb-1">Depends on</div>
                  <div className="flex flex-wrap gap-1.5">
                    {node.dependencies.map((id) => (
                      <button key={id} type="button" className="btn btn-sm tap-target sm:min-h-0" onClick={() => onSelect(id)}>
                        {titles.get(id) ?? id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </Drawer>
  );
}

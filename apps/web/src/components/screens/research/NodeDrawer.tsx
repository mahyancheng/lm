'use client';

/**
 * One node of the Frontier Map, opened.
 *
 * The reading this drawer exists to give is the gap between two numbers: what
 * the world rates this at, and what you rate it at. A node the world prices at
 * 0.31 and you price at 0.68 is where a research thesis lives, and the two
 * meters sit one above the other so that gap is unmissable.
 *
 * The start-project ticket underneath is validated live. Researchers are the
 * usual binding constraint, so the validator's clamp — "the rest are on other
 * programmes" — is shown before the action is queued, not after.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Company, PublicationMode, ResearchProject, SessionState, TechGraph, TechNode } from '@frontier/contracts';
import { PUBLICATION_MODES, quarterLabel } from '@frontier/contracts';
import { heldComputeUnits } from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import {
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
import { useGameActions } from '@/lib/game';
import { STATE_STYLE, VISIBILITY_LABEL } from './graphLayout';
import { tracksOf, trackForNode } from './tracks';

export interface NodeDrawerProps {
  readonly session: SessionState;
  readonly graph: TechGraph;
  readonly company: Company;
  readonly node: TechNode | null;
  readonly projects: readonly ResearchProject[];
  readonly onClose: () => void;
  readonly onSelect: (nodeId: string) => void;
}

const PUBLICATION_LABEL: Readonly<Record<PublicationMode, string>> = {
  paper: 'Paper — reputation, and the method',
  open_weights: 'Open weights — a governance matter',
  product_demonstration: 'Product demonstration',
  closed_briefing: 'Closed briefing — government and investors',
  leak: 'Leak',
};

export function NodeDrawer({ session, graph, company, node, projects, onClose, onSelect }: NodeDrawerProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [budget, setBudget] = useState('500000');
  const [computeUnits, setComputeUnits] = useState('0');
  const [researchers, setResearchers] = useState('1');
  const [secret, setSecret] = useState(true);
  const [startResult, setStartResult] = useState<ActionValidationResult | null>(null);
  const [publishMode, setPublishMode] = useState<PublicationMode>('paper');
  const [publishResult, setPublishResult] = useState<ActionValidationResult | null>(null);

  const titles = useMemo(() => new Map(graph.nodes.map((entry) => [entry.id, entry.title])), [graph.nodes]);

  // The lane this node sits in. Shown only when the graph has more than one,
  // because a single-lane world would put the same badge on every card.
  const tracks = useMemo(() => tracksOf(graph), [graph]);
  const track = node === null ? null : trackForNode(tracks, node.id);
  const showTrack = tracks.length > 1 && track !== null;

  const existing = node === null ? null : (projects.find((project) => project.targetNodeId === node.id) ?? null);
  const ownConfidence = node === null ? undefined : node.confidenceByCompany[company.id];

  /* --- ticket bounds ------------------------------------------------------ */
  const budgetValue = Math.max(0, Number.parseFloat(budget) || 0);
  const computeValue = Math.max(0, Math.round(Number.parseFloat(computeUnits) || 0));
  const researcherValue = Math.max(0, Math.round(Number.parseFloat(researchers) || 0));
  const budgetMax = Math.max(company.financials.cash, budgetValue, 250_000);
  const computeMax = Math.max(Math.round(heldComputeUnits(session, company)), computeValue, 10);
  const researcherMax = Math.max(company.employees.researchers, researcherValue, 1);

  const startIntent =
    node === null
      ? null
      : {
          type: 'start_research_project' as const,
          targetNodeId: node.id,
          budgetUsd: Math.max(0, Number.parseFloat(budget) || 0),
          computeUnits: Math.max(0, Math.round(Number.parseFloat(computeUnits) || 0)),
          researchersAssigned: Math.max(0, Math.round(Number.parseFloat(researchers) || 0)),
          secret,
        };

  const startPreview = startIntent === null ? null : validateIntent(startIntent);

  const owns =
    node !== null &&
    (node.achievedByCompanyId === company.id ||
      projects.some((project) => project.targetNodeId === node.id && project.status === 'succeeded'));

  function startProject(): void {
    if (startIntent === null) return;
    const entry = queueAction(startIntent);
    setStartResult(entry.validation);
  }

  function publish(): void {
    if (node === null) return;
    const entry = queueAction({ type: 'publish_research', nodeId: node.id, mode: publishMode, rationale: 'Published from the Frontier Map.' });
    setPublishResult(entry.validation);
  }

  function close(): void {
    setStartResult(null);
    setPublishResult(null);
    onClose();
  }

  const style = node === null ? null : STATE_STYLE[node.status];

  return (
    <Drawer
      open={node !== null}
      onClose={close}
      title={node?.title ?? ''}
      subtitle={node === null || style === null ? undefined : `${style.label} · ${VISIBILITY_LABEL[node.visibility]}`}
      width={540}
    >
      {node === null || style === null ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {showTrack && track !== null ? <SectorBadge sector={track.sector} /> : null}
            <Tag tone={style.tone} dot>
              {style.label}
            </Tag>
            <Tag tone={node.visibility === 'public' ? 'neutral' : 'warn'}>{VISIBILITY_LABEL[node.visibility]}</Tag>
            {node.achievedByCompanyId === null ? null : (
              <Tag tone="gain">Achieved {node.achievedQuarter === null ? '' : quarterLabel(session.startYear, node.achievedQuarter)}</Tag>
            )}
            {node.originalProposerId === null ? null : <Tag tone="brand">Invented in session</Tag>}
          </div>

          <p className="text-[12px] leading-relaxed text-ink-dim">{node.summary}</p>
          <p className="text-[10px] text-ink-faint">{style.blurb}</p>

          <div>
            <SectionHeading rule>Confidence</SectionHeading>
            <div className="mt-2 space-y-3">
              <Meter value={node.publicConfidence * 100} label="What the world believes" />
              {ownConfidence === undefined ? (
                <p className="text-[10px] text-ink-faint">
                  {company.name} holds no private view on this node. The public figure is the only one you have.
                </p>
              ) : (
                <>
                  <Meter value={ownConfidence * 100} label={`What ${company.name} believes`} tone="brand" benchmark={node.publicConfidence * 100} benchmarkLabel="Public" />
                  <p className="text-[10px] text-ink-faint">
                    {ownConfidence > node.publicConfidence
                      ? `You are ${Math.round((ownConfidence - node.publicConfidence) * 100)} points ahead of the consensus. That gap is the edge a research bet is made on.`
                      : ownConfidence < node.publicConfidence
                        ? `You are ${Math.round((node.publicConfidence - ownConfidence) * 100)} points behind the consensus. The market is pricing something you do not believe.`
                        : 'Your view and the market’s are the same. There is no informational edge here.'}
                  </p>
                </>
              )}
            </div>
          </div>

          <div>
            <SectionHeading rule>Programme shape</SectionHeading>
            <div className="mt-2">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Arrival window', value: `${node.estimatedWindow[0]}–${node.estimatedWindow[1]}` },
                  { label: 'Compute intensity', value: formatPct(node.computeIntensity) },
                  { label: 'Cost estimate (low)', value: formatMoney(node.researchCostRange[0]) },
                  { label: 'Cost estimate (high)', value: formatMoney(node.researchCostRange[1]) },
                  { label: 'Novelty', value: formatPct(node.novelty), hint: 'Distance from what the world already believes' },
                  { label: 'Plausibility', value: formatPct(node.plausibility), hint: 'Coherence with physics, economics and the frontier' },
                ]}
              />
            </div>
          </div>

          <div>
            <SectionHeading rule>Capability required</SectionHeading>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {node.talentRequirements.length === 0 ? (
                <span className="text-[11px] text-ink-faint">No specific capability area is named.</span>
              ) : (
                node.talentRequirements.map((area) => {
                  const strength = company.techCapabilities[area] ?? 0;
                  return (
                    <Tag key={area} tone={strength >= 0.5 ? 'gain' : strength >= 0.25 ? 'warn' : 'loss'} title={`Your strength: ${formatPct(strength)}`}>
                      {area.replace(/_/g, ' ')} · {formatPct(strength)}
                    </Tag>
                  );
                })
              )}
            </div>
          </div>

          {node.dependencies.length === 0 && node.possibleUnlocks.length === 0 ? null : (
            <div>
              <SectionHeading rule>Position on the map</SectionHeading>
              <div className="mt-2 space-y-2">
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
                {node.possibleUnlocks.length === 0 ? null : (
                  <div>
                    <div className="label-caps-faint mb-1">Would make credible</div>
                    <div className="flex flex-wrap gap-1.5">
                      {node.possibleUnlocks.map((id) => (
                        <button key={id} type="button" className="btn btn-sm tap-target sm:min-h-0" onClick={() => onSelect(id)}>
                          {titles.get(id) ?? id}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {existing === null ? (
            <div>
              <SectionHeading rule>Start a programme</SectionHeading>
              {/* Bounds are the validator's, not the form's: cash caps the
                  budget, held capacity caps compute, and the researcher clamp
                  ("the rest are on other programmes") shows live below. */}
              <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
                <SliderField
                  label="Budget / quarter"
                  value={budgetValue}
                  onChange={(next) => setBudget(String(next))}
                  min={0}
                  max={budgetMax}
                  step={roundStep(budgetMax)}
                  format={formatMoney}
                  chips
                />
                <SliderField
                  label="Compute units"
                  value={computeValue}
                  onChange={(next) => setComputeUnits(String(next))}
                  min={0}
                  max={computeMax}
                  step={roundStep(computeMax)}
                  format={formatCount}
                />
                <SliderField
                  label="Researchers"
                  value={researcherValue}
                  onChange={(next) => setResearchers(String(next))}
                  min={0}
                  max={researcherMax}
                  step={1}
                  format={formatCount}
                />
              </div>

              {/* The label is the target: a finger gets the whole 44px row,
                  the box stays a box. */}
              <label className="tap-target mt-2.5 flex cursor-pointer items-start gap-2.5 py-1 sm:min-h-0 sm:py-0">
                <input
                  type="checkbox"
                  checked={secret}
                  onChange={(event) => setSecret(event.target.checked)}
                  className="mt-1 size-5 shrink-0 accent-[color:var(--color-brand-strong)] sm:mt-0.5 sm:size-4"
                />
                <span className="text-[13px] text-ink-dim sm:text-[11px]">
                  Keep the programme secret.
                  <span className="block text-[11px] leading-relaxed text-ink-faint sm:text-[10px]">
                    A secret setback stays out of the share price unless it leaks; a secret success surprises the market.
                  </span>
                </span>
              </label>

              <div className="mt-2.5 flex justify-end">
                <button type="button" className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={startProject}>
                  Queue programme
                </button>
              </div>

              {startResult === null && startPreview !== null ? (
                <div className="mt-2">
                  <ValidationBanner result={startPreview} compact />
                </div>
              ) : null}
              {startResult === null ? null : (
                <div className="mt-2">
                  <ValidationBanner result={startResult} />
                </div>
              )}
            </div>
          ) : (
            <div>
              <SectionHeading rule>Your programme</SectionHeading>
              <div className="mt-2 space-y-2.5">
                <ProgressBar
                  label="Progress to demonstration"
                  value={existing.progress}
                  tone="brand"
                  valueLabel={`${formatPct(existing.progress)} · ${existing.quartersElapsed}/${existing.expectedQuarters} quarters`}
                />
                <Meter value={existing.internalConfidence * 100} label="Internal confidence" tone="info" />
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Budget', value: `${formatMoney(existing.budgetQuarterly)} / quarter` },
                    { label: 'Compute', value: `${existing.computeAllocated} units` },
                    { label: 'Researchers', value: existing.talentAllocated.toString() },
                    { label: 'Spent to date', value: formatMoney(existing.cumulativeSpendUsd) },
                    { label: 'Setbacks', value: existing.setbacks.toString(), tone: existing.setbacks > 0 ? 'warn' : undefined },
                    { label: 'Status', value: existing.status, mono: false },
                  ]}
                />
                {existing.isSecret ? <Tag tone="warn" dot>Secret programme</Tag> : <Tag tone="neutral" dot>Publicly known</Tag>}
              </div>
            </div>
          )}

          {!owns ? null : (
            <div>
              <SectionHeading rule>Publish</SectionHeading>
              <p className="mt-1.5 text-[10px] text-ink-faint">
                Publication buys reputation and hands rivals the method. An open-weights release is a governance matter and goes to the board.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1">
                  <span className="label-caps-faint mb-1 block">Mode</span>
                  <select className="field tap-target sm:min-h-0" value={publishMode} onChange={(event) => setPublishMode(event.target.value as PublicationMode)}>
                    {PUBLICATION_MODES.filter((mode) => mode !== 'leak').map((mode) => (
                      <option key={mode} value={mode}>
                        {PUBLICATION_LABEL[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="btn btn-sm tap-target sm:min-h-0" onClick={publish}>
                  Queue publication
                </button>
              </div>
              {publishResult === null ? null : (
                <div className="mt-2">
                  <ValidationBanner result={publishResult} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

'use client';

/**
 * The bid composer.
 *
 * Every field is a real trade-off with a cost somewhere else in the company:
 * committed compute is capacity that cannot serve customers, cleared staff are
 * scarce and slow to create, IP concessions are permanent, and a price below
 * the evaluators' own estimate scores *worse*, not better.
 *
 * The three panels on the right are not the interface's opinion. They are the
 * engine's: `disqualificationReasons` for the gates, `engineCostEstimate` and
 * `costRealism` for the price, `programmeScale` for what a competent delivery
 * actually takes — all run against the draft as it stands.
 *
 * `bid_government` is one of the thirteen. Nothing is queued until a human has
 * been through `ConfirmDialog`.
 */

import { useMemo, useState } from 'react';
import type {
  ActionValidationResult,
  AuditRights,
  Company,
  IpConcession,
  PlayerView,
  ProcurementOpportunity,
  SessionState,
} from '@frontier/contracts';
import { AUDIT_RIGHTS, IP_CONCESSIONS } from '@frontier/contracts';
import {
  bidTeam,
  costRealism,
  disqualificationReasons,
  engineCostEstimate,
  programmeScale,
} from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import {
  ConfirmDialog,
  Icon,
  KeyValueGrid,
  Meter,
  Modal,
  SectionHeading,
  Tag,
  ValidationBanner,
  cx,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { AUDIT_RIGHTS_LABEL, IP_CONCESSION_LABEL, initialDraft, toBid, toStoredBid, type BidDraft } from './bidModel';

/**
 * One section of the composer.
 *
 * Eight sections of number fields stacked down a phone is a scroll, not a form,
 * so below `sm` each one folds and the player opens the two or three they
 * actually want to argue about. From `sm` up nothing folds: every section is
 * open and the toggle is gone, which is the composer exactly as it was.
 */
function Fold({
  title,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="tap-target flex w-full items-center justify-between gap-2 border-b border-hair text-left sm:hidden"
      >
        <span className="label-caps">{title}</span>
        <span className="text-ink-faint">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} accent="current" />
        </span>
      </button>
      <div className="hidden sm:block">
        <SectionHeading rule>{title}</SectionHeading>
      </div>
      <div className={cx(open ? '' : 'hidden sm:block')}>{children}</div>
    </div>
  );
}

export interface BidBuilderProps {
  readonly session: SessionState;
  readonly company: Company;
  readonly view: PlayerView;
  readonly opportunity: ProcurementOpportunity | null;
  readonly onClose: () => void;
}

export function BidBuilder({ session, company, view, opportunity, onClose }: BidBuilderProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [draft, setDraft] = useState<BidDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  // Seed the draft the first time an opportunity opens, and whenever it changes.
  const active = opportunity;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (active !== null && seededFor !== active.id) {
    setSeededFor(active.id);
    setDraft(initialDraft(active));
    setResult(null);
  }

  const partners = useMemo(
    () => view.visibleCompanies.filter((rival) => rival.id !== undefined && rival.isActive !== false),
    [view.visibleCompanies],
  );

  const analysis = useMemo(() => {
    if (active === null || draft === null) return null;
    const stored = toStoredBid(active, draft, company.id, session.quarter);
    const team = bidTeam(session, stored);
    const gates = disqualificationReasons(session, active, stored, team);
    const estimate = engineCostEstimate(session, active, stored, team);
    const realism = costRealism(stored.price, estimate.estimateUsd, active.contractForm);
    const scale = programmeScale(active, team);
    return { stored, gates, estimate, realism, scale };
  }, [active, draft, company.id, session]);

  const intent =
    active === null || draft === null ? null : ({ type: 'bid_government' as const, opportunityId: active.id, bid: toBid(active, draft) });
  const preview = intent === null ? null : validateIntent(intent);

  function confirmBid(): void {
    if (intent === null) return;
    const entry = queueAction(intent, { confirmed: true });
    setResult(entry.validation);
    setConfirming(false);
  }

  function close(): void {
    setResult(null);
    setConfirming(false);
    onClose();
  }

  function update(partial: Partial<BidDraft>): void {
    setDraft((current) => (current === null ? current : { ...current, ...partial }));
  }

  function toggleConsortium(id: string): void {
    setDraft((current) => {
      if (current === null) return current;
      const has = current.consortiumMemberIds.includes(id);
      return {
        ...current,
        consortiumMemberIds: has ? current.consortiumMemberIds.filter((entry) => entry !== id) : [...current.consortiumMemberIds, id].slice(0, 6),
      };
    });
  }

  function toggleSubcontractor(id: string, name: string): void {
    setDraft((current) => {
      if (current === null) return current;
      const has = current.subcontractors.some((entry) => entry.companyId === id);
      return {
        ...current,
        subcontractors: has
          ? current.subcontractors.filter((entry) => entry.companyId !== id)
          : [...current.subcontractors, { companyId: id, sharePct: 0.15, role: `Delivery support from ${name}` }].slice(0, 8),
      };
    });
  }

  const priceValue = draft === null ? 0 : Number.parseFloat(draft.price) || 0;

  return (
    <>
      <Modal
        open={active !== null}
        onClose={close}
        width="lg"
        title={active === null ? '' : `Bid — ${active.programme}`}
        subtitle={
          active === null
            ? undefined
            : `${active.contractForm.replace(/_/g, ' ')} · ceiling ${formatMoney(active.maxValue)} · ${active.durationQuarters} quarters`
        }
        footer={
          <>
            <button type="button" className="btn tap-target sm:min-h-0" onClick={close}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary tap-target sm:min-h-0"
              disabled={intent === null || (analysis?.gates.length ?? 1) > 0}
              onClick={() => setConfirming(true)}
            >
              Review and confirm
            </button>
          </>
        }
      >
        {active === null || draft === null || analysis === null ? null : (
          <div className="grid gap-4 lg:grid-cols-2">
            {/* The verdict that decides whether any of this matters, stated once
                at the top so a phone reads it before the eight folds and a
                desktop reads it beside them. */}
            <div
              className={cx(
                'flex items-start gap-2 rounded-card border px-3 py-2.5 text-[13px] leading-relaxed lg:col-span-2 sm:text-[11px]',
                analysis.gates.length === 0 ? 'border-gain/25 bg-gain-wash text-gain' : 'border-loss/25 bg-loss-wash text-loss',
              )}
            >
              <Icon name={analysis.gates.length === 0 ? 'check' : 'warning'} size={15} accent="current" className="mt-px" />
              <span>
                {analysis.gates.length === 0
                  ? 'Every hard requirement is met — this bid will be scored.'
                  : `${analysis.gates.length} hard requirement${analysis.gates.length === 1 ? '' : 's'} unmet. A bid that fails one is disqualified, not scored.`}
              </span>
            </div>

            {/* ---------------------------- the bid --------------------------- */}
            <div className="space-y-3.5">
              <Fold title="Price" defaultOpen>
                <input
                  className="field tap-target mt-2 sm:min-h-0"
                  type="number"
                  min={0}
                  step="1000000"
                  value={draft.price}
                  onChange={(event) => update({ price: event.target.value })}
                />
                <p className="mt-1 text-[10px] text-ink-faint">
                  {formatMoney(priceValue)} across the term. Under {active.contractForm.replace(/_/g, ' ')}, an implausibly low price scores badly
                  rather than winning.
                </p>
              </Fold>

              <Fold title="Committed capacity">
                <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Accelerators</span>
                    <input
                      className="field tap-target sm:min-h-0"
                      type="number"
                      min={0}
                      step={1}
                      value={draft.acceleratorUnits}
                      onChange={(event) => update({ acceleratorUnits: event.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Locked for (quarters)</span>
                    <input
                      className="field tap-target sm:min-h-0"
                      type="number"
                      min={1}
                      max={40}
                      value={draft.computeQuarters}
                      onChange={(event) => update({ computeQuarters: Math.max(1, Math.min(40, Number(event.target.value) || 1)) })}
                    />
                  </label>
                </div>
                <p className="mt-1 text-[10px] text-ink-faint">
                  Locked capacity is unavailable for commercial work. A competent delivery of this programme takes about {analysis.scale.computeUnits}{' '}
                  accelerators.
                </p>
              </Fold>

              <Fold title="Committed people">
                <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Engineers</span>
                    <input className="field tap-target sm:min-h-0" type="number" min={0} step={1} value={draft.engineers} onChange={(event) => update({ engineers: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Researchers</span>
                    <input className="field tap-target sm:min-h-0" type="number" min={0} step={1} value={draft.researchers} onChange={(event) => update({ researchers: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Cleared staff</span>
                    <input className="field tap-target sm:min-h-0" type="number" min={0} step={1} value={draft.clearedStaff} onChange={(event) => update({ clearedStaff: event.target.value })} />
                  </label>
                </div>
                <p className="mt-1 text-[10px] text-ink-faint">
                  The programme scale is around {analysis.scale.staff} technical staff and {analysis.scale.clearedStaff} cleared. You employ{' '}
                  {company.employees.engineers} engineers and {company.employees.researchers} researchers.
                </p>
              </Fold>

              <Fold title="Schedule">
                <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Quarters to first full delivery</span>
                    <input
                      className="field tap-target sm:min-h-0"
                      type="number"
                      min={1}
                      max={40}
                      value={draft.deliveryQuarters}
                      onChange={(event) => update({ deliveryQuarters: Math.max(1, Math.min(40, Number(event.target.value) || 1)) })}
                    />
                  </label>
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Milestones</span>
                    <input
                      className="field tap-target sm:min-h-0"
                      type="number"
                      min={1}
                      max={20}
                      value={draft.milestoneCount}
                      onChange={(event) => update({ milestoneCount: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
                    />
                  </label>
                </div>
                <p className="mt-1 text-[10px] text-ink-faint">More milestones mean earlier revenue recognition and more chances to miss.</p>
              </Fold>

              <Fold title="Concessions">
                <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Intellectual property</span>
                    <select className="field tap-target sm:min-h-0" value={draft.ipConcessions} onChange={(event) => update({ ipConcessions: event.target.value as IpConcession })}>
                      {IP_CONCESSIONS.map((option) => (
                        <option key={option} value={option}>
                          {IP_CONCESSION_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label-caps-faint mb-1 block">Audit rights</span>
                    <select className="field tap-target sm:min-h-0" value={draft.auditRights} onChange={(event) => update({ auditRights: event.target.value as AuditRights })}>
                      {AUDIT_RIGHTS.map((option) => (
                        <option key={option} value={option}>
                          {AUDIT_RIGHTS_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="mt-2.5 block">
                  <span className="label-caps-faint mb-1 flex items-baseline justify-between">
                    <span>Domestic sourcing</span>
                    <span className="figure text-ink-dim">{formatPct(draft.domesticSourcingPct)}</span>
                  </span>
                  <input
                    type="range"
                    className="tap-target w-full sm:min-h-0"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.domesticSourcingPct}
                    onChange={(event) => update({ domesticSourcingPct: Number(event.target.value) })}
                  />
                </label>
              </Fold>

              <Fold title="Technical claims">
                <p className="mt-1.5 text-[10px] text-ink-faint">
                  Each claim is discounted by what this company can actually do. Promising what you cannot deliver scores well now and destroys past
                  performance later.
                </p>
                <div className="mt-2 space-y-2.5">
                  {(
                    [
                      ['modelCapability', 'Model capability'],
                      ['architectureQuality', 'Architecture quality'],
                      ['securityPosture', 'Security posture'],
                      ['reliabilityCommitment', 'Reliability commitment'],
                      ['responsibleAiCommitment', 'Responsible AI commitment'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="label-caps-faint mb-1 flex items-baseline justify-between">
                        <span>{label}</span>
                        <span className="figure text-ink-dim">{formatPct(draft[key])}</span>
                      </span>
                      <input
                        type="range"
                        className="tap-target w-full sm:min-h-0"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft[key]}
                        onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<BidDraft>)}
                      />
                    </label>
                  ))}
                </div>
              </Fold>

              {!active.allowsConsortium ? null : (
                <Fold title="Consortium and subcontractors">
                  <div className="mt-2">
                    <div className="label-caps-faint mb-1">Bid jointly as equals</div>
                    <div className="flex flex-wrap gap-1.5">
                      {partners.map((partner) => (
                        <button
                          key={partner.id}
                          type="button"
                          className={`btn btn-sm tap-target sm:min-h-0 ${draft.consortiumMemberIds.includes(partner.id ?? '') ? 'btn-primary' : ''}`}
                          onClick={() => toggleConsortium(partner.id ?? '')}
                        >
                          {partner.name ?? partner.id}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <div className="label-caps-faint mb-1">Subcontract to</div>
                    <div className="flex flex-wrap gap-1.5">
                      {partners.map((partner) => (
                        <button
                          key={partner.id}
                          type="button"
                          className={`btn btn-sm tap-target sm:min-h-0 ${draft.subcontractors.some((entry) => entry.companyId === partner.id) ? 'btn-primary' : ''}`}
                          onClick={() => toggleSubcontractor(partner.id ?? '', partner.name ?? (partner.id ?? ''))}
                        >
                          {partner.name ?? partner.id}
                        </button>
                      ))}
                    </div>
                    {draft.subcontractors.length === 0 ? null : (
                      <p className="mt-1 text-[10px] text-ink-faint">
                        Each subcontractor takes 15% of contract value by default; the engine checks the shares when the bid is scored.
                      </p>
                    )}
                  </div>
                </Fold>
              )}

              <label className="block">
                <span className="label-caps-faint mb-1 block">Narrative</span>
                <textarea
                  className="field tap-target sm:min-h-0"
                  rows={3}
                  maxLength={800}
                  value={draft.narrative}
                  onChange={(event) => update({ narrative: event.target.value })}
                  placeholder="The pitch, in the agency's language."
                />
                <span className="mt-1 block text-[10px] text-ink-faint">Colour only. The score comes from the numbers.</span>
              </label>
            </div>

            {/* --------------------------- the verdict ------------------------ */}
            <div className="space-y-3.5">
              <div className="panel-surface p-3">
                <SectionHeading rule>Hard requirements</SectionHeading>
                <ul className="mt-2 space-y-1.5">
                  {analysis.gates.length === 0 ? (
                    <li className="flex items-start gap-2 text-[13px] text-gain sm:text-[11px]">
                      <Icon name="check" size={15} accent="current" className="mt-px" />
                      Every hard requirement is met. The bid will be scored.
                    </li>
                  ) : (
                    analysis.gates.map((reason) => (
                      <li key={reason} className="flex items-start gap-2 text-[13px] text-loss sm:text-[11px]">
                        <Icon name="warning" size={15} accent="current" className="mt-px" />
                        <span className="leading-relaxed">{reason}</span>
                      </li>
                    ))
                  )}
                </ul>
                <p className="mt-2 text-[10px] text-ink-faint">
                  A bid that fails any requirement is not scored — it is disqualified. This list is the engine&apos;s own gate, run against the draft
                  as it stands.
                </p>
              </div>

              <div className="panel-surface p-3">
                <SectionHeading rule>Price realism</SectionHeading>
                <div className="mt-2">
                  <KeyValueGrid
                    columns={1}
                    items={[
                      { label: 'Your price', value: formatMoney(priceValue) },
                      { label: 'Evaluators’ estimate', value: formatMoney(analysis.estimate.estimateUsd), hint: 'Half bottom-up from your commitments, half programme scope' },
                      { label: 'Bottom-up from your bid', value: formatMoney(analysis.estimate.bottomUpUsd) },
                      { label: 'Standing compliance cost', value: `${formatMoney(analysis.estimate.complianceQuarterlyUsd)} / quarter` },
                    ]}
                  />
                </div>
                <div className="mt-3">
                  <Meter value={analysis.realism * 100} label="Cost-realism score" />
                </div>
                <p className="mt-2 text-[10px] text-ink-faint">
                  Both an implausibly low and an uncompetitively high price score badly. The parabola peaks near the evaluators&apos; estimate.
                </p>
              </div>

              <div className="panel-surface p-3">
                <SectionHeading rule>What it costs you</SectionHeading>
                <div className="mt-2">
                  <KeyValueGrid
                    columns={1}
                    items={[
                      {
                        label: 'Compute locked',
                        value: `${Math.round(Number.parseFloat(draft.acceleratorUnits) || 0)} units × ${draft.computeQuarters}q`,
                        tone: (Number.parseFloat(draft.acceleratorUnits) || 0) > company.compute.ownedAccelerators + company.compute.reservedAccelerators ? 'warn' : undefined,
                      },
                      {
                        label: 'People assigned',
                        value: `${Math.round(Number.parseFloat(draft.engineers) || 0)} eng · ${Math.round(Number.parseFloat(draft.researchers) || 0)} res`,
                      },
                      { label: 'IP given up', value: IP_CONCESSION_LABEL[draft.ipConcessions], mono: false },
                      { label: 'Audit access', value: AUDIT_RIGHTS_LABEL[draft.auditRights], mono: false },
                      {
                        label: 'Export exposure',
                        value: active.requirements.dataSovereignty ? 'Sovereign — restricts foreign sale' : 'Standard',
                        mono: false,
                      },
                    ]}
                  />
                </div>
              </div>

              {result === null && preview !== null ? <ValidationBanner result={preview} /> : null}
              {result === null ? null : <ValidationBanner result={result} />}

              {analysis.gates.length > 0 ? (
                <Tag tone="warn" dot>
                  Fix the hard requirements before confirming
                </Tag>
              ) : null}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirming && active !== null && draft !== null}
        title="Submit a government bid"
        actionType="bid_government"
        tone="warn"
        body="A large award brings backlog, credibility and stable demand, and with it compliance cost, capacity lock-in, export restrictions and employee unease. Winning is not automatically good."
        terms={
          active === null || draft === null || analysis === null
            ? undefined
            : [
                { label: 'Programme', value: active.programme },
                { label: 'Price', value: formatMoney(priceValue), emphasis: true },
                { label: 'Evaluators’ estimate', value: formatMoney(analysis.estimate.estimateUsd) },
                { label: 'Compute locked', value: `${Math.round(Number.parseFloat(draft.acceleratorUnits) || 0)} units for ${draft.computeQuarters} quarters` },
                { label: 'IP concession', value: IP_CONCESSION_LABEL[draft.ipConcessions] },
                { label: 'Compliance', value: `${formatMoney(analysis.estimate.complianceQuarterlyUsd)} a quarter while live` },
              ]
        }
        confirmLabel="Confirm the bid"
        onCancel={() => setConfirming(false)}
        onConfirm={confirmBid}
      />
    </>
  );
}

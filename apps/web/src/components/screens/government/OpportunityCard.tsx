'use client';

/**
 * One open competition.
 *
 * The card states the two things that decide whether bidding is worth the
 * quarter: how the agency will weigh the bids, and which gates this company
 * already passes. Weights are the opportunity's own; the eligibility figure is
 * `recordPastPerformance`, the same number the engine's gate reads.
 *
 * Declining is a real move, not an absence: an invited opportunity turned down
 * is noted by the agency, so it goes through the action queue like everything
 * else.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Company, PlayerView, ProcurementOpportunity, SessionState } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { CLEARANCE_STAFF_REQUIREMENT, recordPastPerformance } from '@frontier/simulation';
import { formatMoney, formatPct, formatScore } from '@frontier/shared';
import { BarChart, Icon, ProgressBar, SectionHeading, SectorBadge, SliderField, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { EVALUATION_AXIS_LABEL } from './bidModel';
import { opportunitySector } from './sectors';

export interface OpportunityCardProps {
  readonly session: SessionState;
  readonly company: Company;
  readonly view: PlayerView;
  readonly opportunity: ProcurementOpportunity;
  readonly agencyName: string;
  readonly alreadyBid: boolean;
  readonly onCompose: (opportunity: ProcurementOpportunity) => void;
}

interface Gate {
  readonly label: string;
  readonly met: boolean;
  readonly detail: string;
}

export function OpportunityCard({
  session,
  company,
  view,
  opportunity,
  agencyName,
  alreadyBid,
  onCompose,
}: OpportunityCardProps): React.JSX.Element {
  const { queueAction } = useGameActions();
  const [panel, setPanel] = useState<'none' | 'decline' | 'consortium'>('none');
  const [reason, setReason] = useState('');
  const [invitees, setInvitees] = useState<readonly string[]>([]);
  const [lead, setLead] = useState(company.id);
  const [share, setShare] = useState(0.5);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const sector = opportunitySector(opportunity);
  const record = recordPastPerformance(session, company, opportunity.agencyId);
  const requirements = opportunity.requirements;
  const clearedNeeded = CLEARANCE_STAFF_REQUIREMENT[requirements.clearanceLevel];
  const quartersLeft = opportunity.closeQuarter - session.quarter;

  const weights = useMemo(
    () =>
      (Object.entries(opportunity.evaluationWeights) as readonly [keyof typeof EVALUATION_AXIS_LABEL, number][])
        .map(([axis, weight]) => ({ label: EVALUATION_AXIS_LABEL[axis], value: weight, tone: 'brand' as const }))
        .sort((a, b) => b.value - a.value),
    [opportunity.evaluationWeights],
  );

  const gates: readonly Gate[] = [
    {
      label: 'Past-performance floor',
      met: record >= requirements.minimumPastPerformance,
      detail: `${formatScore(record)} held against a floor of ${formatScore(requirements.minimumPastPerformance)}`,
    },
    {
      label: 'Eligible to bid',
      met: opportunity.visibility !== 'invited' || opportunity.invitedCompanyIds.includes(company.id),
      detail: opportunity.visibility === 'invited' ? 'Invited competition' : 'Open competition',
    },
    {
      label: 'Not already bid',
      met: !alreadyBid,
      detail: alreadyBid ? 'A bid from this company is already on file' : 'No bid on file',
    },
  ];

  const commitments: readonly Gate[] = [
    {
      label: `${requirements.clearanceLevel.replace(/_/g, ' ')} clearance`,
      met: clearedNeeded === 0,
      detail: `${clearedNeeded} cleared staff must be committed in the bid`,
    },
    {
      label: 'Domestic inference',
      met: !requirements.domesticInference,
      detail: requirements.domesticInference ? 'The bid must source at least 80% domestically' : 'Not required',
    },
    {
      label: 'Data sovereignty',
      met: !requirements.dataSovereignty,
      detail: requirements.dataSovereignty ? 'The bid must keep at least 50% in jurisdiction' : 'Not required',
    },
    {
      label: 'Independent model audit',
      met: !requirements.modelAudit,
      detail: requirements.modelAudit ? 'The bid must grant audit rights' : 'Not required',
    },
    {
      label: `${requirements.uptimePct}% availability`,
      met: false,
      detail: 'Sets the floor on the reliability commitment the bid may claim',
    },
  ];

  const blocked = gates.filter((gate) => !gate.met);

  function decline(): void {
    const entry = queueAction({
      type: 'decline_opportunity',
      opportunityId: opportunity.id,
      reason: reason.trim().length > 0 ? reason.trim().slice(0, 300) : 'Not a fit for this company this quarter.',
    });
    setResult(entry.validation);
  }

  function formConsortium(): void {
    if (invitees.length === 0) return;
    const entry = queueAction({
      type: 'form_consortium',
      opportunityId: opportunity.id,
      inviteeCompanyIds: [...invitees],
      leadCompanyId: lead,
      sharePct: share,
    });
    setResult(entry.validation);
  }

  const partners = view.visibleCompanies.filter((rival) => rival.id !== undefined);

  return (
    <div className="panel-surface p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="label-caps-faint">{agencyName}</div>
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink sm:text-[14px]">{opportunity.programme}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Only where the notice actually says. A programme the engine opened
              later carries no sector, and no badge is drawn rather than one
              inferred from its name. */}
          {sector === null ? null : <SectorBadge sector={sector} />}
          <Tag tone={opportunity.contractForm === 'cost_plus' ? 'info' : 'neutral'}>{opportunity.contractForm.replace(/_/g, ' ')}</Tag>
          <Tag tone={quartersLeft <= 1 ? 'warn' : 'neutral'} dot>
            closes {quarterLabel(session.startYear, opportunity.closeQuarter)}
          </Tag>
          {opportunity.allowsConsortium ? <Tag tone="brand">consortium allowed</Tag> : null}
        </div>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed text-ink-dim sm:text-[11px]">{opportunity.description}</p>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-card bg-raised px-3 py-2.5 sm:grid-cols-4">
        <div className="flex items-baseline justify-between gap-2 sm:block">
          <div className="label-caps-faint">Ceiling</div>
          <div className="figure text-[14px] text-ink sm:text-[13px]">{formatMoney(opportunity.maxValue)}</div>
        </div>
        <div className="flex items-baseline justify-between gap-2 sm:block">
          <div className="label-caps-faint">Term</div>
          <div className="figure text-[14px] text-ink sm:text-[13px]">{opportunity.durationQuarters}q</div>
        </div>
        <div className="flex items-baseline justify-between gap-2 sm:block">
          <div className="label-caps-faint">Your record</div>
          <div className={`figure text-[14px] sm:text-[13px] ${record >= requirements.minimumPastPerformance ? 'text-gain' : 'text-loss'}`}>
            {formatScore(record)}
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-2 sm:block">
          <div className="label-caps-faint">Floor</div>
          <div className="figure text-[14px] text-ink sm:text-[13px]">{formatScore(requirements.minimumPastPerformance)}</div>
        </div>
      </div>

      {/* The checklist leads on a phone: whether this company can bid at all is
          the first question, and the weights only matter once it can. */}
      <div className="mt-3 grid gap-3.5 lg:grid-cols-2">
        <div className="lg:order-2">
          <SectionHeading rule>Can you bid</SectionHeading>
          <ul className="mt-2 flex flex-col gap-1.5">
            {gates.map((gate) => (
              <li key={gate.label} className="flex items-start gap-2">
                <span
                  className={cx(
                    'mt-px flex size-5 shrink-0 items-center justify-center rounded-pill',
                    gate.met ? 'icon-knockout-wash bg-gain-wash text-gain' : 'icon-knockout-wash bg-loss-wash text-loss',
                  )}
                >
                  <Icon name={gate.met ? 'check' : 'close'} size={13} accent="inherit" />
                </span>
                <span className="min-w-0">
                  <span className={cx('text-[13px] sm:text-[11px]', gate.met ? 'text-ink-dim' : 'font-semibold text-loss')}>{gate.label}</span>
                  <span className="block text-[11px] leading-relaxed text-ink-faint sm:text-[10px]">{gate.detail}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-3">
            <div className="label-caps-faint mb-1.5">The bid must commit</div>
            <ul className="flex flex-col gap-1.5">
              {commitments.map((item) => (
                <li key={item.label} className="flex items-start gap-2">
                  <span
                    className={cx(
                      'mt-px flex size-5 shrink-0 items-center justify-center rounded-pill',
                      item.met ? 'icon-knockout-raised bg-raised text-ink-faint' : 'icon-knockout-wash bg-warn-wash text-warn',
                    )}
                  >
                    <Icon name={item.met ? 'check' : 'warning'} size={13} accent="inherit" />
                  </span>
                  <span className="min-w-0">
                    <span className="text-[13px] text-ink-dim sm:text-[11px]">{item.label}</span>
                    <span className="block text-[11px] leading-relaxed text-ink-faint sm:text-[10px]">{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lg:order-1">
          <SectionHeading rule>How it will be judged</SectionHeading>
          <div className="mt-2">
            <BarChart data={weights} max={1} formatValue={(value) => formatPct(value)} />
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-hair pt-3">
        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <Icon name={blocked.length === 0 ? 'check' : 'warning'} size={13} accent={blocked.length === 0 ? 'gain' : 'warn'} />
          {blocked.length === 0 ? 'This company clears every eligibility gate.' : `${blocked.length} gate${blocked.length === 1 ? '' : 's'} blocking a bid.`}
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-1.5">
          <button
            type="button"
            className={cx('btn btn-sm tap-target w-full sm:order-3 sm:w-auto sm:min-h-0', blocked.length > 0 ? '' : 'btn-primary')}
            onClick={() => onCompose(opportunity)}
          >
            {blocked.length > 0 ? 'Inspect requirements' : 'Compose bid'}
          </button>
          <div className={cx('grid gap-2 sm:contents', opportunity.allowsConsortium ? 'grid-cols-2' : 'grid-cols-1')}>
            {opportunity.allowsConsortium ? (
              <button
                type="button"
                className="btn btn-sm tap-target sm:order-1 sm:min-h-0"
                onClick={() => setPanel(panel === 'consortium' ? 'none' : 'consortium')}
              >
                Form consortium
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm tap-target sm:order-2 sm:min-h-0"
              onClick={() => setPanel(panel === 'decline' ? 'none' : 'decline')}
            >
              Decline
            </button>
          </div>
        </div>
      </div>

      {panel === 'decline' ? (
        <div className="mt-2.5 border-t border-hair pt-2.5">
          <label className="block">
            <span className="label-caps-faint mb-1 block">Reason</span>
            <input className="field tap-target sm:min-h-0" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this is not a fit." />
          </label>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            Declining an invited opportunity is noted by the agency and mildly reduces future invitations.
          </p>
          <div className="mt-2 flex justify-end">
            <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={decline}>
              Queue decline
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'consortium' ? (
        <div className="mt-2.5 space-y-2.5 border-t border-hair pt-2.5">
          <div>
            <div className="label-caps-faint mb-1">Invite</div>
            <div className="flex flex-wrap gap-1.5">
              {partners.map((partner) => (
                <button
                  key={partner.id}
                  type="button"
                  className={`btn btn-sm tap-target sm:min-h-0 ${invitees.includes(partner.id ?? '') ? 'btn-primary' : ''}`}
                  onClick={() =>
                    setInvitees((current) =>
                      current.includes(partner.id ?? '') ? current.filter((entry) => entry !== partner.id) : [...current, partner.id ?? ''].slice(0, 5),
                    )
                  }
                >
                  {partner.name ?? partner.id}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block">
              <span className="label-caps-faint mb-1 block">Prime contractor</span>
              <select className="field tap-target sm:min-h-0" value={lead} onChange={(event) => setLead(event.target.value)}>
                <option value={company.id}>{company.name} (us)</option>
                {partners
                  .filter((partner) => invitees.includes(partner.id ?? ''))
                  .map((partner) => (
                    <option key={partner.id} value={partner.id}>
                      {partner.name ?? partner.id}
                    </option>
                  ))}
              </select>
            </label>
            <div>
              {/* A consortium share of nothing is not a consortium: 5% is the
                  floor the card has always offered, and it stays the floor. */}
              <SliderField
                label="Your share"
                value={share}
                onChange={setShare}
                min={0.05}
                max={1}
                step={0.05}
                format={formatPct}
                exact={false}
              />
              <ProgressBar value={share} tone="brand" />
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Each invitee must accept through the deal system before the consortium is real. The prime is accountable for the whole programme.
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0"
              disabled={invitees.length === 0}
              onClick={formConsortium}
            >
              Queue consortium
            </button>
          </div>
        </div>
      ) : null}

      {result === null ? null : (
        <div className="mt-2.5">
          <ValidationBanner result={result} />
        </div>
      )}
    </div>
  );
}

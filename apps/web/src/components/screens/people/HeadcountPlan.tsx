'use client';

/**
 * The headcount plan.
 *
 * One card per function. Each carries the two tickets that move it — open
 * requisitions and reduce the team — with the validator consulted before either
 * is queued, so the affordability answer arrives while the player is still
 * deciding rather than at the end of the quarter.
 *
 * `layoff` is one of the thirteen. It cannot be queued without a human passing
 * through `ConfirmDialog`, and the dialog states the cash and the morale cost in
 * the same breath.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Company, CompBand, SessionState, StaffRole } from '@frontier/contracts';
import { COMP_BANDS, STAFF_ROLES } from '@frontier/contracts';
import { HIRING_CASH_COVER_QUARTERS, fillRate, offerCompUsd, quarterlyHireCostUsd, requiredCompUsd } from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
import { ConfirmDialog, Panel, ProgressBar, Tag, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { BAND_BLURB, BAND_LABEL, ROLE_BLURB, ROLE_LABEL, headcountOf } from './labels';

export interface HeadcountPlanProps {
  readonly session: SessionState;
  readonly company: Company;
}

interface PendingLayoff {
  readonly role: StaffRole;
  readonly count: number;
  readonly severanceQuartersOfPay: number;
  readonly cashUsd: number;
  readonly sharePct: number;
}

export function HeadcountPlan({ session, company }: HeadcountPlanProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [band, setBand] = useState<CompBand>('market');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [severance, setSeverance] = useState(2);
  const [results, setResults] = useState<Record<string, ActionValidationResult>>({});
  const [pending, setPending] = useState<PendingLayoff | null>(null);

  const headcount = headcountOf(company);

  function countFor(role: StaffRole): number {
    const parsed = Number.parseInt(counts[role] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function hire(role: StaffRole): void {
    const count = countFor(role);
    if (count <= 0) return;
    const entry = queueAction({ type: 'hire', role, count, compBand: band });
    setResults((current) => ({ ...current, [role]: entry.validation }));
  }

  function askLayoff(role: StaffRole): void {
    const count = countFor(role);
    if (count <= 0) return;
    const perHead = quarterlyHireCostUsd(session, role, 'market') * severance;
    setPending({
      role,
      count,
      severanceQuartersOfPay: severance,
      cashUsd: perHead * count,
      sharePct: headcount === 0 ? 0 : count / headcount,
    });
  }

  function confirmLayoff(): void {
    if (pending === null) return;
    const entry = queueAction(
      { type: 'layoff', role: pending.role, count: pending.count, severanceQuartersOfPay: pending.severanceQuartersOfPay },
      { confirmed: true },
    );
    setResults((current) => ({ ...current, [pending.role]: entry.validation }));
    setPending(null);
  }

  const bandPreview = useMemo(
    () =>
      STAFF_ROLES.map((role) => ({
        role,
        perQuarterUsd: quarterlyHireCostUsd(session, role, band),
        offerAnnualUsd: offerCompUsd(session, role, band),
        marketAnnualUsd: requiredCompUsd(session, role),
        fill: fillRate(session, company, role, band),
      })),
    [session, company, band],
  );

  return (
    <>
      <Panel
        title="Headcount plan"
        subtitle={`${headcount} people · ${company.employees.openRoles} roles already open`}
        actions={
          <select className="field h-6 w-auto text-[11px]" value={band} onChange={(event) => setBand(event.target.value as CompBand)}>
            {COMP_BANDS.map((option) => (
              <option key={option} value={option}>
                {BAND_LABEL[option]}
              </option>
            ))}
          </select>
        }
      >
        <p className="text-[10px] text-ink-faint">{BAND_BLURB[band]}</p>

        <div className="mt-3 grid gap-2.5 lg:grid-cols-2">
          {bandPreview.map((entry) => {
            const role = entry.role;
            const count = countFor(role);
            const hireIntent = count > 0 ? validateIntent({ type: 'hire', role, count, compBand: band }) : null;
            const result = results[role] ?? null;
            const cashNeeded = entry.perQuarterUsd * HIRING_CASH_COVER_QUARTERS * count;

            return (
              <div key={role} className="raised-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink">{ROLE_LABEL[role]}</div>
                    <div className="text-[10px] text-ink-faint">{ROLE_BLURB[role]}</div>
                  </div>
                  <div className="text-right">
                    <div className="figure text-[15px] text-ink">{company.employees[role]}</div>
                    <div className="label-caps-faint">in post</div>
                  </div>
                </div>

                <div className="mt-2.5">
                  <ProgressBar
                    label={`Expected fill rate at ${BAND_LABEL[band].toLowerCase()}`}
                    value={entry.fill}
                    tone={entry.fill >= 0.5 ? 'gain' : entry.fill >= 0.25 ? 'warn' : 'loss'}
                    valueLabel={formatPct(entry.fill, 0)}
                  />
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-ink-faint">
                  <div>
                    Offer <span className="figure text-ink-dim">{formatMoney(entry.offerAnnualUsd)}</span> a year
                  </div>
                  <div className="text-right">
                    Market <span className="figure text-ink-dim">{formatMoney(entry.marketAnnualUsd)}</span>
                  </div>
                </div>

                <div className="mt-2.5 flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="label-caps-faint mb-1 block">People</span>
                    <input
                      className="field"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      placeholder="0"
                      value={counts[role] ?? ''}
                      onChange={(event) => setCounts((current) => ({ ...current, [role]: event.target.value }))}
                    />
                  </label>
                  <button type="button" className="btn btn-primary btn-sm" disabled={count <= 0} onClick={() => hire(role)}>
                    Hire
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={count <= 0 || company.employees[role] <= 0}
                    onClick={() => askLayoff(role)}
                  >
                    Reduce
                  </button>
                </div>

                {count > 0 ? (
                  <p className="mt-1.5 text-[10px] text-ink-faint">
                    {count} hire{count === 1 ? '' : 's'} reserves{' '}
                    <span className="figure text-ink-dim">{formatMoney(cashNeeded)}</span> of uncommitted cash —{' '}
                    {HIRING_CASH_COVER_QUARTERS} quarters of cover per requisition.
                  </p>
                ) : null}

                {result === null && hireIntent !== null ? (
                  <div className="mt-2">
                    <ValidationBanner result={hireIntent} compact />
                  </div>
                ) : null}
                {result === null ? null : (
                  <div className="mt-2">
                    <ValidationBanner result={result} compact />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-3">
          <span className="label-caps-faint">Severance on a reduction</span>
          <select className="field h-6 w-auto text-[11px]" value={severance} onChange={(event) => setSeverance(Number(event.target.value))}>
            {[0, 1, 2, 3, 4].map((quarters) => (
              <option key={quarters} value={quarters}>
                {quarters} quarter{quarters === 1 ? '' : 's'} of pay
              </option>
            ))}
          </select>
          <Tag tone={severance >= 2 ? 'gain' : 'warn'} dot>
            {severance >= 2 ? 'Protects some morale' : 'Cheap now, expensive in morale'}
          </Tag>
        </div>
      </Panel>

      <ConfirmDialog
        open={pending !== null}
        title="Reduce headcount"
        actionType="layoff"
        tone="loss"
        body="Layoffs always damage morale, and the damage depends on how it is done and on what else the company is spending on. Severance protects some of it, and costs cash now."
        terms={
          pending === null
            ? undefined
            : [
                { label: 'Roles cut', value: `${pending.count} ${ROLE_LABEL[pending.role].toLowerCase()}` },
                { label: 'Share of the company', value: formatPct(pending.sharePct, 1), emphasis: pending.sharePct >= 0.15 },
                { label: 'Severance', value: `${pending.severanceQuartersOfPay} quarters of pay` },
                { label: 'Cash cost', value: formatMoney(pending.cashUsd), emphasis: true },
                {
                  label: 'Governance',
                  value: pending.sharePct >= 0.15 ? 'Above 15% — becomes a board matter' : 'Management decision',
                },
              ]
        }
        confirmLabel="Confirm reduction"
        onCancel={() => setPending(null)}
        onConfirm={confirmLayoff}
      />
    </>
  );
}

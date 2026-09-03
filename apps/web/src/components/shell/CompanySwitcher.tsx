'use client';

/**
 * STAGE 5 — the company switcher.
 *
 * Lives where the identity block used to be a plain link: icon and name, one
 * tap away from a sheet listing every company this seat directs — the
 * founding company first, a sector badge, control %, cash and headcount on
 * each row, and its own solvency clock when one is running. A "Group" row
 * opens the consolidated view rather than switching to any one company.
 *
 * When the seat controls only its founding company there is nothing to pick
 * between, so this renders the plain identity block it always did — no sheet,
 * no chevron, no tap target that would open to a list of one.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatMoney } from '@frontier/shared';
import { SOLVENCY_NEGATIVE_QUARTERS } from '@frontier/simulation';
import { PLAYER_ID, controlledCompanyRows, useActiveCompanyId, useGameActions, useSession } from '@/lib/game';
import { ownershipLabel } from '@/components/screens/portfolio/rows';
import { Drawer, Icon, SectorBadge, cx } from '@/components/ui';

/** "0/2" reads as healthy without a colour cue; only a run in progress gets one. */
function solvencyChip(negativeCashQuarters: number): { label: string; tone: 'neutral' | 'warn' | 'loss' } {
  if (negativeCashQuarters <= 0) return { label: 'Solvent', tone: 'neutral' };
  if (negativeCashQuarters >= SOLVENCY_NEGATIVE_QUARTERS) return { label: `${negativeCashQuarters}/${SOLVENCY_NEGATIVE_QUARTERS} negative`, tone: 'loss' };
  return { label: `${negativeCashQuarters}/${SOLVENCY_NEGATIVE_QUARTERS} negative`, tone: 'warn' };
}

export function CompanySwitcher(): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const activeCompanyId = useActiveCompanyId();
  const { setActiveCompany } = useGameActions();
  const [open, setOpen] = useState(false);

  const rows = controlledCompanyRows(session, PLAYER_ID);
  const active = rows.find((row) => row.company.id === activeCompanyId) ?? rows[0] ?? null;

  if (rows.length <= 1 || active === null) {
    return (
      <Link
        href="/command-centre"
        className="tap-target flex min-w-0 items-center gap-2 rounded-chip px-1.5 hover:bg-raised sm:gap-2.5 sm:px-2"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-chip bg-brand-strong text-white shadow-card">
          <Icon name="logo" size={16} accent="current" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] leading-tight font-bold text-ink">{active?.company.name ?? 'Frontier Capital'}</span>
          <span className="label-caps-faint hidden truncate leading-none sm:block">Frontier Capital</span>
        </span>
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap-target flex min-w-0 items-center gap-2 rounded-chip px-1.5 hover:bg-raised sm:gap-2.5 sm:px-2"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Directing ${active.company.name}. Tap to switch company.`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-chip bg-brand-strong text-white shadow-card">
          <Icon name="logo" size={16} accent="current" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1 truncate text-[12.5px] leading-tight font-bold text-ink">
            {active.company.name}
            <Icon name="chevronDown" size={12} accent="inherit" className="shrink-0 text-ink-faint" />
          </span>
          <span className="label-caps-faint hidden truncate leading-none sm:block">
            {active.isFounding ? 'Founding company' : 'Subsidiary'}
          </span>
        </span>
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title="Direct a company" subtitle={`${rows.length} companies in your group`} side="bottom">
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const solvency = solvencyChip(row.negativeCashQuarters);
            const isActive = row.company.id === active.company.id;
            return (
              <button
                key={row.company.id}
                type="button"
                onClick={() => {
                  setActiveCompany(row.company.id);
                  setOpen(false);
                }}
                className={cx(
                  'press-pop tap-target flex items-center gap-3 rounded-panel border px-3 py-2.5 text-left transition-colors',
                  isActive ? 'border-brand/40 bg-brand-wash' : 'border-hair bg-panel hover:bg-raised',
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-raised">
                  <Icon name="building" size={16} accent="brand" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-bold text-ink">{row.company.name}</span>
                    {row.isFounding ? <span className="label-caps-faint text-brand">Founding</span> : null}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-dim">
                    <SectorBadge sector={row.company.sector} size="sm" />
                    {!row.isFounding ? <span>{ownershipLabel(row.controlPct)} control</span> : null}
                    <span>{formatMoney(row.company.financials.cash)} cash</span>
                    <span>{row.headcount} staff</span>
                  </span>
                </span>
                <span
                  className={cx(
                    'label-caps-faint shrink-0 rounded-pill px-1.5 py-0.5',
                    solvency.tone === 'loss' ? 'bg-loss-wash text-loss' : solvency.tone === 'warn' ? 'bg-warn-wash text-warn' : 'text-ink-faint',
                  )}
                >
                  {solvency.label}
                </span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/group');
            }}
            className="press-pop tap-target mt-1 flex items-center gap-3 rounded-panel border border-dashed border-hair px-3 py-2.5 text-left hover:bg-raised"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-raised">
              <Icon name="chart" size={16} accent="brand" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-bold text-ink">Group</span>
              <span className="block text-[10.5px] text-ink-dim">Consolidated revenue, cash, debt and market value across all {rows.length}</span>
            </span>
            <Icon name="chevronRight" size={14} accent="inherit" className="shrink-0 text-ink-faint" />
          </button>
        </div>
      </Drawer>
    </>
  );
}

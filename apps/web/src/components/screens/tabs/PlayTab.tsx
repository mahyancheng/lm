'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { SOLVENCY_NEGATIVE_QUARTERS } from '@frontier/simulation';
import { ConfirmDialog, Icon, Tag, cashAfterOf } from '@/components/ui';
import { cashEffectOf } from '@/components/screens/end-quarter/intents';
import { askChief } from '@/components/screens/chief-of-staff/composerBus';
import { groupQueueByCompany } from '@/components/screens/end-quarter/companyGrouping';
import { PLAYER_ID, useGameActions, usePlayerCompany, usePlayerView, useQueuedActions, useResolving, useSession } from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import { BeforeYouSubmitCard } from './cards/play-cards';
import { QueueCard, groupQueueByPhase } from './cards/play-queue';

/** Plan is the deliberate pause between choosing moves and advancing the world. */
export function PlayTab(): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const company = usePlayerCompany();
  const view = usePlayerView();
  const queue = useQueuedActions();
  const { resolving, status } = useResolving();
  const { confirmAction, unqueueAction, clearQueue, endQuarter } = useGameActions();
  const [reviewing, setReviewing] = useState(false);

  const blocked = queue.filter((entry) => entry.blocked);
  const rejected = queue.filter((entry) => entry.validation.status === 'rejected');
  const cash = useMemo(() => queue.reduce((sum, entry) => {
    if (entry.validation.status === 'rejected') return sum;
    const effect = cashEffectOf(session, entry.validation.clampedAction ?? entry.action.intent);
    return { outflow: sum.outflow + effect.outflowUsd, inflow: sum.inflow + effect.inflowUsd };
  }, { outflow: 0, inflow: 0 }), [queue, session]);
  const available = company.financials.cash;
  const solvency = cashAfterOf(company, cash.outflow - cash.inflow);
  const groups = useMemo(() => groupQueueByPhase(queue), [queue]);
  const companyGroups = useMemo(() => groupQueueByCompany(session, queue, PLAYER_ID), [session, queue]);
  const names = useMemo(() => new Map([[company.id, company.name], ...view.visibleCompanies.map((entry) => [entry.id, entry.name] as const)]), [company, view.visibleCompanies]);
  const quarter = quarterLabel(session.startYear, session.quarter);
  const nextQuarter = quarterLabel(session.startYear, session.quarter + 1);
  const canAdvance = blocked.length === 0 && !resolving;

  async function advance(): Promise<void> {
    setReviewing(false);
    let resolved = false;
    try { resolved = await endQuarter(); } catch { resolved = false; } finally { if (resolved) router.replace(sheetHref('resolution')); }
  }

  return <div className="flex flex-col gap-5 pb-24">
    <section className="panel-surface overflow-hidden px-5 py-6 sm:px-7 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3"><Tag tone={blocked.length > 0 ? 'warn' : 'gain'} dot>{blocked.length > 0 ? `${blocked.length} need review` : 'Ready when you are'}</Tag><span className="label-caps-faint">{quarter}</span></div>
      <h1 className="mt-3 font-serif text-4xl leading-tight text-ink sm:text-5xl">Review the plan</h1>
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-dim">These are the moves your company will attempt. Confirm held decisions, remove anything you do not want, then advance the world.</p>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="raised-surface p-3"><div className="label-caps-faint">Moves</div><div className="figure mt-1 text-2xl text-ink">{queue.length}</div></div>
        <div className="raised-surface p-3"><div className="label-caps-faint">Cash now</div><div className="figure mt-1 text-xl text-ink">{formatMoney(available)}</div></div>
        <div className="raised-surface p-3"><div className="label-caps-faint">Planned spend</div><div className="figure mt-1 text-xl text-ink">{formatMoney(cash.outflow)}</div></div>
        <div className="raised-surface p-3"><div className="label-caps-faint">After planned moves</div><div className={`figure mt-1 text-xl ${solvency.afterUsd < 0 ? 'text-loss' : 'text-ink'}`}>{formatMoney(solvency.afterUsd)}</div></div>
      </div>
      <p className="mt-3 text-[10.5px] text-ink-faint">This subtracts planned move costs from cash now. It excludes normal sales, payroll, interest, competitors, and world events.</p>
    </section>

    <BeforeYouSubmitCard blocked={blocked.length} rejected={rejected.length} outflowUsd={cash.outflow} availableUsd={available} afterUsd={solvency.afterUsd} solvencyLine={solvency.line} />

    <QueueCard groups={groups} queued={queue.length} startYear={session.startYear} resolving={resolving} companyGroups={companyGroups} companyNameOf={(id) => names.get(id) ?? id} onConfirm={confirmAction} onRemove={unqueueAction} onClear={clearQueue} />

    <section className="panel-surface flex flex-wrap items-center justify-between gap-3 px-4 py-4"><div><h2 className="font-serif text-xl text-ink">Need another move?</h2><p className="text-[11.5px] text-ink-faint">Ask your Chief of Staff. Any proposal comes back here for review.</p></div><button type="button" onClick={() => askChief('I want to add another move to this quarter.')} className="btn tap-target">Open Chief of Staff</button></section>

    <div className="sticky z-20 border-t border-hair bg-base/95 px-3 py-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0" style={{ bottom: 'calc(var(--bottombar-height) + env(safe-area-inset-bottom, 0px))' }}>
      <button type="button" className="btn btn-primary btn-lg tap-target w-full" disabled={!canAdvance} onClick={() => setReviewing(true)}>{resolving ? 'Advancing…' : blocked.length > 0 ? `Review ${blocked.length} held move${blocked.length === 1 ? '' : 's'}` : `Review and advance to ${nextQuarter}`}</button>
      {status === null ? null : <p className="mt-2 text-center text-[11px] text-loss">{status}</p>}
    </div>

    <ConfirmDialog open={reviewing} title={`Advance to ${nextQuarter}?`} body="This advances the world once. Your accepted moves will run, competitors will act, and the quarter cannot be replayed." terms={[
      { label: 'Quarter closing', value: quarter }, { label: 'Moves', value: String(queue.length) }, { label: 'Planned spend', value: formatMoney(cash.outflow), emphasis: cash.outflow > available }, { label: 'Planned inflow', value: formatMoney(cash.inflow) }, { label: 'After planned moves', value: formatMoney(solvency.afterUsd), emphasis: solvency.afterUsd < 0 }, { label: 'Solvency', value: solvency.line === null ? 'Above zero' : `${solvency.quarters + 1} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero`, emphasis: solvency.afterUsd < 0 },
    ]} confirmLabel={`Advance to ${nextQuarter}`} busy={resolving} onCancel={() => setReviewing(false)} onConfirm={() => void advance()} />
  </div>;
}

'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatQuarterCount } from '@frontier/shared';
import { researchProjectsForCompany } from '@frontier/simulation';
import { Icon, Tag } from '@/components/ui';
import { buildFeed } from '@/components/screens/command-centre/feed';
import { askChief } from '@/components/screens/chief-of-staff/composerBus';
import { NeedsDeciding } from '@/components/screens/home/NeedsDeciding';
import { sheetHref, tabPath } from '@/lib/sheets';
import { useCompanyMetrics, useOutcome, usePlayerCompany, usePlayerView, useQueuedActions, useSession } from '@/lib/game';

/** The founder's daily desk: position, decisions, and work already in motion. */
export function HomeTab(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const metrics = useCompanyMetrics();
  const queue = useQueuedActions();
  const outcome = useOutcome();
  const blocked = queue.filter((entry) => entry.blocked).length;
  const feed = useMemo(() => buildFeed(session, view, outcome, blocked), [session, view, outcome, blocked]);
  const projects = useMemo(() => researchProjectsForCompany(session, company.id).filter((project) => project.companyId === company.id && project.status === 'active'), [session, company.id]);
  const products = company.products.filter((product) => product.isActive);

  return <div className="flex flex-col gap-5">
    <section className="panel-surface relative overflow-hidden px-5 py-6 sm:px-7 sm:py-8">
      <div className="absolute inset-y-0 right-0 w-1/3 bg-gain-wash/40" aria-hidden="true" />
      <div className="relative max-w-3xl">
        <div className="flex flex-wrap items-center gap-2"><Tag tone="brand">{quarterLabel(session.startYear, session.quarter)}</Tag><span className="label-caps-faint">Founder briefing</span></div>
        <h1 className="mt-3 font-serif text-4xl leading-[1.02] tracking-tight text-ink sm:text-5xl">{company.name}</h1>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-ink-dim">{feed[0]?.text ?? 'The quarter is open. Choose where the company should move next.'}</p>
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
          <div><div className="label-caps-faint">Cash</div><div className="figure mt-1 text-xl text-ink">{formatMoney(company.financials.cash)}</div></div>
          <div><div className="label-caps-faint">Runway</div><div className="figure mt-1 text-xl text-ink">{metrics === null ? 'Not yet measured' : formatQuarterCount(metrics.runwayQuarters)}</div></div>
          <div><div className="label-caps-faint">Plan</div><div className="figure mt-1 text-xl text-ink">{queue.length} move{queue.length === 1 ? '' : 's'}{blocked > 0 ? ` · ${blocked} held` : ''}</div></div>
        </div>
      </div>
    </section>

    <NeedsDeciding items={feed.slice(0, 3)} queued={queue.length} unconfirmed={blocked} />

    <section className="rounded-card border border-brand/30 bg-panel px-4 py-4 shadow-card sm:px-5" aria-labelledby="chief-prompt-title">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-gain-wash text-brand"><Icon name="chat" size={20} accent="current" /></span>
        <div className="min-w-0 flex-1"><h2 id="chief-prompt-title" className="font-serif text-2xl text-ink">What do you want to do?</h2>
          <p className="mt-1 text-[12.5px] text-ink-dim">Tell your Chief of Staff in your own words. You will review every proposed move before it enters the plan.</p>
          <button type="button" onClick={() => askChief('What should we do this quarter?')} className="btn btn-primary tap-target mt-3 px-4">Start a conversation</button>
        </div>
      </div>
    </section>


    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel-surface p-4">
        <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-2xl text-ink">In motion</h2><Link href={sheetHref('products')} className="btn btn-ghost tap-target">Open Build</Link></div>
        <div className="mt-3 grid grid-cols-2 gap-3"><div className="raised-surface p-3"><div className="label-caps-faint">Products serving</div><div className="figure mt-1 text-2xl text-ink">{products.length}</div></div><div className="raised-surface p-3"><div className="label-caps-faint">Research active</div><div className="figure mt-1 text-2xl text-ink">{projects.length}</div></div></div>
      </section>
      <section className="panel-surface p-4">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-serif text-2xl text-ink">Quarter plan</h2><p className="text-[11.5px] text-ink-faint">Moves that run when you advance.</p></div><Link href={tabPath('play')} className="btn btn-primary tap-target">Review plan</Link></div>
        {queue.length === 0 ? <p className="mt-4 text-[13px] text-ink-dim">No moves queued yet. Explore Build, Power, or ask your Chief of Staff.</p> : <ul className="mt-3 flex flex-col gap-2">{queue.slice(0, 3).map((entry) => <li key={entry.action.actionId} className="flex min-h-11 items-center justify-between gap-3 rounded-chip border border-hair px-3"><span className="truncate text-[12.5px] capitalize text-ink">{entry.action.intent.type.replaceAll('_', ' ')}</span><Tag tone={entry.validation.status === 'rejected' ? 'loss' : entry.blocked ? 'warn' : 'gain'}>{entry.validation.status === 'rejected' ? 'Will not run' : entry.blocked ? 'Review' : 'Ready'}</Tag></li>)}</ul>}
      </section>
    </div>
  </div>;
}

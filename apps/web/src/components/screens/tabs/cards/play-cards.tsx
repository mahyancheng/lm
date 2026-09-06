'use client';

/**
 * The Play tab's cards: the desk, as a page.
 *
 * Play *is* End Quarter. There is no sheet to open to submit a quarter — the
 * quarter is submitted from the page, which is what makes ending one three taps
 * and a typed word from anywhere in the game: the tab, the seal, the word.
 *
 * The gate is unchanged from the screen this replaces. The seal opens
 * `ConfirmDialog`, the dialog still requires the typed word, a blocked action
 * still refuses the whole submission, and the projection of cash is still the
 * validator's affordability model rather than the economy.
 *
 * Pure by construction: every figure arrives as a prop and every control is a
 * handler, so `playTab.test.tsx` renders these to static markup without a store.
 */

import Link from 'next/link';
import { useState } from 'react';
import type { Company, EnginePhaseTiming } from '@frontier/contracts';
import { RESOLUTION_PHASES } from '@frontier/contracts';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { CashAfter, EmptyState, Icon, KeyValueGrid, Panel, ProgressBar, StatCard, Tag, cx } from '@/components/ui';
import { DOCK_RESERVE_CLASS } from '@/components/shell/dockMetrics';
import { DeskScene, SealStamp, StickyNote } from '@/components/screens/end-quarter/desk';
import { titleise } from '@/components/screens/end-quarter/intents';
import { sheetHref } from '@/lib/sheets';

/* -------------------------------------------------------------------------- */
/*  1. The quarter                                                             */
/* -------------------------------------------------------------------------- */

export interface QuarterCardProps {
  /** The quarter about to close, e.g. `Q3 2027`. */
  readonly quarter: string;
  /** The quarter that most recently committed, or null before any has. */
  readonly lastResolved: string | null;
  readonly queued: number;
  readonly blocked: number;
  readonly resolving: boolean;
  /** The company the cash projection is drawn against — the seat's own. */
  readonly company: Company;
  /** Net cash this submission commits: outflow less what it seeks. */
  readonly netSpendUsd: number;
}

export function QuarterCard({ quarter, lastResolved, queued, blocked, resolving, company, netSpendUsd }: QuarterCardProps): React.JSX.Element {
  const state = resolving ? 'Resolving' : blocked > 0 ? 'Held' : 'Ready';
  return (
    <Panel
      title={quarter}
      iconName="stamp"
      iconTone={blocked > 0 ? 'warn' : 'brand'}
      subtitle={lastResolved === null ? 'No quarter has resolved in this tab yet.' : `${lastResolved} is committed.`}
      actions={<Tag tone={resolving ? 'info' : blocked > 0 ? 'warn' : 'gain'} dot>{state}</Tag>}
    >
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Instructions" iconName="ledger" iconTone="brand" value={String(queued)} hint="Queued for this quarter" />
        <StatCard
          label="Blocked"
          iconName="warning"
          value={String(blocked)}
          tone={blocked > 0 ? 'loss' : undefined}
          iconTone={blocked > 0 ? 'loss' : 'neutral'}
          hint={blocked > 0 ? 'Submission is refused while any remain' : 'Nothing waits on a confirmation'}
        />
      </div>
      <div className="mt-3">
        <CashAfter company={company} spendUsd={netSpendUsd} label="Cash at the close" note="Cash on hand covers the quarter." />
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Before you submit                                                       */
/* -------------------------------------------------------------------------- */

export interface BeforeYouSubmitCardProps {
  readonly blocked: number;
  readonly rejected: number;
  readonly outflowUsd: number;
  readonly availableUsd: number;
  readonly afterUsd: number;
  /** The engine's own solvency sentence, or null when the balance stays above zero. */
  readonly solvencyLine: string | null;
}

/** Absent when there is nothing to say: a heading over nothing is worse than no heading. */
export function BeforeYouSubmitCard({
  blocked,
  rejected,
  outflowUsd,
  availableUsd,
  afterUsd,
  solvencyLine,
}: BeforeYouSubmitCardProps): React.JSX.Element | null {
  const overCommitted = outflowUsd > availableUsd;
  if (blocked === 0 && rejected === 0 && !overCommitted) return null;
  return (
    <Panel title="Before you submit" subtitle="Notes stuck to the desk, in the order they matter" iconName="warning" iconTone="warn">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {blocked > 0 ? (
          <StickyNote tone="loss" title="Needs your hand">
            {blocked} action{blocked === 1 ? '' : 's'} in the always-confirm set have not had an explicit human confirmation. The engine rejects
            those with the code <span className="figure">confirmation_required</span>, so the submission is refused here first.
          </StickyNote>
        ) : null}
        {rejected > 0 ? (
          <StickyNote tone="warn" lean="right" title="Will not run">
            {rejected} action{rejected === 1 ? '' : 's'} will not run at all. You can submit anyway — they are simply dropped in the
            action-collection phase — or remove them.
          </StickyNote>
        ) : null}
        {overCommitted ? (
          <StickyNote tone={afterUsd < 0 ? 'loss' : 'warn'} title="More than you hold">
            You have committed {formatMoney(outflowUsd)} against {formatMoney(availableUsd)} of cash. Nothing is refused for that: the quarter
            closes at {formatMoney(afterUsd)}
            {solvencyLine === null ? ' and the company stays solvent.' : `. ${solvencyLine}`}
          </StickyNote>
        ) : null}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  4. The seal                                                                */
/* -------------------------------------------------------------------------- */

export interface SealCardProps {
  readonly quarter: string;
  readonly nextQuarter: string;
  readonly canSubmit: boolean;
  readonly resolving: boolean;
  /** The live status line the engine emits while it works, or empty. */
  readonly status: string;
  readonly queued: number;
  readonly blocked: number;
  readonly outflowUsd: number;
  readonly availableUsd: number;
  readonly onArm: () => void;
}

export function SealCard({
  quarter,
  nextQuarter,
  canSubmit,
  resolving,
  status,
  queued,
  blocked,
  outflowUsd,
  availableUsd,
  onArm,
}: SealCardProps): React.JSX.Element {
  const overCommitted = outflowUsd > availableUsd;
  const share = availableUsd <= 0 ? 1 : outflowUsd / availableUsd;
  return (
    <Panel
      title="Lock the quarter"
      subtitle="The moment the world moves"
      iconName="stamp"
      iconTone={canSubmit ? 'brand' : 'neutral'}
      className={canSubmit ? 'border-brand/40' : undefined}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="scene-frame min-w-0 flex-1 bg-sky/50 px-3 py-3">
          <DeskScene className="mx-auto h-[84px] w-full max-w-[280px] sm:h-[96px]" />
        </div>

        {/* The seal is the desk's own control, from `sm` up. On a phone the
            commitment is `SealBar`, pinned above the tab bar — the same button,
            in thumb reach, opening the same gate. */}
        <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
          <SealStamp
            quarter={quarter}
            disabled={!canSubmit}
            busy={resolving}
            onPress={onArm}
            ariaLabel={`Resolve ${quarter} — opens a confirmation you must complete`}
          />
          <span className="label-caps-faint">Resolve quarter</span>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <ProgressBar
          label="Committed against cash"
          value={Math.min(outflowUsd, availableUsd)}
          max={Math.max(availableUsd, 1)}
          tone={overCommitted ? 'loss' : share > 0.6 ? 'warn' : 'brand'}
          valueLabel={`${formatMoney(outflowUsd)} / ${formatMoney(availableUsd)}`}
          height={8}
        />

        {resolving ? (
          <div className="rounded-card border border-brand/30 bg-brand-wash px-3 py-2.5">
            <div className="label-caps text-brand">Resolving</div>
            <p className="mt-1 text-[12.5px] text-ink">{status === '' ? 'Working' : status}</p>
          </div>
        ) : null}

        <p className="text-[11.5px] leading-relaxed text-ink-dim">
          {canSubmit
            ? `${quarter} closes and ${nextQuarter} opens. A quarter cannot resolve twice.`
            : `Confirm the ${blocked} blocked action${blocked === 1 ? '' : 's'} first, or remove them.`}
        </p>
        <p className="text-[10.5px] text-ink-faint">
          {queued} instruction{queued === 1 ? '' : 's'} · {formatPct(Math.min(share, 9.99))} of cash on hand committed
        </p>
      </div>
    </Panel>
  );
}

export interface SealBarProps {
  readonly quarter: string;
  readonly canSubmit: boolean;
  readonly resolving: boolean;
  readonly queued: number;
  readonly blocked: number;
  readonly onArm: () => void;
}

/**
 * The phone's commitment, pinned above the tab bar.
 *
 * Wired to exactly the same gate as the seal: it opens `ConfirmDialog`, the
 * dialog still requires the typed word, and a blocked action still refuses the
 * submission. The action-queue tray is gone, and the queue it used to carry is
 * the card above.
 *
 * The Chief of Staff dock is `fixed` over the bottom-left corner of every tab,
 * and two fixed elements never scroll clear of each other — so the caption goes
 * **above** the button (clear of the dock's 44px band) and the button row keeps
 * `DOCK_RESERVE_CLASS` to its left. Without that reserve the dock is drawn on
 * top of the left quarter of the one control the tab exists for, and a tap
 * there opens the Chief of Staff instead of the confirmation.
 */
export function SealBar({ quarter, canSubmit, resolving, queued, blocked, onArm }: SealBarProps): React.JSX.Element {
  return (
    <>
      <div
        className="sticky z-10 -mx-3 border-t border-hair bg-base/95 px-3 pt-2.5 pb-3 backdrop-blur sm:hidden"
        style={{ bottom: 'calc(var(--bottombar-height) + env(safe-area-inset-bottom, 0px))' }}
      >
        <p className="mb-1.5 text-center text-[10.5px] leading-relaxed text-ink-faint">
          {canSubmit
            ? `${queued} instruction${queued === 1 ? '' : 's'} · you type the word to confirm`
            : `${blocked} action${blocked === 1 ? '' : 's'} still need your confirmation`}
        </p>
        <div className="flex items-center gap-2">
          <span className={DOCK_RESERVE_CLASS} aria-hidden="true" />
          <button
            type="button"
            className="icon-knockout-brand btn btn-primary btn-lg press-pop min-w-0 flex-1"
            disabled={!canSubmit}
            onClick={onArm}
            aria-label={`Resolve ${quarter} — opens a confirmation you must complete`}
          >
            <Icon name="stamp" size={19} accent="inherit" />
            {resolving ? 'Resolving…' : `Resolve ${quarter}`}
          </button>
        </div>
      </div>
      {/* The scroll region's foot padding exceeds the bar's offset by this much,
          so the bar comes to rest exactly on the tab bar rather than above it. */}
      <div className="h-5 sm:hidden" aria-hidden="true" />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  6. Last quarter                                                            */
/* -------------------------------------------------------------------------- */

export interface LastQuarterCardProps {
  /** Null before a quarter has resolved in this tab. */
  readonly summary: {
    readonly quarter: string;
    readonly headline: string;
    readonly lines: number;
    readonly ledgerRows: number;
    readonly phasesRun: number;
    readonly invariantsPassed: number;
    readonly invariantsFailed: number;
    readonly committed: boolean;
  } | null;
}

export function LastQuarterCard({ summary }: LastQuarterCardProps): React.JSX.Element {
  return (
    <Panel
      title="Last quarter"
      iconName="newspaper"
      iconTone={summary !== null && !summary.committed ? 'loss' : 'neutral'}
      subtitle={summary === null ? 'The report prints when the first quarter closes.' : summary.headline}
      actions={
        summary === null ? undefined : (
          <Link href={sheetHref('resolution')} className="btn btn-ghost tap-target gap-1 px-2">
            Read the full report
            <Icon name="chevronRight" size={14} accent="current" />
          </Link>
        )
      }
    >
      {summary === null ? (
        <EmptyState
          compact
          icon="newspaper"
          title="No quarter has resolved in this tab yet"
          message="Queue your instructions and lock the quarter. The report that comes back is a rendering of the ledger, not a summary of it."
        />
      ) : (
        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Quarter', value: summary.quarter, mono: false },
            { label: 'Lines', value: formatCount(summary.lines), hint: 'Every one opens the rows behind it' },
            { label: 'Ledger rows', value: formatCount(summary.ledgerRows) },
            { label: 'Phases run', value: formatCount(summary.phasesRun) },
            {
              label: 'Invariants',
              value: `${summary.invariantsPassed} passed`,
              tone: summary.invariantsFailed > 0 ? 'loss' : 'gain',
              hint: summary.invariantsFailed > 0 ? `${summary.invariantsFailed} failed — the quarter did not commit` : 'The quarter committed',
              wide: true,
            },
          ]}
        />
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  7. How this quarter resolves                                               */
/* -------------------------------------------------------------------------- */

export interface PipelineCardProps {
  /** Whether a model is configured and turned on for this session. */
  readonly modelLine: string;
  /** Per-phase durations from the last resolution, or empty before one. */
  readonly timings: readonly EnginePhaseTiming[];
  readonly live: boolean;
}

/**
 * The pipeline, folded away.
 *
 * A founder never opens Play to read nineteen phase names, but the order is the
 * whole of the game's causality and is worth being able to check. The count is
 * read from `RESOLUTION_PHASES` rather than written out, so it cannot go stale
 * the way "eighteen phases" did when the node market became a phase of its own.
 */
export function PipelineCard({ modelLine, timings, live }: PipelineCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="How this quarter resolves"
      iconName="globe"
      iconTone="info"
      subtitle={`${RESOLUTION_PHASES.length} phases, in the order that makes causality work.`}
      actions={
        <button type="button" className="btn btn-ghost tap-target gap-1 px-2" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide the pipeline' : 'Show the pipeline'}
          <Icon name="chevronDown" size={14} accent="current" className={open ? 'rotate-180' : undefined} />
        </button>
      }
    >
      <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-ink-dim">
        <span className={cx('mt-1.5 inline-block size-1.5 shrink-0 rounded-pill', live ? 'bg-gain' : 'bg-ink-faint')} />
        {modelLine}
      </p>
      <p className="mt-1.5 text-[10px] text-ink-faint">
        Either way the resolution is deterministic: same state, same recorded decisions, same seed, same outcome.
      </p>

      {open ? (
        <ol className="mt-3 flex flex-col gap-0.5 border-t border-hair pt-2.5">
          {RESOLUTION_PHASES.map((phase, index) => {
            const timing = timings.find((entry) => entry.phase === phase) ?? null;
            return (
              <li key={phase} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="truncate text-ink-faint">
                  <span className="figure mr-1.5 text-[10px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  {titleise(phase)}
                </span>
                <span className="figure shrink-0 text-[10px] text-ink-faint">
                  {timing === null ? '—' : `${formatCount(timing.durationMs)}ms · ${timing.eventsEmitted}`}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Panel>
  );
}

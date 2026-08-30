'use client';

/**
 * End Quarter — the signing desk.
 *
 * Everything queued, grouped by the resolution phase that will consume it, each
 * carrying the validator's answer: accepted, clamped into the reduced form that
 * will actually run, or rejected with its reason and code. A board matter is
 * shown as what it is — a matter that will be tabled — not as a failure.
 *
 * The screen exists to make one thing impossible: submitting a quarter you have
 * not read. Cash is projected against the whole submitted set, so a player sees
 * they have committed more than they hold before the engine tells them, and any
 * action in the always-confirm set that has not had a human click blocks the
 * submission outright.
 *
 * The desk is presentation over exactly that: instructions are documents you
 * leaf through, the things standing in your way are notes stuck to the desk,
 * and the submission is a seal you press. The gate is unchanged — the seal
 * opens `ConfirmDialog`, the dialog still requires the typed word, and a
 * blocked action still refuses the whole submission.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ResolutionPhase } from '@frontier/contracts';
import { RESOLUTION_PHASES, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import {
  ConfirmDialog,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Tag,
  ValidationBanner,
  cx,
  labelOfStatus,
  toneOfStatus,
} from '@/components/ui';
import { cashEffectOf, describeIntent, phaseOfIntent, titleise } from '@/components/screens/end-quarter/intents';
import { DeskScene, PaperSheet, SealStamp, StickyNote } from '@/components/screens/end-quarter/desk';
import {
  useGameActions,
  useLlm,
  useOutcome,
  usePlayerCompany,
  useQueuedActions,
  useResolving,
  useSession,
  useSettings,
} from '@/lib/game';

export default function EndQuarterPage(): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const company = usePlayerCompany();
  const queue = useQueuedActions();
  const llm = useLlm();
  const settings = useSettings();
  const outcome = useOutcome();
  const { resolving, status } = useResolving();
  const { confirmAction, unqueueAction, clearQueue, endQuarter } = useGameActions();

  const [arming, setArming] = useState(false);

  // The floating action-queue tray is on screen whenever something is queued,
  // which on this screen is nearly always. The commitment bar lifts above it.
  const trayLifted = queue.length > 0 && !resolving;

  const blocked = queue.filter((entry) => entry.blocked);
  const rejected = queue.filter((entry) => entry.validation.status === 'rejected');
  const clamped = queue.filter((entry) => entry.validation.status === 'clamped');
  const boardMatters = clamped.filter((entry) => entry.validation.clampedAction?.type === 'submit_board_proposal');

  /* --- cash ---------------------------------------------------------------- */

  const cash = useMemo(() => {
    let outflow = 0;
    let inflow = 0;
    const lines: { readonly key: string; readonly label: string; readonly outflow: number; readonly inflow: number; readonly note: string | null }[] = [];
    for (const entry of queue) {
      if (entry.validation.status === 'rejected') continue;
      const intent = entry.validation.clampedAction ?? entry.action.intent;
      const effect = cashEffectOf(session, intent);
      outflow += effect.outflowUsd;
      inflow += effect.inflowUsd;
      if (effect.outflowUsd === 0 && effect.inflowUsd === 0) continue;
      lines.push({
        key: entry.action.actionId,
        label: describeIntent(intent, session.startYear).label,
        outflow: effect.outflowUsd,
        inflow: effect.inflowUsd,
        note: effect.note,
      });
    }
    return { outflow, inflow, lines };
  }, [queue, session]);

  const available = company.financials.cash;
  const committedShare = available <= 0 ? 1 : cash.outflow / available;
  const overCommitted = cash.outflow > available;

  /* --- grouping ------------------------------------------------------------ */

  const groups = useMemo(() => {
    const map = new Map<ResolutionPhase, typeof queue>();
    for (const entry of queue) {
      const phase = phaseOfIntent(entry.validation.clampedAction ?? entry.action.intent);
      const list = map.get(phase) ?? [];
      list.push(entry);
      map.set(phase, list);
    }
    return RESOLUTION_PHASES.filter((phase) => map.has(phase)).map((phase) => ({ phase, entries: map.get(phase) ?? [] }));
  }, [queue]);

  const timings = outcome?.phaseTimings ?? [];
  const canSubmit = blocked.length === 0 && !resolving;

  /**
   * The arming state and the navigation are settled on every path.
   *
   * `endQuarter` resolves to false when the engine threw on both attempts: the
   * quarter is still open, there is no report to read, and the player stays here
   * with the notice and their queue rather than being sent to an empty screen.
   */
  async function resolve(): Promise<void> {
    setArming(false);
    let resolved = false;
    try {
      resolved = await endQuarter();
    } finally {
      if (resolved) router.push('/quarter-resolution');
    }
  }

  return (
    <>
      <PageHeader
        title="End Quarter"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Every instruction you have queued, grouped by the phase that will consume it, with the engine's answer already attached."
        actions={
          queue.length === 0 ? null : (
            <button type="button" className="btn btn-sm tap-target" onClick={clearQueue} disabled={resolving}>
              Clear the queue
            </button>
          )
        }
      />

      {/* Two up on a phone: four readings a thumb can take in at a glance. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Queued"
          iconName="ledger"
          iconTone="brand"
          value={String(queue.length)}
          hint={`${clamped.length} clamped · ${rejected.length} rejected`}
        />
        <StatCard
          label="Blocked"
          iconName="warning"
          value={String(blocked.length)}
          tone={blocked.length > 0 ? 'loss' : undefined}
          iconTone={blocked.length > 0 ? 'loss' : 'neutral'}
          hint={blocked.length > 0 ? 'Submission is refused while any remain' : 'Nothing waits on a confirmation'}
        />
        <StatCard
          label="Committed"
          iconName="coins"
          iconTone={overCommitted ? 'loss' : 'warn'}
          value={formatMoney(cash.outflow)}
          tone={overCommitted ? 'loss' : undefined}
          hint={`${formatPct(Math.min(committedShare, 9.99))} of ${formatMoney(available)} on hand`}
        />
        <StatCard
          label="Sought"
          iconName="coins"
          iconTone="gain"
          value={formatMoney(cash.inflow)}
          hint="Attempts, not receipts: the market decides"
        />
      </div>

      {/* --- notes stuck to the desk ---------------------------------------- */}
      {blocked.length > 0 || rejected.length > 0 || overCommitted ? (
        <Panel title="Before you submit" subtitle="Notes stuck to the desk, in the order they matter" iconName="warning" iconTone="warn">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {blocked.length > 0 ? (
              <StickyNote tone="loss" title="Needs your hand">
                {blocked.length} action{blocked.length === 1 ? '' : 's'} in the always-confirm set have not had an explicit human
                confirmation. The engine rejects those with the code <span className="figure">confirmation_required</span>, so the
                submission is refused here first.
              </StickyNote>
            ) : null}
            {rejected.length > 0 ? (
              <StickyNote tone="warn" lean="right" title="Will not run">
                {rejected.length} action{rejected.length === 1 ? '' : 's'} will not run at all. You can submit anyway — they are simply
                dropped in the action-collection phase — or remove them.
              </StickyNote>
            ) : null}
            {overCommitted ? (
              <StickyNote tone="loss" title="More than you hold">
                You have committed {formatMoney(cash.outflow)} against {formatMoney(available)} of cash. The validator clamps what it can;
                what it cannot, the financial phase will.
              </StickyNote>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- the documents ------------------------------------------------ */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {queue.length === 0 ? (
            <Panel>
              <EmptyState
                icon="stamp"
                title="Nothing queued for this quarter"
                message="A quarter with no instructions is legal and sometimes correct: the world still moves, rivals still act, and your company still trades. But you probably meant to do something."
                action={
                  <Link href="/command-centre" className="btn btn-sm tap-target">
                    Back to the command centre
                  </Link>
                }
              />
            </Panel>
          ) : (
            groups.map((group, groupIndex) => (
              <Panel
                key={group.phase}
                title={titleise(group.phase)}
                subtitle={`${group.entries.length} instruction${group.entries.length === 1 ? '' : 's'} consumed in this phase`}
                iconName="ledger"
                iconTone="brand"
                bodyClassName="bg-raised/50"
              >
                <ul className="flex flex-col gap-2.5">
                  {group.entries.map((entry, entryIndex) => {
                    const effective = entry.validation.clampedAction ?? entry.action.intent;
                    const description = describeIntent(effective, session.startYear);
                    const isBoardMatter = entry.validation.clampedAction?.type === 'submit_board_proposal';
                    const verdict = toneOfStatus(entry.validation.status);
                    return (
                      <li key={entry.action.actionId}>
                        <PaperSheet
                          tone={entry.blocked ? 'loss' : verdict}
                          style={{ animationDelay: `${Math.min(groupIndex * 90 + entryIndex * 45, 640)}ms` }}
                        >
                          <div className="px-3 py-2.5">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-[12.5px] font-semibold text-ink">{description.label}</p>
                                <p className="mt-0.5 text-[10px] text-ink-faint">
                                  {entry.action.origin === 'chief_of_staff' ? 'Interpreted by the Chief of Staff' : 'Entered by hand'} · sequence{' '}
                                  {entry.action.sequence}
                                </p>
                                {description.terms.length === 0 ? null : (
                                  <dl className="mt-2 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                                    {description.terms.map((term) => (
                                      <div key={term.label} className="flex items-baseline justify-between gap-2 border-b border-dashed border-hair pb-0.5">
                                        <dt className="label-caps-faint shrink-0">{term.label}</dt>
                                        <dd className="figure truncate text-[11px] text-ink">{term.value}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1.5">
                                <Tag tone={verdict} dot>
                                  {isBoardMatter ? 'To the board' : labelOfStatus(entry.validation.status)}
                                </Tag>
                                <div className="flex items-center gap-1.5">
                                  {entry.blocked ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm tap-target"
                                      onClick={() => confirmAction(entry.action.actionId)}
                                    >
                                      Confirm
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm tap-target"
                                    onClick={() => unqueueAction(entry.action.actionId)}
                                    aria-label={`Remove ${description.label}`}
                                  >
                                    <Icon name="close" size={15} accent="current" />
                                  </button>
                                </div>
                              </div>
                            </div>

                            {entry.blocked ? (
                              <p className="mt-2 text-[10px] text-loss">
                                Blocked: this type always requires an explicit human confirmation, whatever your automation preference says.
                              </p>
                            ) : null}

                            {entry.validation.status === 'accepted' ? null : (
                              <div className="mt-2">
                                <ValidationBanner result={entry.validation} />
                              </div>
                            )}
                          </div>
                        </PaperSheet>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ))
          )}
        </div>

        {/* --- the right rail ------------------------------------------------ */}
        {/* `min-w-0`: without it this column's min-content width widens the
            implicit grid track and the page scrolls sideways at 390px. */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Cash impact" subtitle="Estimated from the validator's affordability model" iconName="coins" iconTone="warn">
            <ProgressBar
              label="Committed against cash on hand"
              value={Math.min(cash.outflow, available)}
              max={Math.max(available, 1)}
              tone={overCommitted ? 'loss' : committedShare > 0.6 ? 'warn' : 'brand'}
              valueLabel={`${formatMoney(cash.outflow)} / ${formatMoney(available)}`}
              height={8}
            />
            {cash.lines.length === 0 ? (
              <p className="mt-3 text-[11px] text-ink-faint">Nothing queued moves cash this quarter.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-1.5">
                {cash.lines.map((line) => (
                  <li key={line.key}>
                    <div className="flex items-baseline justify-between gap-3 text-[11px]">
                      <span className="min-w-0 truncate text-ink-dim">{line.label}</span>
                      <span className={cx('figure shrink-0', line.inflow > 0 ? 'tone-gain' : 'tone-loss')}>
                        {line.inflow > 0 ? `+${formatMoney(line.inflow)}` : `-${formatMoney(line.outflow)}`}
                      </span>
                    </div>
                    {line.note === null ? null : <p className="text-[10px] text-ink-faint">{line.note}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2.5 text-[10px] leading-relaxed text-ink-faint">
              These are affordability heuristics, not the economy. The subsystem that resolves each action owns the real cost model and may
              charge more or less.
            </p>
          </Panel>

          <Panel title="Board matters" subtitle="Clamped, not refused" iconName="boardTable" iconTone="info">
            {boardMatters.length === 0 ? (
              <p className="text-[11px] text-ink-faint">
                Nothing you have queued needs the board's morning. Financing, listing, M&amp;A, buybacks, major awards and large
                restructurings do.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {boardMatters.map((entry) => {
                  const tabled = entry.validation.clampedAction;
                  return (
                    <li key={entry.action.actionId} className="raised-surface px-2.5 py-2">
                      <p className="text-[11px] text-ink">
                        {tabled !== null && tabled.type === 'submit_board_proposal' ? tabled.title : 'A board matter'}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-faint">
                        Your instruction is not lost. It goes to the board first, and you have to win the vote.
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            <Link href="/boardroom" className="btn btn-sm tap-target mt-2.5 w-full">
              Open the boardroom
            </Link>
          </Panel>

          <Panel title="How this quarter resolves" subtitle="What is driving the world and your rivals" iconName="globe" iconTone="info">
            <div className="flex flex-col gap-2 text-[11px] leading-relaxed text-ink-dim">
              <p className="flex items-start gap-2">
                <span className={cx('mt-1.5 inline-block size-1.5 shrink-0 rounded-pill', llm.available ? 'bg-gain' : 'bg-ink-faint')} />
                {llm.available && settings.useLiveModel
                  ? `The World Director and the major rivals' strategists run on ${llm.model ?? llm.transportKind}. Their output is a proposal: the engine bounds-checks every modifier and validates every NPC action with the same rules as yours.`
                  : llm.available
                    ? 'A model is configured but you have turned it off for this session. World events fire on their deterministic templates and rivals run their archetype defaults.'
                    : 'No model is configured. World events fire on their deterministic templates and rivals run their archetype defaults — the game plays in full either way.'}
              </p>
              <p className="text-[10px] text-ink-faint">
                Either way the resolution is deterministic: same state, same recorded decisions, same seed, same outcome.
              </p>
            </div>
          </Panel>

          <Panel
            title="The pipeline"
            subtitle="Eighteen phases, in the order that makes causality work"
            iconName="network"
            iconTone="neutral"
          >
            <ol className="flex flex-col gap-0.5">
              {RESOLUTION_PHASES.map((phase, index) => {
                const timing = timings.find((entry) => entry.phase === phase) ?? null;
                const active = resolving;
                return (
                  <li key={phase} className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className={cx('truncate', active ? 'text-ink-dim' : 'text-ink-faint')}>
                      <span className="figure mr-1.5 text-[10px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                      {titleise(phase)}
                    </span>
                    <span className="figure shrink-0 text-[10px] text-ink-faint">
                      {timing === null ? '—' : `${timing.durationMs.toFixed(1)}ms · ${timing.eventsEmitted}`}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              {timings.length === 0
                ? 'Timings appear after the first quarter resolves. They are diagnostics only and never an input to the simulation.'
                : 'Duration and events emitted, from the last resolution. Diagnostics only.'}
            </p>
          </Panel>
        </div>
      </div>

      {/* --- the commitment ------------------------------------------------- */}
      <Panel
        title="Lock the quarter"
        subtitle="The moment the world moves"
        iconName="stamp"
        iconTone={canSubmit ? 'brand' : 'neutral'}
        className={cx(canSubmit ? 'border-brand/40' : '')}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* the desk */}
          <div className="scene-frame min-w-0 flex-1 bg-sky/50 px-3 py-3">
            <DeskScene className="mx-auto h-[84px] w-full max-w-[280px] sm:h-[96px]" />
          </div>

          {/* The seal is the desk's own control, from `sm` up. On a phone the
              commitment is the bar pinned to the bottom of the viewport — the
              same button, in thumb reach, opening the same gate. */}
          <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
            <SealStamp
              quarter={quarterLabel(session.startYear, session.quarter)}
              disabled={!canSubmit}
              busy={resolving}
              onPress={() => setArming(true)}
              ariaLabel={`Resolve ${quarterLabel(session.startYear, session.quarter)} — opens a confirmation you must complete`}
            />
            <span className="label-caps-faint">Resolve quarter</span>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
            <SubmitReading label="Instructions" value={String(queue.length)} />
            <SubmitReading label="Blocked" value={String(blocked.length)} tone={blocked.length > 0 ? 'loss' : undefined} />
            <SubmitReading
              label="Cash committed"
              value={formatMoney(cash.outflow)}
              tone={overCommitted ? 'loss' : undefined}
              className="col-span-2 sm:col-span-1"
            />
          </div>

          {resolving ? (
            <div className="rounded-card border border-brand/30 bg-brand-wash px-3 py-2.5">
              <div className="label-caps text-brand">Resolving</div>
              <p className="mt-1 text-[12.5px] text-ink">{status === '' ? 'Working' : status}</p>
            </div>
          ) : null}

          <p className="text-[11.5px] leading-relaxed text-ink-dim">
            {canSubmit
              ? `${quarterLabel(session.startYear, session.quarter)} closes and ${quarterLabel(session.startYear, session.quarter + 1)} opens. A quarter cannot resolve twice.`
              : 'Confirm the blocked actions first, or remove them.'}
          </p>
        </div>
      </Panel>

      {/* --- the phone's commitment ---------------------------------------
          Pinned above the tab bar, clear of the floating action queue, and
          wired to exactly the same gate as the seal: it opens `ConfirmDialog`,
          which still requires the typed word, and a blocked action still
          refuses the submission. */}
      <div
        className="sticky z-10 -mx-3 border-t border-hair bg-base/95 px-3 pt-2.5 pb-3 backdrop-blur sm:hidden"
        style={{ bottom: 'calc(var(--bottombar-height) + env(safe-area-inset-bottom, 0px))' }}
      >
        <button
          type="button"
          className="icon-knockout-brand btn btn-primary btn-lg press-pop w-full"
          disabled={!canSubmit}
          onClick={() => setArming(true)}
          aria-label={`Resolve ${quarterLabel(session.startYear, session.quarter)} — opens a confirmation you must complete`}
        >
          <Icon name="stamp" size={19} accent="inherit" />
          {resolving ? 'Resolving…' : `Resolve ${quarterLabel(session.startYear, session.quarter)}`}
        </button>
        <p className="mt-1.5 text-center text-[10.5px] leading-relaxed text-ink-faint">
          {canSubmit
            ? `${queue.length} instruction${queue.length === 1 ? '' : 's'} · you type the word to confirm`
            : `${blocked.length} action${blocked.length === 1 ? '' : 's'} still need your confirmation`}
        </p>

        {/* Room under the bar for the floating action queue, which is on screen
            whenever something is queued. The bar keeps the bottom edge; the
            tray floats over its surface instead of over the button. */}
        {trayLifted ? <div className="h-14" aria-hidden="true" /> : null}
      </div>

      {/* The scroll region's foot padding exceeds the bar's offset by this
          much, so the bar comes to rest exactly on the tab bar rather than a
          little above it. */}
      <div className="h-5 sm:hidden" aria-hidden="true" />

      <ConfirmDialog
        open={arming}
        title="Resolve the quarter"
        body="This submits every queued instruction, runs all eighteen phases and commits the ledger. It cannot be taken back: a quarter resolves once."
        terms={[
          { label: 'Quarter', value: quarterLabel(session.startYear, session.quarter) },
          { label: 'Instructions', value: String(queue.length) },
          { label: 'Cash committed', value: formatMoney(cash.outflow), emphasis: overCommitted },
          { label: 'Cash sought', value: formatMoney(cash.inflow) },
          { label: 'World and rivals', value: llm.available && settings.useLiveModel ? 'Model-directed' : 'Deterministic' },
        ]}
        requireTyped="RESOLVE"
        confirmLabel="Resolve"
        busy={resolving}
        onCancel={() => setArming(false)}
        onConfirm={() => void resolve()}
      />
    </>
  );
}

function SubmitReading({
  label,
  value,
  tone,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'loss';
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div className={cx('raised-surface px-3 py-2', className)}>
      <div className="label-caps-faint">{label}</div>
      {/* The key replays the arrival animation whenever the reading changes. */}
      <div
        key={value}
        className={cx('figure animate-count-up mt-0.5 text-[19px] leading-none font-semibold', tone === 'loss' ? 'tone-loss' : 'text-ink')}
      >
        {value}
      </div>
    </div>
  );
}

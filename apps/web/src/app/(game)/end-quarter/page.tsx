'use client';

/**
 * End Quarter — the lock screen.
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

  async function resolve(): Promise<void> {
    setArming(false);
    await endQuarter();
    router.push('/quarter-resolution');
  }

  return (
    <>
      <PageHeader
        title="End Quarter"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Every instruction you have queued, grouped by the phase that will consume it, with the engine's answer already attached."
        actions={
          queue.length === 0 ? null : (
            <button type="button" className="btn btn-sm" onClick={clearQueue} disabled={resolving}>
              Clear the queue
            </button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Queued" value={String(queue.length)} hint={`${clamped.length} clamped · ${rejected.length} rejected`} />
        <StatCard
          label="Blocked"
          value={String(blocked.length)}
          tone={blocked.length > 0 ? 'loss' : undefined}
          hint={blocked.length > 0 ? 'Submission is refused while any remain' : 'Nothing is waiting on a confirmation'}
        />
        <StatCard
          label="Cash committed"
          value={formatMoney(cash.outflow)}
          tone={overCommitted ? 'loss' : undefined}
          hint={`${formatPct(Math.min(committedShare, 9.99))} of ${formatMoney(available)} on hand`}
        />
        <StatCard label="Cash sought" value={formatMoney(cash.inflow)} hint="Attempts, not receipts: the market decides" />
      </div>

      {blocked.length > 0 || rejected.length > 0 || overCommitted ? (
        <Panel title="Before you submit">
          <ul className="flex flex-col gap-2">
            {blocked.length > 0 ? (
              <li className="rounded-[4px] border border-loss/25 bg-loss-wash px-3 py-2 text-[11px] text-loss">
                {blocked.length} action{blocked.length === 1 ? '' : 's'} in the always-confirm set have not had an explicit human
                confirmation. The engine rejects those with the code <span className="figure">confirmation_required</span>, so the
                submission is refused here first.
              </li>
            ) : null}
            {rejected.length > 0 ? (
              <li className="rounded-[4px] border border-warn/25 bg-warn-wash px-3 py-2 text-[11px] text-warn">
                {rejected.length} action{rejected.length === 1 ? '' : 's'} will not run at all. You can submit anyway — they are simply
                dropped in the action-collection phase — or remove them.
              </li>
            ) : null}
            {overCommitted ? (
              <li className="rounded-[4px] border border-loss/25 bg-loss-wash px-3 py-2 text-[11px] text-loss">
                You have committed {formatMoney(cash.outflow)} against {formatMoney(available)} of cash. The validator clamps what it can;
                what it cannot, the financial phase will.
              </li>
            ) : null}
          </ul>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- the queue --------------------------------------------------- */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {queue.length === 0 ? (
            <Panel>
              <EmptyState
                glyph="EQ"
                title="Nothing queued for this quarter"
                message="A quarter with no instructions is legal and sometimes correct: the world still moves, rivals still act, and your company still trades. But you probably meant to do something."
                action={
                  <Link href="/command-centre" className="btn btn-sm">
                    Back to the command centre
                  </Link>
                }
              />
            </Panel>
          ) : (
            groups.map((group) => (
              <Panel
                key={group.phase}
                title={titleise(group.phase)}
                subtitle={`${group.entries.length} instruction${group.entries.length === 1 ? '' : 's'} consumed in this phase`}
              >
                <ul className="flex flex-col gap-2">
                  {group.entries.map((entry) => {
                    const effective = entry.validation.clampedAction ?? entry.action.intent;
                    const description = describeIntent(effective, session.startYear);
                    const isBoardMatter = entry.validation.clampedAction?.type === 'submit_board_proposal';
                    return (
                      <li
                        key={entry.action.actionId}
                        className={cx(
                          'raised-surface px-3 py-2.5',
                          entry.blocked ? 'border-loss/40' : entry.validation.status === 'rejected' ? 'border-loss/25' : '',
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-medium text-ink">{description.label}</p>
                            <p className="mt-0.5 text-[10px] text-ink-faint">
                              {entry.action.origin === 'chief_of_staff' ? 'Interpreted by the Chief of Staff' : 'Entered by hand'} · sequence{' '}
                              {entry.action.sequence}
                            </p>
                            {description.terms.length === 0 ? null : (
                              <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                                {description.terms.map((term) => (
                                  <div key={term.label} className="flex items-baseline justify-between gap-2 border-b border-hair/60 pb-0.5">
                                    <dt className="label-caps-faint shrink-0">{term.label}</dt>
                                    <dd className="figure truncate text-[11px] text-ink">{term.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <Tag tone={toneOfStatus(entry.validation.status)} dot>
                              {isBoardMatter ? 'To the board' : labelOfStatus(entry.validation.status)}
                            </Tag>
                            <div className="flex items-center gap-1.5">
                              {entry.blocked ? (
                                <button type="button" className="btn btn-sm" onClick={() => confirmAction(entry.action.actionId)}>
                                  Confirm
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => unqueueAction(entry.action.actionId)}
                                aria-label={`Remove ${description.label}`}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>

                        {entry.blocked ? (
                          <p className="mt-1.5 text-[10px] text-loss">
                            Blocked: this type always requires an explicit human confirmation, whatever your automation preference says.
                          </p>
                        ) : null}

                        {entry.validation.status === 'accepted' ? null : (
                          <div className="mt-2">
                            <ValidationBanner result={entry.validation} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ))
          )}
        </div>

        {/* --- the right rail ------------------------------------------------ */}
        <div className="flex flex-col gap-4">
          <Panel title="Cash impact" subtitle="Estimated from the validator's affordability model">
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

          <Panel title="Board matters" subtitle="Clamped, not refused">
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
            <Link href="/boardroom" className="btn btn-sm mt-2.5 w-full">
              Open the boardroom
            </Link>
          </Panel>

          <Panel title="How this quarter resolves" subtitle="What is driving the world and your rivals">
            <div className="flex flex-col gap-2 text-[11px] leading-relaxed text-ink-dim">
              <p className="flex items-start gap-2">
                <span className={cx('mt-1.5 inline-block size-1.5 shrink-0 rounded-full', llm.available ? 'bg-gain' : 'bg-ink-faint')} />
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

          <Panel title="The pipeline" subtitle="Eighteen phases, in the order that makes causality work">
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
        className={cx(canSubmit ? 'border-brand/40' : '')}
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <SubmitReading label="Instructions" value={String(queue.length)} />
            <SubmitReading label="Blocked" value={String(blocked.length)} tone={blocked.length > 0 ? 'loss' : undefined} />
            <SubmitReading label="Cash committed" value={formatMoney(cash.outflow)} tone={overCommitted ? 'loss' : undefined} />
          </div>

          {resolving ? (
            <div className="rounded-[4px] border border-brand/30 bg-brand-wash px-3 py-2.5">
              <div className="label-caps text-brand">Resolving</div>
              <p className="mt-1 text-[12px] text-ink">{status === '' ? 'Working' : status}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit}
              onClick={() => setArming(true)}
              style={{ letterSpacing: '0.08em' }}
            >
              RESOLVE QUARTER
            </button>
            <span className="text-[11px] text-ink-dim">
              {canSubmit
                ? `${quarterLabel(session.startYear, session.quarter)} closes and ${quarterLabel(session.startYear, session.quarter + 1)} opens. A quarter cannot resolve twice.`
                : 'Confirm the blocked actions first, or remove them.'}
            </span>
          </div>
        </div>
      </Panel>

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
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'loss';
}): React.JSX.Element {
  return (
    <div className="raised-surface px-3 py-2">
      <div className="label-caps-faint">{label}</div>
      <div className={cx('figure mt-0.5 text-[19px] leading-none', tone === 'loss' ? 'tone-loss' : 'text-ink')}>{value}</div>
    </div>
  );
}

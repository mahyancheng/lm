'use client';

/**
 * The queue — everything you have told the company to do, grouped by the phase
 * that will consume it.
 *
 * This card absorbs the floating action-queue tray entirely. The tray listed
 * the queue, confirmed a row, removed a row, cleared the lot and offered a
 * review link, and it did all of it over the top of whatever screen the founder
 * was on. Play is one tap and one badge from every tab, so the list lives here
 * once, at full width, with the validator's answer on every row.
 *
 * Three rules the rows keep, all of them the engine's:
 *
 * - A **board matter** is shown as what it is — clamped and tabled — not as a
 *   failure. It is the one clamp that means "you have to win a vote".
 * - A **blocked** row is one of the always-confirm set with no human click on
 *   it yet. The submission is refused while any remain, so the row carries the
 *   confirm control itself rather than sending the founder somewhere.
 * - A **rejected** row still submits: it is dropped in the action-collection
 *   phase. Saying so is more honest than hiding the row.
 */

import type { ResolutionPhase } from '@frontier/contracts';
import { RESOLUTION_PHASES } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { EmptyState, Icon, Panel, Tag, ValidationBanner, cx, hasAdvisory, labelOfStatus, toneOfStatus } from '@/components/ui';
import { describeIntent, phaseOfIntent, titleise } from '@/components/screens/end-quarter/intents';
import { PaperSheet } from '@/components/screens/end-quarter/desk';
import type { CompanyQueueGroup } from '@/components/screens/end-quarter/companyGrouping';
import type { QueuedActionEntry } from '@/lib/game';

export interface PhaseGroup {
  readonly phase: ResolutionPhase;
  readonly entries: readonly QueuedActionEntry[];
}

/**
 * The queue folded by the phase that will consume each instruction, in pipeline
 * order, with an empty phase simply absent.
 *
 * The phase is read off the *reduced* form where there is one: a clamped action
 * runs as what it was clamped to, and grouping it by what was asked for would
 * put it under a heading it never reaches.
 */
export function groupQueueByPhase(queue: readonly QueuedActionEntry[]): PhaseGroup[] {
  const map = new Map<ResolutionPhase, QueuedActionEntry[]>();
  for (const entry of queue) {
    const phase = phaseOfIntent(entry.validation.clampedAction ?? entry.action.intent);
    const list = map.get(phase) ?? [];
    list.push(entry);
    map.set(phase, list);
  }
  return RESOLUTION_PHASES.filter((phase) => map.has(phase)).map((phase) => ({ phase, entries: map.get(phase) ?? [] }));
}

export interface QueueCardProps {
  /** The queue folded by resolution phase, in pipeline order. */
  readonly groups: readonly PhaseGroup[];
  readonly queued: number;
  readonly startYear: number;
  /** True while a quarter is resolving: every control on the card is dead. */
  readonly resolving: boolean;
  /**
   * One row per company that has something queued, shown only when more than
   * one has — cash is never pooled, and a group's second company closes on its
   * own balance sheet.
   */
  readonly companyGroups: readonly CompanyQueueGroup[];
  /** Name the company on a row, once more than one company is committing. */
  readonly companyNameOf: (companyId: string) => string;
  readonly onConfirm: (actionId: string) => void;
  readonly onRemove: (actionId: string) => void;
  readonly onClear: () => void;
}

export function QueueCard({
  groups,
  queued,
  startYear,
  resolving,
  companyGroups,
  companyNameOf,
  onConfirm,
  onRemove,
  onClear,
}: QueueCardProps): React.JSX.Element {
  const multiCompany = companyGroups.length > 1;
  return (
    <Panel
      title="Queued instructions"
      iconName="ledger"
      iconTone={queued === 0 ? 'neutral' : 'brand'}
      subtitle={queued === 0 ? 'Nothing waiting for this quarter.' : `${queued} instruction${queued === 1 ? '' : 's'}, in the order they will run.`}
      actions={
        queued === 0 ? undefined : (
          <button type="button" className="btn btn-ghost tap-target px-2" onClick={onClear} disabled={resolving}>
            Clear all
          </button>
        )
      }
    >
      {queued === 0 ? (
        <EmptyState
          compact
          icon="stamp"
          title="Nothing queued for this quarter"
          message="A quarter with no instructions is legal and sometimes correct: the world still moves, rivals still act, and your company still trades. But you probably meant to do something."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.phase}>
              <div className="flex items-baseline justify-between gap-2 border-b border-hair pb-1">
                <span className="label-caps truncate">{titleise(group.phase)}</span>
                <span className="figure shrink-0 text-[10px] text-ink-faint">
                  {group.entries.length} instruction{group.entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {group.entries.map((entry) => {
                  const effective = entry.validation.clampedAction ?? entry.action.intent;
                  const description = describeIntent(effective, startYear);
                  const isBoardMatter = entry.validation.clampedAction?.type === 'submit_board_proposal';
                  const verdict = toneOfStatus(entry.validation.status);
                  return (
                    <li key={entry.action.actionId}>
                      <PaperSheet tone={entry.blocked ? 'loss' : verdict}>
                        <div className="px-3 py-2.5">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-[12.5px] leading-snug font-semibold text-ink">{description.label}</p>
                              <p className="mt-0.5 text-[10px] text-ink-faint">
                                {entry.action.origin === 'chief_of_staff' ? 'Interpreted by the Chief of Staff' : 'Entered by hand'}
                                {multiCompany ? ` · ${companyNameOf(entry.action.actorCompanyId)}` : ''}
                              </p>
                              {description.terms.length === 0 ? null : (
                                <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
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
                                    disabled={resolving}
                                    onClick={() => onConfirm(entry.action.actionId)}
                                  >
                                    Confirm
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm tap-target"
                                  disabled={resolving}
                                  onClick={() => onRemove(entry.action.actionId)}
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

                          {entry.validation.status === 'accepted' && !hasAdvisory(entry.validation) ? null : (
                            <div className="mt-2">
                              <ValidationBanner result={entry.validation} compact />
                            </div>
                          )}
                        </div>
                      </PaperSheet>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {/* Cash is never pooled: each company you queued for closes on its own
              balance sheet, and that is only worth saying once more than one has
              something queued. */}
          {multiCompany ? (
            <div className="border-t border-hair pt-3">
              <div className="label-caps">By company</div>
              <ul className="mt-2 flex flex-col gap-2">
                {companyGroups.map((group) => (
                  <li key={group.company.id} className="raised-surface px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{group.company.name}</span>
                      <span className="figure shrink-0 text-[10px] text-ink-faint">
                        {group.entries.length} instruction{group.entries.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-ink-dim">Committed</span>
                      <span className={cx('figure', group.outflowUsd > group.availableUsd ? 'tone-loss' : 'text-ink')}>
                        {formatMoney(group.outflowUsd)} / {formatMoney(group.availableUsd)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-ink-dim">Cash at the close</span>
                      <span className={cx('figure', group.afterUsd < 0 ? 'tone-loss' : 'text-ink')}>{formatMoney(group.afterUsd)}</span>
                    </div>
                    {group.solvencyLine === null ? null : <p className="mt-1 text-[10px] text-warn">{group.solvencyLine}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

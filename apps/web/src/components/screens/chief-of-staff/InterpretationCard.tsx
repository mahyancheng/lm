'use client';

/**
 * The interpretation, rendered as a control surface rather than a chat bubble.
 *
 * The contract is three steps in this order and no shortcuts: **interpret →
 * propose → confirm.** What the model produced is a set of typed
 * `ActionIntent`s, so the card shows them as rows — the instruction, its terms,
 * and what the validator says about it *before* anything is queued. The
 * mandatory line sits above the controls, and the fourteen always go through
 * `ConfirmDialog` regardless of what the model set `requiresConfirmation` to.
 *
 * Below confidence 0.7 the whole panel is styled as a draft, because a
 * confident-looking summary of a guess is the failure mode this screen exists
 * to avoid.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ActionIntent, ActionType, ActionValidationResult, CosAvailableAction, CosBound } from '@frontier/contracts';
import { formatCount, formatMoney } from '@frontier/shared';
import { ConfirmDialog, Icon, Meter, SectionHeading, Tag, ValidationBanner, cx, labelOfStatus, toneOfStatus } from '@/components/ui';
import { availableActionsForSession, needsConfirmation, useGameActions, useSession } from '@/lib/game';
import { describeIntent } from '@/components/screens/end-quarter/intents';
import type { TranscriptEntry } from './transcript';

/** Where a player goes to do this by hand. The two paths produce the same object. */
export const ROUTE_OF_ACTION: Readonly<Record<ActionType, string>> = {
  set_research_budget: '/research',
  start_research_project: '/research',
  propose_innovation: '/research',
  publish_research: '/research',
  set_product_price: '/products',
  launch_product: '/products',
  sunset_product: '/products',
  set_marketing_budget: '/social',
  marketing_campaign: '/social',
  hire: '/people',
  layoff: '/people',
  poach_executive: '/people',
  appoint_executive: '/people',
  reserve_compute: '/company',
  buy_cloud_capacity: '/company',
  allocate_compute: '/company',
  raise_round: '/capital',
  issue_debt: '/capital',
  buyback: '/capital',
  issue_shares: '/capital',
  ipo: '/capital',
  set_dividend_policy: '/capital',
  set_logistics_toll: '/company',
  buy_shares: '/markets',
  sell_shares: '/markets',
  acquire_company: '/deal-room',
  submit_board_proposal: '/boardroom',
  lobby_director: '/boardroom',
  bid_government: '/government',
  decline_opportunity: '/government',
  form_consortium: '/government',
  meet_regulator: '/government',
  social_post: '/social',
  give_guidance: '/markets',
  respond_crisis: '/news',
  propose_deal: '/deal-room',
  accept_deal: '/deal-room',
  reject_deal: '/deal-room',
  request_introduction: '/network',
};

const DRAFT_CONFIDENCE = 0.7;

/**
 * One bound, in the founder's units.
 *
 * The figures come from the engine's own probe of the validator, so this is a
 * statement about what would actually be accepted rather than a guideline.
 */
export function boundLabel(bound: CosBound): string {
  const format = (value: number): string => {
    switch (bound.unit) {
      case 'usd':
        return formatMoney(value);
      case 'fraction':
        return `${Math.round(value * 100)}%`;
      case 'percent':
        return `${Math.round(value)}%`;
      case 'quarters':
        return `${Math.round(value)}q`;
      default:
        return formatCount(Math.round(value));
    }
  };
  const low = bound.min === null ? 'any' : format(bound.min);
  const high = bound.max === null ? 'no ceiling' : format(bound.max);
  return `${bound.label}: ${low} to ${high}`;
}

/** What this action may spend and what it is bounded by, or an empty list. */
export function limitsOf(availability: CosAvailableAction | null): string[] {
  if (availability === null) return [];
  const lines = availability.bounds.map(boundLabel);
  if (availability.maxCashUsd !== null) lines.unshift(`Commits up to ${formatMoney(availability.maxCashUsd)}`);
  return lines;
}

export interface InterpretationCardProps {
  readonly entry: TranscriptEntry;
  readonly startYear: number;
  /**
   * How the card is framed.
   *
   * `card` is the standalone surface: its own border, and the instruction
   * repeated in a header. `speech` is the same card with the frame removed,
   * because it is sitting inside the Chief of Staff's speech card and the
   * player's instruction is already on the screen above it as their own turn.
   *
   * **Presentation only.** Every rule below this line — the validator verdicts,
   * the per-row queueing, the confirmation gate on the fourteen, the mandatory
   * line — is identical in both, and must stay identical in both.
   */
  readonly variant?: 'card' | 'speech';
}

export function InterpretationCard({ entry, startYear, variant = 'card' }: InterpretationCardProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  // `validateIntent` reads the live session, so the verdicts below are only as
  // current as the session they were computed against. The memo is keyed on it:
  // a card that survives a resolve must recompute rather than keep showing a
  // clamp that was calculated against a world that no longer exists.
  const session = useSession();
  const [queued, setQueued] = useState<Readonly<Record<number, ActionValidationResult>>>({});
  const [pending, setPending] = useState<{ index: number; intent: ActionIntent } | null>(null);
  // True while "Do it" is walking the outstanding confirmations one at a time.
  // Each of the fourteen still takes its own explicit human confirmation; the
  // only thing being batched is the founder's attention, not their consent.
  const [runningAll, setRunningAll] = useState(false);

  // The engine's own verdict on what this company could do right now, memoised
  // per session object. It is what turns "reserve 4,000 accelerators" into
  // "reserve 4,000 accelerators — the market can free 1,536 this quarter".
  const availability = useMemo(() => new Map(availableActionsForSession(session).map((entry) => [entry.type, entry])), [session]);

  const { interpretation } = entry;
  const draft = interpretation.confidence < DRAFT_CONFIDENCE;

  const rows = useMemo(
    () =>
      interpretation.interpretedInstructions.map((intent, index) => ({
        index,
        intent,
        description: describeIntent(intent, startYear),
        validation: validateIntent(intent),
        needsHuman: needsConfirmation(intent.type),
        limits: limitsOf(availability.get(intent.type) ?? null),
      })),
    [availability, interpretation.interpretedInstructions, startYear, validateIntent, session],
  );

  const routine = rows.filter((row) => !row.needsHuman && queued[row.index] === undefined);
  const outstanding = rows.filter((row) => row.needsHuman && queued[row.index] === undefined);

  function queueRow(index: number, intent: ActionIntent, confirmed: boolean): void {
    const outcome = queueAction(intent, { origin: 'chief_of_staff', confirmed });
    setQueued((current) => ({ ...current, [index]: outcome.validation }));
  }

  const speech = variant === 'speech';

  return (
    <article
      className={cx(
        speech
          ? // Inside a speech card the frame belongs to the card; a low-confidence
            // interpretation still declares itself as a draft, because a
            // confident-looking summary of a guess is the failure mode this
            // screen exists to avoid.
            draft
            ? 'rounded-card border border-dashed border-warn/50 bg-warn-wash p-2.5'
            : ''
          : cx('rounded-panel border bg-panel', draft ? 'border-dashed border-warn/40' : 'border-hair'),
      )}
    >
      {/* --- the instruction ---------------------------------------------- */}
      {speech ? null : (
        <header className="border-b border-hair px-3.5 py-2.5">
          <div className="label-caps-faint">You said</div>
          <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink">{entry.message}</p>
        </header>
      )}

      <div className={cx('flex flex-col gap-3.5', speech ? '' : 'px-3.5 py-3')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="label-caps">Interpreted instructions</span>
            {draft ? <Tag tone="warn">Draft — low confidence</Tag> : null}
            {entry.fallback ? <Tag tone="loss">No model reached</Tag> : null}
          </div>
          <div className="w-32">
            <Meter value={interpretation.confidence * 100} label="Confidence" />
          </div>
        </div>

        <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-ink-dim">{interpretation.summary}</p>

        {/* --- the rows ---------------------------------------------------- */}
        {rows.length === 0 ? (
          <p className="rounded-card border border-hair bg-raised px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-dim">
            Nothing was translated into an action. That is a real answer, not a failure — an instruction the game has no action for should be
            said plainly rather than approximated.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const done = queued[row.index];
              return (
                // One instruction, one full-width card: the terms read down the
                // card on a phone and its two controls sit under them, both
                // clearing the 44px floor.
                <li key={row.index} className="raised-surface px-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-[12.5px] leading-snug font-medium text-ink">{row.description.label}</p>
                      <Tag tone={toneOfStatus((done ?? row.validation).status)} dot>
                        {(done ?? row.validation).clampedAction?.type === 'submit_board_proposal'
                          ? 'Board matter'
                          : labelOfStatus((done ?? row.validation).status)}
                      </Tag>
                    </div>

                    {row.description.terms.length === 0 ? null : (
                      <dl className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                        {row.description.terms.map((entryTerm) => (
                          <div key={entryTerm.label} className="flex items-baseline justify-between gap-2 border-b border-hair/60 pb-0.5">
                            <dt className="label-caps-faint shrink-0">{entryTerm.label}</dt>
                            <dd className="figure truncate text-[11.5px] text-ink">{entryTerm.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    {/* What the engine would actually accept, probed from the
                        validator rather than described beside it. */}
                    {row.limits.length === 0 ? null : (
                      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {row.limits.map((limit) => (
                          <li key={limit} className="icon-knockout-panel flex items-center gap-1 text-[10.5px] text-ink-faint">
                            <Icon name="ledger" size={12} accent="inherit" />
                            <span className="figure">{limit}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {done === undefined ? (
                      <div className="flex items-center gap-2">
                        <Link
                          href={ROUTE_OF_ACTION[row.intent.type]}
                          className="btn btn-ghost tap-target flex-1 sm:flex-none"
                          title={`Do this by hand at ${ROUTE_OF_ACTION[row.intent.type]}`}
                        >
                          <Icon name="chevronRight" size={15} />
                          Edit
                        </Link>
                        <button
                          type="button"
                          className="btn tap-target press-pop flex-1 sm:flex-none"
                          onClick={() => {
                            if (row.needsHuman) setPending({ index: row.index, intent: row.intent });
                            else queueRow(row.index, row.intent, true);
                          }}
                        >
                          <Icon name={row.needsHuman ? 'warning' : 'plus'} size={15} accent={row.needsHuman ? 'warn' : 'brand'} />
                          {row.needsHuman ? 'Confirm…' : 'Queue'}
                        </button>
                      </div>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[11px] text-gain">
                        <Icon name="check" size={14} accent="gain" />
                        queued
                      </span>
                    )}
                  </div>

                  {row.needsHuman && done === undefined ? (
                    <p className="mt-1.5 text-[10.5px] leading-relaxed text-warn">
                      Always requires an explicit human confirmation, whatever the model or your automation preference says.
                    </p>
                  ) : null}

                  {(done ?? row.validation).status === 'accepted' ? null : (
                    <div className="mt-2">
                      <ValidationBanner result={done ?? row.validation} compact />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* --- questions and gaps ------------------------------------------ */}
        {interpretation.questions.length > 0 ? (
          <div className="rounded-card border border-info/25 bg-info-wash px-3 py-2.5">
            <SectionHeading>Before this is safe to submit</SectionHeading>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-relaxed text-ink-dim">
              {interpretation.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {interpretation.unsupportedRequests.length > 0 ? (
          <div className="rounded-card border border-warn/25 bg-warn-wash px-3 py-2.5">
            <SectionHeading>Not something the game can do</SectionHeading>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-relaxed text-warn">
              {interpretation.unsupportedRequests.map((request, index) => (
                <li key={index}>{request}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
              Said plainly rather than silently dropped, which would be the worst possible behaviour here.
            </p>
          </div>
        ) : null}

        {/* --- the mandatory line and the controls -------------------------- */}
        <div className="border-t border-hair pt-3">
          <p className="text-[12.5px] font-medium text-ink">No binding action has been submitted yet.</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">
            Approving queues intents for this quarter. The engine validates them again when the quarter resolves, and its answer is the one
            that counts.
          </p>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {/* "Do it" queues everything routine and then walks the outstanding
                confirmations one dialog at a time. Batching the walk is not
                batching the consent: each of the fourteen still gets its own
                terms and its own explicit yes. */}
            <button
              type="button"
              className="btn btn-primary tap-target press-pop w-full sm:w-auto"
              disabled={routine.length + outstanding.length === 0}
              onClick={() => {
                for (const row of routine) queueRow(row.index, row.intent, true);
                const next = outstanding[0];
                if (next === undefined) return;
                setRunningAll(outstanding.length > 1);
                setPending({ index: next.index, intent: next.intent });
              }}
            >
              <Icon name="check" size={16} accent="current" />
              {routine.length + outstanding.length === 0
                ? 'Nothing left to approve'
                : outstanding.length === 0
                  ? `Do it — ${routine.length} action${routine.length === 1 ? '' : 's'}`
                  : `Do it — ${routine.length + outstanding.length} action${routine.length + outstanding.length === 1 ? '' : 's'}, ${outstanding.length} to confirm`}
            </button>
            {outstanding.length > 0 ? (
              <span className="icon-knockout-panel flex items-center gap-1.5 text-[11.5px] text-warn">
                <Icon name="warning" size={14} accent="inherit" />
                {outstanding.length} action{outstanding.length === 1 ? ' needs' : 's need'} a confirmation of its own.
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending === null ? 'Confirm' : describeIntent(pending.intent, startYear).label}
        actionType={pending?.intent.type}
        body="This is one of the fourteen the engine will refuse without an explicit human confirmation. Read the terms; the Chief of Staff proposed them, it did not decide them."
        terms={pending === null ? [] : describeIntent(pending.intent, startYear).terms.map((entryTerm) => ({ label: entryTerm.label, value: entryTerm.value }))}
        confirmLabel="Confirm and queue"
        tone={pending?.intent.type === 'layoff' ? 'loss' : 'brand'}
        onCancel={() => {
          setPending(null);
          setRunningAll(false);
        }}
        onConfirm={() => {
          if (pending === null) return;
          const confirmedIndex = pending.index;
          queueRow(confirmedIndex, pending.intent, true);
          // Advance to the next outstanding confirmation only when the founder
          // asked for the whole set. Cancelling any one of them ends the walk.
          const next = runningAll ? outstanding.find((row) => row.index !== confirmedIndex) : undefined;
          if (next === undefined) {
            setPending(null);
            setRunningAll(false);
            return;
          }
          setPending({ index: next.index, intent: next.intent });
        }}
      />
    </article>
  );
}

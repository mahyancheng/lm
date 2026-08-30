'use client';

/**
 * The interpretation, rendered as a control surface rather than a chat bubble.
 *
 * The contract is three steps in this order and no shortcuts: **interpret →
 * propose → confirm.** What the model produced is a set of typed
 * `ActionIntent`s, so the card shows them as rows — the instruction, its terms,
 * and what the validator says about it *before* anything is queued. The
 * mandatory line sits above the controls, and the thirteen always go through
 * `ConfirmDialog` regardless of what the model set `requiresConfirmation` to.
 *
 * Below confidence 0.7 the whole panel is styled as a draft, because a
 * confident-looking summary of a guess is the failure mode this screen exists
 * to avoid.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ActionIntent, ActionType, ActionValidationResult } from '@frontier/contracts';
import { ConfirmDialog, Meter, SectionHeading, Tag, ValidationBanner, cx, labelOfStatus, toneOfStatus } from '@/components/ui';
import { needsConfirmation, useGameActions, useSession } from '@/lib/game';
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

export interface InterpretationCardProps {
  readonly entry: TranscriptEntry;
  readonly startYear: number;
}

export function InterpretationCard({ entry, startYear }: InterpretationCardProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  // `validateIntent` reads the live session, so the verdicts below are only as
  // current as the session they were computed against. The memo is keyed on it:
  // a card that survives a resolve must recompute rather than keep showing a
  // clamp that was calculated against a world that no longer exists.
  const session = useSession();
  const [queued, setQueued] = useState<Readonly<Record<number, ActionValidationResult>>>({});
  const [pending, setPending] = useState<{ index: number; intent: ActionIntent } | null>(null);

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
      })),
    [interpretation.interpretedInstructions, startYear, validateIntent, session],
  );

  const routine = rows.filter((row) => !row.needsHuman && queued[row.index] === undefined);
  const outstanding = rows.filter((row) => row.needsHuman && queued[row.index] === undefined);

  function queueRow(index: number, intent: ActionIntent, confirmed: boolean): void {
    const outcome = queueAction(intent, { origin: 'chief_of_staff', confirmed });
    setQueued((current) => ({ ...current, [index]: outcome.validation }));
  }

  return (
    <article
      className={cx(
        'rounded-[6px] border bg-panel',
        draft ? 'border-dashed border-warn/40' : 'border-hair',
      )}
    >
      {/* --- the instruction ---------------------------------------------- */}
      <header className="border-b border-hair px-3.5 py-2.5">
        <div className="label-caps-faint">You said</div>
        <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink">{entry.message}</p>
      </header>

      <div className="flex flex-col gap-3.5 px-3.5 py-3">
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
          <p className="rounded-[4px] border border-hair bg-raised px-3 py-2 text-[11px] text-ink-dim">
            Nothing was translated into an action. That is a real answer, not a failure — an instruction the game has no action for should be
            said plainly rather than approximated.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const done = queued[row.index];
              return (
                <li key={row.index} className="raised-surface px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-medium text-ink">{row.description.label}</p>
                      {row.description.terms.length === 0 ? null : (
                        <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                          {row.description.terms.map((entryTerm) => (
                            <div key={entryTerm.label} className="flex items-baseline justify-between gap-2 border-b border-hair/60 pb-0.5">
                              <dt className="label-caps-faint shrink-0">{entryTerm.label}</dt>
                              <dd className="figure truncate text-[11px] text-ink">{entryTerm.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Tag tone={toneOfStatus((done ?? row.validation).status)} dot>
                        {(done ?? row.validation).clampedAction?.type === 'submit_board_proposal'
                          ? 'Board matter'
                          : labelOfStatus((done ?? row.validation).status)}
                      </Tag>
                      {done === undefined ? (
                        <div className="flex items-center gap-1.5">
                          <Link href={ROUTE_OF_ACTION[row.intent.type]} className="btn btn-ghost btn-sm">
                            Edit
                          </Link>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              if (row.needsHuman) setPending({ index: row.index, intent: row.intent });
                              else queueRow(row.index, row.intent, true);
                            }}
                          >
                            {row.needsHuman ? 'Confirm…' : 'Queue'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-ink-faint">queued</span>
                      )}
                    </div>
                  </div>

                  {row.needsHuman && done === undefined ? (
                    <p className="mt-1.5 text-[10px] text-warn">
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
          <div className="rounded-[4px] border border-info/25 bg-info-wash px-3 py-2">
            <SectionHeading>Before this is safe to submit</SectionHeading>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11px] text-ink-dim">
              {interpretation.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {interpretation.unsupportedRequests.length > 0 ? (
          <div className="rounded-[4px] border border-warn/25 bg-warn-wash px-3 py-2">
            <SectionHeading>Not something the game can do</SectionHeading>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11px] text-warn">
              {interpretation.unsupportedRequests.map((request, index) => (
                <li key={index}>{request}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              Said plainly rather than silently dropped, which would be the worst possible behaviour here.
            </p>
          </div>
        ) : null}

        {/* --- the mandatory line and the controls -------------------------- */}
        <div className="border-t border-hair pt-3">
          <p className="text-[12px] font-medium text-ink">No binding action has been submitted yet.</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
            Approving queues intents for this quarter. The engine validates them again when the quarter resolves, and its answer is the one
            that counts.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={routine.length === 0}
              onClick={() => {
                for (const row of routine) queueRow(row.index, row.intent, true);
              }}
            >
              {routine.length === 0 ? 'Nothing left to approve' : `Approve ${routine.length} routine action${routine.length === 1 ? '' : 's'}`}
            </button>
            {outstanding.length > 0 ? (
              <span className="text-[11px] text-warn">
                {outstanding.length} action{outstanding.length === 1 ? '' : 's'} need a confirmation of their own.
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending === null ? 'Confirm' : describeIntent(pending.intent, startYear).label}
        actionType={pending?.intent.type}
        body="This is one of the thirteen the engine will refuse without an explicit human confirmation. Read the terms; the Chief of Staff proposed them, it did not decide them."
        terms={pending === null ? [] : describeIntent(pending.intent, startYear).terms.map((entryTerm) => ({ label: entryTerm.label, value: entryTerm.value }))}
        confirmLabel="Confirm and queue"
        tone={pending?.intent.type === 'layoff' ? 'loss' : 'brand'}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) queueRow(pending.index, pending.intent, true);
          setPending(null);
        }}
      />
    </article>
  );
}

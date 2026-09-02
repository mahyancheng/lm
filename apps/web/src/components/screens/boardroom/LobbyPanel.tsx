'use client';

/**
 * Lobby a director.
 *
 * Speaking to a director never edits their support score. It produces a
 * `ConditionalCommitment` — a structured, expiring, condition-bearing promise
 * the engine checks against the real numbers on the tabled proposal. That is the
 * whole design: persuading a character means *getting a commitment*, not talking
 * a number up, and the panel says so above the send button.
 *
 * Concessions are written in the same field / comparator / value form a
 * commitment uses, so what is offered and what is later checked are the same
 * object.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  ActionValidationResult,
  Board,
  BoardProposal,
  Character,
  CommitmentComparator,
  CommitmentCondition,
  CommitmentField,
  SessionState,
} from '@frontier/contracts';
import { COMMITMENT_COMPARATORS, COMMITMENT_FIELDS } from '@frontier/contracts';
import { checkAccess } from '@frontier/simulation';
import { formatPct, formatScore } from '@frontier/shared';
import { AccessBadge, EmptyState, Meter, Panel, PersonChip, SectionHeading, Tag, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { commitmentText, conditionText } from './labels';

/**
 * A hand-off from the boardroom scene: "lobby this director on this matter".
 *
 * It is an object rather than two strings so the panel can tell one hand-off
 * from the next — the caller holds it in state, so tapping the same seat twice
 * is two distinct objects and the selects follow both times, while an unrelated
 * re-render leaves whatever the player has since typed alone.
 */
export interface LobbyFocus {
  readonly directorId: string;
  readonly proposalId: string | null;
}

export interface LobbyPanelProps {
  readonly session: SessionState;
  readonly board: Board;
  readonly founder: Character;
  readonly proposals: readonly BoardProposal[];
  readonly directorsById: ReadonlyMap<string, Character>;
  /** Optional: preselect a director (and matter) chosen elsewhere on the screen. */
  readonly focus?: LobbyFocus | null;
}

interface Row {
  readonly field: CommitmentField;
  readonly comparator: CommitmentComparator;
  readonly value: string;
}

const EMPTY_ROW: Row = { field: 'purchasePriceUsd', comparator: 'lte', value: '' };

export function LobbyPanel({ session, board, founder, proposals, directorsById, focus = null }: LobbyPanelProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [directorId, setDirectorId] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState<readonly Row[]>([EMPTY_ROW]);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const open = useMemo(() => proposals.filter((proposal) => proposal.status === 'tabled' || proposal.status === 'draft'), [proposals]);

  // A seat tapped at the table fills the selects here. Only the selects: a
  // half-written message and any concessions already offered are the player's,
  // and a hand-off from the scene must not throw them away.
  useEffect(() => {
    if (focus === null) return;
    setDirectorId(focus.directorId);
    if (focus.proposalId !== null) setProposalId(focus.proposalId);
    setResult(null);
  }, [focus]);

  const director = directorId.length === 0 ? null : (directorsById.get(directorId) ?? null);
  const seat = board.directors.find((entry) => entry.characterId === directorId) ?? null;
  const access = director === null ? null : checkAccess(session, founder.id, director.id);

  const commitments = useMemo(
    () => session.commitments.filter((commitment) => commitment.actorCharacterId === directorId && commitment.status === 'active'),
    [session.commitments, directorId],
  );

  const concessions: CommitmentCondition[] = rows
    .map((row) => {
      const value = Number.parseFloat(row.value);
      return Number.isFinite(value) ? { field: row.field, comparator: row.comparator, value } : null;
    })
    .filter((entry): entry is CommitmentCondition => entry !== null)
    .slice(0, 4);

  const intent =
    directorId.length === 0 || proposalId.length === 0
      ? null
      : ({
          type: 'lobby_director' as const,
          directorCharacterId: directorId,
          proposalId,
          concessions,
          message: message.slice(0, 600),
        });

  const preview = intent === null ? null : validateIntent(intent);

  function send(): void {
    if (intent === null) return;
    const entry = queueAction(intent);
    setResult(entry.validation);
  }

  if (open.length === 0) {
    return (
      <Panel iconName="chat" title="Lobby a director">
        <EmptyState
          title="Nothing is before the board"
          message="A director can only be lobbied on a matter that has been tabled. Table one first, and the whip count will tell you who needs the conversation."
        />
      </Panel>
    );
  }

  return (
    <Panel iconName="chat" iconTone="brand" title="Lobby a director" subtitle="A conversation produces a testable promise, never a changed number">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="label-caps-faint mb-1 block">Director</span>
          <select className="field tap-target sm:min-h-0" value={directorId} onChange={(event) => setDirectorId(event.target.value)}>
            <option value="">Select…</option>
            {board.directors
              .filter((entry) => entry.characterId !== founder.id)
              .map((entry) => (
                <option key={entry.characterId} value={entry.characterId}>
                  {directorsById.get(entry.characterId)?.name ?? entry.characterId} — {entry.seat}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="label-caps-faint mb-1 block">Matter</span>
          <select className="field tap-target sm:min-h-0" value={proposalId} onChange={(event) => setProposalId(event.target.value)}>
            <option value="">Select…</option>
            {open.map((proposal) => (
              <option key={proposal.id} value={proposal.id}>
                {proposal.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      {director === null || seat === null ? null : (
        <div className="raised-surface mt-2.5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <PersonChip character={director} subtitle={director.title} className="max-w-[60%]" />
            {access === null ? null : (
              <AccessBadge state={access.allowed ? (access.overrideId === null ? 'open' : 'override') : 'blocked'} gap={Math.round(access.gap)} />
            )}
          </div>
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            <Meter value={seat.independence} label="Independence" />
            <Meter value={Math.max(0, (seat.relationshipWithCeo + 100) / 2)} label={`Relationship with you (${formatScore(seat.relationshipWithCeo)})`} />
            <Meter value={seat.financialDiscipline} label="Financial discipline" />
            <Meter value={seat.safetyOrientation} label="Safety orientation" />
          </div>
          {commitments.length === 0 ? (
            <p className="mt-2.5 text-[12px] text-ink-faint sm:text-[10px]">No live commitment from this director.</p>
          ) : (
            <div className="mt-2.5 space-y-1.5">
              <div className="label-caps-faint">Live commitments</div>
              {commitments.map((commitment) => (
                <div key={commitment.id} className="text-[11px] text-ink-dim">
                  <Tag tone={commitment.stance === 'support' ? 'gain' : commitment.stance === 'oppose' ? 'loss' : 'neutral'}>{commitment.stance}s</Tag>{' '}
                  {commitmentText(commitment.conditions)}
                  <span className="block text-[10px] text-ink-faint">
                    strength {formatPct(commitment.commitmentStrength)} · expires in quarter {commitment.expiresQuarter}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <SectionHeading
          rule
          actions={
            <button type="button" className="btn btn-ghost btn-sm tap-target sm:min-h-0" disabled={rows.length >= 4} onClick={() => setRows((current) => [...current, EMPTY_ROW])}>
              Add term
            </button>
          }
        >
          Concessions offered
        </SectionHeading>
        <div className="mt-2 space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
              <select
                className="field tap-target sm:min-h-0"
                value={row.field}
                onChange={(event) =>
                  setRows((current) => current.map((entry, i) => (i === index ? { ...entry, field: event.target.value as CommitmentField } : entry)))
                }
              >
                {COMMITMENT_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
              <select
                className="field tap-target w-auto sm:min-h-0"
                value={row.comparator}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, i) => (i === index ? { ...entry, comparator: event.target.value as CommitmentComparator } : entry)),
                  )
                }
              >
                {COMMITMENT_COMPARATORS.map((comparator) => (
                  <option key={comparator} value={comparator}>
                    {comparator}
                  </option>
                ))}
              </select>
              <input
                className="field tap-target sm:min-h-0"
                type="number"
                step="any"
                value={row.value}
                placeholder="value"
                onChange={(event) => setRows((current) => current.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm tap-target w-full sm:w-auto sm:min-h-0"
                onClick={() => setRows((current) => (current.length === 1 ? current : current.filter((_, i) => i !== index)))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {concessions.length === 0 ? null : (
          <p className="mt-1.5 text-[11px] text-ink-dim">
            You are offering: <span className="text-ink">{concessions.map(conditionText).join(' and ')}</span>.
          </p>
        )}
      </div>

      <label className="mt-3 block">
        <span className="label-caps-faint mb-1 block">What you say</span>
        <textarea className="field tap-target sm:min-h-0" rows={3} maxLength={600} value={message} onChange={(event) => setMessage(event.target.value)} />
        <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">
          Their reply comes from their traits, their mandate and their memory of you — not from how persuasive the text is.
        </span>
      </label>

      <div className="mt-2.5 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-warn">A conversation creates a commitment. It never edits a support score.</p>
        <button
          type="button"
          className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0"
          disabled={intent === null}
          onClick={send}
        >
          Queue conversation
        </button>
      </div>

      {result === null && preview !== null ? (
        <div className="mt-2">
          <ValidationBanner result={preview} compact />
        </div>
      ) : null}
      {result === null ? null : (
        <div className="mt-2">
          <ValidationBanner result={result} />
        </div>
      )}
    </Panel>
  );
}

'use client';

/**
 * One person, in full: how they regard you, how you regard them, what you
 * remember, and whether you may open a channel at all.
 *
 * The access panel is the point of the screen. When contact is refused the
 * drawer states the gap, names the route that would open it, and puts
 * `request_introduction` one click away behind the same reachability check the
 * validator will run — so the route the interface offers is the route the
 * engine accepts.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Character } from '@frontier/contracts';
import { CONNECTION_GAP_RULE, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatScore } from '@frontier/shared';
import { MIN_INTRODUCTION_PURPOSE_CHARS } from '@frontier/simulation';
import { AccessBadge, Drawer, KeyValueGrid, Meter, SectionHeading, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions, useSession } from '@/lib/game';
import { characterName, memoriesAbout, type DirectoryEntry } from './directory';

export interface PersonDrawerProps {
  readonly entry: DirectoryEntry | null;
  readonly selfId: string;
  readonly selfName: string;
  readonly selfConnection: number;
  readonly startYear: number;
  readonly onClose: () => void;
}

const ROLE_TONE: Readonly<Record<Character['role'], 'brand' | 'info' | 'warn' | 'neutral'>> = {
  founder_ceo: 'brand',
  investor: 'info',
  director: 'info',
  executive: 'neutral',
  regulator: 'warn',
  journalist: 'warn',
  researcher: 'neutral',
  official: 'warn',
};

export function PersonDrawer({
  entry,
  selfId,
  selfName,
  selfConnection,
  startYear,
  onClose,
}: PersonDrawerProps): React.JSX.Element | null {
  const session = useSession();
  const { queueAction, validateIntent } = useGameActions();

  const [via, setVia] = useState('');
  const [purpose, setPurpose] = useState('');
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [queued, setQueued] = useState(false);

  const memories = useMemo(
    () => (entry === null ? [] : memoriesAbout(session, selfId, entry.character.id)),
    [session, selfId, entry],
  );

  if (entry === null) return null;

  const { character, decision, state, outbound, inbound, brokerIds } = entry;
  const target = character;
  const viaId = via === '' ? (brokerIds[0] ?? '') : via;
  const canAsk = brokerIds.length > 0 && purpose.trim().length >= MIN_INTRODUCTION_PURPOSE_CHARS && viaId !== '';

  function reset(): void {
    setResult(null);
    setQueued(false);
    setPurpose('');
    setVia('');
  }

  function preview(): void {
    if (viaId === '') return;
    setResult(
      validateIntent({
        type: 'request_introduction',
        viaCharacterId: viaId,
        targetCharacterId: target.id,
        purpose: purpose.trim(),
      }),
    );
  }

  function ask(): void {
    if (!canAsk) return;
    const outcome = queueAction({
      type: 'request_introduction',
      viaCharacterId: viaId,
      targetCharacterId: target.id,
      purpose: purpose.trim(),
    });
    setResult(outcome.validation);
    setQueued(true);
  }

  const edge = outbound ?? inbound;

  return (
    <Drawer
      open
      onClose={() => {
        reset();
        onClose();
      }}
      title={target.name}
      subtitle={target.title}
      width={520}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={ROLE_TONE[target.role]}>{target.role.replace(/_/g, ' ')}</Tag>
          {target.isPlayer ? <Tag tone="brand">Human seat</Tag> : <Tag tone="neutral">AI-controlled character</Tag>}
          <AccessBadge state={state} gap={Math.round(decision.gap)} />
        </div>

        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Their connection', value: formatScore(target.connectionLevel) },
            { label: 'Yours', value: formatScore(selfConnection) },
            { label: 'Gap', value: formatScore(decision.gap) },
            { label: 'Board seats', value: String(target.boardSeatCount) },
            { label: 'Personal wealth', value: formatMoney(target.personalWealthUsd) },
            { label: 'Employer', value: entry.companyName ?? 'Independent', mono: false },
          ]}
        />

        {/* --- access ------------------------------------------------------- */}
        <div>
          <SectionHeading rule>Access</SectionHeading>
          <p
            className={cx(
              'mt-2 rounded-[4px] border px-3 py-2 text-[11px] leading-relaxed',
              decision.allowed ? 'border-gain/25 bg-gain-wash text-ink-dim' : 'border-warn/25 bg-warn-wash text-warn',
            )}
          >
            {decision.reason}
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">{CONNECTION_GAP_RULE.statement}</p>
        </div>

        {/* --- introduction ------------------------------------------------- */}
        {!decision.allowed ? (
          <div>
            <SectionHeading rule>Ask for an introduction</SectionHeading>
            {brokerIds.length === 0 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">
                Nobody you can reach can reach {target.name} either. Build a relationship with someone in between first — that is the whole
                route upward.
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <label className="block">
                  <span className="label-caps-faint">Through</span>
                  <select
                    className="field mt-1"
                    value={viaId}
                    onChange={(event) => {
                      setVia(event.target.value);
                      setResult(null);
                      setQueued(false);
                    }}
                  >
                    {brokerIds.map((id) => (
                      <option key={id} value={id}>
                        {characterName(session, id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label-caps-faint">What the meeting is for</span>
                  <textarea
                    className="field mt-1"
                    rows={3}
                    maxLength={300}
                    value={purpose}
                    placeholder="Compute supply for a two-quarter training run, on terms they would actually sign."
                    onChange={(event) => {
                      setPurpose(event.target.value);
                      setResult(null);
                      setQueued(false);
                    }}
                    onBlur={preview}
                  />
                  <span className="mt-1 block text-[10px] text-ink-faint">
                    {purpose.trim().length < MIN_INTRODUCTION_PURPOSE_CHARS
                      ? `Vague requests are refused: at least ${MIN_INTRODUCTION_PURPOSE_CHARS} characters.`
                      : `${purpose.trim().length} / 300`}
                  </span>
                </label>

                <ValidationBanner result={result} compact />

                <div className="flex items-center gap-2">
                  <button type="button" className="btn btn-sm" onClick={preview} disabled={viaId === ''}>
                    Check
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={ask} disabled={!canAsk || queued}>
                    {queued ? 'Queued' : 'Queue the request'}
                  </button>
                </div>
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  {viaId === '' ? 'Your intermediary' : characterName(session, viaId)} spends their own standing on this. They decide
                  whether to make the call; the engine resolves it in the relationship phase.
                </p>
              </div>
            )}
          </div>
        ) : null}

        {/* --- relationship ------------------------------------------------- */}
        <div>
          <SectionHeading rule>The relationship, in both directions</SectionHeading>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="label-caps-faint mb-1.5">How {selfName} regards them</div>
              {outbound === null ? (
                <p className="text-[11px] text-ink-faint">You have never dealt with them.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Meter value={outbound.trust} label="Trust" />
                  <Meter value={outbound.respect} label="Respect" />
                  <Meter value={outbound.hostility} label="Hostility" tone={outbound.hostility >= 50 ? 'loss' : 'neutral'} />
                  <Meter value={outbound.dependence} label="Dependence" tone="info" />
                </div>
              )}
            </div>
            <div>
              <div className="label-caps-faint mb-1.5">How they regard {selfName}</div>
              {inbound === null ? (
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  They hold no recorded view of you. Relationships are directional: being impressed by someone is not the same as their
                  having noticed you.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Meter value={inbound.trust} label="Trust" />
                  <Meter value={inbound.respect} label="Respect" />
                  <Meter value={inbound.hostility} label="Hostility" tone={inbound.hostility >= 50 ? 'loss' : 'neutral'} />
                  <Meter value={inbound.dependence} label="Dependence" tone="info" />
                </div>
              )}
            </div>
          </div>

          {edge === null ? null : (
            <div className="mt-3">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'Dealings', value: String(edge.interactionCount) },
                  {
                    label: 'Last contact',
                    value: edge.lastInteractionQuarter === null ? 'Never' : quarterLabel(startYear, edge.lastInteractionQuarter),
                  },
                ]}
              />
            </div>
          )}
        </div>

        {/* --- memory ------------------------------------------------------- */}
        <div>
          <SectionHeading rule>What you remember</SectionHeading>
          {memories.length === 0 ? (
            <p className="mt-2 text-[11px] text-ink-faint">Nothing about {target.name} has stuck yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {memories.map((memory) => (
                <li key={memory.id} className="raised-surface px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <Tag tone={memory.sentiment >= 0 ? 'gain' : 'loss'}>{memory.kind.replace(/_/g, ' ')}</Tag>
                    <span className="figure text-[10px] text-ink-faint">{quarterLabel(startYear, memory.quarter)}</span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">{memory.summary}</p>
                  <div className="mt-1.5">
                    <Meter value={memory.strength * 100} label="Salience" showValue={false} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
            Only your own memories. What {target.name} privately remembers about you is theirs, and you find out when they bring it up.
          </p>
        </div>
      </div>
    </Drawer>
  );
}

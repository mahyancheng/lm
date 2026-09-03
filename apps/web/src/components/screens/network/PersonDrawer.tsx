'use client';

/**
 * One person, in full: how they regard you, how you regard them, what you
 * remember, and — the point of the screen — what you can actually do about it.
 *
 * The drawer used to offer exactly one move, `request_introduction`, and only
 * to people the access rule refused. Everyone reachable got a read-only card.
 * In world 2 that is thirty-one of forty-two people with no button at all, and
 * the eleven who had one could not use it either, because the screen's
 * reachability oracle (`checkAccess`) and the validator's (`canReach`) had
 * drifted apart and the intermediary the screen offered was one the validator
 * said you could not reach.
 *
 * So: every offer here is rendered *with the validator's live verdict beside
 * it*. `validateIntent` is the same call `queueAction` makes, against the same
 * state, so a button that is enabled is a button the engine accepts, and a
 * refusal is shown in the engine's own words rather than hidden by removing the
 * control.
 */

import { useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult, Character } from '@frontier/contracts';
import { CONNECTION_GAP_RULE, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatScore } from '@frontier/shared';
import { MIN_INTRODUCTION_PURPOSE_CHARS } from '@frontier/simulation';
import { AccessBadge, Drawer, Icon, KeyValueGrid, Meter, SectionHeading, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions, usePlayerCompany, useSession } from '@/lib/game';
import { characterName, memoriesAbout, type DirectoryEntry } from './directory';
import { TalkPanel } from './TalkPanel';
import {
  bestVia,
  offersFor,
  openingDealDraft,
  viaOptions,
  type PersonActionKind,
  type PersonActionOffer,
} from './actions';

/** Shortest offer text the engine will read as a real one. */
const MIN_SUMMARY_CHARS = 10;

export interface PersonDrawerProps {
  readonly entry: DirectoryEntry | null;
  /** The whole directory, because a route to one person runs through another. */
  readonly directory: readonly DirectoryEntry[];
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
  directory,
  selfId,
  selfName,
  selfConnection,
  startYear,
  onClose,
}: PersonDrawerProps): React.JSX.Element | null {
  const session = useSession();
  const ownCompany = usePlayerCompany();
  const { queueAction, validateIntent } = useGameActions();

  const [openKind, setOpenKind] = useState<PersonActionKind | null>(null);
  const [via, setVia] = useState('');
  const [purpose, setPurpose] = useState('');
  const [summary, setSummary] = useState('');
  const [premiumPct, setPremiumPct] = useState(40);
  const [approach, setApproach] = useState<'private' | 'public'>('private');
  const [topic, setTopic] = useState<'model_rules' | 'safety_obligations' | 'antitrust' | 'procurement_policy'>('model_rules');
  const [posture, setPosture] = useState<'cooperative' | 'informational' | 'lobbying' | 'defensive'>('cooperative');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [queuedKind, setQueuedKind] = useState<PersonActionKind | null>(null);

  const targetId = entry?.character.id ?? null;

  const memories = useMemo(
    () => (targetId === null ? [] : memoriesAbout(session, selfId, targetId)),
    [session, selfId, targetId],
  );

  // Their memories of the player: the character's own context for a
  // conversation, handed to their agent and never rendered on this screen.
  const theirMemories = useMemo(
    () => (targetId === null ? [] : memoriesAbout(session, targetId, selfId)),
    [session, selfId, targetId],
  );

  const board = useMemo(
    () => session.boards.find((entryBoard) => entryBoard.id === ownCompany.boardId) ?? null,
    [session.boards, ownCompany.boardId],
  );

  const openMatter = useMemo(
    () =>
      session.boardProposals
        .filter((proposal) => proposal.companyId === ownCompany.id && (proposal.status === 'tabled' || proposal.status === 'draft'))
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null,
    [session.boardProposals, ownCompany.id],
  );

  const offers = useMemo(
    () =>
      entry === null
        ? []
        : offersFor(entry, {
            selfId,
            ownCompanyId: ownCompany.id,
            ownBoardDirectorIds: new Set((board?.directors ?? []).map((director) => director.characterId)),
            hasOpenBoardMatter: openMatter !== null,
          }),
    [entry, selfId, ownCompany.id, board, openMatter],
  );

  const routes = useMemo(() => (entry === null ? [] : viaOptions(directory, entry)), [directory, entry]);
  const suggested = useMemo(() => (entry === null ? null : bestVia(directory, entry)), [directory, entry]);

  if (entry === null) return null;

  const { character, decision, state, outbound, inbound } = entry;
  const target = character;
  const viaId = via === '' ? (suggested?.id ?? '') : via;

  /** The intent one offer would queue, or null when it is not yet complete. */
  function intentFor(kind: PersonActionKind): ActionIntent | null {
    switch (kind) {
      case 'talk':
        return null;
      case 'request_introduction':
        return viaId === ''
          ? null
          : { type: 'request_introduction', viaCharacterId: viaId, targetCharacterId: target.id, purpose: purpose.trim() };
      case 'poach_executive':
        return { type: 'poach_executive', targetCharacterId: target.id, compPremiumPct: premiumPct / 100, approach };
      case 'lobby_director':
        return openMatter === null
          ? null
          : {
              type: 'lobby_director',
              directorCharacterId: target.id,
              proposalId: openMatter.id,
              concessions: [],
              message: message.slice(0, 600),
            };
      case 'meet_regulator':
        return { type: 'meet_regulator', regulatorCharacterId: target.id, topic, posture, concessionsOffered: [] };
      case 'propose_deal':
        return { type: 'propose_deal', proposal: openingDealDraft(target, session.quarter, summary.trim()) };
      default:
        return null;
    }
  }

  /**
   * Whether the form behind an offer has been filled in enough to be worth
   * validating. Distinct from the verdict: an empty purpose is not a refusal,
   * it is an unfinished instruction, and showing the engine's rejection for it
   * would read as the move being impossible.
   */
  function isComplete(kind: PersonActionKind): boolean {
    if (kind === 'request_introduction') return viaId !== '' && purpose.trim().length >= MIN_INTRODUCTION_PURPOSE_CHARS;
    if (kind === 'propose_deal') return summary.trim().length >= MIN_SUMMARY_CHARS;
    if (kind === 'lobby_director') return openMatter !== null;
    return true;
  }

  function verdictFor(kind: PersonActionKind): ActionValidationResult | null {
    if (kind === 'talk' || !isComplete(kind)) return null;
    const intent = intentFor(kind);
    return intent === null ? null : validateIntent(intent);
  }

  function queue(kind: PersonActionKind): void {
    const intent = intentFor(kind);
    if (intent === null) return;
    const outcome = queueAction(intent);
    setResult(outcome.validation);
    setQueuedKind(kind);
  }

  function toggle(kind: PersonActionKind): void {
    setOpenKind((current) => (current === kind ? null : kind));
    setResult(null);
    setQueuedKind(null);
  }

  const edge = outbound ?? inbound;

  return (
    <Drawer
      open
      onClose={() => {
        setOpenKind(null);
        setResult(null);
        setQueuedKind(null);
        setPurpose('');
        setSummary('');
        setMessage('');
        setVia('');
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
              'mt-2 flex items-start gap-2 rounded-card border px-3 py-2.5 text-[12.5px] leading-relaxed',
              decision.allowed ? 'border-gain/25 bg-gain-wash text-ink-dim' : 'border-warn/25 bg-warn-wash text-warn',
            )}
          >
            <span className="mt-px shrink-0">
              <Icon name={decision.allowed ? 'check' : 'warning'} size={14} accent="current" />
            </span>
            {decision.reason}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{CONNECTION_GAP_RULE.statement}</p>
        </div>

        {/* --- what you can do --------------------------------------------- */}
        <div>
          <SectionHeading rule>What you can do</SectionHeading>
          {offers.length === 0 ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
              Nobody you can reach can reach {target.name} either. Build the middle ring first — the people you can already speak to are the
              route to everyone above them.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {offers.map((offer) => (
                <li key={offer.kind}>
                  <OfferRow
                    offer={offer}
                    open={openKind === offer.kind}
                    onToggle={() => toggle(offer.kind)}
                    verdict={openKind === offer.kind ? verdictFor(offer.kind) : null}
                  >
                    {offer.kind === 'talk' ? (
                      <TalkPanel
                        key={target.id}
                        session={session}
                        target={target}
                        selfId={selfId}
                        inbound={inbound}
                        outbound={outbound}
                        theirMemories={theirMemories}
                        accessBasis={decision.reason}
                      />
                    ) : null}

                    {offer.kind === 'request_introduction' ? (
                      <div className="flex flex-col gap-2">
                        <label className="block">
                          <span className="label-caps-faint">Through</span>
                          <select
                            className="field tap-target mt-1"
                            value={viaId}
                            onChange={(event) => {
                              setVia(event.target.value);
                              setResult(null);
                              setQueuedKind(null);
                            }}
                          >
                            {routes.map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.name} · connection {Math.round(person.connectionLevel)}
                                {person.id === suggested?.id ? ' · best placed' : ''}
                              </option>
                            ))}
                          </select>
                          <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">
                            Picked for you: the person you can reach with the most standing to spend. {routes.length} can make this
                            introduction.
                          </span>
                        </label>
                        <label className="block">
                          <span className="label-caps-faint">What the meeting is for</span>
                          <textarea
                            className="field mt-1 text-[13px]"
                            rows={3}
                            maxLength={300}
                            value={purpose}
                            placeholder="Compute supply for a two-quarter training run, on terms they would actually sign."
                            onChange={(event) => {
                              setPurpose(event.target.value);
                              setResult(null);
                              setQueuedKind(null);
                            }}
                          />
                          <span className="mt-1 block text-[10px] text-ink-faint">
                            {purpose.trim().length < MIN_INTRODUCTION_PURPOSE_CHARS
                              ? `Vague requests are refused: at least ${MIN_INTRODUCTION_PURPOSE_CHARS} characters.`
                              : `${purpose.trim().length} of 300`}
                          </span>
                        </label>
                        <p className="text-[10.5px] leading-relaxed text-ink-faint">
                          Next quarter {characterName(session, viaId)} decides whether to make the call, out of their own standing and what
                          they think of you. Granted, it opens a channel to {target.name} for four quarters.
                        </p>
                      </div>
                    ) : null}

                    {offer.kind === 'poach_executive' ? (
                      <div className="flex flex-col gap-2">
                        <label className="block">
                          <span className="label-caps-faint">Premium over their pay</span>
                          <input
                            className="field tap-target mt-1"
                            type="number"
                            min={0}
                            max={300}
                            step={5}
                            value={premiumPct}
                            onChange={(event) => {
                              setPremiumPct(Math.max(0, Math.min(300, Math.round(Number(event.target.value) || 0))));
                              setResult(null);
                              setQueuedKind(null);
                            }}
                          />
                          <span className="mt-1 block text-[10px] text-ink-faint">{premiumPct}% above the market rate for the post.</span>
                        </label>
                        <label className="block">
                          <span className="label-caps-faint">How it is made</span>
                          <select
                            className="field tap-target mt-1"
                            value={approach}
                            onChange={(event) => {
                              setApproach(event.target.value === 'public' ? 'public' : 'private');
                              setResult(null);
                              setQueuedKind(null);
                            }}
                          >
                            <option value="private">Privately — discreet, slower, needs reach</option>
                            <option value="public">Publicly — faster, applies pressure, starts a fight</option>
                          </select>
                        </label>
                        <p className="text-[10.5px] leading-relaxed text-ink-faint">
                          Resolved next quarter against their pay, their traits and what they think of you. Their employer remembers the
                          approach either way.
                        </p>
                      </div>
                    ) : null}

                    {offer.kind === 'lobby_director' ? (
                      openMatter === null ? (
                        <p className="text-[12.5px] leading-relaxed text-ink-dim">
                          A director can only be lobbied on a matter that is before the board. Table one in the Boardroom and the whip count
                          will say who needs the conversation.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="raised-surface px-2.5 py-2">
                            <div className="label-caps-faint">On the agenda</div>
                            <p className="mt-1 text-[12.5px] text-ink">{openMatter.title}</p>
                          </div>
                          <label className="block">
                            <span className="label-caps-faint">What you say to them</span>
                            <textarea
                              className="field mt-1 text-[13px]"
                              rows={3}
                              maxLength={600}
                              value={message}
                              placeholder="The price is defensible at this multiple, and I will take the earn-out if that is what closes it."
                              onChange={(event) => {
                                setMessage(event.target.value);
                                setResult(null);
                                setQueuedKind(null);
                              }}
                            />
                          </label>
                          <p className="text-[10.5px] leading-relaxed text-ink-faint">
                            Their reply comes from their mandate and their memory of you, never from how persuasive the text is. What you can
                            win is a conditional commitment the engine checks against the real terms.
                          </p>
                        </div>
                      )
                    ) : null}

                    {offer.kind === 'meet_regulator' ? (
                      <div className="flex flex-col gap-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block">
                            <span className="label-caps-faint">Subject</span>
                            <select
                              className="field tap-target mt-1"
                              value={topic}
                              onChange={(event) => {
                                setTopic(event.target.value as typeof topic);
                                setResult(null);
                                setQueuedKind(null);
                              }}
                            >
                              <option value="model_rules">Model rules</option>
                              <option value="safety_obligations">Safety obligations</option>
                              <option value="antitrust">Antitrust</option>
                              <option value="procurement_policy">Procurement policy</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="label-caps-faint">Posture</span>
                            <select
                              className="field tap-target mt-1"
                              value={posture}
                              onChange={(event) => {
                                setPosture(event.target.value as typeof posture);
                                setResult(null);
                                setQueuedKind(null);
                              }}
                            >
                              <option value="cooperative">Cooperative</option>
                              <option value="informational">Informational</option>
                              <option value="lobbying">Lobbying</option>
                              <option value="defensive">Defensive</option>
                            </select>
                          </label>
                        </div>
                        <p className="text-[10.5px] leading-relaxed text-ink-faint">
                          Held next quarter. Cooperative builds standing slowly; lobbying can shift a rule and is remembered by everyone it
                          disadvantages.
                        </p>
                      </div>
                    ) : null}

                    {offer.kind === 'propose_deal' ? (
                      <div className="flex flex-col gap-2">
                        <label className="block">
                          <span className="label-caps-faint">What you are proposing</span>
                          <textarea
                            className="field mt-1 text-[13px]"
                            rows={3}
                            maxLength={600}
                            value={summary}
                            placeholder="A two-year compute supply arrangement, priced off the reference tape, with a first refusal on the next tranche."
                            onChange={(event) => {
                              setSummary(event.target.value);
                              setResult(null);
                              setQueuedKind(null);
                            }}
                          />
                          <span className="mt-1 block text-[10px] text-ink-faint">
                            {summary.trim().length < MIN_SUMMARY_CHARS
                              ? `At least ${MIN_SUMMARY_CHARS} characters — a counterparty has to be able to read it.`
                              : `${summary.trim().length} of 600`}
                          </span>
                        </label>
                        <p className="text-[10.5px] leading-relaxed text-ink-faint">
                          A recorded, non-binding offer that lapses two quarters from now. It needs your confirmation in the queue before the
                          quarter ends; obligations are written in the Deal Room.
                        </p>
                      </div>
                    ) : null}

                    {offer.kind === 'talk' ? null : (
                      <>
                        <ValidationBanner result={queuedKind === offer.kind ? result : verdictFor(offer.kind)} compact />
                        <button
                          type="button"
                          className="btn btn-primary tap-target icon-knockout-brand mt-2 w-full sm:w-auto"
                          disabled={
                            !isComplete(offer.kind) ||
                            queuedKind === offer.kind ||
                            verdictFor(offer.kind)?.status === 'rejected'
                          }
                          onClick={() => queue(offer.kind)}
                        >
                          <Icon name={offer.icon} size={15} accent="inherit" />
                          {queuedKind === offer.kind ? 'Queued for this quarter' : 'Queue it'}
                        </button>
                      </>
                    )}
                  </OfferRow>
                </li>
              ))}
            </ul>
          )}
        </div>

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
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">{memory.summary}</p>
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

/* -------------------------------------------------------------------------- */
/*  One offer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A tappable row that opens into its own form.
 *
 * Collapsed by default because a phone has one column and six expanded forms is
 * a scroll, not a screen. The whole row is the target — 44px tall — and the
 * refusal, when there is one, is on the collapsed row too, so a player does not
 * have to open a form to learn the move is closed to them.
 */
function OfferRow({
  offer,
  open,
  onToggle,
  verdict,
  children,
}: {
  readonly offer: PersonActionOffer;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly verdict: ActionValidationResult | null;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const refused = verdict?.status === 'rejected';
  return (
    <div className={cx('rounded-card border', refused ? 'border-warn/25' : 'border-hair')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="tap-target flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <span className="shrink-0">
          <Icon name={offer.icon} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-semibold text-ink">{offer.label}</span>
          <span className="block text-[10.5px] leading-relaxed text-ink-faint">{offer.blurb}</span>
        </span>
        <span className="shrink-0">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} accent="current" />
        </span>
      </button>
      {open ? <div className="border-t border-hair px-2.5 py-2.5">{children}</div> : null}
    </div>
  );
}

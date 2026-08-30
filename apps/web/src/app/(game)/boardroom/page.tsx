'use client';

/**
 * Boardroom — composition, docket, and the two levers that move a vote.
 *
 * Being chief executive and owning the company are separate states, and this
 * screen is where that separation becomes mechanical. A board can dismiss the
 * player; the player keeps every share and the campaign continues as a proxy
 * fight. So directors are rendered as people with mandates and memories, not as
 * a difficulty slider: their traits, their independence, their relationship with
 * the chief executive and every live conditional commitment are on the surface.
 *
 * Every director here sits on the player's own board and is therefore visible by
 * construction. Nothing on this screen reads a rival's governance.
 */

import { useMemo, useState } from 'react';
import type { BoardProposal, Character } from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, quarterLabel } from '@frontier/contracts';
import { tallyProposal } from '@frontier/simulation';
import { formatMoney, formatPct, formatScore } from '@frontier/shared';
import {
  Drawer,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  PersonChip,
  ProgressBar,
  SectionHeading,
  StatCard,
  Tag,
} from '@/components/ui';
import { LobbyPanel } from '@/components/screens/boardroom/LobbyPanel';
import { ProposePanel } from '@/components/screens/boardroom/ProposePanel';
import { MANDATE_LABEL, PROPOSAL_KIND_LABEL, commitmentText } from '@/components/screens/boardroom/labels';
import { usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';

const STATUS_TONE = {
  draft: 'neutral',
  tabled: 'info',
  voted: 'info',
  passed: 'gain',
  failed: 'loss',
  withdrawn: 'neutral',
} as const;

export default function BoardroomPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const [openDirectorId, setOpenDirectorId] = useState<string | null>(null);
  const [openProposalId, setOpenProposalId] = useState<string | null>(null);

  const board = view.board;
  const proposals = view.boardProposals;

  const directorsById = useMemo(() => {
    const map = new Map<string, Character>();
    if (board === null) return map;
    for (const seat of board.directors) {
      const character = session.characters.find((entry) => entry.id === seat.characterId);
      if (character !== undefined) map.set(seat.characterId, character);
    }
    return map;
  }, [board, session.characters]);

  const commitments = useMemo(() => {
    if (board === null) return [];
    const seated = new Set(board.directors.map((seat) => seat.characterId));
    return session.commitments.filter((commitment) => seated.has(commitment.actorCharacterId));
  }, [board, session.commitments]);

  if (board === null) {
    return (
      <>
        <PageHeader
          title="Boardroom"
          eyebrow={quarterLabel(session.startYear, session.quarter)}
          subtitle="Agenda, directors, votes and governance."
        />
        <Panel>
          <EmptyState
            title={`${company.name} has no board`}
            message="A company too small to have a board needs no approval for anything — the founder's brief, precious freedom before the first priced round. A board arrives with the first investor seat."
          />
        </Panel>
      </>
    );
  }

  const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
  const openMatters = proposals.filter((proposal) => proposal.status === 'tabled' || proposal.status === 'draft');
  const decided = proposals.filter((proposal) => proposal.status !== 'tabled' && proposal.status !== 'draft');

  const independentCount = board.directors.filter((seat) => seat.seat === 'independent').length;
  const meanRelationship =
    board.directors.length === 0 ? 0 : board.directors.reduce((total, seat) => total + seat.relationshipWithCeo, 0) / board.directors.length;

  const openDirector = openDirectorId === null ? null : (board.directors.find((seat) => seat.characterId === openDirectorId) ?? null);
  const openProposal: BoardProposal | null = openProposalId === null ? null : (proposals.find((proposal) => proposal.id === openProposalId) ?? null);
  const openTally = openProposal === null ? null : tallyProposal(session, openProposal.id);

  return (
    <>
      <PageHeader
        title="Boardroom"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Directors are people with mandates who remember how they were treated. A conversation creates a commitment; only the vote changes anything."
        actions={
          <>
            <Tag tone="neutral">{board.directors.length} of {board.seatsAuthorised} seats</Tag>
            <Tag tone={openMatters.length > 0 ? 'info' : 'neutral'} dot>
              {openMatters.length} matter{openMatters.length === 1 ? '' : 's'} open
            </Tag>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Seats filled" value={`${board.directors.length} / ${board.seatsAuthorised}`} hint={`${independentCount} independent`} />
        <StatCard
          label="Mean relationship"
          value={formatScore(meanRelationship)}
          tone={meanRelationship >= 40 ? 'gain' : meanRelationship >= 0 ? 'warn' : 'loss'}
          hint="How the room feels about the chief executive, on a -100 to 100 scale"
        />
        <StatCard label="Ordinary threshold" value={formatPct(rule.passThresholdFraction, 0)} hint={`Supermajority ${formatPct(rule.supermajorityThresholdFraction, 0)}`} />
        <StatCard
          label="Live commitments"
          value={commitments.filter((commitment) => commitment.status === 'active').length}
          hint="Structured promises the engine will check"
        />
      </div>

      <Panel title="Composition" subtitle="Select a director for their card">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {board.directors.map((seat) => {
            const character = directorsById.get(seat.characterId);
            return (
              <button
                key={seat.characterId}
                type="button"
                onClick={() => setOpenDirectorId(seat.characterId)}
                className="raised-surface p-3 text-left transition-colors hover:border-hair-strong"
              >
                <div className="flex items-start justify-between gap-2">
                  {character === undefined ? (
                    <span className="text-[12px] text-ink">{seat.characterId}</span>
                  ) : (
                    <PersonChip character={character} subtitle={character.title} size="sm" />
                  )}
                  {seat.isChair ? <Tag tone="brand">Chair</Tag> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Tag>{seat.seat}</Tag>
                  <Tag tone="info">{MANDATE_LABEL[seat.mandate]}</Tag>
                  {seat.committees.map((committee) => (
                    <Tag key={committee}>{committee}</Tag>
                  ))}
                </div>
                <div className="mt-2.5 space-y-2">
                  <Meter value={seat.independence} label="Independence" />
                  <Meter value={Math.max(0, (seat.relationshipWithCeo + 100) / 2)} label={`With you · ${formatScore(seat.relationshipWithCeo)}`} showValue={false} />
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Docket" subtitle="Open matters carry a live tally; decided ones carry the minutes" bodyClassName="space-y-2.5">
        {proposals.length === 0 ? (
          <EmptyState
            title="Nothing is on the agenda"
            message="Financing, listings, acquisitions, buybacks, restructurings and C-suite appointments all arrive here automatically — the validator turns the action into the proposal that has to precede it."
          />
        ) : (
          [...openMatters, ...decided].map((proposal) => {
            const tally = tallyProposal(session, proposal.id);
            const cast = tally.support + tally.against;
            return (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setOpenProposalId(proposal.id)}
                className="raised-surface block w-full p-3 text-left transition-colors hover:border-hair-strong"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="label-caps-faint">{PROPOSAL_KIND_LABEL[proposal.kind]}</div>
                    <div className="mt-0.5 text-[13px] font-medium text-ink">{proposal.title}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {proposal.amountUsd === null ? null : <span className="figure text-[12px] text-ink-dim">{formatMoney(proposal.amountUsd)}</span>}
                    <Tag tone={STATUS_TONE[proposal.status]} dot>
                      {proposal.status}
                    </Tag>
                  </div>
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={cast === 0 ? 0 : tally.support / cast}
                    ghostValue={proposal.requiredThresholdFraction}
                    tone={tally.passes ? 'gain' : 'loss'}
                    valueLabel={`${tally.support} for · ${tally.against} against · ${tally.abstain} abstaining`}
                    label={`Decision ${quarterLabel(session.startYear, proposal.decisionQuarter)} · threshold ${formatPct(proposal.requiredThresholdFraction, 0)}`}
                  />
                </div>
              </button>
            );
          })
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <ProposePanel session={session} board={board} founder={founder} view={view} directorsById={directorsById} />
        <LobbyPanel session={session} board={board} founder={founder} proposals={proposals} directorsById={directorsById} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Commitments ledger" subtitle="What directors have promised, and whether it still binds">
          {commitments.length === 0 ? (
            <EmptyState
              compact
              title="No commitments recorded"
              message="A conversation that reaches something concrete leaves a structured promise here. Most conversations do not."
            />
          ) : (
            <div className="space-y-2">
              {commitments.map((commitment) => (
                <div key={commitment.id} className="raised-surface px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px] text-ink">{directorsById.get(commitment.actorCharacterId)?.name ?? commitment.actorCharacterId}</span>
                    <div className="flex items-center gap-1.5">
                      <Tag tone={commitment.stance === 'support' ? 'gain' : commitment.stance === 'oppose' ? 'loss' : 'neutral'}>{commitment.stance}s</Tag>
                      <Tag
                        tone={
                          commitment.status === 'honoured'
                            ? 'gain'
                            : commitment.status === 'broken'
                              ? 'loss'
                              : commitment.status === 'active'
                                ? 'info'
                                : 'neutral'
                        }
                      >
                        {commitment.status}
                      </Tag>
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-dim">
                    Will {commitment.stance} a {PROPOSAL_KIND_LABEL[commitment.proposalKind].toLowerCase()} {commitmentText(commitment.conditions)}.
                  </p>
                  <p className="mt-1 text-[10px] text-ink-faint">
                    Strength {commitment.commitmentStrength.toFixed(2)} · expires {quarterLabel(session.startYear, commitment.expiresQuarter)}
                    {commitment.rationale.length === 0 ? '' : ` · “${commitment.rationale}”`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Governance rules" subtitle="One screen, and no surprises later">
          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Quorum', value: formatPct(rule.minPresentFraction, 0), hint: 'Of seated voting weight' },
              { label: 'Ordinary matter', value: formatPct(rule.passThresholdFraction, 0), hint: 'Of votes cast' },
              { label: 'Supermajority', value: formatPct(rule.supermajorityThresholdFraction, 0) },
              { label: 'Chair breaks ties', value: rule.chairBreaksTies ? 'Yes' : 'No', mono: false },
              { label: 'Seats authorised', value: board.seatsAuthorised.toString() },
              { label: 'Next meeting', value: quarterLabel(session.startYear, board.nextMeetingQuarter) },
            ]}
          />
          <div className="mt-3">
            <SectionHeading rule>Supermajority matters</SectionHeading>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rule.supermajorityKinds.length === 0 ? (
                <span className="text-[11px] text-ink-faint">None: every matter carries on a simple majority.</span>
              ) : (
                rule.supermajorityKinds.map((kind) => (
                  <Tag key={kind} tone="warn">
                    {kind.replace(/_/g, ' ')}
                  </Tag>
                ))
              )}
            </div>
          </div>
          <p className="mt-3 text-[10px] text-ink-faint">
            A proposal to dismiss the chief executive is not tabled by the chief executive, and a director is recused from a matter that concerns them
            personally. Both rules are enforced by the engine, not by hiding a control.
          </p>
        </Panel>
      </div>

      {/* --- one director, opened ------------------------------------------- */}
      <Drawer
        open={openDirector !== null}
        onClose={() => setOpenDirectorId(null)}
        title={openDirector === null ? '' : (directorsById.get(openDirector.characterId)?.name ?? openDirector.characterId)}
        subtitle={openDirector === null ? undefined : `${openDirector.seat} seat · ${MANDATE_LABEL[openDirector.mandate]}`}
      >
        {openDirector === null ? null : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {openDirector.isChair ? <Tag tone="brand">Chair</Tag> : null}
              <Tag>{openDirector.seat}</Tag>
              <Tag tone="info">{MANDATE_LABEL[openDirector.mandate]}</Tag>
              {openDirector.committees.map((committee) => (
                <Tag key={committee}>{committee}</Tag>
              ))}
            </div>

            <div className="space-y-3">
              <Meter value={openDirector.independence} label="Independence — willingness to vote against management" />
              <Meter value={openDirector.riskTolerance} label="Risk tolerance" />
              <Meter value={openDirector.growthPreference} label="Growth over profitability" />
              <Meter value={openDirector.financialDiscipline} label="Financial discipline" />
              <Meter value={openDirector.techKnowledge} label="Technical judgement" />
              <Meter value={openDirector.safetyOrientation} label="Safety orientation" />
              <Meter
                value={Math.max(0, (openDirector.relationshipWithCeo + 100) / 2)}
                label={`Relationship with the chief executive · ${formatScore(openDirector.relationshipWithCeo)}`}
                showValue={false}
              />
            </div>

            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Voting weight', value: openDirector.votingWeight.toFixed(1) },
                { label: 'Appointed', value: quarterLabel(session.startYear, openDirector.appointedQuarter) },
                { label: 'Represents', value: openDirector.representedHolderId ?? 'nobody — independent', mono: false, wide: true },
              ]}
            />

            <div>
              <SectionHeading rule>Their commitments</SectionHeading>
              <div className="mt-2 space-y-1.5">
                {commitments.filter((commitment) => commitment.actorCharacterId === openDirector.characterId).length === 0 ? (
                  <p className="text-[11px] text-ink-faint">Nothing recorded. Lobby them on a tabled matter to change that.</p>
                ) : (
                  commitments
                    .filter((commitment) => commitment.actorCharacterId === openDirector.characterId)
                    .map((commitment) => (
                      <p key={commitment.id} className="text-[11px] text-ink-dim">
                        {commitment.stance}s a {PROPOSAL_KIND_LABEL[commitment.proposalKind].toLowerCase()} {commitmentText(commitment.conditions)} —{' '}
                        <span className="text-ink-faint">{commitment.status}</span>
                      </p>
                    ))
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      {/* --- one matter, opened -------------------------------------------- */}
      <Drawer
        open={openProposal !== null}
        onClose={() => setOpenProposalId(null)}
        title={openProposal?.title ?? ''}
        subtitle={openProposal === null ? undefined : `${PROPOSAL_KIND_LABEL[openProposal.kind]} · ${openProposal.status}`}
        width={520}
      >
        {openProposal === null || openTally === null ? null : (
          <div className="space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-dim">{openProposal.summary}</p>

            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Amount', value: openProposal.amountUsd === null ? 'no price' : formatMoney(openProposal.amountUsd) },
                { label: 'Threshold', value: formatPct(openProposal.requiredThresholdFraction, 0) },
                { label: 'Tabled', value: quarterLabel(session.startYear, openProposal.quarterProposed) },
                { label: 'Decision', value: quarterLabel(session.startYear, openProposal.decisionQuarter) },
                {
                  label: 'Stock component',
                  value: openProposal.stockComponentPct === null ? '—' : formatPct(openProposal.stockComponentPct, 0),
                },
                { label: 'Target', value: openProposal.targetCompanyId ?? '—', mono: false },
              ]}
            />

            <div>
              <SectionHeading rule>
                {openProposal.status === 'passed' || openProposal.status === 'failed' ? 'Minutes' : 'Live tally'}
              </SectionHeading>
              <div className="mt-2">
                <ProgressBar
                  value={openTally.support + openTally.against === 0 ? 0 : openTally.support / (openTally.support + openTally.against)}
                  ghostValue={openProposal.requiredThresholdFraction}
                  tone={openTally.passes ? 'gain' : 'loss'}
                  valueLabel={`${openTally.support} for · ${openTally.against} against`}
                  label={openTally.quorumMet ? (openTally.passes ? 'Carries' : 'Falls') : 'Quorum not met'}
                />
              </div>
              <div className="mt-2.5 space-y-1.5">
                {openTally.perDirector.map((vote) => (
                  <div key={vote.directorCharacterId} className="raised-surface px-2.5 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-ink">{directorsById.get(vote.directorCharacterId)?.name ?? vote.directorCharacterId}</span>
                      <div className="flex items-center gap-1.5">
                        {vote.honouredCommitmentId === null ? null : <Tag tone="info">commitment honoured</Tag>}
                        <Tag tone={vote.vote === 'support' ? 'gain' : vote.vote === 'oppose' ? 'loss' : 'neutral'} dot>
                          {vote.vote}
                        </Tag>
                      </div>
                    </div>
                    {vote.rationale === null ? null : <p className="mt-1 text-[10px] text-ink-faint">{vote.rationale}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

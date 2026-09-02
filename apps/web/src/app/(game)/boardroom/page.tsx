'use client';

/**
 * Boardroom — the room, the matter on the table, and the two levers that move a
 * vote.
 *
 * Being chief executive and owning the company are separate states, and this
 * screen is where that separation becomes mechanical. A board can dismiss the
 * player; the player keeps every share and the campaign continues as a proxy
 * fight. So directors are rendered as *people around a table* rather than as a
 * difficulty slider: their faces carry how they feel about the chief executive,
 * the badge by each seat carries how they would vote on the matter at the head
 * of the table, and their traits, mandate and live commitments are one tap away.
 *
 * Everything the screen could do before it was a scene it still does: table a
 * matter, lobby a director, read the whip count and its reasoning, open the
 * minutes of a decided matter, and read the commitments ledger. The scene is the
 * way in, not a replacement for the controls.
 *
 * Every director here sits on the player's own board and is therefore visible by
 * construction. Nothing on this screen reads a rival's governance.
 */

import { useMemo, useState } from 'react';
import type { BoardProposal, Character } from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, quarterLabel } from '@frontier/contracts';
import { tallyProposal } from '@frontier/simulation';
import { formatCount, formatMoney, formatPct, formatScore } from '@frontier/shared';
import {
  Drawer,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Icon,
  Panel,
  PersonChip,
  ProgressBar,
  SectionHeading,
  StatCard,
  TabBar,
  Tag,
} from '@/components/ui';
import { Portrait, moodFromRelationship } from '@/components/scenes/people';
import { BoardroomScene } from '@/components/screens/boardroom/BoardroomScene';
import { LobbyPanel, type LobbyFocus } from '@/components/screens/boardroom/LobbyPanel';
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

/** Bring a panel into view after a control elsewhere on the page targets it. */
function scrollTo(id: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function BoardroomPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const [openDirectorId, setOpenDirectorId] = useState<string | null>(null);
  const [openProposalId, setOpenProposalId] = useState<string | null>(null);
  const [tabledId, setTabledId] = useState<string | null>(null);
  const [lobbyFocus, setLobbyFocus] = useState<LobbyFocus | null>(null);

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
            icon="boardTable"
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

  // The matter at the head of the table: whichever the player selected, or the
  // first one open. A selection that has since been decided falls back rather
  // than emptying the table.
  const headProposal: BoardProposal | null = openMatters.find((proposal) => proposal.id === tabledId) ?? openMatters[0] ?? null;

  const independentCount = board.directors.filter((seat) => seat.seat === 'independent').length;
  const meanRelationship =
    board.directors.length === 0 ? 0 : board.directors.reduce((total, seat) => total + seat.relationshipWithCeo, 0) / board.directors.length;

  const openDirector = openDirectorId === null ? null : (board.directors.find((seat) => seat.characterId === openDirectorId) ?? null);
  const openDirectorCharacter = openDirector === null ? null : (directorsById.get(openDirector.characterId) ?? null);
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
            <Tag tone="neutral">
              {board.directors.length} of {board.seatsAuthorised} seats
            </Tag>
            <Tag tone={openMatters.length > 0 ? 'info' : 'neutral'} dot>
              {openMatters.length} matter{openMatters.length === 1 ? '' : 's'} open
            </Tag>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard iconName="boardTable" label="Seats filled" value={`${board.directors.length} / ${board.seatsAuthorised}`} hint={`${independentCount} independent`} />
        <StatCard
          iconName="people"
          label="Board mood"
          value={formatScore(meanRelationship)}
          tone={meanRelationship >= 40 ? 'gain' : meanRelationship >= 0 ? 'warn' : 'loss'}
          hint="How the room feels about the chief executive, on a -100 to 100 scale"
        />
        <StatCard iconName="stamp" label="Pass threshold" value={formatPct(rule.passThresholdFraction)} hint={`Supermajority ${formatPct(rule.supermajorityThresholdFraction)}`} />
        <StatCard
          iconName="handshake"
          label="Commitments"
          value={commitments.filter((commitment) => commitment.status === 'active').length}
          hint="Structured promises the engine will check"
        />
      </div>

      {/* --- the room ------------------------------------------------------- */}
      <Panel
        iconName="boardTable"
        iconTone="brand"
        title="The room"
        subtitle={
          headProposal === null
            ? 'Nothing is tabled. The board still has opinions; it has nothing to vote on.'
            : 'Tap a director for their card, their reasoning and the conversation that would move them.'
        }
        actions={
          openMatters.length > 1 ? (
            <TabBar
              className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
              variant="segmented"
              ariaLabel="Matter under discussion"
              value={headProposal?.id ?? ''}
              onChange={setTabledId}
              tabs={openMatters.map((proposal) => ({
                id: proposal.id,
                label: proposal.title.length > 22 ? `${proposal.title.slice(0, 21)}…` : proposal.title,
              }))}
            />
          ) : undefined
        }
      >
        <BoardroomScene
          session={session}
          board={board}
          founder={founder}
          directorsById={directorsById}
          proposal={headProposal}
          selectedDirectorId={openDirectorId}
          onSelectDirector={setOpenDirectorId}
          onOpenProposal={setOpenProposalId}
        />

        {/* The room's controls, in thumb reach directly under the table: a
            two-up grid of full-height targets on a phone, the compact inline
            strip it has always been from `sm` up. */}
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-hair pt-3 sm:flex sm:flex-wrap sm:items-center sm:gap-1.5">
          <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={() => scrollTo('propose')}>
            <Icon name="plus" size={15} accent="current" />
            Table a matter
          </button>
          <button
            type="button"
            className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0"
            onClick={() => scrollTo('lobby')}
            disabled={openMatters.length === 0}
          >
            <Icon name="chat" size={15} accent="current" />
            Lobby a director
          </button>
          <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={() => scrollTo('commitments')}>
            <Icon name="ledger" size={15} accent="current" />
            Commitments
          </button>
          {headProposal === null ? null : (
            <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={() => setOpenProposalId(headProposal.id)}>
              <Icon name="chart" size={15} accent="current" />
              Full tally
            </button>
          )}
        </div>
      </Panel>

      <div id="propose" className="grid scroll-mt-4 gap-4 lg:grid-cols-2">
        <ProposePanel session={session} board={board} founder={founder} view={view} directorsById={directorsById} />
        <div id="lobby" className="flex min-w-0 scroll-mt-4 flex-col">
          <LobbyPanel session={session} board={board} founder={founder} proposals={proposals} directorsById={directorsById} focus={lobbyFocus} />
        </div>
      </div>

      {/* --- decided matters ------------------------------------------------ */}
      <Panel iconName="newspaper" title="Minutes" subtitle="Matters the board has already settled, with the vote as it was taken" bodyClassName="space-y-2.5">
        {decided.length === 0 ? (
          <EmptyState
            compact
            icon="boardTable"
            title="Nothing has been decided yet"
            message="A matter tabled this quarter is voted in the board-resolution phase. Its minutes appear here afterwards, with every director's vote and their reasoning."
          />
        ) : (
          decided.map((proposal) => {
            const tally = tallyProposal(session, proposal.id);
            const cast = tally.support + tally.against;
            return (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setOpenProposalId(proposal.id)}
                className="raised-surface hover-lift press-pop block w-full p-3 text-left"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="label-caps-faint">{PROPOSAL_KIND_LABEL[proposal.kind]}</div>
                    <div className="mt-0.5 text-[13px] font-semibold text-ink">{proposal.title}</div>
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
                    label={`Decision ${quarterLabel(session.startYear, proposal.decisionQuarter)} · threshold ${formatPct(proposal.requiredThresholdFraction)}`}
                  />
                </div>
              </button>
            );
          })
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <div id="commitments" className="flex min-w-0 scroll-mt-4 flex-col">
          <Panel iconName="ledger" title="Commitments ledger" subtitle="What directors have promised, and whether it still binds">
            {commitments.length === 0 ? (
              <EmptyState
                compact
                icon="handshake"
                title="No commitments recorded"
                message="A conversation that reaches something concrete leaves a structured promise here. Most conversations do not."
              />
            ) : (
              <div className="space-y-2">
                {commitments.map((commitment) => {
                  const author = directorsById.get(commitment.actorCharacterId) ?? null;
                  return (
                    <div key={commitment.id} className="raised-surface px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {author === null ? (
                          <span className="text-[12px] text-ink">{commitment.actorCharacterId}</span>
                        ) : (
                          <PersonChip
                            character={author}
                            size="sm"
                            className="max-w-[55%]"
                            onClick={() => setOpenDirectorId(commitment.actorCharacterId)}
                          />
                        )}
                        <div className="flex items-center gap-1.5">
                          <Tag tone={commitment.stance === 'support' ? 'gain' : commitment.stance === 'oppose' ? 'loss' : 'neutral'}>
                            {commitment.stance}s
                          </Tag>
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
                      <p className="mt-1 text-[13px] leading-relaxed text-ink-dim sm:text-[11px]">
                        Will {commitment.stance} a {PROPOSAL_KIND_LABEL[commitment.proposalKind].toLowerCase()} {commitmentText(commitment.conditions)}.
                      </p>
                      <p className="mt-1 text-[10px] text-ink-faint">
                        Strength {formatPct(commitment.commitmentStrength)} · expires {quarterLabel(session.startYear, commitment.expiresQuarter)}
                        {commitment.rationale.length === 0 ? '' : ` · “${commitment.rationale}”`}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <Panel iconName="stamp" title="Governance rules" subtitle="One screen, and no surprises later">
          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Quorum', value: formatPct(rule.minPresentFraction), hint: 'Of seated voting weight' },
              { label: 'Ordinary matter', value: formatPct(rule.passThresholdFraction), hint: 'Of votes cast' },
              { label: 'Supermajority', value: formatPct(rule.supermajorityThresholdFraction) },
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
        title={openDirectorCharacter?.name ?? openDirector?.characterId ?? ''}
        subtitle={openDirector === null ? undefined : `${openDirector.seat} seat · ${MANDATE_LABEL[openDirector.mandate]}`}
      >
        {openDirector === null ? null : (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Portrait
                characterId={openDirector.characterId}
                name={openDirectorCharacter?.name}
                role={openDirectorCharacter?.role}
                size="xl"
                idle
                mood={moodFromRelationship(openDirector.relationshipWithCeo)}
                ring={openDirector.relationshipWithCeo >= 20 ? 'gain' : openDirector.relationshipWithCeo <= -20 ? 'loss' : 'neutral'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5">
                  {openDirector.isChair ? <Tag tone="brand">Chair</Tag> : null}
                  <Tag>{openDirector.seat}</Tag>
                  <Tag tone="info">{MANDATE_LABEL[openDirector.mandate]}</Tag>
                  {openDirector.committees.map((committee) => (
                    <Tag key={committee}>{committee}</Tag>
                  ))}
                </div>
                {openMatters.length === 0 ? (
                  <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                    Nothing is tabled, so there is nothing to lobby them on. A director can only be lobbied on a matter before the board.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm tap-target mt-2 sm:min-h-0"
                    onClick={() => {
                      setLobbyFocus({ directorId: openDirector.characterId, proposalId: headProposal?.id ?? null });
                      setOpenDirectorId(null);
                      scrollTo('lobby');
                    }}
                  >
                    Lobby them
                  </button>
                )}
              </div>
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
                { label: 'Voting weight', value: formatCount(openDirector.votingWeight) },
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
            <p className="text-[13px] leading-relaxed text-ink-dim sm:text-[12px]">{openProposal.summary}</p>

            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Amount', value: openProposal.amountUsd === null ? 'no price' : formatMoney(openProposal.amountUsd) },
                { label: 'Threshold', value: formatPct(openProposal.requiredThresholdFraction) },
                { label: 'Tabled', value: quarterLabel(session.startYear, openProposal.quarterProposed) },
                { label: 'Decision', value: quarterLabel(session.startYear, openProposal.decisionQuarter) },
                {
                  label: 'Stock component',
                  value: openProposal.stockComponentPct === null ? '—' : formatPct(openProposal.stockComponentPct),
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
                {openTally.perDirector.map((vote) => {
                  const voter = directorsById.get(vote.directorCharacterId) ?? null;
                  return (
                    <div key={vote.directorCharacterId} className="raised-surface px-2.5 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {voter === null ? (
                          <span className="text-[11px] text-ink">{vote.directorCharacterId}</span>
                        ) : (
                          <PersonChip
                            character={voter}
                            size="sm"
                            className="max-w-[55%]"
                            ring={vote.vote === 'support' ? 'gain' : vote.vote === 'oppose' ? 'loss' : undefined}
                          />
                        )}
                        <div className="flex items-center gap-1.5">
                          {vote.honouredCommitmentId === null ? null : <Tag tone="info">commitment honoured</Tag>}
                          <Tag tone={vote.vote === 'support' ? 'gain' : vote.vote === 'oppose' ? 'loss' : 'neutral'} dot>
                            {vote.vote}
                          </Tag>
                        </div>
                      </div>
                      {vote.rationale === null ? null : <p className="mt-1 text-[10px] text-ink-faint">{vote.rationale}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

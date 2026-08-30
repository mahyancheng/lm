'use client';

/**
 * The room itself.
 *
 * A board is not a list of rows with support percentages on them; it is seven
 * people around a table who each want something. So the docket is drawn: the
 * matter under discussion sits at the head of the table, the directors sit
 * around it with their faces on, and the badge floating by each seat is the
 * engine's own reading of how they would vote if the matter went to a vote now.
 *
 * Everything on the stage is state:
 *
 * - the seats come from `board.directors` and are placed by a deterministic rule
 *   in `table.ts` — the same board seats the same people in the same chairs;
 * - the stance badges come from `whipCount`, which runs the engine's own
 *   `assessDirector` over the tabled proposal. It is a *projection*, and the
 *   strip under the table says so, because the vote that counts is taken in the
 *   board-resolution phase against the numbers as they stand then;
 * - the expression on a director's face is their relationship with the chief
 *   executive, on the -100..100 scale the board already stores.
 *
 * Tapping a seat opens that director's card. Every other capability of the
 * screen — tabling a matter, lobbying, the commitments ledger — is one control
 * away in the strip beneath the table.
 */

import { useMemo } from 'react';
import type { Board, BoardProposal, Character, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { ProgressBar, Tag } from '@/components/ui';
import { Portrait, moodFromRelationship } from '@/components/scenes/people';
import { PROPOSAL_KIND_LABEL } from './labels';
import { STANCE_LABEL, STANCE_TONE, TABLE, seatDirectors, seatOrder, stanceOf } from './table';
import { whipCount, type WhipLine } from './whip';

export interface BoardroomSceneProps {
  readonly session: SessionState;
  readonly board: Board;
  readonly founder: Character;
  readonly directorsById: ReadonlyMap<string, Character>;
  /** The matter at the head of the table, or null when nothing is tabled. */
  readonly proposal: BoardProposal | null;
  readonly selectedDirectorId: string | null;
  readonly onSelectDirector: (characterId: string) => void;
  /** Open the full tally for the matter at the head of the table. */
  readonly onOpenProposal: (proposalId: string) => void;
}

export function BoardroomScene({
  session,
  board,
  founder,
  directorsById,
  proposal,
  selectedDirectorId,
  onSelectDirector,
  onOpenProposal,
}: BoardroomSceneProps): React.JSX.Element {
  const whip = useMemo(() => (proposal === null ? null : whipCount(session, board, proposal)), [session, board, proposal]);

  // The founder usually holds a seat on their own board; they are drawn at the
  // foot of the table rather than twice.
  const seats = useMemo(() => seatDirectors(seatOrder(board.directors, founder.id)), [board.directors, founder.id]);
  const lineOf = useMemo(() => {
    const map = new Map<string, WhipLine>();
    for (const line of whip?.lines ?? []) map.set(line.characterId, line);
    return map;
  }, [whip]);

  // A crowded table draws smaller people rather than overlapping ones, and past
  // eight seats it drops the stance label: the ring around each face already
  // carries the colour, and the full reading stays in the seat's own label.
  const portraitSize = seats.length <= 6 ? 'lg' : seats.length <= 10 ? 'md' : 'sm';
  const seatWidth = seats.length <= 6 ? 96 : seats.length <= 10 ? 88 : 78;
  const showStance = seats.length <= 8;

  const ownSeat = board.directors.find((seat) => seat.characterId === founder.id) ?? null;
  const ownLine = lineOf.get(founder.id) ?? null;
  const ownStance = stanceOf(ownLine);

  const cast = whip === null ? 0 : whip.support + whip.against;

  return (
    <div className="flex flex-col gap-3">
      {/* --- the stage ---------------------------------------------------- */}
      <div className="scene-frame border border-hair bg-base">
        <div className="scroll-x">
          <div className="relative min-w-[640px]" style={{ aspectRatio: '3 / 2' }}>
            {/* The floor and the table. `preserveAspectRatio="none"` makes the
                viewBox percent-space, so the ellipse and the seats positioned
                on top of it cannot drift apart at any container width. */}
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 size-full"
              role="presentation"
              aria-hidden="true"
            >
              <ellipse cx="50" cy="52" rx="44" ry="36" fill="var(--color-raised)" />
              <ellipse cx={TABLE.cx} cy={TABLE.cy + 2} rx={TABLE.rx + 1.5} ry={TABLE.ry} fill="color-mix(in srgb, var(--color-ink) 8%, transparent)" />
              <ellipse cx={TABLE.cx} cy={TABLE.cy} rx={TABLE.rx} ry={TABLE.ry} fill="var(--color-pop-4)" />
              <ellipse
                cx={TABLE.cx}
                cy={TABLE.cy - 1.4}
                rx={TABLE.rx - 5}
                ry={TABLE.ry - 5}
                fill="color-mix(in srgb, var(--color-panel) 26%, var(--color-pop-4))"
              />
            </svg>

            {/* --- the matter, at the head of the table --------------------- */}
            <div className="absolute left-1/2 top-[2%] w-[220px] -translate-x-1/2">
              {proposal === null || whip === null ? (
                <div className="rounded-card border border-dashed border-hair-strong bg-panel px-3 py-2.5 text-center">
                  <div className="label-caps-faint">The head of the table</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                    Nothing is tabled. Table a matter and the room takes a position on it.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenProposal(proposal.id)}
                  className="hover-lift press-pop block w-full rounded-card border border-hair bg-panel px-3 py-2.5 text-left shadow-card"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="label-caps-faint truncate">{PROPOSAL_KIND_LABEL[proposal.kind]}</span>
                    <Tag tone={whip.carries ? 'gain' : 'loss'} size="sm" dot>
                      {whip.quorumMet ? (whip.carries ? 'Carries' : 'Falls') : 'No quorum'}
                    </Tag>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[12px] font-semibold text-ink">{proposal.title}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="figure text-[11px] text-ink-dim">
                      {proposal.amountUsd === null ? 'no price' : formatMoney(proposal.amountUsd)}
                    </span>
                    <span className="text-[10px] text-brand">Open the tally</span>
                  </div>
                </button>
              )}
            </div>

            {/* --- the directors -------------------------------------------- */}
            {seats.map((seat, index) => {
              const director = board.directors.find((entry) => entry.characterId === seat.characterId);
              const character = directorsById.get(seat.characterId) ?? null;
              const line = lineOf.get(seat.characterId) ?? null;
              const stance = stanceOf(line);
              const tone = STANCE_TONE[stance];
              const name = character?.name ?? seat.characterId;
              const shortName = name.split(' ')[0] ?? name;
              return (
                <button
                  key={seat.characterId}
                  type="button"
                  className="fc-seat animate-pop-in"
                  style={{
                    left: `${seat.xPct}%`,
                    top: `${seat.yPct}%`,
                    width: `${seatWidth}px`,
                    transform: 'translate(-50%, -50%)',
                    animationDelay: `${index * 45}ms`,
                  }}
                  data-selected={seat.characterId === selectedDirectorId}
                  onClick={() => onSelectDirector(seat.characterId)}
                  aria-label={`${name}${director?.isChair === true ? ', chair of the board' : ''} — ${STANCE_LABEL[stance]}. Open their card.`}
                >
                  <Portrait
                    characterId={seat.characterId}
                    role={character?.role}
                    size={portraitSize}
                    idle
                    decorative
                    ring={tone === 'neutral' ? undefined : tone}
                    mood={moodFromRelationship(director?.relationshipWithCeo)}
                  />
                  <span className="w-full truncate text-[10px] font-semibold text-ink">{shortName}</span>
                  {showStance ? (
                    <Tag tone={tone} size="sm" dot={stance !== 'unknown'}>
                      {STANCE_LABEL[stance]}
                    </Tag>
                  ) : null}
                  {director?.isChair === true ? <span className="label-caps-faint text-[9px]">Chair</span> : null}
                  {line !== null && line.honouredCommitmentId !== null ? <span className="text-[9px] text-info">commitment</span> : null}
                </button>
              );
            })}

            {/* --- you, at the foot ----------------------------------------- */}
            <div
              className="fc-seat w-[112px]"
              data-self="true"
              style={{ left: '50%', top: '88%', transform: 'translate(-50%, -50%)', cursor: 'default' }}
            >
              <Portrait
                characterId={founder.id}
                role={founder.role}
                size="lg"
                idle
                decorative
                isPlayer
                mood={whip === null ? 'content' : whip.carries ? 'content' : 'guarded'}
              />
              <span className="w-full truncate text-[10px] font-semibold text-ink">{founder.name}</span>
              <span className="label-caps-faint text-[9px]">
                {ownSeat === null ? 'You · chief executive' : ownSeat.isChair ? 'You · chair' : 'You · director'}
              </span>
              {ownSeat === null || ownLine === null ? null : (
                <Tag tone={STANCE_TONE[ownStance]} size="sm" dot>
                  {STANCE_LABEL[ownStance]}
                </Tag>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* --- the count under the table ------------------------------------ */}
      {whip === null || proposal === null ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Financing, listings, acquisitions, buybacks, restructurings and C-suite appointments all arrive here automatically — the validator
          turns the action into the proposal that has to precede it.
        </p>
      ) : (
        <div>
          <ProgressBar
            label={`Whip count against a ${formatPct(whip.threshold, 0)} threshold`}
            value={cast === 0 ? 0 : whip.support / cast}
            ghostValue={whip.threshold}
            tone={whip.carries ? 'gain' : 'loss'}
            valueLabel={`${whip.support} for · ${whip.against} against · ${whip.abstain} abstaining`}
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
            A projection from state, not a promise: the engine runs the same assessment again in the board-resolution phase, against the
            numbers as they stand then. Tap a director for their reasoning.
          </p>
        </div>
      )}
    </div>
  );
}

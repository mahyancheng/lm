'use client';

/**
 * The quarter moment, staged.
 *
 * The engine is synchronous and fast, but it is real work on the main thread:
 * the store yields a frame before calling it so this paints first, and a replay
 * yields between quarters for the same reason.
 *
 * What the player sees is a **stage** — a flat-vector vignette for the group of
 * phases currently in play, the eighteen phase names streaming beneath it in
 * pipeline order, and a friendly bar. Every bit of it is driven by the store's
 * real `resolveStatus`: the overlay never sleeps, never waits and never holds a
 * frame back. The only time it spends that the engine did not is the 180ms
 * cross-fade between one vignette and the next, and that runs *while* the work
 * does. When `resolving` goes false the overlay is gone on the same frame.
 *
 * The pipeline order is the drama, so the phase list is the real one.
 */

import type { ResolutionPhase } from '@frontier/contracts';
import { RESOLUTION_PHASES } from '@frontier/contracts';
import { useLoading, useResolving } from '@/lib/game';

/* -------------------------------------------------------------------------- */
/*  Stages                                                                     */
/* -------------------------------------------------------------------------- */

type VignetteId = 'desk' | 'globe' | 'podium' | 'office' | 'ticker';

interface Stage {
  readonly id: VignetteId;
  readonly title: string;
  readonly caption: string;
  /** The phases this vignette stands for. The five together are all eighteen. */
  readonly phases: readonly ResolutionPhase[];
}

const STAGES: readonly Stage[] = [
  {
    id: 'desk',
    title: 'Your instructions',
    caption: 'Everything you queued is read back, validated and stamped.',
    phases: ['action_collection'],
  },
  {
    id: 'globe',
    title: 'The world moves',
    caption: 'Events fire, modifiers land, and the frontier reveals what it now believes.',
    phases: ['world_events', 'gm_modifiers', 'information_reveal'],
  },
  {
    id: 'podium',
    title: 'Boards and the state',
    caption: 'Directors vote, capital moves, and public awards are decided.',
    phases: ['board_resolution', 'capital_resolution', 'government_resolution'],
  },
  {
    id: 'office',
    title: 'Your company works',
    caption: 'Hiring, research, demand — and the books that follow from them.',
    phases: ['talent_resolution', 'research_resolution', 'product_demand_resolution', 'financial_resolution'],
  },
  {
    id: 'ticker',
    title: 'The markets price it',
    caption: 'Disclosure, then price, then the feed, the boards and the ledger.',
    phases: [
      'disclosure_resolution',
      'market_resolution',
      'social_resolution',
      'relationship_update',
      'leaderboard_update',
      'ledger_commit',
      'snapshot',
    ],
  },
];

/** Which stage a phase belongs to, so an unmapped phase still renders quietly. */
const STAGE_OF_PHASE: ReadonlyMap<ResolutionPhase, number> = new Map(
  STAGES.flatMap((stage, index) => stage.phases.map((phase) => [phase, index] as const)),
);

/**
 * The stage the store is really in.
 *
 * These four strings are the only values `resolveStatus` takes, dispatched by
 * `endQuarter` in the game provider. Anything else — an empty status on the
 * first frame — reads as the opening stage rather than as an error.
 */
function stageOfStatus(status: string): number {
  if (status.startsWith('Consulting')) return 1;
  if (status.startsWith('Rival')) return 2;
  if (status.startsWith('Resolving')) return 3;
  return 0;
}

const PHASE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  RESOLUTION_PHASES.map((phase) => [phase, phase.replace(/_/g, ' ').replace(/^\w/, (character) => character.toUpperCase())]),
);

/* -------------------------------------------------------------------------- */
/*  The overlay                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `resolveStatus` is one headline line — the four/five strings
 * `stageOfStatus` recognises — followed by zero or more progress-row lines
 * from `formatProgressStatus` (`lib/game/resolveProgress.ts`): `"World
 * Director · done (2.1s)"`, `"Aletheia Labs strategist · 41s"`, `"Basalt
 * Compute strategist · on policy (budget)"`. Split once, here, so the
 * headline drives the existing stage detection unchanged and the rows get
 * their own list instead of being jammed into one paragraph.
 */
function splitStatus(status: string): { headline: string; rows: readonly string[] } {
  const lines = status.split('\n');
  return { headline: lines[0] ?? '', rows: lines.slice(1).filter((line) => line.length > 0) };
}

/** A progress row's tone, read off the punctuation `formatProgressLine` already put there — no parallel state to keep in sync. */
function toneOfProgressRow(row: string): 'pending' | 'running' | 'done' | 'skipped' {
  if (!row.includes(' · ')) return 'pending';
  if (row.includes('on policy') || row.includes('· skipped')) return 'skipped';
  if (row.includes(' · done')) return 'done';
  return 'running';
}

export function ResolvingOverlay(): React.JSX.Element | null {
  const { resolving, status } = useResolving();
  const { loading, progress } = useLoading();
  if (!resolving && !loading) return null;

  const { headline, rows: progressRows } = splitStatus(status);
  const heading = resolving ? 'Resolving quarter' : 'Replaying your session';
  const detail = resolving
    ? headline === ''
      ? 'Working'
      : headline
    : progress === null
      ? 'Reading the save'
      : `Quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`;

  const stageIndex = resolving ? stageOfStatus(headline) : -1;
  /* The engine stage covers both operating groups, so the last tile lights with
     it rather than pretending the market has not been reached yet. */
  const lastActive = stageIndex === 3 ? 4 : stageIndex;
  const stage = STAGES[stageIndex] ?? null;

  const share = resolving
    ? (lastActive + 1) / STAGES.length
    : progress !== null && progress.total > 0
      ? progress.completed / progress.total
      : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-base/90 px-3 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="panel-surface animate-pop-in flex max-h-[calc(100dvh-24px)] w-[min(480px,100%)] flex-col overflow-y-auto p-4 sm:p-5">
        {/* --- who is speaking ------------------------------------------- */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="label-caps text-brand">{heading}</span>
          <span className="figure text-[10px] text-ink-faint">
            {resolving ? `${RESOLUTION_PHASES.length} phases` : progress === null ? '' : `Q${progress.quarter}`}
          </span>
        </div>
        <p className="mt-1 text-[13px] font-semibold text-ink">{detail}</p>

        {/* --- the vignette ----------------------------------------------- */}
        {/* Hidden from the a11y tree: the caption under it says the same thing
            in words, and this sits inside a live region. */}
        <div className="scene-frame mt-3 bg-sky/60" aria-hidden="true">
          <div key={stage?.id ?? 'replay'} className="animate-fade-in flex items-center justify-center px-3 py-2">
            <Vignette id={stage?.id ?? 'desk'} className="h-[104px] w-full max-w-[248px]" />
          </div>
        </div>
        <p className="mt-2 min-h-[32px] text-[11px] leading-relaxed text-ink-dim">
          {stage === null
            ? 'Every recorded decision is being replayed against the same seed. The hash at the end has to match, or the save is not this session.'
            : stage.caption}
        </p>

        {/* --- the friendly bar -------------------------------------------- */}
        <div className="mt-2 h-2 w-full overflow-hidden rounded-pill bg-raised">
          {share === null ? (
            <div className="animate-pulse-soft h-full w-1/3 rounded-pill bg-brand" />
          ) : (
            <div
              className="h-full rounded-pill bg-brand transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(6, Math.round(share * 100))}%` }}
            />
          )}
        </div>

        {/* --- the stage strip ---------------------------------------------- */}
        {resolving ? (
          <ol className="mt-3 grid grid-cols-5 gap-1.5" aria-label="Resolution stages">
            {STAGES.map((entry, index) => {
              const state = index < stageIndex ? 'done' : index <= lastActive ? 'active' : 'waiting';
              return (
                <li
                  key={entry.id}
                  className={[
                    'flex min-w-0 flex-col items-center gap-1 rounded-card border px-1 py-1.5 transition-colors',
                    state === 'active'
                      ? 'border-brand/40 bg-brand-wash'
                      : state === 'done'
                        ? 'border-hair bg-gain-wash'
                        : 'border-hair bg-raised',
                  ].join(' ')}
                  aria-current={state === 'active' ? 'step' : undefined}
                >
                  <span aria-hidden="true" className="block w-full">
                    <Vignette id={entry.id} className={state === 'waiting' ? 'h-7 w-full opacity-45' : 'h-7 w-full'} />
                  </span>
                  <span
                    className={[
                      'w-full truncate text-center text-[9px] leading-tight font-semibold',
                      state === 'active' ? 'text-brand' : state === 'done' ? 'text-gain' : 'text-ink-faint',
                    ].join(' ')}
                  >
                    {entry.title}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {/* --- the phases, streaming --------------------------------------- */}
        {resolving ? (
          /* Deliberately not keyed on the stage: re-mounting inside a live
             region would re-announce all eighteen names on every step. The
             stream plays once, on arrival, and the marks update in place. */
          <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-0.5" aria-label="Resolution phases">
            {RESOLUTION_PHASES.map((phase, index) => {
              const owner = STAGE_OF_PHASE.get(phase) ?? STAGES.length;
              const state = owner < stageIndex ? 'done' : owner <= lastActive ? 'active' : 'waiting';
              return (
                <li
                  key={phase}
                  className="animate-fade-in flex min-w-0 items-center gap-1.5"
                  style={{ animationDelay: `${index * 18}ms` }}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      'inline-block size-1.5 shrink-0 rounded-pill',
                      state === 'active' ? 'animate-pulse-soft bg-brand' : state === 'done' ? 'bg-gain' : 'bg-hair-strong',
                    ].join(' ')}
                  />
                  <span
                    className={[
                      'min-w-0 truncate text-[10px]',
                      state === 'active' ? 'text-ink' : state === 'done' ? 'text-ink-dim' : 'text-ink-faint',
                    ].join(' ')}
                  >
                    {PHASE_LABEL[phase] ?? phase}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* --- what is actually happening right now, with elapsed time ------ */}
        {/* A real list, not a frozen spinner: the World Director, each rival
            strategist in priority order and the deterministic engine pass each
            get their own line, moving from waiting to running to done — or to
            "on policy (budget)" when the quarter's model-time budget ran out
            before that rival's turn. See `formatProgressStatus`. */}
        {resolving && progressRows.length > 0 ? (
          // `aria-hidden`: the outer `role="status"` region already announces
          // `detail` (the headline) on every stage change: a screen reader
          // does not need every tick of every row's elapsed-seconds counter
          // re-announced once a second for the whole resolve.
          <ul className="mt-3 space-y-1 border-t border-hair pt-2" aria-hidden="true">
            {progressRows.map((row, index) => {
              const tone = toneOfProgressRow(row);
              return (
                <li key={`${index}-${row}`} className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={[
                      'inline-block size-1.5 shrink-0 rounded-pill',
                      tone === 'running' ? 'animate-pulse-soft bg-brand' : tone === 'done' ? 'bg-gain' : tone === 'skipped' ? 'bg-loss' : 'bg-hair-strong',
                    ].join(' ')}
                  />
                  <span
                    className={[
                      'min-w-0 truncate text-[11px]',
                      tone === 'running' ? 'text-ink' : tone === 'done' ? 'text-ink-dim' : tone === 'skipped' ? 'text-loss' : 'text-ink-faint',
                    ].join(' ')}
                  >
                    {row}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        <p className="mt-3 border-t border-hair pt-2 text-[10px] leading-relaxed text-ink-faint">
          Same state, same decisions, same seed — the same outcome, every time.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Flat-vector vignettes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Five little scenes, all on the same 96×64 stage.
 *
 * Flat fills only, every colour a token, nothing random: these draw identically
 * on every machine and every run. The idle motion is a bob or a sway, which
 * `globals.css` turns off wholesale under `prefers-reduced-motion`.
 */
function Vignette({ id, className }: { readonly id: VignetteId; readonly className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 96 64" className={className} role="img" aria-label={LABEL_OF[id]} preserveAspectRatio="xMidYMid meet">
      {id === 'globe' ? <Globe /> : null}
      {id === 'ticker' ? <Ticker /> : null}
      {id === 'office' ? <Office /> : null}
      {id === 'podium' ? <Podium /> : null}
      {id === 'desk' ? <Desk /> : null}
    </svg>
  );
}

const LABEL_OF: Readonly<Record<VignetteId, string>> = {
  desk: 'A desk of queued instructions with a seal and a pen',
  globe: 'A globe with an orbiting satellite',
  podium: 'A speaker at a podium with two seated figures',
  office: 'Your office building with two people outside it',
  ticker: 'A ticker tape carrying a rising and a falling line',
};

const INK = 'var(--color-ink)';
const GROUND = 'var(--color-ground)';

function Ground(): React.JSX.Element {
  return <rect x="0" y="52" width="96" height="12" rx="4" fill={GROUND} />;
}

function Globe(): React.JSX.Element {
  return (
    <g>
      <Ground />
      <g className="animate-bob-slow">
        <circle cx="48" cy="30" r="20" fill="var(--color-info-wash)" stroke="var(--color-info)" strokeWidth="1.6" />
        <path d="M33 24c6 3 11 2 16-1 4-2 9-2 13 1v6c-5-2-9-1-13 1-6 3-11 3-16 0Z" fill="var(--color-gain)" />
        <path d="M38 40c4-3 9-3 13-1 3 2 6 2 9 1l-3 5c-4 1-8 0-11-1-3-1-6-1-8 1Z" fill="var(--color-gain)" opacity="0.85" />
        <ellipse cx="48" cy="30" rx="26" ry="9" fill="none" stroke="var(--color-brand)" strokeWidth="1.4" strokeDasharray="3 4" />
        <circle cx="74" cy="30" r="3" fill="var(--color-brand)" />
      </g>
      <circle cx="16" cy="14" r="2.5" fill="var(--color-pop-8)" className="animate-bob" />
      <circle cx="82" cy="12" r="2" fill="var(--color-pop-4)" className="animate-bob-slow" />
    </g>
  );
}

function Ticker(): React.JSX.Element {
  return (
    <g>
      <Ground />
      <rect x="6" y="14" width="84" height="34" rx="8" fill="var(--color-panel)" stroke="var(--color-hair-strong)" strokeWidth="1.4" />
      <g fill="var(--color-hair)">
        {[10, 18, 26, 34, 42, 50, 58, 66, 74, 82].map((x) => (
          <rect key={`t${x}`} x={x} y="15.5" width="4" height="2" rx="1" />
        ))}
        {[10, 18, 26, 34, 42, 50, 58, 66, 74, 82].map((x) => (
          <rect key={`b${x}`} x={x} y="44.5" width="4" height="2" rx="1" />
        ))}
      </g>
      <polyline points="12,38 24,32 34,35 46,24 58,28 70,20 84,23" fill="none" stroke="var(--color-gain)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="12,30 24,34 34,31 46,39 58,36 70,41 84,38" fill="none" stroke="var(--color-loss)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 3" />
      <circle cx="84" cy="23" r="3" fill="var(--color-gain)" className="animate-pulse-soft" />
      <circle cx="12" cy="30" r="2.4" fill="var(--color-loss)" />
    </g>
  );
}

function Office(): React.JSX.Element {
  return (
    <g>
      <Ground />
      <rect x="20" y="12" width="40" height="40" rx="6" fill="var(--color-build-face)" />
      <rect x="60" y="18" width="18" height="34" rx="5" fill="var(--color-build-side)" />
      <rect x="18" y="8" width="44" height="6" rx="3" fill="var(--color-build-roof)" />
      <g fill="var(--color-build-glass)">
        <rect x="25" y="19" width="9" height="7" rx="2" />
        <rect x="38" y="19" width="9" height="7" rx="2" />
        <rect x="25" y="31" width="9" height="7" rx="2" />
        <rect x="51" y="19" width="6" height="7" rx="2" />
        <rect x="64" y="25" width="9" height="7" rx="2" />
        <rect x="64" y="37" width="9" height="7" rx="2" />
      </g>
      <rect x="38" y="31" width="9" height="7" rx="2" fill="var(--color-pop-4)" />
      <rect x="51" y="31" width="6" height="7" rx="2" fill="var(--color-pop-4)" opacity="0.7" />
      <Person x={10} y={34} cloth="var(--color-cloth-hoodie)" skin="var(--color-skin-2)" hair="var(--color-hair-1)" className="animate-bob" />
      <Person x={84} y={36} cloth="var(--color-cloth-lab)" skin="var(--color-skin-4)" hair="var(--color-hair-2)" className="animate-bob-slow" />
    </g>
  );
}

function Podium(): React.JSX.Element {
  return (
    <g>
      <Ground />
      <rect x="6" y="10" width="26" height="16" rx="4" fill="var(--color-brand-wash)" stroke="var(--color-brand)" strokeWidth="1.2" className="animate-sway" />
      <Person x={48} y={22} cloth="var(--color-cloth-suit)" skin="var(--color-skin-3)" hair="var(--color-hair-6)" className="animate-bob-slow" />
      <rect x="36" y="34" width="24" height="18" rx="4" fill="var(--color-cloth-suit)" />
      <rect x="40" y="39" width="16" height="3" rx="1.5" fill="var(--color-build-glass)" />
      <rect x="40" y="44" width="10" height="2.5" rx="1.25" fill="var(--color-build-glass)" opacity="0.7" />
      <Person x={16} y={36} cloth="var(--color-cloth-suit)" skin="var(--color-skin-1)" hair="var(--color-hair-4)" scale={0.8} className="animate-bob" />
      <Person x={80} y={36} cloth="var(--color-cloth-suit)" skin="var(--color-skin-5)" hair="var(--color-hair-1)" scale={0.8} className="animate-bob-slow" />
    </g>
  );
}

function Desk(): React.JSX.Element {
  return (
    <g>
      <Ground />
      <rect x="8" y="34" width="80" height="8" rx="4" fill="var(--color-build-side)" />
      <rect x="16" y="42" width="5" height="10" rx="2.5" fill="var(--color-build-roof)" />
      <rect x="75" y="42" width="5" height="10" rx="2.5" fill="var(--color-build-roof)" />
      <g className="animate-bob-slow">
        <rect x="22" y="16" width="30" height="20" rx="4" fill="var(--color-panel)" stroke="var(--color-hair-strong)" strokeWidth="1.3" />
        <rect x="27" y="21" width="20" height="2" rx="1" fill="var(--color-hair)" />
        <rect x="27" y="26" width="16" height="2" rx="1" fill="var(--color-hair)" />
        <rect x="27" y="31" width="12" height="2" rx="1" fill="var(--color-hair)" />
      </g>
      <rect x="48" y="20" width="26" height="16" rx="4" fill="var(--color-panel)" stroke="var(--color-hair)" strokeWidth="1.2" />
      <circle cx="66" cy="28" r="6" fill="var(--color-brand-wash)" stroke="var(--color-brand)" strokeWidth="1.6" />
      <circle cx="66" cy="28" r="2" fill="var(--color-brand)" className="animate-pulse-soft" />
      <path d="M12 32l8-14 3 2-8 14-4 2Z" fill={INK} opacity="0.75" />
    </g>
  );
}

/** A round-headed flat-vector person: circle head, flat hair, pill body. */
function Person({
  x,
  y,
  cloth,
  skin,
  hair,
  scale = 1,
  className,
}: {
  readonly x: number;
  readonly y: number;
  readonly cloth: string;
  readonly skin: string;
  readonly hair: string;
  readonly scale?: number;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} className={className}>
      <rect x="-6" y="4" width="12" height="16" rx="5" fill={cloth} />
      <circle cx="0" cy="-2" r="6" fill={skin} />
      <path d="M-6 -3a6 6 0 0 1 12 0c-2-2-4-2.6-6-2.6S-4 -5-6 -3Z" fill={hair} />
      <circle cx="-2.2" cy="-1.5" r="0.9" fill={INK} />
      <circle cx="2.2" cy="-1.5" r="0.9" fill={INK} />
      <path d="M-2 1.6c1.3 1.2 2.7 1.2 4 0" fill="none" stroke={INK} strokeWidth="0.9" strokeLinecap="round" />
    </g>
  );
}

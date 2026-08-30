'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SESSION_DIFFICULTIES, quarterLabel, type SessionDifficulty } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { DEMO_SEED, readSaveFile, useGame, useGameActions, useLlm, useLoading } from '@/lib/game';
import { HOME_ROUTE, NAV_GROUPS } from '@/lib/nav';
import { isSupabaseConfigured } from '@/lib/supabase/config';
import { Panel, Tag, cx } from '@/components/ui';

const DIFFICULTY_BLURB: Readonly<Record<SessionDifficulty, string>> = {
  sandbox: 'A quiet world. Two events a quarter at most, and rivals that rarely reach for your throat.',
  standard: 'The intended game. Three events a quarter, rivals that plan, and a market that reprices you honestly.',
  hard: 'A loud world. Four events a quarter and rivals that take the opening you leave them.',
  brutal: 'Five events a quarter, the full impact budget, and no allowance for a slow start.',
};

/* -------------------------------------------------------------------------- */
/*  Illustration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The hero: a flat-vector company town.
 *
 * Every colour is a token, every shape is a rounded primitive, and the only
 * motion is a bob and a sway on two decorative groups — both switched off by
 * `prefers-reduced-motion` in `globals.css`. It scales inside its container, so
 * a 390px phone gets the whole picture rather than a horizontal scrollbar.
 */
function CompanyTown(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 480 330"
      className="h-auto w-full"
      role="img"
      aria-label="A cartoon city block: your headquarters tower beside rival offices, a rising revenue line above them, and two founders standing out front."
    >
      {/* sky */}
      <rect x="0" y="0" width="480" height="330" rx="20" fill="var(--color-sky)" />

      {/* sun and clouds */}
      <circle cx="405" cy="56" r="26" fill="var(--color-pop-4)" opacity="0.85" />
      <g fill="var(--color-panel)" opacity="0.9">
        <rect x="52" y="52" width="86" height="26" rx="13" />
        <circle cx="76" cy="52" r="16" />
        <circle cx="106" cy="46" r="21" />
        <rect x="250" y="88" width="64" height="20" rx="10" />
        <circle cx="272" cy="88" r="13" />
        <circle cx="296" cy="84" r="16" />
      </g>

      {/* ground */}
      <path d="M0 252 H480 V310 a20 20 0 0 1 -20 20 H20 a20 20 0 0 1 -20 -20 Z" fill="var(--color-ground)" />
      <rect x="0" y="252" width="480" height="7" fill="var(--color-build-side)" opacity="0.55" />

      {/* --- the skyline ------------------------------------------------- */}
      {/* a rival, low and wide */}
      <g>
        <rect x="26" y="142" width="70" height="110" rx="12" fill="var(--color-build-side)" />
        <rect x="34" y="156" width="16" height="18" rx="5" fill="var(--color-build-glass)" />
        <rect x="58" y="156" width="16" height="18" rx="5" fill="var(--color-build-glass)" />
        <rect x="34" y="186" width="16" height="18" rx="5" fill="var(--color-build-glass)" />
        <rect x="58" y="186" width="16" height="18" rx="5" fill="var(--color-build-glass)" />
        <rect x="34" y="216" width="40" height="18" rx="5" fill="var(--color-build-glass)" opacity="0.7" />
      </g>

      {/* your headquarters, the tall one */}
      <g>
        <rect x="112" y="72" width="88" height="180" rx="14" fill="var(--color-brand)" />
        <rect x="112" y="72" width="88" height="26" rx="14" fill="var(--color-brand-strong)" />
        <rect x="112" y="86" width="88" height="12" fill="var(--color-brand-strong)" />
        <g fill="var(--color-panel)" opacity="0.92">
          <rect x="126" y="112" width="18" height="20" rx="5" />
          <rect x="152" y="112" width="18" height="20" rx="5" />
          <rect x="178" y="112" width="8" height="20" rx="4" />
          <rect x="126" y="144" width="18" height="20" rx="5" />
          <rect x="152" y="144" width="18" height="20" rx="5" />
          <rect x="178" y="144" width="8" height="20" rx="4" />
          <rect x="126" y="176" width="44" height="20" rx="5" opacity="0.75" />
        </g>
        <rect x="140" y="212" width="32" height="40" rx="8" fill="var(--color-panel)" opacity="0.9" />
        <text x="156" y="90" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--color-panel)" fontFamily="var(--font-mono)">
          FC
        </text>
        {/* the flag on the roof */}
        <g className="animate-sway" style={{ transformOrigin: '156px 72px' }}>
          <rect x="154" y="40" width="3" height="34" rx="1.5" fill="var(--color-ink-faint)" />
          <path d="M157 42 L186 50 L157 60 Z" fill="var(--color-gain)" />
        </g>
      </g>

      {/* two more rivals */}
      <g>
        <rect x="216" y="164" width="66" height="88" rx="12" fill="var(--color-build-face)" />
        <rect x="228" y="180" width="16" height="16" rx="5" fill="var(--color-build-glass)" />
        <rect x="252" y="180" width="16" height="16" rx="5" fill="var(--color-build-glass)" />
        <rect x="228" y="206" width="40" height="16" rx="5" fill="var(--color-build-glass)" opacity="0.7" />
      </g>
      <g>
        <rect x="298" y="126" width="60" height="126" rx="12" fill="var(--color-build-roof)" />
        <g fill="var(--color-build-glass)">
          <rect x="310" y="142" width="14" height="16" rx="4" />
          <rect x="332" y="142" width="14" height="16" rx="4" />
          <rect x="310" y="168" width="14" height="16" rx="4" />
          <rect x="332" y="168" width="14" height="16" rx="4" />
          <rect x="310" y="194" width="36" height="16" rx="4" opacity="0.7" />
        </g>
      </g>
      <g>
        <rect x="374" y="176" width="80" height="76" rx="12" fill="var(--color-build-side)" />
        <rect x="386" y="192" width="18" height="16" rx="5" fill="var(--color-build-glass)" />
        <rect x="412" y="192" width="18" height="16" rx="5" fill="var(--color-build-glass)" />
        <rect x="386" y="218" width="44" height="16" rx="5" fill="var(--color-build-glass)" opacity="0.7" />
      </g>

      {/* --- the tape that runs above the town ---------------------------- */}
      <polyline
        points="40,232 108,206 176,214 244,168 312,150 396,104"
        fill="none"
        stroke="var(--color-gain)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M396 104 l-22 3 l14 14 Z" fill="var(--color-gain)" transform="rotate(-32 396 104)" />
      <circle cx="108" cy="206" r="5" fill="var(--color-gain)" stroke="var(--color-panel)" strokeWidth="2.5" />
      <circle cx="244" cy="168" r="5" fill="var(--color-gain)" stroke="var(--color-panel)" strokeWidth="2.5" />

      {/* a coin, bobbing */}
      <g className="animate-bob">
        <circle cx="424" cy="150" r="17" fill="var(--color-pop-4)" />
        <circle cx="424" cy="150" r="12" fill="var(--color-warn-strong)" opacity="0.25" />
        <text x="424" y="156" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--color-panel)">
          $
        </text>
      </g>

      {/* --- the founders -------------------------------------------------- */}
      {/* the one in the suit */}
      <g className="animate-bob-slow">
        <rect x="98" y="268" width="52" height="56" rx="20" fill="var(--color-cloth-suit)" />
        <path d="M124 268 l-11 8 l11 16 l11 -16 Z" fill="var(--color-panel)" />
        <rect x="120" y="278" width="8" height="18" rx="4" fill="var(--color-brand)" />
        <circle cx="124" cy="246" r="19" fill="var(--color-skin-2)" />
        <path d="M105 243 a19 19 0 0 1 38 0 q-19 -11 -38 0 Z" fill="var(--color-hair-2)" />
        <circle cx="117" cy="247" r="2.2" fill="var(--color-ink)" />
        <circle cx="131" cy="247" r="2.2" fill="var(--color-ink)" />
        <path d="M118 255 q6 5 12 0" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" fill="none" />
      </g>

      {/* the one in the hoodie */}
      <g className="animate-bob">
        <rect x="330" y="272" width="50" height="52" rx="19" fill="var(--color-cloth-hoodie)" />
        <path d="M340 274 q15 12 30 0" stroke="var(--color-panel)" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="355" cy="252" r="18" fill="var(--color-skin-4)" />
        <path d="M337 250 a18 18 0 0 1 36 0 q-18 -13 -36 0 Z" fill="var(--color-hair-1)" />
        <circle cx="349" cy="253" r="2.2" fill="var(--color-ink)" />
        <circle cx="362" cy="253" r="2.2" fill="var(--color-ink)" />
        <path d="M349 261 q6 5 12 0" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" fill="none" />
      </g>

      {/* a small planter, because every office has one */}
      <g className="animate-sway" style={{ transformOrigin: '444px 312px' }}>
        <path d="M444 300 q-14 -8 -10 -24 q13 4 10 24 Z" fill="var(--color-pop-6)" />
        <path d="M444 302 q14 -10 12 -26 q-15 6 -12 26 Z" fill="var(--color-pop-2)" />
        <path d="M434 300 h20 l-3 16 h-14 Z" fill="var(--color-pop-7)" />
      </g>
    </svg>
  );
}

/** A flat glyph for a feature card. Shapes only — no letter monograms. */
function FlatIcon({ name }: { readonly name: 'engine' | 'people' | 'market' }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" fill="none">
      {name === 'engine' ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="5" fill="var(--color-brand-wash)" stroke="var(--color-brand)" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="3.2" fill="var(--color-brand)" />
          <path d="M12 4v2.4M12 17.6V20M3 12h2.4M18.6 12H21" stroke="var(--color-brand)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : null}
      {name === 'people' ? (
        <>
          <circle cx="9" cy="8.5" r="3.4" fill="var(--color-pop-5)" />
          <circle cx="16.5" cy="9.5" r="2.6" fill="var(--color-pop-2)" />
          <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="var(--color-pop-5)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M15 19c0-2.2 1.6-3.6 3.4-3.6 1.3 0 2.1.5 2.1.5" stroke="var(--color-pop-2)" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : null}
      {name === 'market' ? (
        <>
          <rect x="3" y="14" width="4" height="6" rx="2" fill="var(--color-gain)" />
          <rect x="10" y="10" width="4" height="10" rx="2" fill="var(--color-info)" />
          <rect x="17" y="5" width="4" height="15" rx="2" fill="var(--color-warn)" />
        </>
      ) : null}
    </svg>
  );
}

const FEATURES = [
  {
    icon: 'engine' as const,
    title: 'One deterministic engine',
    body: 'Same state, same decisions, same seed — the same quarter, every time. Models propose; only the engine makes reality.',
  },
  {
    icon: 'people' as const,
    title: 'Everyone wants something',
    body: 'Sixteen people with goals, memory and agency. Directors you have to keep, rivals who take the opening you leave.',
  },
  {
    icon: 'market' as const,
    title: 'Markets price belief',
    body: 'What you know is not what the tape knows. The gap between the two is where the whole game is played.',
  },
];

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function LandingPage(): React.JSX.Element {
  const router = useRouter();
  const { hydrated, session } = useGame();
  const { newGame, loadGame } = useGameActions();
  const llm = useLlm();
  const { loading, progress } = useLoading();

  const [seedText, setSeedText] = useState(String(DEMO_SEED));
  const [difficulty, setDifficulty] = useState<SessionDifficulty>('standard');
  const [save, setSave] = useState<ReturnType<typeof readSaveFile>>(null);
  const [showMultiplayer, setShowMultiplayer] = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (hydrated) setSave(readSaveFile());
  }, [hydrated]);

  const seed = useMemo(() => {
    const parsed = Number.parseInt(seedText, 10);
    return Number.isFinite(parsed) ? parsed : DEMO_SEED;
  }, [seedText]);

  /** What a resume actually costs: quarters after the newest checkpoint, not the whole log. */
  const replayDepth = useMemo(() => {
    if (save === null) return 0;
    const from = save.checkpoint?.quarter ?? 0;
    return save.log.filter((record) => record.quarter >= from).length;
  }, [save]);

  const supabaseReady = isSupabaseConfigured();

  function startNewGame(): void {
    newGame({ seed, difficulty });
    router.push(HOME_ROUTE);
  }

  async function continueGame(): Promise<void> {
    setResuming(true);
    try {
      await loadGame();
      // A partial replay still lands the player in the session it produced; the
      // shell carries the notice explaining that the save was left untouched.
      router.push(HOME_ROUTE);
    } finally {
      setResuming(false);
    }
  }

  return (
    <div className="min-h-dvh bg-base">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-10 px-5 py-10 sm:py-14">
        {/* --- masthead ---------------------------------------------------- */}
        <header className="flex items-center gap-3">
          <span className="figure flex size-9 items-center justify-center rounded-chip bg-brand-strong text-[12px] font-bold text-white shadow-card">
            FC
          </span>
          <div>
            <div className="text-[14px] font-extrabold tracking-tight text-ink">Frontier Capital</div>
            <div className="label-caps-faint leading-none">An AI-industry business sim</div>
          </div>
        </header>

        {/* --- hero -------------------------------------------------------- */}
        <section className="grid items-center gap-8 lg:grid-cols-[1.05fr_1fr]">
          <div className="animate-pop-in flex min-w-0 flex-col gap-4">
            <span className="label-caps inline-flex w-fit items-center rounded-pill bg-brand-wash px-3 py-1 text-brand">
              2027 Q1 · eight people · one thesis
            </span>
            <h1 className="max-w-2xl text-[32px] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[42px]">
              Found a company. Outthink everybody else in the industry.
            </h1>
            <p className="max-w-2xl text-[14px] leading-relaxed text-ink-dim">
              You start with <span className="figure font-semibold text-ink">{formatMoney(4_000_000)}</span>, eight people and one thesis,
              on connection level <span className="figure font-semibold text-ink">24</span> — in a world where the sovereign fund&rsquo;s
              chief investment officer sits on <span className="figure font-semibold text-ink">93</span>. Everything this game is about is
              visible in that gap on the very first screen.
            </p>

            <div className="mt-1 flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-primary btn-lg press-pop" onClick={startNewGame}>
                Start a new company
              </button>
              {save !== null ? (
                <button
                  type="button"
                  className="btn btn-lg press-pop"
                  onClick={() => void continueGame()}
                  disabled={resuming || loading}
                >
                  {resuming || loading ? 'Replaying…' : `Continue ${quarterLabel(2027, save.savedQuarter)}`}
                </button>
              ) : null}
            </div>

            <p className="text-[11.5px] text-ink-faint">
              Seven companies, sixteen people, a seventeen-node Frontier Map and two open procurements — all running locally in this
              browser. No sign-up needed.
            </p>
          </div>

          <div className="animate-pop-in stagger-2 min-w-0">
            <div className="scene-frame panel-surface p-3">
              <CompanyTown />
            </div>
          </div>
        </section>

        {/* --- three promises ---------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map((feature, index) => (
            <div
              key={feature.title}
              className={cx('panel-surface animate-pop-in hover-lift p-4', `stagger-${index + 1}`)}
            >
              <span className="flex size-9 items-center justify-center rounded-chip bg-raised">
                <FlatIcon name={feature.icon} />
              </span>
              <h2 className="mt-3 text-[14px] font-bold text-ink">{feature.title}</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{feature.body}</p>
            </div>
          ))}
        </section>

        {/* --- entry points ------------------------------------------------ */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Session setup" subtitle="The two dials that decide what world you get" className="lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-[170px_1fr]">
              <label className="block">
                <span className="label-caps-faint">Seed</span>
                <input
                  className="field mt-1"
                  value={seedText}
                  onChange={(event) => setSeedText(event.target.value.replace(/[^\d-]/g, ''))}
                  inputMode="numeric"
                  aria-label="Session seed"
                />
                <span className="mt-1.5 block text-[10px] text-ink-faint">
                  The same seed and the same decisions always produce the same world.
                </span>
              </label>

              <fieldset className="min-w-0">
                <legend className="label-caps-faint">Difficulty</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {SESSION_DIFFICULTIES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={difficulty === option}
                      onClick={() => setDifficulty(option)}
                      className={cx(
                        'btn press-pop capitalize',
                        difficulty === option ? 'border-brand bg-brand-wash text-brand' : '',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-dim">{DIFFICULTY_BLURB[difficulty]}</p>
              </fieldset>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-hair pt-4">
              <button type="button" className="btn btn-primary press-pop" onClick={startNewGame}>
                Found Player Ventures — 2027 Q1
              </button>
              <span className="text-[11px] text-ink-faint">Seed {seed}, {difficulty} world.</span>
            </div>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel title="Continue">
              {!hydrated ? (
                <p className="text-[12px] text-ink-faint">Checking this browser for a saved session…</p>
              ) : save === null ? (
                <p className="text-[12px] text-ink-faint">
                  No saved session in this browser. A session saves itself after every quarter you resolve.
                </p>
              ) : (
                <>
                  <dl className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2 border-b border-hair pb-1.5">
                      <dt className="label-caps-faint">Quarter</dt>
                      <dd className="figure text-[12px] font-semibold text-ink">{quarterLabel(2027, save.savedQuarter)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-b border-hair pb-1.5">
                      <dt className="label-caps-faint">Seed</dt>
                      <dd className="figure text-[12px] font-semibold text-ink">{save.seed}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="label-caps-faint">Difficulty</dt>
                      <dd className="text-[12px] font-semibold text-ink capitalize">{save.difficulty}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="btn press-pop mt-3.5 w-full"
                    onClick={() => void continueGame()}
                    disabled={resuming || loading}
                  >
                    {resuming || loading
                      ? progress === null
                        ? 'Replaying…'
                        : `Replaying quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`
                      : `Resume — replays ${replayDepth} quarter${replayDepth === 1 ? '' : 's'}`}
                  </button>
                  <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                    Saves store the seed, your decisions and what the model contributed — not the world. Loading re-resolves them from the
                    last checkpoint.
                  </p>
                </>
              )}
            </Panel>

            <Panel title="Multiplayer">
              <div className="flex items-center justify-between gap-2">
                <Tag tone={supabaseReady ? 'gain' : 'neutral'} dot>
                  {supabaseReady ? 'Supabase configured' : 'Not configured'}
                </Tag>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowMultiplayer((value) => !value)}>
                  {showMultiplayer ? 'Hide' : 'Setup'}
                </button>
              </div>

              {supabaseReady ? (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-[11.5px] text-ink-dim">Sign in to join a shared world with other founders.</p>
                  <div className="flex gap-2">
                    <Link href="/sign-in" className="btn flex-1">
                      Sign in
                    </Link>
                    <Link href="/sign-up" className="btn btn-primary flex-1">
                      Sign up
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[11.5px] leading-relaxed text-ink-dim">
                  Demo mode runs the full game locally — same engine, same invariants. Shared sessions need a Supabase project.
                </p>
              )}

              {showMultiplayer ? (
                <div className="animate-rise mt-3 rounded-card border border-hair bg-raised p-3">
                  <p className="label-caps-faint mb-1.5">Set in .env.local</p>
                  <pre className="figure overflow-x-auto text-[10px] leading-relaxed text-ink-dim">
{`NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=`}
                  </pre>
                  <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                    Then apply <span className="figure">supabase/migrations</span> and seed with{' '}
                    <span className="figure">supabase/seed.sql</span>, which loads this same world.
                  </p>
                </div>
              ) : null}
            </Panel>
          </div>
        </div>

        {/* --- what is in there -------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[16px] font-extrabold tracking-tight text-ink">Eighteen screens, one company</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="panel-surface hover-lift p-4">
                <div className="label-caps mb-2.5 text-brand">{group.label}</div>
                <ul className="space-y-2">
                  {group.items.map((item) => (
                    <li key={item.href} className="min-w-0">
                      <Link href={item.href} className="block truncate text-[12.5px] font-semibold text-ink hover:text-brand">
                        {item.label}
                      </Link>
                      <span className="block truncate text-[10.5px] text-ink-faint">{item.blurb}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* --- footer ------------------------------------------------------ */}
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-4 text-[10.5px] text-ink-faint">
          <span>Engine: deterministic, in-browser, {session.companies.length} companies loaded.</span>
          <span className="flex items-center gap-1.5">
            <span className={cx('inline-block size-2 rounded-pill', llm.available ? 'bg-gain' : 'bg-ink-faint')} />
            {llm.available
              ? `Live model configured (${llm.transportKind}${llm.model === null ? '' : `, ${llm.model}`}).`
              : 'No model configured — every role falls back deterministically and the game plays in full.'}
          </span>
        </footer>
      </div>
    </div>
  );
}

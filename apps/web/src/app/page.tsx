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
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 px-5 py-10 sm:py-16">
        {/* --- masthead ---------------------------------------------------- */}
        <header className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="figure flex size-8 items-center justify-center rounded-[4px] border border-brand/40 bg-brand-wash text-[11px] font-semibold text-brand">
              FC
            </span>
            <div className="label-caps tracking-[0.28em]">Frontier Capital</div>
          </div>
          <h1 className="max-w-3xl text-[30px] leading-[1.15] font-semibold tracking-tight text-ink sm:text-[38px]">
            Every important company and character has goals, memory and agency.
          </h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-ink-dim">
            A persistent AI-industry economy resolved one quarter at a time by a deterministic engine. You start with{' '}
            <span className="figure text-ink">{formatMoney(4_000_000)}</span>, eight people and one thesis, on connection level 24 in a
            world where the sovereign fund&rsquo;s chief investment officer sits on 93. Everything the game is about is visible in that
            gap on the first screen.
          </p>
          <p className="max-w-2xl text-[12px] text-ink-faint">
            Models are allowed to think, propose, negotiate and reinterpret the future. Only the simulation engine is allowed to make
            reality.
          </p>
        </header>

        {/* --- entry points ------------------------------------------------ */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="New session" className="lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <label className="block">
                <span className="label-caps-faint">Seed</span>
                <input
                  className="field mt-1"
                  value={seedText}
                  onChange={(event) => setSeedText(event.target.value.replace(/[^\d-]/g, ''))}
                  inputMode="numeric"
                  aria-label="Session seed"
                />
                <span className="mt-1 block text-[10px] text-ink-faint">
                  The same seed and the same decisions always produce the same world.
                </span>
              </label>

              <fieldset className="min-w-0">
                <legend className="label-caps-faint">Difficulty</legend>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {SESSION_DIFFICULTIES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDifficulty(option)}
                      className={cx(
                        'btn btn-sm capitalize',
                        difficulty === option ? 'border-brand/50 bg-brand-wash text-brand' : '',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-ink-dim">{DIFFICULTY_BLURB[difficulty]}</p>
              </fieldset>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hair pt-4">
              <button type="button" className="btn btn-primary" onClick={startNewGame}>
                Found Player Ventures — 2027 Q1
              </button>
              <span className="text-[11px] text-ink-faint">
                Seven companies, sixteen people, a seventeen-node Frontier Map and two open procurements.
              </span>
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
                  <dl className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="label-caps-faint">Quarter</dt>
                      <dd className="figure text-[12px] text-ink">{quarterLabel(2027, save.savedQuarter)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="label-caps-faint">Seed</dt>
                      <dd className="figure text-[12px] text-ink">{save.seed}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="label-caps-faint">Difficulty</dt>
                      <dd className="text-[12px] text-ink capitalize">{save.difficulty}</dd>
                    </div>
                  </dl>
                  <button type="button" className="btn mt-3 w-full" onClick={() => void continueGame()} disabled={resuming || loading}>
                    {resuming || loading
                      ? progress === null
                        ? 'Replaying…'
                        : `Replaying quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`
                      : `Resume — replays ${replayDepth} quarter${replayDepth === 1 ? '' : 's'}`}
                  </button>
                  <p className="mt-2 text-[10px] text-ink-faint">
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
                  <p className="text-[11px] text-ink-dim">Sign in to join a shared world with other founders.</p>
                  <div className="flex gap-2">
                    <Link href="/sign-in" className="btn btn-sm flex-1">
                      Sign in
                    </Link>
                    <Link href="/sign-up" className="btn btn-sm flex-1">
                      Sign up
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-ink-faint">
                  Demo mode runs the full game locally — same engine, same invariants. Shared sessions need a Supabase project.
                </p>
              )}

              {showMultiplayer ? (
                <div className="mt-3 rounded-[4px] border border-hair bg-base/60 p-2.5">
                  <p className="label-caps-faint mb-1.5">Set in .env.local</p>
                  <pre className="figure overflow-x-auto text-[10px] leading-relaxed text-ink-dim">
{`NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=`}
                  </pre>
                  <p className="mt-2 text-[10px] text-ink-faint">
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
          <h2 className="label-caps">Eighteen screens</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="panel-surface p-3">
                <div className="label-caps-faint mb-2">{group.label}</div>
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item.href} className="min-w-0">
                      <Link href={item.href} className="block truncate text-[12px] text-ink hover:text-brand">
                        {item.label}
                      </Link>
                      <span className="block truncate text-[10px] text-ink-faint">{item.blurb}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* --- footer ------------------------------------------------------ */}
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-4 text-[10px] text-ink-faint">
          <span>Engine: deterministic, in-browser, {session.companies.length} companies loaded.</span>
          <span className="flex items-center gap-1.5">
            <span className={cx('inline-block size-1.5 rounded-full', llm.available ? 'bg-gain' : 'bg-ink-faint')} />
            {llm.available
              ? `Live model configured (${llm.transportKind}${llm.model === null ? '' : `, ${llm.model}`}).`
              : 'No model configured — every role falls back deterministically and the game plays in full.'}
          </span>
        </footer>
      </div>
    </div>
  );
}

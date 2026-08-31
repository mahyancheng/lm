'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  NEW_GAME_BACKGROUNDS,
  SESSION_DIFFICULTIES,
  quarterLabel,
  type NewGameBackgroundId,
  type SessionDifficulty,
} from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { DEMO_SEED, readSaveFile, useGame, useGameActions, useLlm, useLoading } from '@/lib/game';
import { HOME_ROUTE, NAV_GROUPS } from '@/lib/nav';
import { isSupabaseConfigured } from '@/lib/supabase/config';
import { Icon, IconChip, Panel, Tag, cx, type IconName } from '@/components/ui';

/** The longest a company or founder name may be, mirroring `NewGameSetupSchema`. */
const NAME_MAX = 40;

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
        {/* The house mark on the roof band — the same silhouette the app logo
            draws, not a two-letter monogram. */}
        <g transform="translate(148.4 77) scale(0.62)" fill="var(--color-panel)">
          <path d="M1.8 20.4 8 9.8a1.7 1.7 0 0 1 2.9 0l2.2 3.7 1.6-2.7a1.7 1.7 0 0 1 2.9 0l4 9.6H1.8Z" />
          <circle cx="17.6" cy="5.4" r="3" />
        </g>
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

/**
 * The three promises.
 *
 * Each carries a mark from the set — no bespoke glyph, no monogram. The tone is
 * the chip's tint, so the row reads as three different things rather than three
 * shades of the same thing.
 */
const FEATURES: readonly {
  readonly icon: IconName;
  readonly tone: 'brand' | 'info' | 'gain';
  readonly title: string;
  readonly body: string;
}[] = [
  {
    icon: 'settings',
    tone: 'brand',
    title: 'One deterministic engine',
    body: 'Same state, same decisions, same seed — the same quarter, every time. Models propose; only the engine makes reality.',
  },
  {
    icon: 'people',
    tone: 'info',
    title: 'Everyone wants something',
    body: 'Sixteen people with goals, memory and agency. Directors you have to keep, rivals who take the opening you leave.',
  },
  {
    icon: 'chart',
    tone: 'gain',
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
  const [companyName, setCompanyName] = useState('');
  const [founderName, setFounderName] = useState('');
  const [backgroundId, setBackgroundId] = useState<NewGameBackgroundId>('enterprise_ai');
  const [save, setSave] = useState<ReturnType<typeof readSaveFile>>(null);
  const [showMultiplayer, setShowMultiplayer] = useState(false);
  const [resuming, setResuming] = useState(false);

  const trimmedCompany = companyName.trim();
  const trimmedFounder = founderName.trim();
  const namesValid =
    trimmedCompany.length > 0 && trimmedCompany.length <= NAME_MAX && trimmedFounder.length > 0 && trimmedFounder.length <= NAME_MAX;

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
    if (!namesValid) {
      // A phone may have the button in view before the fields; send the founder
      // to them rather than starting a nameless company.
      document.getElementById('new-company')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    newGame({ seed, difficulty, setup: { companyName: trimmedCompany, founderName: trimmedFounder, backgroundId } });
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
      {/* The phone reads this top to bottom in one column, in the order a
          visitor decides things: who this is, what it is, how to start (or
          resume), then why, then what is inside. `order` puts the entry cards
          above the three promises on a phone and restores the desktop
          composition from `lg`. */}
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 px-4 py-8 sm:px-5 sm:py-12 lg:gap-10">
        {/* --- masthead ---------------------------------------------------- */}
        <header className="order-1 flex items-center gap-3">
          <span className="icon-knockout-brand flex size-9 items-center justify-center rounded-chip bg-brand-strong text-white shadow-card">
            <Icon name="logo" size={20} accent="inherit" />
          </span>
          <div>
            <div className="text-[14px] font-extrabold tracking-tight text-ink">Frontier Capital</div>
            <div className="label-caps-faint leading-none">An AI-industry business sim</div>
          </div>
        </header>

        {/* --- hero -------------------------------------------------------- */}
        <section className="order-2 grid items-center gap-6 lg:grid-cols-[1.05fr_1fr] lg:gap-8">
          <div className="animate-pop-in flex min-w-0 flex-col gap-4">
            <span className="label-caps inline-flex w-fit items-center rounded-pill bg-brand-wash px-3 py-1 text-brand">
              2027 Q1 · eight people · one thesis
            </span>
            <h1 className="max-w-2xl text-[30px] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[42px]">
              Found a company. Outthink everybody else in the industry.
            </h1>
            <p className="max-w-2xl text-[13.5px] leading-relaxed text-ink-dim sm:text-[14px]">
              You start with <span className="figure font-semibold text-ink">{formatMoney(4_000_000)}</span>, eight people and one thesis,
              on connection level <span className="figure font-semibold text-ink">24</span> — in a world where the sovereign fund&rsquo;s
              chief investment officer sits on <span className="figure font-semibold text-ink">93</span>. Everything this game is about is
              visible in that gap on the very first screen.
            </p>

            {/* Thumb buttons: full width on a phone, stacked in intent order —
                a saved session is what a returning player came for. */}
            <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              {save !== null ? (
                <button
                  type="button"
                  className="icon-knockout-brand btn btn-primary btn-lg press-pop w-full sm:w-auto"
                  onClick={() => void continueGame()}
                  disabled={resuming || loading}
                >
                  <Icon name="playMark" size={18} accent="inherit" />
                  {resuming || loading ? 'Replaying…' : `Continue ${quarterLabel(2027, save.savedQuarter)}`}
                </button>
              ) : null}
              <button
                type="button"
                className={cx('btn btn-lg press-pop w-full sm:w-auto', save === null ? 'btn-primary' : '')}
                onClick={startNewGame}
              >
                <Icon name="plus" size={18} accent={save === null ? 'current' : 'brand'} />
                Start a new company
              </button>
            </div>

            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              Seven companies, sixteen people, a seventeen-node Frontier Map and two open procurements — all running locally in this
              browser. No sign-up needed.
            </p>
          </div>

          <div className="animate-pop-in stagger-2 min-w-0">
            <div className="scene-frame panel-surface p-2 sm:p-3">
              <CompanyTown />
            </div>
          </div>
        </section>

        {/* --- three promises ---------------------------------------------- */}
        <section className="order-4 grid gap-3 sm:grid-cols-3 sm:gap-4 lg:order-3">
          {FEATURES.map((feature, index) => (
            <div
              key={feature.title}
              className={cx('panel-surface animate-pop-in hover-lift p-4', `stagger-${index + 1}`)}
            >
              <IconChip name={feature.icon} tone={feature.tone} size="lg" />
              <h2 className="mt-3 text-[14px] font-bold text-ink">{feature.title}</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-dim">{feature.body}</p>
            </div>
          ))}
        </section>

        {/* --- entry points ------------------------------------------------ */}
        <div id="new-company" className="order-3 grid scroll-mt-4 gap-4 lg:order-4 lg:grid-cols-3">
          <Panel
            title="Start a new company"
            subtitle="Name it and choose how it starts"
            iconName="building"
            iconTone="brand"
            className={cx(save === null ? 'order-1' : 'order-2', 'lg:order-1 lg:col-span-2')}
          >
            {/* --- identity: who you are and what you are building ---------- */}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="label-caps-faint">Company name</span>
                <input
                  className="field mt-1 min-h-11 sm:min-h-0"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value.slice(0, NAME_MAX))}
                  maxLength={NAME_MAX}
                  placeholder="e.g. Northwind AI"
                  aria-label="Company name"
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="label-caps-faint">Founder name</span>
                <input
                  className="field mt-1 min-h-11 sm:min-h-0"
                  value={founderName}
                  onChange={(event) => setFounderName(event.target.value.slice(0, NAME_MAX))}
                  maxLength={NAME_MAX}
                  placeholder="e.g. Rae Fontaine"
                  aria-label="Founder name"
                  autoComplete="off"
                />
              </label>
            </div>

            {/* --- background: how the company starts ----------------------- */}
            <fieldset className="mt-4 min-w-0">
              <legend className="label-caps-faint">Starting background</legend>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                {NEW_GAME_BACKGROUNDS.map((background) => {
                  const selected = backgroundId === background.id;
                  return (
                    <button
                      key={background.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setBackgroundId(background.id)}
                      className={cx(
                        'press-pop flex min-h-11 w-full flex-col gap-2 rounded-card border p-3 text-left',
                        selected ? 'icon-knockout-wash border-brand bg-brand-wash' : 'border-hair bg-raised hover:border-brand',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <IconChip name={background.icon as IconName} tone={selected ? 'brand' : 'neutral'} size="sm" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-bold text-ink">{background.label}</span>
                          <span className="block text-[10.5px] text-ink-faint">{background.tagline}</span>
                        </span>
                        {selected ? <Icon name="check" size={15} accent="brand" className="ml-auto" /> : null}
                      </div>
                      <p className="text-[11.5px] leading-relaxed text-ink-dim">{background.blurb}</p>
                      <dl className="flex flex-wrap gap-x-3 gap-y-1">
                        {background.highlights.map((highlight) => (
                          <div key={highlight.label} className="flex items-baseline gap-1">
                            <dt className="label-caps-faint">{highlight.label}</dt>
                            <dd className="figure text-[11px] font-semibold text-ink">{highlight.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* --- the two world dials -------------------------------------- */}
            <div className="mt-4 grid gap-4 border-t border-hair pt-4 sm:grid-cols-[170px_1fr]">
              <label className="block">
                <span className="label-caps-faint">Seed</span>
                <input
                  className="field mt-1 min-h-11 sm:min-h-0"
                  value={seedText}
                  onChange={(event) => setSeedText(event.target.value.replace(/[^\d-]/g, ''))}
                  inputMode="numeric"
                  aria-label="Session seed"
                />
                <span className="mt-1.5 block text-[10.5px] text-ink-faint">
                  The same seed and the same decisions always produce the same world.
                </span>
              </label>

              <fieldset className="min-w-0">
                <legend className="label-caps-faint">Difficulty</legend>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  {SESSION_DIFFICULTIES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={difficulty === option}
                      onClick={() => setDifficulty(option)}
                      className={cx(
                        'btn tap-target press-pop capitalize',
                        difficulty === option ? 'icon-knockout-wash border-brand bg-brand-wash text-brand' : '',
                      )}
                    >
                      {difficulty === option ? <Icon name="check" size={15} accent="inherit" /> : null}
                      {option}
                    </button>
                  ))}
                </div>
                <p className="mt-2.5 text-[12px] leading-relaxed text-ink-dim">{DIFFICULTY_BLURB[difficulty]}</p>
              </fieldset>
            </div>

            <div className="mt-5 flex flex-col gap-2 border-t border-hair pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <button
                type="button"
                className="btn btn-primary tap-target press-pop w-full sm:w-auto"
                onClick={startNewGame}
                disabled={!namesValid}
              >
                <Icon name="plus" size={16} accent="current" />
                {trimmedCompany.length > 0 ? `Found ${trimmedCompany} — 2027 Q1` : 'Found your company — 2027 Q1'}
              </button>
              <span className="text-[11px] text-ink-faint">
                {namesValid ? `Seed ${seed}, ${difficulty} world.` : 'Enter a company and founder name to start.'}
              </span>
            </div>
          </Panel>

          <div className={cx('flex flex-col gap-4 lg:order-2', save === null ? 'order-2' : 'order-1')}>
            <Panel title="Continue" iconName="playMark" iconTone={save === null ? 'neutral' : 'brand'}>
              {!hydrated ? (
                <p className="text-[12.5px] text-ink-faint">Checking this browser for a saved session…</p>
              ) : save === null ? (
                <p className="text-[12.5px] leading-relaxed text-ink-faint">
                  No saved session in this browser. A session saves itself after every quarter you resolve.
                </p>
              ) : (
                <>
                  <dl className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2 border-b border-hair pb-1.5">
                      <dt className="label-caps-faint">Quarter</dt>
                      <dd className="figure text-[12.5px] font-semibold text-ink">{quarterLabel(2027, save.savedQuarter)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-b border-hair pb-1.5">
                      <dt className="label-caps-faint">Seed</dt>
                      <dd className="figure text-[12.5px] font-semibold text-ink">{save.seed}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="label-caps-faint">Difficulty</dt>
                      <dd className="text-[12.5px] font-semibold text-ink capitalize">{save.difficulty}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="icon-knockout-brand btn btn-primary tap-target press-pop mt-3.5 w-full"
                    onClick={() => void continueGame()}
                    disabled={resuming || loading}
                  >
                    {resuming || loading ? null : <Icon name="playMark" size={16} accent="inherit" />}
                    {resuming || loading
                      ? progress === null
                        ? 'Replaying…'
                        : `Replaying quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`
                      : `Resume — replays ${replayDepth} quarter${replayDepth === 1 ? '' : 's'}`}
                  </button>
                  <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
                    Saves store the seed, your decisions and what the model contributed — not the world. Loading re-resolves them from the
                    last checkpoint.
                  </p>
                </>
              )}
            </Panel>

            <Panel title="Multiplayer" iconName="network" iconTone={supabaseReady ? 'gain' : 'neutral'}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tag tone={supabaseReady ? 'gain' : 'neutral'} dot>
                  {supabaseReady ? 'Supabase configured' : 'Not configured'}
                </Tag>
                <button
                  type="button"
                  className="btn btn-ghost tap-target press-pop"
                  aria-expanded={showMultiplayer}
                  onClick={() => setShowMultiplayer((value) => !value)}
                >
                  <Icon name={showMultiplayer ? 'chevronDown' : 'chevronRight'} size={15} />
                  {showMultiplayer ? 'Hide' : 'Setup'}
                </button>
              </div>

              {supabaseReady ? (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-[12px] leading-relaxed text-ink-dim">Sign in to join a shared world with other founders.</p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Link href="/sign-in" className="btn tap-target flex-1">
                      Sign in
                    </Link>
                    <Link href="/sign-up" className="btn btn-primary tap-target flex-1">
                      Sign up
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">
                  Demo mode runs the full game locally — same engine, same invariants. Shared sessions need a Supabase project.
                </p>
              )}

              {showMultiplayer ? (
                <div className="animate-rise mt-3 rounded-card border border-hair bg-raised p-3">
                  <p className="label-caps-faint mb-1.5">Set in .env.local</p>
                  <pre className="figure scroll-x text-[10px] leading-relaxed text-ink-dim">
{`NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=`}
                  </pre>
                  <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
                    Then apply <span className="figure">supabase/migrations</span> and seed with{' '}
                    <span className="figure">supabase/seed.sql</span>, which loads this same world.
                  </p>
                </div>
              ) : null}
            </Panel>
          </div>
        </div>

        {/* --- what is in there -------------------------------------------- */}
        <section className="order-5 flex flex-col gap-3">
          <h2 className="text-[17px] font-extrabold tracking-tight text-ink">Eighteen screens, one company</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="panel-surface hover-lift min-w-0 p-3.5 sm:p-4">
                <div className="mb-2 flex items-center gap-2">
                  <IconChip name={group.icon} tone="brand" size="sm" />
                  <span className="label-caps text-brand">{group.label}</span>
                </div>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.href} className="min-w-0">
                      {/* A whole row is the target, and it clears 44px. */}
                      <Link
                        href={item.href}
                        className="icon-knockout-panel flex min-h-11 min-w-0 items-center gap-2.5 rounded-chip px-1.5 py-1.5 text-ink hover:bg-raised hover:text-brand"
                      >
                        <Icon name={item.icon} size={17} accent="inherit" className="text-ink-faint" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold">{item.label}</span>
                          <span className="block truncate text-[10.5px] text-ink-faint">{item.blurb}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* --- footer ------------------------------------------------------ */}
        <footer className="order-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-4 text-[10.5px] text-ink-faint">
          <span>Engine: deterministic, in-browser, {session.companies.length} companies loaded.</span>
          <span className="flex items-center gap-1.5">
            <Icon name="live" size={13} accent={llm.available ? 'gain' : 'neutral'} />
            {llm.available
              ? `Live model configured (${llm.transportKind}${llm.model === null ? '' : `, ${llm.model}`}).`
              : 'No model configured — every role falls back deterministically and the game plays in full.'}
          </span>
        </footer>
      </div>
    </div>
  );
}

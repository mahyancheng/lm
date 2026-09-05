'use client';

/**
 * Quarter Resolution — the payoff, and mechanically a rendering of the ledger.
 *
 * Five rules govern this screen and none of them are style preferences:
 *
 * 1. Every line is a `ResolutionLine` and **every line references at least one
 *    committed event**, so every line is clickable and opens its rows.
 * 2. Phases arrive in pipeline order and are revealed progressively. The pacing
 *    is the drama — world, competition, your company, markets, rank — and the
 *    skip is remembered.
 * 3. The `!` tone is reserved for something that has *not* gone wrong yet.
 * 4. "Why did my stock fall?" is answered from committed facts, never by asking
 *    a model to invent a reason.
 * 5. The narrator is optional colour above the lines. Without it the lines
 *    render directly; they are human-readable by construction.
 *
 * And the sixth case, which matters most when it happens: `committed: false`.
 * An invariant refused the quarter, nothing changed, and the screen says which
 * invariant and what did not reconcile.
 *
 * The theatre — the front page, the counting figures, the tape, the podium — is
 * presentation over exactly those facts. Every animated number's final state is
 * the state's number, and `skipResolutionReveal` turns the whole show off.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { NarratorOutput, ResolutionLine, SessionState } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatCount, formatMoney, formatPct, formatRankMove, formatScore } from '@frontier/shared';
import {
  DataTable,
  DeltaBadge,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  SectionHeading,
  StatCard,
  Tag,
  cx,
  toneOfLine,
  type Column,
} from '@/components/ui';
import { LedgerDrawer } from '@/components/screens/quarter-resolution/LedgerDrawer';
import { lineCount, markOf, playerQuarter } from '@/components/screens/quarter-resolution/sections';
import { SECTION_ICON, SECTION_TONE } from '@/components/screens/quarter-resolution/Art';
import { CountUp } from '@/components/screens/quarter-resolution/CountUp';
import { Newspaper } from '@/components/screens/quarter-resolution/Newspaper';
import { PriceTape, type PriceRow } from '@/components/screens/quarter-resolution/Tape';
import { RankPodium, type RankRow } from '@/components/screens/quarter-resolution/Podium';
import { companyNameOf, delintText, humanise, invariantLabel, phaseLabel } from '@/components/screens/reporting/util';
import { requestNarrative } from '@/lib/llm/client';
import {
  PLAYER_ID,
  useGameActions,
  useLlm,
  useOutcome,
  usePlayerCharacter,
  usePlayerCompany,
  usePlayerView,
  useSession,
  useSettings,
} from '@/lib/game';

/** Milliseconds between one revealed line and the next. CSS only — no timers. */
const REVEAL_STEP_MS = 55;
const SECTION_STEP_MS = 220;
const MAX_REVEAL_DELAY_MS = 2_600;

/** Card pop-in steps, in the order the sections are laid out. */
const CARD_STAGGER: readonly string[] = ['', 'stagger-1', 'stagger-2', 'stagger-3', 'stagger-4', 'stagger-5'];

/**
 * How many lines of a section a phone shows before asking.
 *
 * A ninety-line quarter is six screens of scrolling on a 390px phone, and the
 * lines a player wants are the first few of each section. The rest are one tap
 * away, and every line is still a line — nothing is summarised or dropped. From
 * `lg` the full list is always rendered.
 */
const PHONE_LINES = 6;

export default function QuarterResolutionPage(): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const playerView = usePlayerView();
  const outcome = useOutcome();
  const settings = useSettings();
  const llm = useLlm();
  const { updateSettings } = useGameActions();

  const [narrative, setNarrative] = useState<NarratorOutput | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [openLine, setOpenLine] = useState<ResolutionLine | null>(null);
  /** Sections whose full line list the player has asked for on a phone. */
  const [openSections, setOpenSections] = useState<readonly string[]>([]);
  /** Phone only: the full quote table under the tape, and the run diagnostics. */
  const [showQuotes, setShowQuotes] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  /* --- the quarter, as this seat may read it -------------------------------- */
  // The engine returns the whole quarter — every rival's morale, runway and
  // churn. The projection is what a screen is allowed to render, and the
  // narrator is fed the projection too: a model may not be told what the player
  // may not be.
  const view = useMemo(() => (outcome === null ? null : playerQuarter(outcome, session, PLAYER_ID)), [outcome, session]);
  const report = view?.report ?? null;

  /* --- optional colour ----------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    setNarrative(null);
    if (report === null || !llm.available) return;
    setNarrating(true);
    void requestNarrative(report, company.id)
      .then((result) => {
        if (!cancelled) setNarrative(result);
      })
      .finally(() => {
        if (!cancelled) setNarrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [report, company.id, llm.available]);

  const sections = view?.sections ?? [];
  /** The subjects the rank panel looks for: the company and the founder behind it. */
  const ownIds = useMemo(() => new Set<string>([company.id, founder.id]), [company.id, founder.id]);

  /* --- the state the report describes -------------------------------------- */
  // For a committed quarter this is the world afterwards. For a refused one the
  // resolver hands back the restored pre-resolution state, so the price and rank
  // panels are suppressed rather than shown as though they had moved.
  const resolved: SessionState | null = outcome === null ? null : outcome.nextState;
  const committed = outcome?.committed === true;

  const prices: readonly PriceRow[] = useMemo(() => {
    if (resolved === null || !committed) return [];
    return resolved.marketInstruments
      .filter((instrument) => !instrument.isReference)
      .map((instrument) => {
        const series = resolved.quotes.filter((quote) => quote.instrumentId === instrument.id).sort((a, b) => a.quarter - b.quarter);
        const last = series[series.length - 1];
        if (last === undefined) return null;
        return {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          name: instrument.name,
          price: last.price,
          quarterReturn: last.return,
          marketCapUsd: last.marketCapUsd,
          volume: last.volume,
          isOwn: instrument.companyId === company.id,
        };
      })
      .filter((row): row is PriceRow => row !== null)
      .sort((a, b) => b.quarterReturn - a.quarterReturn);
  }, [resolved, committed, company.id]);

  const ranks: readonly RankRow[] = useMemo(() => {
    if (resolved === null || !committed) return [];
    const rows: RankRow[] = [];
    for (const board of resolved.leaderboards) {
      const entry = board.entries.find((candidate) => ownIds.has(candidate.subjectId));
      if (entry === undefined) continue;
      rows.push({
        board: board.board,
        label: entry.label,
        rank: entry.rank,
        previousRank: entry.previousRank,
        value: entry.value,
        percentile: entry.percentile,
      });
    }
    return rows;
  }, [resolved, committed, ownIds]);

  /* --- nothing to show ------------------------------------------------------ */
  if (outcome === null || view === null || report === null) {
    return (
      <>
        <PageHeader
          title="Quarter Resolution"
          eyebrow={quarterLabel(session.startYear, session.quarter)}
          subtitle="Exactly what changed, and why — every line traceable to a committed ledger row."
        />
        <Panel>
          <EmptyState
            icon="newspaper"
            title="No quarter has resolved in this tab yet"
            message="Queue your instructions, review them, and lock the quarter. The report that comes back is a rendering of the ledger, not a summary of it."
            action={
              <Link href="/end-quarter" className="btn btn-primary btn-sm tap-target">
                Go to End Quarter
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  const failed = outcome.invariants.filter((check) => !check.passed);
  const passed = outcome.invariants.length - failed.length;
  const reveal = !settings.skipResolutionReveal;
  let lineIndex = 0;

  return (
    <>
      <PageHeader
        title={committed ? 'Quarter Resolution' : 'Quarter refused'}
        eyebrow={`${quarterLabel(session.startYear, report.quarter)} · ${lineCount(report)} lines · ledger ${report.sequenceFrom}–${report.sequenceTo}`}
        subtitle={report.headline}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn tap-target press-pop"
              onClick={() => updateSettings({ skipResolutionReveal: !settings.skipResolutionReveal })}
            >
              <Icon name={settings.skipResolutionReveal ? 'live' : 'check'} size={15} />
              {settings.skipResolutionReveal ? 'Replay the reveal' : 'Skip to the end'}
            </button>
            <Link href="/command-centre" className="btn btn-primary tap-target press-pop">
              <Icon name="chevronRight" size={16} accent="current" />
              <span className="hidden sm:inline">Continue to next quarter</span>
              <span className="sm:hidden">Next quarter</span>
            </Link>
          </div>
        }
      />

      {/* --- the refusal case ---------------------------------------------- */}
      {!committed ? (
        <Panel
          title="The quarter did not commit"
          subtitle="An invariant refused it and the pre-resolution state was restored"
          iconName="ledger"
          iconTone="loss"
          className="border-loss/40"
        >
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Nothing changed. Your queued instructions are still yours, the world is where it was, and the report below is what the pipeline
            produced before the gate rejected it. A failed check at the ledger commit aborts that commit — that is the mechanism working,
            not a lost quarter.
          </p>
          <SectionHeading className="mt-3" rule>
            Checks that did not pass
          </SectionHeading>
          {failed.length === 0 ? (
            <p className="mt-2 text-[11px] text-ink-faint">
              No individual check reported a failure, which means the resolver aborted before the gate could complete.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {failed.map((check) => (
                <li key={`${check.invariant}:${check.subjectId ?? 'session'}`} className="rounded-card border border-loss/30 bg-loss-wash px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-loss">{invariantLabel(check.invariant)}</span>
                    {check.subjectId === null ? null : (
                      <span className="figure text-[10px] text-ink-faint">{companyNameOf(playerView, check.subjectId)}</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{delintText(check.detail, session)}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      {/* --- the front page -------------------------------------------------- */}
      <Newspaper
        edition={`${quarterLabel(session.startYear, report.quarter)} edition · ${committed ? 'committed' : 'not committed'}`}
        reportHeadline={report.headline}
        narrative={narrative}
        narrating={narrating}
        sequenceFrom={report.sequenceFrom}
        sequenceTo={report.sequenceTo}
      />

      {/* --- the quarter, counted -------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Lines"
          iconName="ledger"
          iconTone="brand"
          value={<CountUp value={lineCount(report)} enabled={reveal} format={(v) => formatScore(Math.round(v))} />}
          hint="Every one opens the ledger rows behind it"
        />
        <StatCard
          label="Ledger rows"
          iconName="chart"
          iconTone="info"
          value={<CountUp value={view.events.length} enabled={reveal} delayMs={90} format={(v) => formatScore(Math.round(v))} />}
          hint={`Sequence ${report.sequenceFrom}–${report.sequenceTo}`}
        />
        <StatCard
          label="Phases run"
          iconName="globe"
          iconTone="info"
          value={<CountUp value={report.phases.length} enabled={reveal} delayMs={180} format={(v) => formatScore(Math.round(v))} />}
          hint="In the order that makes causality work"
        />
        <StatCard
          label="Invariants"
          iconName="trophy"
          iconTone={failed.length === 0 ? 'gain' : 'loss'}
          tone={failed.length === 0 ? 'gain' : 'loss'}
          value={<CountUp value={passed} enabled={reveal} delayMs={270} format={(v) => formatScore(Math.round(v))} />}
          hint={`of ${outcome.invariants.length} passed before the commit`}
        />
      </div>

      {/* --- the checklist --------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section, sectionIndex) => (
          <Panel
            key={section.id}
            title={section.title}
            subtitle={section.subtitle}
            iconName={SECTION_ICON[section.id]}
            iconTone={SECTION_TONE[section.id]}
            className={cx(
              section.id === 'rank' || section.id === 'ledger' ? 'lg:col-span-2' : '',
              reveal ? (CARD_STAGGER[Math.min(sectionIndex, CARD_STAGGER.length - 1)] ?? '') : '',
            )}
          >
            <ul className="flex flex-col gap-0.5">
              {section.lines.map((line, index) => {
                const tone = toneOfLine(line.tone);
                // Capped so a ninety-line quarter still finishes revealing in a few
                // seconds; the pacing is drama, not a loading bar.
                const delay = Math.min(sectionIndex * SECTION_STEP_MS + lineIndex * REVEAL_STEP_MS, MAX_REVEAL_DELAY_MS);
                lineIndex += 1;
                // Phone only: past the sixth line the list folds until asked.
                const folded = index >= PHONE_LINES && !openSections.includes(section.id);
                return (
                  <li
                    key={`${section.id}-${index}`}
                    className={cx(reveal ? 'animate-rise' : '', folded ? 'hidden lg:block' : '')}
                    style={reveal ? { animationDelay: `${delay}ms` } : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenLine(line)}
                      className="flex min-h-11 w-full items-start gap-2.5 rounded-chip px-2 py-1.5 text-left transition-colors hover:bg-raised"
                      title={`${line.refEventIds.length} ledger row${line.refEventIds.length === 1 ? '' : 's'}`}
                    >
                      <span
                        aria-hidden="true"
                        className={cx(
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-pill text-[9px] leading-none font-bold',
                          tone === 'gain'
                            ? 'bg-gain-wash text-gain'
                            : tone === 'loss'
                              ? 'bg-loss-wash text-loss'
                              : tone === 'warn'
                                ? 'bg-warn-wash text-warn'
                                : 'bg-raised text-ink-faint',
                        )}
                      >
                        {markOf(line.tone)}
                      </span>
                      <span className="min-w-0 flex-1 self-center text-[12.5px] leading-snug text-ink">{line.text}</span>
                      {line.deltaLabel === null ? null : (
                        <span className={cx('figure shrink-0 self-center text-[11.5px]', `tone-${tone}`)}>{line.deltaLabel}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {section.lines.length > PHONE_LINES ? (
              <button
                type="button"
                className="btn tap-target press-pop mt-2 w-full lg:hidden"
                aria-expanded={openSections.includes(section.id)}
                onClick={() =>
                  setOpenSections((current) =>
                    current.includes(section.id) ? current.filter((id) => id !== section.id) : [...current, section.id],
                  )
                }
              >
                <Icon name={openSections.includes(section.id) ? 'chevronDown' : 'chevronRight'} size={15} />
                {openSections.includes(section.id)
                  ? `Fold back to ${PHONE_LINES} lines`
                  : `Show all ${section.lines.length} lines`}
              </button>
            ) : null}
          </Panel>
        ))}
      </div>

      {/* --- prices ---------------------------------------------------------- */}
      {committed ? (
        <Panel
          title="Price change"
          subtitle="Closing quotes for the quarter that just resolved"
          iconName="chart"
          iconTone="gain"
          flush
        >
          <PriceTape rows={prices} reveal={reveal} />

          {/* The tape is the phone's reading of the quarter; the full quote
              table is one tap under it, and always open from `sm`. */}
          {prices.length === 0 ? null : (
            <div className="px-3 py-2.5 sm:hidden">
              <button
                type="button"
                className="btn tap-target press-pop w-full"
                aria-expanded={showQuotes}
                onClick={() => setShowQuotes((value) => !value)}
              >
                <Icon name={showQuotes ? 'chevronDown' : 'chevronRight'} size={15} />
                {showQuotes ? 'Hide the quote detail' : `Every quote in full (${prices.length})`}
              </button>
            </div>
          )}

          <div className={cx(showQuotes ? 'block' : 'hidden', 'sm:block')}>
          <DataTable
            dense
            cardMode="auto"
            cardTitleKey="symbol"
            rows={prices}
            rowKey={(row) => row.instrumentId}
            isHighlighted={(row) => row.isOwn}
            rowHref={() => '/markets'}
            initialSort={{ key: 'return', direction: 'desc' }}
            empty={
              <div className="p-3.5">
                <EmptyState
                  title="Nothing traded this quarter"
                  message="No in-world instrument produced a quote. A private company has no instrument at all — that is the starting condition, not an error."
                  compact
                />
              </div>
            }
            columns={
              [
                {
                  key: 'symbol',
                  header: 'Instrument',
                  render: (row) => (
                    <div className="min-w-0">
                      <div className="figure truncate text-[12px] text-ink">{row.symbol}</div>
                      <div className="truncate text-[10px] text-ink-faint">{row.name}</div>
                    </div>
                  ),
                  sortable: true,
                  sortValue: (row) => row.symbol,
                },
                {
                  key: 'price',
                  header: 'Close',
                  cardLabel: 'Closing price',
                  align: 'right',
                  render: (row) => formatMoney(row.price),
                  sortable: true,
                  sortValue: (row) => row.price,
                },
                {
                  key: 'return',
                  header: 'Quarter',
                  cardLabel: 'This quarter',
                  align: 'right',
                  render: (row) => <DeltaBadge value={row.quarterReturn} format="percent" bare />,
                  sortable: true,
                  sortValue: (row) => row.quarterReturn,
                },
                {
                  key: 'cap',
                  header: 'Market cap',
                  align: 'right',
                  hideOnMobile: true,
                  render: (row) => formatMoney(row.marketCapUsd),
                  sortable: true,
                  sortValue: (row) => row.marketCapUsd,
                },
                {
                  key: 'volume',
                  header: 'Volume',
                  align: 'right',
                  hideOnMobile: true,
                  render: (row) => formatScore(row.volume),
                  sortable: true,
                  sortValue: (row) => row.volume,
                },
              ] as readonly Column<PriceRow>[]
            }
          />
          </div>
        </Panel>
      ) : null}

      {/* --- rank ------------------------------------------------------------ */}
      {committed ? (
        <Panel title="Rank movement" subtitle="Where the quarter left you on each of the ten boards" iconName="trophy" iconTone="brand" flush>
          {ranks.length === 0 ? null : (
            <div className="border-b border-hair px-4 pt-4 pb-3">
              <RankPodium rows={ranks} reveal={reveal} />
            </div>
          )}
          {/* Card mode below `sm`, like the quote table above it: five columns
              of figures squeezed into 390px is exactly the misaligned table
              `cardMode` exists to prevent. */}
          <DataTable
            dense
            cardMode="auto"
            cardTitleKey="board"
            rows={ranks}
            rowKey={(row) => row.board}
            rowHref={() => '/leaderboard'}
            empty={
              <div className="p-3.5">
                <EmptyState
                  title="No board lists you yet"
                  message="Leaderboards are recomputed from the ledger each quarter. A company with no priced security and no contracts can sit outside several of them."
                  compact
                />
              </div>
            }
            columns={
              [
                {
                  key: 'board',
                  header: 'Board',
                  render: (row) => <span className="text-[12px] text-ink">{humanise(row.board)}</span>,
                },
                { key: 'subject', header: 'You', hideOnMobile: true, render: (row) => <span className="text-[11px] text-ink-dim">{row.label}</span> },
                { key: 'rank', header: 'Rank', align: 'right', render: (row) => `#${row.rank}` },
                {
                  key: 'move',
                  header: 'Movement',
                  align: 'right',
                  render: (row) => {
                    const move = formatRankMove(row.previousRank, row.rank);
                    if (move === null) return <span className="text-ink-faint">unchanged</span>;
                    if (move === 'new') return <Tag tone="info">new</Tag>;
                    const improved = row.previousRank !== null && row.rank < row.previousRank;
                    return <span className={improved ? 'tone-gain' : 'tone-loss'}>{move}</span>;
                  },
                },
                {
                  key: 'percentile',
                  header: 'Percentile',
                  align: 'right',
                  hideOnMobile: true,
                  render: (row) => formatPct(row.percentile),
                },
              ] as readonly Column<RankRow>[]
            }
          />
        </Panel>
      ) : null}

      {/* --- footer ---------------------------------------------------------- */}
      {/* Three panels of provenance. They are the proof, not the story, so on a
          phone they wait behind one control; from `lg` they are simply there. */}
      <button
        type="button"
        className="btn tap-target press-pop w-full lg:hidden"
        aria-expanded={showDiagnostics}
        onClick={() => setShowDiagnostics((value) => !value)}
      >
        <Icon name={showDiagnostics ? 'chevronDown' : 'chevronRight'} size={15} />
        {showDiagnostics ? 'Hide the proof' : 'Invariants, hashes and timings'}
      </button>

      <div className={cx('gap-4 lg:grid lg:grid-cols-3', showDiagnostics ? 'grid' : 'hidden')}>
        <Panel title="Invariants" subtitle="Checked before the ledger committed" iconName="check" iconTone={failed.length === 0 ? 'gain' : 'loss'}>
          <ul className="flex flex-col gap-1">
            {outcome.invariants.map((check) => (
              <li key={`${check.invariant}:${check.subjectId ?? 'session'}`} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="truncate text-ink-dim">{invariantLabel(check.invariant)}</span>
                <span className={cx('figure shrink-0', check.passed ? 'tone-gain' : 'tone-loss')}>{check.passed ? 'pass' : 'fail'}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="State hashes" subtitle="Same state, same decisions, same seed" iconName="globe" iconTone="info">
          <ul className="flex flex-col gap-1 text-[11px]">
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-ink-dim">Before</span>
              <span className="figure truncate text-ink-faint">{report.stateHashBefore.slice(0, 24)}</span>
            </li>
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-ink-dim">After</span>
              <span className="figure truncate text-ink-faint">{report.stateHashAfter.slice(0, 24)}</span>
            </li>
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-ink-dim">Ledger rows</span>
              <span className="figure text-ink">{view.events.length}</span>
            </li>
          </ul>
          <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
            Replaying this session's recorded decisions against this seed reproduces the hash after, byte for byte.
          </p>
        </Panel>

        <Panel title="Phase timings" subtitle="Diagnostics only; never an input" iconName="network" iconTone="neutral">
          <ul className="flex flex-col gap-0.5">
            {outcome.phaseTimings.map((timing) => (
              <li key={timing.phase} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="truncate text-ink-dim">{phaseLabel(timing.phase)}</span>
                <span className="figure shrink-0 text-[10px] text-ink-faint">
                  {formatCount(timing.durationMs)}ms · {timing.eventsEmitted}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="panel-surface flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink">
            {committed
              ? `${quarterLabel(session.startYear, report.quarter)} is committed. ${quarterLabel(session.startYear, session.quarter)} is open.`
              : 'Nothing was committed. The quarter is still open and your queue is intact.'}
          </p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">
            {committed
              ? 'Every line above opens the ledger rows behind it. Nothing on this screen is narrative invention.'
              : 'Fix what the failed invariant names, or remove the instruction that caused it, and resolve again.'}
          </p>
        </div>
        {/* The screen's one forward move: a thumb button on a phone. */}
        <Link href={committed ? '/command-centre' : '/end-quarter'} className="btn btn-primary btn-lg press-pop w-full sm:w-auto">
          <Icon name={committed ? 'chevronRight' : 'back'} size={18} accent="current" />
          {committed ? 'Continue to next quarter' : 'Back to End Quarter'}
        </Link>
      </div>

      <LedgerDrawer line={openLine} events={view.events} startYear={session.startYear} session={session} onClose={() => setOpenLine(null)} />
    </>
  );
}

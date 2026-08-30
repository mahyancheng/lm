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
import { formatMoney, formatPct, formatRankMove, formatScore } from '@frontier/shared';
import {
  DataTable,
  DeltaBadge,
  EmptyState,
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
import { SECTION_TONE, SectionGlyph, GlobeGlyph, LedgerGlyph, PodiumGlyph, TapeGlyph } from '@/components/screens/quarter-resolution/Art';
import { CountUp } from '@/components/screens/quarter-resolution/CountUp';
import { Newspaper } from '@/components/screens/quarter-resolution/Newspaper';
import { PriceTape, type PriceRow } from '@/components/screens/quarter-resolution/Tape';
import { RankPodium, type RankRow } from '@/components/screens/quarter-resolution/Podium';
import { requestNarrative } from '@/lib/llm/client';
import { PLAYER_ID, useGameActions, useLlm, useOutcome, usePlayerCharacter, usePlayerCompany, useSession, useSettings } from '@/lib/game';

/** Milliseconds between one revealed line and the next. CSS only — no timers. */
const REVEAL_STEP_MS = 55;
const SECTION_STEP_MS = 220;
const MAX_REVEAL_DELAY_MS = 2_600;

/** Card pop-in steps, in the order the sections are laid out. */
const CARD_STAGGER: readonly string[] = ['', 'stagger-1', 'stagger-2', 'stagger-3', 'stagger-4', 'stagger-5'];

export default function QuarterResolutionPage(): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const outcome = useOutcome();
  const settings = useSettings();
  const llm = useLlm();
  const { updateSettings } = useGameActions();

  const [narrative, setNarrative] = useState<NarratorOutput | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [openLine, setOpenLine] = useState<ResolutionLine | null>(null);

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
            glyph="QR"
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm tap-target"
              onClick={() => updateSettings({ skipResolutionReveal: !settings.skipResolutionReveal })}
            >
              {settings.skipResolutionReveal ? 'Replay the reveal' : 'Skip to the end'}
            </button>
            <Link href="/command-centre" className="btn btn-primary btn-sm tap-target">
              Continue to next quarter
            </Link>
          </div>
        }
      />

      {/* --- the refusal case ---------------------------------------------- */}
      {!committed ? (
        <Panel
          title="The quarter did not commit"
          subtitle="An invariant refused it and the pre-resolution state was restored"
          icon={<LedgerGlyph />}
          iconTone="loss"
          className="border-loss/40"
        >
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Nothing changed. Your queued instructions are still yours, the world is where it was, and the report below is what the pipeline
            produced before the gate rejected it. A failed check in <span className="figure">ledger_commit</span> aborts the commit — that is
            the mechanism working, not a lost quarter.
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
                    <span className="figure text-[12px] text-loss">{check.invariant}</span>
                    {check.subjectId === null ? null : <span className="figure text-[10px] text-ink-faint">{check.subjectId}</span>}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{check.detail}</p>
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Lines"
          icon={<LedgerGlyph />}
          iconTone="brand"
          value={<CountUp value={lineCount(report)} enabled={reveal} format={(v) => formatScore(Math.round(v))} />}
          hint="Every one opens the ledger rows behind it"
        />
        <StatCard
          label="Ledger rows"
          icon={<TapeGlyph />}
          iconTone="info"
          value={<CountUp value={view.events.length} enabled={reveal} delayMs={90} format={(v) => formatScore(Math.round(v))} />}
          hint={`Sequence ${report.sequenceFrom}–${report.sequenceTo}`}
        />
        <StatCard
          label="Phases run"
          icon={<GlobeGlyph />}
          iconTone="info"
          value={<CountUp value={report.phases.length} enabled={reveal} delayMs={180} format={(v) => formatScore(Math.round(v))} />}
          hint="In the order that makes causality work"
        />
        <StatCard
          label="Invariants passed"
          icon={<PodiumGlyph />}
          iconTone={failed.length === 0 ? 'gain' : 'loss'}
          tone={failed.length === 0 ? 'gain' : 'loss'}
          value={<CountUp value={passed} enabled={reveal} delayMs={270} format={(v) => formatScore(Math.round(v))} />}
          hint={`of ${outcome.invariants.length} checked before the commit`}
        />
      </div>

      {/* --- the checklist --------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section, sectionIndex) => (
          <Panel
            key={section.id}
            title={section.title}
            subtitle={section.subtitle}
            icon={<SectionGlyph id={section.id} />}
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
                return (
                  <li
                    key={`${section.id}-${index}`}
                    className={reveal ? 'animate-rise' : undefined}
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
                      <span className="min-w-0 flex-1 self-center text-[12px] leading-snug text-ink">{line.text}</span>
                      {line.deltaLabel === null ? null : (
                        <span className={cx('figure shrink-0 self-center text-[11px]', `tone-${tone}`)}>{line.deltaLabel}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ))}
      </div>

      {/* --- prices ---------------------------------------------------------- */}
      {committed ? (
        <Panel
          title="Price change"
          subtitle="Closing quotes for the quarter that just resolved"
          icon={<TapeGlyph />}
          iconTone="gain"
          flush
        >
          <PriceTape rows={prices} reveal={reveal} />
          <DataTable
            dense
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
                { key: 'price', header: 'Close', align: 'right', render: (row) => formatMoney(row.price), sortable: true, sortValue: (row) => row.price },
                {
                  key: 'return',
                  header: 'Quarter',
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
        </Panel>
      ) : null}

      {/* --- rank ------------------------------------------------------------ */}
      {committed ? (
        <Panel title="Rank movement" subtitle="Where the quarter left you on each of the ten boards" icon={<PodiumGlyph />} iconTone="brand" flush>
          {ranks.length === 0 ? null : (
            <div className="border-b border-hair px-4 pt-4 pb-3">
              <RankPodium rows={ranks} reveal={reveal} />
            </div>
          )}
          <DataTable
            dense
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
                  render: (row) => <span className="text-[12px] text-ink">{row.board.replace(/_/g, ' ')}</span>,
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
                  render: (row) => formatPct(row.percentile, 0),
                },
              ] as readonly Column<RankRow>[]
            }
          />
        </Panel>
      ) : null}

      {/* --- footer ---------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Invariants" subtitle="Checked before the ledger committed" icon={<LedgerGlyph />} iconTone={failed.length === 0 ? 'gain' : 'loss'}>
          <ul className="flex flex-col gap-1">
            {outcome.invariants.map((check) => (
              <li key={`${check.invariant}:${check.subjectId ?? 'session'}`} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="truncate text-ink-dim">{check.invariant.replace(/_/g, ' ')}</span>
                <span className={cx('figure shrink-0', check.passed ? 'tone-gain' : 'tone-loss')}>{check.passed ? 'pass' : 'fail'}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="State hashes" subtitle="Same state, same decisions, same seed" icon={<GlobeGlyph />} iconTone="info">
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

        <Panel title="Phase timings" subtitle="Diagnostics only; never an input" icon={<TapeGlyph />} iconTone="neutral">
          <ul className="flex flex-col gap-0.5">
            {outcome.phaseTimings.map((timing) => (
              <li key={timing.phase} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="truncate text-ink-dim">{timing.phase.replace(/_/g, ' ')}</span>
                <span className="figure shrink-0 text-[10px] text-ink-faint">
                  {timing.durationMs.toFixed(1)}ms · {timing.eventsEmitted}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="panel-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-[12px] text-ink">
            {committed
              ? `${quarterLabel(session.startYear, report.quarter)} is committed. ${quarterLabel(session.startYear, session.quarter)} is open.`
              : 'Nothing was committed. The quarter is still open and your queue is intact.'}
          </p>
          <p className="mt-0.5 text-[10px] text-ink-faint">
            {committed
              ? 'Every line above opens the ledger rows behind it. Nothing on this screen is narrative invention.'
              : 'Fix what the failed invariant names, or remove the instruction that caused it, and resolve again.'}
          </p>
        </div>
        <Link href={committed ? '/command-centre' : '/end-quarter'} className="btn btn-primary tap-target">
          {committed ? 'Continue to next quarter' : 'Back to End Quarter'}
        </Link>
      </div>

      <LedgerDrawer line={openLine} events={view.events} startYear={session.startYear} onClose={() => setOpenLine(null)} />
    </>
  );
}

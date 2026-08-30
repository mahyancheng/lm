/**
 * Reading the resolution report as the sections the spec lays out.
 *
 * ```text
 * WORLD                          MARKETS
 * COMPETITION                    YOUR COMPANY          SESSION RANK
 * ```
 *
 * Phases fix four of the buckets outright — the world phases, the pricing
 * phases, the leaderboard phase and the commit itself. Everything else is split
 * by *subject*, because the operating phases interleave every company's actions
 * into one pipeline and only the subject says whose quarter a line describes.
 *
 * A line whose subject is neither a company nor a character — a Frontier Map
 * node whose public confidence moved, an index, an opportunity that opened — is
 * public news about the world, and reads correctly there.
 */

import type { ResolutionLine, ResolutionPhase, ResolutionReport } from '@frontier/contracts';

export type SectionId = 'world' | 'competition' | 'company' | 'markets' | 'rank' | 'ledger';

export interface ResolutionSection {
  readonly id: SectionId;
  readonly title: string;
  readonly subtitle: string;
  readonly lines: readonly ResolutionLine[];
}

const WORLD_PHASES: ReadonlySet<ResolutionPhase> = new Set<ResolutionPhase>(['world_events', 'gm_modifiers', 'information_reveal']);
const MARKET_PHASES: ReadonlySet<ResolutionPhase> = new Set<ResolutionPhase>(['market_resolution', 'disclosure_resolution']);
const LEDGER_PHASES: ReadonlySet<ResolutionPhase> = new Set<ResolutionPhase>(['ledger_commit', 'snapshot']);

const TITLES: Readonly<Record<SectionId, { readonly title: string; readonly subtitle: string }>> = {
  world: { title: 'World', subtitle: 'What moved before anybody acted, and what the frontier now believes' },
  competition: { title: 'Competition', subtitle: 'What everyone else did with the same quarter' },
  company: { title: 'Your company', subtitle: 'What your instructions actually produced' },
  markets: { title: 'Markets', subtitle: 'What was disclosed, and what it was priced at' },
  rank: { title: 'Session rank', subtitle: 'Where that leaves you across the ten boards' },
  ledger: { title: 'Ledger', subtitle: 'The commit itself' },
};

const ORDER: readonly SectionId[] = ['world', 'competition', 'company', 'markets', 'rank', 'ledger'];

/** Which section one line belongs in. */
export function sectionOf(line: ResolutionLine, ownIds: ReadonlySet<string>, actorIds: ReadonlySet<string>): SectionId {
  if (WORLD_PHASES.has(line.phase)) return 'world';
  if (MARKET_PHASES.has(line.phase)) return 'markets';
  if (line.phase === 'leaderboard_update') return 'rank';
  if (LEDGER_PHASES.has(line.phase)) return 'ledger';
  if (line.subjectId === null) return line.phase === 'government_resolution' ? 'world' : 'company';
  if (ownIds.has(line.subjectId)) return 'company';
  if (actorIds.has(line.subjectId)) return 'competition';
  return 'world';
}

/**
 * Group every line in a report, keeping pipeline order within each section.
 *
 * Sections with no lines are dropped: an empty section is not information, and
 * a phase that produced nothing this quarter genuinely produced nothing.
 */
export function groupLines(report: ResolutionReport, ownIds: ReadonlySet<string>, actorIds: ReadonlySet<string>): ResolutionSection[] {
  const buckets = new Map<SectionId, ResolutionLine[]>();
  for (const id of ORDER) buckets.set(id, []);

  for (const phase of report.phases) {
    for (const line of phase.lines) {
      buckets.get(sectionOf(line, ownIds, actorIds))?.push(line);
    }
  }

  return ORDER.filter((id) => (buckets.get(id) ?? []).length > 0).map((id) => ({
    id,
    title: TITLES[id].title,
    subtitle: TITLES[id].subtitle,
    lines: buckets.get(id) ?? [],
  }));
}

/** Total lines in a report, for the header count. */
export function lineCount(report: ResolutionReport): number {
  return report.phases.reduce((total, phase) => total + phase.lines.length, 0);
}

/** The tick mark a line carries. `!` is reserved for what has not gone wrong yet. */
export function markOf(tone: ResolutionLine['tone']): string {
  return tone === 'warning' ? '!' : '✓';
}

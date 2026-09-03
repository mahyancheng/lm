/**
 * The Frontier Map in four states and plain sentences.
 *
 * A node used to show confidence (public and private), novelty, plausibility, a
 * cost range, compute intensity, capability tags with percentages, a visibility
 * and an arrival window, and none of it answered the four questions a founder
 * actually has: **what does this get me, what does it take, how long, and why is
 * it slow.** This file is the copy layer for those answers.
 *
 * Two rules hold here.
 *
 * 1. **Nothing is computed.** Every figure arrives already worked out by
 *    `@frontier/simulation` — `programmeForecast`, `runningForecast`,
 *    `projectRequirements`, `unmetDependencies` — and this file only chooses
 *    words and calls a shared formatter. A screen that recomputed a quarter
 *    count would be a second, disagreeing model of the engine.
 * 2. **Everything is pure.** No React, no session, no clock: the inputs are the
 *    values the engine handed over, which is what makes the copy testable.
 */

import type { ResearchBottleneck, ResearchEffort, ResearchShortfall } from '@frontier/simulation';
import { formatCount, formatMoney } from '@frontier/shared';

/* -------------------------------------------------------------------------- */
/*  The four states of a tile                                                  */
/* -------------------------------------------------------------------------- */

/** A map tile is in exactly one of four states. Nothing else is drawn on it. */
export type NodeStateKind = 'locked' | 'available' | 'running' | 'done';

export interface NodeStateInput {
  /** Name of the company that has demonstrated it, or null while nobody has. */
  readonly achievedByName: string | null;
  /** True when that company is the viewer, including a private demonstration. */
  readonly achievedByYou: boolean;
  /** Titles of the prerequisites this company has not reached, in graph order. */
  readonly missingTitles: readonly string[];
  /** The viewer's own live programme against it, already read by the engine. */
  readonly running: { readonly progressPct: number; readonly quartersLeft: number } | null;
}

export interface NodeState {
  readonly kind: NodeStateKind;
  /** The one line the tile carries under its title. */
  readonly line: string;
  /** Progress 0..1, on a running programme only. The map's one bar. */
  readonly progress: number | null;
}

/**
 * Which of the four states a node is in, and the single line that says so.
 *
 * The order is the order a founder reads it in: something already done is done
 * whatever else is true of it; something you are working on is in progress even
 * if a prerequisite is still open (the engine holds it at the line); otherwise
 * it is locked or available.
 */
export function classifyNode(input: NodeStateInput): NodeState {
  if (input.achievedByName !== null || input.achievedByYou) {
    return { kind: 'done', line: input.achievedByYou ? 'Done — yours' : `Done — ${input.achievedByName ?? 'a rival'}`, progress: 1 };
  }
  if (input.running !== null) {
    return {
      kind: 'running',
      line: `${Math.round(input.running.progressPct)}% done · ${Math.round(input.running.quartersLeft)}q left`,
      progress: Math.max(0, Math.min(1, input.running.progressPct / 100)),
    };
  }
  if (input.missingTitles.length > 0) {
    const [first, ...rest] = input.missingTitles;
    return {
      kind: 'locked',
      line: rest.length === 0 ? `Needs ${first}` : `Needs ${first} and ${rest.length} more`,
      progress: null,
    };
  }
  return { kind: 'available', line: 'Available', progress: null };
}

/** Tile colouring, kept out of the SVG so the four states are named in one place. */
export const NODE_STATE_TONE: Readonly<Record<NodeStateKind, 'neutral' | 'brand' | 'info' | 'gain'>> = {
  locked: 'neutral',
  available: 'info',
  running: 'brand',
  done: 'gain',
};

export const NODE_STATE_LABEL: Readonly<Record<NodeStateKind, string>> = {
  locked: 'Locked',
  available: 'Available',
  running: 'In progress',
  done: 'Done',
};

/* -------------------------------------------------------------------------- */
/*  Who else is close                                                          */
/* -------------------------------------------------------------------------- */

/** "The world thinks: likely" — the public confidence, said rather than measured. */
export function worldThinksLine(verdict: 'likely' | 'unclear' | 'doubtful'): string {
  return `The world thinks this is ${verdict}`;
}

/**
 * Who else the world can see working on it.
 *
 * A secret programme is absent from the input, not redacted, so this can only
 * ever name work that is genuinely public.
 */
export function rivalsLine(rivals: readonly { readonly name: string; readonly progressPct: number }[]): string {
  if (rivals.length === 0) return 'Nobody else has published a programme against it.';
  const [leader, ...rest] = rivals;
  if (leader === undefined) return 'Nobody else has published a programme against it.';
  const head = `${leader.name} is ${Math.round(leader.progressPct)}% of the way there`;
  if (rest.length === 0) return `${head}.`;
  return `${head}, and ${rest.length} other${rest.length === 1 ? '' : 's'} ${rest.length === 1 ? 'is' : 'are'} working on it.`;
}

/* -------------------------------------------------------------------------- */
/*  Risk                                                                       */
/* -------------------------------------------------------------------------- */

export const RISK_LABEL: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const RISK_TONE: Readonly<Record<'low' | 'medium' | 'high', 'gain' | 'warn' | 'loss'>> = {
  low: 'gain',
  medium: 'warn',
  high: 'loss',
};

/** "Medium — a 21% chance each quarter that the run disappoints and sets it back." */
export function riskLine(band: 'low' | 'medium' | 'high', probability: number): string {
  const pct = Math.round(probability * 100);
  return `${RISK_LABEL[band]} — about a ${pct}% chance each quarter that the run disappoints and loses some of the progress.`;
}

/* -------------------------------------------------------------------------- */
/*  Why it is slow                                                             */
/* -------------------------------------------------------------------------- */

export const BOTTLENECK_LABEL: Readonly<Record<ResearchBottleneck, string>> = {
  funding: 'money',
  compute: 'compute',
  talent: 'researchers',
};

/**
 * The one sentence a slow programme gets.
 *
 * The numbers are the engine's: `have` is what the programme was given and
 * `want` is what `resourcingFactors` measured it against. Null when the
 * programme has everything the node asks for — silence is the right copy for a
 * programme running at full speed.
 */
export function shortfallLine(shortfall: ResearchShortfall | null): string | null {
  if (shortfall === null) return null;
  if (shortfall.kind === 'compute') {
    return `Short of compute: ${formatCount(shortfall.have)} of ${formatCount(shortfall.want)} units.`;
  }
  if (shortfall.kind === 'funding') {
    return `Short of money: ${formatMoney(shortfall.have)} a quarter against ${formatMoney(shortfall.want)} the work needs.`;
  }
  if (shortfall.capabilityGap) {
    return `The team is short on the skills this needs, not on bodies: ${formatCount(shortfall.have)} researchers are assigned, and the company is weak in the areas it calls for.`;
  }
  return `Short of researchers: ${formatCount(shortfall.have)} of ${formatCount(shortfall.want)} assigned.`;
}

/* -------------------------------------------------------------------------- */
/*  Effort                                                                     */
/* -------------------------------------------------------------------------- */

export const EFFORT_LABEL: Readonly<Record<ResearchEffort, string>> = {
  light: 'Light',
  standard: 'Standard',
  all_in: 'All-in',
};

export const EFFORT_BLURB: Readonly<Record<ResearchEffort, string>> = {
  light: 'Half the people, half the machines, half the money. Cheap, and slow.',
  standard: 'Exactly what this technology asks for, as far as you have it free.',
  all_in: 'Half again on everything. The fastest route, and the most exposed.',
};

/* -------------------------------------------------------------------------- */
/*  What it unlocks                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What reaching a node actually does, in the order it matters.
 *
 * Capability areas come from the node's own `talentRequirements` — those are the
 * areas `achieveNodes` raises — and the technologies come from the graph. When a
 * node opens nothing mechanical, the honest line says what it does move rather
 * than inventing a benefit.
 */
export function unlockLines(input: {
  readonly capabilityAreas: readonly string[];
  readonly unlockTitles: readonly string[];
  readonly dependentTitles: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  if (input.capabilityAreas.length > 0) {
    out.push(`Raises your strength in ${humanList(input.capabilityAreas.map(readableArea))}.`);
  }
  if (input.unlockTitles.length > 0) {
    out.push(`Makes ${humanList(input.unlockTitles)} credible.`);
  }
  if (input.dependentTitles.length > 0) {
    out.push(`Unblocks ${humanList(input.dependentTitles)}.`);
  }
  if (out.length === 0) {
    out.push('Opens no further technology on its own. What it buys is standing: the world revises what it believes you can do, and your valuation follows.');
  }
  return out;
}

/** "reasoning", "training_systems" → "reasoning and training systems". */
export function readableArea(area: string): string {
  return area.replace(/_/g, ' ');
}

/** Up to three items spelled out, the rest counted. */
export function humanList(items: readonly string[]): string {
  const shown = items.slice(0, 3);
  const hidden = items.length - shown.length;
  const joined =
    shown.length <= 1
      ? (shown[0] ?? '')
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
  return hidden > 0 ? `${joined} and ${hidden} more` : joined;
}

/** "8 quarters" / "1 quarter" — the unit the game counts time in. */
export function quartersLabel(quarters: number): string {
  const whole = Math.round(quarters);
  return `${formatCount(whole)} quarter${whole === 1 ? '' : 's'}`;
}

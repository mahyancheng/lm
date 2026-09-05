/**
 * The Frontier Map's four states, and the sentences under them.
 *
 * This is the copy layer, so what is pinned here is what a founder reads: the
 * four states are exclusive and ordered, the shortfall sentence names the right
 * shortage in the right unit, and no figure is invented — every number in a
 * sentence is one that was handed in.
 */

import { describe, expect, it } from 'vitest';
import type { ResearchShortfall } from '@frontier/simulation';
import {
  BOTTLENECK_LABEL,
  EFFORT_LABEL,
  NODE_STATE_LABEL,
  RISK_LABEL,
  classifyNode,
  humanList,
  quartersLabel,
  readableArea,
  riskLine,
  rivalsLine,
  shortfallLine,
  unlockLines,
  worldThinksLine,
} from './nodeState';

const NOTHING = { achievedByName: null, achievedByYou: false, missingTitles: [], running: null } as const;

describe('the four states', () => {
  it('is available when nothing is missing and nothing is running', () => {
    const state = classifyNode(NOTHING);
    expect(state.kind).toBe('available');
    expect(state.line).toBe('Available');
    expect(state.progress).toBeNull();
  });

  it('is locked when a prerequisite is open, and names the first one', () => {
    expect(classifyNode({ ...NOTHING, missingTitles: ['Sparse Expert Reasoning'] }).line).toBe('Needs Sparse Expert Reasoning');
    expect(classifyNode({ ...NOTHING, missingTitles: ['A', 'B', 'C'] }).line).toBe('Needs A and 2 more');
  });

  it('is in progress when a programme is running, with whole numbers only', () => {
    const state = classifyNode({ ...NOTHING, missingTitles: ['A'], running: { progressPct: 43.7, quartersLeft: 5.2 } });
    expect(state.kind).toBe('running');
    expect(state.line).toBe('44% done · 5q left');
    expect(state.progress).toBeCloseTo(0.437, 3);
  });

  it('is done whatever else is true, and says whose it is', () => {
    expect(classifyNode({ ...NOTHING, achievedByYou: true, running: { progressPct: 50, quartersLeft: 3 } }).line).toBe('Done — yours');
    expect(classifyNode({ ...NOTHING, achievedByName: 'Nexus Systems' }).line).toBe('Done — Nexus Systems');
    expect(classifyNode({ ...NOTHING, achievedByName: 'Nexus Systems' }).kind).toBe('done');
  });

  it('labels all four', () => {
    expect(Object.values(NODE_STATE_LABEL)).toEqual(['Locked', 'Available', 'In progress', 'Done']);
  });
});

describe('why it is slow', () => {
  const base = { have: 0, want: 0, capabilityGap: false };

  it('says nothing when the programme has everything', () => {
    expect(shortfallLine(null)).toBeNull();
  });

  it('names compute in units', () => {
    const shortfall: ResearchShortfall = { ...base, kind: 'compute', have: 300, want: 600 };
    expect(shortfallLine(shortfall)).toBe('Short of compute: 300 of 600 units.');
  });

  it('names researchers as bodies assigned', () => {
    const shortfall: ResearchShortfall = { ...base, kind: 'talent', have: 4, want: 10 };
    expect(shortfallLine(shortfall)).toBe('Short of researchers: 4 of 10 assigned.');
  });

  it('distinguishes a capability gap from a headcount gap', () => {
    const shortfall: ResearchShortfall = { kind: 'talent', have: 10, want: 10, capabilityGap: true };
    const line = shortfallLine(shortfall) ?? '';
    expect(line).toContain('skills');
    expect(line).not.toContain('of 10 assigned');
  });

  it('names money per quarter', () => {
    const shortfall: ResearchShortfall = { ...base, kind: 'funding', have: 1_000_000, want: 4_000_000 };
    expect(shortfallLine(shortfall)).toBe('Short of money: $1,000,000 a quarter against $4,000,000 the work needs.');
  });

  it('has a plain-words label for every bottleneck', () => {
    // Four resourcing factors since world 3: a node that wants petabytes is
    // short of the data its own customers would have produced.
    expect(BOTTLENECK_LABEL).toEqual({ funding: 'money', compute: 'compute', talent: 'researchers', data: 'customer data' });
  });
});

describe('risk and belief, in words', () => {
  it('states the band and the whole percent behind it', () => {
    expect(riskLine('medium', 0.214)).toBe('Medium — about a 21% chance each quarter that the run disappoints and loses some of the progress.');
    expect(Object.values(RISK_LABEL)).toEqual(['Low', 'Medium', 'High']);
  });

  it('says what the world thinks rather than showing a number', () => {
    expect(worldThinksLine('likely')).toBe('The world thinks this is likely');
    expect(worldThinksLine('doubtful')).toBe('The world thinks this is doubtful');
  });

  it('names the leading rival and counts the rest', () => {
    expect(rivalsLine([])).toBe('Nobody else has published a programme against it.');
    expect(rivalsLine([{ name: 'Nexus', progressPct: 62.4 }])).toBe('Nexus is 62% of the way there.');
    expect(rivalsLine([{ name: 'Nexus', progressPct: 62 }, { name: 'Meridian', progressPct: 10 }])).toBe(
      'Nexus is 62% of the way there, and 1 other is working on it.',
    );
  });
});

describe('what it gets you', () => {
  it('lists capability areas, unlocks and dependents', () => {
    const lines = unlockLines({
      capabilityAreas: ['reasoning', 'training_systems'],
      unlockTitles: ['Agent Economies'],
      dependentTitles: ['Autonomous Research'],
    });
    expect(lines[0]).toBe('Raises your strength in reasoning and training systems.');
    expect(lines[1]).toBe('Makes Agent Economies credible.');
    expect(lines[2]).toBe('Unblocks Autonomous Research.');
  });

  it('says what a node with no mechanical consequence actually moves', () => {
    const lines = unlockLines({ capabilityAreas: [], unlockTitles: [], dependentTitles: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('standing');
  });

  it('spells out three and counts the rest', () => {
    expect(humanList(['A'])).toBe('A');
    expect(humanList(['A', 'B'])).toBe('A and B');
    expect(humanList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(humanList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and C and 2 more');
  });

  it('reads a capability area as words', () => {
    expect(readableArea('safety_alignment')).toBe('safety alignment');
  });
});

describe('units', () => {
  it('counts quarters whole and singular where it should', () => {
    expect(quartersLabel(1)).toBe('1 quarter');
    expect(quartersLabel(8.4)).toBe('8 quarters');
  });

  it('names the three efforts', () => {
    expect(Object.values(EFFORT_LABEL)).toEqual(['Light', 'Standard', 'All-in']);
  });
});

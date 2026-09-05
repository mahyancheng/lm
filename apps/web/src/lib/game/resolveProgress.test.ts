/**
 * `resolveProgress.ts` — the resolving overlay's progress-list formatting.
 */

import { describe, expect, it } from 'vitest';
import { elapsedSeconds, formatProgressLine, formatProgressStatus, type ProgressRow } from './resolveProgress';

function row(partial: Partial<ProgressRow>): ProgressRow {
  return { label: 'World Director', state: 'pending', startedAt: null, doneAt: null, note: null, ...partial };
}

describe('elapsedSeconds', () => {
  it('is zero for a row that has not started', () => {
    expect(elapsedSeconds(row({ startedAt: null }), 10_000)).toBe(0);
  });

  it('measures from startedAt to now while unfinished', () => {
    expect(elapsedSeconds(row({ startedAt: 1_000 }), 5_400)).toBe(4.4);
  });

  it('measures from startedAt to doneAt once finished, ignoring now', () => {
    expect(elapsedSeconds(row({ startedAt: 1_000, doneAt: 3_250 }), 999_999)).toBe(2.3);
  });

  it('rounds to one decimal place', () => {
    // 1234ms -> 1.234s -> rounds to 1.2s
    expect(elapsedSeconds(row({ startedAt: 0, doneAt: 1_234 }), 0)).toBe(1.2);
    // 1260ms -> 1.26s -> rounds to 1.3s
    expect(elapsedSeconds(row({ startedAt: 0, doneAt: 1_260 }), 0)).toBe(1.3);
  });
});

describe('formatProgressLine', () => {
  it('renders a pending row as its bare label', () => {
    expect(formatProgressLine(row({ label: 'Aletheia Labs strategist', state: 'pending' }), 0)).toBe('Aletheia Labs strategist');
  });

  it('renders a running row with live elapsed seconds', () => {
    const line = formatProgressLine(row({ label: 'Aletheia Labs strategist', state: 'running', startedAt: 0 }), 41_000);
    expect(line).toBe('Aletheia Labs strategist · 41s');
  });

  it('renders a done row with its final elapsed seconds, in "done (Ns)" form', () => {
    const line = formatProgressLine(row({ label: 'World Director', state: 'done', startedAt: 0, doneAt: 2_100 }), 999_999);
    expect(line).toBe('World Director · done (2.1s)');
  });

  it('renders a skipped row with its note, ignoring elapsed time entirely', () => {
    const line = formatProgressLine(
      row({ label: 'Basalt Compute strategist', state: 'skipped', startedAt: 0, note: 'on policy (budget)' }),
      999_999,
    );
    expect(line).toBe('Basalt Compute strategist · on policy (budget)');
  });

  it('falls back to a generic word when a skipped row somehow carries no note', () => {
    expect(formatProgressLine(row({ label: 'X', state: 'skipped', note: null }), 0)).toBe('X · skipped');
  });
});

describe('formatProgressStatus', () => {
  it('joins the headline and every row on its own line, in order', () => {
    const rows: ProgressRow[] = [
      { label: 'World Director', state: 'done', startedAt: 0, doneAt: 2_000, note: null },
      { label: 'Aletheia Labs strategist', state: 'running', startedAt: 2_000, doneAt: null, note: null },
      { label: 'Basalt Compute strategist', state: 'pending', startedAt: null, doneAt: null, note: null },
    ];
    const status = formatProgressStatus('Rival strategists are planning', rows, 6_000);
    expect(status).toBe(
      ['Rival strategists are planning', 'World Director · done (2s)', 'Aletheia Labs strategist · 4s', 'Basalt Compute strategist'].join('\n'),
    );
  });

  it('keeps the headline recognisable as the first line — ResolvingOverlay stage-detects on it by startsWith', () => {
    const status = formatProgressStatus('Consulting the World Director', [], 0);
    expect(status.startsWith('Consulting')).toBe(true);
    expect(status.split('\n')[0]).toBe('Consulting the World Director');
  });

  it('is just the headline when there are no rows yet', () => {
    expect(formatProgressStatus('Resolving eighteen phases', [], 0)).toBe('Resolving eighteen phases');
  });
});

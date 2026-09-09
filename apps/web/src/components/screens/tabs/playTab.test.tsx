import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState } from '@frontier/contracts';
import { buildSubmittedAction, createSession, needsConfirmation, validateSubmittedAction } from '../../../lib/game/engine';
import type { QueuedActionEntry } from '../../../lib/game/provider';
import { groupQueueByPhase } from './cards/play-queue';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = readFileSync(`${DIR}PlayTab.tsx`, 'utf8');
const REPORT = readFileSync(`${DIR}../quarter-resolution/QuarterResolutionScreen.tsx`, 'utf8');
const session: SessionState = createSession();

function queued(intent: ActionIntent, sequence: number, confirmed: boolean): QueuedActionEntry {
  const action = buildSubmittedAction(session, intent, sequence, { confirmedByHuman: confirmed });
  return { action, validation: validateSubmittedAction(session, action), needsConfirmation: needsConfirmation(intent.type), blocked: needsConfirmation(intent.type) && !confirmed };
}

const held = queued({ type: 'layoff', role: 'engineers', count: 1, severanceQuartersOfPay: 1 }, 1, false);
const ready = queued({ type: 'set_research_budget', budgetUsd: 1_000_000 }, 2, true);

describe('review and advance flow', () => {
  it('uses the real confirmation policy and refuses advance while a move is held', () => {
    expect(held.blocked).toBe(true);
    expect(ready.blocked).toBe(false);
    expect(SOURCE).toContain('blocked.length === 0 && !resolving');
    expect(SOURCE).toContain('onConfirm={confirmAction}');
  });

  it('keeps one explicit final confirmation without a typed-word ritual', () => {
    expect(SOURCE).toContain('<ConfirmDialog');
    expect(SOURCE).toContain('setReviewing(true)');
    expect(SOURCE).toContain('onCancel={() => setReviewing(false)}');
    expect(SOURCE).not.toContain('requireTyped');
  });

  it('preserves the queue unless resolution succeeds and then opens the report', () => {
    expect(SOURCE).toContain('resolved = await endQuarter()');
    expect(SOURCE).toContain("if (resolved) router.replace(sheetHref('resolution'))");
    expect(SOURCE).not.toContain('clearQueue();');
  });

  it('groups accepted moves by their canonical resolution order', () => {
    const groups = groupQueueByPhase([ready, held]);
    expect(groups.map((group) => group.phase)).toEqual(['talent_resolution', 'research_resolution']);
  });

  it('returns a committed outcome to Today and keeps failed outcomes editable', () => {
    expect(REPORT).toContain('Continue to Today');
    expect(REPORT).toContain("committed ? HOME_ROUTE : tabPath('play')");
    expect(REPORT).toContain('your queue is intact');
    expect(REPORT).toContain('biggestOutcomes');
    expect(REPORT).toContain('See what caused this');
  });

  it('never presents the success continuation when a quarter was rolled back', () => {
    expect(REPORT).toContain("{committed ? (\n          <Link href={HOME_ROUTE}");
    expect(REPORT).toContain("<Link href={tabPath('play')}");
    expect(REPORT).toContain('Return to Plan');
    expect(REPORT).toContain('The quarter is still open and your plan is intact');
  });
});

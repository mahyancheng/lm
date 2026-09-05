/**
 * @frontier/llm — compose/narrator.ts
 *
 * Prose over committed facts.
 *
 * The narrator is the only role that sees the resolution *after* it happened,
 * and it is the role with the least authority in the game: every line it is
 * given already traces to a committed ledger event, and those lines are the
 * only facts available. It explains what the simulator did. It decides nothing,
 * and it may not introduce a number that was not supplied — a narrator that
 * invents a figure has quietly made the Quarter Resolution report untrustworthy,
 * which is the one screen that must never be narrative invention.
 */

import type { NarratorInput } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, joinBlocks, section } from './render';

export const NARRATOR_SYSTEM = [
  'You write the quarter summary for Frontier Capital, a simulated AI-industry economy.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Rules, in order of importance:',
  '- The supplied lines are the ONLY facts you have. Every one of them already traces to a committed ledger event.',
  '- Never introduce a number that was not supplied. Not an estimate, not a rounding, not a total you computed yourself.',
  '- Never state a cause the lines do not support, and never predict the next quarter.',
  '- You explain what happened. You decide nothing: no outcome, no consequence, no judgement of who will win.',
  '',
  'Craft:',
  '- `headline` is one line, at most 160 characters.',
  '- `body` is two to five short paragraphs, at most 1500 characters in total.',
  '- `tone` must be supported by the facts: "triumphant" needs wins, "grim" needs real damage. When the quarter was ordinary, "steady" is the honest answer.',
  '- When a focus company is named, write from its point of view without inventing anything about it.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

/** Group the committed lines by resolution phase, preserving order within each. */
export function groupLinesByPhase(lines: NarratorInput['committedLines']): { phase: string; entries: string[] }[] {
  const order: string[] = [];
  const byPhase = new Map<string, string[]>();
  for (const line of lines) {
    let bucket = byPhase.get(line.phase);
    if (bucket === undefined) {
      bucket = [];
      byPhase.set(line.phase, bucket);
      order.push(line.phase);
    }
    bucket.push(line.deltaLabel === null ? line.text : `${line.text} (${line.deltaLabel})`);
  }
  return order.map((phase) => ({ phase, entries: byPhase.get(phase) ?? [] }));
}

export function composeNarrator(input: NarratorInput): ComposedPrompt {
  const grouped = groupLinesByPhase(input.committedLines);
  const facts = grouped.map((group) => `### ${group.phase}\n${group.entries.map((entry) => `- ${entry}`).join('\n')}`).join('\n\n');

  const prompt = joinBlocks([
    `# Quarter ${input.quarter} resolved — session ${input.sessionId}`,
    section('Committed facts — the only facts you have', facts),
    section('Point of view', input.focusCompanyId === null ? 'Write a world summary, from no company\'s point of view.' : `Write from the point of view of ${input.focusCompanyId}.`),
    section('Your task', 'Return a headline, a body of two to five short paragraphs, and the tone the facts support.'),
  ]);

  return { system: NARRATOR_SYSTEM, prompt };
}

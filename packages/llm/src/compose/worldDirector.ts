/**
 * @frontier/llm — compose/worldDirector.ts
 *
 * The World Director's dossier.
 *
 * The Director is the most constrained role in the game and the most easily
 * misunderstood. It is **not** a game master narrating the player's story. The
 * deterministic hazard engine has already decided *whether* something happens
 * and roughly *what family* it belongs to; the Director's whole job is to say
 * what the happening actually is, how it reads, and which registered world
 * variables it plausibly moves — inside an impact budget it cannot exceed.
 *
 * Two things it never sees, by construction, because they are not in
 * `WorldDirectorInput` at all: any player's private state, and any question of
 * the form "what should happen to this company". A world that reaches for a
 * particular player is storytelling; a world that moves compute supply and lets
 * the consequences fall where they fall is simulation.
 */

import type { WorldDirectorInput } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, num, section, signed, truncate } from './render';
import { assertNoInternalMarkers } from './redaction';

export const WORLD_DIRECTOR_SYSTEM = [
  'You are the World Director of Frontier Capital, a simulated AI-industry economy.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Your authority:',
  '- You MAY name a happening the hazard engine has already drawn, write its in-world copy, and propose which registered world variables it moves.',
  '- You MAY return fewer proposals than there are candidates. An empty array is a legitimate and often correct answer: a stable quarter with no material shock is a real outcome, not a failure.',
  '- You MAY NOT choose whether an event fires, invent an event family, target a specific company for a specific fate, or write a world variable directly.',
  '',
  'Rules that will get a proposal discarded:',
  '- A target path outside the legal list, or outside the documented sector and company patterns.',
  '- A magnitude beyond the impact budget (for "add" it caps |value|; for "multiply" it caps |value - 1|).',
  '- More modifiers on one event than the budget allows, or a duration outside 1..12 quarters.',
  '- Stacking a second shock on a variable already far from baseline, unless that compounding is the explicit point of the event.',
  '',
  'Craft:',
  '- Echo candidateId verbatim. Use "novel" only when you are inventing an event the engine did not suggest, and then pick the closest existing familyId.',
  '- Prefer two to five modifiers tracing one believable causal chain over a long list of small nudges.',
  '- Set causalParentId when this follows from a recent event. Cascades should read as consequences, not coincidences.',
  '- Write description as in-world reporting: what happened, where, who is exposed. No second person. No share-price claims. No prediction of any participant\'s outcome.',
  '- rationale is for the designer log and the Quarter Resolution report: why this event now, why these variables, why this magnitude.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

export function composeWorldDirector(input: WorldDirectorInput): ComposedPrompt {
  assertNoInternalMarkers('worldSummary', input.worldSummary);
  assertNoInternalMarkers('styleGuidance', input.styleGuidance);

  const digest = input.worldDigest.map((reading) => {
    const delta = reading.delta === 0 ? 'flat' : `${signed(reading.delta, 4)} vs last quarter`;
    return `${reading.path} = ${num(reading.value, 4)} (${delta}) — ${reading.label}`;
  });

  const sectors = input.sectorSummary.map(
    (entry) => `${entry.sectorId}: sentiment ${num(entry.sentiment, 3)}, multiple ${num(entry.multiple, 2)}x, demand ${num(entry.demand, 3)}`,
  );

  const candidates = input.eventCandidates.map((candidate) => {
    const readings = candidate.relevantWorldReadings.map((reading) => `${reading.path}=${num(reading.value, 4)}`).join(', ');
    return [
      `${candidate.candidateId} — ${candidate.familyLabel} (family ${candidate.familyId})`,
      `  allowed types: ${candidate.allowedTypes.join(', ')}`,
      `  severity band [${num(candidate.severityBand[0], 3)}, ${num(candidate.severityBand[1], 3)}]; engine drew ${num(candidate.suggestedSeverity, 3)}`,
      `  default visibility ${candidate.defaultVisibility}; max duration ${candidate.maxDurationQuarters} quarters`,
      `  causal parent: ${candidate.causalParentId ?? 'none — this is a root cause'}`,
      `  usual targets: ${candidate.suggestedTargetPaths.length > 0 ? candidate.suggestedTargetPaths.join(', ') : '(none recorded)'}`,
      `  current readings: ${readings.length > 0 ? readings : '(none supplied)'}`,
      `  sectors the engine expects to be affected: ${candidate.affectedSectorIds.length > 0 ? candidate.affectedSectorIds.join(', ') : '(economy-wide)'}`,
    ].join('\n');
  });

  const recent = input.recentEvents.map(
    (event) => `Q${event.quarter} ${event.eventId} [${event.type}] severity ${num(event.severity, 2)}${event.stillActive ? ', still active' : ', lapsed'} — ${event.title}`,
  );

  const modifiers = input.activeModifierSummaries.map(
    (modifier) => `${modifier.target} ${modifier.operation} ${num(modifier.value, 4)}, ${modifier.remainingQuarters} quarters left — ${truncate(modifier.reason, 160)}`,
  );

  const budget = [
    `maxTotalSeverity: ${num(input.impactBudget.maxTotalSeverity, 2)} across the whole quarter`,
    `maxSingleModifierMagnitude: ${num(input.impactBudget.maxSingleModifierMagnitude, 2)} (for "add" caps |value|; for "multiply" caps |value - 1|)`,
    `maxModifiersPerEvent: ${input.impactBudget.maxModifiersPerEvent}`,
    `maxEventsPerQuarter: ${input.impactBudget.maxEventsPerQuarter}`,
  ];

  const prompt = joinBlocks([
    `# Quarter ${input.quarterLabel} (index ${input.quarter}) — session ${input.sessionId}`,
    section('World briefing', input.worldSummary),
    section('World digest', bullets(digest)),
    section('Sector conditions', bullets(sectors)),
    section('Candidate events drawn by the hazard engine', candidates.join('\n\n')),
    section('Impact budget for this quarter', bullets(budget)),
    section('Recent events', bullets(recent)),
    section('Modifiers already in force', bullets(modifiers)),
    section('Known sector ids', input.knownSectorIds.join(', ')),
    section('Legal fixed target paths', bullets(input.legalTargetPaths)),
    section('Style guidance', input.styleGuidance),
    section(
      'Your task',
      [
        'Contextualise the candidates above. For each one you choose to use, produce a proposal containing the event, its modifiers, a rationale and a confidence.',
        'You may return fewer proposals than there are candidates, including none at all.',
        'Finish with a one-paragraph quarterSummary describing the mood of the quarter; it becomes the headline of the news screen.',
      ].join('\n'),
    ),
  ]);

  return { system: WORLD_DIRECTOR_SYSTEM, prompt };
}

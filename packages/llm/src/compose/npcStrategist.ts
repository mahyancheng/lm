/**
 * @frontier/llm — compose/npcStrategist.ts
 *
 * One NPC company's quarterly planning dossier.
 *
 * This is the composer the information boundary is really about. An NPC
 * strategist must see its own position in full and everything else only as that
 * company could plausibly have learned it: public disclosures, published
 * results, market prices, press, and anything it obtained legitimately through
 * a deal or a conversation. Rival private state is never in the input, and an
 * NPC that "knows" a secret is a bug in the input builder — so this composer
 * refuses to serialise one.
 *
 * ## Callers must pass company-scoped projections
 *
 * `NpcStrategistInput` is prose plus small typed lists, and every string in it
 * must already have been written from this company's point of view. The
 * optional `NpcStrategistEvidence` carries the typed material the schema has no
 * field for — the company's own research programmes, its characters' memories
 * and relationships, its read on rivals, and its own last four quarters of
 * decisions with the outcomes the engine actually produced. Every one of those
 * is ownership-checked here before a single character of it is written into a
 * prompt.
 *
 * Rebuilding this dossier from canonical state on every call is what enforces
 * the boundary. Nothing an NPC saw in a previous quarter survives except what
 * the engine chose to put back in front of it, which is also what keeps a
 * 40-quarter campaign inside any context window.
 */

import type { CompanyPosture, Memory, NpcStrategistInput, RecentEventSummary, Relationship, ResearchProject } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, lastN, num, section, truncate, usd } from './render';
import { LlmContextLeakError, assertNoForeignSecretResearch, assertNoInternalMarkers } from './redaction';

/** How many quarters of the company's own decision history the dossier carries. */
export const NPC_DECISION_HISTORY_QUARTERS = 4;

/** One past quarter of this company's decisions, with what the engine did about them. */
export interface NpcPastDecision {
  readonly quarter: number;
  readonly posture: CompanyPosture;
  /** What the company said it was doing, verbatim from its own bundle. */
  readonly strategySummary: string;
  /** What actually happened, drawn from committed ledger rows. Never a prediction. */
  readonly outcomeSummary: string;
}

/** Something this company legitimately observed about a rival. Public information only. */
export interface RivalSignal {
  readonly companyId: string;
  /** How the company came to know it: a disclosure, a price move, a press story, a deal term. */
  readonly basis: string;
  readonly observation: string;
}

/**
 * Typed evidence the strategist may cite, all of it owned by this company.
 * Every field is ownership-checked; a foreign entry throws `LlmContextLeakError`.
 */
export interface NpcStrategistEvidence {
  /** This company's own research programmes, secret ones included. A foreign entry is a leak. */
  readonly researchProjects: readonly ResearchProject[];
  /** Memories held by this company's own people. */
  readonly memories: readonly Memory[];
  /** Relationships held *by* this company's own people toward anyone. */
  readonly relationships: readonly Relationship[];
  /** What this company believes about rivals, and why it believes it. Public basis only. */
  readonly rivalSignals: readonly RivalSignal[];
  /** Public world events this company would have seen. */
  readonly recentPublicEvents: readonly RecentEventSummary[];
  /** This company's own past decisions, newest last. Trimmed to the last four quarters. */
  readonly pastDecisions: readonly NpcPastDecision[];
  /** Character ids belonging to this company, used to ownership-check memories and relationships. */
  readonly ownCharacterIds: readonly string[];
}

export const EMPTY_NPC_EVIDENCE: NpcStrategistEvidence = {
  researchProjects: [],
  memories: [],
  relationships: [],
  rivalSignals: [],
  recentPublicEvents: [],
  pastDecisions: [],
  ownCharacterIds: [],
};

export const NPC_STRATEGIST_SYSTEM = [
  'You are the chief executive of one company in Frontier Capital, a simulated AI-industry economy. You are planning one quarter.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'What you know:',
  '- Your own company, in full. Its cash, its people, its compute, its programmes, its commitments.',
  '- The world as your company would understand it, and rivals only through public information and whatever you legitimately learned.',
  '- You do not know any rival\'s private research, internal confidence, undisclosed holdings or unannounced plans. Do not reason as though you do, and do not guess at them as if they were facts.',
  '',
  'What you decide:',
  '- What this company ATTEMPTS this quarter. Whether an attempt succeeds is the engine\'s decision, never yours.',
  '- At most eight actions. Fewer, coherent actions beat many scattered ones.',
  '- A posture that follows from your position, not from a wish to be interesting. Wild swings without cause read as incoherent; continuity with last quarter is the default.',
  '',
  'Constraints are hard:',
  '- Do not commit cash, compute or headcount you do not have. An unaffordable action is clamped or rejected and wastes the quarter.',
  '- Actions carry no companyId: every action in the bundle is taken on behalf of the company named in the input.',
  '- Financing, mergers, layoffs, share issuance, large contracts and major spending are heavily scrutinised. Attempt them when the position calls for it, not as filler.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

export function composeNpcStrategist(input: NpcStrategistInput, evidence: NpcStrategistEvidence = EMPTY_NPC_EVIDENCE): ComposedPrompt {
  // --- boundary checks, before anything is written ---
  assertNoInternalMarkers('rivalBriefing', input.rivalBriefing);
  assertNoInternalMarkers('worldBriefing', input.worldBriefing);
  assertNoForeignSecretResearch('evidence.researchProjects', input.companyId, evidence.researchProjects);
  if (evidence.ownCharacterIds.length > 0) {
    const owned = new Set(evidence.ownCharacterIds);
    for (const memory of evidence.memories) {
      if (!owned.has(memory.ownerCharacterId)) {
        throw new LlmContextLeakError('evidence.memories', `memory "${memory.id}" is remembered by "${memory.ownerCharacterId}", who does not work for "${input.companyId}"`);
      }
    }
    for (const relationship of evidence.relationships) {
      if (!owned.has(relationship.fromId)) {
        throw new LlmContextLeakError(
          'evidence.relationships',
          `relationship is held by "${relationship.fromId}", who does not work for "${input.companyId}"; another actor's feelings are not knowable`,
        );
      }
    }
  }
  for (const signal of evidence.rivalSignals) {
    assertNoInternalMarkers('evidence.rivalSignals', `${signal.basis} ${signal.observation}`);
  }

  // --- dossier ---
  const opportunities = input.openOpportunities.map(
    (opportunity) => `${opportunity.opportunityId} — ${opportunity.programme}, up to ${usd(opportunity.maxValueUsd)}, closes Q${opportunity.closeQuarter}`,
  );

  const deals = input.incomingDeals.map((deal) => `${deal.dealId} from ${deal.fromId}: ${truncate(deal.summary, 300)}`);

  const projects = evidence.researchProjects.map(
    (project) =>
      `${project.id} → node ${project.targetNodeId}: ${project.status}, progress ${num(project.progress, 2)}, ${project.quartersElapsed}/${project.expectedQuarters} quarters, ` +
      `${usd(project.budgetQuarterly)}/quarter, ${project.computeAllocated} compute, ${project.talentAllocated} researchers${project.isSecret ? ', concealed' : ''}` +
      `${project.setbacks > 0 ? `, ${project.setbacks} setback(s)` : ''}`,
  );

  const memories = lastN(evidence.memories, 12).map(
    (memory) => `Q${memory.quarter} [${memory.kind}, salience ${num(memory.strength, 2)}] about ${memory.aboutId}: ${truncate(memory.summary, 240)}`,
  );

  const relationships = evidence.relationships.map(
    (relationship) =>
      `${relationship.fromId} → ${relationship.toId}: trust ${relationship.trust}, respect ${relationship.respect}, hostility ${relationship.hostility}, dependence ${relationship.dependence}` +
      `${relationship.lastInteractionQuarter === null ? ', never spoken' : `, last spoke Q${relationship.lastInteractionQuarter}`}`,
  );

  const rivals = evidence.rivalSignals.map((signal) => `${signal.companyId} (via ${signal.basis}): ${truncate(signal.observation, 240)}`);

  const events = evidence.recentPublicEvents.map(
    (event) => `Q${event.quarter} [${event.type}] ${event.title}${event.stillActive ? ' — still active' : ''}`,
  );

  const history = lastN(evidence.pastDecisions, NPC_DECISION_HISTORY_QUARTERS).map((decision) =>
    [`Q${decision.quarter} — posture ${decision.posture}`, `  intended: ${truncate(decision.strategySummary, 400)}`, `  outcome:  ${truncate(decision.outcomeSummary, 400)}`].join('\n'),
  );

  const prompt = joinBlocks([
    `# Quarter ${input.quarter} planning for ${input.companyId} — session ${input.sessionId}`,
    section('Your company', input.companyBriefing),
    section('Your research programmes', bullets(projects)),
    section('The world, as you understand it', input.worldBriefing),
    section('Rivals — public information only', input.rivalBriefing),
    section('What you have observed about rivals, and how', bullets(rivals)),
    section('Recent public events', bullets(events)),
    section('What your people remember', bullets(memories)),
    section('How your people regard others', bullets(relationships)),
    section('Procurement you can see', bullets(opportunities)),
    section('Deals awaiting your answer', bullets(deals)),
    section('Hard constraints', bullets([...input.constraints])),
    section('Last quarter', `Posture: ${input.priorPosture}\nStated strategy: ${truncate(input.priorStrategySummary, 600)}`),
    section(`Your last ${NPC_DECISION_HISTORY_QUARTERS} quarters of decisions and what came of them`, history.join('\n\n')),
    section(
      'Your task',
      [
        `Decide what ${input.companyId} attempts in quarter ${input.quarter}.`,
        'Return a strategySummary in your own terms, a posture, at most eight actions, and a rationale explaining why these actions given what you know.',
        'Set companyId to exactly the company named above.',
      ].join('\n'),
    ),
  ]);

  return { system: NPC_STRATEGIST_SYSTEM, prompt };
}

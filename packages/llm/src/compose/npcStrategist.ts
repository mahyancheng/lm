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
 *
 * ## The person comes first
 *
 * The dossier opens with the chief executive, not the spreadsheet: their name,
 * their five stable traits stated as instructions rather than as numbers, what
 * they believe, who they have not forgotten, and what they have tried lately.
 * That block is why two companies in identical positions choose differently,
 * and it is projected from canonical character state — the traits, the
 * relationships and the memories the engine already keeps — never invented
 * here and never authored by a model.
 *
 * ## A delta, not a fresh dossier every quarter
 *
 * Sessions are deliberately fresh per call (see the comment in `roles.ts`), so
 * nothing here relies on a model remembering anything. What varies is how much
 * we SEND: on a refresh quarter the whole world and rival dossier travels, and
 * on every other quarter it is replaced by what changed since last quarter.
 * The persona, the engine-written memory, the position line, the constraints
 * and the open deals travel on every call, because a fresh session that lost
 * those would plan blind. `isFullBriefingQuarter` is the rule, and the caller
 * records its answer in `changedSinceLastQuarter.isFullBriefing`.
 */

import type {
  CompanyPosture,
  Memory,
  NpcPersona,
  NpcStrategistInput,
  RecentEventSummary,
  Relationship,
  ResearchProject,
  StableTraits,
  StrategistChangeKind,
} from '@frontier/contracts';
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
  'Who you are:',
  '- You are a named person with fixed traits, stated beliefs and a memory of what has been done to you. That description is the first thing in the dossier and it is not decoration: it decides which moves you reach for first, which you refuse, and how you answer a rival who has crossed you.',
  '- Two companies in the same position should not produce the same bundle. If your bundle would be identical to a cautious executive\'s and you are not one, it is wrong.',
  '- Your grudges are engine records of things that actually happened. Act on them or let them go, but never invent one and never invent an event to justify one.',
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
  '- Compute and headcount you do not have are clamped away and waste the quarter. Cash is different: an overdraft is allowed and charged interest, and two quarters closing below zero wind the company up.',
  '- Actions carry no companyId: every action in the bundle is taken on behalf of the company named in the input.',
  '- Financing, mergers, layoffs, share issuance, large contracts and major spending are heavily scrutinised. Attempt them when the position calls for it, not as filler.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

/* -------------------------------------------------------------------------- */
/*  Full dossier or delta                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How often the whole dossier is re-sent.
 *
 * Every call is a fresh session, so the delta is a compression of what we
 * *send*, never a bet that the model remembers. What travels on every call is
 * the persona, the engine-written memory, the position line and the
 * constraints; what the refresh restores is the wide material — the world
 * digest, the rival table, the observed signals, the decision history.
 */
// The refresh schedule lives in `@frontier/contracts` beside the delta schema
// it governs, because the browser picks the shape and this module only renders
// it. Re-exported here so every existing importer of the composer is unchanged.
export { STRATEGIST_FULL_BRIEFING_INTERVAL, isFullBriefingQuarter, quartersSinceFullBriefing } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  The person                                                                 */
/* -------------------------------------------------------------------------- */

/** At or above this a trait is pronounced enough to name in the prompt. */
const TRAIT_HIGH = 65;

/** At or below this the absence of the trait is itself the instruction. */
const TRAIT_LOW = 35;

/**
 * What each trait means for the moves this executive reaches for first.
 *
 * These lines are the difference between a personality and a decoration. A
 * model told "aggressiveness 78" and nothing else writes the same bundle it
 * would have written at 12; a model told what an aggressive executive does
 * differently chooses different actions. Deterministic: the same traits always
 * produce the same lines, in this order.
 */
function traitDirectives(traits: StableTraits): string[] {
  const lines: string[] = [];

  if (traits.aggressiveness >= TRAIT_HIGH) {
    lines.push('You attack. Poaching, undercutting on price, building a stake in somebody who is exposed, bidding against a rival in public — you reach for these before you reach for patience.');
  } else if (traits.aggressiveness <= TRAIT_LOW) {
    lines.push('You do not pick fights. You would rather compound quietly than start something public, and you escalate only when there is no other way through.');
  }

  if (traits.riskTolerance >= TRAIT_HIGH) {
    lines.push('You concentrate. One large committed bet you can defend beats five hedges, and a quarter that risked nothing was a quarter wasted.');
  } else if (traits.riskTolerance <= TRAIT_LOW) {
    lines.push('You spread risk. You size every move so a bad outcome is survivable, and you decline bets whose downside you cannot name.');
  }

  if (traits.financialConservatism >= TRAIT_HIGH) {
    lines.push('You watch the cash. You will not commit money you cannot cover twice over, you resist dilution, and you cut spend before you cut the balance sheet.');
  } else if (traits.financialConservatism <= TRAIT_LOW) {
    lines.push('You spend ahead of revenue. Debt and an overdraft are instruments, not failures, and being underinvested frightens you more than being stretched.');
  }

  if (traits.technicalOrientation >= TRAIT_HIGH) {
    lines.push('You judge on the engineering. You fund research over marketing, you back the harder architecture when it is the right one, and a claim without a mechanism does not move you.');
  } else if (traits.technicalOrientation <= TRAIT_LOW) {
    lines.push('You judge on the market. You would rather buy capability than build it, and distribution and price beat architecture in your reckoning.');
  }

  if (traits.statusSensitivity >= TRAIT_HIGH) {
    lines.push('A public slight is a real cost to you. Being embarrassed in front of the market changes what you do next, and you answer it.');
  } else if (traits.statusSensitivity <= TRAIT_LOW) {
    lines.push('Noise does not move you. Being written about badly is not a reason to do anything at all.');
  }

  if (lines.length === 0) {
    lines.push('You are moderate in every dimension: you take the balanced move, and you need a reason before you take an extreme one.');
  }
  return lines;
}

/**
 * The post this person holds, without the company name repeated.
 *
 * Titles are stored as "CEO — Aletheia Labs", which would read as "CEO —
 * Aletheia Labs of Aletheia Labs" in the opening line.
 */
function postOf(persona: NpcPersona): string {
  const lead = persona.title.split('—')[0]?.trim() ?? '';
  return lead.length > 0 ? lead : persona.role.replace(/_/g, ' ');
}

/** The opening paragraph: who this is, in their own voice. */
function personaParagraph(input: NpcStrategistInput, persona: NpcPersona): string {
  const traits = persona.traits;
  const whole = (value: number) => String(Math.round(value));
  const beliefs = persona.beliefs.map((belief) => `${belief.topic.replace(/_/g, ' ')} ${belief.level}`);
  return [
    `You are ${persona.name}, ${postOf(persona)} of ${input.companyName}.`,
    `Out of 100 you are ${whole(traits.riskTolerance)} on appetite for risk, ${whole(traits.technicalOrientation)} on technical depth, ` +
      `${whole(traits.financialConservatism)} on financial caution, ${whole(traits.aggressiveness)} on aggression and ${whole(traits.statusSensitivity)} on how much a slight matters to you.`,
    beliefs.length === 0 ? null : `What you currently believe: ${beliefs.join('; ')}.`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/*  The composer                                                               */
/* -------------------------------------------------------------------------- */

export function composeNpcStrategist(input: NpcStrategistInput, evidence: NpcStrategistEvidence = EMPTY_NPC_EVIDENCE): ComposedPrompt {
  // --- boundary checks, before anything is written ---
  assertNoInternalMarkers('rivalBriefing', input.rivalBriefing);
  assertNoInternalMarkers('worldBriefing', input.worldBriefing);
  assertNoForeignSecretResearch('evidence.researchProjects', input.companyId, evidence.researchProjects);
  for (const memory of input.memories) {
    assertNoInternalMarkers('memories', memory.summary);
  }
  for (const grudge of input.memory.grudges) {
    assertNoInternalMarkers('memory.grudges', grudge.reason);
  }
  for (const attempt of input.memory.attempts) {
    assertNoInternalMarkers('memory.attempts', `${attempt.what} ${attempt.outcome}`);
  }
  for (const change of input.changedSinceLastQuarter.changes) {
    assertNoInternalMarkers('changedSinceLastQuarter', change.detail);
  }
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
  if (input.persona !== null && evidence.ownCharacterIds.length > 0 && !evidence.ownCharacterIds.includes(input.persona.characterId)) {
    throw new LlmContextLeakError('persona', `"${input.persona.characterId}" does not work for "${input.companyId}"; a company is never handed somebody else's chief executive`);
  }

  const full = input.changedSinceLastQuarter.isFullBriefing;

  /** Counterparty names, so a grudge reads as a company rather than an id. */
  const nameOf = (id: string): string => {
    if (id === input.companyId) return input.companyName;
    const related = input.relationships.find((entry) => entry.counterpartyId === id);
    if (related !== undefined) return `${related.counterpartyName} (${id})`;
    const remembered = input.memories.find((entry) => entry.aboutId === id);
    return remembered === undefined ? id : `${remembered.aboutName} (${id})`;
  };

  // --- the person, and what their traits mean for the moves they pick ---
  const persona = input.persona === null ? null : personaParagraph(input, input.persona);
  const directives = input.persona === null ? [] : traitDirectives(input.persona.traits);

  // --- the engine-written memory: standing strategy, grudges, attempts ---
  const grudges = input.memory.grudges
    .slice()
    .reverse()
    .map((grudge) => `${nameOf(grudge.companyId)} — ${truncate(grudge.reason, 200)} (Q${grudge.quarter}, still at ${grudge.intensity} out of 100)`);

  const attempts = input.memory.attempts
    .slice()
    .reverse()
    .map((attempt) => `Q${attempt.quarter} ${attempt.what}: ${truncate(attempt.outcome, 240)}`);

  const standing =
    input.memory.standingStrategy.trim().length === 0
      ? null
      : `${input.memory.standingStrategy}\n(Unchanged since Q${input.memory.standingStrategyQuarter}.)`;

  // --- the character's own memories and feelings ---
  //
  // `input.memories` is the projected, bounded list the builder chose. The
  // `evidence` lists are the older typed path and are rendered only when the
  // projection is empty, so nothing is written twice.
  const characterMemories =
    input.memories.length > 0
      ? input.memories.map(
          (memory) =>
            `Q${memory.quarter} [${memory.kind}, ${memory.sentiment < 0 ? 'bitter' : memory.sentiment > 0 ? 'grateful' : 'neutral'}, salience ${num(memory.strength, 2)}] ` +
            `about ${memory.aboutName}: ${truncate(memory.summary, 240)}`,
        )
      : lastN(evidence.memories, 12).map(
          (memory) => `Q${memory.quarter} [${memory.kind}, salience ${num(memory.strength, 2)}] about ${memory.aboutId}: ${truncate(memory.summary, 240)}`,
        );

  const characterRelationships =
    input.relationships.length > 0
      ? input.relationships.map(
          (view) =>
            `${view.counterpartyName} (${view.counterpartyId})${view.isPlayerCompany ? ' — the player' : ''}: trust ${Math.round(view.trust)}, respect ${Math.round(view.respect)}, hostility ${Math.round(view.hostility)}`,
        )
      : evidence.relationships.map(
          (relationship) =>
            `${relationship.fromId} → ${relationship.toId}: trust ${relationship.trust}, respect ${relationship.respect}, hostility ${relationship.hostility}, dependence ${relationship.dependence}` +
            `${relationship.lastInteractionQuarter === null ? ', never spoken' : `, last spoke Q${relationship.lastInteractionQuarter}`}`,
        );

  // --- the delta, and the wide material it replaces ---
  const CHANGE_LABEL: Record<StrategistChangeKind, string> = {
    own_move: 'you',
    world: 'the world',
    rival: 'a rival',
    opportunity: 'procurement',
    deal: 'a deal',
  };
  const changes = input.changedSinceLastQuarter.changes.map((change) => `[${CHANGE_LABEL[change.kind]}] ${change.detail}`);

  // --- the rest of the dossier ---
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

  const rivals = evidence.rivalSignals.map((signal) => `${signal.companyId} (via ${signal.basis}): ${truncate(signal.observation, 240)}`);

  const events = evidence.recentPublicEvents.map(
    (event) => `Q${event.quarter} [${event.type}] ${event.title}${event.stillActive ? ' — still active' : ''}`,
  );

  const history = lastN(evidence.pastDecisions, NPC_DECISION_HISTORY_QUARTERS).map((decision) =>
    [`Q${decision.quarter} — posture ${decision.posture}`, `  intended: ${truncate(decision.strategySummary, 400)}`, `  outcome:  ${truncate(decision.outcomeSummary, 400)}`].join('\n'),
  );

  const prompt = joinBlocks([
    `# Quarter ${input.quarter} planning for ${input.companyName} (${input.companyId}) — session ${input.sessionId}`,
    persona,
    input.persona === null ? null : section('How you decide', bullets(directives)),
    standing === null ? null : section('What you are already doing', standing),
    grudges.length === 0 ? null : section('Who you have not forgotten', bullets(grudges)),
    characterMemories.length === 0 ? null : section('What you remember', bullets(characterMemories)),
    characterRelationships.length === 0 ? null : section('How you regard the people you deal with', bullets(characterRelationships)),
    attempts.length === 0 ? null : section('What you have tried lately, and what the world did with it', bullets(attempts)),
    section('Your position', input.companyBriefing),
    projects.length === 0 ? null : section('Your research programmes', bullets(projects)),
    full
      ? null
      : section(
          `What changed since quarter ${input.quarter - 1}`,
          [
            changes.length === 0 ? '(nothing material moved)' : bullets(changes),
            `This is an update, not a full briefing: the last full world and rival dossier was ${input.changedSinceLastQuarter.quartersSinceFullBriefing} quarter(s) ago. What is not listed here has not changed enough to matter.`,
          ].join('\n\n'),
        ),
    full ? section('The world, as you understand it', input.worldBriefing) : null,
    full ? section('Rivals — public information only', input.rivalBriefing) : null,
    full && rivals.length > 0 ? section('What you have observed about rivals, and how', bullets(rivals)) : null,
    full && events.length > 0 ? section('Recent public events', bullets(events)) : null,
    section('Procurement you can see', bullets(opportunities)),
    section('Deals awaiting your answer', bullets(deals)),
    section('Hard constraints', bullets([...input.constraints])),
    section('Last quarter', `Posture: ${input.priorPosture}\nStated strategy: ${truncate(input.priorStrategySummary, 600)}`),
    full && history.length > 0 ? section(`Your last ${NPC_DECISION_HISTORY_QUARTERS} quarters of decisions and what came of them`, history.join('\n\n')) : null,
    section(
      'Your task',
      [
        `Decide what ${input.companyName} attempts in quarter ${input.quarter}.`,
        'Return a strategySummary in your own terms, a posture, at most eight actions, and a rationale explaining why these actions given what you know.',
        'Choose as the person described above would choose, not as a neutral optimiser would.',
        `Set companyId to exactly ${input.companyId}.`,
      ].join('\n'),
    ),
  ]);

  return { system: NPC_STRATEGIST_SYSTEM, prompt };
}

/**
 * @frontier/llm — compose/innovationInterpreter.ts
 *
 * A player has proposed a technology the Frontier Map has never contained.
 *
 * The interpreter turns that idea into a typed node proposal: what it is, how
 * novel it is, how plausible it honestly is, what capabilities it needs, what
 * it would cost, how long it would take, and which existing nodes it builds on.
 *
 * It does **not** decide whether the node exists. The rules engine takes the
 * proposal and returns an `InnovationIntegrationResult` with its own
 * `adjustedPlausibility`, `adjustedCostUsd` and `adjustedQuarters`, which are
 * routinely far worse than the proposer's estimate. If accepted, the node
 * becomes real in that session's graph and carries its inventor's name for the
 * rest of the campaign.
 *
 * Honesty about plausibility is the load-bearing instruction: a low-plausibility
 * proposal is not rejected, it becomes an expensive speculative node. Inflating
 * plausibility to get a node accepted only produces a cheap-looking programme
 * that will not work.
 */

import type { InnovationInterpreterInput } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, num, section, truncate, usd } from './render';
import { assertNoInternalMarkers } from './redaction';

export const INNOVATION_INTERPRETER_SYSTEM = [
  'You are the Innovation Interpreter for Frontier Capital, a simulated AI-industry economy. A founder has proposed a technology that is not on the Frontier Map.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Your job is to state, in typed form, what they are actually proposing:',
  '- `summary` describes the mechanism, not the marketing. Two to four sentences.',
  '- `novelty` measures distance from what the world already believes: 0.2 restates the consensus, 0.85 is a genuinely new direction.',
  '- `plausibility` measures consistency with known physics, economics and the current frontier. Be honest. A low-plausibility proposal is NOT rejected — it becomes a speculative node that will be expensive to prove. Inflating this number helps nobody.',
  '- `estimatedCost` and `estimatedQuarters` are your best estimate. The rules engine will adjust both, often far upward.',
  '- `dependencies` may contain only node ids present in the map below. Unknown ids are dropped.',
  '- `requiredCapabilities` are capability areas, checked against what this company can actually do.',
  '- `initialVisibility` is "company_private" for a genuine edge, "public" to trade surprise for talent and capital.',
  '',
  'You may not add the node to the graph, set its real cost, or promise it will work. You describe; the engine decides.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

export function composeInnovationInterpreter(input: InnovationInterpreterInput): ComposedPrompt {
  assertNoInternalMarkers('worldContext', input.worldContext);

  const nodes = input.existingNodes.map((node) => `${node.nodeId} — "${node.title}" [${node.status}], public confidence ${num(node.publicConfidence, 2)}`);
  const capabilities = input.companyCapabilities.map((capability) => `${capability.area}: ${num(capability.strength, 2)}`);
  const resources = [
    `cash: ${usd(input.companyResources.cashUsd)}`,
    `R&D per quarter: ${usd(input.companyResources.quarterlyRdUsd)}`,
    `researchers: ${input.companyResources.researchers}`,
    `compute: ${input.companyResources.computeUnits} accelerator-equivalents`,
  ];

  const experimentTask = input.experimentMode === 'design' ? [
    'Design an exploratory experiment, not a guaranteed technology unlock. Return experiment with question, method, budgetUsd, computeUnits, researchersAssigned and reviewAfterQuarters.',
    'The resource mandate in the context is binding. Use exactly those resource ceilings, including autonomous and spendingLimitUsd when present. estimatedCost is the cash budget times the review interval; do not inflate it into the cost of an eventual breakthrough.',
    'The founder may ask agents to evolve, search, invent or investigate an unknown. Describe what they will try and how observations will be evaluated. No existing technology node is required as the destination.',
    'Set experimentReview to null. Fill the ordinary proposal fields too; keep initialVisibility company_private. No success is promised.',
  ] : input.experimentMode === 'review' ? [
    'Adjudicate the findings of a FICTIONAL in-game experiment from its question, method, recorded resource use and previous findings. You determine a plausible result; this is not a report of a real laboratory run.',
    'Return experimentReview with the exact projectId, round and elapsedQuarters in the context. Set experiment to null.',
    'Choose promising, unexpected, inconclusive, negative, or evaluation_failure. Do not always reward ambition or assume self-improvement works. Distinguish observation from interpretation; explain limits and alternative explanations.',
    'Invent specific, coherent in-world observations shaped by THIS method and history, not a generic quality bonus. Do not invent resources spent or results of experiments that were never run.',
    'Propose 1–4 concrete nextDirections: continued evolution, a changed test, investigating a surprising result, or a follow-up research thesis. Preserve discoveries and failures from prior rounds.',
    'capabilityGains may be empty. Only promising or unexpected findings justify small gains in capability areas listed in the dossier, with total gain at most 0.02. A failed evaluation grants none.',
    'Return hypotheses: 0–3 distinct follow-up technologies supported by the observations. Each needs title, summary, requiredCapabilities, estimatedCost, estimatedQuarters, novelty and plausibility. These create real, unfunded research nodes. Do not repeat existingResearchBranches, rename an old lead, or create arbitrary branches every quarter. Failures can suggest new tests or falsify a direction.',
    'Return recommendation (continue, ask_founder, stop) and nextMethod (an adapted method or null). In autonomous mode, continue investigating the mandate while resources remain, carrying forward prior findings and testing emerging behaviours. Do not simply rephrase the first answer every round. Ask the founder if the next step needs a different objective or additional resources; stop if the investigation has exhausted its useful directions. You cannot raise the cash ceiling.',
    'Fill the ordinary proposal fields as a short summary of this review; the review records findings on the existing project and does not create another technology. Its title may repeat the existing experiment title.',
  ] : [
    'Express this idea as one typed node proposal. Set experiment and experimentReview to null.',
    'Depend only on node ids listed above, and do not duplicate a node that already exists — if the idea restates one, say so in the rationale and set novelty low.',
    'Be honest about plausibility and about cost relative to what this company can afford.',
  ];
  const prompt = joinBlocks([
    `# Innovation proposal — quarter ${input.quarter}, session ${input.sessionId}, company ${input.companyId}`,
    section('The founder\'s idea, in their own words', truncate(input.playerIdea, 4000)),
    section('The current Frontier Map', bullets(nodes)),
    section('What this company can actually do today', bullets(capabilities)),
    section('What this company can actually afford', bullets(resources)),
    section('World conditions bearing on feasibility', input.worldContext),
    section('Experiment mandate and recorded history', input.experimentContext ?? '(ordinary technology proposal)'),
    section(
      'Your task',
      experimentTask.join('\n'),
    ),
  ]);

  return { system: INNOVATION_INTERPRETER_SYSTEM, prompt };
}

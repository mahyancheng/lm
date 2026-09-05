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

  const prompt = joinBlocks([
    `# Innovation proposal — quarter ${input.quarter}, session ${input.sessionId}, company ${input.companyId}`,
    section('The founder\'s idea, in their own words', truncate(input.playerIdea, 4000)),
    section('The current Frontier Map', bullets(nodes)),
    section('What this company can actually do today', bullets(capabilities)),
    section('What this company can actually afford', bullets(resources)),
    section('World conditions bearing on feasibility', input.worldContext),
    section(
      'Your task',
      [
        'Express this idea as one typed node proposal.',
        'Depend only on node ids listed above, and do not duplicate a node that already exists — if the idea restates one, say so in the rationale and set novelty low.',
        'Be honest about plausibility and about cost relative to what this company can afford.',
      ].join('\n'),
    ),
  ]);

  return { system: INNOVATION_INTERPRETER_SYSTEM, prompt };
}

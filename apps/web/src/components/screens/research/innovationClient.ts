/**
 * The client half of the innovation interpreter.
 *
 * `@/lib/llm/client` covers the five roles the shell owns; the interpreter is
 * the Research screen's own, so its fetcher lives beside the screen that uses
 * it. The contract is identical to the shell's: one POST, a 45-second ceiling,
 * and `null` for every failure — no transport, a refusal, a timeout, malformed
 * JSON. Nothing here imports `@frontier/llm`; the Agent SDK stays on the server.
 *
 * **Null is a designed answer, not an error.** The innovation fallback declines
 * rather than inventing a thesis, because a node is never added to the Frontier
 * Map without interpretation. The caller's deterministic path is the guided
 * form, where the player states the same fields in their own hand.
 */

import type { Company, InnovationInterpreterInput, InnovationProposal, SessionState, TechGraph } from '@frontier/contracts';

const TIMEOUT_MS = 45_000;

interface RoleResponse {
  readonly output: InnovationProposal | null;
  readonly fallback: boolean;
  readonly reason?: string;
}

/** Ask the interpreter to turn a free-text thesis into a typed proposal. */
export async function requestInnovation(input: InnovationInterpreterInput): Promise<InnovationProposal | null> {
  if (typeof window === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch('/api/llm/innovation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as RoleResponse;
    return parsed.output ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One line of world context the interpreter uses to judge feasibility. */
export function worldContextOf(session: SessionState): string {
  const world = session.world;
  return [
    `Accelerator supply ${world.compute.acceleratorSupply.toFixed(2)}, spot price index ${world.compute.spotPrice.toFixed(2)}, fab capacity ${world.compute.fabCapacity.toFixed(2)}.`,
    `Electricity price index ${world.energy.electricityPrice.toFixed(2)}, datacentre access ${world.energy.datacentreAccess.toFixed(2)}.`,
    `Researcher supply ${world.talent.researcherSupply.toFixed(2)} at a salary pressure of ${world.talent.salaryPressure.toFixed(2)}.`,
    `Frontier capability ${world.aiFrontier.frontierCapability.toFixed(2)}, training efficiency ${world.aiFrontier.trainingEfficiency.toFixed(2)}, inference cost index ${world.aiFrontier.inferenceCost.toFixed(2)}.`,
    `Model rules ${world.regulation.modelRules.toFixed(2)}, export controls ${world.regulation.exportControls.toFixed(2)}.`,
  ].join(' ');
}

/**
 * Everything the interpreter is allowed to see, built from the player's own
 * state. `graph` must be the **reduced** map (`PlayerView.techGraph`): a rival's
 * private node has no business in a prompt, and the redaction guard in
 * `@frontier/llm` treats one reaching a composer as a leak, not a mistake.
 */
export function buildInnovationInput(
  session: SessionState,
  company: Company,
  graph: TechGraph,
  playerIdea: string,
  researchEnvelopeUsd: number,
  computeUnits: number,
): InnovationInterpreterInput {
  return {
    sessionId: session.sessionId,
    quarter: session.quarter,
    companyId: company.id,
    playerIdea,
    existingNodes: graph.nodes.map((node) => ({
      nodeId: node.id,
      title: node.title,
      status: node.status,
      publicConfidence: node.publicConfidence,
    })),
    companyCapabilities: Object.entries(company.techCapabilities).map(([area, strength]) => ({ area, strength })),
    companyResources: {
      cashUsd: company.financials.cash,
      quarterlyRdUsd: researchEnvelopeUsd,
      researchers: company.employees.researchers,
      computeUnits,
    },
    worldContext: worldContextOf(session),
  };
}

/**
 * @frontier/simulation — research
 *
 * The Frontier Map subsystem: programmes, achievement, belief and player
 * invention. It implements `ResearchSubsystem` from `@frontier/contracts/engine`
 * and runs inside `research_resolution` (phase 9), except
 * `integrateInnovationProposal`, which the resolver calls once per
 * `propose_innovation` action.
 *
 * The order inside the phase is: advance the programmes, achieve what has
 * finished, then move belief — so that a demonstration made this quarter is
 * already in the world when confidence is recomputed. `updateTechConfidence`
 * tolerates the reverse order too: a publication is honoured whether the
 * programme was marked succeeded before or after it.
 *
 * ## The invariant this subsystem exists to protect
 *
 * Canonical private reality and public belief are separate, and only a
 * deliberate act crosses between them. A secret programme's progress, setbacks
 * and completion are written to the ledger at `private` visibility, produce no
 * line in the quarter report and leave the node's public confidence, epistemic
 * state and visibility untouched. `publish_research` — or, later, a leak — is
 * what makes an achievement public.
 */

import type { ResearchSubsystem } from '@frontier/contracts';
import { advanceProjects } from './progress';
import { achieveNodes } from './nodes';
import { updateTechConfidence } from './confidence';
import { integrateInnovationProposal } from './innovation';

export { advanceProjects, resourcingFactors, setbackProbability } from './progress';
export type { ResourcingFactors } from './progress';
export { achieveNodes, dependencySatisfied, unmetDependencies } from './nodes';
export { updateTechConfidence } from './confidence';
export { integrateInnovationProposal, assessPlausibility, assessCostUsd, reachableCapitalUsd } from './innovation';
export { publicTechGraph, techGraphForCompany, publicResearchProjects, researchProjectsForCompany, isNodePublic } from './projection';
export * from './balance';

/**
 * Build the research subsystem. Stateless: everything it needs comes from the
 * draft and the resolver context.
 */
export function createResearchSubsystem(): ResearchSubsystem {
  return {
    advanceProjects,
    updateTechConfidence,
    achieveNodes,
    integrateInnovationProposal,
  };
}

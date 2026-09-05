/**
 * @frontier/simulation — research/projection.ts
 *
 * Redaction helpers for the technology layer.
 *
 * `SessionState` holds canonical private reality: every secret programme, every
 * company's private confidence, every internal estimate. None of that may reach
 * a client. These pure functions produce the reduced views the read models are
 * built from, and the research tests assert against them — a secret programme
 * that shows up in a public projection is a failed invariant
 * (`information_boundary`), not a cosmetic bug.
 */

import type { ResearchProject, SessionState, TechGraph, TechNode } from '@frontier/contracts';

/** A node with every company's private confidence removed. */
function stripPrivateConfidence(node: TechNode): TechNode {
  return { ...node, confidenceByCompany: {} };
}

/** A node reduced to what one company may see: the public figure and its own. */
function forCompany(node: TechNode, companyId: string): TechNode {
  const own = node.confidenceByCompany[companyId];
  return { ...node, confidenceByCompany: own === undefined ? {} : { [companyId]: own } };
}

/** True when a node's existence is public knowledge. */
export function isNodePublic(node: TechNode): boolean {
  return node.visibility === 'public' || node.visibility === 'sector';
}

/**
 * The Frontier Map as the world sees it: public nodes only, no private
 * confidences, and edges pruned to the surviving nodes.
 */
export function publicTechGraph(graph: TechGraph): TechGraph {
  const nodes = graph.nodes.filter(isNodePublic).map(stripPrivateConfidence);
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

/**
 * The Frontier Map as one company sees it: public nodes plus its own private
 * ones, with private confidence reduced to its own entry.
 */
export function techGraphForCompany(graph: TechGraph, companyId: string): TechGraph {
  const nodes = graph.nodes
    .filter((n) => isNodePublic(n) || n.achievedByCompanyId === companyId || n.confidenceByCompany[companyId] !== undefined)
    .map((n) => forCompany(n, companyId));
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

/**
 * Research programmes the world can see. A secret programme is not redacted, it
 * is absent: rivals cannot see that it exists at all until it is published,
 * leaked or demonstrated in a product.
 */
export function publicResearchProjects(draft: SessionState): ResearchProject[] {
  return draft.researchProjects.filter((p) => !p.isSecret);
}

/** Research programmes one company can see: everything of its own, plus public work. */
export function researchProjectsForCompany(draft: SessionState, companyId: string): ResearchProject[] {
  return draft.researchProjects.filter((p) => p.companyId === companyId || !p.isSecret);
}

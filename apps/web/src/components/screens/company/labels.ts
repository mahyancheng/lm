/**
 * Display vocabulary for the Company screen.
 *
 * Every map here turns an engine enum into the words a founder would use. No
 * figures are derived in this file — labels only.
 */

import type { CompanyArchetype, CompanyPosture, StaffRole } from '@frontier/contracts';

export const ARCHETYPE_LABEL: Readonly<Record<CompanyArchetype, string>> = {
  frontier_lab: 'Frontier lab',
  enterprise_ai: 'Enterprise AI',
  consumer_ai: 'Consumer AI',
  infrastructure: 'Infrastructure',
  chip_maker: 'Chip maker',
  cloud: 'Cloud',
  data: 'Data',
  defence_ai: 'Defence AI',
};

export const ARCHETYPE_BLURB: Readonly<Record<CompanyArchetype, string>> = {
  frontier_lab: 'Trains state-of-the-art models and burns compute.',
  enterprise_ai: 'Sells seats and services to businesses.',
  consumer_ai: 'Sells to the public.',
  infrastructure: 'Builds datacentres and platforms.',
  chip_maker: 'Designs or fabricates accelerators.',
  cloud: 'Rents capacity.',
  data: 'Licenses and curates corpora.',
  defence_ai: 'Serves government and security customers.',
};

export const POSTURE_LABEL: Readonly<Record<CompanyPosture, string>> = {
  aggressive_growth: 'Aggressive growth',
  balanced: 'Balanced',
  efficiency: 'Efficiency',
  research_first: 'Research first',
  land_grab: 'Land grab',
  consolidation: 'Consolidation',
  defensive: 'Defensive',
  survival: 'Survival',
};

export const POSTURE_BLURB: Readonly<Record<CompanyPosture, string>> = {
  aggressive_growth: 'Spends ahead of revenue.',
  balanced: 'Holds growth and margin together.',
  efficiency: 'Protects margin.',
  research_first: 'Prioritises the frontier over near-term product.',
  land_grab: 'Buys market share with price.',
  consolidation: 'Acquires.',
  defensive: 'Protects existing accounts.',
  survival: 'Preserves cash.',
};

export const ROLE_LABEL: Readonly<Record<StaffRole, string>> = {
  engineers: 'Engineers',
  researchers: 'Researchers',
  sales: 'Sales',
  ops: 'Operations',
  execs: 'Executives',
};

export const ROLE_BLURB: Readonly<Record<StaffRole, string>> = {
  engineers: 'Build product and platform.',
  researchers: 'Advance the frontier. The binding constraint on research throughput.',
  sales: 'Convert enterprise and government demand.',
  ops: 'Run infrastructure, support, security and compliance.',
  execs: 'The leadership layer.',
};

/** The five reputation audiences, in the order the screen always shows them. */
export const REPUTATION_AUDIENCES = [
  { key: 'public', label: 'Public', blurb: 'How the general public regards the company.' },
  { key: 'developer', label: 'Developer', blurb: 'Open weights and documentation raise it; price rises and deprecations lower it.' },
  { key: 'enterprise', label: 'Enterprise', blurb: 'Reliability, security posture and delivery record.' },
  { key: 'government', label: 'Government', blurb: 'Distinct from the formal procurement past-performance score.' },
  { key: 'investor', label: 'Investor', blurb: 'Credibility spent on guidance and recovered slowly after a miss.' },
] as const;

/** Human wording for a capability area id. */
export function capabilityLabel(area: string): string {
  return area
    .split('_')
    .map((part) => (part.length === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(' ');
}

/**
 * @frontier/simulation — graph/describe.ts
 *
 * One line of a world-3 company, said the way its founder would say it:
 *
 *   "your AI software suite on Basalt's inference API with an agent harness
 *    from the open market, aimed at logistics enterprises"
 *
 * The sentence is the composition read back — which node sits in each slot,
 * where it comes from, and who the line is aimed at — and it is built here,
 * once, for the Chief of Staff dossier, the drawer subtitle and the canvas
 * card, so every surface describes the same line in the same words.
 *
 * The rules that shape it:
 *
 * - **Possessive from the viewer.** The company reading its own dossier hears
 *   "your"; a rival's line is "Basalt's". A source the company runs itself is
 *   "your own" or "its own"; a named seller is possessive; the open market is
 *   "from the open market".
 * - **Two slots, by value.** The two slots carrying the largest share of the
 *   unit cost are named, in that order — the ones that decide whether the
 *   business works. Ties fall back to the table's slot order. An empty slot
 *   is not a slot the line runs on and is never named.
 * - **The target closes it.** The customer type and, when the customer is not
 *   the public, the industry, from `targetOf` — the same resolution the market
 *   sells the line into.
 * - **No ids.** Labels and names only: a sentence a founder reads, not a row a
 *   screen keys on.
 *
 * Pure: a function of the draft alone. Every price it ranks by comes from
 * `unitCostOf`, so the slot it calls biggest is the slot the roll-up books
 * biggest.
 */

import type { Company, EconomicNode, NodeCostCache, Product, ProductSegment, SessionState, UnitCostLine } from '@frontier/contracts';
import { SECTOR_META, economicNodeById, type Sector } from '@frontier/contracts';
import { unitCostOf } from './cost';
import { lineNodeIdOf } from './lines';
import { targetOf } from './slots';

/** How many slots the sentence names. Two reads as a sentence; six reads as a bill of materials. */
export const DESCRIBED_SLOTS = 2;

/* -------------------------------------------------------------------------- */
/*  Words                                                                      */
/* -------------------------------------------------------------------------- */

/** "Basalt's", "Nexus'": the English possessive of a proper name. */
export function possessiveOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  return trimmed.endsWith('s') || trimmed.endsWith('S') ? `${trimmed}'` : `${trimmed}'s`;
}

/**
 * A node label in running prose: "Inference API" reads "inference API",
 * "AI software suite" stays as it is. Only a word-initial capital followed by
 * a lower-case letter is a sentence-case capital; an acronym keeps its case.
 */
export function proseLabel(label: string): string {
  const first = label.charAt(0);
  const second = label.charAt(1);
  if (first === '' || second === '' || first !== first.toUpperCase() || second !== second.toLowerCase()) return label;
  return `${first.toLowerCase()}${label.slice(1)}`;
}

/**
 * Last words of node labels that take no indefinite article: plurals
 * ("permanent magnets", "rare earth oxides") and mass nouns ("robot
 * telemetry", "structural steel", "grid power"). Everything else in the table
 * is countable — "an inference API", "a frontier model", "a curated corpus".
 */
const NO_ARTICLE_ENDINGS: ReadonlySet<string> = new Set([
  'material', 'graphite', 'data', 'composite', 'capacity', 'diesel', 'separator', 'management', 'brokerage', 'balancing',
  'interconnection', 'power', 'supply', 'carbonate', 'sulphate', 'evaluation', 'gas', 'packaging', 'polysilicon', 'telemetry',
  'media', 'steel', 'fuel', 'tooling', 'mile', 'haul',
]);

/** "an inference API", "a frontier model", "permanent magnets": the indefinite article, or none for a plural or mass noun. */
export function withArticle(phrase: string): string {
  const trimmed = phrase.trim();
  const words = trimmed.toLowerCase().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  if (last === '' || last.endsWith('s') || NO_ARTICLE_ENDINGS.has(last)) return trimmed;
  return `${'aeiou'.includes(trimmed.charAt(0).toLowerCase()) ? 'an' : 'a'} ${trimmed}`;
}

/** The industry in words, as `SECTOR_META` labels it: "logistics", "AI". */
export function industryWord(sector: Sector): string {
  return proseLabel(SECTOR_META[sector].label);
}

/**
 * Who a line is aimed at, in words: "logistics enterprises", "AI developers",
 * "government buyers in energy", or "consumers" — selling to the public has no
 * industry, and the sentence does not pretend it has.
 */
export function targetPhrase(industry: Sector, customer: ProductSegment): string {
  switch (customer) {
    case 'consumer':
      return 'consumers';
    case 'enterprise':
      return `${industryWord(industry)} enterprises`;
    case 'developer_api':
      return `${industryWord(industry)} developers`;
    case 'government':
      return `government buyers in ${industryWord(industry)}`;
    default: {
      const exhaustive: never = customer;
      return String(exhaustive);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The sentence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The possessive that opens the sentence and the one used for a slot the
 * company fills from its own line, both from the viewer's seat.
 */
function voiceFor(company: Company, viewerCompanyId: string): { readonly owner: string; readonly own: string } {
  return company.id === viewerCompanyId ? { owner: 'your', own: 'your own' } : { owner: possessiveOf(company.name), own: 'its own' };
}

/**
 * One filled slot as a phrase: "Basalt's inference API", "your own small
 * model", "an agent harness from the open market". `own` is the possessive for
 * a slot the company fills from its own line — "your own", "its own", "our
 * own" — because the same row is read from three seats. A blocked slot —
 * nobody in the world can make what sits in it — says so, because that is the
 * fact a founder most needs to hear about it.
 */
export function describeSource(state: SessionState, row: UnitCostLine, own: string, blocked: boolean): string {
  const label = proseLabel(economicNodeById(row.nodeId ?? '')?.label ?? row.label);
  if (blocked) return `${withArticle(label)} nobody can yet make`;
  switch (row.sourceKind) {
    case 'make':
      return `${own} ${label}`;
    case 'buy': {
      const seller = state.companies.find((entry) => entry.id === row.sourceCompanyId);
      return seller === undefined ? `${withArticle(label)} from a named supplier` : `${possessiveOf(seller.name)} ${label}`;
    }
    default:
      return `${withArticle(label)} from the open market`;
  }
}

/**
 * The slot rows of a roll-up worth naming, largest share of the unit cost
 * first, ties in the table's slot order. Empty slots are dropped: a slot the
 * line does not run on is not part of what the line is.
 */
function describedRows(node: EconomicNode, lines: readonly UnitCostLine[]): readonly UnitCostLine[] {
  const order = new Map<string, number>(node.slots.map((slot, index) => [slot.id, index]));
  return lines
    .filter((row) => row.slotId !== undefined && row.nodeId !== null && row.nodeId !== undefined)
    .sort((a, b) => b.amountUsd - a.amountUsd || (order.get(a.slotId ?? '') ?? 0) - (order.get(b.slotId ?? '') ?? 0))
    .slice(0, DESCRIBED_SLOTS);
}

/**
 * Describe one line from `viewerCompanyId`'s seat.
 *
 * Returns "" for a product that is not a node line — a world-2 product, or a
 * world-3 product on a node the table no longer carries — so a caller can
 * print nothing rather than a sentence about nothing. With a cache the roll-up
 * is the memoised one the resolver already computed.
 */
export function describeLine(state: SessionState, company: Company, product: Product, viewerCompanyId: string, cache?: NodeCostCache): string {
  const nodeId = lineNodeIdOf(product);
  const node = nodeId === null ? undefined : economicNodeById(nodeId);
  if (node === undefined) return '';

  const voice = voiceFor(company, viewerCompanyId);
  const cost = unitCostOf(state, company, node.id, cache);
  const blocked = new Set(cost.blockedInputNodeIds);
  const rows = describedRows(node, cost.lines);

  const phrases = rows.map((row) => describeSource(state, row, voice.own, blocked.has(row.nodeId ?? '')));
  const composition = phrases.length === 0 ? '' : ` on ${phrases[0]}${phrases.length > 1 ? ` with ${phrases[1]}` : ''}`;
  const target = targetPhrase(targetOf(product, node), product.segment);

  return `${voice.owner} ${proseLabel(node.label)}${composition}, aimed at ${target}`;
}

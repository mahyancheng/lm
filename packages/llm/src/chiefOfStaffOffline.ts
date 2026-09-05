/**
 * @frontier/llm — chiefOfStaffOffline.ts
 *
 * The Chief of Staff with no model behind it.
 *
 * `failure_mode` is an engine invariant: the game never blocks on a model, and
 * `LLM_TRANSPORT=none` is a supported configuration — it is what demo mode runs
 * on. The old fallback echoed the instruction back as a question, which is the
 * right answer for an *instruction* and a useless one for a *question*: a
 * founder who typed "how much cash have we got?" was told the model was down.
 *
 * With the typed dossier in hand that is no longer necessary. The common
 * questions — cash, runway, burn, best and worst product, who is circling us,
 * what needs deciding, what can I even do — are all answerable from state by
 * arithmetic, and arithmetic does not need a language model. So this module
 * answers them, in whole figures, and offers the click path. Anything it cannot
 * classify still falls back to asking, because inventing a decision on a
 * founder's behalf is the one thing this role must never do.
 *
 * Everything here is **pure**: same input, same output, no RNG, no clock, no
 * state. It runs inside a resolution whose contract is
 * `S_{t+1} = F(S_t, actions, modifiers, seed)`, so anything it produces has to
 * be reproducible from the recorded inputs alone.
 *
 * It never *composes* an `ActionIntent`. Answering is safe without a model;
 * translating an instruction into a binding proposal is not. What it may do,
 * since the sourcing stage, is hand back an action the **engine** built: a
 * findings row from `runLookups` carries the exact intent the validator accepts,
 * and passing that through is quoting the engine rather than guessing at the
 * founder's intent. `requiresConfirmation` stays true on every one of them.
 *
 * ## Sourcing without a model
 *
 * The same two-turn loop the model uses runs here. A message that asks about the
 * market — "buy a small data centre", "who could we acquire", "can we borrow" —
 * is matched against a keyword table, answered with `mode: 'research'` and a
 * list of lookups, and comes back with `findings` attached, which this module
 * then reads out. With no model at all, "buy a small data centre" still returns
 * the sellers, the price, the units, the cash afterwards and an action to
 * approve.
 */

import type {
  ActionIntent,
  ChiefOfStaffDossier,
  ChiefOfStaffInput,
  ChiefOfStaffInterpretation,
  CosProductLine,
  LookupKind,
  LookupRequest,
  LookupResult,
} from '@frontier/contracts';
import { MAX_LOOKUPS_PER_TURN } from '@frontier/contracts';
import { formatCount, formatMoney, formatQuarterCount } from '@frontier/shared';
import { truncate } from './compose/render';

/* -------------------------------------------------------------------------- */
/*  Question classification                                                    */
/* -------------------------------------------------------------------------- */

export const COS_QUESTION_KINDS = [
  'cash',
  'runway',
  'burn',
  'best_product',
  'worst_product',
  'threats',
  'decisions',
  'capabilities',
  'people',
  'board',
  // STAGE 5 — consolidated across every company the seat directs, not this
  // one alone. Appended: enum growth stays at the end.
  'group',
  // World 3 — what a line is built on: the composition sentence the dossier
  // carries per line. Appended before the fallback, as `group` was.
  'composition',
  'unclassified',
] as const;
export type CosQuestionKind = (typeof COS_QUESTION_KINDS)[number];

/**
 * Which question was asked, by keyword.
 *
 * The order is the precedence, and it is fixed: "how much runway does our cash
 * buy" is a runway question, not a cash question, because runway is tested
 * first. A keyword table is a blunt instrument and it is the right one here —
 * it is inspectable, it is deterministic, and it is only ever used when there
 * is no model to do better.
 */
const PATTERNS: readonly (readonly [CosQuestionKind, readonly string[]])[] = [
  // Tested first: "what is my app built on" and "which model does our suite
  // run on" share no needle with anything below, and "run on" must not be
  // read as "run out".
  ['composition', ['built on', 'built with', 'run on', 'runs on', 'running on', 'which model', 'what model', 'which harness', 'what harness', 'composed of', 'made up of', 'aimed at', 'built as']],
  ['runway', ['runway', 'how long can we last', 'how long do we have', 'out of money', 'run out']],
  ['burn', ['burn', 'burning', 'spending a quarter', 'how much are we spending']],
  ['cash', ['cash', 'how much money', 'bank', 'balance', 'liquid']],
  ['worst_product', ['worst product', 'worst line', 'losing money', 'weakest product', 'which product is bad', 'lowest margin']],
  ['best_product', ['best product', 'best line', 'strongest product', 'biggest product', 'top product', 'best seller']],
  ['threats', ['attacking', 'attack us', 'coming after', 'against us', 'threat', 'activist', 'circling', 'who is after', 'hostile']],
  ['decisions', ['what needs deciding', 'needs deciding', 'waiting on me', 'open decision', 'what should i decide', 'what is pending', 'anything for me']],
  ['capabilities', ['what can i do', 'what can we do', 'what are my options', 'what actions', 'what is available', 'what can you do']],
  ['people', ['headcount', 'how many people', 'staff', 'morale', 'team size', 'employees']],
  ['board', ['board', 'directors', 'ownership', 'control', 'my stake']],
  // STAGE 5: consolidated across every company the seat directs. Tested before
  // nothing above it collides — "the group" does not otherwise appear in any
  // of the earlier patterns.
  ['group', ['group', 'consolidat', 'subsidiar', 'whole empire', 'across the companies', 'across all my companies']],
];

/** Classify a founder's message. Lower-cased substring matching, first pattern wins. */
export function classifyQuestion(message: string): CosQuestionKind {
  const text = message.toLowerCase();
  for (const [kind, needles] of PATTERNS) {
    for (const needle of needles) {
      if (text.includes(needle)) return kind;
    }
  }
  return 'unclassified';
}

/* -------------------------------------------------------------------------- */
/*  Sourcing: which lookups a message asks for                                 */
/* -------------------------------------------------------------------------- */

/**
 * Phrasings that mean "go and look at the market", in precedence order.
 *
 * A keyword table is a blunt instrument and it is the right one here for the
 * same reason `PATTERNS` is: it is inspectable, it is deterministic, and it only
 * ever runs when there is no model to do better. The first match wins, and
 * `own_position` is appended to it rather than matched on its own — every one of
 * these questions is really "and what does that do to us".
 */
const SOURCING_PATTERNS: readonly (readonly [LookupKind, readonly string[]])[] = [
  [
    'compute_market',
    ['data center', 'data centre', 'datacenter', 'datacentre', 'accelerator', 'gpu', 'buy compute', 'more compute', 'cloud capacity', 'server', 'chips'],
  ],
  ['acquisition_targets', ['acquire', 'acquisition', 'buy a company', 'buy out', 'takeover', 'take over', 'merge with', 'm&a', 'target list']],
  ['debt_headroom', ['borrow', 'debt', 'a loan', 'credit line', 'leverage', 'refinance']],
  ['government_programmes', ['government', 'procurement', 'agency', 'tender', 'public contract', 'bid on']],
  ['hiring_market', ['hire', 'hiring', 'recruit', 'headcount cost', 'what does an engineer cost', 'salaries', 'salary']],
  ['launchable_lines', ['what could i launch', 'what can i launch', 'new product line', 'new line', 'launch a product', 'what should we launch', 'what can we build']],
];

/** A number written in the message, e.g. "buy 500 accelerators". 0 when none. */
export function unitsInMessage(message: string): number {
  const match = /(\d[\d,]*)/.exec(message.replace(/[$£€]\s?\d[\d,]*/g, ''));
  if (match === null) return 0;
  const value = Number(match[1]?.replace(/,/g, '') ?? '0');
  return Number.isFinite(value) && value > 0 && value < 1_000_000 ? Math.round(value) : 0;
}

/** One market request, with the parameters its kind carries. */
function marketRequest(kind: LookupKind, message: string): LookupRequest | null {
  switch (kind) {
    case 'compute_market':
      return { kind, units: unitsInMessage(message) };
    case 'acquisition_targets':
      return { kind, sector: '', region: '', maxValueUsd: 0, keyword: '' };
    case 'hiring_market':
      return { kind, role: null };
    case 'debt_headroom':
      return { kind: 'debt_headroom' };
    case 'government_programmes':
      return { kind: 'government_programmes' };
    case 'launchable_lines':
      return { kind: 'launchable_lines' };
    // `suppliers` and `customers` each need a category or product id no
    // keyword table can safely guess, so they are never matched by
    // `SOURCING_PATTERNS` and never reached here from a real message — but the
    // model may still ask for either in `research` mode, and a findings turn
    // built from that request has to come back through this same offline path
    // if the model then goes unreachable, so the exhaustive switches below
    // (`answerFromFinding`, `actionsFromFindings`) still answer them.
    case 'suppliers':
    case 'customers':
    // `unit_cost`, `entry_path` and `slot_candidates` are the same shape of
    // problem: each needs a node id, a slot id or a sector the founder named,
    // which a keyword table cannot safely guess from free text, so none is
    // ever built here.
    case 'unit_cost':
    case 'entry_path':
    case 'slot_candidates':
    // `own_position` is always appended and is never the market half.
    case 'own_position':
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * The lookups a message asks for, or an empty list when it asks for none.
 *
 * Bounded to `MAX_LOOKUPS_PER_TURN` by construction: at most one market kind
 * plus the company's own position.
 */
export function sourcingRequestsFor(message: string): LookupRequest[] {
  const text = message.toLowerCase();
  for (const [kind, needles] of SOURCING_PATTERNS) {
    if (!needles.some((needle) => text.includes(needle))) continue;
    const market = marketRequest(kind, message);
    if (market === null) continue;
    const requests: LookupRequest[] = [market, { kind: 'own_position' }];
    return requests.slice(0, MAX_LOOKUPS_PER_TURN);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/*  Sourcing: reading the findings back                                        */
/* -------------------------------------------------------------------------- */

const pctWhole = (value: number): string => `${Math.round(value)}%`;

/** A row label in running prose: "Inference API" reads "inference API"; an acronym keeps its case. */
const inProse = (label: string): string => {
  const first = label.charAt(0);
  const second = label.charAt(1);
  if (first === '' || second === '' || first !== first.toUpperCase() || second !== second.toLowerCase()) return label;
  return `${first.toLowerCase()}${label.slice(1)}`;
};

/** One finding as the sentences a founder reads. Every figure comes off the row. */
export function answerFromFinding(finding: LookupResult): string {
  switch (finding.kind) {
    case 'compute_market': {
      const buy = finding.sellers.filter((seller) => seller.offering === 'accelerators');
      const rent = finding.sellers.filter((seller) => seller.offering !== 'accelerators');
      if (buy.length === 0 && rent.length === 0) return 'Nobody is selling compute this quarter.';
      const first = buy[0];
      const lines: string[] = [];
      if (first !== undefined) {
        lines.push(
          `${first.name} will sell ${formatCount(first.sellableUnits)} accelerators at ${formatMoney(first.unitPriceUsd)} each. ${formatCount(
            finding.units,
          )} of them is ${formatMoney(finding.purchaseCostUsd)}, which takes cash from ${formatMoney(finding.cashUsd)} to ${formatMoney(
            finding.cashAfterPurchaseUsd,
          )}.${finding.solvencyLine === '' ? '' : ` ${finding.solvencyLine}`}`,
        );
      }
      lines.push(
        `Owned, that is ${formatMoney(finding.ownedQuarterlyCostUsd)} a quarter to run. Reserved it would be ${formatMoney(
          finding.reservedQuarterlyCostUsd,
        )} a quarter and on cloud ${formatMoney(finding.cloudQuarterlyCostUsd)} a quarter, with no capital down.`,
      );
      if (rent.length > 0) {
        lines.push(
          `Renting instead: ${rent
            .slice(0, 3)
            .map((seller) => `${seller.name} at ${formatMoney(seller.unitPriceUsd)} a unit (${formatCount(seller.sellableUnits)} spare)`)
            .join('; ')}.`,
        );
      }
      return lines.join(' ');
    }

    case 'acquisition_targets': {
      if (finding.rows.length === 0) return 'No active company matches that description.';
      return `${finding.rows.length} could be approached. ${finding.rows
        .slice(0, 3)
        .map(
          (row) =>
            `${row.name} (${row.sectorId}, ${row.region}, ${row.headcountBand} people) at about ${formatMoney(row.indicativePriceUsd)}, leaving ${formatMoney(
              row.cashAfterUsd,
            )}`,
        )
        .join('; ')}.`;
    }

    case 'debt_headroom':
      return finding.available
        ? `We could raise about ${formatMoney(finding.headroomUsd)} of debt at an indicative ${pctWhole(
            finding.indicativeCouponPct,
          )} coupon. Last quarter's operating income was ${formatMoney(finding.lastOperatingIncomeUsd)}.`
        : `No debt is available: ${finding.reason}`;

    case 'government_programmes':
      return finding.rows.length === 0
        ? 'Nothing we can see is still accepting bids.'
        : `${finding.rows.length} open: ${finding.rows
            .slice(0, 3)
            .map((row) => `${row.programme} up to ${formatMoney(row.maxValueUsd)}, closing quarter ${row.closeQuarter}`)
            .join('; ')}.`;

    case 'hiring_market':
      return `The market fills about ${pctWhole(finding.fillRatePct)} of an opened role a quarter. ${finding.rows
        .slice(0, 3)
        .map((row) => `${row.role} at ${row.band.replace(/_/g, ' ')} costs ${formatMoney(row.quarterlyCostUsd)} a quarter`)
        .join('; ')}.`;

    case 'own_position':
      return `Cash is ${formatMoney(finding.cashUsd)}, moving ${formatMoney(finding.quarterlyBurnUsd)} a quarter — ${formatQuarterCount(
        finding.runwayQuarters,
      )} of runway. ${finding.negativeCashQuarters} of the ${finding.solvencyQuartersAllowed} quarters that end the company have closed below zero.`;

    case 'launchable_lines': {
      const open = finding.rows.filter((row) => !row.locked);
      if (open.length === 0) return 'Nothing in our own industry is open to launch right now; every line is waiting on research.';
      return `${open.length} line${open.length === 1 ? '' : 's'} open now: ${open
        .slice(0, 3)
        .map((row) => `${row.label} at ${formatMoney(row.referencePriceUsd)} a ${row.unitLabel}`)
        .join('; ')}.`;
    }

    case 'suppliers':
      return finding.rows.length === 0
        ? 'Nobody currently publishes that as an input we could buy.'
        : `${finding.rows.length} would sell it to us; the best on quality per dollar is ${finding.rows[0]?.name ?? ''} at ${formatMoney(
            finding.rows[0]?.pricePerUnitUsd ?? 0,
          )} a unit.`;

    case 'customers':
      return finding.rows.length === 0
        ? 'Nobody is building on that line yet.'
        : `${finding.rows.length} compan${finding.rows.length === 1 ? 'y builds' : 'ies build'} on it, worth ${formatMoney(
            finding.rows.reduce((sum, row) => sum + row.revenueUsd, 0),
          )} this quarter.`;

    case 'unit_cost':
      return finding.unitCostUsd <= 0
        ? `${finding.label} costs nothing we can measure to make.`
        : `One ${finding.unitLabel} of ${finding.label} costs ${formatMoney(finding.unitCostUsd)} to make against a market price of ${formatMoney(
            finding.marketPriceUsd,
          )}${finding.rows[0] === undefined ? '' : `, and the biggest line of that is ${inProse(finding.rows[0].label)} at ${formatMoney(finding.rows[0].amountUsd)}`}.`;

    case 'slot_candidates': {
      if (finding.rows.length === 0) return `Nothing can fill the ${finding.slotLabel.toLowerCase()} slot right now.`;
      const named = finding.rows.slice(0, 3).map(
        (row) =>
          `${row.label} ${row.sourceKind === 'make' ? 'made ourselves' : row.sourceKind === 'buy' ? `from ${row.sellerName}` : 'from the open market'} at ${formatMoney(
            row.unitPriceUsd,
          )} a unit, quality ${row.qualityScorePct} of 100${row.blocked ? ' (blocked: nobody owns it)' : ''}`,
      );
      return `${finding.rows.length} way${finding.rows.length === 1 ? '' : 's'} to fill the ${finding.slotLabel.toLowerCase()} slot: ${named.join('; ')}.`;
    }

    case 'entry_path':
      return finding.alreadyIn
        ? 'We can already make something there.'
        : finding.rows.length === 0
          ? 'Nothing stands in the way of it.'
          : `${finding.rows.length} node${finding.rows.length === 1 ? '' : 's'} to own first, starting with ${finding.rows[0]?.label ?? ''}${
              finding.rows[0]?.researchable === true
                ? ` — a programme against it runs ${formatMoney(finding.rows[0]?.researchLowUsd ?? 0)} to ${formatMoney(finding.rows[0]?.researchHighUsd ?? 0)}`
                : ''
            }.`;

    default: {
      const exhaustive: never = finding;
      return String((exhaustive as { kind?: string }).kind ?? '');
    }
  }
}

/**
 * The actions a set of findings puts on the table, taken verbatim from the rows.
 *
 * Nothing is composed here. Each intent was built by `runLookups` inside the
 * engine from the same helpers the validator enforces, so what the founder is
 * offered is what the validator would accept.
 */
export function actionsFromFindings(findings: readonly LookupResult[]): ActionIntent[] {
  const out: ActionIntent[] = [];
  for (const finding of findings) {
    if (out.length >= 3) break;
    switch (finding.kind) {
      case 'compute_market': {
        const row = finding.sellers.find((seller) => seller.offering === 'accelerators' && seller.intent !== null) ?? finding.sellers[0];
        if (row?.intent != null) out.push(row.intent);
        break;
      }
      case 'acquisition_targets': {
        const row = finding.rows[0];
        if (row !== undefined) out.push(row.intent);
        break;
      }
      case 'debt_headroom':
        if (finding.intent !== null) out.push(finding.intent);
        break;
      case 'hiring_market': {
        const row = finding.rows.find((entry) => entry.intent !== null);
        if (row?.intent != null) out.push(row.intent);
        break;
      }
      case 'launchable_lines': {
        const row = finding.rows.find((entry) => entry.intent !== null);
        if (row?.intent != null) out.push(row.intent);
        break;
      }
      case 'suppliers': {
        const row = finding.rows.find((entry) => entry.intent !== null);
        if (row?.intent != null) out.push(row.intent);
        break;
      }
      case 'slot_candidates': {
        // The row the engine ranks first that carries a fill: the slot's own
        // order is the roll-up's, so this is the top route of the first node.
        const row = finding.rows.find((entry) => entry.intent !== null);
        if (row?.intent != null) out.push(row.intent);
        break;
      }
      // `customers` names counterparties; it carries no action of our own to offer.
      case 'customers':
      default:
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Product ranking                                                            */
/* -------------------------------------------------------------------------- */

/** Best line: most revenue, then best margin, then id. Total and deterministic. */
export function bestProduct(lines: readonly CosProductLine[]): CosProductLine | null {
  const active = lines.filter((line) => line.isActive);
  if (active.length === 0) return null;
  return [...active].sort(
    (a, b) =>
      b.revenueQuarterlyUsd - a.revenueQuarterlyUsd || b.grossMarginPct - a.grossMarginPct || (a.productId < b.productId ? -1 : 1),
  )[0] as CosProductLine;
}

/** Worst line: thinnest margin, then most churn, then least revenue, then id. */
export function worstProduct(lines: readonly CosProductLine[]): CosProductLine | null {
  const active = lines.filter((line) => line.isActive);
  if (active.length === 0) return null;
  return [...active].sort(
    (a, b) =>
      a.grossMarginPct - b.grossMarginPct ||
      b.churnQuarterly - a.churnQuarterly ||
      a.revenueQuarterlyUsd - b.revenueQuarterlyUsd ||
      (a.productId < b.productId ? -1 : 1),
  )[0] as CosProductLine;
}

/* -------------------------------------------------------------------------- */
/*  Answers                                                                    */
/* -------------------------------------------------------------------------- */

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** Where the founder goes to do this by hand. Named here, not routed here. */
const PATHS: Readonly<Record<CosQuestionKind, string>> = {
  cash: 'Financials',
  runway: 'Financials',
  burn: 'Financials',
  best_product: 'Products',
  worst_product: 'Products',
  threats: 'The Street',
  decisions: 'End Quarter',
  capabilities: 'Command Centre',
  people: 'People',
  board: 'Boardroom',
  group: 'Group',
  composition: 'Products',
  unclassified: 'Command Centre',
};

/**
 * The line a message names, by its name or by the node it sells: "what is my
 * Copilot built on" picks Nexus Copilot. Null when no line is named, in which
 * case every composed line is read out.
 */
export function namedLine(lines: readonly CosProductLine[], message: string): CosProductLine | null {
  const text = message.toLowerCase();
  const active = lines.filter((line) => line.isActive);
  const byName = active.filter((line) => line.name.length > 0 && text.includes(line.name.toLowerCase()));
  if (byName.length > 0) return [...byName].sort((a, b) => b.name.length - a.name.length || (a.productId < b.productId ? -1 : 1))[0] as CosProductLine;
  const byNode = active.filter((line) => line.categoryId.length > 0 && text.includes(line.categoryId.replace(/^[a-z]{3}_/, '').replace(/_/g, ' ')));
  if (byNode.length > 0) return [...byNode].sort((a, b) => b.categoryId.length - a.categoryId.length || (a.productId < b.productId ? -1 : 1))[0] as CosProductLine;
  return null;
}

/** "Your AI software suite …" — the composition sentence as its own sentence. */
function compositionSentence(line: CosProductLine): string {
  const text = line.composition.trim();
  return text.length === 0 ? '' : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The answer to one classified question, from the dossier alone.
 *
 * Returns null when the dossier does not hold enough to answer, which is a real
 * answer: saying "I do not have that" beats estimating it.
 */
export function answerFromDossier(kind: CosQuestionKind, dossier: ChiefOfStaffDossier, message = ''): string | null {
  const f = dossier.finances;
  switch (kind) {
    case 'composition': {
      // The sentence is the engine's (`describeLine`), carried on the dossier
      // line; nothing here reads the graph. A world without slots says so.
      const composed = dossier.products.lines.filter((line) => line.isActive && line.composition.trim().length > 0);
      if (composed.length === 0) {
        return dossier.products.lines.length === 0
          ? 'There is no product line to describe.'
          : 'Our lines are not composed by slot in this world: each is a catalogued product with its own inputs, not a chain of chosen nodes.';
      }
      const named = namedLine(composed, message);
      if (named !== null) return `${named.name}: ${compositionSentence(named)} You can change the model, the harness or a supplier, and who it is aimed at, from the line’s drawer on Products.`;
      const listed = composed.slice(0, 3).map((line) => `${line.name} — ${compositionSentence(line)}`);
      return `${listed.join(' ')}${composed.length > 3 ? ` And ${composed.length - 3} more.` : ''}`;
    }

    case 'cash':
      return `Cash on hand is ${formatMoney(f.cashUsd)}. Net cash movement is ${formatMoney(f.quarterlyBurnUsd)} a quarter and debt outstanding is ${formatMoney(
        f.debtUsd,
      )}. That is ${formatQuarterCount(f.runwayQuarters)} of runway at the current rate.`;

    case 'runway':
      return `${formatQuarterCount(f.runwayQuarters)}. ${formatMoney(f.cashUsd)} of cash against net cash movement of ${formatMoney(
        f.quarterlyBurnUsd,
      )} a quarter.`;

    case 'burn':
      return `Net cash movement is ${formatMoney(f.quarterlyBurnUsd)} a quarter against revenue of ${formatMoney(
        f.revenueQuarterlyUsd,
      )}. Payroll is ${formatMoney(dossier.people.payrollQuarterlyUsd)}, research ${formatMoney(
        dossier.research.budgetQuarterlyUsd,
      )} and cloud compute ${formatMoney(dossier.products.cloudSpendQuarterlyUsd)}.`;

    case 'best_product': {
      const line = bestProduct(dossier.products.lines);
      if (line === null) return 'There is no active product line to rank.';
      return `${line.name} — ${formatMoney(line.revenueQuarterlyUsd)} a quarter from ${formatCount(line.activeCustomers)} customers at ${formatMoney(
        line.pricePerSeatUsd,
      )} a seat, margin ${pct(line.grossMarginPct)}, churn ${pct(line.churnQuarterly)}.`;
    }

    case 'worst_product': {
      const line = worstProduct(dossier.products.lines);
      if (line === null) return 'There is no active product line to rank.';
      return `${line.name} — margin ${pct(line.grossMarginPct)} and churn ${pct(line.churnQuarterly)}, on ${formatMoney(
        line.revenueQuarterlyUsd,
      )} a quarter from ${formatCount(line.activeCustomers)} customers. That is the thinnest line we have.`;
    }

    case 'threats': {
      const approaches = dossier.capital.approaches;
      if (approaches.length > 0) {
        return `${approaches.length} open approach${approaches.length === 1 ? '' : 'es'}: ${approaches
          .map((entry) => `${entry.fromName} (${entry.kind.replace(/_/g, ' ')}, quarter ${entry.quarter})`)
          .join('; ')}.`;
      }
      const holders = dossier.capital.funds.filter((fund) => fund.holdsStakePct > 0);
      const biggest = [...dossier.markets.rivals].sort(
        (a, b) => (b.marketCapUsd ?? b.revenueQuarterlyUsd ?? 0) - (a.marketCapUsd ?? a.revenueQuarterlyUsd ?? 0) || (a.companyId < b.companyId ? -1 : 1),
      )[0];
      const pieces: string[] = ['Nobody has written to us and no campaign is open.'];
      if (holders.length > 0) {
        pieces.push(
          `Holding stock in us: ${holders.map((fund) => `${fund.name} at ${pct(fund.holdsStakePct)} with ${formatMoney(fund.dryPowderUsd)} of dry powder`).join('; ')}.`,
        );
      }
      if (biggest !== undefined) {
        pieces.push(
          `The largest rival in ${dossier.markets.sectorId} is ${biggest.name}${
            biggest.revenueQuarterlyUsd === null ? ' (financials undisclosed)' : ` on ${formatMoney(biggest.revenueQuarterlyUsd)} a quarter`
          }.`,
        );
      }
      return pieces.join(' ');
    }

    case 'decisions':
      return dossier.openDecisions.length === 0
        ? 'Nothing is waiting on you this quarter.'
        : `${dossier.openDecisions.length} thing${dossier.openDecisions.length === 1 ? '' : 's'} waiting on you: ${dossier.openDecisions.join(' ')}`;

    case 'capabilities': {
      const available = dossier.availableActions.filter((entry) => entry.available);
      if (available.length === 0) return 'Nothing is available to this company right now, which usually means the quarter has already resolved.';
      const named = available.slice(0, 8).map((entry) => entry.type.replace(/_/g, ' '));
      const blocked = dossier.availableActions.filter((entry) => !entry.available).length;
      return `${available.length} action${available.length === 1 ? '' : 's'} are open to us — ${named.join(', ')}${
        available.length > named.length ? ' and others' : ''
      }. ${blocked} ${blocked === 1 ? 'is' : 'are'} not possible today.`;
    }

    case 'people': {
      const p = dossier.people;
      return `${formatCount(p.total)} people — ${formatCount(p.engineers)} engineers, ${formatCount(p.researchers)} researchers, ${formatCount(
        p.sales,
      )} sales, ${formatCount(p.ops)} ops, ${formatCount(p.execs)} executives. Morale ${Math.round(p.moralePct)} of 100, ${pct(
        p.attritionPct,
      )} expected to leave next quarter, ${formatCount(p.openRoles)} open roles, payroll ${formatMoney(p.payrollQuarterlyUsd)} a quarter.`;
    }

    case 'board': {
      const g = dossier.governance;
      const seats = g.hasBoard ? `${g.seatsFilled} of ${g.seatsAuthorised} seats filled, ${g.founderSeats} on your side.` : 'There is no board yet.';
      const proposals =
        g.openProposals.length === 0 ? 'Nothing is before it.' : `Before it: ${g.openProposals.map((entry) => entry.title).join('; ')}.`;
      return `You hold ${pct(g.founderOwnershipPct)} of the company and ${g.isCeo ? 'are' : 'are not'} chief executive. ${seats} ${proposals}`;
    }

    case 'group': {
      const g = dossier.group;
      if (g.companyCount <= 1) {
        return `You direct one company — ${dossier.companyName} — so there is nothing to consolidate yet. Buying a majority stake or completing an acquisition that keeps the target alive as a subsidiary is what starts a group.`;
      }
      return `${g.companyCount} companies, consolidated: ${formatMoney(g.revenueUsd)} revenue and ${formatMoney(
        g.netIncomeUsd,
      )} net income last filed quarter, ${formatMoney(g.cashUsd)} cash against ${formatMoney(g.debtUsd)} debt, ${formatCount(
        g.headcount,
      )} people, ${formatMoney(g.marketValueUsd)} consolidated market value.`;
    }

    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  The interpretation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Answer without a model.
 *
 * With a dossier this answers the question and points at the screen that owns
 * it. Without one — an older caller, or a request that carried only prose — it
 * does what it always did: hands the instruction back as a question and
 * interprets nothing.
 *
 * `interpretedInstructions` is always empty and `requiresConfirmation` always
 * true, because nothing here has been through a model and a deterministic
 * responder must never look like an approved plan.
 */
export function offlineChiefOfStaff(input: ChiefOfStaffInput): ChiefOfStaffInterpretation {
  const echoed = truncate(input.playerMessage.trim(), 400);
  const dossier = input.dossier ?? null;

  /* --- turn two: the findings came back ---------------------------------- */
  const findings = input.findings ?? [];
  if (findings.length > 0) {
    const body = findings.map(answerFromFinding).join(' ');
    const actions = actionsFromFindings(findings);
    return {
      // `plan` rather than `act`: these are options with actions attached, and
      // the founder decides. Never `act` — nothing here read their intent.
      mode: actions.length === 0 ? 'answer' : 'plan',
      reply: truncate(`${body} This is read straight off the market rather than reasoned about; no model is reachable this quarter.`, 2000),
      interpretedInstructions: actions,
      summary: truncate(
        `Sourced from the market without a model. ${
          actions.length === 0 ? 'Nothing is ready to approve.' : `${actions.length} action${actions.length === 1 ? '' : 's'} are ready for you to approve, each naming its counterparty.`
        } Nothing has been submitted.`,
        1200,
      ),
      questions: [],
      requiresConfirmation: true,
      confidence: 0,
      unsupportedRequests: [],
      lookups: [],
    };
  }

  /* --- turn one: does this need the market? ------------------------------ */
  const lookups = sourcingRequestsFor(input.playerMessage);
  if (lookups.length > 0) {
    return {
      mode: 'research',
      reply: truncate(`Checking ${lookups.map((request) => request.kind.replace(/_/g, ' ')).join(' and ')}.`, 2000),
      interpretedInstructions: [],
      summary: truncate('Going to look this up against the real market before answering. Nothing has been submitted.', 1200),
      questions: [],
      requiresConfirmation: true,
      confidence: 0,
      unsupportedRequests: [],
      lookups,
    };
  }

  const kind = classifyQuestion(input.playerMessage);
  const answer = dossier === null ? null : answerFromDossier(kind, dossier, input.playerMessage);

  if (answer === null) {
    const known = dossier === null ? '' : ' I can answer cash, runway, burn, best and worst product, what a line is built on, who is circling us, what needs deciding and what actions are open — ask one of those and I will answer it from state.';
    return {
      mode: 'answer',
      reply: truncate(
        `No model is reachable, so I have interpreted nothing and submitted nothing. What I heard was: "${echoed}"${known}`,
        2000,
      ),
      interpretedInstructions: [],
      summary: truncate(
        `The Chief of Staff is running without a model, so nothing has been interpreted and nothing has been submitted. Your instruction was recorded exactly as written: "${echoed}" Use the normal controls to make these changes yourself, or try again shortly.`,
        1200,
      ),
      questions: [truncate(`Do you want to submit this through the controls yourself: "${echoed}"?`, 240)],
      requiresConfirmation: true,
      confidence: 0,
      unsupportedRequests: [],
      lookups: [],
    };
  }

  return {
    mode: 'answer',
    reply: truncate(`${answer} No model is reachable this quarter, so this is read straight off your own state rather than reasoned about. ${PATHS[kind]} has the detail.`, 2000),
    interpretedInstructions: [],
    summary: truncate(
      `Answered from your own state without a model: ${answer} Nothing was interpreted and no binding action has been submitted.`,
      1200,
    ),
    questions: [],
    requiresConfirmation: true,
    // Read directly off state, so it is exactly as good as the state — but it
    // is not a *judgement*, and the interface must keep presenting it as a
    // draft rather than as advice a model stood behind.
    confidence: 0,
    unsupportedRequests: [],
    lookups: [],
  };
}

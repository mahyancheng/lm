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
 * It never produces an `ActionIntent`. Answering is safe without a model;
 * translating an instruction into a binding proposal is not.
 */

import type { ChiefOfStaffDossier, ChiefOfStaffInput, ChiefOfStaffInterpretation, CosProductLine } from '@frontier/contracts';
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
  unclassified: 'Command Centre',
};

/**
 * The answer to one classified question, from the dossier alone.
 *
 * Returns null when the dossier does not hold enough to answer, which is a real
 * answer: saying "I do not have that" beats estimating it.
 */
export function answerFromDossier(kind: CosQuestionKind, dossier: ChiefOfStaffDossier): string | null {
  const f = dossier.finances;
  switch (kind) {
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
  const kind = classifyQuestion(input.playerMessage);
  const answer = dossier === null ? null : answerFromDossier(kind, dossier);

  if (answer === null) {
    const known = dossier === null ? '' : ' I can answer cash, runway, burn, best and worst product, who is circling us, what needs deciding and what actions are open — ask one of those and I will answer it from state.';
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
  };
}

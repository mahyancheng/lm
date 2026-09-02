/**
 * @frontier/simulation — resolver/invariants.ts
 *
 * The gate that runs before a quarter commits.
 *
 * Thirteen invariants, checked against the finished draft. A failure is loud,
 * never silent, and it is loud in one of two ways depending on what failed:
 *
 * - **State invariants** — balance sheets, cap tables, prices, the information
 *   boundary, LLM containment. These describe the *world*, and a world that
 *   fails them is a world the game refuses to commit. The quarter returns
 *   `committed: false`, the pre-resolution state is restored, and the session
 *   stays where it was. We would rather stall a session than commit a world
 *   where shares do not reconcile.
 *
 * - **Engine invariants** — the ledger hash chain, sequence contiguity, the
 *   report's references, the outage record. These describe *this code*, not the
 *   world: no legitimate simulation outcome breaks them. A failure means the
 *   engine itself is wrong, so it throws with diagnostics rather than quietly
 *   returning an uncommitted quarter that hides a bug.
 *
 * Both paths write an `invariant_check_failed` row first, so the ledger records
 * the refusal even when the state is rolled back.
 */

import type { Company, InvariantCheckResult, ResolutionLine, SessionState, SimEvent, SimulationInvariant } from '@frontier/contracts';
import { BALANCE_SHEET_TOLERANCE_USD, MARKET_CAP_TOLERANCE_USD, balanceSheetReconciles, getTargetPathSpec, marketCapFromPrice } from '@frontier/contracts';
import { MAX_ABS_LOG_RETURN, V2_MAX_ABS_LOG_RETURN, V2_SHOCK_MAX_ABS_LOG_RETURN } from '../markets/pricing';
import { isMultiSectorWorld } from '../economy/sectors';
import { chainRowHash } from './ledger';

/** Invariants whose failure means the engine is wrong rather than the world. */
export const ENGINE_INVARIANTS: readonly SimulationInvariant[] = [
  'deterministic_replay',
  'auditability',
  'agent_reproducibility',
  'failure_mode',
];

/** Thrown when an engine invariant fails. Carries every check for diagnosis. */
export class InvariantViolationError extends Error {
  constructor(
    message: string,
    readonly results: readonly InvariantCheckResult[],
    readonly quarter: number,
  ) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

/** Everything the gate inspects. */
export interface InvariantGateInput {
  readonly draft: SessionState;
  /**
   * The pre-resolution state, untouched by the quarter.
   *
   * `financial_integrity` needs it: the closing equity is compared against the
   * *opening* equity plus what the ledger says moved, so the check does not
   * depend on the phase that wrote the closing sheet. Fixtures that fabricate a
   * gate input may omit it, in which case the draft is compared with itself and
   * only the stored balance-sheet identity is checked.
   */
  readonly opening?: SessionState;
  readonly events: readonly SimEvent[];
  readonly lines: readonly ResolutionLine[];
  readonly startSequence: number;
  readonly preResolutionHash: string;
  readonly droppedLines: number;
  readonly gmProposalWasPresent: boolean;
  readonly quarterWasOpen: boolean;
}

const pass = (invariant: SimulationInvariant, detail: string): InvariantCheckResult => ({
  invariant,
  passed: true,
  detail: detail.slice(0, 500),
  subjectId: null,
});

const fail = (invariant: SimulationInvariant, detail: string, subjectId: string | null): InvariantCheckResult => ({
  invariant,
  passed: false,
  detail: detail.slice(0, 500),
  subjectId,
});

/**
 * Run every check. Pure: it reads the draft and reports, and never repairs.
 * Repairing an invariant failure would defeat the purpose of having one.
 */
export function runInvariantGate(input: InvariantGateInput): InvariantCheckResult[] {
  return [
    checkFinancialIntegrity(input.draft, input.opening ?? input.draft, input.events),
    checkOwnershipIntegrity(input.draft),
    checkMarketIntegrity(input.draft, input.events),
    checkAuthoritativeBackend(input.draft),
    checkInformationBoundary(input.draft, input.events),
    checkLlmContainment(input.draft),
    checkTechGraphSafety(input.draft),
    checkSocialSecurity(input.draft),
    checkIdempotency(input),
    checkDeterministicReplay(input),
    checkAuditability(input),
    checkAgentReproducibility(input),
    checkFailureMode(input),
  ];
}

/* -------------------------------------------------------------------------- */
/*  State invariants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Two halves, and the second is the one that bites.
 *
 * 1. `sum(assets) - sum(liabilities) === equity`, within a dollar, per company.
 * 2. `closing equity === opening equity + net income + net capital flows`, also
 *    within a dollar, per company — with every term on the right read from the
 *    **ledger**, never from the balance sheet the financial phase wrote.
 *
 * The second half exists because the first one cannot fail on its own.
 * `resolveFinancials` derives closing equity from the closing sheet, so the
 * stored identity holds by construction even when a phase before it moved
 * assets without moving equity: the plug silently absorbs the difference and the
 * quarter commits with equity nobody issued. Reconstructing the movement from
 * the rows that claim to have caused it is what turns that from an unfalsifiable
 * statement into a check. A double-entry defect anywhere in the pipeline now
 * lands here as an unexplained equity movement, and the quarter does not commit.
 *
 * The reconstruction is exact, not heuristic, because only three files may move
 * a balance sheet and every movement they make writes a row:
 *
 * | movement                        | row                                     |
 * |---------------------------------|-----------------------------------------|
 * | trading profit and loss         | `revenue_recognised` / `cost_recognised`|
 * | a round closing                 | `funding_round_closed`                  |
 * | a primary issue                 | `shares_issued` (`primary_issue`)       |
 * | a listing                       | `ipo_completed`                         |
 * | a buyback                       | `buyback_executed`                      |
 * | acquisition consideration       | `acquisition_completed`                 |
 * | a realised gain on a stake sold | `shares_traded` + the investments moved |
 * | a wind-up in administration     | `information_revealed` (`administration`)|
 */
function checkFinancialIntegrity(draft: SessionState, opening: SessionState, events: readonly SimEvent[]): InvariantCheckResult {
  const offenders: string[] = [];

  for (const company of draft.companies) {
    if (!company.isActive) continue;
    if (!balanceSheetReconciles(company.balanceSheet)) {
      const sheet = company.balanceSheet;
      offenders.push(`${company.id} off by ${(assetsOf(company) - liabilitiesOf(company) - sheet.equity).toFixed(2)}`);
    }
  }

  const openingById = new Map(opening.companies.map((company) => [company.id, company] as const));
  const movements = equityMovementsFromLedger(events, openingById);
  let checked = 0;
  let unexplained = 0;

  for (const company of draft.companies) {
    if (!company.isActive) continue;
    const before = openingById.get(company.id);
    if (before === undefined) continue; // a company the quarter created: nothing to compare against
    const moved = movements.get(company.id);
    if (moved !== undefined && moved.unverifiable !== null) {
      unexplained += 1;
      continue;
    }

    const netIncome = moved === undefined ? 0 : moved.revenue - moved.cost;
    const capital = moved === undefined ? 0 : moved.capital;
    // A stake sold realises its gain into equity: cash in, carrying value out.
    // The carrying value is not on the row, but the investments line moved by
    // exactly it, net of what the quarter's purchases added, of what an
    // acquisition absorbed from the company it swallowed, and of what a wind-up
    // swept into the estate — the last two having already been accounted for on
    // their own rows.
    const trading =
      moved === undefined
        ? 0
        : moved.sold -
          moved.bought +
          (company.balanceSheet.assets.investments - before.balanceSheet.assets.investments) -
          moved.absorbedInvestments +
          moved.woundUpInvestments;

    const expected = before.balanceSheet.equity + netIncome + capital + trading;
    const gap = company.balanceSheet.equity - expected;
    checked += 1;
    if (Math.abs(gap) > BALANCE_SHEET_TOLERANCE_USD) {
      offenders.push(
        `${company.id} equity moved ${(company.balanceSheet.equity - before.balanceSheet.equity).toFixed(2)} but the ledger explains ${(
          netIncome + capital + trading
        ).toFixed(2)} (unexplained ${gap.toFixed(2)})`,
      );
    }
  }

  const skipped = unexplained > 0 ? ` ${unexplained} could not be reconstructed from their rows and were not compared.` : '';
  return offenders.length === 0
    ? pass('financial_integrity', `${checked} balance sheets reconcile and move only by what the ledger explains.${skipped}`)
    : fail('financial_integrity', `Balance sheets do not reconcile: ${offenders.slice(0, 3).join('; ')}`, firstId(offenders));
}

/** The keys the financial phase's cost row states the whole quarter's cost in. */
const COST_KEYS = ['cogsUsd', 'payrollUsd', 'marketingUsd', 'rdSpendUsd', 'interestUsd', 'taxUsd'] as const;

/** What one company's ledger rows say moved its equity this quarter. */
interface EquityMovement {
  revenue: number;
  cost: number;
  capital: number;
  bought: number;
  sold: number;
  absorbedInvestments: number;
  /** Carrying value the investments line lost to a wind-up rather than to a sale. */
  woundUpInvestments: number;
  /** Whether the financial phase's own three rows were all read. */
  sawRevenue: boolean;
  sawCost: boolean;
  sawCashFlow: boolean;
  /** Set when a row that should carry a figure does not, so nothing is guessed. */
  unverifiable: string | null;
}

/**
 * Reduce the quarter's rows to a per-company statement of equity movement.
 *
 * Two rules keep this honest:
 *
 * - A row that omits a figure the reconstruction needs marks its company
 *   unverifiable rather than contributing a zero. An invariant that quietly
 *   assumes the missing number is nought is the tautology this replaced.
 * - `cost_recognised` is written by five phases, four of which are *staging*
 *   rows — a severance charge, a compute reservation, a capacity constraint, a
 *   compliance burden — that the financial phase later books into the one row
 *   stating the whole quarter. Those all carry a `kind`; the profit and loss
 *   carries none. Counting a staging row would charge the same dollar twice, so
 *   only the unkinded rows are read, and a company whose cash flow resolved
 *   without a readable profit and loss is left uncompared rather than accused.
 */
function equityMovementsFromLedger(events: readonly SimEvent[], opening: ReadonlyMap<string, Company>): Map<string, EquityMovement> {
  const out = new Map<string, EquityMovement>();
  const entry = (id: string | null): EquityMovement | null => {
    if (id === null) return null;
    const existing = out.get(id);
    if (existing !== undefined) return existing;
    const created: EquityMovement = {
      revenue: 0,
      cost: 0,
      capital: 0,
      bought: 0,
      sold: 0,
      absorbedInvestments: 0,
      woundUpInvestments: 0,
      sawRevenue: false,
      sawCost: false,
      sawCashFlow: false,
      unverifiable: null,
    };
    out.set(id, created);
    return created;
  };
  const money = (event: SimEvent, key: string): number | null => {
    const value = event.payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const add = (event: SimEvent, target: EquityMovement, key: string, apply: (value: number) => void): void => {
    const value = money(event, key);
    if (value === null) target.unverifiable = `${event.type} carries no numeric ${key}`;
    else apply(value);
  };
  /** A staging row books nothing on its own; the profit and loss already has it. */
  const isStagingRow = (event: SimEvent): boolean => event.payload.kind !== undefined;

  for (const event of events) {
    const actor = entry(event.actorId);
    if (actor === null) continue;

    switch (event.type) {
      case 'revenue_recognised':
        if (isStagingRow(event)) break;
        actor.sawRevenue = true;
        add(event, actor, 'revenueUsd', (value) => (actor.revenue += value));
        break;
      case 'cost_recognised':
        if (isStagingRow(event)) break;
        actor.sawCost = true;
        for (const key of COST_KEYS) add(event, actor, key, (value) => (actor.cost += value));
        break;
      case 'cash_flow_resolved':
        actor.sawCashFlow = true;
        break;
      case 'funding_round_closed':
        add(event, actor, 'amountUsd', (value) => (actor.capital += value));
        break;
      case 'shares_issued':
        // A round's own issuance is already counted through the round row.
        if (event.payload.reason === 'primary_issue') add(event, actor, 'proceedsUsd', (value) => (actor.capital += value));
        break;
      case 'ipo_completed':
        add(event, actor, 'raisedUsd', (value) => (actor.capital += value));
        break;
      case 'buyback_executed':
        add(event, actor, 'costUsd', (value) => (actor.capital -= value));
        break;
      case 'acquisition_completed': {
        add(event, actor, 'stockUsd', (value) => (actor.capital += value));
        // A purchase below net asset value is a gain, not negative goodwill.
        add(event, actor, 'bargainGainUsd', (value) => (actor.capital += value));
        // The target's investments cross onto the acquirer's sheet with the
        // rest of it. Chains resolve because rows are walked in order.
        const swallowed = event.targetId === null ? undefined : opening.get(event.targetId);
        const carried = event.targetId === null ? undefined : out.get(event.targetId);
        actor.absorbedInvestments += (swallowed?.balanceSheet.assets.investments ?? 0) + (carried?.absorbedInvestments ?? 0);
        break;
      }
      case 'shares_traded':
        if (event.payload.side === 'buy') add(event, actor, 'considerationUsd', (value) => (actor.bought += value));
        else if (event.payload.side === 'sell') add(event, actor, 'considerationUsd', (value) => (actor.sold += value));
        break;
      case 'information_revealed':
        // A wind-up moves equity without trading: the estate is realised at a
        // haircut and the creditors it cannot pay are released. The row states
        // that movement from its causes, so the reconstruction reads it like any
        // other declared flow — and a wind-up that moved equity by some other
        // amount fails the gate. The stakes it swept into the estate are stated
        // too: the investments line falls, and without this the fall would be
        // read a second time as a stake sold at a loss.
        if (event.payload.kind === 'administration') {
          add(event, actor, 'equityMovementUsd', (value) => (actor.capital += value));
          add(event, actor, 'investmentsRealisedUsd', (value) => (actor.woundUpInvestments += value));
        }
        break;
      default:
        break;
    }
  }

  // The financial phase ran but its profit and loss could not be read: that is
  // a reason not to compare this company, never a reason to accuse it.
  for (const movement of out.values()) {
    if (movement.sawCashFlow && !(movement.sawRevenue && movement.sawCost)) {
      movement.unverifiable = movement.unverifiable ?? 'the financial phase left no readable profit and loss';
    }
  }
  return out;
}

const assetsOf = (company: Company): number => {
  const a = company.balanceSheet.assets;
  return a.cash + a.ppe + a.goodwill + a.investments + a.receivables;
};

const liabilitiesOf = (company: Company): number => {
  const l = company.balanceSheet.liabilities;
  return l.debt + l.payables + l.deferredRevenue;
};

/** Per class, the sum of holdings equals the issued count. */
function checkOwnershipIntegrity(draft: SessionState): InvariantCheckResult {
  const offenders: string[] = [];
  for (const table of draft.capTables) {
    const securityClass = new Map<string, string>();
    for (const security of draft.securities) {
      if (security.companyId === table.companyId) securityClass.set(security.id, security.shareClassId);
    }
    const heldByClass = new Map<string, number>();
    for (const holding of table.holdings) {
      if (holding.shares < 0) offenders.push(`${table.companyId} holds a negative position (${holding.id})`);
      const classId = securityClass.get(holding.securityId);
      if (classId === undefined) continue;
      heldByClass.set(classId, (heldByClass.get(classId) ?? 0) + holding.shares);
    }
    for (const shareClass of table.shareClasses) {
      const held = heldByClass.get(shareClass.id) ?? 0;
      const declared = table.totalIssuedByClass[shareClass.id] ?? shareClass.issuedShares;
      if (held !== declared || declared !== shareClass.issuedShares) {
        offenders.push(`${table.companyId}/${shareClass.id}: holdings ${held}, totalIssuedByClass ${declared}, class ${shareClass.issuedShares}`);
      }
    }
  }
  return offenders.length === 0
    ? pass('ownership_integrity', `${draft.capTables.length} cap tables reconcile to their issued share counts.`)
    : fail('ownership_integrity', `Ownership does not reconcile: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/**
 * Prices are real numbers that behave like prices.
 *
 * Four things, in ascending order of how much they cost to get wrong:
 *
 * 1. **Every in-world price is finite and positive**, and no return is below a
 *    total loss. A NaN price is a corrupt world, not a cheap stock.
 * 2. **This quarter's capitalisation reconciles**: `price x sharesOutstanding`
 *    equals the `marketCapUsd` the quote carries, to the dollar. A price and a
 *    market capitalisation that disagree are two different companies.
 * 3. **No price moved further than the bound without a recorded reason.** The
 *    pricing model clamps every move; this checks the clamp actually held, and
 *    that anything past it carries a `price_shock` row or was floored by
 *    distress. It is the half of "realistic prices" that a model cannot quietly
 *    stop honouring.
 * 4. Only quotes struck *this* quarter are checked for 2 and 3: an older quote
 *    was checked when it was written, and a scenario's seeded opening quotes are
 *    data rather than the output of a priced quarter.
 */
function checkMarketIntegrity(draft: SessionState, events: readonly SimEvent[]): InvariantCheckResult {
  const reference = new Set(draft.marketInstruments.filter((instrument) => instrument.isReference).map((instrument) => instrument.id));
  const shares = new Map<string, number>();
  for (const instrument of draft.marketInstruments) {
    if (instrument.sharesOutstanding != null && instrument.sharesOutstanding > 0) shares.set(instrument.id, instrument.sharesOutstanding);
  }
  const offenders: string[] = [];

  for (const quote of draft.quotes) {
    if (reference.has(quote.instrumentId)) continue;
    if (!Number.isFinite(quote.price) || quote.price <= 0) offenders.push(`${quote.instrumentId}@q${quote.quarter} price ${quote.price}`);
    const returnValue = quote.return;
    if (!Number.isFinite(returnValue) || returnValue < -1) offenders.push(`${quote.instrumentId}@q${quote.quarter} return ${returnValue}`);

    if (quote.quarter !== draft.quarter) continue;
    const count = shares.get(quote.instrumentId);
    if (count === undefined) continue;
    const implied = marketCapFromPrice(quote.price, count);
    if (Math.abs(quote.marketCapUsd - implied) > MARKET_CAP_TOLERANCE_USD) {
      offenders.push(`${quote.instrumentId}@q${quote.quarter} capitalisation ${quote.marketCapUsd.toFixed(2)} against ${implied.toFixed(2)} implied`);
    }
  }

  // A move past the bound needs a reason on the record: a dislocation row, or the
  // price floor a distressed company hit.
  const shocked = new Set<string>();
  for (const event of events) {
    if (event.type === 'sentiment_shifted' && event.payload.kind === 'price_shock' && event.targetId !== null) shocked.add(event.targetId);
  }
  const bound = isMultiSectorWorld(draft) ? V2_MAX_ABS_LOG_RETURN : MAX_ABS_LOG_RETURN;
  // Prices are rounded to six places before the applied return is recomputed, so
  // the bound is compared with a tolerance rather than exactly.
  const epsilon = 1e-6;
  let moves = 0;
  for (const event of events) {
    if (event.type !== 'market_priced' || event.quarter !== draft.quarter) continue;
    const before = event.payload.priceBefore;
    const after = event.payload.priceAfter;
    if (typeof before !== 'number' || typeof after !== 'number' || !(before > 0) || !(after > 0)) continue;
    if (event.payload.floored === true) continue;
    moves += 1;
    const permitted = (event.targetId !== null && shocked.has(event.targetId) ? V2_SHOCK_MAX_ABS_LOG_RETURN : bound) + epsilon;
    const move = Math.abs(Math.log(after / before));
    if (move > permitted) {
      offenders.push(`${String(event.targetId)}@q${event.quarter} moved ${(move * 100).toFixed(1)}% against a bound of ${(permitted * 100).toFixed(1)}%`);
    }
  }

  return offenders.length === 0
    ? pass('market_integrity', `${draft.quotes.length} quotes carry finite, positive prices; ${moves} priced move(s) stayed inside their bound and reconcile to their capitalisation.`)
    : fail('market_integrity', `Illegal quotes: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/** Shares cannot exceed their authorisation, and money must stay a number. */
function checkAuthoritativeBackend(draft: SessionState): InvariantCheckResult {
  const offenders: string[] = [];
  for (const table of draft.capTables) {
    for (const shareClass of table.shareClasses) {
      if (shareClass.issuedShares > shareClass.authorisedShares) {
        offenders.push(`${table.companyId}/${shareClass.id} issued ${shareClass.issuedShares} of ${shareClass.authorisedShares} authorised`);
      }
    }
  }
  for (const company of draft.companies) {
    const f = company.financials;
    for (const [label, value] of Object.entries({ cash: f.cash, debt: f.debt, revenue: f.revenueQuarterly })) {
      if (!Number.isFinite(value)) offenders.push(`${company.id} ${label} is ${String(value)}`);
    }
  }
  return offenders.length === 0
    ? pass('authoritative_backend', 'No share class exceeds its authorisation and every monetary figure is finite.')
    : fail('authoritative_backend', `Manufactured value detected: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/** A secret programme produces no public trace, and no public row is marked secret. */
function checkInformationBoundary(draft: SessionState, events: readonly SimEvent[]): InvariantCheckResult {
  const secretIds = new Set<string>();
  for (const project of draft.researchProjects) if (project.isSecret) secretIds.add(project.id);
  const secretNodes = new Set(draft.techGraph.nodes.filter((node) => node.visibility !== 'public').map((node) => node.id));

  const offenders: string[] = [];
  for (const disclosure of draft.disclosures) {
    if (disclosure.quarter !== draft.quarter) continue;
    const haystack = `${disclosure.headline} ${disclosure.body} ${Object.keys(disclosure.metrics).join(' ')}`;
    for (const id of secretIds) if (haystack.includes(id)) offenders.push(`disclosure ${disclosure.id} names secret programme ${id}`);
    for (const id of secretNodes) if (haystack.includes(id)) offenders.push(`disclosure ${disclosure.id} names non-public node ${id}`);
  }
  for (const event of events) {
    if (event.visibility !== 'public') continue;
    if (event.payload.secret === true) offenders.push(`${event.eventId} is public and carries a secret payload`);
  }
  return offenders.length === 0
    ? pass('information_boundary', `${secretIds.size} secret programmes and ${secretNodes.size} non-public nodes left no public trace.`)
    : fail('information_boundary', `Private facts leaked without a disclosure: ${offenders.slice(0, 5).join('; ')}`, null);
}

/** Every stored modifier names a registered path with a permitted operation. */
function checkLlmContainment(draft: SessionState): InvariantCheckResult {
  const offenders: string[] = [];
  for (const modifier of draft.activeModifiers) {
    const spec = getTargetPathSpec(modifier.target);
    if (spec === null) {
      offenders.push(`${modifier.id} targets unregistered path ${modifier.target}`);
      continue;
    }
    if (!spec.operations.includes(modifier.operation)) {
      offenders.push(`${modifier.id} applies ${modifier.operation} to ${modifier.target}, which does not permit it`);
    }
    if (!Number.isFinite(modifier.value) || !Number.isFinite(modifier.effectiveValue)) {
      offenders.push(`${modifier.id} carries a non-finite operand`);
    }
  }
  for (const event of draft.activeEvents) {
    if (event.severity < 0 || event.severity > 1) offenders.push(`${event.id} has severity ${event.severity}`);
  }
  return offenders.length === 0
    ? pass('llm_containment', `${draft.activeModifiers.length} active modifiers sit on registered paths with permitted operations.`)
    : fail('llm_containment', `Model output escaped its bounds: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/** Generated technology is data, and carries nothing that could execute. */
function checkTechGraphSafety(draft: SessionState): InvariantCheckResult {
  const idShape = /^[A-Za-z0-9_.:-]+$/;
  const markup = /<\s*[a-zA-Z/!]|javascript:|data:text\/html|on[a-z]+\s*=/;
  const offenders: string[] = [];
  for (const node of draft.techGraph.nodes) {
    if (!idShape.test(node.id)) offenders.push(`node id ${node.id} is not a plain identifier`);
    if (markup.test(node.title) || markup.test(node.summary)) offenders.push(`node ${node.id} carries markup`);
  }
  for (const edge of draft.techGraph.edges) {
    if (!idShape.test(edge.from) || !idShape.test(edge.to)) offenders.push(`edge ${edge.from}->${edge.to} is not a plain identifier pair`);
  }
  return offenders.length === 0
    ? pass('tech_graph_safety', `${draft.techGraph.nodes.length} nodes and ${draft.techGraph.edges.length} edges are inert typed data.`)
    : fail('tech_graph_safety', `Unsafe technology graph content: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/** Nobody is in a conversation who is not a person in this world. */
function checkSocialSecurity(draft: SessionState): InvariantCheckResult {
  const known = new Set(draft.characters.map((character) => character.id));
  const offenders: string[] = [];
  for (const conversation of draft.conversations) {
    for (const participant of conversation.participantCharacterIds) {
      if (!known.has(participant)) offenders.push(`${conversation.id} contains unknown participant ${participant}`);
    }
  }
  return offenders.length === 0
    ? pass('social_security', `${draft.conversations.length} conversations contain only known participants.`)
    : fail('social_security', `Unauthorised conversation membership: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

/* -------------------------------------------------------------------------- */
/*  Engine invariants                                                          */
/* -------------------------------------------------------------------------- */

function checkIdempotency(input: InvariantGateInput): InvariantCheckResult {
  return input.quarterWasOpen
    ? pass('idempotency', `Quarter ${input.draft.quarter} was open when resolution began.`)
    : fail('idempotency', `Quarter ${input.draft.quarter} had already committed when resolution was attempted.`, null);
}

/**
 * Both chains run unbroken from the pre-resolution state to the last row.
 *
 * The state is hashed once per phase, so every row a phase wrote shares one
 * before-hash and one after-hash, and each phase opens on the hash the previous
 * one closed at. The row chain is the per-row half: each `rowHash` folds the
 * previous one together with the row itself, so a row inserted, removed,
 * reordered or edited breaks it from that point on even though the state was
 * never hashed for it.
 */
function checkDeterministicReplay(input: InvariantGateInput): InvariantCheckResult {
  let opensAt = input.preResolutionHash;
  let rowChain = input.preResolutionHash;
  let groupBefore: string | null = null;
  let groupAfter: string | null = null;
  let phases = 0;

  for (const event of input.events) {
    if (event.stateHashBefore !== groupBefore) {
      if (event.stateHashBefore !== opensAt) {
        return fail(
          'deterministic_replay',
          `Ledger hash chain broken at sequence ${event.sequence}: a phase opened on ${event.stateHashBefore}, but the previous phase closed at ${opensAt}.`,
          event.eventId,
        );
      }
      groupBefore = event.stateHashBefore;
      groupAfter = event.stateHashAfter;
      phases += 1;
    } else if (event.stateHashAfter !== groupAfter) {
      return fail(
        'deterministic_replay',
        `Ledger hash chain broken at sequence ${event.sequence}: rows of one phase must close on one state hash, found ${event.stateHashAfter} beside ${String(groupAfter)}.`,
        event.eventId,
      );
    }
    opensAt = event.stateHashAfter;

    rowChain = chainRowHash(rowChain, event);
    if (event.rowHash !== rowChain) {
      return fail(
        'deterministic_replay',
        `Ledger row chain broken at sequence ${event.sequence}: rowHash is ${event.rowHash || '(empty)'}, expected ${rowChain}.`,
        event.eventId,
      );
    }
  }
  return pass(
    'deterministic_replay',
    `${input.events.length} rows across ${phases} phase(s) chain unbroken from ${input.preResolutionHash}, row by row and phase by phase.`,
  );
}

/** Sequences are contiguous and every report line references a committed row. */
function checkAuditability(input: InvariantGateInput): InvariantCheckResult {
  const ids = new Set(input.events.map((event) => event.eventId));
  for (let index = 0; index < input.events.length; index += 1) {
    const event = input.events[index];
    if (event === undefined) continue;
    const expected = input.startSequence + index;
    if (event.sequence !== expected) {
      return fail('auditability', `Ledger sequence is not contiguous: row ${index} has sequence ${event.sequence}, expected ${expected}.`, event.eventId);
    }
  }
  if (input.draft.ledgerSequence !== input.startSequence + input.events.length) {
    return fail(
      'auditability',
      `Ledger sequence counter is ${input.draft.ledgerSequence}, expected ${input.startSequence + input.events.length}.`,
      null,
    );
  }
  for (const line of input.lines) {
    if (line.refEventIds.length === 0) return fail('auditability', `A ${line.phase} report line references no ledger row: "${line.text}"`, line.subjectId);
    for (const ref of line.refEventIds) {
      if (!ids.has(ref)) return fail('auditability', `A ${line.phase} report line references ${ref}, which is not in this quarter's ledger.`, line.subjectId);
    }
  }
  const dropped = input.droppedLines > 0 ? ` ${input.droppedLines} unreferenced line(s) were dropped rather than shown.` : '';
  return pass('auditability', `${input.events.length} rows, ${input.lines.length} lines, every line traced to a committed row.${dropped}`);
}

/** The quarter records how its world was decided: by a model, or by fallback. */
function checkAgentReproducibility(input: InvariantGateInput): InvariantCheckResult {
  const recorded = input.events.filter((event) => event.type === 'llm_call_logged' || event.type === 'fallback_engaged');
  return recorded.length > 0
    ? pass('agent_reproducibility', `${recorded.length} agent decision(s) recorded for this quarter.`)
    : fail('agent_reproducibility', 'The quarter recorded neither a model decision nor a fallback.', null);
}

/** An absent World Director must leave a recorded fallback behind it. */
function checkFailureMode(input: InvariantGateInput): InvariantCheckResult {
  if (input.gmProposalWasPresent) return pass('failure_mode', 'A World Director proposal was supplied and validated.');
  const fallback = input.events.some((event) => event.type === 'fallback_engaged');
  return fallback
    ? pass('failure_mode', 'No World Director output: the deterministic fallback ran and was recorded.')
    : fail('failure_mode', 'No World Director output and no fallback was recorded.', null);
}

/* -------------------------------------------------------------------------- */

function firstId(offenders: readonly string[]): string | null {
  const first = offenders[0];
  if (first === undefined) return null;
  const id = first.split(/[\s/]/)[0];
  return id === undefined || id.length === 0 ? null : id;
}

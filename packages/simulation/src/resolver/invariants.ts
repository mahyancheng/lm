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

import type { InvariantCheckResult, ResolutionLine, SessionState, SimEvent, SimulationInvariant } from '@frontier/contracts';
import { balanceSheetReconciles, getTargetPathSpec } from '@frontier/contracts';

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
    checkFinancialIntegrity(input.draft),
    checkOwnershipIntegrity(input.draft),
    checkMarketIntegrity(input.draft),
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

/** `sum(assets) - sum(liabilities) === equity`, within a dollar, per company. */
function checkFinancialIntegrity(draft: SessionState): InvariantCheckResult {
  const offenders: string[] = [];
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    if (!balanceSheetReconciles(company.balanceSheet)) {
      const sheet = company.balanceSheet;
      const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
      const liabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
      offenders.push(`${company.id} off by ${(assets - liabilities - sheet.equity).toFixed(2)}`);
    }
  }
  return offenders.length === 0
    ? pass('financial_integrity', `${draft.companies.filter((c) => c.isActive).length} balance sheets reconcile within one dollar.`)
    : fail('financial_integrity', `Balance sheets do not reconcile: ${offenders.slice(0, 5).join('; ')}`, firstId(offenders));
}

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

/** No in-world price is negative, zero or NaN, and no return is unbounded. */
function checkMarketIntegrity(draft: SessionState): InvariantCheckResult {
  const reference = new Set(draft.marketInstruments.filter((instrument) => instrument.isReference).map((instrument) => instrument.id));
  const offenders: string[] = [];
  for (const quote of draft.quotes) {
    if (reference.has(quote.instrumentId)) continue;
    if (!Number.isFinite(quote.price) || quote.price <= 0) offenders.push(`${quote.instrumentId}@q${quote.quarter} price ${quote.price}`);
    const returnValue = quote.return;
    if (!Number.isFinite(returnValue) || returnValue < -1) offenders.push(`${quote.instrumentId}@q${quote.quarter} return ${returnValue}`);
  }
  return offenders.length === 0
    ? pass('market_integrity', `${draft.quotes.length} quotes carry finite, positive prices.`)
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

/** The hash chain runs unbroken from the pre-resolution state to the last row. */
function checkDeterministicReplay(input: InvariantGateInput): InvariantCheckResult {
  let expected = input.preResolutionHash;
  for (const event of input.events) {
    if (event.stateHashBefore !== expected) {
      return fail(
        'deterministic_replay',
        `Ledger hash chain broken at sequence ${event.sequence}: expected before-hash ${expected}, found ${event.stateHashBefore}.`,
        event.eventId,
      );
    }
    expected = event.stateHashAfter;
  }
  return pass('deterministic_replay', `${input.events.length} ledger rows form an unbroken hash chain from ${input.preResolutionHash}.`);
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

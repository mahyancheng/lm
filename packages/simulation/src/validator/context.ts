/**
 * @frontier/simulation — validator/context.ts
 *
 * Everything a validation rule needs beyond the intent itself: who is acting,
 * what they still have left to spend inside this submission, and the small
 * lookups every second rule performs.
 *
 * Two ideas carry most of the weight here.
 *
 * **The batch budget.** Two actions in one submission cannot spend the same
 * dollar. `validateBatch` walks the submission in sequence order against a
 * running reservation of cash, compute, headcount and authorised shares, so the
 * second action sees what the first already committed. This is why validation is
 * a batch operation rather than a per-action predicate, and why the order it
 * uses is `sequence` — a deterministic tie-break, not a race.
 *
 * **The verdict builder.** A rule never returns a value. It rejects, or it
 * clamps by mutating a working copy of the intent. Clamps compose: an action can
 * be reduced on three axes and still run, and the player is told about all
 * three. That is the difference between "your instruction was refused" and "your
 * instruction ran in the form your company could actually execute".
 */

import type {
  ActionIntent,
  ActionRejectionCode,
  ActionValidationResult,
  ActionValidationStatus,
  Character,
  Company,
  SessionState,
  StaffRole,
} from '@frontier/contracts';
import { heldComputeUnits } from '../companies/products';
import { checkAccess } from '../relationships/access';
import { isMultiSectorWorld } from '../economy/sectors';

/* -------------------------------------------------------------------------- */
/*  Actor                                                                      */
/* -------------------------------------------------------------------------- */

/** Who an action is attributed to. Resolved before any rule runs. */
export interface ValidationActor {
  /** Player seat behind the action, or null for an NPC or system action. */
  readonly playerId: string | null;
  /** Company the action is taken on behalf of. */
  readonly companyId: string;
  /** Character taking it. Relationships and memory attach to people. */
  readonly characterId: string | null;
  /** Whether a human explicitly approved it. */
  readonly confirmedByHuman: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Batch budget                                                               */
/* -------------------------------------------------------------------------- */

/** Running reservations across one submission. */
export class BatchBudget {
  private readonly cash = new Map<string, number>();
  private readonly compute = new Map<string, number>();
  private readonly headcount = new Map<string, number>();
  private readonly shares = new Map<string, number>();
  private readonly seen = new Set<string>();

  /** Cash a company has left this quarter after everything already committed. */
  availableCash(company: Company): number {
    return Math.max(0, company.financials.cash - (this.cash.get(company.id) ?? 0));
  }

  /**
   * The same figure unfloored, so it can be negative.
   *
   * `availableCash` answers "how much of this can you pay for", which is the
   * world-1 clamp. This answers "where does the balance stand", which is what a
   * world-2 note has to state: from world version 2 cash never refuses an
   * instruction, and a player told their balance was zero when it is minus nine
   * million has been told nothing.
   */
  uncommittedCash(company: Company): number {
    return company.financials.cash - (this.cash.get(company.id) ?? 0);
  }

  spendCash(companyId: string, amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
    this.cash.set(companyId, (this.cash.get(companyId) ?? 0) + amountUsd);
  }

  /** Accelerator-equivalents a company has left uncommitted this quarter. */
  availableCompute(company: Company): number {
    const held = company.compute.ownedAccelerators + company.compute.reservedAccelerators;
    return Math.max(0, held - (this.compute.get(company.id) ?? 0));
  }

  commitCompute(companyId: string, units: number): void {
    if (!Number.isFinite(units) || units <= 0) return;
    this.compute.set(companyId, (this.compute.get(companyId) ?? 0) + units);
  }

  /**
   * Accelerator-equivalents earlier actions in this batch already put on new
   * programmes. Unfloored, unlike `availableCompute`, because a commitment can
   * legitimately exceed owned-plus-reserved once cloud capacity counts.
   */
  committedCompute(companyId: string): number {
    return this.compute.get(companyId) ?? 0;
  }

  /** Staff in a role not already promised to another action this quarter. */
  availableStaff(company: Company, role: StaffRole): number {
    const key = `${company.id}:${role}`;
    return Math.max(0, company.employees[role] - (this.headcount.get(key) ?? 0));
  }

  commitStaff(companyId: string, role: StaffRole, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    const key = `${companyId}:${role}`;
    this.headcount.set(key, (this.headcount.get(key) ?? 0) + count);
  }

  /** Shares already claimed from a class's unissued authorisation. */
  claimedShares(shareClassId: string): number {
    return this.shares.get(shareClassId) ?? 0;
  }

  claimShares(shareClassId: string, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.shares.set(shareClassId, (this.shares.get(shareClassId) ?? 0) + count);
  }

  /** True the first time a (company, kind) pair is claimed; false ever after. */
  claimOnce(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/*  Verdict builder                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Accumulates the outcome of running the rules for one action.
 *
 * `reject` is terminal for the action's status but does not stop the rule from
 * finishing: a player is better served by three reasons than by the first one.
 */
export class Verdict<T extends ActionIntent = ActionIntent> {
  private readonly reasons: string[] = [];
  private readonly codes: ActionRejectionCode[] = [];
  private rejected = false;
  private clamped = false;
  private working: T;

  constructor(private readonly original: T) {
    this.working = original;
  }

  /** Refuse the action outright. */
  reject(code: ActionRejectionCode, reason: string): void {
    this.rejected = true;
    this.note(code, reason);
  }

  /**
   * Reduce the action to a form the company can execute. The mutation runs on a
   * private copy, so the caller's intent object is never touched.
   */
  clamp(mutate: (draft: T) => void, code: ActionRejectionCode, reason: string): void {
    if (!this.clamped) this.working = cloneIntent(this.original);
    this.clamped = true;
    mutate(this.working);
    this.note(code, reason);
  }

  /** Replace the action with a different one — the board-proposal transform. */
  replaceWith(intent: ActionIntent, code: ActionRejectionCode, reason: string): void {
    this.clamped = true;
    this.working = intent as unknown as T;
    this.note(code, reason);
  }

  /** Record an explanation without changing the outcome. */
  note(code: ActionRejectionCode, reason: string): void {
    this.reasons.push(reason);
    this.codes.push(code);
  }

  get isRejected(): boolean {
    return this.rejected;
  }

  get isClamped(): boolean {
    return this.clamped;
  }

  /** The action as it currently stands, including any clamps applied so far. */
  get current(): T {
    return this.working;
  }

  status(): ActionValidationStatus {
    if (this.rejected) return 'rejected';
    return this.clamped ? 'clamped' : 'accepted';
  }

  toResult(actionId: string): ActionValidationResult {
    const status = this.status();
    return {
      actionId,
      status,
      reasons: [...this.reasons],
      codes: [...this.codes],
      clampedAction: status === 'clamped' ? (this.working as ActionIntent) : null,
    };
  }
}

/** Structural copy of an intent. Intents are plain JSON by contract. */
export function cloneIntent<T extends ActionIntent>(intent: T): T {
  return JSON.parse(JSON.stringify(intent)) as T;
}

/* -------------------------------------------------------------------------- */
/*  Lookups                                                                    */
/* -------------------------------------------------------------------------- */

export const findCompany = (draft: SessionState, id: string | null): Company | null =>
  id === null ? null : draft.companies.find((company) => company.id === id) ?? null;

export const findCharacter = (draft: SessionState, id: string | null): Character | null =>
  id === null ? null : draft.characters.find((character) => character.id === id) ?? null;

export const findSecurity = (draft: SessionState, id: string) => draft.securities.find((security) => security.id === id) ?? null;

export const findCapTable = (draft: SessionState, companyId: string) => draft.capTables.find((table) => table.companyId === companyId) ?? null;

export const findOpportunity = (draft: SessionState, id: string) =>
  draft.procurementOpportunities.find((opportunity) => opportunity.id === id) ?? null;

export const findDeal = (draft: SessionState, id: string) => draft.deals.find((deal) => deal.id === id) ?? null;

export const findBoard = (draft: SessionState, companyId: string) => draft.boards.find((board) => board.companyId === companyId) ?? null;

/** Shares of one security held by one holder, across every holding row. */
export function heldShares(draft: SessionState, securityId: string, holderId: string): number {
  const security = findSecurity(draft, securityId);
  if (security === null) return 0;
  const table = findCapTable(draft, security.companyId);
  if (table === null) return 0;
  let total = 0;
  for (const holding of table.holdings) {
    if (holding.securityId === securityId && holding.holderId === holderId) total += holding.shares;
  }
  return total;
}

/**
 * The stake an actor holds in one company, 0..1 of its fully diluted shares.
 *
 * A player owns shares as a person, not as a company: the holding sits under
 * their character id, or under their player id where a seat holds directly. Both
 * are counted, because both mean the same thing — this is somebody the company
 * has to answer to whether or not they currently run it.
 */
export function shareholderStake(draft: SessionState, companyId: string, actor: ValidationActor): number {
  const table = findCapTable(draft, companyId);
  if (table === null || table.fullyDilutedShares <= 0) return 0;
  let held = 0;
  for (const holding of table.holdings) {
    if (holding.holderId === actor.characterId || (actor.playerId !== null && holding.holderId === actor.playerId)) held += holding.shares;
  }
  return held / table.fullyDilutedShares;
}

/** The earliest quarter a holder may sell out of a security, or null. */
export function lockupUntil(draft: SessionState, securityId: string, holderId: string): number | null {
  const security = findSecurity(draft, securityId);
  if (security === null) return null;
  const table = findCapTable(draft, security.companyId);
  if (table === null) return null;
  let latest: number | null = null;
  for (const holding of table.holdings) {
    if (holding.securityId !== securityId || holding.holderId !== holderId) continue;
    if (holding.lockupUntilQuarter === null) continue;
    latest = latest === null ? holding.lockupUntilQuarter : Math.max(latest, holding.lockupUntilQuarter);
  }
  return latest;
}

/** Shares of a security sitting in the anonymous public float. */
export function floatShares(draft: SessionState, securityId: string): number {
  const security = findSecurity(draft, securityId);
  if (security === null) return 0;
  const table = findCapTable(draft, security.companyId);
  if (table === null) return 0;
  let total = 0;
  for (const holding of table.holdings) {
    if (holding.securityId === securityId && holding.holderKind === 'public_float') total += holding.shares;
  }
  return total;
}

/** Total accelerator-equivalents installed across the session. */
export function installedComputeBase(draft: SessionState): number {
  let total = 0;
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    total += company.compute.ownedAccelerators + company.compute.reservedAccelerators;
  }
  return total;
}

/** Researchers already committed to active programmes at one company. */
export function researchersCommitted(draft: SessionState, companyId: string): number {
  let total = 0;
  for (const project of draft.researchProjects) {
    if (project.companyId !== companyId) continue;
    if (project.status !== 'active' && project.status !== 'paused') continue;
    total += project.talentAllocated;
  }
  return total;
}

/** Compute already committed to active programmes at one company. */
export function computeCommitted(draft: SessionState, companyId: string): number {
  let total = 0;
  for (const project of draft.researchProjects) {
    if (project.companyId !== companyId) continue;
    if (project.status !== 'active') continue;
    total += project.computeAllocated;
  }
  return total;
}

/**
 * Accelerator-equivalents a company can still put on a new research programme.
 *
 * World 1 counts owned and reserved units, as it always has. World 2 counts
 * cloud capacity too, at the spot index, because most of its companies start
 * with nothing but cloud: counting only the accelerators they own clamped every
 * programme to zero compute and stalled it. The Frontier Map's start form reads
 * the same figure, so what the slider offers is what the validator accepts.
 */
export function researchComputeHeadroom(draft: SessionState, company: Company): number {
  const held = isMultiSectorWorld(draft)
    ? Math.floor(heldComputeUnits(draft, company))
    : company.compute.ownedAccelerators + company.compute.reservedAccelerators;
  return Math.max(0, held - computeCommitted(draft, company.id));
}

/* -------------------------------------------------------------------------- */
/*  Access                                                                     */
/* -------------------------------------------------------------------------- */

/** Why an approach is or is not permitted. */
export interface ReachDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Whether `fromId` may open contact with `toId`.
 *
 * INVARIANT: this is `checkAccess`, not a restatement of it. The validator, the
 * resolver's `applyIntroductionRequests` and every screen badge must return the
 * same verdict for the same pair, or the interface offers actions the engine
 * refuses.
 *
 * It used to restate the rule from `canInitiateContact` plus stored
 * `accessOverrides` alone, which silently dropped the *structural* overrides —
 * a shared board, a common investor on two cap tables, a consortium, a live
 * deal, a running story. Those are derived rather than stored, so a founder
 * whose seed investor also sits on eleven other cap tables was shown thirty-one
 * reachable people and could queue nothing against any of them: every action
 * gated on `canReach` was rejected as `target_not_reachable`, and every
 * introduction was refused because the intermediary was "unreachable" too.
 */
export function canReach(draft: SessionState, fromId: string | null, toId: string): ReachDecision {
  if (fromId === null) return { allowed: false, reason: 'No acting character, so no approach can be attributed.' };
  const decision = checkAccess(draft, fromId, toId);
  return { allowed: decision.allowed, reason: decision.reason };
}

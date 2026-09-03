/**
 * Which copy wins — decided in one place, with no I/O.
 *
 * Every reconciliation in the app is one of three questions:
 *
 * - *At first sight of a server* — what does this browser have that the host
 *   does not, and vice versa? (`planSlot`, `planMigration`.)
 * - *At a 409* — the host refused a push because it holds something else; whose
 *   copy is that? (`reconcileConflict`.)
 * - *At the picker* — with two copies of a slot, which one does Load load?
 *   (`mergeSlot`.)
 *
 * All three answer with the same sentence, and it is the server's:
 *
 * > **A save is never overwritten by an older one.** Older is decided by
 * > `savedQuarter` first, then `savedAtIso`; ties go to the server copy.
 *
 * That is `isNewer` in `./shared`, imported here rather than restated, so the
 * browser and the host cannot drift into disagreeing about which of two saves
 * is the later one.
 *
 * Pure by construction: no `fetch`, no `localStorage`, no clock. `./sync` is
 * what has the side effects, and it decides nothing.
 */

import { ABSENT_SAVE_SUMMARY, type SaveFileSummary, type SaveStatus } from '@/lib/game/saveFile';
import { SAVE_SLOTS, type SaveOrder, type SaveSlot, type SaveSummaryEnvelope, isNewer } from './shared';

/* -------------------------------------------------------------------------- */
/*  Slot names                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The manual slot number a server slot name stands for, or null for the
 * autosave.
 *
 * Two vocabularies meet here and neither is going to change: the browser has
 * had an autosave key and slots numbered 1–3 since before there was a server,
 * and the server names its four files `autosave`, `1`, `2`, `3`. This is the
 * whole of the translation.
 */
export function slotNumberOf(slot: SaveSlot): number | null {
  return slot === 'autosave' ? null : Number.parseInt(slot, 10);
}

/** The server's name for the autosave (`null`) or a manual slot. Null when out of range. */
export function saveSlotOf(slot: number | null): SaveSlot | null {
  if (slot === null) return 'autosave';
  const name = String(slot);
  return (SAVE_SLOTS as readonly string[]).includes(name) && name !== 'autosave' ? (name as SaveSlot) : null;
}

/* -------------------------------------------------------------------------- */
/*  Facts                                                                      */
/* -------------------------------------------------------------------------- */

/** What both sides hold for one slot, as far as anyone has looked. */
export interface SlotFacts {
  readonly slot: SaveSlot;
  /** This browser's copy, summarised. `absent` when the key holds nothing. */
  readonly local: SaveFileSummary;
  /** The host's copy, or null when the host has not been asked. */
  readonly server: SaveSummaryEnvelope | null;
}

/** The two facts the conflict rule reads, taken off a local summary. */
export function orderOf(summary: SaveFileSummary | SaveSummaryEnvelope): SaveOrder {
  return { savedQuarter: summary.savedQuarter, savedAtIso: summary.savedAtIso };
}

/** Is this local copy one this build can read, and therefore reason about? */
export function localReadable(status: SaveStatus): boolean {
  return status === 'ok';
}

/** Has the host ever accepted a write here? `revision` is the only fact that says so. */
export function serverOccupied(server: SaveSummaryEnvelope | null): boolean {
  return server !== null && server.revision > 0;
}

/* -------------------------------------------------------------------------- */
/*  The plan                                                                   */
/* -------------------------------------------------------------------------- */

export type SlotAction =
  /** Send this browser's copy to the host. */
  | 'upload'
  /** Take the host's copy, keeping this browser's as a backup first. */
  | 'adopt'
  /** Both hold the same position. */
  | 'in_sync'
  /** Neither holds anything. */
  | 'idle'
  /** Something is here that must not be touched — see `reason`. */
  | 'blocked';

export type SlotReason =
  | 'nothing_anywhere'
  | 'absent_on_server'
  | 'absent_locally'
  | 'local_newer'
  | 'server_newer'
  | 'same_position'
  /** A save this build cannot read (a newer build's, or corrupt). Preserved, never sent, never replaced. */
  | 'local_preserved';

export interface SlotPlan {
  readonly slot: SaveSlot;
  readonly action: SlotAction;
  readonly reason: SlotReason;
  /**
   * The revision an `upload` must condition on — what the host held when this
   * plan was made. A push that sends it is saying "apply this to the version I
   * looked at", which is what makes a second device a conflict instead of a
   * silent loss.
   */
  readonly ifRevision: number;
}

/**
 * What to do about one slot.
 *
 * The order of the cases is the argument. A local copy this build cannot read
 * is decided **first** and always the same way: it is neither uploaded (the
 * host would refuse it, and rightly — a save nobody can describe cannot be
 * ordered against anything) nor replaced (that is the downgrade that loses a
 * newer build's game). Everything after that is the conflict rule.
 */
export function planSlot(facts: SlotFacts): SlotPlan {
  const server = facts.server;
  const revision = server?.revision ?? 0;
  const here = facts.local.status;

  if (here !== 'absent' && !localReadable(here)) {
    return { slot: facts.slot, action: 'blocked', reason: 'local_preserved', ifRevision: revision };
  }

  const hasLocal = localReadable(here);
  const hasServer = serverOccupied(server);

  if (!hasLocal && !hasServer) return { slot: facts.slot, action: 'idle', reason: 'nothing_anywhere', ifRevision: revision };
  if (hasLocal && !hasServer) return { slot: facts.slot, action: 'upload', reason: 'absent_on_server', ifRevision: revision };
  if (!hasLocal && hasServer) return { slot: facts.slot, action: 'adopt', reason: 'absent_locally', ifRevision: revision };

  // Both. `server` is non-null here because `hasServer` proved it.
  const mine = orderOf(facts.local);
  const theirs = orderOf(server as SaveSummaryEnvelope);
  if (isNewer(mine, theirs)) return { slot: facts.slot, action: 'upload', reason: 'local_newer', ifRevision: revision };
  if (isNewer(theirs, mine)) return { slot: facts.slot, action: 'adopt', reason: 'server_newer', ifRevision: revision };
  return { slot: facts.slot, action: 'in_sync', reason: 'same_position', ifRevision: revision };
}

/**
 * The whole first-contact plan, one entry per slot, in picker order.
 *
 * Idempotent by construction: it is a function of the two inventories, so
 * running it again after it has been carried out yields `in_sync` everywhere it
 * previously said `upload` or `adopt`, and nothing is done twice.
 */
export function planMigration(facts: readonly SlotFacts[]): SlotPlan[] {
  const bySlot = new Map(facts.map((entry) => [entry.slot, entry]));
  return SAVE_SLOTS.map((slot) => {
    const entry = bySlot.get(slot);
    return entry === undefined
      ? { slot, action: 'idle' as const, reason: 'nothing_anywhere' as const, ifRevision: 0 }
      : planSlot(entry);
  });
}

/** Did this plan actually change anything? What the landing page's one line is about. */
export interface MigrationOutcome {
  readonly uploaded: SaveSlot[];
  readonly adopted: SaveSlot[];
  /** Slots whose local copy was set aside because the host's was newer. */
  readonly backedUp: SaveSlot[];
  readonly blocked: SaveSlot[];
}

export const NO_MIGRATION: MigrationOutcome = { uploaded: [], adopted: [], backedUp: [], blocked: [] };

export function migrationChangedSomething(outcome: MigrationOutcome): boolean {
  return outcome.uploaded.length > 0 || outcome.adopted.length > 0 || outcome.blocked.length > 0;
}

/* -------------------------------------------------------------------------- */
/*  Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a push should do after the host answered 409.
 *
 * - `resend` — ours is the later position, so send it again conditioned on the
 *   revision the host just named. The copy it displaces becomes the host's
 *   `<slot>.prev.json`, so the loser survives there.
 * - `yield` — theirs is later. Ours is kept as the local backup and the picker
 *   offers the host's copy; nothing is deleted on either side.
 * - `settled` — the two are the same position. Nothing to do but record the
 *   revision, which stops the retry loop.
 */
export type ConflictOutcome = 'resend' | 'yield' | 'settled';

export function reconcileConflict(local: SaveOrder, current: SaveSummaryEnvelope): ConflictOutcome {
  const theirs = orderOf(current);
  if (isNewer(local, theirs)) return 'resend';
  if (isNewer(theirs, local)) return 'yield';
  return 'settled';
}

/* -------------------------------------------------------------------------- */
/*  The merged view                                                            */
/* -------------------------------------------------------------------------- */

/** Which copy a Load would load. */
export type SlotSource = 'none' | 'local' | 'server';

/** One row of the picker, after both inventories have been folded together. */
export interface MergedSlot {
  readonly slot: SaveSlot;
  /** The manual slot number, or null for the autosave. */
  readonly slotNumber: number | null;
  readonly source: SlotSource;
  /** True when both hold a copy — the row can say "also on this device". */
  readonly onBoth: boolean;
  /** The status of the copy that would be loaded. A server copy is always `ok`. */
  readonly status: SaveStatus;
  readonly companyName: string | null;
  readonly founderName: string | null;
  readonly savedQuarter: number | null;
  readonly savedAtIso: string | null;
  /** The host's revision, for a conditional write. Zero when it holds nothing. */
  readonly revision: number;
}

/**
 * Fold one slot's two copies into the row the picker draws.
 *
 * The rule is the plan's: the host's copy is preferred exactly when the plan
 * says `adopt`, which is exactly when it is the later position or the only one.
 * A local copy this build cannot read stays visible as itself — the picker has
 * always told the difference between "empty" and "preserved", and a server copy
 * must not paper over that.
 */
export function mergeSlot(facts: SlotFacts): MergedSlot {
  const plan = planSlot(facts);
  const server = facts.server;
  const onBoth = localReadable(facts.local.status) && serverOccupied(server);
  const base = {
    slot: facts.slot,
    slotNumber: slotNumberOf(facts.slot),
    onBoth,
    revision: server?.revision ?? 0,
  };
  if (plan.action === 'blocked') {
    return { ...base, source: 'local', status: facts.local.status, ...names(facts.local) };
  }
  if (plan.action === 'adopt' && server !== null) {
    return { ...base, source: 'server', status: 'ok', ...names(server) };
  }
  if (plan.action === 'idle') {
    return { ...base, source: 'none', status: 'absent', companyName: null, founderName: null, savedQuarter: null, savedAtIso: null };
  }
  return { ...base, source: 'local', status: facts.local.status, ...names(facts.local) };
}

function names(from: SaveFileSummary | SaveSummaryEnvelope): {
  companyName: string | null;
  founderName: string | null;
  savedQuarter: number | null;
  savedAtIso: string | null;
} {
  return {
    companyName: from.companyName,
    founderName: from.founderName,
    savedQuarter: from.savedQuarter,
    savedAtIso: from.savedAtIso,
  };
}

export function mergeSlots(facts: readonly SlotFacts[]): MergedSlot[] {
  const bySlot = new Map(facts.map((entry) => [entry.slot, entry]));
  return SAVE_SLOTS.map((slot) => {
    const entry = bySlot.get(slot);
    return mergeSlot(entry ?? { slot, local: ABSENT_SAVE_SUMMARY, server: null });
  });
}

/**
 * Which copy wins.
 *
 * These are the assertions the whole feature stands on, so they are written as
 * the sentence they enforce rather than as the code they call:
 *
 * 1. **A save is never overwritten by an older one** — by `savedQuarter` first,
 *    then `savedAtIso`, ties to the server copy.
 * 2. **Quarter outranks the clock**, because a phone whose date is wrong must
 *    not win a reconciliation it has no business winning.
 * 3. **A save this build cannot read is neither sent nor replaced**, whatever
 *    the host holds.
 * 4. **Reconciling twice does nothing the second time**, which is what lets the
 *    migration run on every load instead of exactly once.
 *
 * Pure input, pure output, no clock: nothing here reads a timestamp it was not
 * handed.
 */

import { describe, expect, it } from 'vitest';
import { ABSENT_SAVE_SUMMARY, type SaveFileSummary } from '../game/saveFile';
import {
  type SlotFacts,
  mergeSlot,
  mergeSlots,
  planMigration,
  planSlot,
  reconcileConflict,
  saveSlotOf,
  slotNumberOf,
} from './plan';
import { type SaveSlot, type SaveSummaryEnvelope, emptySlot } from './shared';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function localSave(options: { quarter?: number | null; at?: string | null; status?: SaveFileSummary['status'] } = {}): SaveFileSummary {
  return {
    ...ABSENT_SAVE_SUMMARY,
    status: options.status ?? 'ok',
    version: 5,
    savedQuarter: options.quarter === undefined ? 4 : options.quarter,
    savedAtIso: options.at === undefined ? '2027-01-01T00:00:00.000Z' : options.at,
    companyName: 'Acme AI',
    founderName: 'Dana Vale',
  };
}

function serverSave(
  options: { quarter?: number | null; at?: string | null; revision?: number; company?: string } = {},
): SaveSummaryEnvelope {
  return {
    ...emptySlot('yc', 'autosave'),
    revision: options.revision ?? 1,
    updatedAtIso: '2027-02-01T00:00:00.000Z',
    savedQuarter: options.quarter === undefined ? 4 : options.quarter,
    savedAtIso: options.at === undefined ? '2027-01-01T00:00:00.000Z' : options.at,
    companyName: options.company ?? 'Acme AI',
    founderName: 'Dana Vale',
  };
}

function facts(local: SaveFileSummary | null, server: SaveSummaryEnvelope | null, slot: SaveSlot = 'autosave'): SlotFacts {
  return { slot, local: local ?? ABSENT_SAVE_SUMMARY, server };
}

/* -------------------------------------------------------------------------- */
/*  Slot names                                                                 */
/* -------------------------------------------------------------------------- */

describe('slot names', () => {
  it('translates between the browser numbering and the host naming', () => {
    expect(slotNumberOf('autosave')).toBeNull();
    expect(slotNumberOf('1')).toBe(1);
    expect(slotNumberOf('3')).toBe(3);
    expect(saveSlotOf(null)).toBe('autosave');
    expect(saveSlotOf(2)).toBe('2');
  });

  it('has no name for a slot that does not exist', () => {
    expect(saveSlotOf(0)).toBeNull();
    expect(saveSlotOf(4)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  One slot                                                                   */
/* -------------------------------------------------------------------------- */

describe('planSlot', () => {
  it('does nothing when neither side holds anything', () => {
    expect(planSlot(facts(null, null))).toMatchObject({ action: 'idle', reason: 'nothing_anywhere', ifRevision: 0 });
  });

  it('treats a never-written server slot as empty however it is described', () => {
    // revision 0 is the only fact that says "never written". A row with names
    // in it and revision 0 is still an empty slot.
    expect(planSlot(facts(localSave(), emptySlot('yc', 'autosave')))).toMatchObject({
      action: 'upload',
      reason: 'absent_on_server',
      ifRevision: 0,
    });
  });

  it('uploads what only this browser has, conditioned on nothing', () => {
    const plan = planSlot(facts(localSave(), null));
    expect(plan).toMatchObject({ action: 'upload', reason: 'absent_on_server', ifRevision: 0 });
  });

  it('adopts what only the host has', () => {
    expect(planSlot(facts(null, serverSave({ revision: 3 })))).toMatchObject({
      action: 'adopt',
      reason: 'absent_locally',
      ifRevision: 3,
    });
  });

  it('uploads when the local save is further along', () => {
    const plan = planSlot(facts(localSave({ quarter: 9 }), serverSave({ quarter: 4, revision: 7 })));
    expect(plan).toMatchObject({ action: 'upload', reason: 'local_newer', ifRevision: 7 });
  });

  it('adopts when the host is further along', () => {
    expect(planSlot(facts(localSave({ quarter: 2 }), serverSave({ quarter: 8 })))).toMatchObject({
      action: 'adopt',
      reason: 'server_newer',
    });
  });

  it('breaks a quarter tie on the stamp, in both directions', () => {
    expect(planSlot(facts(localSave({ at: '2027-06-01T00:00:00.000Z' }), serverSave({ at: '2027-01-01T00:00:00.000Z' })))).toMatchObject({
      action: 'upload',
      reason: 'local_newer',
    });
    expect(planSlot(facts(localSave({ at: '2027-01-01T00:00:00.000Z' }), serverSave({ at: '2027-06-01T00:00:00.000Z' })))).toMatchObject({
      action: 'adopt',
      reason: 'server_newer',
    });
  });

  it('gives an exact tie to the host, and calls it agreement rather than a conflict', () => {
    expect(planSlot(facts(localSave(), serverSave()))).toMatchObject({ action: 'in_sync', reason: 'same_position' });
  });

  it('lets the quarter outrank a wrong clock', () => {
    // The device is nine quarters further into the same game and thinks it is
    // 2019. It still wins, because quarters count decisions and clocks do not.
    const plan = planSlot(
      facts(localSave({ quarter: 12, at: '2019-01-01T00:00:00.000Z' }), serverSave({ quarter: 4, at: '2099-01-01T00:00:00.000Z' })),
    );
    expect(plan).toMatchObject({ action: 'upload', reason: 'local_newer' });
  });

  it('orders a save with no stamp below one that has one, at the same quarter', () => {
    expect(planSlot(facts(localSave({ at: null }), serverSave()))).toMatchObject({ action: 'adopt', reason: 'server_newer' });
  });

  it('ignores an unparseable stamp rather than letting NaN decide', () => {
    expect(planSlot(facts(localSave({ at: 'not a date' }), serverSave()))).toMatchObject({ action: 'adopt' });
  });

  for (const status of ['unsupported', 'unreadable'] as const) {
    it(`neither sends nor replaces a local save that is ${status}`, () => {
      const plan = planSlot(facts(localSave({ status, quarter: 99 }), serverSave({ quarter: 1 })));
      expect(plan).toMatchObject({ action: 'blocked', reason: 'local_preserved' });
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  The whole inventory                                                        */
/* -------------------------------------------------------------------------- */

describe('planMigration', () => {
  it('answers for all four slots, in picker order, from a partial inventory', () => {
    const plan = planMigration([facts(localSave(), null, '2')]);
    expect(plan.map((entry) => entry.slot)).toEqual(['autosave', '1', '2', '3']);
    expect(plan.map((entry) => entry.action)).toEqual(['idle', 'idle', 'upload', 'idle']);
  });

  it('uploads every local slot a fresh host does not have — decision 6, the first run', () => {
    const inventory = (['autosave', '1', '2', '3'] as const).map((slot) => facts(localSave(), null, slot));
    expect(planMigration(inventory).every((entry) => entry.action === 'upload')).toBe(true);
  });

  it('does nothing the second time, which is why it may run on every load', () => {
    // Carry out the first plan by hand: what was uploaded is now on the host,
    // at the same position, one revision up.
    const first = planMigration([facts(localSave({ quarter: 6 }), null)]);
    expect(first[0]).toMatchObject({ action: 'upload' });

    const second = planMigration([facts(localSave({ quarter: 6 }), serverSave({ quarter: 6, revision: 1 }))]);
    expect(second[0]).toMatchObject({ action: 'in_sync' });
    expect(second.slice(1).every((entry) => entry.action === 'idle')).toBe(true);
  });

  it('never plans to delete a server save because a browser lacks it', () => {
    const plan = planMigration([facts(null, serverSave(), '1')]);
    expect(plan.map((entry) => entry.action)).not.toContain('upload');
    expect(plan[1]).toMatchObject({ slot: '1', action: 'adopt' });
  });
});

/* -------------------------------------------------------------------------- */
/*  Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

describe('reconcileConflict', () => {
  it('re-sends when ours is the later position', () => {
    expect(reconcileConflict({ savedQuarter: 9, savedAtIso: '2027-01-01T00:00:00.000Z' }, serverSave({ quarter: 4 }))).toBe('resend');
  });

  it('yields when theirs is', () => {
    expect(reconcileConflict({ savedQuarter: 1, savedAtIso: '2027-01-01T00:00:00.000Z' }, serverSave({ quarter: 4 }))).toBe('yield');
  });

  it('settles when the two are the same position, so the retry stops', () => {
    expect(reconcileConflict({ savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' }, serverSave())).toBe('settled');
  });
});

/* -------------------------------------------------------------------------- */
/*  The merged view                                                            */
/* -------------------------------------------------------------------------- */

describe('mergeSlot', () => {
  it('shows the host copy when it is the later one, and says both have it', () => {
    const row = mergeSlot(facts(localSave({ quarter: 2 }), serverSave({ quarter: 8, revision: 4, company: 'Northwind' })));
    expect(row).toMatchObject({ source: 'server', onBoth: true, companyName: 'Northwind', savedQuarter: 8, revision: 4 });
  });

  it('shows this browser when it is the later one', () => {
    const row = mergeSlot(facts(localSave({ quarter: 8 }), serverSave({ quarter: 2 })));
    expect(row).toMatchObject({ source: 'local', onBoth: true, savedQuarter: 8 });
  });

  it('shows the host copy when this browser has none', () => {
    expect(mergeSlot(facts(null, serverSave()))).toMatchObject({ source: 'server', onBoth: false });
  });

  it('keeps a preserved local save visible as itself, never papered over by the host', () => {
    const row = mergeSlot(facts(localSave({ status: 'unsupported' }), serverSave({ quarter: 99 })));
    expect(row).toMatchObject({ source: 'local', status: 'unsupported' });
  });

  it('is empty only when both sides are', () => {
    expect(mergeSlot(facts(null, null))).toMatchObject({ source: 'none', status: 'absent', savedQuarter: null });
  });

  it('carries the slot number a browser control needs', () => {
    expect(mergeSlot(facts(localSave(), null, '2')).slotNumber).toBe(2);
    expect(mergeSlot(facts(localSave(), null, 'autosave')).slotNumber).toBeNull();
  });
});

describe('mergeSlots', () => {
  it('always draws four rows in picker order', () => {
    const rows = mergeSlots([facts(localSave(), null, '3')]);
    expect(rows.map((row) => row.slot)).toEqual(['autosave', '1', '2', '3']);
    expect(rows.map((row) => row.source)).toEqual(['none', 'none', 'none', 'local']);
  });
});

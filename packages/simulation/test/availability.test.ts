/**
 * The available-actions list is derived from the validator, not described
 * beside it. These tests are what keeps that true: every claim the list makes
 * is checked against the validator itself on a real session, so a rule change
 * that the list has not noticed fails here rather than misleading a founder.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, ActionType, CosBound } from '@frontier/contracts';
import { ACTION_TYPES, CONFIRMATION_REQUIRED_ACTIONS, CosAvailableActionSchema } from '@frontier/contracts';
import { createDemoSession } from '../src/scenario/demo';
import { availableActionsFor, availableActionTypes } from '../src/validator/availability';
import { BatchBudget, validateAction } from '../src/validator';

function seatOf(session: ReturnType<typeof createDemoSession>) {
  const seat = session.players[0];
  if (seat === undefined) throw new Error('the demo session has no seat');
  return { playerId: seat.playerId, companyId: seat.companyId, characterId: seat.characterId };
}

/** Read a dotted path off an intent, mirroring the module's own reader. */
function readPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of path.split('.')) {
    if (segment.endsWith('[]')) return undefined;
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

describe('availableActionsFor', () => {
  const session = createDemoSession();
  const actor = seatOf(session);
  const list = availableActionsFor(session, actor);

  it('covers every action type exactly once, in the union\'s own order', () => {
    expect(list.map((entry) => entry.type)).toEqual([...ACTION_TYPES]);
  });

  it('parses against the contract', () => {
    for (const entry of list) expect(CosAvailableActionSchema.safeParse(entry).success).toBe(true);
  });

  it('is deterministic: the same state produces the same list', () => {
    expect(availableActionsFor(session, actor)).toEqual(list);
  });

  it('marks exactly the always-confirm set as requiring confirmation', () => {
    const flagged = list.filter((entry) => entry.requiresConfirmation).map((entry) => entry.type);
    expect([...flagged].sort()).toEqual([...CONFIRMATION_REQUIRED_ACTIONS].sort());
  });

  it('gives every unavailable action a reason and every available one none', () => {
    for (const entry of list) {
      if (entry.available) expect(entry.reason).toBeNull();
      else expect(entry.reason === null ? '' : entry.reason).not.toHaveLength(0);
    }
  });

  it('reports at least the actions any company can always take', () => {
    const types = availableActionTypes(session, actor);
    for (const type of ['set_research_budget', 'set_marketing_budget', 'allocate_compute', 'hire'] as const) {
      expect(types).toContain(type);
    }
  });

  it('never claims a bound the validator would reduce', () => {
    // The property the whole module exists for. For every bound whose field the
    // probe's own clamp could have tightened, re-running the validator at the
    // reported maximum must not reduce that field any further.
    for (const entry of list) {
      if (!entry.available || entry.becomesBoardMatter) continue;
      for (const bound of entry.bounds) {
        if (bound.max === null) continue;
        const probe = probeAt(entry.type, session, actor, bound);
        if (probe === null) continue;
        const result = validateAction(session, probe, { ...actor, confirmedByHuman: true }, new BatchBudget(), `check_${entry.type}`);
        expect(result.status).not.toBe('rejected');
        const clamped = result.clampedAction === null ? null : readPath(result.clampedAction, bound.field);
        if (typeof clamped === 'number') expect(clamped).toBeGreaterThanOrEqual(bound.max);
      }
    }
  });

  it('reports a company with no cash as unable to spend', () => {
    const broke = {
      ...session,
      companies: session.companies.map((company) =>
        company.id === actor.companyId ? { ...company, financials: { ...company.financials, cash: 0 } } : company,
      ),
    };
    const entry = availableActionsFor(broke, actor).find((row) => row.type === 'hire');
    expect(entry?.available).toBe(false);
    expect(entry?.reason).toContain('uncommitted');
  });

  it('reports a company with no board as unable to table a matter', () => {
    const boardless = {
      ...session,
      companies: session.companies.map((company) => (company.id === actor.companyId ? { ...company, boardId: null } : company)),
    };
    const entry = availableActionsFor(boardless, actor).find((row) => row.type === 'submit_board_proposal');
    expect(entry?.available).toBe(false);
    expect(entry?.reason).toContain('no board');
  });

  it('says which actions become board matters rather than executing', () => {
    // A demo company with a board turns financing into a proposal. Whichever
    // ones do, they are available *and* flagged, never silently one or other.
    for (const entry of list) {
      if (entry.becomesBoardMatter) expect(entry.available).toBe(true);
    }
  });
});

/**
 * Rebuild the probe intent for one type with one bounded field set to the
 * reported maximum. Returns null for the types whose probe this test cannot
 * reconstruct without duplicating the module — those are covered by the
 * parse and confirmation assertions instead.
 */
function probeAt(
  type: ActionType,
  session: ReturnType<typeof createDemoSession>,
  actor: { companyId: string },
  bound: CosBound,
): ActionIntent | null {
  const company = session.companies.find((entry) => entry.id === actor.companyId);
  if (company === undefined || bound.max === null) return null;
  const max = bound.max;

  switch (type) {
    case 'set_research_budget':
      return bound.field === 'budgetUsd' ? { type, budgetUsd: max } : null;
    case 'hire':
      return bound.field === 'count' ? { type, role: 'engineers', count: max, compBand: 'market' } : null;
    case 'marketing_campaign':
      return bound.field === 'budgetUsd' ? { type, theme: 'brand', segment: 'enterprise', budgetUsd: max, quarters: 1 } : null;
    case 'buy_cloud_capacity':
      return bound.field === 'quarterlySpendUsd'
        ? { type, quarterlySpendUsd: max, providerCompanyId: null, commitmentQuarters: 0 }
        : null;
    case 'set_product_price': {
      const product = company.products.find((entry) => entry.isActive);
      return product !== undefined && bound.field === 'pricePerSeatUsd'
        ? { type, productId: product.id, pricePerSeatUsd: max }
        : null;
    }
    default:
      return null;
  }
}

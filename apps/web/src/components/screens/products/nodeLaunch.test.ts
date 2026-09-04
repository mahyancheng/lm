/**
 * The world-3 launch flow's gating, copy and ticket.
 *
 * The point of this file is that the launch screen makes no economic claim of
 * its own: the cost it shows is `unitCostOf`, the routes it offers are
 * `inputOptions`, the lock it reports is `canProduce`. What is left to test is
 * exactly what this module owns — which node is offered and in what order, what
 * the words say, and whether the ticket that comes out the far end is one the
 * validator accepts.
 *
 * The last of those is checked against the real validator rather than against
 * an expectation of it, because "the screen offers it and the engine refuses
 * it" is the failure this whole stage exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { Company, SessionState } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { createWorld3Session, nodeEntryRoutes, inputOptions, unitCostOf } from '@frontier/simulation';
import { playerCompanyOf, validateIntentForCompany } from '../../../lib/game/engine';
import {
  NODE_LAUNCH_STEPS,
  costingBlockers,
  defaultWiring,
  entryRoutes,
  launchIntent,
  launchOptions,
  lockReason,
  priceSentence,
  supplyFromWiring,
} from './nodeLaunch';

const usd = (value: number): string => `$${Math.round(value)}`;

/**
 * The world, seen from the seat that actually directs a company.
 *
 * `companies[0]` is not the player's: a ticket built against it is refused for
 * `not_controller_of_company` long before any world-3 rule is reached, which
 * would have made the validator assertions below pass for the wrong reason.
 */
function world(): { state: SessionState; company: Company } {
  const state = createWorld3Session();
  return { state, company: playerCompanyOf(state) };
}

/* -------------------------------------------------------------------------- */

describe('the four steps', () => {
  it('costs before it prices', () => {
    expect(NODE_LAUNCH_STEPS).toEqual(['Line', 'Cost to make', 'Inputs', 'Price']);
    expect(NODE_LAUNCH_STEPS.indexOf('Cost to make')).toBeLessThan(NODE_LAUNCH_STEPS.indexOf('Price'));
  });
});

describe('launchOptions', () => {
  it('offers open nodes before locked ones and finished goods before commodities', () => {
    const { state, company } = world();
    const options = launchOptions(state, company);
    expect(options.length).toBeGreaterThan(0);

    // Open first.
    const firstLocked = options.findIndex((option) => option.locked);
    if (firstLocked >= 0) {
      expect(options.slice(firstLocked).every((option) => option.locked)).toBe(true);
    }
    // Inside the open, unsold before already-sold, then tier descending.
    const open = options.filter((option) => !option.locked && !option.alreadySold);
    for (let i = 1; i < open.length; i += 1) {
      expect((open[i - 1]?.tier ?? 0) >= (open[i]?.tier ?? 0)).toBe(true);
    }
  });

  it('never offers a node from a sector this company has no foothold in', () => {
    const { state, company } = world();
    const owned = new Set(company.ownedNodes ?? []);
    for (const option of launchOptions(state, company)) {
      const inOwnSector = option.node.sector === company.sector;
      expect(inOwnSector || owned.has(option.node.id)).toBe(true);
    }
  });
});

describe('lockReason and the three ways in', () => {
  it('says nothing when the company can already make it', () => {
    const { state, company } = world();
    const own = launchOptions(state, company).find((option) => !option.locked);
    expect(own).toBeDefined();
    expect(lockReason(nodeEntryRoutes(state, company, own!.node.id))).toBe('');
  });

  it('names the node the company does not own', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const reason = lockReason(nodeEntryRoutes(state, company, locked.node.id));
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain(locked.node.label);
  });

  it('offers all three routes, and says which of them the world actually has', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const offers = entryRoutes(nodeEntryRoutes(state, company, locked.node.id), usd);
    expect(offers.map((offer) => offer.kind)).toEqual(['research', 'licence', 'buy']);
    // A route nobody offers is present and says so rather than being hidden.
    for (const offer of offers) {
      expect(offer.detail.length).toBeGreaterThan(0);
      if (!offer.available) expect(offer.detail).toMatch(/Nobody|cannot|nothing/i);
    }
  });
});

describe('wiring', () => {
  it('defaults to whatever the roll-up already does, so costing survives the step', () => {
    const { state, company } = world();
    const nodeId = company.products.find((product) => product.nodeId !== undefined)?.nodeId ?? '';
    if (nodeId === '') return;
    const options = inputOptions(state, company, nodeId);
    const wiring = defaultWiring(options);
    for (const option of options) {
      const chosen = option.chosen;
      if (chosen?.kind === 'buy') {
        expect(wiring[option.inputNodeId]?.supplierCompanyId).toBe(chosen.supplierCompanyId);
      } else {
        expect(wiring[option.inputNodeId]).toBeUndefined();
      }
    }
  });

  it('drops an open-market choice rather than sending it as a deliberate null', () => {
    // An absent entry is the open market; a null pair is "unsupplied", which
    // stops the line shipping. They must not be confused.
    const supply = supplyFromWiring({
      mat_wafer_300mm: { supplierCompanyId: null, supplierProductId: null },
      cmp_logic_die: { supplierCompanyId: 'cmp_a', supplierProductId: 'prd_a' },
    });
    expect(supply).toEqual([{ inputCategoryId: 'cmp_logic_die', supplierCompanyId: 'cmp_a', supplierProductId: 'prd_a' }]);
  });
});

describe('priceSentence', () => {
  it('states the position against the market and the margin, in whole percent', () => {
    expect(priceSentence(120, 100, 60, usd)).toBe('20% above the market at $100, a 50% gross margin.');
    expect(priceSentence(80, 100, 60, usd)).toBe('20% below the market at $100, a 25% gross margin.');
  });

  it('says "under cost" in words rather than showing a negative margin', () => {
    expect(priceSentence(50, 100, 75, usd)).toContain('50% under cost');
  });

  it('handles a free line and a node with no market price', () => {
    expect(priceSentence(0, 100, 10, usd)).toContain('Free');
    expect(priceSentence(100, 0, 50, usd)).toBe('a 50% gross margin.');
  });
});

describe('costingBlockers', () => {
  it('names a blocked input by its label, and is empty when nothing blocks', () => {
    const { state, company } = world();
    const nodeId = company.products.find((product) => product.nodeId !== undefined)?.nodeId ?? '';
    if (nodeId === '') return;
    expect(costingBlockers(unitCostOf(state, company, nodeId))).toEqual([]);

    const node = economicNodeById(nodeId);
    const required = node?.consumes.find((input) => !input.substitutable);
    if (required === undefined) return;
    for (const candidate of state.companies) {
      candidate.ownedNodes = (candidate.ownedNodes ?? []).filter((id) => id !== required.nodeId);
      candidate.licences = (candidate.licences ?? []).filter((licence) => licence.nodeId !== required.nodeId);
      candidate.products = candidate.products.filter((product) => product.nodeId !== required.nodeId);
    }
    const blockers = costingBlockers(unitCostOf(state, company, nodeId));
    expect(blockers).toContain(economicNodeById(required.nodeId)?.label);
  });
});

/* -------------------------------------------------------------------------- */
/*  The ticket, against the real validator                                     */
/* -------------------------------------------------------------------------- */

describe('launchIntent', () => {
  it('refuses to build a ticket out of an incomplete form', () => {
    const { state, company } = world();
    const node = launchOptions(state, company).find((option) => !option.locked)?.node;
    expect(node).toBeDefined();
    expect(launchIntent({ node: node!, name: '   ', priceUsd: 100, marketingUsd: 0, quality: 0.5, wiring: {} })).toBeNull();
    expect(launchIntent({ node: node!, name: 'A line', priceUsd: -1, marketingUsd: 0, quality: 0.5, wiring: {} })).toBeNull();
  });

  it('carries the NODE id and the node\'s own buyer segment', () => {
    const { state, company } = world();
    const node = launchOptions(state, company).find((option) => !option.locked && !option.alreadySold)?.node;
    if (node === undefined) return;
    const intent = launchIntent({ node, name: 'New line', priceUsd: 1_000, marketingUsd: 0, quality: 0.5, wiring: {} });
    expect(intent).not.toBeNull();
    if (intent === null || intent.type !== 'launch_product') throw new Error('not a launch');
    expect(intent.categoryId).toBe(node.id);
    expect(intent.segment).toBe(node.buyerSegment ?? 'enterprise');
  });

  it('produces a ticket the validator accepts for an open node', () => {
    const { state, company } = world();
    const node = launchOptions(state, company).find((option) => !option.locked && !option.alreadySold)?.node;
    if (node === undefined) return;
    const intent = launchIntent({ node, name: 'A brand new line', priceUsd: 1_000, marketingUsd: 0, quality: 0.5, wiring: {} });
    const verdict = validateIntentForCompany(state, intent!, company.id);
    expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
  });

  it('produces a ticket the validator refuses for a node the company does not own', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const intent = launchIntent({ node: locked.node, name: 'Something locked', priceUsd: 1_000, marketingUsd: 0, quality: 0.5, wiring: {} });
    const verdict = validateIntentForCompany(state, intent!, company.id);
    expect(verdict.status).toBe('rejected');
    // And the refusal names the same thing the screen's lock reason does.
    expect(verdict.reasons.some((reason) => reason.includes(locked.node.label))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ECONOMIC_NODES, type DealProposalDraft, type ResolverContext, type SubmittedAction } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createWorld3Session } from '../src/scenario/world3';
import { routeDeals, routeNodeLicences } from '../src/resolver/routing';

function fixture() {
  const state = createWorld3Session();
  const player = state.companies.find((c) => c.id === state.players[0]!.companyId)!;
  const owner = state.companies.find((c) => c.controllerPlayerId === null && c.isActive)!;
  const node = ECONOMIC_NODES.find((n) => n.researchable)!;
  owner.ownedNodes = [...(owner.ownedNodes ?? []), node.id];
  owner.licenceOffers = [];
  player.licences = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const ctx: ResolverContext = { quarter: state.quarter, rng: createRng('negotiation'), emit: (e) => { events.push(e); return 'evt_' + events.length; }, log: () => undefined };
  const draft: DealProposalDraft = { counterpartyId: owner.id, counterpartyKind: 'company', gives: [],
    gets: [{ kind: 'node_licence', nodeId: node.id, ownerCompanyId: owner.id, licenseeCompanyId: player.id, royaltyPct: 15, quarters: 4, upfrontUsd: 12345 }],
    binding: true, confidentiality: 'private', expiresQuarter: state.quarter + 2, intentStatements: [], summary: 'Licence the technology on the exact negotiated terms.' };
  const submit = (): void => {
    const action: SubmittedAction = { actionId: 'act_negotiation', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: player.controllerPlayerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId!, origin: 'player_ui',
      confirmedByHuman: true, intent: { type: 'propose_deal', proposal: draft } };
    state.pendingActions = [action];
    routeDeals(state, ctx);
    routeNodeLicences(state, ctx);
  };
  return { state, player, owner, node, draft, ctx, events, submit };
}

describe('negotiated licence settlement', () => {
  it('an NPC accepts viable terms and the exact rights and fee settle once', () => {
    const f = fixture();
    const before = f.player.financials.cash;
    const ownerBefore = f.owner.financials.cash;
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('executed');
    expect(f.player.licences).toContainEqual({ nodeId: f.node.id, ownerCompanyId: f.owner.id, royaltyPct: 15, expiryQuarter: f.state.quarter + 4 });
    expect(f.player.financials.cash).toBe(before - 12345);
    expect(f.owner.financials.cash).toBe(ownerBefore + 12345);
    f.submit();
    expect(f.player.financials.cash).toBe(before - 12345);
    expect(f.events.filter((e) => e.type === 'node_licensed')).toHaveLength(1);
  });

  it('settles licence fee and separately negotiated cash atomically, once', () => {
    const f = fixture();
    f.draft.gives = [{ kind: 'cash_payment', amount: 800 }];
    f.draft.gets = [...f.draft.gets, { kind: 'cash_payment', amount: 125 }];
    const playerBefore = f.player.financials.cash;
    const ownerBefore = f.owner.financials.cash;
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('executed');
    expect(f.player.licences).toHaveLength(1);
    expect(f.player.financials.cash).toBe(playerBefore - 12345 - 800 + 125);
    expect(f.owner.financials.cash).toBe(ownerBefore + 12345 + 800 - 125);
    f.submit();
    expect(f.player.financials.cash).toBe(playerBefore - 12345 - 800 + 125);
  });

  it('does not grant or charge any part of an unfundable licence bundle, even with injected consent', () => {
    const f = fixture();
    f.draft.gives = [{ kind: 'cash_payment', amount: f.player.financials.cash }];
    const before = f.player.financials.cash;
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('rejected');
    f.state.deals.at(-1)!.status = 'accepted';
    routeNodeLicences(f.state, f.ctx);
    expect(f.state.deals.at(-1)?.breachedByPartyId).toBe(f.player.id);
    expect(f.player.financials.cash).toBe(before);
    expect(f.player.licences).toEqual([]);
  });

  it('settles a binding cash exchange once, after acceptance', () => {
    const f = fixture();
    f.draft.gets = [{ kind: 'cash_payment', amount: 250 }];
    f.draft.gives = [{ kind: 'cash_payment', amount: 1000 }];
    f.draft.summary = 'A cash exchange on signing.';
    const before = f.player.financials.cash;
    const ownerBefore = f.owner.financials.cash;
    f.submit();
    // Cash deals settle in the following quarter, unlike node licences.
    expect(f.state.deals.at(-1)?.status).toBe('accepted');
    f.state.quarter += 1;
    routeDeals(f.state, f.ctx);
    expect(f.state.deals.at(-1)?.status).toBe('executed');
    expect(f.player.financials.cash).toBe(before - 750);
    expect(f.owner.financials.cash).toBe(ownerBefore + 750);
    routeDeals(f.state, f.ctx);
    expect(f.player.financials.cash).toBe(before - 750);
    expect(f.events.filter((e) => e.type === 'deal_executed')).toHaveLength(1);
  });

  it('normalizes fractional amounts before settlement', () => {
    const f = fixture();
    f.draft.gets = [{ kind: 'cash_payment', amount: 0.6 }, { kind: 'cash_payment', amount: 0.6 }];
    f.draft.gives = [{ kind: 'cash_payment', amount: 2.4 }];
    f.draft.summary = 'Rounded cash consideration.';
    const before = f.player.financials.cash;
    f.submit();
    f.state.quarter += 1;
    routeDeals(f.state, f.ctx);
    expect(f.state.deals.at(-1)?.status).toBe('executed');
    expect(f.state.deals.at(-1)?.breachedByPartyId).toBeNull();
    expect(f.player.financials.cash).toBe(before);
  });

  it('breaches without moving either side when an accepted deal later becomes unfundable', () => {
    const f = fixture();
    f.draft.gets = [{ kind: 'cash_payment', amount: 500 }];
    f.draft.gives = [{ kind: 'cash_payment', amount: 1000 }];
    f.draft.summary = 'A funded cash exchange.';
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('accepted');
    const ownerBefore = f.owner.financials.cash;
    f.player.financials.cash = 0;
    f.state.quarter += 1;
    routeDeals(f.state, f.ctx);
    expect(f.state.deals.at(-1)?.breachedByPartyId).toBe(f.player.id);
    expect(f.owner.financials.cash).toBe(ownerBefore);
    expect(f.events.filter((e) => e.type === 'deal_breached')).toHaveLength(1);
  });

  it('an NPC refuses an inadequate royalty without charging the fee', () => {
    const f = fixture();
    f.draft.gets[0] = { ...f.draft.gets[0]!, royaltyPct: 0 } as typeof f.draft.gets[number];
    const before = f.player.financials.cash;
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('rejected');
    expect(f.player.financials.cash).toBe(before);
    expect(f.player.licences).toEqual([]);
  });

  it.each(['third-party', 'unsupported'] as const)('refuses %s terms, even if an acceptance is injected later', (kind) => {
    const f = fixture();
    if (kind === 'unsupported') f.draft.gives = [{ kind: 'public_endorsement', statement: 'We support this technology partnership.', quarters: 2 }];
    else f.draft.gets[0] = { ...f.draft.gets[0]!, licenseeCompanyId: f.owner.id } as typeof f.draft.gets[number];
    const before = f.player.financials.cash;
    f.submit();
    expect(f.state.deals.at(-1)?.status).toBe('rejected');
    f.state.deals.at(-1)!.status = 'accepted';
    routeNodeLicences(f.state, f.ctx);
    expect(f.state.deals.at(-1)?.status).toBe('rejected');
    expect(f.player.financials.cash).toBe(before);
    expect(f.player.licences).toEqual([]);
  });
});

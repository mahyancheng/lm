/**
 * The Street's surfaces, pinned.
 *
 * These screens read the institutional layer the resolver committed onto
 * `EconomyReport` and onto the `DealProposal` obligations a capital desk wrote.
 * The rule they live under is the same one every Wave 3 surface lives under and
 * it is not enforceable by types, so it is enforced here:
 *
 * > nothing in the interface computes an economic number; it renders rows the
 * > resolver recorded, and every threshold it draws a badge from is the
 * > engine's own constant.
 *
 * Five groups:
 *
 * 1. **Cards.** Roster order held, the committed row carried through verbatim,
 *    portfolios and short books attributed to the right entity.
 * 2. **The clock.** The forced-seller horizon runs at the engine's own rate, is
 *    monotone, and is zero for a fund already at the floor.
 * 3. **Short interest.** The squeeze badge fires at the engine's thresholds and
 *    nowhere else; the bar is drawn against the cap; an undisclosed holder is
 *    absent rather than summarised.
 * 4. **The inbox.** Ordering, and the one rule that makes it a decision: an
 *    offer made in quarter *t* is answerable in *t+1*, never in *t*.
 * 5. **World version.** A world-version-1 session renders every one of these
 *    surfaces as absent, and a multi-sector one renders them as populated.
 *
 * Relative imports throughout: the `@/` alias is Next's, and the test files keep
 * to relative paths (see `vitest.config.mts`).
 */

import { describe, expect, it } from 'vitest';
import type {
  ActivistCampaign,
  CapitalPositionRow,
  DealProposal,
  NewGameSetupInput,
  SessionState,
  ShortInterestRow,
} from '@frontier/contracts';
import {
  COUNTER_BAND_PCT,
  CURRENT_WORLD_VERSION,
  FUND_TERM_QUARTERS,
  LP_PRESSURE_FORCED_FLOOR,
  SHORT_INTEREST_CAP_PCT,
  SQUEEZE_MIN_SHORT_INTEREST_PCT,
  TAKEOVER_DEFENCE_REPUTATION_COST,
  borrowFeePctFor,
} from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { projectPlayerView } from '../../../lib/game/playerView';
import { isFundVoice } from '../feed/filters';
import {
  BACKER_STAKE_PCT,
  BACKER_TRUST,
  EMPTY_STANCE_CONTEXT,
  LP_PRESSURE_PER_QUARTER,
  answerableCount,
  buyoutOf,
  counterBand,
  counterInsideBand,
  counteredTermSheet,
  defenceOptions,
  disclosedHolders,
  forcedSellerInQuarters,
  offerInbox,
  shortInterestBadge,
  shortInterestFraction,
  squeezeRisk,
  stanceOf,
  streetCards,
  termSheetOf,
  termSheetPreview,
  type StanceContext,
  type TermSheet,
} from './model';

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                   */
/* -------------------------------------------------------------------------- */

const MULTI_SECTOR: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

/** Every quarter of a run, so one engine pass serves several tabs. */
function replay(state: SessionState, quarters: number): SessionState[] {
  const engine = createDefaultEngine();
  const steps: SessionState[] = [];
  let current = state;
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(current, [], null, []);
    expect(outcome.committed).toBe(true);
    current = outcome.nextState;
    steps.push(current);
  }
  return steps;
}

function resolved(state: SessionState, quarters: number): SessionState {
  const steps = replay(state, quarters);
  const last = steps[steps.length - 1];
  if (last === undefined) throw new Error('no quarters resolved');
  return last;
}

const worldTwoSteps = replay(createDemoSession(undefined, MULTI_SECTOR), 6);
const worldTwo = worldTwoSteps[5] as SessionState;
const worldTwoView = projectPlayerView(worldTwo);
const ownCompanyId = worldTwoView.ownCompany.id;

/**
 * The quarter the venture desk's opening term sheets are answerable in.
 *
 * A desk writes a sheet in quarter *t* and it lapses on the clock the engine
 * gave it, so the tab an inbox test reads has to be the one where an offer is
 * actually on the table — the fixture is chosen by that fact, not by a
 * convenient constant.
 */
const offersState = worldTwoSteps.find((state) => {
  const view = projectPlayerView(state);
  return view.deals.some(
    (deal) =>
      deal.status === 'proposed' &&
      deal.expiresQuarter >= state.quarter &&
      deal.createdQuarter < state.quarter &&
      deal.gives.some((obligation) => obligation.kind === 'term_sheet' || obligation.kind === 'buyout_offer'),
  );
}) as SessionState;
const offersView = projectPlayerView(offersState);

const worldOne = resolved(createDemoSession(), 6);
const worldOneView = projectPlayerView(worldOne);

const context: StanceContext = { ...EMPTY_STANCE_CONTEXT, ownCompanyIds: new Set([ownCompanyId]) };

/* -------------------------------------------------------------------------- */
/*  1. The cards                                                               */
/* -------------------------------------------------------------------------- */

describe('the roster of cards', () => {
  const cards = streetCards(worldTwoView.economyReport, context);

  it('is one card per committed entity, in the engine’s own order', () => {
    const rows = worldTwoView.economyReport?.capitalEntities ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(cards.map((card) => card.row.entityId)).toEqual(rows.map((row) => row.entityId));
  });

  it('carries the committed row through untouched', () => {
    for (const card of cards) {
      const source = worldTwoView.economyReport?.capitalEntities.find((row) => row.entityId === card.row.entityId);
      expect(card.row).toBe(source);
      // Every figure the card prints is already whole on the row: the screen
      // rounds nothing.
      expect(Number.isInteger(card.row.dryPowderPct)).toBe(true);
      expect(Number.isInteger(card.row.lpPressure)).toBe(true);
      expect(Number.isInteger(card.row.dpiPct)).toBe(true);
      expect(card.row.dryPowderPct).toBeGreaterThanOrEqual(0);
      expect(card.row.dryPowderPct).toBeLessThanOrEqual(100);
    }
  });

  it('attributes every portfolio line and every short book to its own entity', () => {
    for (const card of cards) {
      for (const position of card.portfolio) expect(position.entityId).toBe(card.row.entityId);
      for (const short of card.shorts) expect(short.disclosedEntityIds).toContain(card.row.entityId);
      for (const position of card.ownPositions) expect(position.companyId).toBe(ownCompanyId);
    }
  });

  it('accounts for every visible position exactly once across the roster', () => {
    const attributed = cards.reduce((total, card) => total + card.portfolio.length, 0);
    const visible = worldTwoView.economyReport?.capitalPositions.length ?? 0;
    expect(attributed).toBe(visible);
  });

  it('orders a portfolio by what it is marked at, largest first', () => {
    for (const card of cards) {
      for (let index = 1; index < card.portfolio.length; index += 1) {
        const previous = card.portfolio[index - 1];
        const current = card.portfolio[index];
        if (previous === undefined || current === undefined) throw new Error('portfolio drifted');
        expect(previous.valueUsd).toBeGreaterThanOrEqual(current.valueUsd);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Stance                                                                  */
/* -------------------------------------------------------------------------- */

describe('the stance a card shows its reader', () => {
  const entityId = 'fund_test';
  const row = { entityId, partnerCharacterId: 'chr_partner' } as const;
  const holding: CapitalPositionRow = {
    entityId,
    companyId: ownCompanyId,
    securityId: 'sec_a',
    shares: 100,
    stakePct: BACKER_STAKE_PCT,
    sinceQuarter: 0,
    costBasisUsd: 1,
    valueUsd: 2,
    unrealisedMultiplePct: 200,
    isDisclosed: true,
  };

  function ctx(patch: Partial<StanceContext>): StanceContext {
    return { ...EMPTY_STANCE_CONTEXT, ownCompanyIds: new Set([ownCompanyId]), ...patch };
  }

  it('is watching by default, and a stranger is not scored as an enemy', () => {
    expect(stanceOf(row, [], ctx({}))).toBe('watching');
  });

  it('is a backer only when they hold enough of you and their partner trusts you', () => {
    const trusted = ctx({ trustByPartnerId: new Map([['chr_partner', BACKER_TRUST]]) });
    expect(stanceOf(row, [holding], trusted)).toBe('backer');
    // One point of trust below the line, and a stake this size is just a stake.
    const cool = ctx({ trustByPartnerId: new Map([['chr_partner', BACKER_TRUST - 1]]) });
    expect(stanceOf(row, [holding], cool)).toBe('watching');
    // A stake in somebody else's company is not a stake in yours.
    const elsewhere = { ...holding, companyId: 'cmp_someone_else' };
    expect(stanceOf(row, [elsewhere], trusted)).toBe('watching');
  });

  it('is hostile on a short, a campaign, or plain hostility', () => {
    expect(stanceOf(row, [], ctx({ shortEntityIds: new Set([entityId]) }))).toBe('hostile');
    expect(stanceOf(row, [], ctx({ campaignEntityIds: new Set([entityId]) }))).toBe('hostile');
    expect(stanceOf(row, [], ctx({ hostilityByPartnerId: new Map([['chr_partner', 55]]) }))).toBe('hostile');
  });

  it('is an adversary on an approach or a proxy fight, whatever else is true', () => {
    const backing = ctx({
      trustByPartnerId: new Map([['chr_partner', 90]]),
      approachEntityIds: new Set([entityId]),
    });
    expect(stanceOf(row, [holding], backing)).toBe('adversary');
    expect(stanceOf(row, [], ctx({ proxyFightEntityIds: new Set([entityId]) }))).toBe('adversary');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The clock                                                               */
/* -------------------------------------------------------------------------- */

describe('the forced-seller horizon', () => {
  it('runs at the rate the engine’s own LP clock runs', () => {
    expect(LP_PRESSURE_PER_QUARTER).toBe(100 / FUND_TERM_QUARTERS);
    // One quarter of ageing from one quarter below the floor.
    expect(forcedSellerInQuarters(LP_PRESSURE_FORCED_FLOOR - LP_PRESSURE_PER_QUARTER)).toBe(1);
  });

  it('is zero for a fund already at or above the floor', () => {
    expect(forcedSellerInQuarters(LP_PRESSURE_FORCED_FLOOR)).toBe(0);
    expect(forcedSellerInQuarters(100)).toBe(0);
  });

  it('never rises as the pressure rises', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let pressure = 0; pressure <= 100; pressure += 1) {
      const quarters = forcedSellerInQuarters(pressure) ?? Number.POSITIVE_INFINITY;
      expect(quarters).toBeLessThanOrEqual(previous);
      previous = quarters;
    }
  });

  it('is visible at least four quarters out, which is the whole point of printing it', () => {
    const fourOut = LP_PRESSURE_FORCED_FLOOR - 4 * LP_PRESSURE_PER_QUARTER;
    expect(forcedSellerInQuarters(fourOut)).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Short interest                                                          */
/* -------------------------------------------------------------------------- */

describe('the short-interest badge', () => {
  function short(patch: Partial<ShortInterestRow>): ShortInterestRow {
    return {
      instrumentId: 'ins_a',
      companyId: 'cmp_a',
      shortInterestPct: 0,
      borrowFeePctPerQuarter: 1,
      disclosedEntityIds: [],
      squeezeFired: false,
      forcedCoverShares: 0,
      causeEventId: null,
      ...patch,
    };
  }

  it('warns exactly at the engine’s squeeze floor and not one point below it', () => {
    expect(squeezeRisk(short({ shortInterestPct: SQUEEZE_MIN_SHORT_INTEREST_PCT - 1 }))).toBe('none');
    expect(squeezeRisk(short({ shortInterestPct: SQUEEZE_MIN_SHORT_INTEREST_PCT }))).toBe('watch');
  });

  it('reports a fired squeeze as a fact the resolver wrote, never as a guess', () => {
    const fired = short({ shortInterestPct: 1, squeezeFired: true, forcedCoverShares: 12_000 });
    expect(squeezeRisk(fired)).toBe('fired');
    expect(shortInterestBadge(fired).label).toContain('12,000');
    expect(shortInterestBadge(fired).tone).toBe('loss');
  });

  it('draws its bar against the per-instrument cap, never against a hundred', () => {
    expect(shortInterestFraction(short({ shortInterestPct: SHORT_INTEREST_CAP_PCT }))).toBe(1);
    expect(shortInterestFraction(short({ shortInterestPct: 0 }))).toBe(0);
    // A row that somehow exceeds the cap still fills the bar rather than spilling.
    expect(shortInterestFraction(short({ shortInterestPct: SHORT_INTEREST_CAP_PCT + 5 }))).toBe(1);
  });

  it('prints the borrow fee the engine charges, not one of its own', () => {
    for (const row of worldTwoView.economyReport?.shortInterest ?? []) {
      expect(row.borrowFeePctPerQuarter).toBe(borrowFeePctFor(row.shortInterestPct));
    }
  });

  it('names only holders who crossed the disclosure line', () => {
    for (const companyId of [ownCompanyId, 'cmp_lumen']) {
      for (const holder of disclosedHolders(worldTwoView.economyReport, companyId)) {
        expect(holder.isDisclosed).toBe(true);
        expect(holder.companyId).toBe(companyId);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  5. The inbox                                                               */
/* -------------------------------------------------------------------------- */

describe('the offers inbox', () => {
  const quarter = offersState.quarter;
  const offers = offerInbox({
    deals: offersView.deals,
    campaigns: offersState.activistCampaigns ?? [],
    companyIds: new Set([ownCompanyId]),
    quarter,
  });

  it('is built from the deals the desks wrote, and from nothing else', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.companyId).toBe(ownCompanyId);
      if (offer.deal === null) continue;
      expect(offer.deal.status).toBe('proposed');
      expect(termSheetOf(offer.deal) !== null || buyoutOf(offer.deal) !== null).toBe(true);
    }
  });

  it('never lets an offer be answered in the quarter it was made', () => {
    for (const offer of offers) {
      if (offer.deal === null) continue;
      expect(offer.answerableFromQuarter).toBe(offer.createdQuarter + 1);
      const sameQuarter = offerInbox({
        deals: [offer.deal],
        campaigns: [],
        companyIds: new Set([ownCompanyId]),
        quarter: offer.createdQuarter,
      });
      expect(sameQuarter[0]?.isAnswerable).toBe(false);
      const nextQuarter = offerInbox({
        deals: [offer.deal],
        campaigns: [],
        companyIds: new Set([ownCompanyId]),
        quarter: offer.createdQuarter + 1,
      });
      expect(nextQuarter[0]?.isAnswerable).toBe(offer.deal.expiresQuarter >= offer.createdQuarter + 1);
    }
  });

  it('puts what needs an answer first, then the largest, then the newest', () => {
    for (let index = 1; index < offers.length; index += 1) {
      const previous = offers[index - 1];
      const current = offers[index];
      if (previous === undefined || current === undefined) throw new Error('inbox drifted');
      if (previous.isAnswerable !== current.isAnswerable) {
        expect(previous.isAnswerable).toBe(true);
        continue;
      }
      if (previous.valueUsd !== current.valueUsd) {
        expect(previous.valueUsd).toBeGreaterThan(current.valueUsd);
        continue;
      }
      expect(previous.createdQuarter).toBeGreaterThanOrEqual(current.createdQuarter);
    }
    expect(answerableCount(offers)).toBe(offers.filter((offer) => offer.isAnswerable).length);
  });

  it('keeps another company’s offers out of your inbox', () => {
    const foreign = offerInbox({
      deals: offersView.deals,
      campaigns: [],
      companyIds: new Set(['cmp_nobody']),
      quarter,
    });
    expect(foreign).toHaveLength(0);
  });

  it('carries a live campaign, and drops a closed one', () => {
    const live: ActivistCampaign = {
      id: 'cam_1',
      entityId: 'fund_kaido',
      targetCompanyId: ownCompanyId,
      stage: 'public_letter',
      demands: ['cut_costs'],
      openedQuarter: quarter - 2,
      lastEscalatedQuarter: quarter - 1,
      stakePct: 15,
      convictionPct: 44,
      seatsGranted: 0,
      outcome: null,
      closedQuarter: null,
    };
    const withLive = offerInbox({ deals: [], campaigns: [live], companyIds: new Set([ownCompanyId]), quarter });
    expect(withLive).toHaveLength(1);
    expect(withLive[0]?.kind).toBe('activist');
    expect(withLive[0]?.isAnswerable).toBe(true);

    const closed = { ...live, outcome: 'settled' as const, closedQuarter: quarter - 1 };
    expect(offerInbox({ deals: [], campaigns: [closed], companyIds: new Set([ownCompanyId]), quarter })).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Previews and countering                                                 */
/* -------------------------------------------------------------------------- */

describe('the now → after preview on a term sheet', () => {
  const sheet: TermSheet = {
    kind: 'term_sheet',
    entityId: 'fund_seawall',
    companyId: ownCompanyId,
    stage: 'series_b',
    amountUsd: 60_000_000,
    preMoneyUsd: 340_000_000,
    dilutionPct: 15,
    boardSeats: 1,
    proRata: true,
    protectiveProvisions: false,
    liquidationPreferenceMultiple: 1,
    participating: false,
  };

  it('applies the fund’s own dilution to the founder’s own stake', () => {
    const rows = termSheetPreview(sheet, { ownStakePct: 62, cashUsd: 18_000_000, boardSeats: 5, partnerName: 'Helena Ward' });
    const ownership = rows.find((row) => row.key === 'ownership');
    expect(ownership?.now).toBe('62%');
    // 62 × (100 − 15) / 100, and nothing else.
    expect(ownership?.after).toBe('53%');
    expect(ownership?.tone).toBe('loss');
  });

  it('adds the cheque to the cash and the seat to the board, and names who takes it', () => {
    const rows = termSheetPreview(sheet, { ownStakePct: 62, cashUsd: 18_000_000, boardSeats: 5, partnerName: 'Helena Ward' });
    expect(rows.find((row) => row.key === 'cash')?.after).toBe('$78M');
    expect(rows.find((row) => row.key === 'board')?.after).toContain('6 seats');
    expect(rows.find((row) => row.key === 'board')?.after).toContain('Helena Ward');
  });

  it('says nothing about a seat that is not on the sheet', () => {
    const seatless = { ...sheet, boardSeats: 0 };
    const rows = termSheetPreview(seatless, { ownStakePct: 62, cashUsd: 0, boardSeats: 5, partnerName: 'Helena Ward' });
    expect(rows.find((row) => row.key === 'board')?.after).toBe('5 seats');
  });

  it('offers a counter band of exactly the engine’s width, and judges it both ways', () => {
    const band = counterBand(sheet);
    expect(band.minUsd).toBe(Math.round((sheet.preMoneyUsd * (100 - COUNTER_BAND_PCT)) / 100));
    expect(band.maxUsd).toBe(Math.round((sheet.preMoneyUsd * (100 + COUNTER_BAND_PCT)) / 100));
    expect(band.minSeats).toBe(0);
    expect(band.maxSeats).toBe(2);

    expect(counterInsideBand(sheet, band.maxUsd, 1)).toBe(true);
    expect(counterInsideBand(sheet, band.maxUsd + 1, 1)).toBe(false);
    expect(counterInsideBand(sheet, band.minUsd - 1, 1)).toBe(false);
    expect(counterInsideBand(sheet, sheet.preMoneyUsd, band.maxSeats + 1)).toBe(false);
  });

  it('restates the dilution a countered price actually implies', () => {
    const countered = counteredTermSheet(sheet, 500_000_000, 1);
    expect(countered.preMoneyUsd).toBe(500_000_000);
    // 60 / (500 + 60), whole, which is the obligation's own definition.
    expect(countered.dilutionPct).toBe(11);
    expect(countered.amountUsd).toBe(sheet.amountUsd);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Defences                                                                */
/* -------------------------------------------------------------------------- */

describe('the three defences', () => {
  const live = {
    approachIsPublic: true,
    hasBoard: true,
    boardIsStaggered: false,
    pillAlreadyRaised: false,
    rescuerCount: 2,
  };

  it('offers all three, priced from the contract’s own table', () => {
    const options = defenceOptions(live);
    expect(options.map((option) => option.defence)).toEqual(['poison_pill', 'staggered_board', 'white_knight']);
    for (const option of options) {
      expect(option.blockedReason).toBeNull();
      expect(option.reputationDelta).toBe(TAKEOVER_DEFENCE_REPUTATION_COST[option.defence]);
    }
  });

  it('keeps a defence present and disabled with the reason, never hidden', () => {
    const confidential = defenceOptions({ ...live, approachIsPublic: false });
    expect(confidential).toHaveLength(3);
    for (const option of confidential) expect(option.blockedReason).toBe('The approach is still confidential');

    const staggered = defenceOptions({ ...live, boardIsStaggered: true });
    expect(staggered.find((option) => option.defence === 'staggered_board')?.blockedReason).toBe('The board is already staggered');

    const pilled = defenceOptions({ ...live, pillAlreadyRaised: true });
    expect(pilled.find((option) => option.defence === 'poison_pill')?.blockedReason).toBe('Already raised against this raider');

    const alone = defenceOptions({ ...live, rescuerCount: 0 });
    expect(alone.find((option) => option.defence === 'white_knight')?.blockedReason).toBe('No institution here has the dry powder');

    const boardless = defenceOptions({ ...live, hasBoard: false });
    expect(boardless.find((option) => option.defence === 'poison_pill')?.blockedReason).toBe('No board to table it at');
  });
});

/* -------------------------------------------------------------------------- */
/*  8. World version                                                           */
/* -------------------------------------------------------------------------- */

describe('a world-version-1 session', () => {
  it('has no institutional layer at all', () => {
    expect(worldOneView.economyReport).toBeNull();
    expect(worldOne.capitalEntities).toBeUndefined();
    expect(worldOne.shortPositions).toBeUndefined();
    expect(worldOne.activistCampaigns).toBeUndefined();
  });

  it('renders every one of these surfaces as absent rather than as empty', () => {
    const playerCompanyId = worldOneView.ownCompany.id;
    expect(streetCards(worldOneView.economyReport, EMPTY_STANCE_CONTEXT)).toEqual([]);
    expect(disclosedHolders(worldOneView.economyReport, playerCompanyId)).toEqual([]);
    expect(
      offerInbox({
        deals: worldOneView.deals,
        campaigns: worldOne.activistCampaigns ?? [],
        companyIds: new Set([playerCompanyId]),
        quarter: worldOne.quarter,
      }),
    ).toEqual([]);
  });

  it('draws no institution’s mark on anything in the feed', () => {
    const noRoster: ReadonlySet<string> = new Set<string>();
    for (const disclosure of worldOneView.disclosures) {
      const item = {
        who: { characterId: disclosure.sourceCharacterId, companyId: disclosure.companyId, name: '', isAi: true },
      } as Parameters<typeof isFundVoice>[0];
      expect(isFundVoice(item, noRoster)).toBe(false);
    }
  });
});

describe('a multi-sector session', () => {
  it('carries the whole roster onto the projection the screens read', () => {
    const rows = worldTwoView.economyReport?.capitalEntities ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(row.thesis.length).toBeGreaterThan(0);
      expect(row.partnerCharacterId).not.toBeNull();
    }
  });

  it('marks a partner’s publication as an institution’s voice', () => {
    const partners = new Set(
      (worldTwoView.economyReport?.capitalEntities ?? [])
        .map((row) => row.partnerCharacterId)
        .filter((id): id is string => id !== null),
    );
    expect(partners.size).toBeGreaterThan(0);
    const partnerId = [...partners][0] as string;
    const spoken = { who: { characterId: partnerId, companyId: null, name: '', isAi: true } } as Parameters<typeof isFundVoice>[0];
    const founder = { who: { characterId: 'chr_not_a_partner', companyId: null, name: '', isAi: false } } as Parameters<
      typeof isFundVoice
    >[0];
    expect(isFundVoice(spoken, partners)).toBe(true);
    expect(isFundVoice(founder, partners)).toBe(false);
  });

  it('ranks the institutions on the two boards a player cannot enter', () => {
    const boards = worldTwo.leaderboards.filter(
      (board) => board.board === 'capital_returns' || board.board === 'assets_under_management',
    );
    expect(boards).toHaveLength(2);
    for (const board of boards) {
      expect(board.entries.length).toBeGreaterThan(0);
      for (const entry of board.entries) expect(entry.subjectKind).toBe('fund');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  9. The obligations a desk wrote                                            */
/* -------------------------------------------------------------------------- */

describe('reading a desk’s obligation off a deal', () => {
  const deals: readonly DealProposal[] = worldTwo.deals;

  it('finds a term sheet where there is one, and nothing where there is not', () => {
    const withSheets = deals.filter((deal) => termSheetOf(deal) !== null);
    expect(withSheets.length).toBeGreaterThan(0);
    for (const deal of withSheets) {
      const sheet = termSheetOf(deal);
      expect(sheet?.kind).toBe('term_sheet');
      // The single control dial and the single price dial are both whole.
      expect(Number.isInteger(sheet?.dilutionPct)).toBe(true);
      expect(Number.isInteger(sheet?.boardSeats)).toBe(true);
      expect(buyoutOf(deal)).toBeNull();
    }
  });

  it('reads an approach as an approach, with its premium whole', () => {
    for (const deal of deals) {
      const offer = buyoutOf(deal);
      if (offer === null) continue;
      expect(Number.isInteger(offer.premiumPct)).toBe(true);
      expect(offer.equityChequeUsd).toBeGreaterThanOrEqual(0);
      expect(termSheetOf(deal)).toBeNull();
    }
  });
});

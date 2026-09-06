/**
 * The Market tab: seven cards, four merges, and one answer to "who is coming
 * for me" without a tap.
 *
 * `apps/web` has no jsdom, so the tab is checked the way the Company tab is —
 * the pure cards are rendered to static markup, and the order and the merges
 * are read off the source with the TypeScript file itself as the evidence.
 *
 * The merges each get a test of their own, because each is a *deletion* and a
 * deletion is exactly the kind of change that quietly comes back:
 *
 * - `AcquisitionDesk` is mounted once in the whole app, in the Deal Room.
 * - `TradeTicket` keeps its two mounts and gains no third.
 * - `PositionDrawer` no longer imports the desk, and links to it instead with
 *   the target named.
 *
 * `registerFigures` — the register card's whole reading layer — is exercised
 * against a real world-3 session with a live campaign pushed onto it, so "n to
 * answer" is proved by the same inbox The Street counts and not by a fixture
 * written to agree with the card.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivistCampaign, Company, NewGameSetupInput, SessionState } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession, createWorld3Session } from '@frontier/simulation';
import { answerableCount, offerInbox } from '../street';
import { projectPlayerView } from '../../../lib/game/playerView';
import { TABS } from '../../../lib/nav';
import { LEGACY_ROUTES, firstSegmentOf, sheetHref } from '../../../lib/sheets';
import {
  BoardCard,
  DealsCard,
  FundingCard,
  PortfolioCard,
  RegisterCard,
  StockCard,
  TapeCard,
} from './cards/market-cards';
import { registerFigures, stanceContextFor } from './cards/registerModel';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = readFileSync(`${DIR}MarketTab.tsx`, 'utf8');
const SRC_ROOT = join(process.cwd(), 'src');

const TAB_PATHS = new Set(TABS.map((tab) => tab.href));

function hrefsIn(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&'));
}

/** Naming a screen that is no longer a screen. The five tab paths are not that. */
function isOldRoute(href: string): boolean {
  const segment = firstSegmentOf(href);
  if (TAB_PATHS.has(segment)) return false;
  return Object.prototype.hasOwnProperty.call(LEGACY_ROUTES, segment);
}

/** Every component source under `src`, tests excluded. */
function sources(dir: string = SRC_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(path);
  }
  return out;
}

/** Files whose markup mounts this component, by JSX tag. */
function mountsOf(tag: string): string[] {
  return sources().filter((path) => new RegExp(`<${tag}[\\s/>]`).test(readFileSync(path, 'utf8')));
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

const CARDS = ['StockCard', 'FundingCard', 'RegisterCard', 'TapeCard', 'PortfolioCard', 'DealsCard', 'BoardCard'] as const;

function renderRegister(answerable: number): string {
  return renderToStaticMarkup(
    <RegisterCard
      holders={[
        { entityId: 'fund_a', name: 'Kaido Capital', stakePct: 9 },
        { entityId: 'fund_b', name: 'Ledger Partners', stakePct: 6 },
      ]}
      ownStakePct={0.61}
      shortInterestPct={14}
      shortBadge={{ risk: 'watch', label: 'squeeze territory', tone: 'warn' }}
      liveCampaigns={1}
      dryPowderAimedAtYouUsd={800_000_000}
      answerable={answerable}
      offers={answerable + 1}
    />,
  );
}

function renderPage(answerable: number): string {
  return [
    renderToStaticMarkup(
      <StockCard
        companyName="Player Ventures"
        marketCapUsd={310_000_000}
        lastPriceUsd={18.4}
        lastReturn={0.042}
        ownStakePct={0.61}
        issuedShares={12_000_000}
        instrumentId="ins_pv"
        history={[15, 16, 18.4]}
      />,
    ),
    renderToStaticMarkup(
      <FundingCard
        cashUsd={24_000_000}
        cashMovementUsd={-1_800_000}
        runwayQuarters={13}
        debtUsd={5_000_000}
        interestUsd={120_000}
        listingWindow={0.6}
      />,
    ),
    renderRegister(answerable),
    renderToStaticMarkup(<TapeCard strip={null} sectorLine="6 sectors · 9 listed · $1.2b of quoted value." />),
    renderToStaticMarkup(
      <PortfolioCard netWorthUsd={90_000_000} heldValueUsd={12_000_000} stakes={2} subsidiaries={1} funds={0} line="1 controlled · 2 held" />,
    ),
    renderToStaticMarkup(<DealsCard toAnswer={2} outstanding={1} live={3} lapsing={0} />),
    renderToStaticMarkup(<BoardCard seatsFilled={5} seatsAuthorised={7} mood={22} passThreshold={0.5} mattersTabled={1} />),
  ].join('\n');
}

const page = renderPage(2);

describe('the Market tab is seven cards in the plan’s order', () => {
  it('renders them in that order and mounts each exactly once', () => {
    const positions = CARDS.map((name) => ({ name, at: SOURCE.indexOf(`<${name}`) }));
    for (const entry of positions) expect(entry.at, `${entry.name} is not mounted`).toBeGreaterThan(-1);
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      if (previous === undefined || current === undefined) throw new Error('card list is malformed');
      expect(current.at, `${current.name} must come after ${previous.name}`).toBeGreaterThan(previous.at);
    }
    for (const name of CARDS) expect(SOURCE.split(`<${name}`).length - 1, `${name} is mounted twice`).toBe(1);
  });
});

describe('every address on the Market tab', () => {
  const hrefs = hrefsIn(page);

  it('links somewhere, and never to one of the twenty-two old routes', () => {
    expect(hrefs.length).toBeGreaterThan(4);
    for (const href of hrefs) expect(isOldRoute(href), `${href} is still an old route`).toBe(false);
  });

  it('writes no old route into the tab’s own source', () => {
    for (const route of Object.keys(LEGACY_ROUTES)) {
      if (TAB_PATHS.has(route)) continue;
      expect(SOURCE.includes(`'${route}'`), `${route} is written out in MarketTab.tsx`).toBe(false);
      expect(SOURCE.includes(`"${route}"`), `${route} is written out in MarketTab.tsx`).toBe(false);
    }
  });

  it('opens a listed company’s own instrument, and Capital when it is private', () => {
    expect(hrefs).toContain(sheetHref('exchange', { item: 'ins_pv' }));
    const priv = renderToStaticMarkup(
      <StockCard
        companyName="Player Ventures"
        marketCapUsd={310_000_000}
        lastPriceUsd={null}
        lastReturn={null}
        ownStakePct={1}
        issuedShares={10_000_000}
        instrumentId={null}
        history={[]}
      />,
    );
    expect(hrefsIn(priv)).toContain(sheetHref('capital'));
    expect(priv).toContain('private');
  });
});

/* -------------------------------------------------------------------------- */
/*  The register card                                                          */
/* -------------------------------------------------------------------------- */

describe('the register card', () => {
  it('says "n to answer" when an offer is answerable, and stays quiet when none is', () => {
    expect(renderRegister(2)).toContain('2 to answer');
    expect(renderRegister(0)).not.toContain('to answer');
  });

  it('names the short book’s badge and the money pointed at you', () => {
    expect(page).toContain('squeeze territory');
    expect(page).toContain('Dry powder aimed at you');
  });

  it('says a holder is absent rather than summarising one below the threshold', () => {
    const markup = renderToStaticMarkup(
      <RegisterCard
        holders={[]}
        ownStakePct={1}
        shortInterestPct={null}
        shortBadge={null}
        liveCampaigns={0}
        dryPowderAimedAtYouUsd={0}
        answerable={0}
        offers={0}
      />,
    );
    expect(markup).toContain('No disclosed institutional holder');
  });
});

/* -------------------------------------------------------------------------- */
/*  What the register card is reading                                          */
/* -------------------------------------------------------------------------- */

const MULTI_SECTOR: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

/** `quarters` closed quarters of a session, so the resolver has written a report. */
function resolved(state: SessionState, quarters: number): SessionState {
  const engine = createDefaultEngine();
  let current = state;
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(current, [], null, []);
    expect(outcome.committed).toBe(true);
    current = outcome.nextState;
  }
  return current;
}

function playerOf(state: SessionState): Company {
  return state.companies.find((company) => company.id === 'cmp_player_ventures') ?? (state.companies[0] as Company);
}

function founderIdOf(state: SessionState): string {
  const founder = state.characters.find((character) => character.isPlayer);
  if (founder === undefined) throw new Error('no player character');
  return founder.id;
}

describe('registerFigures counts what The Street counts', () => {
  const base = createWorld3Session();
  const company = playerOf(base);
  const founderId = founderIdOf(base);

  it('agrees with `offerInbox`/`answerableCount` on an untouched world', () => {
    const view = projectPlayerView(base);
    const figures = registerFigures({ session: base, view, companyId: company.id, founderId });
    const inbox = offerInbox({
      deals: view.deals,
      campaigns: base.activistCampaigns ?? [],
      companyIds: new Set([company.id]),
      quarter: base.quarter,
    });
    expect(figures.offers).toBe(inbox.length);
    expect(figures.answerable).toBe(answerableCount(inbox));
  });

  it('turns one live campaign into one answerable offer and one campaign', () => {
    const state = createWorld3Session();
    const target = playerOf(state);
    const campaign: ActivistCampaign = {
      id: 'cam_test',
      entityId: 'fund_kaido',
      targetCompanyId: target.id,
      stage: 'public_letter',
      demands: ['cut_costs'],
      openedQuarter: state.quarter,
      lastEscalatedQuarter: state.quarter,
      stakePct: 15,
      convictionPct: 44,
      seatsGranted: 0,
      outcome: null,
      closedQuarter: null,
    };
    state.activistCampaigns = [...(state.activistCampaigns ?? []), campaign];

    const view = projectPlayerView(state);
    const figures = registerFigures({ session: state, view, companyId: target.id, founderId: founderIdOf(state) });
    expect(figures.liveCampaigns).toBe(1);
    expect(figures.answerable).toBeGreaterThanOrEqual(1);
    expect(figures.offers).toBeGreaterThanOrEqual(1);

    // And the card then says it, in the words the plan asks for.
    const markup = renderToStaticMarkup(
      <RegisterCard
        holders={figures.holders}
        ownStakePct={figures.ownStakePct}
        shortInterestPct={figures.shortInterestPct}
        shortBadge={figures.shortBadge}
        liveCampaigns={figures.liveCampaigns}
        dryPowderAimedAtYouUsd={figures.dryPowderAimedAtYouUsd}
        answerable={figures.answerable}
        offers={figures.offers}
      />,
    );
    expect(markup).toContain(`${figures.answerable} to answer`);
  });

  it('reads the campaigner as aimed at you, which is what the dry powder sums', () => {
    // The institutional layer is written by the resolver, so the report only
    // exists after a quarter has closed — the same reason The Street's own
    // tests replay before they read one.
    const state = resolved(createDemoSession(undefined, MULTI_SECTOR), 2);
    const target = playerOf(state);
    const entities = projectPlayerView(state).economyReport?.capitalEntities ?? [];
    const entity = entities[0];
    if (entity === undefined) throw new Error('two resolved quarters carry no capital entities');

    const quiet = registerFigures({ session: state, view: projectPlayerView(state), companyId: target.id, founderId: founderIdOf(state) });

    state.activistCampaigns = [
      {
        id: 'cam_dry',
        entityId: entity.entityId,
        targetCompanyId: target.id,
        stage: 'public_letter',
        demands: ['cut_costs'],
        openedQuarter: state.quarter,
        lastEscalatedQuarter: state.quarter,
        stakePct: 15,
        convictionPct: 44,
        seatsGranted: 0,
        outcome: null,
        closedQuarter: null,
      },
    ];
    const input = { session: state, view: projectPlayerView(state), companyId: target.id, founderId: founderIdOf(state) };
    expect(stanceContextFor(input).campaignEntityIds.has(entity.entityId)).toBe(true);

    const loud = registerFigures(input);
    expect(loud.liveCampaigns).toBe(1);
    // The campaigner's own dry powder is now counted as pointed at you, and it
    // was not before: the card's warning arrives with the campaign.
    expect(loud.dryPowderAimedAtYouUsd - quiet.dryPowderAimedAtYouUsd).toBe(entity.dryPowderUsd);
  });
});

/* -------------------------------------------------------------------------- */
/*  The merges                                                                 */
/* -------------------------------------------------------------------------- */

describe('one desk, one ticket', () => {
  it('mounts AcquisitionDesk in exactly one place — the Deal Room', () => {
    const mounts = mountsOf('AcquisitionDesk');
    expect(mounts.map((path) => path.split('/').pop())).toEqual(['DealRoomScreen.tsx']);
  });

  it('keeps TradeTicket at its two mounts and grows no third', () => {
    const mounts = mountsOf('TradeTicket').map((path) => path.split('/').pop()).sort();
    expect(mounts).toEqual(['InstrumentDrawer.tsx', 'PositionDrawer.tsx']);
  });

  it('leaves PositionDrawer linking to the one desk with the target named', () => {
    const source = readFileSync(join(SRC_ROOT, 'components/screens/portfolio/PositionDrawer.tsx'), 'utf8');
    // The header comment still names the desk, because *why it is not here* is
    // the interesting fact about this file. What must be gone is the mount and
    // the import that would make a second live copy of the form.
    expect(source).not.toMatch(/<AcquisitionDesk/);
    expect(source).not.toMatch(/import[^\n]*AcquisitionDesk/);
    expect(source).toContain("sheetHref('deals', { target: row.companyId })");
    expect(sheetHref('deals', { target: 'cmp_rival' })).toBe('/market?sheet=deals&target=cmp_rival');
  });

  it('has the Deal Room read that target off the address', () => {
    const source = readFileSync(join(SRC_ROOT, 'components/screens/deal-room/DealRoomScreen.tsx'), 'utf8');
    expect(source).toContain("searchParams?.get('target')");
    expect(source).toMatch(/useState<string \| null>\(target\)/);
  });

  it('has Markets read the instrument, Products the line, and People the fragment', () => {
    const markets = readFileSync(join(SRC_ROOT, 'components/screens/markets/MarketsScreen.tsx'), 'utf8');
    expect(markets).toContain("searchParams?.get('item')");
    const products = readFileSync(join(SRC_ROOT, 'components/screens/products/ProductsScreen.tsx'), 'utf8');
    expect(products).toContain("searchParams?.get('line')");
    expect(products).toContain('<ConnectionsScreen initialLineId={initialLineId} />');
    const people = readFileSync(join(SRC_ROOT, 'components/screens/people/PeopleScreen.tsx'), 'utf8');
    expect(people).toContain("window.location.hash !== '#headcount'");
    expect(people).toContain('id="headcount"');
    // The price control has to be in the first screenful of a line opened by
    // address, which is what the drawer's own focus prop is for.
    const drawer = readFileSync(join(SRC_ROOT, 'components/screens/products/NodeLineDrawer.tsx'), 'utf8');
    expect(drawer).toContain("initialFocus !== 'price'");
    expect(drawer).toContain('data-testid="line-price-section"');
  });
});

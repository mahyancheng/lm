/**
 * The newspaper's rules, checked without a browser.
 *
 * Three kinds of evidence, deliberately:
 *
 * - **Arithmetic** — the layout, the params and the pairing rule — checked on
 *   fixtures parsed by `PublicRecordItemSchema`, so a fixture cannot drift from
 *   the contract the engine projects.
 * - **Writing** — that a post's headline is its own words and a filing's
 *   kicker says what kind of filing it is — checked through the real projection
 *   over a real session with rows injected, then through the real components
 *   rendered to static markup.
 * - **The reload path** — that the ledger a reload rebuilds cites the same rows
 *   a resolve did — checked through `replay` on a save file built from a
 *   resolved quarter, the way the store loads one.
 *
 * Relative imports throughout: the `@/` alias is wired up in vitest.config.mts
 * only so the modules under test can resolve their own imports.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicDisclosure, PublicRecordItem, SessionState, SimEvent, SocialPost } from '@frontier/contracts';
import { NewGameSetupSchema, PublicRecordItemSchema } from '@frontier/contracts';
import { audienceFor, isEventVisibleTo, projectEditionIndex, projectPublicRecord } from '@frontier/simulation';
import { fakeMeasurer } from '../../../lib/text/measure';
import { PLAYER_ID, createSession, getEngine, playerCompanyOf } from '../../../lib/game/engine';
import { replay } from '../../../lib/game/persistence';
import { buildSaveFile } from '../../../lib/game/saveFile';
import { Briefs, leadInOf, showsLeadIn } from './Briefs';
import { FittedHeadline, LEAD_SIZES } from './Headline';
import { LeadStory, openingTextOf, takesDropCap } from './LeadStory';
import { MASTHEAD_HEIGHT_PX, Masthead } from './Masthead';
import { NEWS_CHROME_BUDGET_PX, STRIP_HEIGHT_PX, SectionStrip } from './SectionStrip';
import {
  DEFAULT_NEWS_PARAMS,
  HALF_WIDTH_FALLBACK_CHARS,
  fitsHalf,
  kindsOfSection,
  layoutFrontPage,
  pairForColumns,
  parseNewsParams,
  resolveEdition,
  serialiseNewsParams,
  type TierMeasure,
} from './layout';
import { Kicker, kickerParts, kickerSectorLabel, type NewsContext } from './pieces';
import { LedgerRowList, compactFigures, compactSummary } from '../reporting/LedgerDrawer';
import { FeedItem } from '../feed/FeedItem';
import { newsHref, readNewsSearch, rememberNewsSearch } from '../../../lib/game/deepLink';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let counter = 0;

function makeItem(overrides: Partial<PublicRecordItem> = {}): PublicRecordItem {
  counter += 1;
  const weight = overrides.weight ?? Math.max(0, 0.9 - counter * 0.01);
  return PublicRecordItemSchema.parse({
    id: `itm_${String(counter).padStart(3, '0')}`,
    quarter: 3,
    kind: 'story',
    who: { characterId: 'chr_npc', companyId: 'cmp_rival', name: 'A Rival', isAi: true },
    sectorIds: [],
    companyIds: ['cmp_rival'],
    headline: 'A thing that happened in the world this quarter',
    deck: 'One sentence of engine figures under the headline.',
    body: 'The body, in full. '.repeat(20).trim(),
    kicker: { word: 'Analysis', sector: 'ai', company: 'Rival Systems' },
    tone: 0,
    weight,
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: [],
    whyItMatters: null,
    network: null,
    intent: null,
    reach: null,
    pressPickup: null,
    ...overrides,
  });
}

const CONTEXT: NewsContext = {
  startYear: 2027,
  characters: new Map(),
  companyNames: new Map([['cmp_rival', 'Rival Systems'], ['cmp_me', 'My Company']]),
  multiSector: true,
  playerCharacterId: 'chr_me',
  playerCompanyId: 'cmp_me',
  headlineOf: () => null,
  onOpen: () => {},
};

const SERIF = 'Georgia, serif';
const measurer = fakeMeasurer(0.5);
const TIER: TierMeasure = { measurer, widthPx: 366, gapPx: 14, family: SERIF, weight: 700, sizePx: 19, leading: 1.15, maxPairedLines: 4 };

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

describe('the front page layout', () => {
  it('leads with the heaviest item, tiers the next few, and briefs the rest in engine order', () => {
    const items = Array.from({ length: 9 }, () => makeItem());
    const layout = layoutFrontPage(items, null);
    expect(layout.lead?.id).toBe(items[0]?.id);
    const tiered = layout.secondTier.flat().map((item) => item.id);
    expect(tiered).toEqual(items.slice(1, 5).map((item) => item.id));
    expect(layout.briefs.map((item) => item.id)).toEqual(items.slice(5).map((item) => item.id));
  });

  it('keeps a reply out of the second tier: it belongs under the post it answers', () => {
    const post = makeItem({ kind: 'post', network: 'fast_feed', intent: 'announce', reach: 10, pressPickup: false, deck: null });
    const reply = makeItem({
      kind: 'reply',
      network: 'fast_feed',
      intent: 'defend',
      reach: 5,
      pressPickup: false,
      deck: null,
      links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: post.id },
    });
    const items = [makeItem(), reply, post, makeItem(), makeItem()];
    const layout = layoutFrontPage(items, null);
    expect(layout.secondTier.flat().some((item) => item.id === reply.id)).toBe(false);
    expect(layout.briefs.some((item) => item.id === reply.id)).toBe(true);
  });

  it('has no second tier with fewer than two candidates — they read as briefs', () => {
    const items = [makeItem(), makeItem()];
    const layout = layoutFrontPage(items, null);
    expect(layout.secondTier).toEqual([]);
    expect(layout.briefs.map((item) => item.id)).toEqual([items[1]?.id]);
    expect(layoutFrontPage([], null)).toEqual({ lead: null, secondTier: [], briefs: [] });
  });

  it('pairs two short headlines side by side and stacks a long one, by measurement', () => {
    const short = makeItem({ headline: 'Exports restricted' });
    const alsoShort = makeItem({ headline: 'Orbit guides lower' });
    // Eighty-seven characters: five lines of 19px type in a 176px column, one over the budget.
    const long = makeItem({ headline: 'A very long headline that needs more than four lines in a column half a phone wide' });
    expect(fitsHalf(short, TIER)).toBe(true);
    expect(fitsHalf(long, TIER)).toBe(false);
    expect(pairForColumns([short, alsoShort, long], TIER).map((row) => row.length)).toEqual([2, 1]);
    expect(pairForColumns([long, short, alsoShort], TIER).map((row) => row.length)).toEqual([1, 2]);
  });

  it('pairs by headline length when nothing can be measured', () => {
    const short = makeItem({ headline: 'x'.repeat(HALF_WIDTH_FALLBACK_CHARS) });
    const long = makeItem({ headline: 'x'.repeat(HALF_WIDTH_FALLBACK_CHARS + 1) });
    expect(fitsHalf(short, null)).toBe(true);
    expect(fitsHalf(long, null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Sections and params                                                       */
/* -------------------------------------------------------------------------- */

describe('sections in the URL', () => {
  it('round-trips through the query string and omits defaults', () => {
    expect(serialiseNewsParams(DEFAULT_NEWS_PARAMS)).toBe('');
    const street = serialiseNewsParams({ ...DEFAULT_NEWS_PARAMS, section: 'street', mine: true });
    expect(street).toBe('?section=street&mine=1');
    expect(parseNewsParams(street)).toEqual({ ...DEFAULT_NEWS_PARAMS, section: 'street', mine: true });
    const narrowed = serialiseNewsParams({ section: 'markets', mine: false, sector: 'energy', companyId: 'cmp_grid', edition: 7 });
    expect(parseNewsParams(narrowed)).toEqual({ section: 'markets', mine: false, sector: 'energy', companyId: 'cmp_grid', edition: 7 });
  });

  it('falls back to the front page on anything malformed', () => {
    expect(parseNewsParams('?section=gossip&mine=yes&sector=space&edition=-2')).toEqual(DEFAULT_NEWS_PARAMS);
    expect(parseNewsParams(null)).toEqual(DEFAULT_NEWS_PARAMS);
  });

  it('keeps each kind in one section and every kind on the front page', () => {
    expect(kindsOfSection('front')).toBeNull();
    expect(kindsOfSection('markets')).toEqual(['disclosure']);
    expect(kindsOfSection('press')).toEqual(['story']);
    expect(kindsOfSection('street')).toEqual(['post', 'reply']);
    expect(kindsOfSection('world')).toEqual(['event']);
  });

  it('opens the requested edition when the record has it, else the newest', () => {
    expect(resolveEdition(null, [0, 1, 2])).toBe(2);
    expect(resolveEdition(1, [0, 1, 2])).toBe(1);
    expect(resolveEdition(9, [0, 1, 2])).toBe(2);
    expect(resolveEdition(null, [])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  The URL hook                                                                */
/* -------------------------------------------------------------------------- */

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('section=street&mine=1'),
  usePathname: () => '/news',
  useRouter: () => ({ replace }),
}));

describe('useNewsParams', () => {
  afterEach(() => replace.mockClear());

  it('reads the section off the URL and writes a change back with replace', async () => {
    const { useNewsParams } = await import('./useNewsParams');
    let captured: ReturnType<typeof useNewsParams> | null = null;
    function Probe(): null {
      captured = useNewsParams();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(captured).not.toBeNull();
    const [params, setParams] = captured as unknown as ReturnType<typeof useNewsParams>;
    expect(params.section).toBe('street');
    expect(params.mine).toBe(true);
    setParams({ mine: false });
    expect(replace).toHaveBeenCalledWith('/news?section=street', { scroll: false });
    setParams({ section: 'world' });
    expect(replace).toHaveBeenCalledWith('/news?section=world&mine=1', { scroll: false });
  });
});

/* -------------------------------------------------------------------------- */
/*  Above the fold                                                             */
/* -------------------------------------------------------------------------- */

describe('the chrome budget', () => {
  it('keeps masthead and strip under 120px so the lead is on a 390×844 screen', () => {
    expect(MASTHEAD_HEIGHT_PX + STRIP_HEIGHT_PX).toBeLessThan(NEWS_CHROME_BUDGET_PX);
    // The shell's fixed chrome on a phone: status bar 56 + sub-tab strip 46.
    const shellChrome = 56 + 46;
    const leadKickerTop = shellChrome + MASTHEAD_HEIGHT_PX + STRIP_HEIGHT_PX;
    // Kicker (14px) + gap + three lines of 30px display type at 1.08 leading.
    const leadHeadlineBottom = leadKickerTop + 12 + 14 + 8 + 3 * Math.round(30 * 1.08);
    expect(leadHeadlineBottom).toBeLessThan(844);
  });

  it('renders the masthead and strip at their declared heights', () => {
    const masthead = renderToStaticMarkup(<Masthead startYear={2027} edition={10} narrative="bubble_concern" controversy={0.66} />);
    expect(masthead).toContain(`height:${MASTHEAD_HEIGHT_PX}px`);
    expect(masthead).toContain('The Frontier Ledger');
    expect(masthead).toContain('2029 Q3');
    expect(masthead).toContain('Edition 11');
    expect(masthead).toContain('Bubble concern');
    expect(masthead).toContain('Hot');
    // No H1 "News", no eyebrow pill: the nameplate is the only heading.
    expect(masthead.match(/<h1/g)?.length).toBe(1);
    expect(masthead).not.toContain('>News<');
    const strip = renderToStaticMarkup(
      <SectionStrip section="front" onSection={() => {}} mine={false} onMine={() => {}} filterCount={0} onFilter={() => {}} filterable />,
    );
    expect(strip).toContain(`height:${STRIP_HEIGHT_PX}px`);
    expect(strip).toContain('aria-selected="true"');
    expect(strip.match(/role="tab"/g)?.length).toBe(5);
  });

  it('puts the lead headline before any brief in document order', () => {
    // Lead, four in the tier, then the briefs — the sixth item is the first brief.
    const items = [makeItem({ headline: 'The lead headline' }), makeItem(), makeItem(), makeItem(), makeItem(), makeItem({ headline: 'A brief headline' }), makeItem()];
    const layout = layoutFrontPage(items, TIER);
    const markup = renderToStaticMarkup(
      <>
        <LeadStory item={layout.lead as PublicRecordItem} context={CONTEXT} widthPx={366} measurer={measurer} serif={SERIF} />
        <Briefs items={layout.briefs} context={CONTEXT} />
      </>,
    );
    expect(markup.indexOf('The lead headline')).toBeGreaterThan(-1);
    expect(markup.indexOf('The lead headline')).toBeLessThan(markup.indexOf('A brief headline'));
    // The lead prints its opening paragraph with a drop cap and a continuation.
    expect(markup).toContain('np-dropcap');
    expect(markup).toContain('Continued');
  });
});

/* -------------------------------------------------------------------------- */
/*  SSR                                                                        */
/* -------------------------------------------------------------------------- */

describe('the server render', () => {
  it('sets a headline without a canvas, at the largest size across the full width', () => {
    const markup = renderToStaticMarkup(
      <FittedHeadline text="Advanced accelerator exports restricted" sizes={LEAD_SIZES} maxLines={3} widthPx={366} measurer={null} serif={SERIF} />,
    );
    expect(markup).toContain('Advanced accelerator exports restricted');
    expect(markup).toContain(`font-size:${LEAD_SIZES[0]}px`);
    expect(markup).not.toContain('max-width');
    expect(markup).toContain('np-headline');
  });

  it('narrows the block to the balanced width once it can measure', () => {
    const markup = renderToStaticMarkup(
      <FittedHeadline text="aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii" sizes={[20]} maxLines={3} widthPx={366} measurer={measurer} serif={SERIF} />,
    );
    expect(markup).toMatch(/max-width:\d+px/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Writing, through the real projection                                       */
/* -------------------------------------------------------------------------- */

const W3_SETUP = NewGameSetupSchema.parse({
  companyName: 'Northwind AI',
  founderName: 'Rae Fontaine',
  backgroundId: 'consumer_ai',
  worldVersion: 3,
});

function withRows(): { session: SessionState; postId: string } {
  const session = createSession({ seed: 7, setup: W3_SETUP });
  const company = playerCompanyOf(session);
  const rival = session.companies.find((entry) => entry.id !== company.id && entry.isActive);
  if (rival === undefined) throw new Error('no rival');
  const author = session.characters.find((entry) => entry.companyId === rival.id) ?? session.characters.find((entry) => !entry.isPlayer);
  if (author === undefined) throw new Error('no author');

  const post: SocialPost = {
    id: 'pst_test_1',
    authorCharacterId: author.id,
    accountId: 'acc_missing',
    network: 'fast_feed',
    text: 'Harbourline is quietly repricing every enterprise seat. Ask them what changed, and when.',
    intent: 'attack',
    targetCompanyId: company.id,
    quarter: 0,
    engagement: {
      postId: 'pst_test_1',
      quarter: 0,
      reach: 250_000,
      engagementScore: 0.4,
      sentimentShifts: [],
      pressPickup: true,
      viralityFactor: 1,
      competitorHostilityDelta: 4,
    },
    isAiGenerated: true,
    reportedCount: 0,
    replyToPostId: null,
  };
  const filing = (kind: PublicDisclosure['kind'], id: string): PublicDisclosure => ({
    id,
    companyId: rival.id,
    quarter: 0,
    kind,
    headline: `${rival.name} guides to a wider loss as it re-platforms`,
    body: 'The company now expects a wider full-year loss.',
    metrics: {},
    credibility: 0.7,
    sourceCharacterId: null,
    isTruthful: true,
    beliefTopic: null,
  });
  return {
    session: {
      ...session,
      socialPosts: [...session.socialPosts, post],
      disclosures: [...session.disclosures, filing('press_release', 'dsc_release'), filing('rumour', 'dsc_rumour'), filing('leak', 'dsc_leak')],
    },
    postId: post.id,
  };
}

describe('what the paper prints', () => {
  it('gives a post its own first sentence as the headline, never a byline restated', () => {
    const { session, postId } = withRows();
    const record = projectPublicRecord(session, PLAYER_ID);
    const post = record.find((item) => item.id === postId);
    expect(post).toBeDefined();
    expect(post?.headline).toBe('Harbourline is quietly repricing every enterprise seat');
    expect(post?.headline).not.toMatch(/posted on|fast feed/i);
    expect(post?.deck).toBeNull();
    expect(post?.pressPickup).toBe(true);

    const markup = renderToStaticMarkup(<Briefs items={[post as PublicRecordItem]} context={{ ...CONTEXT, playerCompanyId: 'nobody' }} />);
    expect(markup).toContain('Harbourline is quietly repricing every enterprise seat');
    expect(markup).not.toContain('posted on');
  });

  it('sets the disclosure kind as the kicker word: press release, rumour and leak read differently', () => {
    const { session } = withRows();
    const record = projectPublicRecord(session, PLAYER_ID);
    const words = ['dsc_release', 'dsc_rumour', 'dsc_leak'].map((id) => record.find((item) => item.id === id)?.kicker.word);
    expect(words).toEqual(['Press release', 'Rumour', 'Leak']);
    const context = { ...CONTEXT, multiSector: false };
    const rendered = ['dsc_release', 'dsc_rumour', 'dsc_leak'].map((id) =>
      renderToStaticMarkup(<Kicker item={record.find((item) => item.id === id) as PublicRecordItem} context={context} />),
    );
    expect(rendered[0]).toContain('Press release');
    expect(rendered[1]).toContain('Rumour');
    expect(rendered[2]).toContain('Leak');
    expect(new Set(rendered).size).toBe(3);
  });

  it('does not print a post\'s first sentence twice: the opening paragraph starts after the headline', () => {
    const post = { kind: 'post' as const, headline: 'Orbit sells speed because it has nothing else', body: 'Orbit sells speed because it has nothing else. Ask them what their model scores.' };
    expect(openingTextOf(post)).toBe('Ask them what their model scores.');
    // A one-sentence post has nothing left to print under its headline.
    expect(openingTextOf({ ...post, body: 'Orbit sells speed because it has nothing else.' })).toBe('');
    // A headline cut mid-sentence lets the body run from the start, whole.
    expect(openingTextOf({ ...post, headline: 'Orbit sells speed because…' })).toBe(post.body);
    // Every other kind prints its body from the start.
    expect(openingTextOf({ kind: 'story', headline: 'Anything', body: 'Anything. And more.' })).toBe('Anything. And more.');
  });

  it('marks the reader\'s own line with "You" and leads a brief in with the company', () => {
    const mine = makeItem({ who: { characterId: 'chr_me', companyId: 'cmp_me', name: 'Me', isAi: false }, kicker: { word: 'Press release', sector: 'ai', company: 'My Company' } });
    const theirs = makeItem({ kicker: { word: 'Rumour', sector: null, company: null } });
    expect(kickerParts(mine, CONTEXT)[0]).toBe('You');
    expect(kickerParts(theirs, { ...CONTEXT, multiSector: false })).toEqual(['Rumour']);
    expect(leadInOf(mine, CONTEXT)).toBe('You');
    expect(leadInOf(theirs, CONTEXT)).toBe('Rumour');
    expect(leadInOf(makeItem(), CONTEXT)).toBe('Rival Systems');
    // A headline that opens with its own lead-in is not led in twice.
    const selfNamed = makeItem({ headline: 'Rival Systems has this wrong', kicker: { word: 'Rebuttal', sector: 'ai', company: 'Rival Systems' } });
    const twice = renderToStaticMarkup(<Briefs items={[selfNamed]} context={CONTEXT} />);
    expect(twice.match(/Rival Systems/g)?.length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The reload                                                                  */
/* -------------------------------------------------------------------------- */

describe('sources after a reload', () => {
  it('cites ledger rows rebuilt by the replay, not held over from the resolve', () => {
    const opening = createSession({ seed: 11, setup: W3_SETUP });
    const outcome = getEngine().resolver.resolveQuarter(opening, [], null, []);
    expect(outcome.committed).toBe(true);

    // The save the store would have written: the one recorded quarter and the
    // session as it stands after it. No ledger is in the file.
    const file = buildSaveFile({
      seed: 11,
      difficulty: 'standard',
      autoExecuteRoutine: false,
      setup: W3_SETUP,
      log: [{ quarter: 0, actions: [], gmProposal: null, npcBundles: [], socialTexts: [] }],
      queue: [],
      session: outcome.nextState,
      now: () => '2030-01-02T03:04:05.000Z',
    });
    expect(JSON.stringify(file)).not.toContain('stateHashBefore');

    // What the store does on load: replay, then project the rows to the seat.
    const loaded = replay(file);
    expect(loaded.complete).toBe(true);
    expect(loaded.ledger.length).toBeGreaterThan(0);
    expect(loaded.ledger.map((row) => row.eventId)).toEqual(outcome.events.map((row) => row.eventId));
    const audience = audienceFor(loaded.session, PLAYER_ID);
    const ledger = loaded.ledger.filter((row) => isEventVisibleTo(row, loaded.session, audience));
    expect(ledger.length).toBeGreaterThan(0);

    const edition = projectEditionIndex(loaded.session, PLAYER_ID)[0]?.quarter ?? null;
    expect(edition).not.toBeNull();
    const items = projectPublicRecord(loaded.session, PLAYER_ID, { ledger, sinceQuarter: edition ?? 0, limit: Number.POSITIVE_INFINITY });
    expect(items.length).toBeGreaterThan(0);
    const cited = items.filter((item) => item.ledgerEventIds.length > 0);
    expect(cited.length).toBeGreaterThan(0);
    // And the same rows a live resolve cites.
    const live = projectPublicRecord(outcome.nextState, PLAYER_ID, {
      ledger: outcome.events.filter((row) => isEventVisibleTo(row, outcome.nextState, audienceFor(outcome.nextState, PLAYER_ID))),
      sinceQuarter: edition ?? 0,
      limit: Number.POSITIVE_INFINITY,
    });
    expect(items.map((item) => [item.id, item.ledgerEventIds])).toEqual(live.map((item) => [item.id, item.ledgerEventIds]));
  });
});

/* -------------------------------------------------------------------------- */
/*  Who is speaking, in a brief                                                 */
/* -------------------------------------------------------------------------- */

describe('a brief leads in with the speaker', () => {
  const post = (overrides: Partial<PublicRecordItem> = {}): PublicRecordItem =>
    makeItem({
      kind: 'post',
      network: 'fast_feed',
      intent: 'hype',
      reach: 12_000,
      pressPickup: false,
      deck: null,
      who: { characterId: 'chr_jun', companyId: 'cmp_rival', name: 'Jun Park', isAi: true },
      kicker: { word: 'Promotion', sector: 'logistics', company: 'Rival Systems' },
      ...overrides,
    });

  it('names the person for a post, so a first-person line is not a corporate statement', () => {
    const line = post({ headline: '14% down and I have never been more certain about Rival Systems' });
    expect(leadInOf(line, CONTEXT)).toBe('Jun Park');
    const markup = renderToStaticMarkup(<Briefs items={[line]} context={CONTEXT} />);
    expect(markup).toContain('Jun Park');
    // The company is named once — in the headline — not led in a second time.
    expect(markup.match(/Rival Systems/g)?.length).toBe(1);
    expect(markup.indexOf('Jun Park')).toBeLessThan(markup.indexOf('14% down'));
  });

  it('drops the lead-in when the headline already names the speaker anywhere in it', () => {
    const named = post({ headline: 'Analysts say Jun Park is talking up Rival Systems' });
    expect(showsLeadIn(named, leadInOf(named, CONTEXT), false)).toBe(false);
    const markup = renderToStaticMarkup(<Briefs items={[named]} context={CONTEXT} />);
    expect(markup.match(/Jun Park/g)?.length).toBe(1);
    // A story still leads in with the company, and hides it when the headline carries it mid-line.
    const story = makeItem({ headline: 'Pressure builds on Rival Systems after a missed quarter' });
    expect(leadInOf(story, CONTEXT)).toBe('Rival Systems');
    expect(showsLeadIn(story, 'Rival Systems', false)).toBe(false);
    // The reader's own line always carries "You".
    expect(showsLeadIn(post({ who: { characterId: 'chr_me', companyId: 'cmp_me', name: 'Me', isAi: false }, headline: 'You will see' }), 'You', true)).toBe(true);
  });

  it('spells the AI sector out in a kicker, so it never reads as the AI pill', () => {
    expect(kickerSectorLabel('ai')).toBe('AI models');
    expect(kickerSectorLabel('energy')).toBe('Energy');
    expect(kickerParts(makeItem({ kicker: { word: 'Earnings', sector: 'ai', company: 'Aletheia Labs' } }), CONTEXT)).toEqual(['AI models', 'Aletheia Labs', 'Earnings']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Where the paper was open                                                    */
/* -------------------------------------------------------------------------- */

describe('the remembered section', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  it('carries the section and Mine — but not an edition — onto the shell\'s News links, and forgets the front page', () => {
    vi.stubGlobal('sessionStorage', fakeStorage);
    try {
      rememberNewsSearch('section=street&mine=1&edition=4');
      expect(readNewsSearch()).toBe('section=street&mine=1');
      expect(newsHref('/news', readNewsSearch())).toBe('/news?section=street&mine=1');
      // Other screens are untouched.
      expect(newsHref('/social', readNewsSearch())).toBe('/social');
      // Back on the plain front page, the memory clears and the link is plain again.
      rememberNewsSearch('');
      expect(readNewsSearch()).toBe('');
      expect(newsHref('/news', readNewsSearch())).toBe('/news');
      // A leading question mark is tolerated.
      rememberNewsSearch('?section=world');
      expect(readNewsSearch()).toBe('section=world');
    } finally {
      vi.unstubAllGlobals();
      store.clear();
    }
  });

  it('is harmless without storage', () => {
    vi.stubGlobal('sessionStorage', undefined);
    try {
      expect(() => rememberNewsSearch('section=street')).not.toThrow();
      expect(readNewsSearch()).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Sources, named                                                              */
/* -------------------------------------------------------------------------- */

describe('a Sources row', () => {
  const row: SimEvent = {
    eventId: 'evt_1808',
    sessionId: 'sess_x',
    sequence: 1808,
    quarter: 2,
    type: 'rumour_spread',
    actorId: 'chr_bill',
    targetId: 'cmp_harbourline',
    payload: {
      disclosureId: 'dsc_sess_x_2_pst_bill_1',
      postId: 'pst_bill_1',
      kind: 'rumour',
      beliefTopic: 'margin_pressure',
      credibility: 0.1333,
      reach: 182_479,
      anonymous: false,
      metrics: { revenue: 2_388_974_800, grossMargin: 0.699 },
    },
    visibility: 'public',
    stateHashBefore: 'cb657a92e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    stateHashAfter: '1b09fc374eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: '2030-01-02T03:04:05.000Z',
  } as unknown as SimEvent;
  const names = new Map([
    ['chr_bill', 'Bill Hargrove'],
    ['cmp_harbourline', 'Harbourline Freight'],
    ['pst_bill_1', 'Overland Transit Group is not going to pretend this did not happen'],
  ]);
  const resolve = (id: string): string | null => names.get(id) ?? null;

  it('prints names and figures, never an id, a hash or a machine token', () => {
    expect(compactSummary(row, resolve)).toBe('Rumour · Bill Hargrove · Harbourline Freight');
    const figures = compactFigures(row, resolve);
    expect(figures).toContain('Belief topic margin pressure');
    expect(figures).toContain('Credibility 13%');
    expect(figures).toContain('Reach 182k');
    expect(figures).toContain('Revenue $2B');
    expect(figures).toContain('Gross margin 70%');
    expect(figures).toContain('Post Overland Transit Group is not going to pretend this did not happen');
    // The disclosure id names nothing the resolver knows, so it is dropped rather than printed.
    expect(figures.join(' ')).not.toMatch(/dsc_|pst_|cmp_|chr_/);
    // A label never says "id": "Source posts", not "Source post ids".
    const storyRow = { ...row, payload: { storyId: 'sty_1', headline: 'Lumen Household defends itself', sourcePostIds: ['pst_bill_1'], sourceEventId: null } } as unknown as SimEvent;
    const storyFigures = compactFigures(storyRow, (id) => (id === 'sty_1' ? 'Lumen Household defends itself' : resolve(id)));
    expect(storyFigures).toContain('Source posts Overland Transit Group is not going to pretend this did not happen');
    expect(storyFigures.join(' ')).not.toMatch(/\bids?\b/i);
    // One value is never printed under two labels: the story id names its own headline.
    expect(storyFigures.filter((figure) => figure.endsWith('Lumen Household defends itself'))).toEqual(['Story Lumen Household defends itself']);
    const markup = renderToStaticMarkup(<LedgerRowList events={[row]} compact resolveName={resolve} onOpen={() => {}} />);
    expect(markup).toContain('Bill Hargrove');
    expect(markup).not.toMatch(/cmp_|chr_|dsc_|pst_|margin_pressure|cb657a92e1/);
    // Each row is a button that leads to the full row.
    expect(markup).toContain('<button');
    expect(markup).toContain('aria-label="Open ledger row 1808"');
  });

  it('keeps the full audit rendering for the reporting screens unchanged in shape', () => {
    const markup = renderToStaticMarkup(<LedgerRowList events={[row]} />);
    expect(markup).toContain('#1808');
    expect(markup).toContain('cb657a92e1');
    expect(markup).toContain('cmp_harbourline');
  });
});

/* -------------------------------------------------------------------------- */
/*  One utterance, one card                                                     */
/* -------------------------------------------------------------------------- */

describe('a post the market heard', () => {
  it('carries how it was heard on the Social card instead of a second card', () => {
    const heard = makeItem({
      kind: 'post',
      network: 'fast_feed',
      intent: 'attack',
      reach: 182_479,
      pressPickup: false,
      deck: null,
      headline: 'Overland Transit Group is not going to pretend this did not happen',
      body: 'Overland Transit Group is not going to pretend this did not happen. They went after us in public on fast feed.',
      heard: { kind: 'rumour', credibility: 0.1333 },
    });
    expect(heard.heard).toEqual({ kind: 'rumour', credibility: 0.1333 });
    // A fixture without the field parses to null: the contract defaults it.
    expect(makeItem().heard).toBeNull();
    const markup = renderToStaticMarkup(
      <FeedItem
        item={heard}
        context={{
          startYear: 2027,
          characters: new Map(),
          companyNames: CONTEXT.companyNames,
          companySectors: new Map(),
          multiSector: false,
          playerCharacterId: 'chr_me',
          playerCompanyId: 'cmp_me',
          headlines: new Map(),
          mappedEventIds: new Set(),
        }}
      />,
    );
    expect(markup).toContain('Heard as rumour · 13%');
  });
});

/* -------------------------------------------------------------------------- */
/*  The drop cap                                                                */
/* -------------------------------------------------------------------------- */

describe('the lead\'s drop cap', () => {
  it('is set on a letter and never on a numeral, a quotation mark or a figure', () => {
    expect(takesDropCap('The market heard it.')).toBe(true);
    expect(takesDropCap('Ärger in the boardroom.')).toBe(true);
    expect(takesDropCap('14% down and I have never been more certain.')).toBe(false);
    expect(takesDropCap('"We won," she said.')).toBe(false);
    expect(takesDropCap('$9M of the round is spoken for.')).toBe(false);
    const numeral = makeItem({ body: '14% down and I have never been more certain about Rival Systems. Our attention is on retention and margin.' });
    const markup = renderToStaticMarkup(<LeadStory item={numeral} context={CONTEXT} widthPx={366} measurer={fakeMeasurer()} serif="Georgia" />);
    expect(markup).toContain('data-testid="lead-opening"');
    expect(markup).not.toContain('np-dropcap');
    const letter = makeItem({ body: 'Down fourteen percent, and never more certain about Rival Systems. Our attention is on retention and margin.' });
    expect(renderToStaticMarkup(<LeadStory item={letter} context={CONTEXT} widthPx={366} measurer={fakeMeasurer()} serif="Georgia" />)).toContain('np-dropcap');
  });
});

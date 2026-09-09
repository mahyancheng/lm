/**
 * The five tabs, driven on a phone — a plain Node + Playwright script in the
 * shape of `news-paper.js` and `connections.js` (same method notes: DOM
 * locators and `.count()` rather than `body.innerText()`, the app's own links
 * rather than `page.goto()` once the game is running, any `pageerror` fails
 * the run).
 *
 * The game is now five scrolling pages of cards — Home · Company · Market ·
 * World · Play — with every drill-down a sheet addressed by `?sheet=` over the
 * tab that owns it. This drive measures the claims that shape makes:
 *
 *   1. each of the five bottom-bar tabs: the URL it lands on, that the page
 *      never scrolls sideways, and that every bar target clears 44 × 44;
 *   2. the four tap paths the simplification exists to shorten, counting every
 *      click made after landing on Home — end a quarter (≤ 3 + the typed word),
 *      raise a price (≤ 3 + a slider drag), hire (≤ 3 + a slider), and "who is
 *      attacking me" (≤ 2);
 *   3. a sheet opened in-app, then the browser's own Back: `?sheet` is gone and
 *      the tab is on screen — the sheet was pushed, so Back closes it;
 *   4. the old addresses: `/markets` → `/market?sheet=exchange`,
 *      `/news?section=world` → `/world?sheet=news&section=world` with the map
 *      section drawn, and an address nobody knows → a 404;
 *   5. the status bar's quarter-and-cash block is a link to the desk — the
 *      always-visible way to advance time, at no new pixels;
 *   6. the Chief of Staff dock opens on every tab and says what it is being
 *      asked about;
 *   7. the Products sheet's four stat cards and its Lines table, above and
 *      below the picture;
 *   8. what the browser actually downloads for `/home`, encoded — the figure
 *      the bundle budget is written against.
 *
 * Everything runs at both 390 × 844 and 360 × 780, each viewport in its own
 * browser context with its own founded game, so no measurement inherits the
 * other's state.
 *
 * Usage (server started per e2e/README.md):
 *   BASE_URL=http://localhost:3100 node apps/web/e2e/five-tabs.js
 * Optional: OUT_DIR (default apps/web/e2e/shots/five-tabs), VIEWPORTS
 * ("390x844,360x780"), BACKGROUND ("Enterprise AI").
 */

process.env.NODE_PATH = process.env.NODE_PATH ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules` : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'shots', 'five-tabs');
const BACKGROUND = process.env.BACKGROUND || 'Enterprise AI';
const VIEWPORTS = (process.env.VIEWPORTS || '390x844,360x780').split(',').map((entry) => {
  const [w, h] = entry.split('x').map(Number);
  return { width: w, height: h };
});

/** The phone's minimum comfortable target: every bottom-bar tab owes it. */
const MIN_TAP_PX = 44;
/** The five tabs, in bar order, with the path each must land on. */
const TABS = [
  { label: 'Home', path: '/home' },
  { label: 'Company', path: '/company' },
  { label: 'Market', path: '/market' },
  { label: 'World', path: '/world' },
  { label: 'Play', path: '/play' },
];
/** What the plan allows each tap path. The drive fails if a path costs more. */
const TAP_BUDGET = { endQuarter: 3, raisePrice: 3, hire: 3, whoIsAttacking: 2 };

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = { baseUrl: BASE_URL, background: BACKGROUND, bundle: null, viewports: [], failures: [] };
const failures = [];

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}
function check(ok, message) {
  if (!ok) failures.push(message);
  log(ok ? 'PASS' : 'FAIL', message);
}
async function shot(page, name, fullPage = false) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return path.resolve(file);
}
/** The page's own horizontal overflow, read off `document.scrollingElement`. */
async function pageScroll(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}
function pathOf(url) {
  const parsed = new URL(url);
  return parsed.pathname;
}
function searchOf(url) {
  return new URL(url).search;
}

/* -------------------------------------------------------------------------- */
/*  Taps                                                                       */
/*                                                                             */
/*  Every click the drive makes goes through `tap`, which counts it against the */
/*  path currently being measured. A helper that clicks without counting would  */
/*  make the four figures in `results.json` a fiction, so there is not one.     */
/* -------------------------------------------------------------------------- */

let counter = null;
function startCounting() {
  counter = 0;
}
function taps() {
  return counter;
}
async function tap(locator, what) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.click();
  if (counter !== null) counter += 1;
  log('  tap', counter === null ? '-' : counter, what);
}

/* -------------------------------------------------------------------------- */
/*  Starting a game                                                            */
/* -------------------------------------------------------------------------- */

/** The setup chat: three chip grids, then the two names, then Found. */
async function foundCompany(page, companyName) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  for (let step = 0; step < 3; step++) {
    const chips = page.locator('ul.grid > li > button');
    await chips.first().waitFor({ state: 'visible', timeout: 20000 });
    const wanted = page.locator('ul.grid > li > button', { hasText: BACKGROUND });
    if ((await wanted.count()) > 0) await wanted.first().click();
    else await chips.first().click();
    await page.waitForTimeout(250);
  }
  await page.fill('#setup-name-field', companyName);
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(200);
  await page.fill('#setup-name-field', 'Reader Tester');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(200);
  const foundBtn = page.locator('button:has-text("Found ")');
  await foundBtn.waitFor({ state: 'visible', timeout: 20000 });
  await foundBtn.click();
  await page.waitForURL('**/home', { timeout: 30000 });
  await page.waitForTimeout(600);
  log('founded', companyName, '→', page.url());
}

function tabLink(page, label) {
  return page.locator('nav[aria-label="Sections"] a', { hasText: new RegExp(`^${label}\\d*$`) }).first();
}

/** Escape closes a drawer; a sheet left open covers the tab bar underneath it. */
async function closeSheets(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await page.locator('[role="dialog"]').count()) === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

/** Back to Home without counting: every tap path is measured from there. */
async function goHome(page) {
  await closeSheets(page);
  await tabLink(page, 'Home').click();
  await page.waitForURL('**/home', { timeout: 15000 });
  await page.waitForTimeout(350);
}

/** What the Play tab's badge says, as a number. Zero when there is no badge. */
async function queueBadge(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll('nav[aria-label="Sections"] a')];
    const play = anchors[anchors.length - 1];
    if (!play) return -1;
    const badge = play.querySelector('span.figure');
    return badge === null ? 0 : Number(badge.textContent.trim());
  });
}

/** The sheet drawer whose header carries this title, ignoring inner drawers. */
function sheetByTitle(page, title) {
  return page.locator('[role="dialog"]').filter({ has: page.locator('h2', { hasText: title }) });
}

/* -------------------------------------------------------------------------- */
/*  1. The five tabs                                                           */
/* -------------------------------------------------------------------------- */

async function driveTabs(page, tag, out) {
  for (const entry of TABS) {
    await tap(tabLink(page, entry.label), `tab ${entry.label}`);
    await page.waitForURL(`**${entry.path}`, { timeout: 15000 });
    await page.waitForTimeout(450);
    check(pathOf(page.url()) === entry.path, `${tag} · ${entry.label} lands on ${entry.path} (${pathOf(page.url())})`);

    const scroll = await pageScroll(page);
    check(
      scroll.scrollWidth <= scroll.clientWidth + 1,
      `${tag} · ${entry.label} does not scroll sideways (${scroll.scrollWidth} ≤ ${scroll.clientWidth})`,
    );

    const boxes = await page.locator('nav[aria-label="Sections"] a').evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return { label: el.textContent.trim(), width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    );
    check(boxes.length === 5, `${tag} · the bar carries exactly five tabs (${boxes.length})`);
    const small = boxes.filter((box) => box.width < MIN_TAP_PX || box.height < MIN_TAP_PX);
    check(small.length === 0, `${tag} · every bar target clears ${MIN_TAP_PX}×${MIN_TAP_PX} (${JSON.stringify(small)})`);

    // The page's own height, for the record: Home is the one with a stated bar.
    const scrollHeight = await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollHeight);
    out.tabs.push({
      tab: entry.label,
      url: page.url(),
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      scrollHeight,
      barTargets: boxes,
      shot: await shot(page, `${tag}-tab-${entry.label.toLowerCase()}`),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Home's six figures, and Market's register card                             */
/* -------------------------------------------------------------------------- */

/**
 * Label · value · unit · delta · hint, off the six stat cards Home leads with.
 *
 * The value is the `animate-count-up` span specifically: a card with a change
 * badge carries two `.figure` spans, and the first of them is the badge.
 */
async function readFigures(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.panel-surface')].filter(
      (el) => el.querySelector('.label-caps') !== null && el.querySelector('.animate-count-up') !== null,
    );
    return cards.slice(0, 6).map((el) => {
      const value = el.querySelector('.animate-count-up');
      const unit = value.nextElementSibling;
      const delta = el.querySelector('.figure:not(.animate-count-up)');
      const hint = el.querySelector('p');
      return {
        label: el.querySelector('.label-caps').textContent.trim(),
        value: value.textContent.trim(),
        unit: unit === null ? '' : unit.textContent.trim(),
        delta: delta === null ? '' : delta.textContent.trim(),
        hint: hint === null ? '' : hint.textContent.trim(),
        href: el.getAttribute('href'),
      };
    });
  });
}

/** Every label · value · hint the register card prints, and its whole text. */
async function readRegisterCard(page) {
  return page.evaluate(() => {
    const head = [...document.querySelectorAll('section h2')].find((el) => el.textContent.trim() === 'Your register');
    if (head === undefined) return null;
    const card = head.closest('section');
    const rows = [...card.querySelectorAll('dl > div')].map((row) => {
      const label = row.querySelector('dt');
      const value = row.querySelector('dd > span');
      const hint = row.querySelector('dd > div');
      return {
        label: label === null ? '' : label.textContent.trim(),
        value: value === null ? '' : value.textContent.trim(),
        hint: hint === null ? '' : hint.textContent.trim(),
      };
    });
    const subtitle = card.querySelector('h2 + p');
    return {
      subtitle: subtitle === null ? '' : subtitle.textContent.trim(),
      badges: [...card.querySelectorAll('header span')].map((el) => el.textContent.trim()).filter((text) => text !== ''),
      text: card.textContent.replace(/\s+/g, ' ').trim(),
      rows,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  2. The four tap paths                                                      */
/* -------------------------------------------------------------------------- */

/** A real thumb drag along a range input, left to right by `fraction`. */
async function dragSlider(page, locator, fraction = 0.75) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box === null) throw new Error('slider has no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.05, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function driveRaisePrice(page, tag, out) {
  await goHome(page);
  startCounting();
  await tap(tabLink(page, 'Company'), 'Company tab');
  await page.waitForURL('**/company', { timeout: 15000 });
  await page.waitForTimeout(500);

  // The Connections card's first line row: it deep-links `?sheet=products&line=`
  // and the sheet opens the line's drawer on its price control.
  const linesCard = page.locator('section').filter({ has: page.locator('h2', { hasText: /^Products$/ }) }).first();
  const lineRow = linesCard.locator('a[href*="sheet=products&line="]').first();
  const rows = await lineRow.count();
  check(rows > 0, `${tag} · the Connections card lists a line to tap (${rows})`);
  if (rows === 0) {
    out.raisePrice = { taps: null, note: 'no line row on the card' };
    counter = null;
    return;
  }
  await tap(lineRow, 'line row on the Connections card');
  await page.waitForTimeout(900);
  check(
    searchOf(page.url()).includes('sheet=products') && searchOf(page.url()).includes('line='),
    `${tag} · the line row addresses the products sheet (${searchOf(page.url())})`,
  );

  const priceSection = page.locator('[data-testid="line-price-section"]');
  await priceSection.waitFor({ state: 'visible', timeout: 20000 });
  const priceBox = await priceSection.boundingBox();
  const viewport = page.viewportSize();
  check(
    priceBox !== null && priceBox.y < viewport.height,
    `${tag} · the price control is in the first screenful (y=${priceBox === null ? 'none' : Math.round(priceBox.y)} of ${viewport.height})`,
  );
  const slider = priceSection.locator('input[type="range"]').first();
  await dragSlider(page, slider);
  await shot(page, `${tag}-raise-price-slider`);

  await tap(page.locator('button:has-text("Queue the reprice")').first(), 'Queue the reprice');
  await page.waitForTimeout(700);
  const badge = await queueBadge(page);
  check(badge === 1, `${tag} · the Play badge reads 1 after the reprice (${badge})`);
  check(taps() <= TAP_BUDGET.raisePrice, `${tag} · raise a price in ${taps()} taps + a drag (budget ${TAP_BUDGET.raisePrice})`);
  out.raisePrice = { taps: taps(), plusSliderDrag: true, badgeAfter: badge, shot: await shot(page, `${tag}-raise-price`) };
  counter = null;
}

async function driveHire(page, tag, out) {
  await goHome(page);
  startCounting();
  await tap(tabLink(page, 'Company'), 'Company tab');
  await page.waitForURL('**/company', { timeout: 15000 });
  await page.waitForTimeout(500);

  const peopleCard = page.locator('section').filter({ has: page.locator('h2', { hasText: /^People$/ }) }).first();
  const roleRow = peopleCard.locator('a[href*="sheet=people"]').first();
  await tap(roleRow, 'role row on the People card');
  await page.waitForTimeout(900);

  // The People sheet is asked for at `#headcount`, and scrolls itself there.
  const plan = page.locator('#headcount');
  await plan.waitFor({ state: 'visible', timeout: 20000 });
  const planBox = await plan.boundingBox();
  const viewport = page.viewportSize();
  check(
    planBox !== null && planBox.y < viewport.height,
    `${tag} · the headcount plan is in view (y=${planBox === null ? 'none' : Math.round(planBox.y)} of ${viewport.height})`,
  );

  const slider = plan.locator('input[type="range"]').first();
  await dragSlider(page, slider, 0.2);
  const hireButton = plan.locator('button:has-text("Hire")').first();
  await hireButton.scrollIntoViewIfNeeded();
  await tap(hireButton, 'Hire');
  await page.waitForTimeout(700);
  const badge = await queueBadge(page);
  check(badge === 2, `${tag} · the Play badge reads 2 after the hire (${badge})`);
  check(taps() <= TAP_BUDGET.hire, `${tag} · hire in ${taps()} taps + a slider (budget ${TAP_BUDGET.hire})`);
  out.hire = { taps: taps(), plusSliderDrag: true, badgeAfter: badge, shot: await shot(page, `${tag}-hire`) };
  counter = null;
}

async function driveWhoIsAttacking(page, tag, out) {
  await goHome(page);
  startCounting();
  await tap(tabLink(page, 'Market'), 'Market tab');
  await page.waitForURL('**/market', { timeout: 15000 });
  await page.waitForTimeout(600);

  const register = await readRegisterCard(page);
  check(register !== null, `${tag} · the Market tab carries a register card`);
  if (register !== null) {
    check(/Short interest/.test(register.text), `${tag} · the register card states short interest on the page`);
    check(/answer/i.test(register.text), `${tag} · the register card says what is there to answer`);
  }
  await shot(page, `${tag}-market-register`);

  const openRegister = page
    .locator('section')
    .filter({ has: page.locator('h2', { hasText: /^Your register$/ }) })
    .locator('a[aria-label="Open Your register"]')
    .first();
  await tap(openRegister, 'the register card');
  await page.waitForTimeout(900);
  const street = sheetByTitle(page, 'The Street');
  const open = await street.count();
  check(open > 0, `${tag} · the street sheet opens (${open})`);
  check(searchOf(page.url()).includes('sheet=street'), `${tag} · the address names the street sheet (${searchOf(page.url())})`);
  check(
    taps() <= TAP_BUDGET.whoIsAttacking,
    `${tag} · "who is attacking me" in ${taps()} taps (budget ${TAP_BUDGET.whoIsAttacking})`,
  );
  out.whoIsAttacking = {
    taps: taps(),
    register: register === null ? null : register.rows,
    registerText: register === null ? null : register.text,
    shot: await shot(page, `${tag}-street-sheet`),
  };
  counter = null;
  // Leave the sheet closed for whatever runs next.
  await page.goBack();
  await page.waitForTimeout(400);
}

async function driveEndQuarter(page, tag, out) {
  await goHome(page);
  startCounting();
  await tap(tabLink(page, 'Play'), 'Play tab');
  await page.waitForURL('**/play', { timeout: 15000 });
  await page.waitForTimeout(600);

  // The sticky bar above the tab bar is the phone's commitment; the seal card
  // higher up the page carries the same label, so this takes the last one.
  const sealBar = page.locator('button[aria-label^="Resolve "]').last();
  await tap(sealBar, 'the sticky bar’s Resolve');
  const typed = page.locator('[role="dialog"] input').last();
  await typed.waitFor({ state: 'visible', timeout: 15000 });
  await typed.fill('RESOLVE');
  log('  typed RESOLVE');
  await tap(page.locator('[role="dialog"] button:has-text("Resolve")').last(), 'Resolve in the dialog');

  await page.waitForURL((url) => url.pathname === '/play' && url.searchParams.get('sheet') === 'resolution', { timeout: 240000 });
  await page.waitForTimeout(1200);
  check(
    pathOf(page.url()) === '/play' && searchOf(page.url()).includes('sheet=resolution'),
    `${tag} · resolving lands on /play?sheet=resolution (${page.url()})`,
  );
  const report = sheetByTitle(page, 'Quarter Resolution');
  const visible = await report.count();
  check(visible > 0, `${tag} · the report sheet is on screen (${visible})`);
  check(taps() <= TAP_BUDGET.endQuarter, `${tag} · end a quarter in ${taps()} taps + the typed word (budget ${TAP_BUDGET.endQuarter})`);
  out.endQuarter = { taps: taps(), plusTypedWord: 'RESOLVE', url: page.url(), shot: await shot(page, `${tag}-resolution`) };
  counter = null;
}

/* -------------------------------------------------------------------------- */
/*  3–7. Back, deep links, the status bar, the dock, the Products sheet        */
/* -------------------------------------------------------------------------- */

async function driveSheetBack(page, tag, out) {
  await goHome(page);
  // Any sheet, opened the way a thumb opens one: a card's own control.
  await tabLink(page, 'Company').click();
  await page.waitForURL('**/company', { timeout: 15000 });
  await page.waitForTimeout(450);
  const opener = page.locator('a[aria-label="Open Financials"]').first();
  await opener.click();
  await page.waitForTimeout(700);
  check(searchOf(page.url()).includes('sheet=financials'), `${tag} · a card opens its sheet by address (${searchOf(page.url())})`);
  const sheetOpen = await sheetByTitle(page, 'Financials').count();
  check(sheetOpen > 0, `${tag} · the financials sheet is drawn (${sheetOpen})`);

  await page.goBack();
  await page.waitForTimeout(700);
  check(!searchOf(page.url()).includes('sheet='), `${tag} · Back leaves no ?sheet in the address (${page.url()})`);
  check(pathOf(page.url()) === '/company', `${tag} · Back leaves the tab on screen (${pathOf(page.url())})`);
  const stillOpen = await sheetByTitle(page, 'Financials').count();
  check(stillOpen === 0, `${tag} · the sheet is gone after Back (${stillOpen})`);
  const cards = await page.locator('section h2').count();
  check(cards > 0, `${tag} · the Company tab's cards are visible again (${cards})`);
  out.back = { url: page.url(), shot: await shot(page, `${tag}-after-back`) };
}

async function driveDeepLinks(page, tag, out) {
  // `/markets` is one of the twenty-two old addresses.
  await page.goto(`${BASE_URL}/markets`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname === '/market' && url.search === '?sheet=exchange', { timeout: 20000 });
  await page.waitForTimeout(800);
  check(
    pathOf(page.url()) === '/market' && searchOf(page.url()) === '?sheet=exchange',
    `${tag} · /markets → /market?sheet=exchange (${page.url()})`,
  );
  const exchange = await sheetByTitle(page, 'Markets').count();
  check(exchange > 0, `${tag} · the exchange sheet is open on arrival (${exchange})`);
  const marketsShot = await shot(page, `${tag}-legacy-markets`);

  // `/news?section=world` keeps its section through the rewrite.
  await page.goto(`${BASE_URL}/news?section=world`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname === '/world' && url.searchParams.get('sheet') === 'news', { timeout: 20000 });
  await page.waitForTimeout(1200);
  check(
    pathOf(page.url()) === '/world' && searchOf(page.url()) === '?sheet=news&section=world',
    `${tag} · /news?section=world → /world?sheet=news&section=world (${page.url()})`,
  );
  const mapSection = await page.locator('[data-testid="world-section"]').count();
  check(mapSection > 0, `${tag} · the map section is the one drawn (${mapSection})`);
  const newsShot = await shot(page, `${tag}-legacy-news-world`);

  // An address nobody knows is a 404, not a swallowed redirect.
  const response = await page.goto(`${BASE_URL}/no-such-screen`, { waitUntil: 'domcontentloaded' });
  const status = response === null ? 0 : response.status();
  check(status === 404, `${tag} · /no-such-screen answers 404 (${status})`);
  const notFoundShot = await shot(page, `${tag}-not-found`);

  out.deepLinks = { markets: marketsShot, newsWorld: newsShot, notFoundStatus: status, notFound: notFoundShot };
}

async function driveStatusBar(page, tag, out) {
  await goHome(page);
  const block = page.locator('a[aria-label^="Open the desk"]').first();
  const count = await block.count();
  check(count > 0, `${tag} · the status bar's quarter block is a link (${count})`);
  const href = count === 0 ? null : await block.getAttribute('href');
  check(href === '/play', `${tag} · it points at the desk (${href})`);
  const text = count === 0 ? '' : (await block.textContent()).replace(/\s+/g, ' ').trim();
  await block.click();
  await page.waitForURL('**/play', { timeout: 15000 });
  await page.waitForTimeout(400);
  check(pathOf(page.url()) === '/play', `${tag} · tapping the quarter block reaches the desk (${pathOf(page.url())})`);
  out.statusBar = { href, text };
}

async function driveDock(page, tag, out) {
  await closeSheets(page);
  const seen = [];
  for (const entry of TABS) {
    await tabLink(page, entry.label).click();
    await page.waitForURL(`**${entry.path}`, { timeout: 15000 });
    await page.waitForTimeout(450);
    const ask = page.locator('button[aria-label^="Ask the Chief of Staff about"]');
    const present = await ask.count();
    check(present > 0, `${tag} · the dock's Ask is on ${entry.label} (${present})`);
    if (present === 0) continue;
    const label = await ask.first().getAttribute('aria-label');
    await ask.first().click();
    await page.waitForTimeout(500);
    const drawer = sheetByTitle(page, 'Chief of Staff');
    const opened = await drawer.count();
    check(opened > 0, `${tag} · it opens on ${entry.label} (${opened})`);
    const subtitle = opened === 0 ? '' : (await drawer.locator('h2 + p, p').first().textContent()).replace(/\s+/g, ' ').trim();
    check(
      subtitle.includes(`asking about ${entry.label}`),
      `${tag} · the dock on ${entry.label} says what it is reading — "${subtitle}"`,
    );
    seen.push({ tab: entry.label, ariaLabel: label, subtitle });
    await page.locator('[role="dialog"] button[aria-label="Close"]').last().click();
    await page.waitForTimeout(350);
  }

  // With a sheet open the dock names the sheet, not the tab.
  await page.goto(`${BASE_URL}/company?sheet=financials`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const ask = page.locator('button[aria-label^="Ask the Chief of Staff about"]');
  const sheetLabel = (await ask.count()) === 0 ? null : await ask.first().getAttribute('aria-label');
  check(
    sheetLabel !== null && sheetLabel.includes('Financials'),
    `${tag} · over a sheet the dock names the sheet (${sheetLabel})`,
  );
  seen.push({ tab: 'company?sheet=financials', ariaLabel: sheetLabel, subtitle: null });
  out.dock = seen;
}

async function driveProductsSheet(page, tag, out) {
  await page.goto(`${BASE_URL}/company?sheet=products`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const picture = page.locator('[data-testid="connections"]').first();
  await picture.waitFor({ state: 'visible', timeout: 20000 });

  const wanted = ['Revenue', 'Cost of goods', 'Gross profit', 'Blocked inputs'];
  // Scoped to the sheet, not the document: the Company tab is still mounted
  // underneath it with stat cards of its own, and a check that counted those
  // would pass with nothing at all inside the sheet.
  const stats = await page.evaluate(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (sheet === null) return [];
    const out = [];
    for (const el of sheet.querySelectorAll('.panel-surface')) {
      const label = el.querySelector('.label-caps');
      const figure = el.querySelector('.figure');
      if (label === null || figure === null) continue;
      out.push({ label: label.textContent.trim(), value: figure.textContent.trim() });
    }
    return out;
  });
  for (const label of wanted) {
    const found = stats.find((stat) => stat.label === label);
    check(found !== undefined, `${tag} · the Products sheet states ${label} (${found === undefined ? 'absent' : found.value})`);
  }

  // Above the picture, and the Lines table below it: document order decides.
  // Each of the four is asked for *by name* rather than counted — `panel-surface`
  // is worn by the line switcher and the Lines panel too, so a count would be
  // measuring the wrong thing in both directions.
  const order = await page.evaluate((names) => {
    const sheet = document.querySelector('[role="dialog"]');
    if (sheet === null) return { above: [], linesAfter: false, rows: 0 };
    const picture = sheet.querySelector('[data-testid="connections"]');
    const cards = [...sheet.querySelectorAll('.panel-surface')].filter(
      (el) => el.querySelector('.label-caps') !== null && el.querySelector('.figure') !== null,
    );
    const above = names.filter((name) => {
      const card = cards.find((el) => el.querySelector('.label-caps').textContent.trim() === name);
      return card !== undefined && picture !== null && Boolean(card.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const heads = [...sheet.querySelectorAll('section h2')];
    const linesHead = heads.find((el) => el.textContent.trim() === 'Lines');
    const linesAfter =
      linesHead !== undefined && picture !== null
        ? Boolean(picture.compareDocumentPosition(linesHead) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false;
    const rows = linesHead === undefined ? 0 : linesHead.closest('section').querySelectorAll('ul > li').length;
    return { above, linesAfter, rows };
  }, wanted);
  check(
    order.above.length === wanted.length,
    `${tag} · all four stat cards sit above the picture (${JSON.stringify(order.above)})`,
  );
  check(order.linesAfter, `${tag} · the Lines table sits below the picture (${order.linesAfter})`);
  check(order.rows >= 1, `${tag} · the Lines table has at least one row (${order.rows})`);

  const scroll = await pageScroll(page);
  check(
    scroll.scrollWidth <= scroll.clientWidth + 1,
    `${tag} · the Products sheet does not scroll the page sideways (${scroll.scrollWidth} ≤ ${scroll.clientWidth})`,
  );
  // The sheet has its own scroll region: the Lines panel must be reachable in it.
  const linesReachable = await page.evaluate(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (sheet === null) return false;
    const heads = [...sheet.querySelectorAll('section h2')];
    const linesHead = heads.find((el) => el.textContent.trim() === 'Lines');
    if (linesHead === undefined) return false;
    linesHead.scrollIntoView({ block: 'center' });
    const rect = linesHead.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  check(linesReachable, `${tag} · the sheet's own scroll reaches the Lines panel (${linesReachable})`);

  out.products = { stats, order, shot: await shot(page, `${tag}-products-sheet`) };
}

/* -------------------------------------------------------------------------- */
/*  8. What /home actually costs                                               */
/* -------------------------------------------------------------------------- */

/**
 * Encoded (over-the-wire) bytes of every script `/home` pulls on a cold load.
 *
 * This is the *whole* download, prefetches included: the bottom bar carries
 * four other `<Link>`s, and Next prefetches each one's route chunk as soon as
 * it is in the viewport, so this figure is roughly half again the first load.
 * The number the 400 kB budget is written against is the build's own "First
 * Load JS" for `/home`, which Next already reports gzipped — read that off
 * `pnpm --filter @frontier/web build`, not off this.
 */
async function measureBundle(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/home`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const bytes = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => entry.initiatorType === 'script' || /\.js(\?|$)/.test(entry.name))
      .reduce(
        (totals, entry) => ({
          encoded: totals.encoded + entry.encodedBodySize,
          decoded: totals.decoded + entry.decodedBodySize,
          files: totals.files + 1,
        }),
        { encoded: 0, decoded: 0, files: 0 },
      ),
  );
  await context.close();
  return {
    encodedKb: Math.round(bytes.encoded / 102.4) / 10,
    decodedKb: Math.round(bytes.decoded / 102.4) / 10,
    files: bytes.files,
  };
}

/* -------------------------------------------------------------------------- */
/*  The run                                                                    */
/* -------------------------------------------------------------------------- */

async function main() {
  const browser = await chromium.launch();

  results.bundle = await measureBundle(browser);
  log('bundle /home:', `${results.bundle.encodedKb} kB encoded`, `${results.bundle.decodedKb} kB decoded`, `${results.bundle.files} files`);
  check(results.bundle.encodedKb > 0, 'the bundle measurement returned bytes');

  for (const viewport of VIEWPORTS) {
    const tag = `${viewport.width}x${viewport.height}`;
    log('=== viewport', tag, '===');
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('pageerror', (error) => {
      failures.push(`${tag} · pageerror: ${error.message}`);
      log('FAIL pageerror', error.message);
    });

    const out = { viewport: tag, tabs: [], figures: null };
    await foundCompany(page, `Harbour ${viewport.width}`);

    // Home's own figures, read once, before anything is queued.
    out.figures = await readFigures(page);
    check(out.figures.length === 6, `${tag} · Home states six figures (${out.figures.length})`);
    for (const figure of out.figures)
      log(
        '  figure:',
        `${figure.label} = ${figure.value}${figure.unit === '' ? '' : ` ${figure.unit}`}` +
          `${figure.delta === '' ? '' : ` (${figure.delta})`} · ${figure.hint}`,
      );
    await shot(page, `${tag}-home-figures`);

    await driveTabs(page, tag, out);
    await driveStatusBar(page, tag, out);
    await driveDock(page, tag, out);
    await driveSheetBack(page, tag, out);
    await driveDeepLinks(page, tag, out);
    await driveProductsSheet(page, tag, out);

    await driveRaisePrice(page, tag, out);
    await driveHire(page, tag, out);
    await driveWhoIsAttacking(page, tag, out);
    await driveEndQuarter(page, tag, out);

    results.viewports.push(out);
    await context.close();
  }

  await browser.close();

  results.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  log('wrote', path.resolve(OUT_DIR, 'results.json'));

  if (failures.length > 0) {
    log('FAILURES:', failures.length);
    for (const failure of failures) log(' -', failure);
    process.exitCode = 1;
  } else {
    log('ALL CHECKS PASSED');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

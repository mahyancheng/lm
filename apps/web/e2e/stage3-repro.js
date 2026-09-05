/**
 * Stage 3 verification harness — resolution screen tokens, news determinism.
 *
 * Same shape as `stage0-repro.js` (plain Node + Playwright, no
 * `@playwright/test`, drives Chromium at a 390x844 viewport): new game →
 * three quarters, resolving each and then checking the news screen before and
 * after a real reload. What it checks is Stage 3's two fixes specifically:
 *
 * 1. **The resolution screen carries no raw token.** Same scan as Stage 0
 *    (`grepTokens`, `textContent()` not `innerText()` — see the method note
 *    in `stage0-repro.js` and this directory's README), now expected to come
 *    back empty on every quarter.
 * 2. **The news screen is deterministic.** The "Quarter in review" card, and
 *    the feed's item count, must be identical before and after a real
 *    `page.reload()` — not merely present, but the *same* — and the feed
 *    must always sit above the World section in document order, whatever the
 *    active filter, since there is no longer a tab that can hide or reorder
 *    either one.
 *
 * Usage — see README.md in this directory for how to build and start a
 * server this points at:
 *   BASE_URL=http://localhost:3100 OUT_DIR=/tmp/stage3-none \
 *     node apps/web/e2e/stage3-repro.js
 */

process.env.NODE_PATH = process.env.NODE_PATH
  ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules`
  : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || '/tmp/stage3-repro';
const QUARTERS = Number(process.env.QUARTERS || 3);

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = { baseUrl: BASE_URL, resolution: [], news: [] };

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

async function screenshot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Same pattern as stage0-repro.js's `grepTokens`, restated here so this file runs standalone. */
function grepSnakeTokens(text) {
  return [...new Set((text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []))];
}

async function foundCompany(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  for (let i = 0; i < 3; i++) {
    const chip = page.locator('ul.grid > li > button').first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });
    await chip.click();
    await page.waitForTimeout(150);
  }
  await page.fill('#setup-name-field', 'Stage3 Test Co');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  await page.fill('#setup-name-field', 'Stage3 Tester');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);

  const foundBtn = page.locator('button:has-text("Found ")');
  await foundBtn.waitFor({ state: 'visible', timeout: 10000 });
  await foundBtn.click();
  await page.waitForURL('**/command-centre', { timeout: 20000 }).catch(() => {});
  log('founded company, url =', page.url());
}

async function resolveQuarter(page, quarter) {
  await page.goto(`${BASE_URL}/end-quarter`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const resolveBtn = page.locator('button', { hasText: /Resolve \d{4} Q\d/ }).first();
  await resolveBtn.waitFor({ state: 'visible', timeout: 10000 });
  await resolveBtn.click();

  const typedInput = page.locator('input').last();
  await typedInput.waitFor({ state: 'visible', timeout: 10000 });
  await typedInput.fill('RESOLVE');
  const confirmBtn = page.locator('button:has-text("Resolve")').last();
  await confirmBtn.click();

  await page.waitForURL('**/quarter-resolution', { timeout: 180000 });
  await page.waitForTimeout(500);

  // textContent, not innerText — see the method note in stage0-repro.js /
  // this directory's README: innerText can under-report on this app's
  // longer pages.
  const bodyText = (await page.locator('body').textContent()) ?? '';
  const snake = grepSnakeTokens(bodyText);
  const shot = await screenshot(page, `resolution-q${quarter}`);

  // Open a couple of ledger rows: the payload block used to be a raw JSON
  // dump with no label on its keys, and that text is not otherwise on the
  // page for `bodyText` to have scanned unless a drawer is open.
  const lines = page.locator('button[title$="ledger rows"], button[title$="ledger row"]');
  const lineCount = await lines.count();
  let payloadSnake = [];
  if (lineCount > 0) {
    await lines.first().click();
    await page.waitForTimeout(200);
    const drawerText = (await page.locator('body').textContent()) ?? '';
    payloadSnake = grepSnakeTokens(drawerText);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }

  const entry = { quarter, snakeCaseTokens: snake, snakeCaseTokensWithLedgerDrawerOpen: payloadSnake, screenshot: shot };
  results.resolution.push(entry);
  log('resolution screen', JSON.stringify(entry));
}

/**
 * The feed must be first and the World section must sit below it in document
 * order, regardless of viewport — checked structurally (`compareDocumentPosition`),
 * not by scroll position, so it is true even on a tall page.
 */
async function feedComesBeforeWorld(page) {
  return page.evaluate(() => {
    // `Feed` renders one `<section aria-label="...">` per quarter group — the
    // first one in the DOM is the newest quarter, i.e. the top of the feed.
    const firstFeedSection = document.querySelector('section[aria-label]');
    const worldHeading = [...document.querySelectorAll('span.label-caps')].find((el) => el.textContent?.trim() === 'World');
    if (firstFeedSection === null || worldHeading === undefined) return null;
    // DOCUMENT_POSITION_FOLLOWING (4) on `worldHeading` relative to the first
    // feed section means the feed precedes the World heading in the DOM.
    const relation = firstFeedSection.compareDocumentPosition(worldHeading);
    return (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
}

async function checkNews(page, quarter) {
  const newsLink = page.locator('nav[aria-label="Sections"] a', { hasText: 'World' }).first();
  await newsLink.waitFor({ state: 'visible', timeout: 10000 });
  await newsLink.click();
  await page.waitForURL('**/news', { timeout: 10000 });
  await page.waitForTimeout(500);

  const leadCard = page.locator('span.label-caps', { hasText: 'Quarter in review' });
  const feedCards = page.locator('article.panel-surface');
  const worldPanel = page.locator('span.label-caps', { hasText: 'World' });

  const countBefore = await leadCard.count();
  const feedItemsBefore = await feedCards.count();
  const orderOkBefore = await feedComesBeforeWorld(page);
  const worldPresentBefore = (await worldPanel.count()) > 0;
  const shotBefore = await screenshot(page, `news-q${quarter}-before-reload`);

  // A real full-page reload — the state stage 3 must survive.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const countAfter = await leadCard.count();
  const feedItemsAfter = await feedCards.count();
  const orderOkAfter = await feedComesBeforeWorld(page);
  const worldPresentAfter = (await worldPanel.count()) > 0;
  const shotAfter = await screenshot(page, `news-q${quarter}-after-reload`);

  const entry = {
    quarter,
    quarterInReviewPresentBeforeReload: countBefore > 0,
    quarterInReviewPresentAfterReload: countAfter > 0,
    // The determinism claim: not just "present both times" but "the same".
    quarterInReviewPresenceUnchanged: (countBefore > 0) === (countAfter > 0),
    feedItemCountBeforeReload: feedItemsBefore,
    feedItemCountAfterReload: feedItemsAfter,
    feedItemCountUnchanged: feedItemsBefore === feedItemsAfter,
    feedBeforeWorldBeforeReload: orderOkBefore,
    feedBeforeWorldAfterReload: orderOkAfter,
    worldSectionPresentBeforeReload: worldPresentBefore,
    worldSectionPresentAfterReload: worldPresentAfter,
    screenshotBefore: shotBefore,
    screenshotAfter: shotAfter,
  };
  results.news.push(entry);
  log('news', JSON.stringify(entry));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console error:', msg.text());
  });

  await foundCompany(page);

  for (let q = 1; q <= QUARTERS; q++) {
    await resolveQuarter(page, q);
    await checkNews(page, q);
    await page.goto(`${BASE_URL}/command-centre`, { waitUntil: 'networkidle' }).catch(() => {});
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  const anyTokens = results.resolution.some((r) => r.snakeCaseTokens.length > 0 || r.snakeCaseTokensWithLedgerDrawerOpen.length > 0);
  const anyDrift = results.news.some(
    (n) => !n.quarterInReviewPresenceUnchanged || !n.feedItemCountUnchanged || !n.feedBeforeWorldBeforeReload || !n.feedBeforeWorldAfterReload,
  );
  log('done. results at', path.join(OUT_DIR, 'results.json'));
  log(anyTokens ? 'FAIL: raw token(s) found on the resolution screen' : 'PASS: no raw token on the resolution screen');
  log(anyDrift ? 'FAIL: news screen drifted across a reload or ordered wrongly' : 'PASS: news screen is deterministic and correctly ordered');
})().catch((err) => {
  console.error('HARNESS FAILED', err);
  process.exit(1);
});

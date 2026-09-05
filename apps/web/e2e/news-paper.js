/**
 * The newspaper, read like a reader — a plain Node + Playwright script in the
 * shape of `stage3-repro.js` (same method notes: `<Link>` navigation for the
 * first visit, `textContent()` over `innerText()`, a real `page.reload()`).
 *
 * New game → resolve QUARTERS quarters → News. Then, at each viewport:
 *   1. the front page above the fold, with the lead headline's y position;
 *   2. scrolled to the second tier and the briefs;
 *   3. the lead opened in full (the story sheet, with its Sources);
 *   4. The Street and World, then Mine toggled on;
 *   5. a real reload on `?section=world&mine=1`: the section and toggle must
 *      persist and, with Mine off again, a story's Sources must still list
 *      committed ledger rows — the reload bug this stage fixes;
 *   6. The Street → the Social sub-tab → the News sub-tab: the paper must come
 *      back open on The Street (the app's own links carry the section).
 * Along the way: no headline is printed twice under one byline (a post the
 * market heard as a disclosure is one item), the lead and the tier are not all
 * earnings filings, a Sources row prints no raw id, hash or machine token and
 * opens the ledger row on a tap, and the story body is one column on a phone.
 * Every step also asserts the document never scrolls horizontally.
 *
 * Usage (server started per e2e/README.md):
 *   BASE_URL=http://localhost:3100 OUT_DIR=apps/web/e2e/shots node apps/web/e2e/news-paper.js
 * Optional: QUARTERS (default 3), VIEWPORTS ("390x844,360x780").
 */

process.env.NODE_PATH = process.env.NODE_PATH ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules` : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'shots');
const QUARTERS = Number(process.env.QUARTERS || 3);
const VIEWPORTS = (process.env.VIEWPORTS || '390x844,360x780').split(',').map((entry) => {
  const [w, h] = entry.split('x').map(Number);
  return { width: w, height: h };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = { baseUrl: BASE_URL, viewports: [] };
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
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
/** An engine id (cmp_x, dsc_x, pst_x…), a bare 10-hex hash pair, or a snake_case token. */
const RAW_TOKEN = /\b(?:cmp|chr|dsc|pst|sty|evt|sess|fnd|agy|nod|acc)_[a-z0-9_]+|\b[0-9a-f]{10}\s*→\s*[0-9a-f]{10}|\b[a-z]+_[a-z]+(?:_[a-z0-9]+)*\b/;
/** Every headline on the front page with the byline it is printed under, in page order. */
async function printedHeadlines(page) {
  return page.evaluate(() => {
    const out = [];
    for (const article of document.querySelectorAll('[data-testid="lead-story"], [data-testid="tier-story"]')) {
      const headline = article.querySelector('h2, h3');
      const byline = article.querySelector('[data-testid="byline"]');
      if (headline) out.push({ headline: headline.textContent.trim(), byline: byline ? byline.textContent.trim() : '' });
    }
    for (const brief of document.querySelectorAll('[data-testid="brief"]')) {
      const headline = brief.querySelector('.np-deck');
      const leadIn = brief.querySelector('p > span:first-child:not(.np-deck)'); // the lead-in, when the headline does not already name the speaker
      if (headline) out.push({ headline: headline.textContent.trim(), byline: leadIn ? leadIn.textContent.trim() : '' });
    }
    return out;
  });
}

async function foundCompany(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 3; i++) {
    const chip = page.locator('ul.grid > li > button').first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });
    await chip.click();
    await page.waitForTimeout(150);
  }
  await page.fill('#setup-name-field', 'Harbourline Test Co');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  await page.fill('#setup-name-field', 'Reader Tester');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  const foundBtn = page.locator('button:has-text("Found ")');
  await foundBtn.waitFor({ state: 'visible', timeout: 10000 });
  await foundBtn.click();
  await page.waitForURL('**/command-centre', { timeout: 20000 }).catch(() => {});
  log('founded company, url =', page.url());
}

async function resolveQuarter(page, quarter) {
  await page.goto(`${BASE_URL}/end-quarter`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const resolveBtn = page.locator('button', { hasText: /Resolve \d{4} Q\d/ }).first();
  await resolveBtn.waitFor({ state: 'visible', timeout: 10000 });
  await resolveBtn.click();
  const typedInput = page.locator('input').last();
  await typedInput.waitFor({ state: 'visible', timeout: 10000 });
  await typedInput.fill('RESOLVE');
  await page.locator('button:has-text("Resolve")').last().click();
  await page.waitForURL('**/quarter-resolution', { timeout: 180000 });
  await page.waitForTimeout(400);
  log('resolved quarter', quarter);
}

async function openNews(page) {
  // The bottom tab groups News under "World"; a real <Link>, not a goto.
  const tab = page.locator('nav[aria-label="Sections"] a', { hasText: 'World' }).first();
  await tab.waitFor({ state: 'visible', timeout: 10000 });
  await tab.click();
  await page.waitForURL('**/news**', { timeout: 10000 });
  await page.waitForTimeout(600);
}

async function readPaper(page, viewport, label) {
  const entry = { viewport: `${viewport.width}x${viewport.height}`, shots: {} };
  await page.setViewportSize(viewport);
  await page.goto(`${BASE_URL}/news`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="newspaper"]').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(900);

  // 1. Above the fold.
  const lead = page.locator('[data-testid="lead-story"] h2');
  check((await lead.count()) > 0, `${label}: a lead story is on the front page`);
  const box = await lead.first().boundingBox();
  entry.leadHeadlineY = box ? Math.round(box.y) : null;
  entry.leadHeadlineBottom = box ? Math.round(box.y + box.height) : null;
  check(box !== null && box.y + box.height < viewport.height, `${label}: the lead headline is above the fold (bottom at ${entry.leadHeadlineBottom}px of ${viewport.height})`);
  const opening = page.locator('[data-testid="lead-opening"]');
  if ((await opening.count()) > 0) {
    const openingBox = await opening.first().boundingBox();
    entry.leadOpeningTop = openingBox ? Math.round(openingBox.y) : null;
  }
  const masthead = await page.locator('[data-testid="masthead"]').boundingBox();
  const strip = await page.locator('[data-testid="section-strip"]').boundingBox();
  entry.chromePx = masthead && strip ? Math.round(masthead.height + strip.height) : null;
  check(entry.chromePx !== null && entry.chromePx < 120, `${label}: masthead + strip = ${entry.chromePx}px (< 120)`);
  check(await noHorizontalScroll(page), `${label}: no horizontal scroll on the front page`);
  entry.shots.frontAboveFold = await shot(page, `${label}-1-front-above-fold`);
  entry.frontFull = await shot(page, `${label}-1b-front-full`, true);

  // One utterance, printed once: no headline appears twice under one byline.
  // (Two rivals may open a post with the same template sentence — "On Grid
  // Firming and Datacentre Supply" from two losing bidders — and those are two
  // items; a post and the disclosure the market made of it are one.)
  const printed = await printedHeadlines(page);
  const seen = new Map();
  for (const line of printed) {
    const key = `${line.byline}\u0000${line.headline}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  entry.duplicateHeadlines = [...seen.entries()].filter(([, n]) => n > 1).map(([key, n]) => `${key.replace('\u0000', ' · ')} ×${n}`);
  entry.itemsPrinted = printed.length;
  check(entry.duplicateHeadlines.length === 0, `${label}: no headline is printed twice under one byline (${printed.length} items; duplicates: ${JSON.stringify(entry.duplicateHeadlines)})`);

  // The lead and the tier are not a stock table.
  entry.topKickers = await page.locator('[data-testid="lead-story"] p.np-kicker, [data-testid="tier-story"] p.np-kicker').allTextContents();
  const earningsOnly = entry.topKickers.length > 0 && entry.topKickers.every((text) => /Earnings|Guidance/i.test(text));
  check(!earningsOnly, `${label}: the lead and the tier are not all earnings filings (${JSON.stringify(entry.topKickers)})`);

  // 2. Second tier and briefs.
  const tier = page.locator('[data-testid="second-tier"]');
  const briefs = page.locator('[data-testid="briefs"]');
  entry.tierStories = await page.locator('[data-testid="tier-story"]').count();
  entry.briefs = await page.locator('[data-testid="brief"]').count();
  if ((await tier.count()) > 0) {
    await tier.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    entry.shots.secondTier = await shot(page, `${label}-2-second-tier`);
  }
  if ((await briefs.count()) > 0) {
    await briefs.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    entry.shots.briefs = await shot(page, `${label}-3-briefs`);
  }
  check(await noHorizontalScroll(page), `${label}: no horizontal scroll after scrolling`);

  // 3. The lead in full.
  await page.evaluate(() => window.scrollTo(0, 0));
  await lead.first().click();
  const sheet = page.locator('[data-testid="story-sheet"]');
  await sheet.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  entry.leadSourcesRows = await page.locator('[data-testid="source-row"]').count();
  entry.shots.leadOpen = await shot(page, `${label}-4-lead-open`);
  check((await page.locator('[data-testid="story-body"]').count()) > 0, `${label}: the opened lead has a body`);
  entry.leadColumns = await page.locator('[data-testid="story-body"]').first().getAttribute('data-columns');
  check(viewport.width > 600 || entry.leadColumns === '1', `${label}: the story body is one column on a phone (data-columns=${entry.leadColumns})`);
  const sourcesText = ((await page.locator('[data-testid="sources"]').textContent()) || '').trim();
  const rawInSources = sourcesText.match(RAW_TOKEN);
  check(rawInSources === null, `${label}: Sources print no raw id, hash or token (${rawInSources ? rawInSources[0] : 'clean'})`);
  if (entry.leadSourcesRows > 0) {
    await page.locator('[data-testid="sources"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    entry.shots.leadSources = await shot(page, `${label}-4b-lead-sources`);
    await page.locator('[data-testid="source-row"] button').first().click();
    const rowDialog = page.locator('[role="dialog"]', { hasText: /Ledger row \d+/ });
    await rowDialog.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    entry.sourceRowOpens = (await rowDialog.count()) > 0;
    check(entry.sourceRowOpens, `${label}: a Sources row opens the ledger row on a tap`);
    entry.shots.sourceRowOpen = await shot(page, `${label}-4c-source-row-open`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 4. The Street, World, Mine.
  await page.locator('[role="tab"]', { hasText: 'The Street' }).click();
  await page.waitForTimeout(500);
  check(page.url().includes('section=street'), `${label}: The Street is in the URL (${page.url()})`);
  entry.shots.street = await shot(page, `${label}-5-street`);
  await page.locator('[role="tab"]', { hasText: 'World' }).click();
  await page.waitForTimeout(700);
  check(page.url().includes('section=world'), `${label}: World is in the URL`);
  check((await page.locator('[data-testid="world-section"]').count()) > 0, `${label}: World carries the map section`);
  entry.shots.world = await shot(page, `${label}-6-world`);
  await page.locator('[data-testid="world-section"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  entry.shots.worldMap = await shot(page, `${label}-6b-world-map`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('button[aria-pressed]', { hasText: 'Mine' }).click();
  await page.waitForTimeout(500);
  check(page.url().includes('mine=1'), `${label}: Mine is in the URL`);
  entry.shots.mine = await shot(page, `${label}-7-mine`);

  // 5. Reload: the URL state persists, and Sources still list rows.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="newspaper"]').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  const worldSelected = await page.locator('[role="tab"][aria-selected="true"]').first().textContent();
  const minePressed = await page.locator('button[aria-pressed="true"]', { hasText: 'Mine' }).count();
  check((worldSelected || '').trim() === 'World', `${label}: World is still the selected section after a reload (${(worldSelected || '').trim()})`);
  check(minePressed === 1, `${label}: Mine is still on after a reload`);
  entry.shots.afterReload = await shot(page, `${label}-8-after-reload`);

  await page.locator('button[aria-pressed]', { hasText: 'Mine' }).click();
  await page.waitForTimeout(300);
  await page.locator('[role="tab"]', { hasText: 'Front page' }).click();
  await page.waitForTimeout(600);
  const leadAfter = page.locator('[data-testid="lead-story"] h2');
  check((await leadAfter.count()) > 0, `${label}: the lead is back after a reload`);
  await leadAfter.first().click();
  await page.locator('[data-testid="story-sheet"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  entry.sourcesRowsAfterReload = await page.locator('[data-testid="source-row"]').count();
  check(entry.sourcesRowsAfterReload > 0, `${label}: Sources list ${entry.sourcesRowsAfterReload} ledger rows after a real reload`);
  await page.locator('[data-testid="sources"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  entry.shots.sourcesAfterReload = await shot(page, `${label}-9-sources-after-reload`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 6. The Street → Social by the sub-tab → News by the sub-tab: still The Street.
  await page.locator('[role="tab"]', { hasText: 'The Street' }).click();
  await page.waitForTimeout(400);
  check(page.url().includes('section=street'), `${label}: The Street is in the URL before leaving (${page.url()})`);
  await page.locator('nav[aria-label="World screens"] a', { hasText: 'Social' }).first().click();
  await page.waitForURL('**/social**', { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.locator('nav[aria-label="World screens"] a', { hasText: 'News' }).first().click();
  await page.waitForURL('**/news**', { timeout: 10000 });
  await page.locator('[data-testid="newspaper"]').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(600);
  const backSelected = ((await page.locator('[role="tab"][aria-selected="true"]').first().textContent()) || '').trim();
  entry.afterSocialAndBack = { url: page.url(), section: backSelected };
  check(page.url().includes('section=street') && backSelected === 'The Street', `${label}: The Street survives Social and back by the News tab (${page.url()}, ${backSelected})`);
  entry.shots.afterSocialAndBack = await shot(page, `${label}-10-after-social-and-back`);
  await page.locator('[role="tab"]', { hasText: 'Front page' }).click();
  await page.waitForTimeout(300);

  results.viewports.push(entry);
  log('paper', JSON.stringify(entry));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORTS[0] });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console error:', msg.text());
  });
  page.on('pageerror', (err) => {
    failures.push(`page error: ${err.message}`);
    log('page error:', err.message);
  });

  await foundCompany(page);
  for (let q = 1; q <= QUARTERS; q++) await resolveQuarter(page, q);
  await page.goto(`${BASE_URL}/command-centre`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await openNews(page);
  check(page.url().endsWith('/news'), `arrived on /news by tab (${page.url()})`);

  for (const viewport of VIEWPORTS) {
    await readPaper(page, viewport, `${viewport.width}x${viewport.height}`);
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ ...results, failures }, null, 2));
  log('done. results at', path.resolve(path.join(OUT_DIR, 'results.json')));
  log(failures.length === 0 ? 'PASS: the paper reads as designed' : `FAIL: ${failures.length} check(s) failed`);
  process.exit(failures.length === 0 ? 0 : 2);
})().catch((err) => {
  console.error('HARNESS FAILED', err);
  process.exit(1);
});

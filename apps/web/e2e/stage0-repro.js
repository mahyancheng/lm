/**
 * Stage 0 reproduction harness — owner-reported bugs, with numbers.
 *
 * Run against an already-running `next start` server (see README.md in this
 * directory). Drives Chromium at a 390x844 viewport through: new game →
 * three quarters, exercising the Chief of Staff dock, the quarter-resolution
 * screen and the news screen on each quarter.
 *
 * Usage:
 *   BASE_URL=http://localhost:3100 OUT_DIR=/tmp/stage0-none \
 *     node apps/web/e2e/stage0-repro.js
 *
 * Requires the `playwright` package (present globally in this environment at
 * /opt/node22/lib/node_modules — set NODE_PATH to it if `require('playwright')`
 * fails) and its Chromium browser (PLAYWRIGHT_BROWSERS_PATH).
 */

process.env.NODE_PATH = process.env.NODE_PATH
  ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules`
  : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || '/tmp/stage0-repro';
const QUARTERS = Number(process.env.QUARTERS || 3);

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = { baseUrl: BASE_URL, quarters: [], chiefOfStaff: [], news: [], timings: {} };

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

async function screenshot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function grepTokens(text) {
  // snake_case tokens: two+ lowercase/number segments joined by underscore.
  const snake = [...new Set((text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []))];
  // The literal word "type" as its own token (case-sensitive, whole word).
  const typeWord = [...new Set((text.match(/\btype\b/g) || []))];
  return { snake, typeWord };
}

async function foundCompany(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

  // sector, region, backgroundId chips in that order (SETUP_ASK_ORDER), then
  // companyName / founderName text fields, then the Found button.
  for (let i = 0; i < 3; i++) {
    const chip = page.locator('ul.grid > li > button').first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });
    await chip.click();
    await page.waitForTimeout(150);
  }

  await page.fill('#setup-name-field', 'Stage0 Test Co');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  await page.fill('#setup-name-field', 'Stage0 Tester');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);

  const foundBtn = page.locator('button:has-text("Found ")');
  await foundBtn.waitFor({ state: 'visible', timeout: 10000 });
  await foundBtn.click();
  await page.waitForURL('**/command-centre', { timeout: 20000 }).catch(() => {});
  log('founded company, url =', page.url());
}

async function askChiefOfStaff(page, quarter, message) {
  const askBtn = page.locator('button[aria-label^="Ask the Chief of Staff"]');
  await askBtn.waitFor({ state: 'visible', timeout: 10000 });
  await askBtn.click();

  const textarea = page.locator('textarea[aria-label="Your question"]');
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  await textarea.fill(message);

  const sendBtn = page.locator('button:has-text("Ask")').last();
  const t0 = Date.now();
  await sendBtn.click();

  // Wait for either the "No model reached" tag, a normal reply bubble, or a
  // hard timeout of our own (well above ROLE_TIMEOUT_MS=45s) so the harness
  // itself never hangs forever.
  const drawer = page.locator('text=Chief of Staff').first();
  let finalState = 'timed_out_in_harness';
  try {
    await page.waitForFunction(
      () => {
        const text = document.body.textContent || '';
        return /No model reached/.test(text) || /Sourced/.test(text) || document.querySelectorAll('p.text-\\[13px\\]').length > 0;
      },
      { timeout: 60000 },
    );
    finalState = 'settled';
  } catch {
    finalState = 'harness_timeout_60s';
  }
  const elapsedMs = Date.now() - t0;

  const bodyText = (await page.locator('body').textContent()) ?? '';
  const noModelReached = bodyText.includes('No model reached');
  const offlineTag = bodyText.includes('Offline — answers from your own state');
  const liveTag = /Live · /.test(bodyText);

  const shot = await screenshot(page, `cos-q${quarter}-${message.slice(0, 12).replace(/\W+/g, '_')}`);

  const entry = { quarter, message, elapsedMs, finalState, noModelReached, offlineTag, liveTag, screenshot: shot };
  log('chief-of-staff', JSON.stringify(entry));
  results.chiefOfStaff.push(entry);

  // Close the drawer.
  const closeBtn = page.locator('button[aria-label="Close"]').first();
  if (await closeBtn.count()) await closeBtn.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

async function resolveQuarter(page, quarter) {
  await page.goto(`${BASE_URL}/end-quarter`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const resolveBtn = page.locator('button', { hasText: /Resolve \d{4} Q\d/ }).first();
  await resolveBtn.waitFor({ state: 'visible', timeout: 10000 });
  const t0 = Date.now();
  await resolveBtn.click();

  // Confirmation dialog requires typing the word RESOLVE.
  const typedInput = page.locator('input').last();
  await typedInput.waitFor({ state: 'visible', timeout: 10000 });
  await typedInput.fill('RESOLVE');
  const confirmBtn = page.locator('button:has-text("Resolve")').last();
  await confirmBtn.click();

  await page.waitForURL('**/quarter-resolution', { timeout: 180000 });
  const wallMs = Date.now() - t0;
  log(`quarter ${quarter} resolved in ${wallMs} ms (wall clock, click to navigation)`);
  results.timings[`quarter_${quarter}_wall_ms`] = wallMs;

  await page.waitForTimeout(500);
  // `textContent` (not `innerText`) — see the note on `checkNews`: innerText
  // can under-report on a long page, and this scan must not miss a token.
  const bodyText = (await page.locator('body').textContent()) ?? '';
  const { snake, typeWord } = grepTokens(bodyText);
  const shot = await screenshot(page, `resolution-q${quarter}`);

  const entry = {
    quarter,
    wallMs,
    snakeCaseTokens: snake,
    literalTypeOccurrences: typeWord.length,
    screenshot: shot,
  };
  results.quarters.push(entry);
  log('resolution screen', JSON.stringify({ quarter, wallMs, snake, typeWordCount: typeWord.length }));
}

/**
 * NOTE on method: `page.locator('body').innerText()` is NOT reliable for
 * presence checks on this page — on a long feed (11k+ px tall) Chromium's
 * innerText() can under-report content that `boundingBox()`/`isVisible()`
 * and a screenshot both confirm is genuinely on screen (verified directly:
 * same page, same instant, `span.isVisible()` true and a screenshot showing
 * the card, while `body.innerText()` omitted its text). So presence here is
 * decided by a DOM locator `.count()`, never by string-matching innerText.
 */
async function checkNews(page, quarter) {
  // Navigate via the app's own <Link> (client-side routing), not
  // page.goto(), so in-memory store state (`lastOutcome`) survives exactly as
  // it would for a real player clicking through the app. page.goto() is a
  // real browser navigation and would itself destroy that state, conflating
  // the "normal" case with the "after reload" case the bug report describes.
  // At the 390px viewport the sidebar `<a href="/news">` is display:none (it's
  // `lg:` only); the phone's bottom tab bar groups News under "World".
  const newsLink = page.locator('nav[aria-label="Sections"] a', { hasText: 'World' }).first();
  await newsLink.waitFor({ state: 'visible', timeout: 10000 });
  await newsLink.click();
  await page.waitForURL('**/news', { timeout: 10000 });
  await page.waitForTimeout(500);

  const leadCard = page.locator('span.label-caps', { hasText: 'Quarter in review' });
  const feedBadge = page.locator('nav[aria-label="News view"] button[role="tab"]').first();
  const countBefore = await leadCard.count();
  const feedTextBefore = (await feedBadge.innerText().catch(() => '')).trim();
  const shotBefore = await screenshot(page, `news-q${quarter}-before-reload`);

  // Now a real full-page reload — this is what the bug report's "sometimes
  // not showing" describes, and what the news page's own source comment flags
  // (`lastOutcome?.events ?? []`, empty after a reload).
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const countAfter = await leadCard.count();
  const feedTextAfter = (await feedBadge.innerText().catch(() => '')).trim();
  const shotAfter = await screenshot(page, `news-q${quarter}-after-reload`);

  const entry = {
    quarter,
    quarterInReviewCardPresentBeforeReload: countBefore > 0,
    quarterInReviewCardPresentAfterReload: countAfter > 0,
    feedTabLabelBeforeReload: feedTextBefore,
    feedTabLabelAfterReload: feedTextAfter,
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

  const overallStart = Date.now();
  await foundCompany(page);

  for (let q = 1; q <= QUARTERS; q++) {
    await askChiefOfStaff(page, q, 'how are we doing?');
    await askChiefOfStaff(page, q, 'buy a small data center');
    await resolveQuarter(page, q);
    await checkNews(page, q);
    await page.goto(`${BASE_URL}/command-centre`, { waitUntil: 'networkidle' }).catch(() => {});
  }
  results.timings.totalWallMs = Date.now() - overallStart;

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  log('done. results at', path.join(OUT_DIR, 'results.json'));
})().catch((err) => {
  console.error('HARNESS FAILED', err);
  process.exit(1);
});

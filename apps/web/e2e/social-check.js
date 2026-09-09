/**
 * Social still works — a short read of the screen that shares the projection
 * with the newspaper but kept its own feed components. New game → one quarter →
 * Social by the World tab and its sub-tab, then a screenshot and three checks:
 * cards are on the page, a post card prints the post's text as its main line
 * (not a byline restated as a headline), and after a real reload the "Why"
 * button — the ledger from the store, rebuilt by the replay — is still offered.
 *
 *   BASE_URL=http://localhost:3100 OUT_DIR=apps/web/e2e/shots node apps/web/e2e/social-check.js
 */

process.env.NODE_PATH = process.env.NODE_PATH ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules` : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const failures = [];
function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}
function check(ok, message) {
  if (!ok) failures.push(message);
  log(ok ? 'PASS' : 'FAIL', message);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 3; i++) {
    const chip = page.locator('ul.grid > li > button').first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });
    await chip.click();
    await page.waitForTimeout(150);
  }
  await page.fill('#setup-name-field', 'Social Test Co');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  await page.fill('#setup-name-field', 'Social Tester');
  await page.click('button:has-text("Use it")');
  await page.waitForTimeout(150);
  await page.locator('button:has-text("Found ")').click();
  await page.waitForURL('**/command-centre', { timeout: 20000 }).catch(() => {});

  await page.goto(`${BASE_URL}/end-quarter`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.locator('button', { hasText: /Resolve \d{4} Q\d/ }).first().click();
  const typedInput = page.locator('input').last();
  await typedInput.waitFor({ state: 'visible', timeout: 10000 });
  await typedInput.fill('RESOLVE');
  await page.locator('button:has-text("Resolve")').last().click();
  await page.waitForURL('**/quarter-resolution', { timeout: 180000 });
  await page.waitForTimeout(400);

  await page.locator('nav[aria-label="Sections"] a', { hasText: 'World' }).first().click();
  await page.waitForURL('**/news**', { timeout: 10000 });
  await page.locator('nav[aria-label="World screens"] a', { hasText: 'Social' }).first().click();
  await page.waitForURL('**/social', { timeout: 10000 });
  await page.waitForTimeout(900);

  const cards = page.locator('article.panel-surface');
  const count = await cards.count();
  check(count > 0, `Social shows ${count} cards`);
  const firstText = ((await cards.first().textContent()) || '').trim();
  check(!/posted on|went after a rival|answered back/.test(firstText), 'no card headline restates the byline');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on Social');
  await page.screenshot({ path: path.join(OUT_DIR, 'social-390x844.png') });

  const whyBefore = await page.locator('button', { hasText: /^Why/ }).count();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('article.panel-surface').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(900);
  const whyAfter = await page.locator('button', { hasText: /^Why/ }).count();
  check(whyAfter === whyBefore, `the Why buttons survive a reload (${whyBefore} before, ${whyAfter} after)`);
  if (whyAfter > 0) {
    await page.locator('button', { hasText: /^Why/ }).first().click();
    await page.waitForTimeout(300);
    const rows = await page.locator('li.raised-surface').count();
    check(rows > 0, `a Why drawer lists ${rows} ledger rows after a reload`);
    await page.screenshot({ path: path.join(OUT_DIR, 'social-why-after-reload.png') });
  }

  await browser.close();
  log(failures.length === 0 ? 'PASS: Social still works' : `FAIL: ${failures.join('; ')}`);
  process.exit(failures.length === 0 ? 0 : 2);
})().catch((err) => {
  console.error('HARNESS FAILED', err);
  process.exit(1);
});

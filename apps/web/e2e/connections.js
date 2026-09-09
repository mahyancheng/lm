/**
 * The Connections screens, driven on a phone — a plain Node + Playwright script
 * in the shape of `news-paper.js` (same method notes: the app's own `<Link>`
 * navigation rather than `page.goto()` once the game is running, DOM locators
 * rather than `body.innerText()`, any `pageerror` fails the run).
 *
 * New game → resolve QUARTERS quarters → Products by the bottom tab. Then, at
 * each viewport:
 *   1. the picture: a hub, a margin disc, at least one supplier, no horizontal
 *      scroll, and every pill at least 44 points tall, inside the viewport and
 *      inside the picture's own box;
 *   2. a live supplier tapped → the line drawer opens on that slot's candidate
 *      sheet → "Open market" picked → the validator answers;
 *   3. a customer company tapped, when the seeded world gives this company one
 *      → that company's Connections read-only: a Back row, their name in the
 *      header, and no cost, price or ask on their hub;
 *   4. "Open a line" → What to sell → a node this company already sells (it is
 *      not locked, and it says where it already sells) → Target, which must
 *      default to a market the company does not already serve → Cost to make →
 *      Price, whose placeholder is the line name a blank field would launch as
 *      → Queue launch → the validator answers;
 *   5. Research by the bottom tab → the same picture asked of technology → the
 *      first option pill → the node drawer → Standard → Start the programme →
 *      the validator answers.
 *
 * The seeded Enterprise AI opening has no named buyer of its own line, so step
 * 3 has nothing to tap there. Rather than skip the read-only view — the one
 * place the privacy boundary is drawn in the browser — the script founds a
 * second game on WALK_BACKGROUND (a background that does start with buyers) in
 * its own context and walks the chain there. `results.json` records which game
 * each check ran on.
 *
 * Usage (server started per e2e/README.md):
 *   BASE_URL=http://localhost:3100 node apps/web/e2e/connections.js
 * Optional: OUT_DIR (default apps/web/e2e/shots/connections), QUARTERS
 * (default 2), VIEWPORTS ("390x844,360x780"), BACKGROUND ("Enterprise AI"),
 * WALK_BACKGROUND ("AI Infrastructure").
 */

process.env.NODE_PATH = process.env.NODE_PATH ? `${process.env.NODE_PATH}:/opt/node22/lib/node_modules` : '/opt/node22/lib/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'shots', 'connections');
const QUARTERS = Number(process.env.QUARTERS || 2);
const BACKGROUND = process.env.BACKGROUND || 'Enterprise AI';
const WALK_BACKGROUND = process.env.WALK_BACKGROUND || 'AI Infrastructure';
const VIEWPORTS = (process.env.VIEWPORTS || '390x844,360x780').split(',').map((entry) => {
  const [w, h] = entry.split('x').map(Number);
  return { width: w, height: h };
});
/** The phone's minimum comfortable target. Every pill is a button, so every pill owes it. */
const MIN_TAP_PX = 44;

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = { baseUrl: BASE_URL, background: BACKGROUND, walkBackground: WALK_BACKGROUND, quarters: QUARTERS, viewports: [], walk: null, texts: {} };
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
/** One line per pill: side, state, key and the words on it, straight off the DOM. */
async function readPills(page) {
  return page.locator('[data-testid="conn-pill"]').evaluateAll((els) =>
    els.map((el) => ({
      side: el.dataset.side,
      state: el.dataset.state,
      key: el.dataset.key,
      text: el.innerText.replace(/\s*\n\s*/g, ' · ').trim(),
      aria: el.getAttribute('aria-label'),
    })),
  );
}

/* -------------------------------------------------------------------------- */
/*  Starting a game                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The setup chat asks three questions as chip grids — sector, region, opening.
 * Whichever grid carries the wanted background is answered with it; the rest
 * take their first chip, which is what a founder in a hurry does.
 */
async function foundCompany(page, background, companyName) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  for (let step = 0; step < 3; step++) {
    const chips = page.locator('ul.grid > li > button');
    await chips.first().waitFor({ state: 'visible', timeout: 20000 });
    const wanted = page.locator('ul.grid > li > button', { hasText: background });
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
  await foundBtn.waitFor({ state: 'visible', timeout: 15000 });
  await foundBtn.click();
  await page.waitForURL('**/home', { timeout: 30000 }).catch(() => {});
  log('founded', companyName, 'on', background, '→', page.url());
}

/**
 * The desk is the Play tab and the report a sheet over it: the sticky bar arms
 * the confirmation, the typed word commits it, and the report is closed again
 * so the tab bar beneath is tappable for the next step.
 */
async function resolveQuarter(page, quarter) {
  await page.goto(`${BASE_URL}/play`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const resolveBtn = page.locator('button[aria-label^="Resolve "]').last();
  await resolveBtn.waitFor({ state: 'visible', timeout: 15000 });
  await resolveBtn.click();
  const typedInput = page.locator('[role="dialog"] input').last();
  await typedInput.waitFor({ state: 'visible', timeout: 10000 });
  await typedInput.fill('RESOLVE');
  await page.locator('[role="dialog"] button:has-text("Resolve")').last().click();
  await page.waitForURL((url) => url.pathname === '/play' && url.searchParams.get('sheet') === 'resolution', { timeout: 180000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  log('resolved quarter', quarter);
}

/**
 * Reach a subject the way a thumb does: the bottom tab that owns it, then the
 * card's own control. There is no sub-tab strip — Products and Research are two
 * cards on Company, each opening a sheet addressed by `?sheet=`.
 */
async function openScreen(page, tabLabel, sheetTitle, sheetId) {
  // A sheet stands over the whole tab, scrim and all, so the bar underneath it
  // is not clickable until it is closed — Back, or the phone's back gesture,
  // is the way out of a sheet, and Escape is that gesture here.
  for (let attempt = 0; attempt < 4 && (await dialogCount(page)) > 0; attempt++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  const tab = page.locator('nav[aria-label="Sections"] a', { hasText: new RegExp(`^${tabLabel}\\d*$`) }).first();
  await tab.waitFor({ state: 'visible', timeout: 15000 });
  await tab.click();
  await page.waitForTimeout(500);
  const open = page.locator(`main a[aria-label="Open ${sheetTitle}"]`).first();
  await open.waitFor({ state: 'visible', timeout: 15000 });
  await open.click();
  await page.waitForURL((url) => url.searchParams.get('sheet') === sheetId, { timeout: 15000 });
  await page.waitForTimeout(500);
}

/**
 * The drawer the thumb is actually in.
 *
 * Products and Research are themselves sheets now — `?sheet=products` over the
 * Company tab — so `[role="dialog"]` always matches that sheet *under* any
 * detail drawer opened on top of it. `.first()` therefore aims at the sheet's
 * own header, whose controls sit behind the inner drawer's scrim and swallow
 * every click. Two rules follow, and both are kept everywhere below: address
 * the **innermost** dialog, and measure "the drawer closes" against the number
 * standing open when the screen is at rest, never against zero.
 */
function innerDialog(page) {
  return page.locator('[role="dialog"]').last();
}
function dialogCount(page) {
  return page.locator('[role="dialog"]').count();
}
/** Wait until one more dialog stands open than `rest`, then return it. */
async function waitForInnerDialog(page, rest) {
  await page.waitForFunction((open) => document.querySelectorAll('[role="dialog"]').length > open, rest, {
    timeout: 10000,
  });
  return innerDialog(page);
}

/* -------------------------------------------------------------------------- */
/*  The picture                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Geometry every pill owes a thumb, and every word owes a reader.
 *
 * Two halves. The boxes: 44 points tall, inside the viewport, inside the
 * picture's own frame. And the **words in them** — which is the half a critic
 * pass found missing, when every geometry check here passed while the screen
 * printed "MODEL · 40 1…", "67,32…", "1…" and a market pill whose qualifying
 * word "wanted" was allotted zero points. A truncation is now a failure, not a
 * note: `scrollWidth > clientWidth` on a header, a recipe or a data row, and
 * `scrollHeight > clientHeight` on a two-line clamped name, are each measured
 * per element and each fail the run.
 */
async function checkPillGeometry(page, viewport, label, entry, screen) {
  const measured = await page.evaluate(() => {
    const cut = (el) => ({
      text: (el.textContent || '').trim(),
      client: el.clientWidth,
      scroll: el.scrollWidth,
      overflowPx: el.scrollWidth - el.clientWidth,
    });
    const diagram = document.querySelector('[data-testid="connections"]');
    const frame = diagram.getBoundingClientRect();
    const parent = diagram.parentElement.getBoundingClientRect();
    const pills = [...document.querySelectorAll('[data-testid="conn-pill"]')].map((el) => {
      const rect = el.getBoundingClientRect();
      const name = el.querySelector('[data-testid="conn-pill-name"]');
      const detail = el.querySelector('[data-testid="conn-pill-detail"]');
      return {
        key: el.dataset.key,
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        insetLeft: Math.round(rect.left - frame.left),
        insetRight: Math.round(rect.right - frame.left),
        // A clamped name is cut two ways: sideways by a word wider than the box,
        // and downwards by a third line the clamp drops.
        name: name === null ? null : { ...cut(name), overflowRows: name.scrollHeight - name.clientHeight },
        detail: detail === null ? null : cut(detail),
      };
    });
    const headers = [...document.querySelectorAll('[data-testid="conn-header"]')].map((el) => {
      const name = el.querySelector('[data-testid="conn-header-name"]');
      const recipe = el.querySelector('[data-testid="conn-header-recipe"]');
      const row = el.firstElementChild;
      return {
        text: el.innerText.replace(/\s*\n\s*/g, ' ').trim(),
        overflowPx: Math.max(
          name === null ? 0 : name.scrollWidth - name.clientWidth,
          recipe === null ? 0 : recipe.scrollWidth - recipe.clientWidth,
          row === null ? 0 : row.scrollWidth - row.clientWidth,
        ),
      };
    });
    return {
      frameWidth: Math.round(frame.width),
      parentWidth: Math.round(parent.width),
      pictureHeight: Math.round(frame.height),
      pageHeight: document.documentElement.scrollHeight,
      pills,
      clippedHeaders: headers.filter((header) => header.overflowPx > 1),
    };
  });
  const short = measured.pills.filter((box) => box.height < MIN_TAP_PX);
  const outside = measured.pills.filter((box) => box.right > viewport.width + 1 || box.left < -1);
  const spilling = measured.pills.filter((box) => box.insetRight > measured.frameWidth + 1 || box.insetLeft < -1);
  const cutNames = measured.pills.filter((box) => box.name !== null && (box.name.overflowPx > 1 || box.name.overflowRows > 1));
  const cutDetails = measured.pills.filter((box) => box.detail !== null && box.detail.overflowPx > 1);
  // Namespaced by screen: Products and Research are measured into one entry, and
  // a shared key would let the second pass erase the first one's findings.
  entry.geometry = entry.geometry || {};
  entry.geometry[screen] = {
    pillCount: measured.pills.length,
    diagramWidth: measured.frameWidth,
    diagramParentWidth: measured.parentWidth,
    pictureHeight: measured.pictureHeight,
    pageHeight: measured.pageHeight,
    clippedHeaders: measured.clippedHeaders,
    clippedNames: cutNames.map((box) => ({ key: box.key, ...box.name })),
    clippedDetails: cutDetails.map((box) => ({ key: box.key, ...box.detail })),
    shortPills: short,
    pillsOutsideViewport: outside,
    pillsOutsideDiagram: spilling,
  };
  check(short.length === 0, `${label}: every pill is at least ${MIN_TAP_PX}px tall (${short.length} short: ${JSON.stringify(short.slice(0, 3))})`);
  check(outside.length === 0, `${label}: every pill sits inside ${viewport.width}px (${outside.length} outside: ${JSON.stringify(outside.slice(0, 3))})`);
  check(
    spilling.length === 0 && measured.frameWidth <= measured.parentWidth + 1,
    `${label}: the picture fits its panel (${measured.frameWidth} of ${measured.parentWidth}px, ${spilling.length} pill(s) over the edge)`,
  );
  check(
    measured.clippedHeaders.length === 0,
    `${label}: every group header and recipe fits its box (${JSON.stringify(measured.clippedHeaders.slice(0, 3))})`,
  );
  check(cutNames.length === 0, `${label}: no pill name is cut (${JSON.stringify(entry.geometry[screen].clippedNames.slice(0, 3))})`);
  check(cutDetails.length === 0, `${label}: no data row is cut (${JSON.stringify(entry.geometry[screen].clippedDetails.slice(0, 3))})`);
}

async function driveProducts(page, viewport, label, entry) {
  await openScreen(page, 'Company', 'Products', 'products');
  const diagram = page.locator('[data-testid="connections"]');
  await diagram.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(400);

  const left = page.locator('[data-testid="conn-pill"][data-side="left"]');
  entry.leftPills = await left.count();
  check(entry.leftPills >= 1, `${label}: the supplier column has ${entry.leftPills} pill(s)`);
  check((await page.locator('[data-testid="conn-hub"]').count()) > 0, `${label}: the hub is drawn`);
  check((await page.locator('[data-testid="conn-margin"]').count()) > 0, `${label}: the margin disc is drawn`);
  entry.hubFigures = (await page.locator('[data-testid="conn-hub-figures"]').innerText()).replace(/\s*\n\s*/g, ' · ').trim();
  entry.marginDisc = (await page.locator('[data-testid="conn-margin"] text').textContent()) || '';
  check(await noHorizontalScroll(page), `${label}: Products never scrolls sideways`);
  await checkPillGeometry(page, viewport, `${label}: Products`, entry, "products");
  entry.pills = await readPills(page);
  entry.shots = entry.shots || {};
  entry.shots.products = await shot(page, `${label}-1-products`);
  entry.shots.productsFull = await shot(page, `${label}-1b-products-full`, true);
  results.texts.supplierPill = results.texts.supplierPill ?? (entry.pills.find((pill) => pill.side === 'left' && pill.state === 'live') ?? null);
  results.texts.marketPill = results.texts.marketPill ?? (entry.pills.find((pill) => pill.side === 'right') ?? null);
  results.texts.hubFigures = results.texts.hubFigures ?? entry.hubFigures;
  results.texts.marginDisc = results.texts.marginDisc ?? entry.marginDisc;

  /* --- a live supplier → the slot sheet → Open market --------------------- */
  const liveSupplier = page.locator('[data-testid="conn-pill"][data-side="left"][data-state="live"]').first();
  check((await liveSupplier.count()) > 0, `${label}: there is a live supplier to tap`);
  if ((await liveSupplier.count()) > 0) {
    entry.tappedSupplier = (await liveSupplier.getAttribute('aria-label')) || '';
    const rest = await dialogCount(page);
    await liveSupplier.click();
    const dialog = await waitForInnerDialog(page, rest);
    await page.waitForTimeout(400);
    const sheetBack = dialog.locator('button:has-text("Back")').first();
    check((await sheetBack.count()) > 0, `${label}: the slot's candidate sheet opened on the tapped slot`);
    entry.shots.slotSheet = await shot(page, `${label}-2-slot-sheet`);
    const market = dialog.locator('button:has-text("Open market")').first();
    check((await market.count()) > 0, `${label}: the sheet offers the open market as a route`);
    if ((await market.count()) > 0) {
      await market.click();
      await page.waitForTimeout(500);
      const banner = dialog.locator('text=/Accepted|Clamped|Rejected/').first();
      const answered = (await banner.count()) > 0;
      entry.slotBanner = answered ? ((await banner.textContent()) || '').trim() : null;
      check(answered, `${label}: the validator answered the fill (${entry.slotBanner})`);
      entry.shots.slotBanner = await shot(page, `${label}-2b-slot-banner`);
    }
    await dialog.locator('button[aria-label="Close"]').first().click();
    await page.waitForTimeout(400);
    check((await dialogCount(page)) === rest, `${label}: the drawer closes back to the sheet (${await dialogCount(page)} of ${rest})`);
  }

  /* --- a market pill opens the drawer *at* the Target section -------------- */
  // "Change the target market" that lands 800 points above the Target section
  // is preselected but not reachable, which is the same as not preselected.
  const marketPill = page.locator('[data-testid="conn-pill"][data-side="right"][data-key^="cell:"]').first();
  if ((await marketPill.count()) > 0) {
    const rest = await dialogCount(page);
    await marketPill.click();
    const dialog = await waitForInnerDialog(page, rest);
    await page.waitForTimeout(600);
    const target = dialog.locator('[data-testid="line-target-section"]').first();
    const placed = (await target.count()) > 0;
    check(placed, `${label}: a market pill opens the line drawer on its Target section`);
    if (placed) {
      const seen = await target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const scroller = el.closest('[role="dialog"]');
        const frame = scroller === null ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
        return { offset: Math.round(box.top - frame.top), frameHeight: Math.round(frame.height) };
      });
      entry.targetSectionOffset = seen.offset;
      check(
        seen.offset >= -8 && seen.offset < seen.frameHeight,
        `${label}: the Target section is on screen when the drawer opens (${seen.offset}px into a ${seen.frameHeight}px drawer)`,
      );
      entry.shots.aimDrawer = await shot(page, `${label}-2c-aim-drawer`);
    }
    await dialog.locator('button[aria-label="Close"]').first().click();
    await page.waitForTimeout(400);
  }

  /* --- a customer company, when this opening has one ---------------------- */
  // A buyer pill for one of my *own* lines only switches lines; the walk needs a
  // named counterparty.
  const buyer = page
    .locator('[data-testid="conn-pill"][data-side="right"][data-key^="buyer:"]')
    .filter({ hasNotText: 'Your own line' })
    .first();
  entry.hasCustomerCompany = (await buyer.count()) > 0;
  if (entry.hasCustomerCompany) await walkToRival(page, label, entry, buyer);

  /* --- Open a line -------------------------------------------------------- */
  await driveLaunch(page, label, entry);
}

/**
 * Following the chain: a customer company opens their Connections read-only.
 * Their picture is public relationships only — the assertion that matters is
 * that their hub carries no cost, price or ask.
 */
async function walkToRival(page, label, entry, pill) {
  entry.walkedTo = (await pill.getAttribute('aria-label')) || '';
  // The name as it is printed on the pill, not as the aria sentence says it:
  // the header has to carry the words the thumb just touched.
  const rivalName = ((await pill.innerText()) || '').split('\n')[0].trim();
  await pill.click();
  await page.waitForTimeout(600);
  const back = page.locator('[data-testid="connections-back"]');
  check((await back.count()) > 0, `${label}: a customer pill opens their Connections with a Back row`);
  const panelTitles = await page.locator('h2, h3').allTextContents();
  entry.rivalPanelTitles = panelTitles.map((text) => text.trim()).filter((text) => text.length > 0);
  entry.rivalName = rivalName;
  check(
    rivalName.length > 0 && entry.rivalPanelTitles.some((title) => title.includes(rivalName)),
    `${label}: the rival's name is in the header (${rivalName} in ${JSON.stringify(entry.rivalPanelTitles)})`,
  );
  const hubFigures = (await page.locator('[data-testid="conn-hub-figures"]').innerText()).trim();
  entry.rivalHubFigures = hubFigures;
  check(!hubFigures.includes('$'), `${label}: the rival's hub carries no money figure (${JSON.stringify(hubFigures)})`);
  check(await noHorizontalScroll(page), `${label}: the rival's picture never scrolls sideways`);
  // "Open a line" over somebody else's picture reads as though the button
  // belongs to the company on screen, and it opens my own launch flow.
  entry.rivalOpenALine = await page.locator('button:has-text("Open a line")').count();
  check(entry.rivalOpenALine === 0, `${label}: "Open a line" is not offered over a rival's picture`);
  entry.rivalPills = await readPills(page);
  entry.shots.rival = await shot(page, `${label}-3-rival-connections`);
  entry.shots.rivalFull = await shot(page, `${label}-3b-rival-full`, true);
  await walkHomeFromRival(page, label, entry);
  await page.locator('[data-testid="connections-back"]').click();
  await page.waitForTimeout(500);
  check((await page.locator('[data-testid="connections-back"]').count()) === 0, `${label}: Back returns to your own company`);
}

/**
 * The walk that used to strand: a rival's slot filled by my own company.
 *
 * Tapping it pushes my own id onto the stack, and reading "is this me" off the
 * subject alone hid the Back row on exactly that screen — two entries deep,
 * with no way back to the rival. Back has to survive, and it has to return to
 * the rival rather than to my own company.
 */
async function walkHomeFromRival(page, label, entry) {
  const mine = page.locator('[data-testid="conn-pill"][data-side="left"]').filter({ hasText: entry.companyName }).first();
  entry.rivalBuysFromMe = (await mine.count()) > 0;
  if (!entry.rivalBuysFromMe) {
    log('note', `${label}: this rival buys nothing from me, so the walk-home case has nothing to tap`);
    return;
  }
  entry.walkHomeAria = (await mine.getAttribute('aria-label')) || '';
  check(
    entry.walkHomeAria.includes('your own'),
    `${label}: my own company on a rival's picture says whose connections open (${entry.walkHomeAria})`,
  );
  await mine.click();
  await page.waitForTimeout(600);
  const back = page.locator('[data-testid="connections-back"]');
  check((await back.count()) > 0, `${label}: walking to my own company from a rival keeps a way back`);
  entry.shots.walkHome = await shot(page, `${label}-3c-walked-home`);
  if ((await back.count()) > 0) {
    await back.click();
    await page.waitForTimeout(500);
    const titles = (await page.locator('h2, h3').allTextContents()).map((text) => text.trim());
    check(
      titles.some((title) => title.includes(entry.rivalName)),
      `${label}: Back from my own company returns to ${entry.rivalName} (${JSON.stringify(titles.slice(0, 4))})`,
    );
  }
}

/**
 * The multi-line launch: a node this company already sells must be openable
 * again, and the Target step must open on a market it does not already serve.
 */
async function driveLaunch(page, label, entry) {
  const rest = await dialogCount(page);
  await page.locator('button:has-text("Open a line")').first().click();
  const dialog = await waitForInnerDialog(page, rest);
  await page.waitForTimeout(400);
  const step0 = dialog.locator('button:has-text("What to sell")').first();
  check((await step0.count()) > 0, `${label}: the launch flow opens on "What to sell"`);
  entry.shots.launchWhatToSell = await shot(page, `${label}-4-launch-what-to-sell`);

  // The row for a node already sold says so; that row must not also be locked.
  const openRow = dialog.locator('ul > li > button', { hasText: 'You sell this into' }).first();
  entry.hasAlreadySoldRow = (await openRow.count()) > 0;
  check(entry.hasAlreadySoldRow, `${label}: a node the company already sells is offered again, with its caption`);
  if (!entry.hasAlreadySoldRow) {
    await dialog.locator('button[aria-label="Close"]').first().click();
    return;
  }
  entry.alreadySoldRow = ((await openRow.innerText()) || '').replace(/\s*\n\s*/g, ' · ').trim();
  check(!/\bLocked\b/.test(entry.alreadySoldRow), `${label}: that row is not locked (${entry.alreadySoldRow})`);
  await openRow.click();
  await page.waitForTimeout(400);
  entry.shots.launchInputs = await shot(page, `${label}-4b-launch-inputs`);

  await dialog.locator('button:has-text("Aim it")').first().click();
  await page.waitForTimeout(400);
  const aimSentence = ((await dialog.locator('p.rounded-card').first().textContent()) || '').trim();
  entry.launchTargetSentence = aimSentence;
  check(
    aimSentence.length > 0 && !aimSentence.includes('already sells there'),
    `${label}: Target opens on a market this company does not already serve (${aimSentence})`,
  );
  entry.shots.launchTarget = await shot(page, `${label}-4c-launch-target`);

  await dialog.locator('button:has-text("Cost it")').first().click();
  await page.waitForTimeout(400);
  entry.shots.launchCost = await shot(page, `${label}-4d-launch-cost`);
  await dialog.locator('button:has-text("Set a price")').first().click();
  await page.waitForTimeout(400);
  const placeholder = await dialog.locator('input[placeholder]').first().getAttribute('placeholder');
  entry.launchLineNamePlaceholder = placeholder;
  check(typeof placeholder === 'string' && placeholder.length > 0, `${label}: the blank line name shows what it would launch as (${placeholder})`);
  entry.shots.launchPrice = await shot(page, `${label}-4e-launch-price`);

  await dialog.locator('button:has-text("Queue launch")').first().click();
  await page.waitForTimeout(600);
  const banner = dialog.locator('text=/Accepted|Clamped|Rejected/').first();
  const answered = (await banner.count()) > 0;
  entry.launchBanner = answered ? ((await banner.textContent()) || '').trim() : null;
  check(answered, `${label}: the validator answered the launch (${entry.launchBanner})`);
  entry.shots.launchQueued = await shot(page, `${label}-4f-launch-queued`);
  await dialog.locator('button[aria-label="Close"]').first().click();
  await page.waitForTimeout(400);
}

/* -------------------------------------------------------------------------- */
/*  Research                                                                   */
/* -------------------------------------------------------------------------- */

async function driveResearch(page, viewport, label, entry) {
  await openScreen(page, 'Company', 'Research', 'research');
  const diagram = page.locator('[data-testid="connections"]').first();
  await diagram.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(500);
  // Research draws the Products picture, so it carries the same testid; what
  // tells them apart is the panel it sits in.
  const panelTitles = (await page.locator('h2, h3').allTextContents()).map((text) => text.trim());
  entry.researchPanelTitles = panelTitles.filter((text) => text.length > 0);
  check(entry.researchPanelTitles.includes('Your research'), `${label}: Research draws the Connections picture under "Your research"`);
  check(await noHorizontalScroll(page), `${label}: Research never scrolls sideways`);
  await checkPillGeometry(page, viewport, `${label}: Research`, entry, "research");
  entry.researchPills = await readPills(page);
  const options = entry.researchPills.filter((pill) => pill.side === 'right' && pill.key.startsWith('option_'));
  const unlocks = entry.researchPills.filter((pill) => pill.side === 'right' && pill.key.startsWith('unlock_'));
  check(options.length > 0, `${label}: Research offers ${options.length} programme(s) on the right`);
  results.texts.researchOption = results.texts.researchOption ?? (options[0] ?? null);
  results.texts.researchUnlock = results.texts.researchUnlock ?? (unlocks[0] ?? null);
  entry.shots.research = await shot(page, `${label}-5-research`);
  entry.shots.researchFull = await shot(page, `${label}-5b-research-full`, true);

  if (options.length === 0) return;
  const option = page.locator(`[data-testid="conn-pill"][data-key="${options[0].key}"]`).first();
  entry.tappedOption = options[0].text;
  const rest = await dialogCount(page);
  await option.click();
  const dialog = await waitForInnerDialog(page, rest);
  await page.waitForTimeout(500);
  entry.shots.nodeDrawer = await shot(page, `${label}-6-node-drawer`);
  const standard = dialog.locator('button[aria-pressed]', { hasText: 'Standard' }).first();
  check((await standard.count()) > 0, `${label}: the node drawer offers the Standard preset`);
  if ((await standard.count()) > 0) {
    await standard.click();
    await page.waitForTimeout(300);
  }
  const start = dialog.locator('button:has-text("Start the programme")').first();
  check((await start.count()) > 0, `${label}: the node drawer offers to start the programme`);
  if ((await start.count()) > 0) {
    await start.click();
    await page.waitForTimeout(700);
    const banner = dialog.locator('text=/Accepted|Clamped|Rejected/').first();
    const answered = (await banner.count()) > 0;
    entry.researchBanner = answered ? ((await banner.textContent()) || '').trim() : null;
    check(answered, `${label}: the validator answered the programme (${entry.researchBanner})`);
    entry.shots.researchBanner = await shot(page, `${label}-6b-research-banner`);
  }
  await dialog.locator('button[aria-label="Close"]').first().click();
  await page.waitForTimeout(400);
}

/* -------------------------------------------------------------------------- */
/*  The run                                                                    */
/* -------------------------------------------------------------------------- */

function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console error:', msg.text());
  });
  page.on('pageerror', (err) => {
    failures.push(`page error: ${err.message}`);
    log('page error:', err.message);
  });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORTS[0] });
  const page = await context.newPage();
  watch(page);

  const COMPANY_NAME = 'Harbourline Test Co';
  await foundCompany(page, BACKGROUND, COMPANY_NAME);
  for (let q = 1; q <= QUARTERS; q++) await resolveQuarter(page, q);
  await page.goto(`${BASE_URL}/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  let sawCustomerCompany = false;
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    const entry = { viewport: label, companyName: COMPANY_NAME, shots: {} };
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    await driveProducts(page, viewport, label, entry);
    await driveResearch(page, viewport, label, entry);
    sawCustomerCompany = sawCustomerCompany || entry.hasCustomerCompany === true;
    results.viewports.push(entry);
    log('viewport done', label);
  }

  // The read-only rival view, on a game that actually has a customer company.
  if (!sawCustomerCompany) {
    log(`no customer company on ${BACKGROUND}; walking the chain on ${WALK_BACKGROUND}`);
    const walkContext = await browser.newContext({ viewport: VIEWPORTS[0] });
    const walkPage = await walkContext.newPage();
    watch(walkPage);
    const label = `walk-${VIEWPORTS[0].width}x${VIEWPORTS[0].height}`;
    const WALK_COMPANY = 'Northgate Capacity Co';
    const entry = { viewport: label, background: WALK_BACKGROUND, companyName: WALK_COMPANY, shots: {} };
    await foundCompany(walkPage, WALK_BACKGROUND, WALK_COMPANY);
    for (let q = 1; q <= QUARTERS; q++) await resolveQuarter(walkPage, q);
    await walkPage.goto(`${BASE_URL}/home`, { waitUntil: 'domcontentloaded' });
    await walkPage.waitForTimeout(700);
    await openScreen(walkPage, 'Company', 'Products', 'products');
    await walkPage.locator('[data-testid="connections"]').waitFor({ state: 'visible', timeout: 20000 });
    await walkPage.waitForTimeout(500);
    const buyer = walkPage
      .locator('[data-testid="conn-pill"][data-side="right"][data-key^="buyer:"]')
      .filter({ hasNotText: 'Your own line' })
      .first();
    entry.hasCustomerCompany = (await buyer.count()) > 0;
    check(entry.hasCustomerCompany, `${label}: ${WALK_BACKGROUND} opens with a named buyer to walk to`);
    entry.pills = await readPills(walkPage);
    entry.shots.products = await shot(walkPage, `${label}-1-products`);
    if (entry.hasCustomerCompany) await walkToRival(walkPage, label, entry, buyer);
    results.walk = entry;
    await walkContext.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ ...results, failures }, null, 2));
  log('done. results at', path.resolve(path.join(OUT_DIR, 'results.json')));
  log(failures.length === 0 ? 'PASS: the Connections screens drive as designed' : `FAIL: ${failures.length} check(s) failed`);
  process.exit(failures.length === 0 ? 0 : 2);
})().catch((err) => {
  console.error('HARNESS FAILED', err);
  process.exit(1);
});

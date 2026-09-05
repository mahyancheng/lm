# Stage 0 reproduction harness

`stage0-repro.js` is a plain Node + Playwright script (no `@playwright/test`
dependency — this environment ships `playwright` globally at
`/opt/node22/lib/node_modules`) that drives Chromium at a 390×844 viewport
through: found a company → for each quarter, ask the Chief of Staff twice,
resolve the quarter, check the news screen before and after a real reload.
It writes screenshots and a `results.json` to `OUT_DIR`.

## Running it

1. Build once: `pnpm --filter @frontier/web build`
2. Start a server (pick one; port must match `BASE_URL`):
   - Engine + UI only, no model calls:
     `NEXT_PUBLIC_DEMO_MODE=true LLM_TRANSPORT=none pnpm --filter @frontier/web start -p 3100`
   - Live-model path, as a Pi with a dropped/expired credential fails:
     `NEXT_PUBLIC_DEMO_MODE=true LLM_TRANSPORT=claude-session CLAUDE_CODE_OAUTH_TOKEN=invalid pnpm --filter @frontier/web start -p 3101`
     — **caveat**: in an environment where the `claude` CLI is already
     logged in (as this one was), the SDK transport uses that ambient login
     regardless of what `CLAUDE_CODE_OAUTH_TOKEN` is set to, so this does
     **not** reproduce "no credential" locally — it reproduces a real,
     working call instead. There is no environment-variable way around this
     from outside the sandbox; the true "dropped credential" failure can only
     be observed on a host with no `claude login` and no valid token at all.
3. Run: `BASE_URL=http://localhost:3100 OUT_DIR=/tmp/stage0-none node apps/web/e2e/stage0-repro.js`
   (optionally `QUARTERS=<n>`, default 3)

## Method notes (read before trusting a "not present" result)

- **Presence checks use a DOM locator's `.count()`, never
  `page.locator('body').innerText()`.** On this app's longer pages (an
  11,000+ px tall news feed, for instance) Chromium's `innerText()` can
  under-report content that `boundingBox()`, `isVisible()` and a screenshot
  all confirm is genuinely on screen — verified directly during this
  investigation (same page, same instant: `span.isVisible()` was `true` and
  a screenshot showed the card, while `body.innerText()` omitted its text).
  Token/snake_case scanning on the resolution screen uses `textContent()` for
  the same reason.
- News-feed navigation between screens uses the app's own `<Link>` (the phone
  bottom-tab bar groups News under "World"), not `page.goto()` — a `goto()`
  is a real browser navigation and destroys the same in-memory state a real
  reload does, which would conflate "just navigated here" with "reloaded the
  tab" — two states the owner's report explicitly distinguishes.
- The end-quarter flow submits with an **empty** action queue (nothing typed
  or confirmed) — resolving a quarter with nothing queued is legal in this
  app, so this measures the floor cost of *resolving*, not of validating a
  large queue.

## What was found running this (2026-09-03, this sandbox)

See the reproduction summary in the Stage 0 write-up. In short:
`results.json` under `OUT_DIR` records, per quarter: Chief of Staff latency
and whether "No model reached" showed; the resolution screen's wall time and
any raw snake_case/enum tokens found in its text; and whether the "Quarter in
review" card was present before/after a real reload.

# Stage 3 verification harness

`stage3-repro.js` follows the same shape and the same method notes as
`stage0-repro.js` above (plain Node + Playwright, `textContent()` not
`innerText()`, client-side `<Link>` navigation rather than `page.goto()`), and
targets what Stage 3 fixed specifically:

- The resolution screen — headline, every section's lines, and a couple of
  opened ledger drawers — scanned for a raw `snake_case` token, expected to
  come back empty on every quarter.
- The news screen: the "Quarter in review" card's presence, the feed's item
  count, and the feed's position ahead of the World section in document order,
  all captured before and after a real `page.reload()` and asserted
  unchanged — not merely "still there", but *the same*.

Run it the same way, against a server started per the steps above:

```
BASE_URL=http://localhost:3100 OUT_DIR=/tmp/stage3-none node apps/web/e2e/stage3-repro.js
```

It prints a `PASS`/`FAIL` line for each of the two checks in addition to
writing `results.json` and before/after screenshots to `OUT_DIR`.

# The newspaper harness

`news-paper.js` reads the News screen the way a reader would, after the front
page became a newspaper (masthead, section strip, lead, second tier, briefs,
earlier editions): new game → three quarters → News by the bottom tab, then at
each viewport (390×844 and 360×780 by default) it screenshots the front page
above the fold, the second tier and the briefs, the lead opened in full, The
Street, World and its map, Mine toggled on, and a real reload — asserting the
lead headline is above the fold, masthead + strip are under 120px, the page
never scrolls horizontally, the section and the Mine toggle persist in the URL
across the reload, and the opened story's "Sources" still lists committed
ledger rows afterwards (the ledger is rebuilt by the replay, not held over from
`lastOutcome`). It also checks that no headline is printed twice under one
byline (a post the market heard as a disclosure is one item), that the lead and
the tier are not all earnings filings, that a Sources row prints no raw id and
opens the ledger row on a tap, that the story body is one column on a phone,
and that the section survives a trip through the Social sub-tab and back by
the app's own News tab. Any `pageerror` fails the run. Waits are on the DOM, not
`networkidle`: with `LLM_TRANSPORT=none` the client's health polling never goes
idle. Note that `/news` is client-rendered: `useSearchParams` bails the static
prerender out, so `curl /news` returns the shell and a bail-out marker, and the
paper is laid out in the browser behind the shell's replay overlay.

```
BASE_URL=http://localhost:3100 OUT_DIR=apps/web/e2e/shots node apps/web/e2e/news-paper.js
```

Screenshots land in `apps/web/e2e/shots/` (gitignored) with a `results.json`.
`social-check.js` runs against the same server and confirms Social — which
kept its own feed components — still renders cards, prints a post's own text
rather than a byline restated as a headline, and still offers the "Why"
ledger button after a real reload.
`stage3-repro.js` predates the newspaper and still looks for the "Quarter in
review" card, which no longer exists; it is kept as the record of that stage.

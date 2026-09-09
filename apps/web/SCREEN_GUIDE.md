# Screen Guide

The contract between the application shell, its four rooms, the Plan action and the sheet bodies.

Everything in this document is built and green: the engine runs in the browser,
the store wraps it, the primitives are written, and every room, Plan and sheet renders.
Your job is to write one surface — a room, Plan, or one sheet body.

**Read this whole file before writing a surface.** Half of it is rules that stop
a surface from leaking private state or inventing a number, and those are
invariants, not style preferences.

---

## 1. What you own

The game has **four primary rooms** and one persistent **Plan** action. Each
room is a scrolling decision surface; every drill-down is a **sheet** over the
room that owns it. Plan is the review-and-advance step rather than a fifth
subject.

| Place | Route file | Body |
|---|---|---|
| Today | `src/app/(game)/home/page.tsx` | `components/screens/tabs/HomeTab.tsx` |
| Build | `src/app/(game)/company/page.tsx` | `components/screens/tabs/CompanyTab.tsx` |
| Power | `src/app/(game)/market/page.tsx` | `components/screens/tabs/MarketTab.tsx` |
| World | `src/app/(game)/world/page.tsx` | `components/screens/tabs/WorldTab.tsx` |
| Plan action | `src/app/(game)/play/page.tsx` | `components/screens/tabs/PlayTab.tsx` |

Every subject that used to be a route of its own is now a **sheet body** under
`src/components/screens/<subject>/<Subject>Screen.tsx`, named in
`src/lib/sheets.ts` and switched on by `components/shell/SheetHost.tsx`:

| Place | Sheets |
|---|---|
| Build | Company, Group, Products, People, Research, Government, Financials |
| Power | Markets, Capital, Portfolio, The Street, Deal Room, Boardroom |
| World | News, Social, Network, Leaderboard, Sector |
| Plan | Quarter Resolution, Chief of Staff |

Today owns no sheet. It briefs the player and routes each decision to the room
or sheet where it can be resolved.

All twenty-two old addresses still resolve. `app/(game)/[...legacy]/page.tsx`
looks the first segment up in `LEGACY_ROUTES` and replaces onto the new one;
an unknown segment is a real 404. **Never write a legacy path into a
component** — `legacyHref()` and `sheetHref()` in `lib/sheets.ts` are the only
places one belongs, and `shell/legacyLinks.test.ts` fails a build that does.

You may add screen-local components under
`src/components/screens/<subject>/`. Do **not** edit:

- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- `src/lib/**`, `src/components/ui/**`, `src/components/shell/**`
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`

If a primitive is missing something you need, compose it locally out of what
exists rather than editing the primitive — three agents share those files.

---

## 2. Page skeleton

**A room is a page of decisions.** Today leads with priorities, Build with work
and constraints, Power with live situations, and World with signals and
consequences. State the useful figures before a tap, explain why a matter needs
attention, and give it one clear next action. Plan previews every queued move
and its known effect before the quarter can advance.

Use progressive detail: the default surface says what matters and what to do;
an expansion shows drivers and trade-offs; a sheet carries the full table or
graph; an audit drawer carries ledger rows and diagnostics. Do not lead copy
with validators, invariants, transport kinds, phase counts, hashes or row counts.

**A sheet body renders no `PageHeader`.** The sheet's own header carries the
title and the Back control; a body that drew a second one drew it twice. What
used to be the header's `actions` becomes the first flex-wrap row of the body.

The shell supplies the status bar, the bottom bar, `SheetHost`, the Chief of
Staff dock and the resolving overlay; neither a room nor a sheet body renders
chrome or a page background. A room may use a single layout wrapper. A sheet
body normally returns a fragment because the sheet host already owns its frame.

```tsx
'use client';

import { Panel, StatCard } from '@/components/ui';
import { useActiveCompany, useSession } from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import { formatMoney } from '@frontier/shared';

export function CompanyTab(): React.JSX.Element {
  const session = useSession();
  const company = useActiveCompany();

  return (
    <>
      {/* A card: its figures, then one address. */}
      <Panel title="Financials" iconName="ledger" actions={<Link href={sheetHref('financials')}>Open</Link>}>
        <StatCard label="Revenue" value={formatMoney(company.financials.revenueQuarterly)} delta={0.11} />
      </Panel>
    </>
  );
}
```

Notes:

- Grids: `grid gap-4 lg:grid-cols-3` and friends. Always give a single-column
  mobile fallback — **the phone is primary**.
- Wide content scrolls inside its own container (`DataTable` already does).
  **The page body must never scroll horizontally.**
- Every address goes through `sheetHref()` or `legacyHref()`. A raw `/products`
  in a component still works — the catch-all redirects it — but it costs a
  navigation hop and `legacyLinks.test.ts` fails on it.

---

## 3. The store

One import: `@/lib/game`. Everything below is exported from it.

### 3.1 Selector hooks

| Hook | Returns | Use for |
|---|---|---|
| `useSession()` | `SessionState` | The world, the market tape, your own company — anything you legitimately see in full |
| `usePlayerView()` | `PlayerView` | **Anything about anyone else.** Redacted projection |
| `usePlayerCompany()` | `Company` | Your company, in full |
| `usePlayerCharacter()` | `Character` | Avery Sinclair, the founder |
| `useCompanyMetrics(companyId?)` | `CompanyQuarterMetrics \| null` | Runway, margins, enterprise value. **Null before the first resolve** |
| `useQuotes(instrumentId?)` | `Quote[]` (oldest first) | Price series for charts |
| `useLeaderboards(board?)` | `Leaderboard[]` | Rankings. **Empty until a quarter resolves** |
| `useQueuedActions()` | `QueuedActionEntry[]` | End Quarter, the tray, "already queued" affordances |
| `useOutcome()` | `FrontierResolutionOutcome \| null` | Quarter Resolution |
| `useConnection()` | `number` | The founder's connection level (0–100) |
| `useMarketCap(companyId?)` | `number` | Quote when listed, anchor when private |
| `useFounderNetWorth()` | `number` | As the leaderboard measures it |
| `useResolving()` | `{ resolving, status }` | Disable controls while the engine runs |
| `useSettings()` | `GameSettings` | Seed, difficulty, auto-execute, live-model opt-out |
| `useLlm()` | `LlmHealth` | `{ available, transportKind, model }` |
| `useGame()` | `GameStoreState` | Everything, when a narrower hook will not do |

`QueuedActionEntry`:

```ts
{
  action: SubmittedAction;
  validation: ActionValidationResult;   // accepted | clamped | rejected
  needsConfirmation: boolean;           // type is one of the thirteen
  blocked: boolean;                     // needsConfirmation && !confirmedByHuman
}
```

### 3.2 Actions

```ts
const {
  queueAction, unqueueAction, confirmAction, clearQueue, validateIntent,
  endQuarter, newGame, saveGame, loadGame, deleteSave,
  updateSettings, dismissNotice, refreshLlmHealth,
} = useGameActions();
```

The object is stable across renders; it is safe in a dependency array.

| Function | Signature | Notes |
|---|---|---|
| `validateIntent` | `(intent) => ActionValidationResult` | Pre-check without queuing. Use for live previews and disabled states |
| `queueAction` | `(intent, { origin?, confirmed? }) => QueuedActionEntry` | Validates, then queues. Returns the entry so you can render the result immediately |
| `confirmAction` | `(actionId) => void` | Records the explicit human confirmation and re-validates |
| `unqueueAction` | `(actionId) => void` | |
| `endQuarter` | `() => Promise<void>` | Async. Owned by the End Quarter screen; do not call it from elsewhere |

### 3.3 Derived helpers (pure functions, not hooks)

```ts
import {
  metricsFor, quotesFor, latestQuote, marketCapOf, founderNetWorth,
  leaderboardOf, projectPlayerView, redactRival, visibleResearchProjects,
  buildAlerts, playerCompanyOf, playerCharacterOf, needsConfirmation,
} from '@/lib/game';
```

---

## 4. Queuing an action, and the confirmation flow

Every control submits an **intent**. The engine validates, clamps and resolves;
a disabled button is a courtesy, never a rule.

### 4.1 Low-risk actions — one step

```tsx
const { queueAction } = useGameActions();
const [result, setResult] = useState<ActionValidationResult | null>(null);

function apply() {
  const entry = queueAction({ type: 'set_research_budget', budgetUsd: 750_000 });
  setResult(entry.validation);
}

// …
<ValidationBanner result={result} />
```

### 4.2 The thirteen — `ConfirmDialog` first, always

```
raise_round · issue_debt · buyback · issue_shares · ipo · acquire_company
layoff · bid_government · submit_board_proposal · propose_deal · accept_deal
buy_shares · sell_shares
```

Use `needsConfirmation(type)` (or `requiresExplicitConfirmation` from
`@frontier/contracts`) to test membership. Never queue one of these with
`confirmed: true` unless a human has just clicked through `ConfirmDialog`.

```tsx
const [pending, setPending] = useState<ActionIntent | null>(null);

<button className="btn btn-danger" onClick={() => setPending(layoffIntent)}>Reduce headcount</button>

<ConfirmDialog
  open={pending !== null}
  title="Reduce headcount"
  actionType="layoff"
  body="Layoffs always damage morale. Severance protects some of it, and costs cash now."
  terms={[
    { label: 'Roles cut', value: '24 engineers' },
    { label: 'Severance', value: '2 quarters of pay', emphasis: true },
    { label: 'Cash cost', value: formatMoney(3_600_000) },
  ]}
  confirmLabel="Confirm layoff"
  tone="loss"
  onCancel={() => setPending(null)}
  onConfirm={() => {
    if (pending !== null) queueAction(pending, { confirmed: true });
    setPending(null);
  }}
/>
```

Rules that are not negotiable:

1. **The gate cannot be satisfied programmatically.** `onConfirm` fires from a
   real activation of the button and nowhere else.
2. The player's auto-execute preference (`useSettings().autoExecuteRoutine`) is
   a UI convenience for *low-risk* actions only. It never applies here.
3. The engine rejects any of the thirteen carrying `confirmedByHuman: false`
   with the code `confirmation_required`. Blocked entries are surfaced in the
   tray and again on End Quarter.

### 4.3 Board matters clamp — say so plainly

Several actions come back `clamped` with `clampedAction.type ===
'submit_board_proposal'`. That is not a failure, and it must not read as one.
`ValidationBanner` already renders it as **"Requires board approval"** with the
form that will actually be tabled. Use it rather than writing your own copy.

---

## 5. Reading engine output

### 5.1 `ResolutionReport` (Quarter Resolution)

```ts
const outcome = useOutcome();            // null before the first resolved quarter
outcome.committed                        // false => nothing changed; show the report and the invariants
outcome.report.headline
outcome.report.phases                    // [{ phase, lines, durationMs }], in pipeline order
outcome.events                           // SimEvent[] — the ledger rows the lines reference
outcome.invariants                       // InvariantCheckResult[]
```

Each `ResolutionLine` is `{ phase, text, deltaLabel, refEventIds, tone,
subjectId }`. Map `tone` with `toneOfLine(line.tone)`.

> **INVARIANT: every line references at least one committed ledger event.**
> Nothing on that screen is narrative invention. Make each line clickable and
> open its `refEventIds` rows from `outcome.events` in a `Drawer`.

Phases arrive in pipeline order and are revealed progressively — world, then
competition, then your company, then markets, then rank. The player can skip to
the end; remember the choice in `useSettings().skipResolutionReveal` via
`updateSettings`.

The narrator is optional colour above the lines and its only input is the
committed lines. If `requestNarrative` returns `null`, render the lines
directly — they are human-readable by construction.

### 5.2 Leaderboards

```ts
const boards = useLeaderboards();               // all ten
const founder = useLeaderboards('founder_index')[0] ?? null;
```

Entries carry `{ rank, previousRank, subjectId, subjectKind, label, value,
percentile, delta }`. Use `formatRankMove(previousRank, rank)` for the movement
label — it returns `'new'`, `null` (unchanged) or `'#3 to #1'`. The Founder
Index breaks into eight weighted components; `FOUNDER_INDEX_WEIGHTS` from
`@frontier/contracts` is the data behind that breakdown.

Leaderboards are **empty at quarter 0**. Render an `EmptyState` explaining that
rankings are computed when the first quarter resolves — never a spinner.

### 5.3 Quotes and market cap

```ts
const quotes = useQuotes('ins_nxs');            // oldest first
const last = quotes.at(-1);                     // { price, return, volume, marketCapUsd }
const cap = useMarketCap('cmp_nexus');          // quote when listed, anchor when private
```

Player Ventures is **private**: `instrumentId` is null and there is no quote.
Handle that everywhere — it is the starting condition, not an edge case.

---

## 6. The information boundary

`SessionState` in the browser holds canonical reality, secret programmes
included. The screens are what keep it in. Three rules:

1. **Anything about another company or character comes from `usePlayerView()`.**
   Never iterate `session.companies` to render rivals. `view.visibleCompanies`
   is `Partial<Company>[]`: a private rival exposes identity, sector,
   reputation and listing status only; a listed one adds its filed financials.
   Nobody's headcount, compute, offices, capability scores or product
   economics.
2. **`view.techGraph` is already reduced** — public nodes plus your own, with
   `confidenceByCompany` cut to your own entry and the public figure. Never
   render `session.techGraph` on a surface that shows rivals. The informational
   edge to display is exactly this: a node the world rates at 0.31 and you rate
   at 0.68.
3. **A rival's secret research programme is absent, not redacted.** Use
   `visibleResearchProjects(session)`, never `session.researchProjects`.
4. **On the Connections picture: public relationships, my numbers.** Following
   a supplier or a buyer opens *their* Connections, and what a rival's picture
   may carry is fixed by the engine, not by the screen: who they buy from, who
   buys from them, which node each wire is, their target market and their
   awards — the relationships trade press would report. Never their unit cost,
   list price, published ask, gross margin, quality score or the alternatives
   they could have picked; `connectionsOf(state, viewerId, subjectId, …)` hands
   those back as `null` for anyone but the viewer, so the screen renders what
   it is given and never redacts. The one figure that crosses is **the viewer's
   own order book** — units a named buyer draws from my line, and units I draw
   from theirs (`NodeSupplyWire.unitsDrawnLastQuarter`, present only when the
   viewer is one of the two parties). A wire between two other companies
   carries no units at all. A rival's picture also offers no ticket: no aim
   button, no slot sheet — re-aiming somebody else's line is not a thing this
   seat can do.

Also: `PublicDisclosure.isTruthful` is internal. Never render it, never branch
a visible affordance on it.

Every NPC-authored message, post or reply carries `<AiLabel />`. Without
exception.

---

## 7. Formatting

All figures go through `@frontier/shared`. Never `toLocaleString`, never a
hand-rolled `.toFixed(...)`, never `Intl`. Players never see a decimal digit:
money is whole dollars or whole compact units, percentages are whole percents,
ratios are `formatMultiple` ("12x", "+8%").

```ts
import {
  formatMoney,        // 4_230_000 -> "$4,230,000"; 42_400_000 -> "$42M"; formatMoney(v, 'full') -> long form
  formatPercent,      // 0.043 -> "4%"; 0.004 -> "<1%"  (formatPct is the same function)
  formatCount,        // 12_500_000 -> "12,500,000" — shares, headcount, units
  formatMultiple,     // 12.4 -> "12x"; 1.08 -> "+8%"
  formatDelta,        // (0.13,'percent') -> "+13%"; (-0.021,'points') -> "-2pp"; (2,'rank') -> "+2"
  formatScore,        // 0..100 scores, whole points
  formatQuarter,      // (2027, 5) -> "2028 Q2"
  formatQuarterCount, // 34 -> "34 quarters"
  formatRankMove,
} from '@frontier/shared';
import { quarterLabel } from '@frontier/contracts';
```

- **Percent vs points.** A change in a percentage is `points` (`-2pp`); a
  change in a quantity is `percent` (`+13%`). Getting this wrong is a bug.
- Every figure in a column that can be compared vertically gets the `figure`
  class (monospace + tabular numerals). `DataTable` applies it to right-aligned
  columns automatically; `StatCard`, `KeyValueGrid` and `DeltaBadge` already do.
- Almost every figure has a previous value. Show the change.

---

## 8. Primitives

Import from `@/components/ui`. All are client components.

### `Panel`
```ts
{ title?, subtitle?, actions?, flush?, dense?, maxBodyHeight?, className?, bodyClassName?, children }
```
The unit a screen is built from. `flush` removes body padding — use it when the
body is a `DataTable`. Panels do not nest.

### `PageHeader`
```ts
{ title, subtitle?, eyebrow?, actions?, className? }
```
First row of every screen. Do not invent another title treatment.

### `SectionHeading`
```ts
{ children, actions?, rule?, className? }
```
Small-caps divider **inside** a panel body.

### `StatCard`
```ts
{ label, value, unit?, delta?, deltaFormat?, deltaInvert?, spark?, tone?, hint?, href?, onClick?, className? }
```
`deltaInvert` for figures where down is good (churn, burn, attrition). `href`
makes the card link to the screen that decomposes the number.

### `DataTable<T>`
```ts
{ columns, rows, rowKey, rowHref?, onRowClick?, isHighlighted?, dense?, initialSort?, empty?, maxHeight?, className? }

Column<T> = {
  key, header, render(row, index),
  align?: 'left'|'right'|'center', width?, sortable?, sortValue?(row),
  mono?, hideOnMobile?,
}
```
Right-aligned columns are monospace and tabular by default. `sortValue` is
required for sorting anything that is not a plain string cell. `hideOnMobile`
drops a column below `md`.

### `Sparkline` / `LineChart` / `BarChart`
```ts
Sparkline  { values, width?, height?, tone?, area?, marker?, ariaLabel? }
LineChart  { series: LineSeries[], xLabels?, height?, formatValue?, includeZero?, showLegend? }
             LineSeries = { id, label, values, tone?, dashed? }
BarChart   { data: BarDatum[], orientation?, formatValue?, height?, max? }
             BarDatum = { label, value, tone?, caption? }
```
Inline SVG, no library. `BarChart` defaults to horizontal, which reads better
for long category labels (the twelve capability areas, the five audiences).

### `DeltaBadge`
```ts
{ value, format?, decimals?, invert?, tone?, arrow?, bare? }
```
`bare` for inline text; the chip form for standalone use.

### `Tag` / `AiLabel`
```ts
Tag { children, tone?, size?, dot?, title? }
```
`AiLabel` takes nothing and has no opt-out.

### `TabBar`
```ts
{ tabs: TabItem[], value, onChange, variant?: 'underline'|'segmented', ariaLabel? }
TabItem = { id, label, badge?, disabled? }
```
`underline` under a page header; `segmented` inside a panel header.

### `Modal` / `Drawer`
```ts
Modal  { open, onClose, title, subtitle?, children, footer?, width?: 'sm'|'md'|'lg', dismissible? }
Drawer { open, onClose, title, subtitle?, children, footer?, side?: 'right'|'bottom', width? }
```
`Drawer` takes two more props for the sheet layer: `height?: 'sheet' | 'full'`
and `leading?: ReactNode`. `SheetHost` mounts every registry sheet as
`height="full"` with a Back control in `leading`; a screen's own detail drawer
leaves both off and stays the 85dvh sheet over it. `Drawer` is the right home
for ledger rows behind a figure, a director's card, one node of a picture.

### `ConfirmDialog`
```ts
{ open, title, body?, terms?: ConfirmTerm[], actionType?, confirmLabel?, cancelLabel?,
  tone?: 'brand'|'loss'|'warn', requireTyped?, busy?, onConfirm, onCancel }
ConfirmTerm = { label, value, emphasis? }
```
Pass `actionType` and the dialog states the always-confirm rule itself.

### `ValidationBanner`
```ts
{ result: ActionValidationResult | null, showClamped?, compact? }
```
Also exports `toneOfStatus` and `labelOfStatus`.

### `EmptyState`
```ts
{ title, message?, action?, glyph?, compact? }
```
Empty is information. Say what would fill it.

### `KeyValueGrid`
```ts
{ items: KeyValueItem[], columns?: 1|2|3|4, stacked? }
KeyValueItem = { label, value, tone?, mono?, hint?, wide? }
```

### `ProgressBar` / `Meter`
```ts
ProgressBar { value, max?, tone?, label?, valueLabel?, height?, ghostValue? }
Meter       { value /* 0..100 */, label?, tone?, benchmark?, benchmarkLabel?, showValue? }
```
`Meter` derives its band from the value: ≥70 gain, ≥45 info, ≥25 warn, below
that loss. Use it for morale, the five reputation audiences, connection level,
director support, past performance.

### `SliderField`
```ts
{ label, value, onChange, min, max, step, format,
  chips?, exact?, disabled?, ariaLabel?, className? }
```
Every numeric quantity in an action form is set with this, not typed. The one
exception in the app is the commitment threshold on `LobbyPanel`, which is a
comparator against a figure with no bound and an empty state that means "no
term offered".

- `min`/`max` are the bounds the validator already enforces — the schema range
  (`0..1`, `1..40`, `1..20`) or a real quantity from state (uncommitted cash,
  the free float, headcount, the award ceiling). Where an action has no schema
  maximum, `openCeiling(floor, ...candidates)` builds one that always contains
  the figure already set.
- `step` comes from `roundStep(bound)`: budgets move in $250K notches, never
  $247,193. `snapToStep` keeps both bounds reachable even off-grid.
- `format` is the shared formatter for the unit — `formatMoney`,
  `formatPercent`, `formatCount`, `formatQuarterCount`. The live figure above
  the track is the only place the value is stated.
- `chips` adds 25/50/75/Max quick-sets. Only where `max` is a real budget or
  cash bound; "Max" of an invented ceiling reads as an entitlement.
- `exact` (default true) reveals the old numeric input for a figure the grid
  cannot state. It imposes the floor only: a typed value above `max` is legal
  input, and the validator decides what it means. Set `exact={false}` on a
  field the schema fully bounds, where there is nothing left to type.

A drag calls `onChange` once, on release — not on every pixel. The thumb and
the live figure move locally in the meantime. Forms that re-run the validator
or an engine analysis from `onChange` therefore run it once per drag; do not
add a second, live-reading copy of the value alongside it.

### `PersonChip` / `CompanyChip` / `AccessBadge`
```ts
PersonChip   { character: PersonLike, subtitle?, right?, onClick?, size? }
CompanyChip  { company: CompanyLike, subtitle?, right?, onClick?, own?, size? }
AccessBadge  { state: 'open'|'override'|'blocked', gap? }
```
`PersonLike` and `CompanyLike` are structural: a full `Character` or a
redacted `Partial<Company>` both satisfy them. Avatarless by design — initials
only.

### `ConnectionPill` / `ConnectionsDiagram`
```ts
layoutConnections  ({ width, left, right, hub }) => ConnectionsLayout
pillWidth          (width) => number      // min(180, floor((W - 40 - 56) / 2))
ConnectionsDiagram { model: ConnectionsModel, layout: ConnectionsLayout, onAct? }
ConnectionPill     { pill: PillModel, box: LaidPill, onAct? }
nameSizePx         (name, pillWidth, nested) => number
rowSizePx          (figure, detail, pillWidth) => number
```
`screens/connections/` draws the three-column picture Products and Research
both use: what feeds this line on the left, the line itself on the hub, who
takes it on the right. Import the geometry from `./layout` — never lay a pill
out by hand, or the SVG wire behind it and the button in front of it disagree.

`layout.ts` is pure and integer-valued: both stacks run top-down and are
centred on the hub, `height = max(sides, 150)`, and a wire is a cubic from a
pill's wire-edge midpoint to the input anchor or to the output junction at
`hub.right + GAP/2`. `dashed` is true for exactly `possible` and `empty`; a
`blocked` wire is solid in the loss tone, because dashing it would say "you
could have this".

A pill is a 48-point absolutely positioned button — a `<div>` when it has no
action, a `<Link>` when it has an `href` — carrying a 20px glyph
(`CompanyGlyph` for a company, a `SECTOR_TINT` disc with `sectorIcon` for a
market cell), a name clamped to two lines and **one** data line whose figure
sits as a tag on the wire edge. There is no (i) button: at 130 points the
whole pill is the target, and its `aria-label` states what tapping it does.

**Words are budgeted, then sized.** `model.ts` writes every figure to
`FIGURE_MAX_CH` (6) and every detail to `DETAIL_MAX_CH` (12), with the pair
inside `ROW_MAX_CH` (15), and anything longer — the node a route buys, the
exact unit count, the full word behind an abbreviation — lives in the
`aria-label`, which has no width. `nameSizePx` and `rowSizePx` then pick the
largest size at which the strings this pill was *actually* handed fit the box
it *actually* has, by greedily wrapping them; both are pure, so the server and
the browser agree. A group header is two lines when the group has a recipe
("MODEL" over "40 1M tokens per unit") because the two do not fit one row at
any legible size. `apps/web/e2e/connections.js` fails the run on any
`scrollWidth > clientWidth` or clamped third line, which is the only check that
catches a truncation the layout tests cannot see.

`ConnectionsDiagram` is hook-free so a whole picture renders to static markup
in a test; container width comes from `useContainerWidth` (fallback 356 — the
panel's *measured* content box on a 390-point phone), and its ref must sit on a
nearly unpadded box or the picture is drawn wider than the column it lands in.

### Utilities
`cx(...)` joins class names. `TONE_VAR` gives the raw CSS variable for inline
SVG. `toneOfDelta(value, invert?)` and `toneOfLine(resolutionTone)` map to the
palette.

---

## 9. Design language

Warm paper tabletop strategy game × legible venture dashboard. Calm, tactile
and information rich, with the next decision easy to find.

- **Backgrounds** layer: `bg-base` (page) → `bg-panel` (panel) → `bg-raised`
  (rows, chips, hover). Hairlines are `border-hair`, emphasis `border-hair-strong`.
- **Text**: `text-ink` (figures and headings) → `text-ink-dim` (labels, prose)
  → `text-ink-faint` (captions, hints).
- **Accents carry meaning and nothing else**. Use semantic tokens from
  `globals.css`; do not copy their values into components.
- **Type**: serif display headings establish place and hierarchy; sans-serif
  text carries controls and explanation; `.figure` keeps comparable numbers tabular.
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`.
  **Inputs**: `.field` (works on `input`, `select`, `textarea`).
- **No chatbot look.** Even the Chief of Staff screen is a control surface: the
  interpretation renders as a **diff** — old value, new value, one line per
  change — and the mandatory copy *"No binding action has been submitted yet."*
  sits above `[Approve] [Edit]`. Below `confidence` 0.7 the panel is styled as
  a draft.

Responsive: **the phone is primary** — 390×844, portrait, one thumb. Desktop
gets the same page with the rail beside it, and every surface needs a
single-column layout under `lg`.

- **Chrome is 132 points** at 390: the status bar (64) and the bottom bar (68).
  Four rooms and the highlighted Plan action share the phone bar.
- **A sheet is 95dvh with a Back control** in its header (`Drawer height="full"`,
  `leading`). It is opened by `?sheet=` and closed by Back — the browser's or
  the header's.
- **A detail drawer over a sheet is the 85dvh sheet** (`Drawer` as it always
  was): one node of the picture, one director's card, one line's controls.
- **Two levels, never three.** A drawer inside a sheet may not open another
  drawer. The deepest thing on the screen is a centred `ConfirmDialog` or
  `Modal`, which is a decision rather than a level.
- **Every tappable clears 44×44** (`tap-target`), on a card, in a table row and
  on a pill alike.

---

## 10. The LLM client

Server-only code (`@frontier/llm`, the Claude Agent SDK) must **never** be
imported by a screen. Screens reach the model through `@/lib/llm/client` and
nothing else:

```ts
import {
  llmHealth,            // () => Promise<LlmHealth>  — memoised 3s
  requestChiefOfStaff,  // (ChiefOfStaffInput, conversationKey) => Promise<ChiefOfStaffInterpretation | null>
  requestCharacterReply,// (CharacterUtteranceContext, conversationKey) => Promise<CharacterReply | null>
  requestNarrative,     // (ResolutionReport, focusCompanyId) => Promise<NarratorOutput | null>
  requestWorldDirector, // used by the store; screens should not call it
  requestNpcBundle,     // used by the store; screens should not call it
} from '@/lib/llm/client';
```

Build inputs with the helpers in `@/lib/game`:

```ts
import { buildChiefOfStaffInput } from '@/lib/game';
const input = buildChiefOfStaffInput(session, message, history);
const interpretation = await requestChiefOfStaff(input, `cos:${session.sessionId}`);
```

**Every one of these can return `null`, and every caller must have a
deterministic path for it.** `failure_mode` is an engine invariant. For the
Chief of Staff the deterministic path is to echo the instruction back as a
question requiring confirmation — asking beats guessing. For the narrator it is
to render the committed lines directly.

Use `useLlm().available` to decide whether to *offer* a model-backed affordance,
never to decide whether to handle null.

---

## 11. Rules the interface may not break

1. **The client is never authoritative.** Every control submits an intent; the
   engine validates, clamps and resolves.
2. **No generated markup or code is rendered.** Generative surfaces — the
   Frontier Map above all — render typed data through trusted components.
3. **Private fields never reach a screen.** Rival `confidenceByCompany`, rival
   secret projects, `PublicDisclosure.isTruthful`, raw agent output.
4. **NPCs are always labelled** — conversations, the social feed, the deal room,
   the boardroom.
5. **Nothing on Quarter Resolution lacks a ledger reference.**
6. **No screen invents a number.** If a figure is not in state, or derived from
   state by documented code, it does not render. No placeholder data, no
   `Math.random()`, no `Date.now()` in anything gameplay-visible. (`Date.now`
   is fine for a debounce or an animation.)

---

## 12. Before you hand back

```bash
pnpm -C apps/web exec tsc --noEmit --incremental false   # must be clean
pnpm --filter @frontier/web build                        # must succeed
pnpm -C apps/web exec vitest run                         # store regression tests
```

`src/lib/game/store.test.ts` covers the store surfaces your screens sit on —
the demo session, the redaction rule, offline resolution, replay determinism
and the briefing builders. If you break one of those, you have broken a screen
somebody else is writing.

# Screen Guide

The contract between the application shell and the eighteen screens.

Everything in this document is built and green: the engine runs in the browser,
the store wraps it, the primitives are written, and every route renders. Your
job is to replace one placeholder file per screen with the real surface.

**Read this whole file before writing a screen.** Half of it is rules that stop
a screen from leaking private state or inventing a number, and those are
invariants, not style preferences.

---

## 1. What you own

Replace exactly one file per screen:

| Screen | Route file |
|---|---|
| Command Centre | `src/app/(game)/command-centre/page.tsx` |
| Company | `src/app/(game)/company/page.tsx` |
| Products | `src/app/(game)/products/page.tsx` |
| Research / Frontier | `src/app/(game)/research/page.tsx` |
| People | `src/app/(game)/people/page.tsx` |
| Network | `src/app/(game)/network/page.tsx` |
| Markets | `src/app/(game)/markets/page.tsx` |
| Capital | `src/app/(game)/capital/page.tsx` |
| Boardroom | `src/app/(game)/boardroom/page.tsx` |
| Government | `src/app/(game)/government/page.tsx` |
| Social | `src/app/(game)/social/page.tsx` |
| News | `src/app/(game)/news/page.tsx` |
| Deal Room | `src/app/(game)/deal-room/page.tsx` |
| Financials | `src/app/(game)/financials/page.tsx` |
| Leaderboard | `src/app/(game)/leaderboard/page.tsx` |
| Chief of Staff | `src/app/(game)/chief-of-staff/page.tsx` |
| End Quarter | `src/app/(game)/end-quarter/page.tsx` |
| Quarter Resolution | `src/app/(game)/quarter-resolution/page.tsx` |

You may also add screen-local components under
`src/components/screens/<screen>/`. Do **not** edit:

- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- `src/lib/**`, `src/components/ui/**`, `src/components/shell/**`
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`

If a primitive is missing something you need, compose it locally out of what
exists rather than editing the primitive — three agents share those files.

---

## 2. Page skeleton

Every screen is a client component that renders **a header row, then a grid of
panels**. The shell supplies the rail, the status bar, the action tray and the
resolving overlay; a page renders neither chrome nor a page background.

```tsx
'use client';

import { PageHeader, Panel, StatCard } from '@/components/ui';
import { usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';

export default function ProductsPage(): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();

  return (
    <>
      <PageHeader
        title="Products"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Pricing, customers and unit economics."
        actions={<button className="btn btn-sm">Launch product</button>}
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <StatCard label="Revenue" value={formatMoney(company.financials.revenueQuarterly)} delta={0.11} />
        {/* … */}
      </div>

      <Panel title="Product lines" flush>
        {/* DataTable */}
      </Panel>
    </>
  );
}
```

Notes:

- The page returns a **fragment**, not a wrapper `<div>`. The shell already
  provides `max-w-[1400px]`, the padding and a `flex flex-col gap-4` column.
- Grids: `grid gap-4 lg:grid-cols-3` and friends. Always give a single-column
  mobile fallback — desktop is primary, but every screen must be readable on a
  phone.
- Wide content scrolls inside its own container (`DataTable` already does).
  **The page body must never scroll horizontally.**

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
const outcome = useOutcome();            // null before the first resolve in this tab
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

Also: `PublicDisclosure.isTruthful` is internal. Never render it, never branch
a visible affordance on it.

Every NPC-authored message, post or reply carries `<AiLabel />`. Without
exception.

---

## 7. Formatting

All figures go through `@frontier/shared`. Never `toLocaleString`, never a hand-rolled
`.toFixed(2)` on money, never `Intl`.

```ts
import {
  formatMoney,        // 1_240_000_000 -> "$1.24B";  formatMoney(v, 'full') -> "$1,240,000,000"
  formatPct,          // 0.0473 -> "4.7%"
  formatDelta,        // (0.13,'percent') -> "+13%"; (-0.021,'points') -> "-2.1pp"; (2,'rank') -> "+2"
  formatScore,        // 0..100 scores
  formatQuarter,      // (2027, 5) -> "2028 Q2"
  formatQuarterCount, // 34 -> "34 quarters"
  formatRankMove,
} from '@frontier/shared';
import { quarterLabel } from '@frontier/contracts';
```

- **Percent vs points.** A change in a percentage is `points` (`-2.1pp`); a
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
`Drawer` is the right home for ledger rows behind a figure, a director's card,
one node of the Frontier Map.

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

### `PersonChip` / `CompanyChip` / `AccessBadge`
```ts
PersonChip   { character: PersonLike, subtitle?, right?, onClick?, size? }
CompanyChip  { company: CompanyLike, subtitle?, right?, onClick?, own?, size? }
AccessBadge  { state: 'open'|'override'|'blocked', gap? }
```
`PersonLike` and `CompanyLike` are structural: a full `Character` or a
redacted `Partial<Company>` both satisfy them. Avatarless by design — initials
only.

### `ActionQueueTray`
Rendered by the shell. Do not mount it yourself.

### Utilities
`cx(...)` joins class names. `TONE_VAR` gives the raw CSS variable for inline
SVG. `toneOfDelta(value, invert?)` and `toneOfLine(resolutionTone)` map to the
palette.

---

## 9. Design language

Premium financial terminal × venture dashboard. Dark, dense, information first.

- **Backgrounds** layer: `bg-base` (page) → `bg-panel` (panel) → `bg-raised`
  (rows, chips, hover). Hairlines are `border-hair`, emphasis `border-hair-strong`.
- **Text**: `text-ink` (figures and headings) → `text-ink-dim` (labels, prose)
  → `text-ink-faint` (captions, hints).
- **Accents carry meaning and nothing else**: `gain` #3fdc97, `loss` #ff5d5d,
  `warn` #ffb454, `info` #4cc9f0, `brand` #7aa2ff. No decorative gradient behind
  data. No colour that does not mean something.
- **Type scale**: 10px small caps labels (`label-caps`), 11px captions, 12px
  body, 13px emphasis, 19px page titles and headline figures.
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`.
  **Inputs**: `.field` (works on `input`, `select`, `textarea`).
- **No chatbot look.** Even the Chief of Staff screen is a control surface: the
  interpretation renders as a **diff** — old value, new value, one line per
  change — and the mandatory copy *"No binding action has been submitted yet."*
  sits above `[Approve] [Edit]`. Below `confidence` 0.7 the panel is styled as
  a draft.

Responsive: desktop primary, usable on a tablet, readable on a phone. The rail
collapses under `lg` — screens do not need to handle that, but they do need a
single-column layout at that width.

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

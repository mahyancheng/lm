# Art Direction

Frontier Capital looks like a **warm paper tabletop strategy game with real
strategic weight**: tactile cream surfaces, a deep forest rail, restrained
emerald and amber accents, expressive serif headings, and legible business
figures. Illustrations keep the world approachable without turning decisions
into decoration.

This file is the prose half of `src/app/globals.css`. That file holds the
values; this one says what they mean and how to use them. **Read both before
adding a surface.** Nothing in the interface is styled with a literal colour.

> The one rule that has no exceptions: **never hardcode a colour in a
> component.** Every colour is a token. If you need one that does not exist,
> say so — the palette is owned in one place, and a stray hex is the one thing
> that cannot be re-skinned later.

---

## 1. The look, in one paragraph

A page is a warm cream ground carrying paper panels with quiet rules and soft
shadows. Large serif headings establish the room and moment; sans-serif copy
explains the decision; every figure keeps tabular numerals. The desktop rail is
the one deep forest anchor. Emerald marks ownership and interaction, amber
marks attention, and status colours keep their semantic meaning. Texture and
gradients may establish the desk, but never obscure or encode data.

---

## 2. Palette

All tokens live in the `@theme` block of `src/app/globals.css`. Tailwind turns
each `--color-x` into `bg-x` / `text-x` / `border-x`, and CSS can read
`var(--color-x)` directly (do that inside inline SVG).

### 2.1 Surfaces

| Token | Value | What it is |
|---|---|---|
| `base` | `#f3eddf` | The page behind everything |
| `panel` | `#fffdf7` | A card |
| `raised` | `#e8e0d0` | A row, a chip, a hover, a track, an inset |
| `overlay` | `#fffdf7` | Reserved for a floating surface |

The stack is not "darker is deeper". `raised` is **tinted**: it is simply the
surface whose job is to separate itself from a white card. A segmented control's
selected pill is therefore `bg-panel` sitting *in* a `bg-raised` track — the
selected thing rises, it does not sink.

### 2.2 Hairlines

`hair` `#d8ceba` for every divider; `hair-strong` `#bfb39c` for a control border
or a dashed empty state. Do not use an alpha variant (`border-hair/50`) on a
light ground — it disappears.

### 2.3 Ink

| Token | Value | Use |
|---|---|---|
| `ink` | `#17251f` | Figures, headings, primary text |
| `ink-dim` | `#46564d` | Labels, prose, secondary text |
| `ink-faint` | `#66736b` | Captions, hints, provenance — the explanatory layer |

`ink-faint` carries hundreds of 10–11px spans, so it is held to the **4.5:1
body-text floor on every surface**, not the 3:1 large-text one.
`src/components/ui/interaction.test.ts` re-derives contrast from `globals.css`
on every test run and fails the build if a palette change drops below 4.5. If you move an ink value, run
`pnpm -C apps/web exec vitest run` before you move on.

### 2.4 Accents — colour means something

| Token | Value | Meaning |
|---|---|---|
| `gain` | `#16815b` | Up, good, achieved |
| `loss` | `#ef4444` | Down, bad, rejected |
| `warn` | `#a56816` | Needs attention, clamped, unmet |
| `info` | `#247665` | Neutral-but-notable, informational |
| `brand` | `#1f7a55` | Interactive, yours, selected |

There is exactly **one value per tone** because `text-gain` and `bg-gain` are the
same token in fifty places each. Each is therefore deep enough to read as 11px
text on white (3.4:1 or better) while still reading as a flat fill. `gain`,
`warn` and `info` sit a step deeper than the brightest member of their family
for that reason — the bright amber still exists, as `pop-4`, for illustration.

**Washes** — `gain-wash`, `loss-wash`, `warn-wash`, `info-wash`, `brand-wash` —
are the pale tints behind chips, banners and highlighted rows.

**Solids** — `brand-strong` `#12613f`, `gain-strong` `#116342`, `loss-strong`
`#dc2626`, `warn-strong` `#8a5010`, `info-strong` `#1d6555`. Every one clears
4.5:1 against the light panel. **Whenever light text sits on a colour, use a `-strong`
token, never the plain tone.** `TONE_SOLID` in `components/ui/tokens.ts` is the
class-map for exactly this.

### 2.5 Flat pastels

`pop-1` … `pop-8` (indigo, teal, pink, amber, violet, green, coral, sky). They
mean *different from each other* and nothing else. Use them for categorical
tags, multi-series charts and illustration — **never** where gain/loss/warn
would carry meaning. A revenue line is `gain`, not `pop-6`.

### 2.6 Illustration

Flat-vector people and places have their own ramps so two agents draw the same
world:

- Skin: `skin-1` … `skin-5` (light to deep).
- Hair: `hair-1` … `hair-6` (near-black, brown, sandy, blond, auburn, grey).
  *(Note the collision in reading: these are `--color-hair-1…6`, unrelated to
  the `hair` hairline token. Always write the number.)*
- Garments: `cloth-suit` (investors, directors), `cloth-lab` (researchers),
  `cloth-hoodie` (engineers), `cloth-casual` (everyone else).
- Places: `build-face`, `build-side`, `build-roof`, `build-glass`, `sky`,
  `ground`.

---

## 3. Geometry

| Token | Value | Where |
|---|---|---|
| `--radius-panel` | 10px | Cards, modals, drawers, scene frames |
| `--radius-card` | 8px | Callouts, insets, empty states |
| `--radius-chip` | 6px | Small buttons, icon squares, nav items |
| `--radius-field` | 7px | Buttons and inputs |
| `--radius-pill` | 999px | Tags, badges, meters, bars, dots |

As Tailwind classes: `rounded-panel`, `rounded-card`, `rounded-chip`,
`rounded-pill` (and the side variants, `rounded-t-panel`). **Stop writing
`rounded-[4px]`.** Anything that shows a value — a tag, a delta, a meter, a
progress bar, a legend swatch — is a pill.

### Shadows

| Token | Where |
|---|---|
| `shadow-card` | A resting card. `.panel-surface` already applies it |
| `shadow-pop` | A card under the pointer (`.hover-lift` applies it) |
| `shadow-float` | A floating control: the Chief of Staff dock, a sticky seal bar |
| `shadow-sheet` | A modal or a drawer |

Shadows are slate at 4–18% alpha. **Never black**, never `shadow-2xl
shadow-black/60` — that is the old dark theme and it reads as dirt on white.

---

## 4. Typography

The font stacks do not change: `--font-sans` for everything, `--font-mono` for
figures.

- Headings are **700 / 800** with `-0.015em` tracking. Page titles are 22px
  extrabold (`PageHeader` does this — do not invent another title treatment).
- Body is 12–13px, prose is `text-ink-dim`.
- `.label-caps` / `.label-caps-faint` are the 10px small-caps section labels.
- **`.figure` and `.tabnum` are not decorative and must never be dropped.**
  Every number that can be compared down a column keeps tabular numerals.
  `DataTable` applies `.figure` to right-aligned columns; `StatCard`,
  `KeyValueGrid`, `DeltaBadge` and `Meter` already do it themselves.

---

## 5. Motion

Cheap, soft, bouncy, and **transform/opacity only**. No canvas, no
`requestAnimationFrame`, no physics, no layout animation.

| Class | What it does |
|---|---|
| `animate-pop-in` | Arrival: fade + rise + a small overshoot, 320ms. Cards, panels, dialogs |
| `animate-rise` | A quieter arrival, 220ms. Banners, drawers |
| `animate-fade-in` | Opacity only, 180ms |
| `animate-bob` | Idle life, 2.6s loop, ±3px. Characters, icons |
| `animate-bob-slow` | The same at 4.2s, so a crowd is not synchronised |
| `animate-sway` | ±1.4° lean, 5s. Flags, plants, signs |
| `animate-count-up` | A figure rising into place, 420ms |
| `animate-pulse-soft` | A gentle attention pulse |
| `stagger-1` … `stagger-6` | 40ms steps of `animation-delay` |
| `hover-lift` | Lifts 2px and deepens the shadow under the pointer |
| `press-pop` | Scales to 0.97 while pressed |

### Two things to know

**Count-up.** There is no JavaScript tween. `animate-count-up` replays when the
element mounts, so give the value a React `key` that changes with the number:

```tsx
<span key={String(value)} className="figure animate-count-up">{formatMoney(value)}</span>
```

**Composition.** `hover-lift` and `press-pop` deliberately use the *individual*
`translate` and `scale` properties rather than `transform`. A running animation
outranks the cascade for the property it animates, so a card mid-`animate-pop-in`
could pop **or** lift, but not both, if the two shared `transform`. For the same
reason the arrival animations fill `backwards`, not `both` — they all end on the
element's natural state, so holding the last keyframe would only keep
`transform` (and its containing block) pinned forever. If you write a new hover
effect on an animated element, follow the same rule.

**Reduced motion.** `globals.css` collapses every animation and transition under
`prefers-reduced-motion: reduce`, and additionally forces `transform: none` on
the idle loops and neutralises the lift and press. Anything you add is covered
by the blanket rule, but if your effect ends in a non-default transform, add it
to that block.

---

## 6. Illustration style

- **Flat vector only.** Solid fills, no gradients on subjects, no textures, no
  photorealism, no drop shadows inside an illustration.
- **Rounded primitives.** Buildings are `rect`s with `rx` 10–14. Heads are
  circles. Bodies are pill-shaped `rect`s (`rx` ≈ height/2.5).
- **People are round-headed and simple**: a circle head, a flat hair shape laid
  over the top of it, two dot eyes, a two-point smile arc, a coloured body.
  Outfits are role-coded through the `cloth-*` tokens: suits for investors and
  directors, lab coats for researchers, hoodies for engineers.
- **Places are isometric-lite**: a lit face and one darker side (`build-face` /
  `build-side`), a roof band, glass rectangles for windows. Two tones per
  volume, no more.
- **Flat icons beat letter monograms — always.** There are no two-letter
  monograms left in the interface, and there is a drawn mark for every screen,
  every room, every sheet and every common control. Do not invent one inline: use the
  set, documented in **§10**. A bespoke illustration is still welcome; a
  bespoke *icon* is a fork.
- Give every illustration `role="img"` and a real `aria-label` that says what is
  in it — it is information, not decoration.

### Determinism

Any per-entity visual variation — face, hair, outfit, building colour — is
derived from `fnv1a64(entityId)` from `@frontier/shared`. **Never
`Math.random()`, never `Date.now()`.** Two renders of the same character are
identical forever, and so are two players' screens.

`fnv1a64(input)` returns **16 lower-case hex characters**, so take a slice and
parse it; salt the input so a character's hair and outfit do not move together.

```ts
import { fnv1a64 } from '@frontier/shared';

const SKINS = ['skin-1', 'skin-2', 'skin-3', 'skin-4', 'skin-5'] as const;

/** A stable index into a palette, derived from the entity's id. */
function pickIndex(id: string, salt: string, length: number): number {
  return Number.parseInt(fnv1a64(`${salt}:${id}`).slice(-8), 16) % length;
}

const skin = SKINS[pickIndex(character.id, 'skin', SKINS.length)] ?? 'skin-1';
// → fill={`var(--color-${skin})`}
```

---

## 7. Touch, keyboard and containment

- **Navigation is four rooms plus Plan.** Today, Build, Power and World are
  peers. Plan is a persistent highlighted action at the end of the phone bar
  and foot of the desktop rail. There is no sub-tab strip or hamburger. Every
  drill-down is a sheet over its owning room, so Back closes it. Chrome at 390
  is 132 points: status bar 64, bottom bar 68.
- **Every interactive zone is at least 44×44 CSS px.** `.tap-target` sets that
  floor and composes with `.btn` (whose `height` loses to a larger
  `min-height`). Dialog closers, a card's whole row, the settings button and a
  queued instruction's remove button all use it. Dense in-table controls are
  the one pragmatic exception, and they still get a visible focus ring.
- **Everything focusable shows it.** The global `:focus-visible` ring is a 2px
  `brand-strong` outline at 2px offset. A clickable `DataTable` row is a real
  control: `role`, `tabIndex`, Enter and Space, and an inset ring.
- **A scene contains itself.** Wide or illustrated content lives in a
  `.scroll-x` or a `.scene-frame` and scrolls or scales *inside* its own box.
  **The page body never scrolls horizontally**, and it is deliberately not
  `overflow-x: hidden` — that would make `<body>` a scroll container and break
  every sticky header in the shell.
- Check every screen at **390px**. A grid without a single-column fallback is a
  bug.

---

## 8. The component vocabulary

Use these before writing a surface of your own. Props are documented in
`SCREEN_GUIDE.md`, which remains the contract; prop APIs are additive only,
because every room and every sheet body depends on them.

| Class / component | Notes |
|---|---|
| `.panel-surface` | White card, hairline, `shadow-card`, `radius-panel` |
| `.raised-surface` | Tinted inset block |
| `.btn` `.btn-primary` `.btn-danger` `.btn-ghost` | 34px, `radius-field`, press-scale built in |
| `.btn-sm` / `.btn-lg` | 28px / 46px. `btn-lg` is for a landing-page CTA |
| `.field` | 34px input, brand focus ring. Works on input, select, textarea |
| `.data-table` | Light zebra, white sticky header, tinted hover |
| `Panel` | Takes an optional flat `icon` + `iconTone` |
| `StatCard` | Takes an optional flat `icon` + `iconTone`; the figure counts up |
| `Tag` `DeltaBadge` `Meter` `ProgressBar` | Flat pills, all of them |
| `TONE_CHIP` `TONE_WASH` `TONE_SOLID` `TONE_FILL` `TONE_VAR` | The tone maps. `TONE_VAR` is the one to use inside inline SVG |

### Two ordering traps that bite

1. **DataTable row backgrounds paint the cell, not the row.** Zebra striping
   sets a `td` background, so a `tr` background would sit underneath it. The
   highlight is `data-highlight="true"` on the `tr`, and `globals.css` orders
   the three rules stripe → highlight → hover at equal specificity. If you add
   a fourth row state, add it to that ordered block.
2. **Utilities beat `.label-caps`.** The small-caps classes set a colour in the
   `components` layer, so `text-brand` on the same element wins. That is
   intended — use it.

---

## 9. Checklist before you hand a surface back

- [ ] Every mark comes from `components/ui/icons.tsx`. No two-letter monograms,
      no emoji, no one-off inline glyph.
- [ ] On a filled or tinted surface the mark carries an `icon-knockout-*`
      class (or comes from `IconChip`, which does it for you).
- [ ] The phone layout came first: the four rooms and Plan are not covered,
      tables that do not fit are `cardMode="auto"`, and a side drawer is a
      bottom sheet under `sm`.
- [ ] No hex literal anywhere in the component.
- [ ] Dark fills are reserved for the desktop rail and semantic solid controls;
      no black shadows and no white text on an unverified fill.
- [ ] Radii come from the scale; value-bearing shapes are pills.
- [ ] Figures keep `.figure` / `.tabnum`.
- [ ] Any per-entity variation comes from `fnv1a64`, not `Math.random`.
- [ ] Animations are transform/opacity, and reduced motion is honoured.
- [ ] Every control is keyboard reachable with a visible ring; touch targets
      clear 44px.
- [ ] It holds together at 390px without the page scrolling sideways.
- [ ] `pnpm -C apps/web exec tsc --noEmit --incremental false` is clean and
      `pnpm -C apps/web exec vitest run` is green — the contrast assertions in
      `interaction.test.ts` read the palette straight out of `globals.css`.

---

## 10. The icon set

`src/components/ui/icons.tsx` holds **thirty-six flat marks on a 24×24 grid**,
drawn in the same language as the people and the places: solid rounded shapes,
no outlines, no strokes, no emoji, no letter monograms. One component draws all
of them.

```tsx
import { Icon, IconChip } from '@/components/ui';

<Icon name="flask" />                        // 20px, brand accent, inherits ink
<Icon name="gauge" size={16} />              // inline beside a label
<IconChip name="ledger" tone="info" />       // the mark in a tinted square
<IconChip name="stamp" tone="brand" variant="solid" size="lg" />
```

### 10.1 The two colours

Every mark is exactly two flat colours and never more:

- the **base** is `currentColor`, so a mark takes the colour of the text it sits
  with — ink, `ink-faint`, a tone, or white on a `-strong` fill;
- the **accent** is *one detail per mark* — a needle, a roof, a liquid, a seam —
  painted with `var(--fc-icon-accent)`.

`accent` on `<Icon>` takes a `Tone` (default `brand`), `current` (fold the detail
into the base — a silhouette), or `inherit` (read the property from an
ancestor).

### 10.2 The knockout rule

> On a plain surface, leave the accent alone. On a **filled** surface, set
> `--fc-icon-accent` to that surface's own colour and the detail becomes a
> knockout.

A second colour either vanishes or fights inside a 24px filled chip; a cut-out
never does. `globals.css` provides the classes — put one on the **filled
element**, not on the icon:

| Class | For a mark sitting on |
|---|---|
| `icon-knockout-panel` | a white card, a tab bar, an empty state |
| `icon-knockout-raised` | a `bg-raised` chip or row |
| `icon-knockout-base` | the page ground |
| `icon-knockout-wash` | a `bg-brand-wash` pill — the active tab |
| `icon-knockout-brand` | a `bg-brand-strong` square — the active rail item |

```tsx
<span className="icon-knockout-brand flex size-7 items-center justify-center rounded-chip bg-brand-strong text-white">
  <Icon name="logo" size={16} accent="inherit" />
</span>
```

`IconChip` applies the right one for its `tone` and `variant`, so prefer it for
a chip and reach for the classes only when you are building the filled surface
yourself.

Every mark is drawn so that its **silhouette alone reads**: the accent adds
information, it never carries the shape. That is why the accent always sits
*inside or across* the base rather than beside it — a knocked-out detail that
floated outside the silhouette would simply disappear.

### 10.3 Sizes

| Size | Where |
|---|---|
| 13–14 | Beside a `label-caps` group heading |
| 15–16 | Inside a rail row's chip, a status-bar button, a card's drill row |
| 18–20 | The default: a bottom tab, a button, body text |
| 20–24 | An empty state, a section heading, a landing card |

Never below 13: these are drawn to be simple, not to be micro-type.

### 10.4 Pairing a mark with a label

- A mark **beside its own label** is decoration: leave `label` off and it is
  `aria-hidden`, so a screen reader hears the words once.
- A mark **standing alone** — an icon-only button — needs an accessible name.
  Put it on the control (`aria-label`) and leave the icon hidden; only pass
  `Icon`'s own `label` when the mark is the whole content of a non-interactive
  element.
- Icon **then** label, `gap-1.5` to `gap-2.5`, both on the same text colour.
  Never colour a label to match an accent.
- Every icon-only control still clears 44×44 on a phone: `tap-target px-0`.

### 10.5 The names

Four rooms — `gauge` (Today), `building` (Build), `chart` (Power), `globe`
(World) — plus the persistent `playMark` (Plan). Pairwise distinct, and pinned
by `nav.test.ts`.

Twenty sheets, each keeping the mark its screen was known by — `building`
(Company), `boardTable` (Group, Boardroom), `box` (Products), `people`,
`flask` (Research), `capitol` (Government), `ledger` (Financials), `chart`
(Markets), `coins` (Capital), `portfolio`, `briefcase` (The Street, Chief of
Staff), `handshake` (Deal Room), `newspaper` (News, Quarter Resolution),
`chat` (Social), `network`, `trophy` (Leaderboard), `globe` (Sector).

Still drawn for legacy and secondary surfaces — `desk`, `compass`,
`vault`, `stamp`.

Utility — `settings`, `bell`, `live`, `close`, `chevronRight`, `chevronDown`,
`check`, `warning`, `search`, `plus`, `save`, `export`, `import`, `back`,
`menu`, `logo`.

`nav.ts` names one for every screen and every group, and
`components/shell/nav.test.ts` fails the build if a name it asks for is not
drawn. `ICON_NAMES` is the full list at runtime; `isIconName` is the guard the
primitives use so `icon="flask"` and `iconName="flask"` both work on `Panel`,
`StatCard` and `EmptyState`.

### 10.6 Adding a mark

Add the name to `ICON_NAMES` and the drawing to `SHAPES` — the `Record` is
exhaustive, so TypeScript will not let you add one without the other. Then:
build it from rounded rects, circles, ellipses and short filled paths; give it
one accent detail that sits inside the silhouette; check it at **16px**, in a
wash chip and on a solid fill before you keep it.

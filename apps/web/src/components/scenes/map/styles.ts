/**
 * The world map's own stylesheet.
 *
 * Two things live here and nowhere else:
 *
 * 1. **The scene's derived colours.** Every fill in the map resolves to a
 *    *semantic design token* — the illustration ramps (`--color-build-*`,
 *    `--color-sky`, `--color-ground`) or the tone tokens (`brand`, `gain`,
 *    `warn`, `loss`, `info`, `pop-*`). No component in this folder writes a hex
 *    value, so a re-skin of `globals.css` re-skins the world with it. Aliasing
 *    the tokens onto `.fc-map` lets the SVG use plain
 *    `fill="var(--fc-map-face)"` presentation attributes.
 * 2. **The idle motion.** Transform and opacity only, so nothing here can force
 *    layout: a bobbing citizen, a swaying ticker flag, a turning rotor, a
 *    pulsing event marker, drifting weather over the strait and a blinking rack
 *    LED. Every one is switched off under `prefers-reduced-motion`, both by the
 *    global rule in `globals.css` and again here so the scene stays correct if
 *    that rule ever moves.
 *
 * `<style>` is emitted once by the scene; React 19 dedupes the
 * `href`/`precedence` pair, so two maps on one page still yield a single tag.
 */

export const MAP_STYLE_ID = 'fc-world-map';

export const MAP_STYLES = `
.fc-map {
  /* --- ground and water --------------------------------------------------- */
  --fc-map-sea: var(--color-sky);
  --fc-map-sea-deep: var(--color-build-glass);
  --fc-map-land: var(--color-ground);
  --fc-map-shore: var(--color-build-side);
  --fc-map-parcel: var(--color-panel);
  --fc-map-parcel-edge: var(--color-hair);
  --fc-map-road: var(--color-build-side);
  --fc-map-green: var(--color-pop-6);

  /* --- volumes: two tones per building, never more ----------------------- */
  --fc-map-face: var(--color-build-face);
  --fc-map-side: var(--color-build-side);
  --fc-map-roof: var(--color-build-roof);
  --fc-map-glass: var(--color-build-glass);

  /* --- weather ----------------------------------------------------------- */
  --fc-map-storm: var(--color-cloth-suit);
  --fc-map-heat: var(--color-warn);

  /* Contact shadows are the ink token thinned out, never a literal black. */
  --fc-map-shadow: color-mix(in srgb, var(--color-ink) 12%, transparent);

  /* --- company colourways: eight flat pastels, picked by fnv1a64(id) ------ */
  --fc-map-brand-0: var(--color-pop-1);
  --fc-map-brand-1: var(--color-pop-2);
  --fc-map-brand-2: var(--color-pop-3);
  --fc-map-brand-3: var(--color-pop-4);
  --fc-map-brand-4: var(--color-pop-5);
  --fc-map-brand-5: var(--color-pop-6);
  --fc-map-brand-6: var(--color-pop-7);
  --fc-map-brand-7: var(--color-pop-8);

  /* --- people ------------------------------------------------------------ */
  --fc-map-skin-0: var(--color-skin-1);
  --fc-map-skin-1: var(--color-skin-2);
  --fc-map-skin-2: var(--color-skin-3);
  --fc-map-skin-3: var(--color-skin-4);
  --fc-map-skin-4: var(--color-skin-5);
  --fc-map-hair-0: var(--color-hair-1);
  --fc-map-hair-1: var(--color-hair-2);
  --fc-map-hair-2: var(--color-hair-3);
  --fc-map-hair-3: var(--color-hair-4);
  --fc-map-hair-4: var(--color-hair-5);
  --fc-map-hair-5: var(--color-hair-6);
  --fc-map-suit: var(--color-cloth-suit);
  --fc-map-lab: var(--color-cloth-lab);
  --fc-map-hoodie: var(--color-cloth-hoodie);
  --fc-map-casual: var(--color-cloth-casual);
}

/* Text drawn inside the SVG keeps the figure treatment: a ticker is a figure
   as much as a price is, and tabular numerals stop flags jittering. */
.fc-map-label {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0.02em;
  paint-order: stroke fill;
}

.fc-map-name {
  font-family: var(--font-sans);
  font-weight: 700;
  letter-spacing: -0.01em;
}

/* --- a shape that is also a control -------------------------------------- */

.fc-map-target {
  cursor: pointer;
  transform-box: fill-box;
  transform-origin: 50% 100%;
  transition: transform 150ms cubic-bezier(0.2, 0.9, 0.3, 1.1);
}

.fc-map-target:hover {
  transform: translateY(-2px);
}

.fc-map-target:active {
  transform: translateY(0) scale(0.99);
}

/* The focus ring is drawn, not outlined: an SVG outline clips unpredictably
   inside a scaled viewBox, and a ring shape scales with the art. */
.fc-map-ring {
  opacity: 0;
  transition: opacity 140ms ease;
}

.fc-map-target:hover .fc-map-ring {
  opacity: 0.55;
}

.fc-map-target:focus-visible {
  outline: none;
}

.fc-map-target:focus-visible .fc-map-ring {
  opacity: 1;
}

/* A district parcel is a quieter control than a building. */
.fc-map-parcel-hit {
  cursor: pointer;
  transition: opacity 140ms ease;
  opacity: 0;
}

.fc-map-parcel-hit:hover,
.fc-map-parcel-hit:focus-visible {
  opacity: 1;
  outline: none;
}

/* --- idle motion --------------------------------------------------------- */

.fc-map-flag {
  transform-box: fill-box;
  transform-origin: 0% 50%;
  animation: fc-map-sway var(--fc-dur, 4.4s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-map-bob {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  animation: fc-map-bob var(--fc-dur, 3.2s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-map-rotor {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: fc-map-rotor 14s linear infinite;
}

.fc-map-led {
  animation: fc-map-led var(--fc-dur, 2.6s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-map-wave {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  animation: fc-map-wave 3.4s ease-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-map-drift {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: fc-map-drift var(--fc-dur, 9s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-map-pulse {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: fc-map-pulse 2.4s ease-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

@keyframes fc-map-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes fc-map-sway {
  0%, 100% { transform: rotate(-3deg); }
  50% { transform: rotate(3deg); }
}

@keyframes fc-map-rotor {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes fc-map-led {
  0%, 100% { opacity: 0.28; }
  50% { opacity: 1; }
}

@keyframes fc-map-wave {
  0% { opacity: 0.55; transform: scale(0.6); }
  70% { opacity: 0; transform: scale(1.25); }
  100% { opacity: 0; transform: scale(1.25); }
}

@keyframes fc-map-drift {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(6px); }
}

@keyframes fc-map-pulse {
  0% { opacity: 0.7; transform: scale(0.7); }
  75% { opacity: 0; transform: scale(1.6); }
  100% { opacity: 0; transform: scale(1.6); }
}

@media (prefers-reduced-motion: reduce) {
  .fc-map-target,
  .fc-map-flag,
  .fc-map-bob,
  .fc-map-rotor,
  .fc-map-led,
  .fc-map-wave,
  .fc-map-drift,
  .fc-map-pulse {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
  .fc-map-target:hover { transform: none; }
  .fc-map-led { opacity: 0.8; }
  /* The expanding rings are the whole point of a marker; without motion they
     become one steady halo rather than disappearing. */
  .fc-map-pulse,
  .fc-map-wave { opacity: 0.35; }
}
`;

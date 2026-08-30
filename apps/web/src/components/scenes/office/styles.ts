/**
 * The office scene's own stylesheet.
 *
 * Two things live here and nowhere else:
 *
 * 1. **The scene's derived colours.** Every fill in the scene resolves to a
 *    *semantic design token* — the illustration ramps (`--color-skin-*`,
 *    `--color-hair-*`, `--color-cloth-*`, `--color-build-*`) or the tone tokens
 *    (`brand`, `gain`, `warn`, `info`, `pop-*`). No component in this folder
 *    writes a hex value; a re-skin of `globals.css` re-skins the office with
 *    it. Aliasing them onto `.fc-office` lets the SVG use plain
 *    `fill="var(--fc-desk)"` presentation attributes.
 * 2. **The idle motion.** Transform and opacity only, so nothing here can force
 *    layout: a slow head bob, a typing wrist, a rack LED pulse and a pop-in for
 *    the zones. Every one is disabled under `prefers-reduced-motion`, both by
 *    the global rule in `globals.css` and again here so the scene stays correct
 *    if that rule ever moves.
 *
 * `<style>` is emitted once by the scene; React 19 dedupes the
 * `href`/`precedence` pair, so mounting the full scene and the compact scene on
 * the same page still yields a single tag.
 */

export const OFFICE_STYLE_ID = 'fc-office-scene';

export const OFFICE_STYLES = `
.fc-office {
  /* --- room shell: the flat isometric-lite building palette -------------- */
  --fc-floor: var(--color-build-face);
  --fc-floor-alt: var(--color-build-side);
  --fc-wall: var(--color-build-side);
  --fc-wall-shade: var(--color-build-roof);
  --fc-glass: var(--color-build-glass);
  /* Contact shadows are the ink token thinned out, never a literal black:
     a re-skin that darkens the ink darkens the shadows with it. */
  --fc-shadow: color-mix(in srgb, var(--color-ink) 14%, transparent);
  --fc-shadow-soft: color-mix(in srgb, var(--color-ink) 8%, transparent);

  /* --- furniture --------------------------------------------------------- */
  --fc-desk: var(--color-pop-4);
  --fc-desk-top: var(--color-build-face);
  --fc-chair: var(--color-build-roof);
  --fc-screen-on: var(--color-info);
  --fc-screen-off: var(--color-build-side);
  --fc-plant: var(--color-pop-6);
  --fc-plant-pot: var(--color-pop-7);
  --fc-rack: var(--color-cloth-suit);
  --fc-rack-face: var(--color-build-roof);
  --fc-board: var(--color-cloth-lab);
  --fc-crate: var(--color-pop-1);
  --fc-vacant: var(--color-ground);

  /* --- people ------------------------------------------------------------ */
  --fc-skin-0: var(--color-skin-1);
  --fc-skin-1: var(--color-skin-2);
  --fc-skin-2: var(--color-skin-3);
  --fc-skin-3: var(--color-skin-4);
  --fc-skin-4: var(--color-skin-5);

  --fc-hair-0: var(--color-hair-1);
  --fc-hair-1: var(--color-hair-2);
  --fc-hair-2: var(--color-hair-3);
  --fc-hair-3: var(--color-hair-4);
  --fc-hair-4: var(--color-hair-5);
  --fc-hair-5: var(--color-hair-6);

  /* Role colourways. Three variants each, so a room is not a uniform. */
  --fc-eng-0: var(--color-cloth-hoodie);
  --fc-eng-1: var(--color-pop-5);
  --fc-eng-2: var(--color-pop-8);
  --fc-res-0: var(--color-cloth-lab);
  --fc-res-1: var(--color-cloth-lab);
  --fc-res-2: var(--color-cloth-lab);
  --fc-sal-0: var(--color-pop-2);
  --fc-sal-1: var(--color-pop-3);
  --fc-sal-2: var(--color-pop-1);
  --fc-ops-0: var(--color-cloth-casual);
  --fc-ops-1: var(--color-pop-6);
  --fc-ops-2: var(--color-pop-4);
  --fc-exe-0: var(--color-cloth-suit);
  --fc-exe-1: var(--color-cloth-suit);
  --fc-exe-2: var(--color-cloth-suit);
}

/* A zone is a card that is also a control: flat, rounded, and it answers the
   pointer and the keyboard. 44px is enforced by the layout, not by this rule. */
.fc-office-zone {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px 5px;
  text-align: left;
  border-radius: var(--radius-card);
  border: 1px solid var(--color-hair);
  background-color: var(--color-panel);
  color: inherit;
  cursor: pointer;
  transition: transform 150ms cubic-bezier(0.2, 0.9, 0.3, 1.1),
    border-color 150ms ease, box-shadow 150ms ease;
}

.fc-office-zone:hover {
  border-color: var(--color-brand);
  box-shadow: var(--shadow-pop);
  transform: translateY(-2px);
}

.fc-office-zone:active {
  transform: translateY(0) scale(0.995);
}

.fc-office-zone:focus-visible {
  outline: 2px solid var(--color-brand-strong);
  outline-offset: 2px;
}

/* A room with nobody in it reads as unbuilt ground rather than a white card. */
.fc-office-zone[data-empty='true'] {
  background-color: var(--color-raised);
  border-style: dashed;
}

/* The executive row is a frame around its own buttons, so the frame itself is
   inert: it must not look or behave like one big control. */
.fc-office-zone[data-static='true'] {
  cursor: default;
}

.fc-office-zone[data-static='true']:hover {
  transform: none;
  border-color: var(--color-hair);
  box-shadow: none;
}

/* One executive's desk. A real button, comfortably over the 44px floor. */
.fc-office-desk {
  min-height: var(--tap, 44px);
  cursor: pointer;
  transition: transform 150ms cubic-bezier(0.2, 0.9, 0.3, 1.1), background-color 150ms ease,
    border-color 150ms ease;
}

.fc-office-desk:hover {
  background-color: var(--color-brand-wash);
  border-color: var(--color-brand);
  transform: translateY(-2px);
}

.fc-office-desk:focus-visible {
  outline: 2px solid var(--color-brand-strong);
  outline-offset: 2px;
}

.fc-office-figure {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  animation: fc-office-bob var(--fc-dur, 3s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-office-hand {
  transform-box: fill-box;
  transform-origin: 50% 0%;
  animation: fc-office-type var(--fc-dur, 1.3s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

.fc-office-led {
  animation: fc-office-led var(--fc-dur, 2.4s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

@keyframes fc-office-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1.8px); }
}

@keyframes fc-office-type {
  0%, 100% { transform: rotate(-8deg); }
  50% { transform: rotate(8deg); }
}

@keyframes fc-office-led {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .fc-office-zone,
  .fc-office-desk,
  .fc-office-figure,
  .fc-office-hand,
  .fc-office-led {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
  .fc-office-zone:hover,
  .fc-office-desk:hover { transform: none; box-shadow: var(--shadow-card); }
  .fc-office-led { opacity: 0.8; }
}
`;

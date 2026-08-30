/**
 * The people layer's own stylesheet.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The portrait's derived colours.** Every fill in a face resolves to an
 *    illustration token from `globals.css` (`--color-skin-*`, `--color-hair-*`,
 *    `--color-cloth-*`, `--color-pop-*`). Aliasing them onto `.fc-face` lets the
 *    SVG use plain `fill="var(--fc-…)"` presentation attributes, and a re-skin
 *    of the palette re-skins every person in the game with it. There is no hex
 *    in this folder.
 * 2. **The scene furniture** the social screens share: a seat at a table, a node
 *    on the people web, a speech card with a tail. All of them are real
 *    controls, so all of them clear the 44px tap floor and show a focus ring.
 * 3. **The idle motion.** Transform and opacity only, so nothing here can force
 *    layout: a slow head bob and a soft pop for an arriving card. Every one is
 *    switched off under `prefers-reduced-motion`, both by the global rule in
 *    `globals.css` and again here, so the scenes stay correct if that rule ever
 *    moves.
 *
 * `Portrait` emits the tag itself with a `href`/`precedence` pair; React 19
 * dedupes it, so a table of forty faces still yields a single `<style>`.
 */

export const PEOPLE_STYLE_ID = 'fc-people-scene';

export const PEOPLE_STYLES = `
.fc-face {
  --fc-face-disc: var(--color-raised);
  --fc-face-ring: var(--color-hair);
  --fc-shirt: var(--color-cloth-lab);
  --fc-line: color-mix(in srgb, var(--color-ink) 78%, transparent);
  --fc-shade: color-mix(in srgb, var(--color-ink) 12%, transparent);
  display: block;
  flex: none;
}

/* The head and shoulders bob as one, hinged at the base of the bust. */
.fc-face-bob {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  animation: fc-face-bob var(--fc-dur, 3s) ease-in-out infinite;
  animation-delay: var(--fc-delay, 0ms);
}

@keyframes fc-face-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1.1px); }
}

/* --- a seat at the boardroom table, a node on the people web -------------- */

.fc-seat {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: var(--tap, 44px);
  min-height: var(--tap, 44px);
  padding: 4px 6px 5px;
  border-radius: var(--radius-card);
  border: 1px solid var(--color-hair);
  background-color: var(--color-panel);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  text-align: center;
  transition: translate 150ms cubic-bezier(0.2, 0.9, 0.3, 1.1), box-shadow 150ms ease,
    border-color 150ms ease, background-color 150ms ease;
}

.fc-seat:hover {
  translate: 0 -2px;
  border-color: var(--color-brand);
  box-shadow: var(--shadow-pop);
}

.fc-seat:active {
  scale: 0.97;
}

.fc-seat:focus-visible {
  outline: 2px solid var(--color-brand-strong);
  outline-offset: 2px;
}

.fc-seat[data-selected='true'] {
  border-color: var(--color-brand);
  background-color: var(--color-brand-wash);
}

/* The player's own seat is stated rather than styled away: same control, brand
   ground, so "you" reads at a glance without a legend. */
.fc-seat[data-self='true'] {
  border-color: var(--color-brand);
  background-color: var(--color-brand-wash);
}

/* Out of reach is a fact about the world, not a disabled control: the node
   stays clickable — that is where the introduction route is explained. */
.fc-seat[data-reach='blocked'] {
  background-color: var(--color-raised);
  border-style: dashed;
}

/* --- the edge between two people ----------------------------------------- */

.fc-edge {
  stroke-linecap: round;
  transition: opacity 150ms ease;
}

/* --- a speech card ------------------------------------------------------- */

.fc-speech {
  position: relative;
  border: 1px solid var(--color-hair);
  border-radius: var(--radius-panel);
  background-color: var(--color-panel);
  box-shadow: var(--shadow-card);
}

/* The tail is a rotated square rather than a border triangle so the hairline
   carries around it: two of its sides are the card's own border. */
.fc-speech::before {
  content: '';
  position: absolute;
  top: 15px;
  left: -6px;
  width: 10px;
  height: 10px;
  rotate: 45deg;
  border-left: 1px solid var(--color-hair);
  border-bottom: 1px solid var(--color-hair);
  border-bottom-left-radius: 3px;
  background-color: var(--color-panel);
}

.fc-speech[data-side='right']::before {
  left: auto;
  right: -6px;
  rotate: 225deg;
  background-color: var(--color-brand-wash);
  border-left-color: var(--color-brand-wash);
  border-bottom-color: var(--color-brand-wash);
}

.fc-speech[data-side='right'] {
  background-color: var(--color-brand-wash);
  border-color: var(--color-brand-wash);
}

/* Above a phone-width tail the card sits under the face instead of beside it,
   and a tail pointing at nothing is worse than no tail. */
@media (max-width: 520px) {
  .fc-speech::before { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fc-face-bob {
    animation: none !important;
    transform: none !important;
  }
  .fc-seat {
    transition: none !important;
  }
  .fc-seat:hover {
    translate: none !important;
    box-shadow: var(--shadow-card);
  }
  .fc-seat:active {
    scale: none !important;
  }
}
`;

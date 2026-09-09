/**
 * The rules the world map cannot be allowed to break, checked against its own
 * source.
 *
 * `map.test.ts` proves the model is honest. This one proves the *drawing* is
 * disciplined, and it does it by reading the folder rather than by mounting it:
 * the app's `tsconfig` keeps `jsx: "preserve"` for Next, so a test may not
 * render a component without changing configuration it does not own.
 *
 * Five invariants, each of which has a way of quietly coming back:
 *
 * 1. **No colour literal.** Every paint in the scene is a design token, so a
 *    re-skin of `globals.css` re-skins the world with it.
 * 2. **No nondeterminism.** No `Math.random`, no `Date.now`, no `new Date`. A
 *    livery derived from a clock differs between the server render and the
 *    hydration that follows it.
 * 3. **No game loop.** No canvas, no `requestAnimationFrame`, no interval. The
 *    life in the scene is CSS, and CSS is what `prefers-reduced-motion` can
 *    switch off.
 * 4. **Motion is transform and opacity only**, and the scene answers reduced
 *    motion in its own stylesheet rather than relying on the global rule.
 * 5. **Public information only.** The scene reads the projection through the
 *    documented hooks and never walks `session.companies`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAP_STYLES } from './styles';

const FOLDER = join(process.cwd(), 'src/components/scenes/map');

/**
 * Comments describe the rules; they are not the code the rules apply to. A
 * sentence that says "no `Math.random`" must not itself trip the check.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = readdirSync(FOLDER)
  .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts'))
  .map((name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    return { name, text, code: code(text) };
  });

describe('world map: source discipline', () => {
  it('has the files the scene is made of', () => {
    const names = SOURCES.map((source) => source.name).sort();
    expect(names).toEqual(['Buildings.tsx', 'Detail.tsx', 'WorldMap.tsx', 'geography.ts', 'index.ts', 'model.ts', 'styles.ts']);
  });

  it('never writes a colour literal: the palette belongs to globals.css', () => {
    for (const source of SOURCES) {
      const hex = source.code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hex, `${source.name} contains a hex colour`).toEqual([]);
      expect(source.code, `${source.name} contains a raw rgb()`).not.toMatch(/\brgba?\(\s*\d/);
      expect(source.code, `${source.name} contains a raw hsl()`).not.toMatch(/\bhsla?\(\s*\d/);
    }
  });

  it('draws every shape with a token, a prop or nothing', () => {
    for (const source of SOURCES) {
      if (!source.name.endsWith('.tsx')) continue;
      for (const match of source.code.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
        const value = match[1] ?? '';
        if (value === 'none') continue;
        expect(value, `${source.name}: unexpected paint "${value}"`).toMatch(/^var\(--(color|fc)-/);
      }
    }
  });

  it('is deterministic by construction: no clock, no randomness', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} uses Math.random`).not.toMatch(/Math\s*\.\s*random/);
      expect(source.code, `${source.name} uses Date.now`).not.toMatch(/Date\s*\.\s*now/);
      expect(source.code, `${source.name} constructs a Date`).not.toMatch(/new\s+Date\b/);
    }
    // The one entropy source the scene is allowed is the shared 64-bit hash.
    expect(SOURCES.find((source) => source.name === 'model.ts')?.code).toContain('fnv1a64');
  });

  it('runs no game loop: the life in the world is CSS', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} uses requestAnimationFrame`).not.toMatch(/requestAnimationFrame/);
      expect(source.code, `${source.name} uses a timer`).not.toMatch(/set(Interval|Timeout)\s*\(/);
      expect(source.code, `${source.name} uses a canvas`).not.toMatch(/<canvas|getContext\s*\(/);
    }
  });

  it('scopes its palette to a root the scene actually carries', () => {
    // Every fill is `var(--fc-map-*)`, and those variables are declared on
    // `.fc-map`. A scene root that loses the class does not degrade — an
    // unresolved `var()` in a `fill` renders *black*.
    expect(MAP_STYLES).toContain('.fc-map {');
    const scene = SOURCES.find((source) => source.name === 'WorldMap.tsx')?.code ?? '';
    expect(scene).toMatch(/fc-map(?![-\w])/);
  });

  it('reads engine state only through the documented store hooks', () => {
    for (const name of ['WorldMap.tsx', 'Detail.tsx']) {
      const scene = SOURCES.find((source) => source.name === name)?.code ?? '';
      expect(scene, `${name} does not import the store`).toMatch(/from '@\/lib\/game'/);
      // Never a rival's canonical row, and never a rival's secret programme.
      expect(scene, `${name} walks session.companies`).not.toMatch(/session\s*\.\s*companies/);
      expect(scene, `${name} reads research programmes`).not.toMatch(/researchProjects/);
      expect(scene, `${name} reads a rival's tech graph`).not.toMatch(/confidenceByCompany/);
    }
  });

  it('never renders the internal truthfulness flag of a disclosure', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} reads isTruthful`).not.toMatch(/isTruthful/);
    }
  });

  it('keeps every interactive shape reachable from the keyboard', () => {
    const scene = SOURCES.find((source) => source.name === 'WorldMap.tsx')?.code ?? '';
    const buttons = (scene.match(/role="button"/g) ?? []).length;
    const tabbable = (scene.match(/tabIndex=\{0\}/g) ?? []).length;
    const keyed = (scene.match(/onKeyDown=/g) ?? []).length;
    expect(buttons).toBeGreaterThanOrEqual(2);
    expect(tabbable).toBe(buttons);
    expect(keyed).toBeGreaterThanOrEqual(2);
  });
});

describe('world map: motion', () => {
  const keyframes = [...MAP_STYLES.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');

  it('declares keyframes at all', () => {
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframes).toMatch(/transform|opacity/);
  });

  it('animates nothing that forces layout', () => {
    expect(keyframes).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
  });

  it('switches itself off under prefers-reduced-motion', () => {
    expect(MAP_STYLES).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = MAP_STYLES.slice(MAP_STYLES.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['fc-map-flag', 'fc-map-bob', 'fc-map-rotor', 'fc-map-led', 'fc-map-pulse', 'fc-map-drift']) {
      expect(reduced, `${cls} keeps animating under reduced motion`).toContain(cls);
    }
  });

  it('declares every illustration variable the drawing reaches for', () => {
    const declared = new Set([...MAP_STYLES.matchAll(/(--fc-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    for (const source of SOURCES) {
      if (!source.name.endsWith('.tsx')) continue;
      for (const match of source.code.matchAll(/var\((--fc-[a-z0-9-]+)\)/g)) {
        const name = match[1];
        // `--fc-dur` and `--fc-delay` are set inline on the element, not declared.
        if (name === undefined || name === '--fc-dur' || name === '--fc-delay') continue;
        expect(declared.has(name), `${name} is used but never declared`).toBe(true);
      }
    }
    // The indexed ramps, which are built by template literal at the call site.
    for (let index = 0; index < 8; index += 1) expect(declared.has(`--fc-map-brand-${index}`)).toBe(true);
    for (let index = 0; index < 5; index += 1) expect(declared.has(`--fc-map-skin-${index}`)).toBe(true);
    for (let index = 0; index < 6; index += 1) expect(declared.has(`--fc-map-hair-${index}`)).toBe(true);
  });
});

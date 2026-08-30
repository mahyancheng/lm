/**
 * The rules the office scene cannot be allowed to break, checked against its
 * own source.
 *
 * The model test proves the arithmetic is honest. This one proves the *drawing*
 * is disciplined, and it does it by reading the folder rather than by rendering
 * it: the app's `tsconfig` keeps `jsx: "preserve"` for Next, so a test may not
 * mount a component without changing configuration it does not own.
 *
 * Four invariants, each of which has a way of quietly coming back:
 *
 * 1. **No colour literal.** Every fill in the scene is a design token, so a
 *    re-skin of `globals.css` re-skins the office. One `#3b82f6` typed into an
 *    SVG and the office stops following the palette.
 * 2. **No nondeterminism.** No `Math.random`, no `Date.now`, no `new Date`. A
 *    face derived from a clock differs between the server render and the
 *    hydration that follows it, and differs again next quarter.
 * 3. **No game loop.** No canvas, no `requestAnimationFrame`, no interval. The
 *    life in the scene is CSS, and CSS is what `prefers-reduced-motion` can
 *    switch off.
 * 4. **Motion is transform and opacity only**, and the scene answers reduced
 *    motion in its own stylesheet rather than relying on the global rule.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICE_STYLES } from './styles';

const FOLDER = join(process.cwd(), 'src/components/scenes/office');

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

describe('office scene: source discipline', () => {
  it('has the files the scene is made of', () => {
    const names = SOURCES.map((source) => source.name).sort();
    expect(names).toEqual(['Figures.tsx', 'OfficeScene.tsx', 'Rooms.tsx', 'index.ts', 'model.ts', 'seats.ts', 'styles.ts']);
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
    expect(SOURCES.find((source) => source.name === 'seats.ts')?.code).toContain('fnv1a64');
  });

  it('runs no game loop: the life in the office is CSS', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} uses requestAnimationFrame`).not.toMatch(/requestAnimationFrame/);
      expect(source.code, `${source.name} uses a timer`).not.toMatch(/set(Interval|Timeout)\s*\(/);
      expect(source.code, `${source.name} uses a canvas`).not.toMatch(/<canvas|getContext\s*\(/);
    }
  });

  it('reads engine state only through the documented store hooks', () => {
    const scene = SOURCES.find((source) => source.name === 'OfficeScene.tsx')?.code ?? '';
    expect(scene).toMatch(/from '@\/lib\/game'/);
    // Never the raw provider internals, and never a rival's row.
    expect(scene).not.toMatch(/session\.companies/);
    expect(scene).not.toMatch(/visibleCompanies/);
    expect(scene).not.toMatch(/researchProjects/);
  });
});

describe('office scene: motion', () => {
  const keyframes = [...OFFICE_STYLES.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');

  it('declares keyframes at all', () => {
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframes).toMatch(/transform|opacity/);
  });

  it('animates nothing that forces layout', () => {
    expect(keyframes).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
  });

  it('switches itself off under prefers-reduced-motion', () => {
    expect(OFFICE_STYLES).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = OFFICE_STYLES.slice(OFFICE_STYLES.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['fc-office-figure', 'fc-office-hand', 'fc-office-led', 'fc-office-zone']) {
      expect(reduced, `${cls} keeps animating under reduced motion`).toContain(cls);
    }
  });

  it('defines every illustration variable the figures reach for', () => {
    const declared = new Set([...OFFICE_STYLES.matchAll(/(--fc-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set<string>();
    for (const source of SOURCES) {
      if (!source.name.endsWith('.tsx')) continue;
      for (const match of source.code.matchAll(/var\((--fc-[a-z0-9-]+)\)/g)) {
        const name = match[1];
        // Indexed ramps are built by template literal and checked below.
        if (name !== undefined) used.add(name);
      }
    }
    for (const name of used) {
      // `--fc-dur` and `--fc-delay` are set inline by `motionVars`, not declared.
      if (name === '--fc-dur' || name === '--fc-delay') continue;
      expect(declared.has(name), `${name} is used but never declared`).toBe(true);
    }
    // The indexed ramps: five skins, six hair colours, three outfits per role.
    for (let index = 0; index < 5; index += 1) expect(declared.has(`--fc-skin-${index}`)).toBe(true);
    for (let index = 0; index < 6; index += 1) expect(declared.has(`--fc-hair-${index}`)).toBe(true);
    for (const role of ['eng', 'res', 'sal', 'ops', 'exe']) {
      for (let index = 0; index < 3; index += 1) expect(declared.has(`--fc-${role}-${index}`)).toBe(true);
    }
  });
});

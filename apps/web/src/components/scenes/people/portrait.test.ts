/**
 * The rules the people layer cannot be allowed to break.
 *
 * Two of them are about the *derivation*, and they are checked against the real
 * demo cast rather than against invented ids:
 *
 * 1. **Determinism.** The same character id and role produce the same face,
 *    every time, in any process. A face derived from a clock or a counter would
 *    differ between the server render and the hydration that follows it, and
 *    would differ again next quarter — which is exactly the class of bug that
 *    makes an interface feel untrustworthy.
 * 2. **Uniqueness.** No two of the sixteen demo characters draw the same
 *    portrait. Sixteen people around this world's boardrooms, feeds and deal
 *    rooms have to be told apart at a glance, and "they look similar" is a bug
 *    in a game where a face is an identity.
 *
 * The rest is source discipline, checked by reading the folder rather than by
 * rendering it: the app's `tsconfig` keeps `jsx: "preserve"` for Next, so a test
 * here may not mount a component without changing configuration it does not own.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoSessionInput } from '@frontier/simulation';
import {
  CHIEF_OF_STAFF,
  PORTRAIT_ACCESSORIES,
  garmentFill,
  garmentOfRole,
  moodFromRelationship,
  moodFromScore,
  pickIndex,
  portraitLook,
  portraitSignature,
} from './look';
import { PEOPLE_STYLES } from './styles';

const CAST = demoSessionInput().characters ?? [];

/* -------------------------------------------------------------------------- */
/*  The derivation                                                             */
/* -------------------------------------------------------------------------- */

describe('the demo cast', () => {
  it('is the sixteen characters the world ships with', () => {
    expect(CAST).toHaveLength(16);
  });

  it('draws every one of them differently', () => {
    const seen = new Map<string, string>();
    for (const character of CAST) {
      const signature = portraitSignature(portraitLook(character.id, character.role));
      const clash = seen.get(signature);
      expect(clash, `${character.name} draws identically to ${clash ?? ''}`).toBeUndefined();
      seen.set(signature, character.name);
    }
    expect(seen.size).toBe(CAST.length);
  });

  it('draws the same face twice', () => {
    for (const character of CAST) {
      const first = portraitLook(character.id, character.role);
      const second = portraitLook(character.id, character.role);
      expect(second).toEqual(first);
    }
  });

  it('uses the whole skin ramp rather than one corner of it', () => {
    const tones = new Set(CAST.map((character) => portraitLook(character.id, character.role).skin));
    expect(tones.size).toBeGreaterThanOrEqual(4);
  });

  it('dresses people by role, not by hash', () => {
    for (const character of CAST) {
      const look = portraitLook(character.id, character.role);
      expect(look.garment).toBe(garmentOfRole(character.role));
      // The same person in a different role changes clothes and nothing else.
      const asInvestor = portraitLook(character.id, 'investor');
      expect(asInvestor.garment).toBe('suit');
      expect(asInvestor.skin).toBe(look.skin);
      expect(asInvestor.hairStyle).toBe(look.hairStyle);
      expect(asInvestor.accessory).toBe(look.accessory);
    }
  });

  it('gives the Chief of Staff a face of their own', () => {
    const chief = portraitLook(CHIEF_OF_STAFF.id, CHIEF_OF_STAFF.role);
    expect(chief.garment).toBe('blazer');
    const signatures = new Set(CAST.map((character) => portraitSignature(portraitLook(character.id, character.role))));
    expect(signatures.has(portraitSignature(chief))).toBe(false);
  });
});

describe('the derivation itself', () => {
  it('stays inside the palette for any id', () => {
    for (let index = 0; index < 400; index += 1) {
      const look = portraitLook(`chr_synthetic_${index}`, 'researcher');
      expect(look.skin).toBeGreaterThanOrEqual(1);
      expect(look.skin).toBeLessThanOrEqual(5);
      expect(look.hairColour).toBeGreaterThanOrEqual(1);
      expect(look.hairColour).toBeLessThanOrEqual(6);
      expect(look.hairStyle).toBeGreaterThanOrEqual(0);
      expect(look.hairStyle).toBeLessThanOrEqual(7);
      expect(look.accent).toBeGreaterThanOrEqual(1);
      expect(look.accent).toBeLessThanOrEqual(8);
      expect(PORTRAIT_ACCESSORIES).toContain(look.accessory);
      expect([-1, 0, 1]).toContain(look.tilt);
      expect(look.bobDurationMs).toBeGreaterThanOrEqual(2800);
      expect(look.bobDelayMs).toBeLessThan(2400);
    }
  });

  it('keeps features independent: salts do not move together', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `chr_independent_${index}`);
    const pairs = new Set(ids.map((id) => `${pickIndex(id, 'skin', 5)}:${pickIndex(id, 'haircolour', 6)}`));
    // Thirty combinations exist; a derivation that moved skin and hair together
    // would collapse this to six, and the cast would fall into visible families.
    expect(pairs.size).toBe(30);
  });

  it('does not collapse ids that differ only in their last character', () => {
    // The regression this guards: FNV-1a's final xor-and-multiply leaves two
    // such ids a fixed stride apart, and a stride divisible by the palette size
    // is invisible to the modulo — every seat in a room would share a face.
    const ids = Array.from({ length: 40 }, (_, index) => `cmp_player/engineering/${index}`);
    expect(new Set(ids.map((id) => pickIndex(id, 'skin', 5))).size).toBe(5);
    expect(new Set(ids.map((id) => pickIndex(id, 'haircolour', 6))).size).toBe(6);
    expect(new Set(ids.map((id) => portraitSignature(portraitLook(id, 'researcher')))).size).toBeGreaterThan(30);
  });

  it('never emits a colour that is not a token', () => {
    for (const garment of ['suit', 'blazer', 'lab', 'hoodie', 'uniform', 'casual'] as const) {
      for (let variant = 0; variant < 3; variant += 1) {
        expect(garmentFill(garment, variant)).toMatch(/^var\(--color-[a-z0-9-]+\)$/);
      }
    }
  });

  it('answers an unknown role with plain clothes rather than a crash', () => {
    expect(garmentOfRole(undefined)).toBe('casual');
    expect(garmentOfRole('time_traveller')).toBe('casual');
  });
});

describe('mood comes from state the caller already has', () => {
  it('reads a 0-100 score in the same bands a Meter does', () => {
    expect(moodFromScore(92)).toBe('delighted');
    expect(moodFromScore(60)).toBe('content');
    expect(moodFromScore(40)).toBe('neutral');
    expect(moodFromScore(20)).toBe('guarded');
    expect(moodFromScore(4)).toBe('hostile');
  });

  it('reads a -100..100 relationship through the same bands', () => {
    expect(moodFromRelationship(80)).toBe('delighted');
    expect(moodFromRelationship(0)).toBe('neutral');
    expect(moodFromRelationship(-90)).toBe('hostile');
  });

  it('falls back to a pleasant, uncommitted face when nothing is known', () => {
    expect(moodFromScore(null)).toBe('content');
    expect(moodFromScore(undefined)).toBe('content');
    expect(moodFromScore(Number.NaN)).toBe('content');
    expect(moodFromRelationship(null)).toBe('content');
  });
});

/* -------------------------------------------------------------------------- */
/*  Source discipline                                                          */
/* -------------------------------------------------------------------------- */

const FOLDER = join(process.cwd(), 'src/components/scenes/people');

/** Comments describe the rules; they are not the code the rules apply to. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = readdirSync(FOLDER)
  .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts'))
  .map((name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    return { name, text, code: code(text) };
  });

describe('people layer: source discipline', () => {
  it('has the files the layer is made of', () => {
    expect(SOURCES.map((source) => source.name).sort()).toEqual(['Portrait.tsx', 'SpeechCard.tsx', 'index.ts', 'look.ts', 'styles.ts']);
  });

  it('never writes a colour literal: the palette belongs to globals.css', () => {
    for (const source of SOURCES) {
      expect(source.code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], `${source.name} contains a hex colour`).toEqual([]);
      expect(source.code, `${source.name} contains a raw rgb()`).not.toMatch(/\brgba?\(\s*\d/);
      expect(source.code, `${source.name} contains a raw hsl()`).not.toMatch(/\bhsla?\(\s*\d/);
    }
    expect(PEOPLE_STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('is deterministic: no clock, no random', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} reads a random number`).not.toMatch(/Math\.random/);
      expect(source.code, `${source.name} reads a clock`).not.toMatch(/Date\.now|new Date\(/);
    }
  });

  it('runs no game loop: the life in a face is CSS', () => {
    for (const source of SOURCES) {
      expect(source.code, `${source.name} uses canvas`).not.toMatch(/getContext\(|<canvas/);
      expect(source.code, `${source.name} drives a frame loop`).not.toMatch(/requestAnimationFrame|setInterval/);
    }
  });

  it('animates transform and opacity only, and answers reduced motion itself', () => {
    const animated = PEOPLE_STYLES.match(/@keyframes[^}]*\{[\s\S]*?\n\}/g) ?? [];
    expect(animated.length).toBeGreaterThan(0);
    for (const block of animated) {
      const properties = block.match(/^\s*([a-z-]+):/gm) ?? [];
      for (const property of properties) {
        expect(['transform:', 'opacity:'], `keyframe animates ${property}`).toContain(property.trim());
      }
    }
    expect(PEOPLE_STYLES).toMatch(/prefers-reduced-motion/);
  });

  it('keeps every seat over the 44px tap floor', () => {
    expect(PEOPLE_STYLES).toMatch(/min-width:\s*var\(--tap, 44px\)/);
    expect(PEOPLE_STYLES).toMatch(/min-height:\s*var\(--tap, 44px\)/);
    expect(PEOPLE_STYLES).toMatch(/:focus-visible/);
  });
});

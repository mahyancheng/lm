/**
 * @frontier/simulation — the line between world 3 and the worlds it replaces.
 *
 * World 2's catalogue is not deleted: a world-2 game that is still being played
 * has to keep running, `PRODUCT_CATEGORIES` still backs it, and the frozen
 * hashes still depend on every line of it. What must be true instead is that no
 * world-3 code can reach it — because the day a world-3 module resolves a
 * category is the day the two economies start disagreeing again, which is the
 * defect this whole world exists to end.
 *
 * A grep is a blunt instrument and exactly the right one here: the question is
 * not "does this behave correctly" but "is this name mentioned at all", and a
 * behavioural test cannot answer that. Comments may name the catalogue — this
 * file's own do — so only code is scanned.
 *
 * The same test covers `TechEdgeSchema` and `TechTrackSchema`. The world-3
 * Frontier Map is the node table projected: its edge list is always empty and
 * its tracks are the six sectors, so a world-3 module that reached for either
 * schema would be building a second graph beside the one economy.
 */

import { describe, expect, it } from 'vitest';
import { MINIMUM_SUPPORTED_WORLD_VERSION, RETIRED_WORLD_SAVE_MESSAGE, worldVersionIsSupported } from '@frontier/contracts';

/** Vite supplies this at transform time; the package carries no Vite types. */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}

/** Comments may name anything; only code counts. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Names no world-3 module may mention, with what each one would mean if it did. */
const FORBIDDEN: readonly { readonly name: string; readonly why: string }[] = [
  { name: 'PRODUCT_CATEGORIES', why: 'the world-2 catalogue is a second economy beside the node table' },
  { name: 'productCategories', why: 'the world-2 catalogue module is deprecated and world-2 only' },
  { name: 'categoryById', why: 'resolving a world-2 category in world 3 reintroduces the second catalogue' },
  { name: 'defaultCategoryFor', why: 'a world-3 launch names a NODE, never a category' },
  { name: 'segmentReferencePrice', why: 'a world-3 price is judged against its own node’s market price' },
  { name: 'TechEdgeSchema', why: 'the world-3 map is the node table projected, and its edge list is always empty' },
  { name: 'TechTrackSchema', why: 'world-3 tracks are the six sectors, derived, never authored' },
];

describe('the world-3 modules cannot reach world 2', () => {
  const sources = {
    ...import.meta.glob('../src/graph/*.ts', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../src/scenario/world3/*.ts', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../src/research/ownership.ts', { query: '?raw', import: 'default', eager: true }),
  } as Record<string, string>;

  it('scanned the modules it claims to have scanned', () => {
    const paths = Object.keys(sources);
    expect(paths.length, 'no world-3 source was scanned at all').toBeGreaterThanOrEqual(8);
    for (const marker of ['cost.ts', 'lines.ts', 'licensing.ts', 'production.ts', 'market.ts']) {
      expect(paths.some((path) => path.endsWith(marker)), `${marker} was not scanned`).toBe(true);
    }
  });

  for (const { name, why } of FORBIDDEN) {
    it(`names ${name} nowhere: ${why}`, () => {
      for (const [path, source] of Object.entries(sources)) {
        expect(codeOf(source).includes(name), `${path} names ${name}`).toBe(false);
      }
    });
  }
});

describe('the node table itself is free of the catalogue', () => {
  const sources = import.meta.glob('../../contracts/src/node*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('scanned the node contracts', () => {
    const paths = Object.keys(sources);
    for (const marker of ['nodes.ts', 'nodeGraph.ts', 'nodeOwnership.ts']) {
      expect(paths.some((path) => path.endsWith(marker)), `${marker} was not scanned`).toBe(true);
    }
  });

  it('imports nothing from the deprecated catalogue, and authors no tech edges', () => {
    for (const [path, source] of Object.entries(sources)) {
      const code = codeOf(source);
      expect(code.includes('productCategories'), `${path} imports the deprecated catalogue`).toBe(false);
      expect(code.includes('PRODUCT_CATEGORIES'), `${path} names the deprecated catalogue`).toBe(false);
      expect(code.includes('TechEdgeSchema'), `${path} authors a tech edge`).toBe(false);
      expect(code.includes('TechTrackSchema'), `${path} authors a tech track`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Saves from a world this build retired                                      */
/* -------------------------------------------------------------------------- */

describe('a save from an earlier world', () => {
  it('is refused rather than migrated, in one plain sentence', () => {
    expect(MINIMUM_SUPPORTED_WORLD_VERSION).toBe(3);
    expect(worldVersionIsSupported(1)).toBe(false);
    expect(worldVersionIsSupported(2)).toBe(false);
    expect(worldVersionIsSupported(3)).toBe(true);
    // The exact words, because they are what a player reads when a save they
    // were playing yesterday will not open today.
    expect(RETIRED_WORLD_SAVE_MESSAGE).toBe(
      'This save was made in world 2. World 3 rebuilt the economy from the ground up and cannot replay it. Start a new game.',
    );
  });
});

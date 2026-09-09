/**
 * The Connections geometry, judged the way a drawing is judged: by where things
 * land.
 *
 * Four claims, all of which have to hold at every width a phone can produce.
 *
 * 1. **Nothing leaves the container.** Every pill, every header and the hub sit
 *    inside `[0, W]` at every width the app actually produces. The widths are
 *    measured, not chosen: a critic pass found the panel's content box is 356
 *    at a 390-point viewport and 326 at a 360-point one, while this file was
 *    asserting 358 and 328 — so every judgement about what fits was made nine
 *    points per pill wider than the screen ever is. `WIDTHS` therefore carries
 *    the measured pair, the pair the old padding produced, and the extremes.
 * 2. **Every pill is a thumb target**, at least 44 points tall, and no two on
 *    the same side overlap — so a tap always lands on exactly one thing.
 * 3. **A wire starts on the pill it belongs to** — the midpoint of its wire
 *    edge — and ends on the hub's anchor or the junction. Not near them: on
 *    them, to the point, because a wire that stops short reads as a broken
 *    relationship.
 * 4. **Dashed means "not yet"**, exactly: a possible route or an empty slot,
 *    and nothing else. A blocked wire is solid in the loss tone, since dashing
 *    it too would say "you could have this".
 * 5. **The margin badge sits on the wire, not on the company.** It clears the
 *    hub's own ring and the right column at every width.
 */

import { describe, expect, it } from 'vitest';
import {
  GAP,
  HEADER_H,
  HUB,
  MARGIN_R,
  MIN_HUB_STACK,
  NESTED_H,
  NESTED_INDENT,
  PILL_H,
  PILL_PITCH,
  SUBHEADER_H,
  flowWire,
  layoutConnections,
  pillWidth,
  type ConnectionsLayout,
  type LayoutGroup,
  type PillState,
} from './layout';

/**
 * Measured, not chosen: 356 and 326 are the panel's content box on a 390- and a
 * 360-point phone; 340 and 332 are what the same panels measured before the
 * padding was cut, and are kept so a padding change that regresses them fails
 * here rather than on the owner's phone; 320 and 560 are the extremes.
 */
const WIDTHS = [320, 326, 332, 340, 356, 390, 560] as const;

/** A group of `states.length` pills, with a header unless `header` is null. */
function group(key: string, header: string | null, states: readonly PillState[], subheader: string | null = null): LayoutGroup {
  return { key, header, subheader, pills: states.map((state, index) => ({ key: `${key}:${index}`, state })) };
}

const LEFT: readonly LayoutGroup[] = [
  group('model', 'Model', ['live', 'possible', 'possible'], '1 call per unit'),
  group('harness', 'Harness', ['blocked'], '2 licences per unit'),
  group('data', 'Dataset', ['empty'], '1 PB per unit'),
];
const RIGHT: readonly LayoutGroup[] = [
  group('buyers', 'Buyers', ['live', 'live']),
  group('markets', 'Market', ['live', 'possible', 'possible', 'possible']),
];

function layoutAt(width: number, left: readonly LayoutGroup[] = LEFT, right: readonly LayoutGroup[] = RIGHT): ConnectionsLayout {
  return layoutConnections({ width, left, right, hub: { showOutput: true } });
}

/** Every laid box that has to stay inside the container. */
function boxesOf(layout: ConnectionsLayout): readonly { x: number; width: number; what: string }[] {
  return [
    ...layout.pills.map((pill) => ({ x: pill.x, width: pill.width, what: `pill ${pill.key}` })),
    ...layout.headers.map((header) => ({ x: header.x, width: header.width, what: `header ${header.key}` })),
    { x: layout.hub.x, width: layout.hub.size, what: 'hub' },
    { x: layout.hub.labelBox.x, width: layout.hub.labelBox.width, what: 'hub label' },
    { x: layout.hub.figuresBox.x, width: layout.hub.figuresBox.width, what: 'hub figures' },
  ];
}

describe('pillWidth', () => {
  it('splits whatever the hub and its two channels leave, and stops at 180', () => {
    // The two the app actually renders, first.
    expect(pillWidth(356)).toBe(130);
    expect(pillWidth(326)).toBe(115);
    expect(pillWidth(390)).toBe(147);
    expect(pillWidth(560)).toBe(180);
    for (const width of WIDTHS) expect(pillWidth(width) * 2 + HUB + GAP * 2).toBeLessThanOrEqual(width);
  });

  /**
   * The floor the pill's own text budget is written against.
   *
   * `ConnectionPill` spends 12 points of padding, 20 of glyph and 4 of gap, so
   * a name and a data row get `pillWidth - 36`. At the narrowest width the app
   * produces that has to leave enough for the six-character figure tag and the
   * fourteen-character detail `model.ts` writes to; below about 78 points it
   * does not, and the data row starts eating its own numbers.
   */
  it('leaves at least 78 points of text on the narrowest phone the app renders', () => {
    expect(pillWidth(326) - 36).toBeGreaterThanOrEqual(78);
  });
});

describe('the picture fits the phone', () => {
  for (const width of WIDTHS) {
    it(`keeps every pill, header and the hub inside ${width}`, () => {
      const layout = layoutAt(width);
      for (const box of boxesOf(layout)) {
        expect(box.x, `${box.what} starts left of 0`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${box.what} runs past ${width}`).toBeLessThanOrEqual(width);
      }
      expect(layout.width).toBe(width);
    });
  }

  it('never lets two pills on the same side overlap, and never draws one under 44 points', () => {
    for (const width of WIDTHS) {
      const layout = layoutAt(width);
      for (const side of ['left', 'right'] as const) {
        const boxes = [
          ...layout.pills.filter((pill) => pill.side === side).map((pill) => ({ y: pill.y, height: pill.height, key: pill.key })),
          ...layout.headers.filter((header) => header.side === side).map((header) => ({ y: header.y, height: header.height, key: `h:${header.key}` })),
        ].sort((a, b) => a.y - b.y);
        for (let index = 1; index < boxes.length; index += 1) {
          const above = boxes[index - 1];
          const below = boxes[index];
          expect((above?.y ?? 0) + (above?.height ?? 0), `${above?.key} overlaps ${below?.key} at ${width}`).toBeLessThanOrEqual(below?.y ?? 0);
        }
      }
      for (const pill of layout.pills) expect(pill.height).toBeGreaterThanOrEqual(44);
    }
  });

  it('is never shorter than the hub needs, and grows by one pitch per pill', () => {
    const one = layoutAt(356, [group('a', null, ['live'])], []);
    expect(one.height).toBe(MIN_HUB_STACK);

    const tall = (count: number): number => layoutAt(356, [group('a', 'A', Array.from({ length: count }, () => 'live' as PillState))], []).height;
    expect(tall(4)).toBe(HEADER_H + 4 * PILL_PITCH);
    expect(tall(5) - tall(4)).toBe(PILL_PITCH);
    expect(tall(9) - tall(8)).toBe(PILL_PITCH);
  });

  /**
   * A slot's recipe — "40 1M tokens per unit" — is 21 characters and its slot
   * name is another 5, and the two on one 130-point row is the truncation the
   * critic found ("MODEL · 40 1…"). The recipe therefore gets its own line, and
   * the stack has to make room for it or the first pill sits on top of it.
   */
  it('gives a group with a recipe a second header line, and only that group', () => {
    const withRecipe = layoutAt(356, [group('a', 'Model', ['live'], '40 1M tokens per unit')], []);
    const plain = layoutAt(356, [group('a', 'Model', ['live'])], []);
    expect(withRecipe.headers[0]?.height).toBe(HEADER_H + SUBHEADER_H);
    expect(withRecipe.headers[0]?.subtext).toBe('40 1M tokens per unit');
    expect(plain.headers[0]?.height).toBe(HEADER_H);
    expect(plain.headers[0]?.subtext).toBeNull();
    // The pill sits below the whole header, not below its first line.
    expect((withRecipe.pills[0]?.y ?? 0) - (withRecipe.headers[0]?.y ?? 0)).toBe(HEADER_H + SUBHEADER_H);
  });
});

describe('nesting', () => {
  it('indents a nested pill 16 points from the wire edge and draws it 44 tall, on a bracket', () => {
    const layout = layoutConnections({
      width: 356,
      left: [],
      right: [
        {
          key: 'options',
          header: 'Research',
          subheader: null,
          pills: [
            { key: 'opt', state: 'possible' },
            { key: 'unlock', state: 'possible', nested: true, parentKey: 'opt' },
          ],
        },
      ],
      hub: { showOutput: true },
    });
    const parent = layout.pills.find((pill) => pill.key === 'opt');
    const child = layout.pills.find((pill) => pill.key === 'unlock');
    expect(parent?.height).toBe(PILL_H);
    expect(child?.height).toBe(NESTED_H);
    expect((child?.x ?? 0) - (parent?.x ?? 0)).toBe(NESTED_INDENT);
    expect(child?.width).toBe((parent?.width ?? 0) - NESTED_INDENT);
    expect((child?.y ?? 0) - (parent?.y ?? 0)).toBe(PILL_PITCH);

    const bracket = layout.wires.find((wire) => wire.key === 'w:unlock');
    expect(bracket?.kind).toBe('bracket');
    // Down the parent's inner edge, then across into the child's wire edge.
    expect(bracket?.path).toBe(
      `M ${(parent?.x ?? 0) + 10} ${(parent?.y ?? 0) + PILL_H} L ${(parent?.x ?? 0) + 10} ${(child?.y ?? 0) + NESTED_H / 2} L ${child?.x} ${(child?.y ?? 0) + NESTED_H / 2}`,
    );
  });
});

describe('wires', () => {
  it('runs every flow wire from the pill\'s wire-edge midpoint to the hub anchor or the junction', () => {
    for (const width of WIDTHS) {
      const layout = layoutAt(width);
      const byKey = new Map(layout.pills.map((pill) => [pill.key, pill]));
      for (const wire of layout.wires) {
        if (wire.kind === 'trunk') continue;
        const pill = byKey.get(wire.key.slice(2));
        expect(pill, `${wire.key} belongs to no pill`).toBeDefined();
        if (pill === undefined) continue;
        const centre = pill.y + pill.height / 2;
        const from = pill.side === 'left' ? { x: pill.x + pill.width, y: centre } : { x: pill.x, y: centre };
        const to = pill.side === 'left' ? layout.hub.inputAnchor : layout.hub.junction;
        expect(wire.path).toBe(flowWire(from, to));
        expect(wire.kind).toBe(pill.side === 'left' ? 'input' : 'output');
      }
    }
  });

  /**
   * The badge is a fact about the wire leaving the company, so it may not sit
   * on the company. Drawn halfway along the trunk it overlapped the hub's ring
   * by three points at this channel width; on the junction it clears both the
   * hub and the right column by `GAP / 2 - MARGIN_R`.
   */
  it('puts the margin badge on the trunk, clear of the hub and of the right column', () => {
    for (const width of WIDTHS) {
      const layout = layoutAt(width);
      const rightX = Math.min(...layout.pills.filter((pill) => pill.side === 'right').map((pill) => pill.x));
      expect(layout.hub.marginAnchor.y).toBe(layout.hub.junction.y);
      expect(layout.hub.marginAnchor.x - MARGIN_R, `badge overlaps the hub at ${width}`).toBeGreaterThanOrEqual(layout.hub.x + HUB);
      expect(layout.hub.marginAnchor.x + MARGIN_R, `badge overlaps the right column at ${width}`).toBeLessThanOrEqual(rightX);
    }
  });

  it('draws the trunk from the hub to the junction, half a channel out', () => {
    const layout = layoutAt(356);
    const trunk = layout.wires.find((wire) => wire.kind === 'trunk');
    expect(layout.hub.junction.x).toBe(layout.hub.x + HUB + GAP / 2);
    expect(trunk?.path).toBe(`M ${layout.hub.outputAnchor.x} ${layout.hub.outputAnchor.y} L ${layout.hub.junction.x} ${layout.hub.junction.y}`);
    expect(trunk?.dashed).toBe(false);
    expect(trunk?.tone).toBe('own');
    // Nothing on the right means nothing to trunk to.
    expect(layoutAt(356, LEFT, []).wires.some((wire) => wire.kind === 'trunk')).toBe(false);
  });

  it('dashes exactly the possible and empty wires, and tones a blocked one for loss', () => {
    const layout = layoutAt(356);
    const byKey = new Map(layout.pills.map((pill) => [pill.key, pill]));
    for (const wire of layout.wires) {
      if (wire.kind === 'trunk') continue;
      const state = byKey.get(wire.key.slice(2))?.state;
      expect(wire.dashed, `${wire.key} (${state ?? '?'}) is dashed wrongly`).toBe(state === 'possible' || state === 'empty');
      expect(wire.tone).toBe(state === 'blocked' ? 'blocked' : state === 'live' ? 'live' : 'possible');
    }
    expect(layout.wires.some((wire) => wire.tone === 'blocked' && !wire.dashed)).toBe(true);
  });
});

describe('determinism', () => {
  it('returns the same integers for the same input, twice', () => {
    for (const width of WIDTHS) {
      const once = layoutAt(width);
      const twice = layoutAt(width);
      expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
      for (const pill of once.pills) {
        for (const value of [pill.x, pill.y, pill.width, pill.height]) expect(Number.isInteger(value)).toBe(true);
      }
      for (const value of [once.hub.x, once.hub.y, once.hub.junction.x, once.hub.junction.y, once.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

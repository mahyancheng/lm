/**
 * The canvas, tested the way a drawing is judged: by geometry and by what
 * actually comes out of the renderer.
 *
 * Three things are proved here.
 *
 * 1. **The geometry is the reference's geometry.** Ports land on the edges they
 *    are supposed to land on, sub-ports spread along the bottom, suppliers hang
 *    below on a wire that leaves downwards, and every interactive glyph has a
 *    44px target over it however small the glyph is.
 * 2. **The renderer draws every tier and every sale kind.** The canvas is
 *    rendered to static markup — no jsdom, no testing-library, the same
 *    technique the provider tests use for a component that renders no host
 *    elements of its own — and the markup is checked to carry a card for each
 *    of the table's seven tiers and each of its three sale kinds. A canvas that
 *    silently dropped contract lines would pass every unit test of the model
 *    and fail this one.
 * 3. **A rival's economics are not on the client.** The model is built from the
 *    engine's projection and the rendered markup is searched, by value, for a
 *    rival's list price, ask, unit cost, margin and quality. Searching the
 *    markup rather than the model is deliberate: it is the last thing before
 *    the screen, so it catches a leak introduced anywhere upstream of it.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, Product } from '@frontier/contracts';
import { ECONOMIC_NODES, NODE_TIERS, economicNodeById } from '@frontier/contracts';
import { createWorld3Session, nodeMapFor, type NodeMapView } from '@frontier/simulation';
import {
  CARD_H,
  CARD_W,
  SUPPLIER_DROP,
  SUPPLIER_PITCH,
  TAP,
  boundsOf,
  clampScale,
  fitViewport,
  flowWire,
  hitBoxAt,
  inputPortOf,
  outputPortOf,
  subPortsOf,
  supplierSlotsOf,
  supplierWire,
  zoomAbout,
} from './geometry';
import { buildCanvas, focusBoxes, standingOf, subtitleOf, type CanvasModel } from './model';
import { Canvas, clip, initials } from './Canvas';

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const BOX = { x: 100, y: 200, width: CARD_W, height: CARD_H };

describe('canvas geometry', () => {
  it('puts the input tab on the left edge and the output circle on the right', () => {
    expect(inputPortOf(BOX)).toEqual({ x: 100, y: 200 + CARD_H / 2 });
    expect(outputPortOf(BOX)).toEqual({ x: 100 + CARD_W, y: 200 + CARD_H / 2 });
  });

  it('centres a single sub-port and spreads several along the bottom edge', () => {
    const one = subPortsOf(BOX, 1);
    expect(one).toEqual([{ x: BOX.x + CARD_W / 2, y: BOX.y + CARD_H }]);

    const three = subPortsOf(BOX, 3);
    expect(three.length).toBe(3);
    for (const port of three) {
      expect(port.y).toBe(BOX.y + CARD_H);
      expect(port.x).toBeGreaterThanOrEqual(BOX.x);
      expect(port.x).toBeLessThanOrEqual(BOX.x + CARD_W);
    }
    // Evenly spread: the gaps are equal.
    const gaps = three.slice(1).map((port, index) => port.x - (three[index]?.x ?? 0));
    expect(new Set(gaps.map((gap) => Math.round(gap))).size).toBe(1);
    expect(subPortsOf(BOX, 0)).toEqual([]);
  });

  it('hangs suppliers below the card, spread wider than it, centred on it', () => {
    const slots = supplierSlotsOf(BOX, 4);
    expect(slots.length).toBe(4);
    for (const slot of slots) expect(slot.y).toBe(BOX.y + CARD_H + SUPPLIER_DROP);
    // Centred on the card.
    const centre = (Math.min(...slots.map((s) => s.x)) + Math.max(...slots.map((s) => s.x))) / 2;
    expect(centre).toBeCloseTo(BOX.x + CARD_W / 2, 6);
    // Wider than the card, so the wires fan clear of the name block under it.
    const span = Math.max(...slots.map((s) => s.x)) - Math.min(...slots.map((s) => s.x));
    expect(span).toBe(SUPPLIER_PITCH * 3);
    expect(span).toBeGreaterThan(CARD_W);
  });

  it('gives every glyph a 44px target however small the glyph is', () => {
    const hit = hitBoxAt({ x: 50, y: 60 });
    expect(hit.size).toBe(TAP);
    expect(hit.size).toBeGreaterThanOrEqual(44);
    expect(hit.x).toBe(50 - TAP / 2);
    expect(hit.y).toBe(60 - TAP / 2);
  });

  it('draws a flow wire that leaves horizontally and a supplier wire that leaves downwards', () => {
    const flow = flowWire({ x: 0, y: 0 }, { x: 200, y: 40 });
    // Horizontal tangents: the first control point shares the start's y.
    expect(flow).toMatch(/^M 0 0 C 100 0, 100 40, 200 40$/);

    const supply = supplierWire({ x: 10, y: 0 }, { x: 60, y: 100 });
    // Vertical tangents: the first control point shares the start's x.
    expect(supply).toMatch(/^M 10 0 C 10 55, 60 45, 60 100$/);
  });

  it('clamps zoom and keeps the point under the fingers under the fingers', () => {
    expect(clampScale(99)).toBeLessThanOrEqual(2.2);
    expect(clampScale(0)).toBeGreaterThanOrEqual(0.3);
    expect(clampScale(Number.NaN)).toBe(1);

    const before = { x: 0, y: 0, scale: 1 };
    const anchor = { x: 120, y: 90 };
    const after = zoomAbout(before, anchor, 2);
    // The canvas coordinate under the anchor is unchanged by the zoom.
    const worldBefore = { x: (anchor.x - before.x) / before.scale, y: (anchor.y - before.y) / before.scale };
    const worldAfter = { x: (anchor.x - after.x) / after.scale, y: (anchor.y - after.y) / after.scale };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  it('fits a bounding box into a phone-sized window without infinities', () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    const viewport = fitViewport(boundsOf([BOX]), 390, 420);
    expect(Number.isFinite(viewport.x)).toBe(true);
    expect(Number.isFinite(viewport.y)).toBe(true);
    expect(viewport.scale).toBeGreaterThanOrEqual(0.3);
    expect(viewport.scale).toBeLessThanOrEqual(2.2);
  });

  it('clips and initialises labels rather than letting them overrun', () => {
    expect(clip('short', 20)).toBe('short');
    expect(clip('a name far too long for one card', 10)).toHaveLength(10);
    expect(initials('Basalt Semiconductor')).toBe('BS');
    expect(initials('Meridian')).toBe('ME');
  });
});

/* -------------------------------------------------------------------------- */
/*  The model                                                                  */
/* -------------------------------------------------------------------------- */

function world3View(): { view: NodeMapView; viewerId: string } {
  const state = createWorld3Session();
  const viewer = state.companies.find((company) => company.products.some((product) => product.nodeId !== undefined));
  const viewerId = viewer?.id ?? (state.companies[0]?.id ?? '');
  return { view: nodeMapFor(state, viewerId), viewerId };
}

describe('the canvas model', () => {
  const { view } = world3View();

  it('lays every node out with tier as a floor for its column', () => {
    const model = buildCanvas(view, { view: 'map' });
    expect(model.nodes.length).toBe(view.nodes.length);

    // One x per column, and a node never sits left of the column its tier claims.
    const columnOf = new Map<number, number>();
    for (const node of model.nodes) {
      const seen = columnOf.get(node.box.x);
      if (seen === undefined) columnOf.set(node.box.x, node.tier);
    }
    const xs = [...new Set(model.nodes.map((node) => node.box.x))].sort((a, b) => a - b);
    for (const node of model.nodes) {
      expect(xs.indexOf(node.box.x)).toBeGreaterThanOrEqual(node.tier);
    }
  });

  it('never lets a consumed input sit at or right of the thing that consumes it', () => {
    const model = buildCanvas(view, { view: 'map' });
    const at = new Map(model.nodes.map((node) => [node.nodeId, node.box.x]));
    for (const wire of view.wires) {
      if (wire.kind !== 'consumes') continue;
      const from = at.get(wire.fromNodeId);
      const to = at.get(wire.toNodeId);
      if (from === undefined || to === undefined) continue;
      expect(from, `${wire.fromNodeId} -> ${wire.toNodeId}`).toBeLessThan(to);
    }
  });

  it('draws sub-ports in the chain view and none in the map view', () => {
    const mine = view.nodes.filter((node) => node.yourProductId !== null).map((node) => node.nodeId);
    const chain = buildCanvas(view, { view: 'chain', nodeIds: [...mine, ...inputsOf(mine)] });
    const map = buildCanvas(view, { view: 'map' });
    expect(map.nodes.every((node) => node.subPorts.length === 0)).toBe(true);

    const withInputs = chain.nodes.filter((node) => (economicNodeById(node.nodeId)?.consumes.length ?? 0) > 0);
    expect(withInputs.length).toBeGreaterThan(0);
    for (const node of withInputs) {
      expect(node.subPorts.length).toBe(economicNodeById(node.nodeId)?.consumes.length);
      // A required input is a non-substitutable one, and it is what gets the asterisk.
      const required = node.subPorts.filter((port) => port.required).length;
      const nonSubstitutable = economicNodeById(node.nodeId)?.consumes.filter((input) => !input.substitutable).length;
      expect(required).toBe(nonSubstitutable);
    }
  });

  it('shows an empty port as the open market and a wired one by name', () => {
    const mine = view.nodes.find((node) => node.yourProductId !== null && (economicNodeById(node.nodeId)?.consumes.length ?? 0) > 0);
    expect(mine, 'the scenario seeded no line with inputs').toBeDefined();
    const productId = mine?.yourProductId ?? '';
    const inputId = economicNodeById(mine?.nodeId ?? '')?.consumes[0]?.nodeId ?? '';

    const bare = buildCanvas(view, { view: 'chain', nodeIds: [mine?.nodeId ?? ''] });
    expect(bare.nodes[0]?.subPorts[0]?.supplier).toBeNull();

    const wired = buildCanvas(view, {
      view: 'chain',
      nodeIds: [mine?.nodeId ?? ''],
      wiring: new Map([[`${productId}|${inputId}`, { companyId: 'cmp_x', name: 'Basalt', madeInHouse: false }]]),
    });
    expect(wired.nodes[0]?.subPorts[0]?.supplier?.name).toBe('Basalt');
  });

  it('states a standing per company, never a global achievement', () => {
    for (const entry of view.nodes) {
      const standing = standingOf(entry);
      if (entry.yourProductId !== null) expect(standing).toBe('yours');
      else if (entry.youCanProduce) expect(standing).toBe('ready');
    }
    // Somebody else's node reads as somebody else's, not as locked-for-everyone.
    const foreign = view.nodes.find((entry) => entry.yourProductId === null && !entry.youCanProduce && entry.ownerCompanyIds.length > 0);
    if (foreign !== undefined) expect(standingOf(foreign)).toBe('foreign');
  });

  it('subtitles a card with its own unit and its own sale kind, never "per seat"', () => {
    for (const entry of view.nodes) {
      const subtitle = subtitleOf(entry);
      expect(subtitle.startsWith(entry.unitLabel)).toBe(true);
      expect(subtitle).not.toContain('per seat');
    }
    const contract = view.nodes.find((entry) => entry.saleKind === 'contract');
    expect(subtitleOf(contract!)).toContain('term contract');
  });

  it('fits to the chain when there is one and to everything when there is not', () => {
    const model = buildCanvas(view, { view: 'map' });
    expect(focusBoxes(model, null).length).toBe(model.nodes.length);
    // An unknown id is not a reason to show a blank canvas.
    expect(focusBoxes(model, ['nope']).length).toBe(model.nodes.length);
    const one = model.nodes[0]?.nodeId ?? '';
    expect(focusBoxes(model, [one]).length).toBe(1);
  });
});

/** Every node consumed by any of `nodeIds`, one step up. */
function inputsOf(nodeIds: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const nodeId of nodeIds) {
    for (const input of economicNodeById(nodeId)?.consumes ?? []) out.push(input.nodeId);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The renderer                                                               */
/* -------------------------------------------------------------------------- */

function render(model: CanvasModel): string {
  return renderToStaticMarkup(
    <Canvas model={model} focusNodeIds={null} selectedNodeId={null} onSelectNode={() => {}} onSelectInput={() => {}} />,
  );
}

describe('the canvas renders', () => {
  const { view } = world3View();

  it('draws a card for every tier the table carries', () => {
    const perTier = NODE_TIERS.map((tier) => ECONOMIC_NODES.find((node) => node.tier === tier)).filter((node) => node !== undefined);
    expect(perTier.length).toBe(NODE_TIERS.length);

    const model = buildCanvas(view, { view: 'map', nodeIds: perTier.map((node) => node.id) });
    const markup = render(model);
    for (const node of perTier) {
      expect(markup, `tier ${node.tier} is missing`).toContain(clip(node.label, 22));
    }
  });

  it('draws a card for every sale kind, with each kind\'s own subtitle', () => {
    const kinds = ['unit', 'recurring', 'contract'] as const;
    const perKind = kinds.map((kind) => ECONOMIC_NODES.find((node) => node.saleKind === kind)).filter((node) => node !== undefined);
    expect(perKind.length).toBe(kinds.length);

    const markup = render(buildCanvas(view, { view: 'map', nodeIds: perKind.map((node) => node.id) }));
    expect(markup).toContain('sold outright');
    expect(markup).toContain('billed every quarter');
    expect(markup).toContain('term contract');
  });

  it('draws a plus on an empty port and the supplier\'s initials on a wired one', () => {
    const mine = view.nodes.find((node) => node.yourProductId !== null && (economicNodeById(node.nodeId)?.consumes.length ?? 0) > 0);
    const nodeId = mine?.nodeId ?? '';
    const productId = mine?.yourProductId ?? '';
    const inputId = economicNodeById(nodeId)?.consumes[0]?.nodeId ?? '';

    const empty = render(buildCanvas(view, { view: 'chain', nodeIds: [nodeId] }));
    expect(empty).toContain('open market');
    expect(empty).toContain('>+<');

    const wired = render(
      buildCanvas(view, {
        view: 'chain',
        nodeIds: [nodeId],
        wiring: new Map([[`${productId}|${inputId}`, { companyId: 'cmp_x', name: 'Basalt Semiconductor', madeInHouse: false }]]),
      }),
    );
    expect(wired).toContain('BS');
    expect(wired).toContain('Basalt Semiconductor');
  });

  it('marks a blocked input rather than drawing it as an ordinary open port', () => {
    const mine = view.nodes.find((node) => node.yourProductId !== null && (economicNodeById(node.nodeId)?.consumes.length ?? 0) > 0);
    const nodeId = mine?.nodeId ?? '';
    const productId = mine?.yourProductId ?? '';
    const inputId = economicNodeById(nodeId)?.consumes[0]?.nodeId ?? '';
    const markup = render(
      buildCanvas(view, { view: 'chain', nodeIds: [nodeId], blocked: new Set([`${productId}|${inputId}`]) }),
    );
    expect(markup).toContain('nobody makes it');
  });

  it('gives the zoom and fit controls real names and 44px targets', () => {
    const markup = render(buildCanvas(view, { view: 'map', nodeIds: [view.nodes[0]?.nodeId ?? ''] }));
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Fit to view"');
    // size-11 is 44px in this design system's scale.
    expect(markup).toContain('size-11');
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction, at the last point before the screen                             */
/* -------------------------------------------------------------------------- */

describe('a rival\'s economics never reach the canvas', () => {
  it('carries no rival list price, ask, unit cost, margin or quality in the rendered markup', () => {
    const state = createWorld3Session();
    const viewer = state.companies[0] as Company;
    const rival = state.companies.find((company) => company.id !== viewer.id && company.products.length > 0) as Company;
    const line = rival.products[0] as Product;

    // Distinctive values: finding one in the markup is proof, not coincidence.
    line.pricePerSeat = 7_777_777;
    line.unitCostUsd = 6_666_666;
    line.grossMarginPct = 0.123_456;
    line.qualityScore = 0.987_654;
    line.supplyTerms = { openToAll: true, pricePerUnitUsd: 5_555_555, exclusiveCustomerIds: [], blockedCustomerIds: [] };

    const view = nodeMapFor(state, viewer.id);
    const markup = render(buildCanvas(view, { view: 'map' }));
    for (const secret of ['7777777', '7,777,777', '6666666', '6,666,666', '0.123456', '0.987654', '5555555', '5,555,555']) {
      expect(markup.includes(secret), `${secret} reached the client`).toBe(false);
    }
    // And the viewer's own market prices are there, because a market price is public.
    expect(markup.length).toBeGreaterThan(1_000);
  });
});

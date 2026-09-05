/**
 * The canvas, tested the way a drawing is judged: by geometry and by what
 * actually comes out of the renderer.
 *
 * Four things are proved here.
 *
 * 1. **The geometry is the reference's geometry.** Ports land on the edges they
 *    are supposed to land on, slot ports spread along the bottom, hanging nodes
 *    sit below on a wire that leaves downwards, a card with more than three
 *    slots wraps them into rows of three, and every interactive glyph has a
 *    44px target that overlaps no other however small the glyph is.
 * 2. **The chain reads left to right as the owner sketched it.** A delivery
 *    slot's device sits one column right of the terminal that ships on it, on
 *    a wire out of the output port; every other input sits left of what it
 *    feeds; the card says who the line is aimed at.
 * 3. **The renderer draws every tier and every sale kind.** The canvas is
 *    rendered to static markup — no jsdom, no testing-library, the same
 *    technique the provider tests use for a component that renders no host
 *    elements of its own — and the markup is checked to carry a card for each
 *    of the table's eight tiers and each of its three sale kinds.
 * 4. **A rival's economics are not on the client.** The model is built from the
 *    engine's projection and the rendered markup is searched, by value, for a
 *    rival's list price, ask, unit cost, margin and quality. Searching the
 *    markup rather than the model is deliberate: it is the last thing before
 *    the screen, so it catches a leak introduced anywhere upstream of it.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, Product } from '@frontier/contracts';
import { ECONOMIC_NODES, NODE_TIERS, defaultInputsOf, economicNodeById, type EconomicNode } from '@frontier/contracts';
import { createWorld3Session, describeLine, nodeMapFor, slotOptions, type NodeMapView, type ResolvedFill } from '@frontier/simulation';
import {
  CARD_H,
  CARD_W,
  HEAD_H,
  SUPPLIER_DROP,
  SUPPLIER_PITCH,
  SUPPLIER_ROW_GAP,
  TAP,
  boundsOf,
  clampScale,
  fitViewport,
  flowWire,
  hitBoxAt,
  inputPortOf,
  nodeBlockHeight,
  outputPortOf,
  shiftPathY,
  subPortsOf,
  supplierRowsOf,
  supplierSlotsOf,
  supplierWire,
  zoomAbout,
} from './geometry';
import { buildCanvas, focusBoxes, standingOf, subtitleOf, targetLineOf, type CanvasLine, type CanvasModel } from './model';
import { Canvas, clip, fillCaption, initials } from './Canvas';

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const BOX = { x: 100, y: 200, width: CARD_W, height: CARD_H };

/** Two 44px squares centred on `a` and `b` share no area. */
function targetsClear(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) >= TAP || Math.abs(a.y - b.y) >= TAP;
}

describe('canvas geometry', () => {
  it('puts the input tab on the left edge and the output circle on the right', () => {
    expect(inputPortOf(BOX)).toEqual({ x: 100, y: 200 + CARD_H / 2 });
    expect(outputPortOf(BOX)).toEqual({ x: 100 + CARD_W, y: 200 + CARD_H / 2 });
  });

  it('centres a single slot port and spreads several along the bottom edge', () => {
    const one = subPortsOf(BOX, 1);
    expect(one).toEqual([{ x: BOX.x + CARD_W / 2, y: BOX.y + CARD_H }]);

    const three = subPortsOf(BOX, 3);
    expect(three.length).toBe(3);
    for (const port of three) {
      expect(port.y).toBe(BOX.y + CARD_H);
      expect(port.x).toBeGreaterThanOrEqual(BOX.x);
      expect(port.x).toBeLessThanOrEqual(BOX.x + CARD_W);
    }
    const gaps = three.slice(1).map((port, index) => port.x - (three[index]?.x ?? 0));
    expect(new Set(gaps.map((gap) => Math.round(gap))).size).toBe(1);
    expect(subPortsOf(BOX, 0)).toEqual([]);
  });

  it('hangs up to three nodes below the card in one row, spread wider than it, centred on it', () => {
    const slots = supplierSlotsOf(BOX, 3);
    expect(slots.length).toBe(3);
    for (const slot of slots) expect(slot.y).toBe(BOX.y + CARD_H + SUPPLIER_DROP);
    const centre = (Math.min(...slots.map((s) => s.x)) + Math.max(...slots.map((s) => s.x))) / 2;
    expect(centre).toBeCloseTo(BOX.x + CARD_W / 2, 6);
    const span = Math.max(...slots.map((s) => s.x)) - Math.min(...slots.map((s) => s.x));
    expect(span).toBe(SUPPLIER_PITCH * 2);
    expect(span).toBeGreaterThan(CARD_W);
  });

  it('wraps a six-slot card into two rows of three, every target clear of every other', () => {
    expect(supplierRowsOf(0)).toBe(0);
    expect(supplierRowsOf(3)).toBe(1);
    expect(supplierRowsOf(4)).toBe(2);
    expect(supplierRowsOf(6)).toBe(2);

    const six = supplierSlotsOf(BOX, 6);
    expect(six.length).toBe(6);
    const rows = [...new Set(six.map((slot) => slot.y))].sort((a, b) => a - b);
    expect(rows).toEqual([BOX.y + CARD_H + SUPPLIER_DROP, BOX.y + CARD_H + SUPPLIER_DROP + SUPPLIER_ROW_GAP]);
    expect(six.filter((slot) => slot.y === rows[0]).length).toBe(3);
    expect(six.filter((slot) => slot.y === rows[1]).length).toBe(3);
    // Each row is centred on the card in its own right.
    for (const y of rows) {
      const xs = six.filter((slot) => slot.y === y).map((slot) => slot.x);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(BOX.x + CARD_W / 2, 6);
    }
    // No two thumb targets share any area: the pitch and the row gap both clear TAP.
    expect(SUPPLIER_PITCH).toBeGreaterThan(TAP);
    expect(SUPPLIER_ROW_GAP).toBeGreaterThan(TAP);
    for (let i = 0; i < six.length; i += 1) {
      for (let j = i + 1; j < six.length; j += 1) expect(targetsClear(six[i]!, six[j]!)).toBe(true);
    }
    // A short last row is still centred.
    const four = supplierSlotsOf(BOX, 4);
    expect(four[3]?.x).toBeCloseTo(BOX.x + CARD_W / 2, 6);
  });

  it('gives a block the height of its rows, and a target line room under the subtitle', () => {
    expect(nodeBlockHeight(0)).toBe(HEAD_H);
    expect(nodeBlockHeight(0, true)).toBeGreaterThan(HEAD_H);
    expect(nodeBlockHeight(3)).toBeGreaterThan(HEAD_H);
    expect(nodeBlockHeight(6) - nodeBlockHeight(3)).toBe(SUPPLIER_ROW_GAP);
  });

  it('gives every glyph a 44px target however small the glyph is', () => {
    const hit = hitBoxAt({ x: 50, y: 60 });
    expect(hit.size).toBe(TAP);
    expect(hit.size).toBeGreaterThanOrEqual(44);
    expect(hit.x).toBe(50 - TAP / 2);
    expect(hit.y).toBe(60 - TAP / 2);
  });

  it('draws a flow wire that leaves horizontally and a slot wire that leaves downwards', () => {
    const flow = flowWire({ x: 0, y: 0 }, { x: 200, y: 40 });
    expect(flow).toMatch(/^M 0 0 C 100 0, 100 40, 200 40$/);

    const supply = supplierWire({ x: 10, y: 0 }, { x: 60, y: 100 });
    expect(supply).toMatch(/^M 10 0 C 10 55, 60 45, 60 100$/);
  });

  it('shifts every y of a path and no x', () => {
    expect(shiftPathY('M 0 0 C 100 0, 100 40, 200 40', -10)).toBe('M 0 -10 C 100 -10, 100 30, 200 30');
    expect(shiftPathY('M 1.5 2.25 L 3 4', 0.5)).toBe('M 1.5 2.75 L 3 4.5');
    expect(shiftPathY('M 1 2', 0)).toBe('M 1 2');
  });

  it('clamps zoom and keeps the point under the fingers under the fingers', () => {
    expect(clampScale(99)).toBeLessThanOrEqual(2.2);
    expect(clampScale(0)).toBeGreaterThanOrEqual(0.3);
    expect(clampScale(Number.NaN)).toBe(1);

    const before = { x: 0, y: 0, scale: 1 };
    const anchor = { x: 120, y: 90 };
    const after = zoomAbout(before, anchor, 2);
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
    expect(initials('Inference API')).toBe('IA');
  });
});

/* -------------------------------------------------------------------------- */
/*  The world, seen from the player's seat                                     */
/* -------------------------------------------------------------------------- */

/** The player's company: the seat with a line and slots to compose. */
function viewerOf(state: ReturnType<typeof createWorld3Session>): Company {
  return state.companies.find((company) => company.id === 'cmp_player_ventures') ?? (state.companies[0] as Company);
}

function world3View(): { view: NodeMapView; viewerId: string } {
  const state = createWorld3Session();
  const viewer = viewerOf(state);
  return { view: nodeMapFor(state, viewer.id), viewerId: viewer.id };
}

/** The viewer's own lines as the chain screen hands them to the canvas: resolved fills and a target. */
function linesOf(state: ReturnType<typeof createWorld3Session>, viewer: Company, override?: (product: Product, fills: ResolvedFill[]) => ResolvedFill[]): Map<string, CanvasLine> {
  const out = new Map<string, CanvasLine>();
  for (const product of viewer.products) {
    if (!product.isActive || product.nodeId === undefined || product.nodeId === null) continue;
    const fills = slotOptions(state, viewer, product.nodeId, product.id).flatMap((slot) => (slot.fill === null ? [] : [slot.fill]));
    out.set(product.id, {
      target: { customer: product.segment, industry: product.targetIndustry ?? 'logistics' },
      fills: override === undefined ? fills : override(product, fills),
      description: describeLine(state, viewer, product, viewer.id),
    });
  }
  return out;
}

/** Give the viewer a live line on `nodeId`, cloned from its first, and return it. */
function runLineOn(viewer: Company, nodeId: string): Product {
  const template = viewer.products[0] as Product;
  const line: Product = { ...template, id: `prd_test_${nodeId}`, name: `${nodeId} line`, nodeId, slots: [], supplyTerms: null, targetIndustry: 'manufacturing' };
  viewer.products.push(line);
  return line;
}

/* -------------------------------------------------------------------------- */
/*  The model                                                                  */
/* -------------------------------------------------------------------------- */

describe('the canvas model', () => {
  const { view } = world3View();

  it('lays every node out with tier as a floor for its column', () => {
    const model = buildCanvas(view, { view: 'map' });
    expect(model.nodes.length).toBe(view.nodes.length);
    const xs = [...new Set(model.nodes.map((node) => node.box.x))].sort((a, b) => a - b);
    for (const node of model.nodes) {
      expect(xs.indexOf(node.box.x)).toBeGreaterThanOrEqual(node.tier);
    }
  });

  it('never lets an input sit at or right of the card whose slot it fills', () => {
    const model = buildCanvas(view, { view: 'map' });
    const at = new Map(model.nodes.map((node) => [node.nodeId, node.box.x]));
    for (const wire of view.wires) {
      if (wire.kind !== 'slot' || !wire.isDefault) continue;
      const from = at.get(wire.fromNodeId);
      const to = at.get(wire.toNodeId);
      if (from === undefined || to === undefined) continue;
      expect(from, `${wire.fromNodeId} -> ${wire.toNodeId}`).toBeLessThan(to);
    }
  });

  it('draws slot ports on the viewer\'s own cards in the chain view and none in the map view', () => {
    const mine = view.nodes.filter((node) => node.yourProductId !== null).map((node) => node.nodeId);
    const chain = buildCanvas(view, { view: 'chain', nodeIds: [...mine, ...inputsOf(mine)] });
    const map = buildCanvas(view, { view: 'map' });
    expect(map.nodes.every((node) => node.slots.length === 0)).toBe(true);

    const own = chain.nodes.filter((node) => node.standing === 'yours');
    expect(own.length).toBeGreaterThan(0);
    for (const node of own) {
      const slots = economicNodeById(node.nodeId)?.slots ?? [];
      // Every slot the table declares, empty ones included: an empty slot is a `+`.
      expect(node.slots.map((port) => port.slotId)).toEqual(slots.map((slot) => slot.id));
      expect(node.slots.filter((port) => port.required).length).toBe(slots.filter((slot) => slot.required).length);
    }
    // A rival's card makes no claim about who it buys from.
    for (const node of chain.nodes.filter((entry) => entry.standing === 'foreign' || entry.standing === 'locked')) expect(node.slots.length).toBe(0);
  });

  it('shows an unresolved slot as the table default from the open market, a resolved one by node and supplier', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const line = viewer.products.find((product) => product.nodeId !== undefined) as Product;
    const node = economicNodeById(line.nodeId ?? '') as EconomicNode;
    const modelSlot = node.slots.find((slot) => slot.id === 'model') as NonNullable<EconomicNode['slots'][number]>;
    const fresh = nodeMapFor(state, viewer.id);

    const bare = buildCanvas(fresh, { view: 'chain', nodeIds: [node.id] });
    const barePort = bare.nodes[0]?.slots.find((port) => port.slotId === 'model');
    expect(barePort?.fill?.nodeId).toBe(modelSlot.defaultNodeId);
    expect(barePort?.fill?.supplier).toBeNull();
    expect(bare.nodes[0]?.target).toBeNull();

    const seller = state.companies.find((company) => company.id === 'cmp_basalt') as Company;
    const sellerLine = seller.products.find((product) => product.nodeId === 'svc_inference_api') as Product;
    const composed = buildCanvas(fresh, {
      view: 'chain',
      nodeIds: [node.id],
      lines: linesOf(state, viewer, (_product, fills) =>
        fills.map((fill) =>
          fill.slotId === 'model'
            ? { ...fill, route: 'buy', supplierCompanyId: seller.id, supplierProductId: sellerLine.id, askUsd: 7 }
            : fill,
        ),
      ),
    });
    const port = composed.nodes[0]?.slots.find((entry) => entry.slotId === 'model');
    expect(port?.fill?.nodeLabel).toBe('Inference API');
    expect(port?.fill?.supplier?.name).toBe(seller.name);
    expect(port?.fill?.route).toBe('buy');
    expect(composed.nodes[0]?.target).toEqual({ customer: line.segment, industry: line.targetIndustry ?? 'logistics' });
  });

  it('draws the delivery device one column right of the terminal, on a wire out of its output port', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const line = viewer.products.find((product) => product.nodeId !== undefined) as Product;
    const terminal = line.nodeId ?? '';
    const device = 'sys_consumer_device';
    const fresh = nodeMapFor(state, viewer.id);
    const lines = linesOf(state, viewer, (_product, fills) =>
      fills.map((fill) => (fill.slotId === 'delivery' ? { ...fill, nodeId: device, route: 'market' as const } : fill)),
    );
    const model = buildCanvas(fresh, { view: 'chain', nodeIds: [terminal, device, 'svc_inference_api', 'svc_copilot_framework'], lines });

    const app = model.nodes.find((node) => node.nodeId === terminal);
    const card = model.nodes.find((node) => node.nodeId === device);
    expect(app).toBeDefined();
    expect(card).toBeDefined();
    // Right of the terminal, although the device is the lower tier.
    expect(card!.box.x).toBeGreaterThan(app!.box.x);
    expect(card!.tier).toBeLessThan(app!.tier);
    // The inputs still sit left.
    for (const id of ['svc_inference_api', 'svc_copilot_framework']) {
      expect(model.nodes.find((node) => node.nodeId === id)!.box.x).toBeLessThan(app!.box.x);
    }
    // One delivery wire, out of the terminal's output port into the device's input tab.
    const wire = model.wires.find((entry) => entry.kind === 'delivery');
    expect(wire).toBeDefined();
    expect(wire!.fromNodeId).toBe(terminal);
    expect(wire!.toNodeId).toBe(device);
    expect(wire!.path.startsWith(`M ${outputPortOf(app!.box).x} `)).toBe(true);
    // The delivery slot is drawn as that wire, not as a node hanging under the card.
    const port = app!.slots.find((entry) => entry.slotId === 'delivery');
    expect(port?.viaWire).toBe(true);
    expect(app!.slots.filter((entry) => !entry.viaWire).length).toBe(2);
  });

  it('keeps every other admissible node as a faint wire and the default recipe solid', () => {
    const model = buildCanvas(view, { view: 'map' });
    const faint = model.wires.filter((wire) => wire.emphasis === 'faint');
    const solid = model.wires.filter((wire) => wire.emphasis === 'solid' && wire.kind === 'slot');
    expect(faint.length).toBeGreaterThan(0);
    expect(solid.every((wire) => wire.isDefault)).toBe(true);
    // The three models the inference API admits: one solid default, two faint alternatives.
    const intoApi = model.wires.filter((wire) => wire.toNodeId === 'svc_inference_api' && wire.kind === 'slot');
    expect(intoApi.filter((wire) => wire.emphasis === 'solid').length).toBe(1);
    expect(intoApi.filter((wire) => wire.emphasis === 'faint').length).toBe(2);
  });

  it('spaces rows by the tallest block, so a card\'s hanging nodes never run into the card below', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    runLineOn(viewer, 'sys_humanoid_robot');
    const fresh = nodeMapFor(state, viewer.id);
    const lines = linesOf(state, viewer);
    const humanoid = economicNodeById('sys_humanoid_robot') as EconomicNode;
    expect(humanoid.slots.length).toBe(6);
    const ids = ['sys_humanoid_robot', ...defaultInputsOf(humanoid).map((input) => input.nodeId)];
    const model = buildCanvas(fresh, { view: 'chain', nodeIds: ids, lines });
    const robot = model.nodes.find((node) => node.nodeId === 'sys_humanoid_robot')!;
    expect(robot.slots.length).toBe(6);
    // Two rows of hanging nodes under it.
    const hung = supplierSlotsOf(robot.box, robot.slots.filter((port) => !port.viaWire).length);
    expect(new Set(hung.map((point) => point.y)).size).toBe(2);
    // Nothing else in the robot's column starts inside its block.
    const blockBottom = robot.box.y + nodeBlockHeight(6, true);
    for (const other of model.nodes) {
      if (other.nodeId === robot.nodeId || other.box.x !== robot.box.x) continue;
      expect(other.box.y >= blockBottom || other.box.y + nodeBlockHeight(other.slots.length, other.target !== null) <= robot.box.y).toBe(true);
    }
  });

  it('states a standing per company, never a global achievement', () => {
    for (const entry of view.nodes) {
      const standing = standingOf(entry);
      if (entry.yourProductId !== null) expect(standing).toBe('yours');
      else if (entry.youCanProduce) expect(standing).toBe('ready');
    }
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

  it('writes the target as industry then customer, and the public alone', () => {
    const label = (sector: string): string => sector.toUpperCase();
    expect(targetLineOf({ industry: 'logistics', customer: 'enterprise' }, label)).toBe('→ LOGISTICS · enterprise');
    expect(targetLineOf({ industry: 'consumer', customer: 'consumer' }, label)).toBe('→ the public');
  });

  it('titles the viewer\'s own card with the line in words, and no other card', () => {
    // The composed line as the Chief of Staff would say it — "your ... on
    // Basalt Compute's inference API ..., aimed at ..." — rides on the card
    // whose line it is; a rival's card says nothing about how its line is built.
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const lines = linesOf(state, viewer);
    const model = buildCanvas(nodeMapFor(state, viewer.id), { view: 'chain', lines });
    const own = model.nodes.filter((node) => node.yourProductId !== null);
    expect(own.length).toBeGreaterThan(0);
    for (const node of own) {
      const description = lines.get(node.yourProductId as string)?.description ?? '';
      expect(description.length).toBeGreaterThan(0);
      expect(node.description).toBe(description);
      expect(node.description?.startsWith('your ')).toBe(true);
      expect(node.description).toContain('aimed at');
    }
    for (const node of model.nodes.filter((entry) => entry.yourProductId === null)) expect(node.description).toBeNull();
  });

  it('fits to the chain when there is one and to everything when there is not', () => {
    const model = buildCanvas(view, { view: 'map' });
    expect(focusBoxes(model, null).length).toBe(model.nodes.length);
    expect(focusBoxes(model, ['nope']).length).toBe(model.nodes.length);
    const one = model.nodes[0]?.nodeId ?? '';
    expect(focusBoxes(model, [one]).length).toBe(1);
  });
});

/** The default recipe of one node, or nothing for an unknown id. */
function recipeOf(nodeId: string): ReturnType<typeof defaultInputsOf> {
  const node: EconomicNode | undefined = economicNodeById(nodeId);
  return node === undefined ? [] : defaultInputsOf(node);
}

/** Every node in the default recipe of any of `nodeIds`, one step up. */
function inputsOf(nodeIds: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const nodeId of nodeIds) {
    for (const input of recipeOf(nodeId)) out.push(input.nodeId);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The renderer                                                               */
/* -------------------------------------------------------------------------- */

function render(model: CanvasModel, selectedNodeId: string | null = null): string {
  return renderToStaticMarkup(
    <Canvas model={model} focusNodeIds={null} selectedNodeId={selectedNodeId} onSelectNode={() => {}} onSelectInput={() => {}} />,
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

  it('draws a plus on an empty slot, the node\'s initials with the supplier beneath on a filled one, and the target under the card', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const line = viewer.products.find((product) => product.nodeId !== undefined) as Product;
    const nodeId = line.nodeId ?? '';
    const fresh = nodeMapFor(state, viewer.id);

    // Without a resolved line the optional delivery slot is empty, the rest default to the market.
    const empty = render(buildCanvas(fresh, { view: 'chain', nodeIds: [nodeId] }));
    expect(empty).toContain('open market');
    expect(empty).toContain('>+<');
    expect(empty).toContain('>empty<');

    const seller = state.companies.find((company) => company.id === 'cmp_basalt') as Company;
    const sellerLine = seller.products.find((product) => product.nodeId === 'svc_inference_api') as Product;
    const composed = render(
      buildCanvas(fresh, {
        view: 'chain',
        nodeIds: [nodeId],
        lines: linesOf(state, viewer, (_product, fills) =>
          fills.map((fill) =>
            fill.slotId === 'model' ? { ...fill, route: 'buy', supplierCompanyId: seller.id, supplierProductId: sellerLine.id, askUsd: 7 } : fill,
          ),
        ),
      }),
    );
    // The node's initials in the circle, the seller's name beneath, and where the line is aimed.
    expect(composed).toContain('>IA<');
    expect(composed).toContain(seller.name);
    expect(composed).toContain('→ Logistics · enterprise');
  });

  it('marks a blocked slot rather than drawing it as an ordinary open one', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const line = viewer.products.find((product) => product.nodeId !== undefined) as Product;
    const nodeId = line.nodeId ?? '';
    const markup = render(
      buildCanvas(nodeMapFor(state, viewer.id), {
        view: 'chain',
        nodeIds: [nodeId],
        lines: linesOf(state, viewer, (_product, fills) => fills.map((fill) => (fill.slotId === 'model' ? { ...fill, route: 'blocked' as const } : fill))),
      }),
    );
    expect(markup).toContain('nobody makes it');
  });

  it('keeps every hit target on a six-slot card at 44px, in two rows, at phone width', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    runLineOn(viewer, 'sys_humanoid_robot');
    const fresh = nodeMapFor(state, viewer.id);
    const model = buildCanvas(fresh, { view: 'chain', nodeIds: ['sys_humanoid_robot'], lines: linesOf(state, viewer) });
    const robot = model.nodes[0]!;
    expect(robot.slots.length).toBe(6);
    const markup = render(model);
    // Six hanging-node targets plus the card's own: each a TAP square.
    const hits = markup.match(new RegExp(`width="${TAP}" height="${TAP}"`, 'g')) ?? [];
    expect(hits.length).toBe(6);
    // The block fits a 390px phone when fitted: two rows, not one 400px shelf.
    const points = supplierSlotsOf(robot.box, 6);
    const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)) + TAP;
    expect(width).toBeLessThan(390);
    expect(new Set(points.map((point) => point.y)).size).toBe(2);
  });

  it('shows the faint alternatives only for the selected card', () => {
    const model = buildCanvas(view, { view: 'map', nodeIds: ['svc_inference_api', 'sys_frontier_model', 'sys_efficient_small_model', 'sys_robot_policy_model'] });
    expect(model.wires.filter((wire) => wire.emphasis === 'faint').length).toBe(2);
    const unselected = render(model, null);
    const selected = render(model, 'svc_inference_api');
    expect(unselected).not.toContain('stroke-dasharray="2 5"');
    expect((selected.match(/stroke-dasharray="2 5"/g) ?? []).length).toBe(2);
  });

  it('gives the zoom and fit controls real names and 44px targets', () => {
    const markup = render(buildCanvas(view, { view: 'map', nodeIds: [view.nodes[0]?.nodeId ?? ''] }));
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Fit to view"');
    expect(markup).toContain('size-11');
  });

  it('captions a slot by what it resolves to', () => {
    const base = { slotId: 'model', role: 'model' as const, label: 'Model', required: true, kind: 'input' as const, viaWire: false };
    expect(fillCaption({ ...base, fill: null })).toBe('empty');
    expect(fillCaption({ ...base, fill: { nodeId: 'x', nodeLabel: 'X', route: 'market', supplier: null, blocked: false } })).toBe('open market');
    expect(fillCaption({ ...base, fill: { nodeId: 'x', nodeLabel: 'X', route: 'blocked', supplier: null, blocked: true } })).toBe('nobody makes it');
    expect(fillCaption({ ...base, fill: { nodeId: 'x', nodeLabel: 'X', route: 'buy', supplier: { companyId: 'c', name: 'Basalt' }, blocked: false } })).toBe('Basalt');
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction, at the last point before the screen                             */
/* -------------------------------------------------------------------------- */

describe('a rival\'s economics never reach the canvas', () => {
  it('carries no rival list price, ask, unit cost, margin or quality in the rendered markup, chain view included', () => {
    const state = createWorld3Session();
    const viewer = viewerOf(state);
    const rival = state.companies.find((company) => company.id === 'cmp_basalt') as Company;
    const line = rival.products.find((product) => product.nodeId === 'svc_inference_api') as Product;

    // Distinctive values: finding one in the markup is proof, not coincidence.
    line.pricePerSeat = 7_777_777;
    line.unitCostUsd = 6_666_666;
    line.grossMarginPct = 0.123_456;
    line.qualityScore = 0.987_654;
    line.supplyTerms = { openToAll: true, pricePerUnitUsd: 5_555_555, exclusiveCustomerIds: [], blockedCustomerIds: [] };

    const view = nodeMapFor(state, viewer.id);
    const mine = viewer.products.find((product) => product.nodeId !== undefined) as Product;
    // The viewer's line composed on that rival's API, so the rival's name is on the picture and its numbers must not be.
    const lines = linesOf(state, viewer, (_product, fills) =>
      fills.map((fill) => (fill.slotId === 'model' ? { ...fill, route: 'buy' as const, supplierCompanyId: rival.id, supplierProductId: line.id, askUsd: 5_555_555 } : fill)),
    );
    for (const markup of [render(buildCanvas(view, { view: 'map' })), render(buildCanvas(view, { view: 'chain', nodeIds: [mine.nodeId ?? '', 'svc_inference_api'], lines }))]) {
      for (const secret of ['7777777', '7,777,777', '6666666', '6,666,666', '0.123456', '0.987654', '5555555', '5,555,555']) {
        expect(markup.includes(secret), `${secret} reached the client`).toBe(false);
      }
      expect(markup.length).toBeGreaterThan(1_000);
    }
  });
});

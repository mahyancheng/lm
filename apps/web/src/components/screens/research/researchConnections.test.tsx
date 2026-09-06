/**
 * The Research picture, tested the way a drawing is judged: by geometry, by
 * what actually comes out of the renderer, and by what does not.
 *
 * Five things are proved here.
 *
 * 1. **The model is the engine's answer, arranged.** Every pill is built from
 *    `researchMapFor` on a real world-3 session: the sectors are the engine's
 *    sectors in `SECTORS` order, a node the company runs a line on leads its
 *    group and is solid, and an option quotes the table's own cost range and
 *    the standard preset's quarter count.
 * 2. **It fits a phone.** The shared `layoutConnections` places it at 356
 *    points — the body width inside the shell at 390 — and nothing, pill,
 *    header or hub, starts before 0 or ends after 356. The rendered markup is
 *    then read back and every absolutely positioned box checked again, because
 *    the layout being right and the renderer using it are two facts.
 * 3. **A running programme reads as one.** It is solid, ringed with its own
 *    progress, and says how many quarters are left and what a quarter costs.
 * 4. **An unlock hangs off its programme.** Nested pills are indented, 44
 *    points tall, and joined by a square bracket wire rather than a flow.
 * 5. **A rival's research is not on my picture.** A rival's *published*
 *    programme reaches this screen through `researchProjectsForCompany` and
 *    must still be absent: the markup is searched by value for its progress,
 *    its spend, its budget and the rival's own name.
 *
 * apps/web has no jsdom, so the hook-free `ConnectionsDiagram` — the same
 * renderer the Products picture uses — is rendered to static markup, and the
 * screen around it is checked by source text where a render is impossible.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, ResearchProject, SessionState } from '@frontier/contracts';
import { SECTORS, SECTOR_META } from '@frontier/contracts';
import { MAX_FORECAST_QUARTERS, createWorld3Session, researchMapFor, researchProjectsForCompany, type ResearchMapView } from '@frontier/simulation';
import { formatMoney } from '@frontier/shared';
import { layoutConnections, NESTED_H, NESTED_INDENT, PILL_H, type ConnectionsLayout } from '../connections/layout';
import { ConnectionsDiagram } from '../connections/ConnectionsDiagram';
import { tagMoney } from '../connections/model';
import { ariaLabelOf, connectionsModelOf, layoutGroupsOf } from './ResearchConnectionsScreen';
import {
  HELD_PER_SECTOR,
  OPTIONS_SHOWN,
  UNLOCKS_PER_OPTION,
  lockedRow,
  researchDiagram,
  type ResearchDiagramModel,
  type ResearchPill,
} from './researchModel';

/** The body width inside the phone shell at 390 points. Nothing may cross it. */
const PHONE = 356;

/* -------------------------------------------------------------------------- */
/*  The world                                                                  */
/* -------------------------------------------------------------------------- */

function playerOf(state: SessionState): Company {
  return state.companies.find((company) => company.id === 'cmp_player_ventures') ?? (state.companies[0] as Company);
}

function mapOf(state: SessionState, company: Company): ResearchMapView {
  return researchMapFor(state, company, researchProjectsForCompany(state, company.id));
}

function pictureOf(
  state: SessionState,
  company: Company,
  options: { expandedSectors?: ReadonlySet<never>; showAllOptions?: boolean } = {},
): { view: ResearchMapView; model: ResearchDiagramModel; layout: ConnectionsLayout } {
  const view = mapOf(state, company);
  const model = researchDiagram(view, {
    expandedSectors: options.expandedSectors ?? new Set(),
    showAllOptions: options.showAllOptions ?? false,
  });
  const layout = layoutConnections({
    width: PHONE,
    left: layoutGroupsOf(model.left),
    right: layoutGroupsOf(model.right),
    hub: { showOutput: model.right.length > 0 },
  });
  return { view, model, layout };
}

function render(model: ResearchDiagramModel, layout: ConnectionsLayout, company: Company): string {
  return renderToStaticMarkup(
    <ConnectionsDiagram model={connectionsModelOf(model, company.name, company.archetype)} layout={layout} onAct={() => {}} />,
  );
}

/** A live programme of this company's against `nodeId`, as the engine would carry one. */
function runProgramme(state: SessionState, company: Company, nodeId: string, overrides: Partial<ResearchProject> = {}): ResearchProject {
  const project: ResearchProject = {
    id: `proj_test_${nodeId}`,
    companyId: company.id,
    targetNodeId: nodeId,
    budgetQuarterly: 40_000_000,
    computeAllocated: 40,
    talentAllocated: 12,
    progress: 0.4,
    internalConfidence: 0.6,
    quartersElapsed: 2,
    expectedQuarters: 6,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 80_000_000,
    setbacks: 0,
    startedQuarter: state.quarter,
    ...overrides,
  };
  state.researchProjects.push(project);
  return project;
}

/* -------------------------------------------------------------------------- */
/*  The model                                                                  */
/* -------------------------------------------------------------------------- */

describe('the research picture is the engine\'s answer, arranged', () => {
  it('groups what the company holds by sector, in SECTORS order, with a count on the header', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    expect(view.held.length).toBeGreaterThan(0);
    expect(model.left.map((group) => group.key)).toEqual(view.held.map((group) => `held_${group.sector}`));

    // Presentation order, not insertion order: the engine walks SECTORS.
    const drawn = view.held.map((group) => group.sector);
    expect(drawn).toEqual(SECTORS.filter((sector) => drawn.includes(sector)));

    for (const [index, group] of model.left.entries()) {
      const held = view.held[index];
      expect(held).toBeDefined();
      expect(group.header).toBe(`${SECTOR_META[held?.sector ?? 'ai'].label} · ${held?.nodes.length ?? 0}`);
    }
  });

  it('leads a sector with the line the company actually runs, solid, and dashes what it merely owns', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    const producing = view.held.flatMap((group) => group.nodes).filter((node) => node.producing);
    expect(producing.length).toBeGreaterThan(0);

    for (const group of model.left) {
      const live = group.pills.filter((pill) => pill.state === 'live');
      // Every solid pill sits above every dashed one in its own group.
      const firstDashed = group.pills.findIndex((pill) => pill.state !== 'live');
      if (firstDashed >= 0) expect(group.pills.slice(firstDashed).every((pill) => pill.state !== 'live')).toBe(true);
      for (const pill of live) {
        // Fourteen characters, so the tier moved to the aria: four nested pills
        // all reading "Lets you se…" is what the long form looks like at 110pt.
        expect(pill.data).toBe('your line');
        expect(pill.action.kind).toBe('products');
      }
    }

    const owned = model.left.flatMap((group) => group.pills).filter((pill) => pill.action.kind === 'launch');
    expect(owned.length).toBeGreaterThan(0);
    const shortIds = new Set(view.locked.map((entry) => entry.nodeId));
    for (const pill of owned) {
      const nodeId = pill.action.kind === 'launch' ? pill.action.nodeId : '';
      if (shortIds.has(nodeId)) {
        // Owning a node it cannot yet make is not "could open a line".
        expect(pill.state).toBe('blocked');
        expect(pill.data).toBe('1 step short');
      } else {
        expect(pill.state).toBe('possible');
        expect(pill.data).toBe('could sell');
      }
    }
  });

  it('says what a node it owns but cannot yet make is waiting on', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    // The seeded player owns the Inference API node but not the model it needs.
    const short = view.locked.find((entry) => view.held.some((group) => group.nodes.some((node) => node.nodeId === entry.nodeId)));
    expect(short).toBeDefined();
    // Read the sector open: the cap is three a sector, and the blocked node is
    // not always among the three a collapsed group draws.
    const opened = researchDiagram(view, { expandedSectors: new Set(SECTORS), showAllOptions: false });
    const pill = opened.left.flatMap((group) => group.pills).find((entry) => entry.key === `held_${short?.nodeId}`);
    expect(pill?.state).toBe('blocked');
    expect(pill?.data).toBe('1 step short');
    // What it is short of is a node label of any length, so it is said in the
    // panel beneath the picture rather than on a fourteen-character row.
    expect(view.locked.some((entry) => entry.nodeId === short?.nodeId && entry.missing.label.length > 0)).toBe(true);
    // Blocked is the loss tone and a solid wire, never the dashed "not yet".
    const layout = layoutConnections({
      width: PHONE,
      left: layoutGroupsOf(opened.left),
      right: layoutGroupsOf(opened.right),
      hub: { showOutput: true },
    });
    const wire = layout.wires.find((entry) => entry.key.endsWith(`held_${short?.nodeId}`));
    expect(wire?.tone).toBe('blocked');
    expect(wire?.dashed).toBe(false);
  });

  /**
   * The column a critic pass measured at thirteen pills of resource nodes, and
   * a "+N more" that could only ever grow it. The cap is `HELD_PER_SECTOR` and
   * the same pill both opens and closes the sector, so a tap is reversible.
   */
  it('caps a sector behind a "+N more" that expands, and offers the way back once it has', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    const crowded = view.held.find((group) => group.nodes.length > HELD_PER_SECTOR);
    expect(crowded).toBeDefined();
    const sector = crowded?.sector ?? 'ai';
    const collapsed = model.left.find((group) => group.key === `held_${sector}`);
    expect(collapsed?.pills.length).toBe(HELD_PER_SECTOR + 1);
    const more = collapsed?.pills[HELD_PER_SECTOR];
    expect(more?.label).toBe(`+${(crowded?.nodes.length ?? 0) - HELD_PER_SECTOR} more`);
    expect(more?.action).toEqual({ kind: 'expand', sector });

    const opened = researchDiagram(view, { expandedSectors: new Set([sector]), showAllOptions: false });
    const openedGroup = opened.left.find((group) => group.key === `held_${sector}`);
    expect(openedGroup?.pills.length).toBe((crowded?.nodes.length ?? 0) + 1);
    const back = openedGroup?.pills[openedGroup.pills.length - 1];
    expect(back?.label).toBe('Show fewer');
    expect(back?.action).toEqual({ kind: 'expand', sector });
  });

  it('quotes the table\'s own cost range and the standard preset\'s quarters on an option, and never more than six', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    const options = model.right.flatMap((group) => group.pills).filter((pill) => pill.key.startsWith('option_'));
    expect(options.length).toBe(Math.min(view.options.length, OPTIONS_SHOWN));
    const first = view.options[0];
    expect(first).toBeDefined();
    const pill = options[0];
    expect(pill?.label).toBe(first?.label);
    expect(pill?.action).toEqual({ kind: 'node', nodeId: first?.nodeId, fallbackNodeId: first?.nodeId });
    if ((first?.expectedQuarters ?? 0) >= MAX_FORECAST_QUARTERS) {
      // `quartersAtPace` saturates at 200 and its own comment says that beyond
      // it "the honest answer is 'not on this resourcing'". Printed as "~200q"
      // it read as a fifty-year estimate on every one of the four opening
      // options; it now prints as the bound it is and names the bottleneck.
      expect(pill?.figure).toBe(`>${MAX_FORECAST_QUARTERS}q`);
      expect(pill?.data).toMatch(/^[+]/);
      expect(ariaLabelOf(pill as ResearchPill)).toContain('not on this resourcing');
    } else {
      expect(pill?.figure).toBe(`~${Math.round(first?.expectedQuarters ?? 0)}q`);
      expect(pill?.data).toBe(`${tagMoney(first?.costRangeUsd[0] ?? 0)}–${tagMoney(first?.costRangeUsd[1] ?? 0)}`);
    }
  });

  /**
   * Every option on the seeded opening saturated, so every one of them read
   * "~200q at standard" while their cost ranges differed sensibly — the leading
   * figure on the pill the owner is meant to tap was a ceiling, not a forecast.
   */
  it('never prints the forecast ceiling as though it were an estimate', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);
    const options = model.right.flatMap((group) => group.pills).filter((pill) => pill.key.startsWith('option_'));
    expect(options.length).toBeGreaterThan(0);
    for (const pill of options) {
      const option = view.options.find((entry) => `option_${entry.nodeId}` === pill.key);
      if (option === undefined || option.running !== null) continue;
      const saturated = option.expectedQuarters >= MAX_FORECAST_QUARTERS;
      expect(pill.figure.startsWith('~'), `${pill.key} printed ${pill.figure}`).toBe(!saturated);
      expect(pill.figure.startsWith('>'), `${pill.key} printed ${pill.figure}`).toBe(saturated);
    }
  });

  it('says what the programme buys, in the engine\'s order: something to sell, then something to research', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    const option = view.options.find((entry) => entry.unlocks.length >= 2);
    expect(option).toBeDefined();
    const pill = model.right.flatMap((group) => group.pills).find((entry) => entry.key === `option_${option?.nodeId}`);
    expect(pill?.children.length).toBeGreaterThan(0);

    for (const [index, child] of (pill?.children ?? []).entries()) {
      // Two unlocks are drawn; a third child is the "+N" that opens the
      // programme's own drawer, where every unlock is listed.
      const unlock = index < UNLOCKS_PER_OPTION ? option?.unlocks[index] : undefined;
      if (unlock === undefined) {
        expect(child.label.startsWith('+')).toBe(true);
        expect(child.action).toEqual({ kind: 'node', nodeId: option?.nodeId, fallbackNodeId: option?.nodeId });
        continue;
      }
      // The *thing* names the pill and what it is for is the data row: named
      // the other way round, four unlocks in a row all printed "Lets you se…".
      expect(child.label).toBe(unlock.label);
      expect(child.data).toBe(unlock.kind === 'now_producible' ? 'sell it next' : 'research it');
      // An unlock the reader's own graph may not carry falls back to the
      // programme that would reach it, so no pill is a dead tap.
      expect(child.action).toEqual({ kind: 'node', nodeId: unlock.nodeId, fallbackNodeId: option?.nodeId });
    }
  });

  it('names the hub in the company\'s own figures and is identical on a repeated call', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { view, model } = pictureOf(state, company);

    const held = view.held.reduce((total, group) => total + group.nodes.length, 0);
    const producing = view.held.reduce((total, group) => total + group.nodes.filter((node) => node.producing).length, 0);
    expect(model.hub.figures).toBe(`${held} nodes held · ${producing} line${producing === 1 ? '' : 's'}`);
    // Short enough to survive the panel subtitle it lands in, beside a tag.
    expect(model.hub.label).toBe('Held → open to you');
    expect(model.hub.label.length).toBeLessThanOrEqual(24);

    const again = researchDiagram(mapOf(createWorld3Session(), playerOf(createWorld3Session())), {
      expandedSectors: new Set(),
      showAllOptions: false,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(model));
  });
});

/* -------------------------------------------------------------------------- */
/*  Fit                                                                        */
/* -------------------------------------------------------------------------- */

/** Every absolutely positioned box in the markup, read back off its inline style. */
function boxesInMarkup(markup: string): readonly { left: number; width: number }[] {
  const out: { left: number; width: number }[] = [];
  for (const match of markup.matchAll(/style="([^"]*)"/g)) {
    const style = match[1] ?? '';
    // React drops the unit on a zero: `left:0`, not `left:0px`.
    const left = /(?:^|;)left:(-?[\d.]+)(?:px)?(?:;|$)/.exec(style);
    const width = /(?:^|;)width:(-?[\d.]+)(?:px)?(?:;|$)/.exec(style);
    if (left === null || width === null) continue;
    out.push({ left: Number(left[1]), width: Number(width[1]) });
  }
  return out;
}

describe('the picture fits a 390-point phone', () => {
  it('places every pill, header and hub inside 356 points, and every one is a thumb target', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { layout } = pictureOf(state, company);

    expect(layout.width).toBe(PHONE);
    expect(layout.pillWidth).toBe(130);
    for (const pill of layout.pills) {
      expect(pill.x).toBeGreaterThanOrEqual(0);
      expect(pill.x + pill.width).toBeLessThanOrEqual(PHONE);
      expect(pill.height).toBeGreaterThanOrEqual(44);
    }
    for (const header of layout.headers) {
      expect(header.x).toBeGreaterThanOrEqual(0);
      expect(header.x + header.width).toBeLessThanOrEqual(PHONE);
    }
    expect(layout.hub.x).toBeGreaterThanOrEqual(0);
    expect(layout.hub.x + layout.hub.size).toBeLessThanOrEqual(PHONE);
    expect(layout.hub.labelBox.x).toBeGreaterThanOrEqual(0);
    expect(layout.hub.figuresBox.x + layout.hub.figuresBox.width).toBeLessThanOrEqual(PHONE);
  });

  it('renders every box it laid out inside the same 356 points', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { model, layout } = pictureOf(state, company);
    const markup = render(model, layout, company);

    const boxes = boxesInMarkup(markup);
    expect(boxes.length).toBeGreaterThanOrEqual(layout.pills.length);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(PHONE);
    }
    // One button per laid-out pill, and each carries what tapping it does.
    expect((markup.match(/data-testid="conn-pill"/g) ?? []).length).toBe(layout.pills.length);
    // Every pill states its own action out loud, and the label the model built
    // is the label that reached the markup.
    const picture = connectionsModelOf(model, company.name, company.archetype);
    const drawn = [...picture.left, ...picture.right].flatMap((group) => group.pills);
    expect(drawn.length).toBe(layout.pills.length);
    for (const pill of drawn) expect(markup).toContain(pill.ariaLabel);
  });

  it('says out loud what each kind of tap does', () => {
    const base = {
      key: 'k',
      state: 'live' as const,
      label: 'Frontier model',
      figure: '~4q',
      data: '$2B–$10B',
      sector: null,
      ringPct: null,
      children: [],
    };
    expect(ariaLabelOf({ ...base, action: { kind: 'products', nodeId: 'n', productId: 'p' } })).toBe('Frontier model — open this line on Products');
    expect(ariaLabelOf({ ...base, action: { kind: 'launch', nodeId: 'n' } })).toBe('Frontier model — open a line on it');
    expect(ariaLabelOf({ ...base, action: { kind: 'expand', sector: SECTORS[0] } })).toBe('Frontier model — show or hide the rest of this sector');
    expect(ariaLabelOf({ ...base, action: { kind: 'showAll' } })).toBe('Frontier model');
    // A programme pill reads its own figures; one with nothing to say says what it opens.
    expect(ariaLabelOf({ ...base, action: { kind: 'node', nodeId: 'n', fallbackNodeId: 'n' } })).toBe('Frontier model — ~4q · $2B–$10B');
    // A forecast that has run into its own ceiling is said in words here, where
    // there is room for them, rather than as a bound the eye reads as a number.
    expect(ariaLabelOf({ ...base, figure: '>200q', action: { kind: 'node', nodeId: 'n', fallbackNodeId: 'n' } })).toBe(
      'Frontier model — more than 200q at standard effort — not on this resourcing · $2B–$10B',
    );
    expect(ariaLabelOf({ ...base, figure: '', data: '', action: { kind: 'node', nodeId: 'n', fallbackNodeId: 'n' } })).toBe(
      'Frontier model — open it',
    );
  });

  it('narrows the columns rather than the page at 326 points', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { model } = pictureOf(state, company);
    const narrow = layoutConnections({
      width: 326,
      left: layoutGroupsOf(model.left),
      right: layoutGroupsOf(model.right),
      hub: { showOutput: true },
    });
    expect(narrow.pillWidth).toBe(115);
    for (const pill of narrow.pills) expect(pill.x + pill.width).toBeLessThanOrEqual(326);
  });
});

/* -------------------------------------------------------------------------- */
/*  A programme under way                                                      */
/* -------------------------------------------------------------------------- */

describe('a programme under way', () => {
  it('is solid, ringed with its own progress, and says the quarters left and the cost a quarter', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const target = mapOf(state, company).options[0];
    expect(target).toBeDefined();
    runProgramme(state, company, target?.nodeId ?? '');

    const { view, model, layout } = pictureOf(state, company);
    const running = view.options.find((option) => option.running !== null);
    expect(running).toBeDefined();
    expect(model.right[0]?.header).toBe('Under way');

    const pill = model.right.flatMap((group) => group.pills).find((entry) => entry.key === `option_${running?.nodeId}`);
    expect(pill?.state).toBe('live');
    expect(pill?.ringPct).toBe(Math.round((running?.running?.progress ?? 0) * 100));
    // The quarters ride the wire edge, where the Products picture puts a price.
    expect(pill?.figure).toBe(`${Math.round(running?.running?.quartersLeft ?? 0)}q`);
    const short = running?.running?.bottleneck ?? null;
    // The cost a quarter, unless something is holding the programme up — in
    // which case what it is short of outranks it on a fourteen-character row.
    if (short === null) expect(pill?.data).toBe(`${formatMoney(running?.running?.quarterlyCostUsd ?? 0)}/q`);
    else expect(pill?.data).toMatch(/^[+]/);

    const markup = render(model, layout, company);
    // The ring is drawn, and it is drawn on the gain tone rather than the hairline.
    expect(markup).toContain('stroke="var(--color-gain)"');
    expect(markup).toContain(`data-key="option_${running?.nodeId}"`);
    expect(markup).toContain(pill?.data ?? '');
  });

  it('leaves a programme with nothing running unringed', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { model, layout } = pictureOf(state, company);
    expect(model.right.flatMap((group) => group.pills).every((pill) => pill.ringPct === null)).toBe(true);
    expect(render(model, layout, company)).not.toContain('stroke="var(--color-gain)"');
  });
});

/* -------------------------------------------------------------------------- */
/*  Unlocks hang off their programme                                           */
/* -------------------------------------------------------------------------- */

describe('an unlock hangs off the programme that would reach it', () => {
  it('indents the nested pill, keeps it a 44-point target and joins it with a bracket, not a flow', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const { model, layout } = pictureOf(state, company);

    const nested = layout.pills.filter((pill) => pill.nested);
    expect(nested.length).toBeGreaterThan(0);
    const brackets = layout.wires.filter((wire) => wire.kind === 'bracket');
    expect(brackets.length).toBe(nested.length);

    for (const pill of nested) {
      expect(pill.height).toBe(NESTED_H);
      expect(pill.width).toBe(layout.pillWidth - NESTED_INDENT);
      // Right-hand nests move in from the column's left edge.
      expect(pill.x).toBe(PHONE - layout.pillWidth + NESTED_INDENT);
      expect(pill.parentKey).not.toBeNull();
      const parent = layout.pills.find((entry) => entry.key === pill.parentKey);
      expect(parent?.height).toBe(PILL_H);
    }

    // A bracket is square: two corners, no cubic.
    for (const wire of brackets) {
      expect(wire.path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
      expect(wire.path).not.toContain('C');
    }

    const markup = render(model, layout, company);
    for (const wire of brackets) expect(markup).toContain(`d="${wire.path}"`);
  });
});

/* -------------------------------------------------------------------------- */
/*  A rival's research is not on my picture                                    */
/* -------------------------------------------------------------------------- */

describe('a rival\'s research never reaches this picture', () => {
  it('carries no rival progress, spend, budget or name in the rendered markup', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const rival = state.companies.find((entry) => entry.isActive && entry.id !== company.id) as Company;
    const target = mapOf(state, company).options[0];
    expect(target).toBeDefined();

    // A rival's PUBLISHED programme against the very node I am considering.
    // `researchProjectsForCompany` hands it to this screen; nothing may draw it.
    runProgramme(state, rival, target?.nodeId ?? '', {
      id: 'proj_rival_public',
      companyId: rival.id,
      isSecret: false,
      progress: 0.876_543,
      cumulativeSpendUsd: 7_777_777,
      budgetQuarterly: 5_555_555,
      quartersElapsed: 9,
    });

    const { view, model, layout } = pictureOf(state, company);
    // The engine's own guard: a rival's public programme is not my programme.
    expect(view.options.every((option) => option.running === null)).toBe(true);

    const markup = render(model, layout, company);
    for (const leak of ['0.876543', '87%', '88%', '7,777,777', '7777777', '5,555,555', '$8M', rival.name]) {
      expect(markup, `${leak} leaked onto the research picture`).not.toContain(leak);
    }
    // And the pill for that node still reads as something I could start.
    expect(markup).toContain('at standard');
  });
});

/* -------------------------------------------------------------------------- */
/*  Locked, one step away                                                      */
/* -------------------------------------------------------------------------- */

describe('the locked panel names the one thing missing and the ways in', () => {
  it('offers research, licence and buy in that order, greying what the world does not offer', () => {
    const state = createWorld3Session();
    const company = playerOf(state);
    const locked = mapOf(state, company).locked;
    expect(locked.length).toBeGreaterThan(0);

    const row = lockedRow(locked[0] as (typeof locked)[number]);
    expect(row.needs).toBe(`Needs ${locked[0]?.missing.label}`);
    expect(row.routes.map((route) => route.kind)).toEqual(['research', 'licence', 'buy']);

    const research = row.routes[0];
    expect(research?.available).toBe(locked[0]?.missing.researchable);
    if (research?.available === true) {
      expect(research.text.startsWith('Research it $')).toBe(true);
      // The chip opens the drawer on the MISSING node, not on the locked one.
      expect(research.nodeId).toBe(locked[0]?.missing.nodeId);
      expect(research.nodeId).not.toBe(row.nodeId);
    }
    // An unavailable route says so rather than vanishing.
    for (const route of row.routes) expect(route.text.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

describe('the world-3 research route', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const page = readFileSync(`${dir}../../../app/(game)/research/page.tsx`, 'utf8');

  it('draws the Connections picture instead of the node map, and hides the sector tracks', () => {
    // The world-3 branch draws exactly one picture and it is this one. The
    // panel the industry canvas hung off is deleted; `FrontierMap` is the
    // world-1/2 surface and stays in the other arm of the same condition.
    const branch = page.slice(
      page.indexOf('{nodeEconomy ? <ResearchConnectionsScreen'),
      page.indexOf('{nodeEconomy ? null : ('),
    );
    expect(branch).toContain('<ResearchConnectionsScreen');
    // The picture leads the world-3 page: the stat cards are the only thing
    // between it and the world-1/2 map, and they come *after* it.
    expect(branch.indexOf('<ResearchConnectionsScreen')).toBeLessThan(branch.indexOf('<StatCard'));
    expect(page.indexOf('<ResearchConnectionsScreen')).toBeLessThan(page.indexOf('<StatCard'));
    // The tracks panel is a world-1/2 surface: a sector is a column here.
    expect(page).toMatch(/\{!multiTrack \|\| nodeEconomy \? null : \(/);
    expect(page).toContain("title={nodeEconomy ? 'Research' : 'Frontier Map'}");
    expect(page).toContain('What you hold, what is one programme away, and what it would let you sell.');
  });

  it('keeps the programmes table, the allocation panel, the rival list and the drawer', () => {
    expect(page).toContain('title="Research programmes"');
    expect(page).toContain('title="Allocation"');
    expect(page).toContain('title="Published rival programmes"');
    expect(page).toContain('<NodeDrawer');
  });
});

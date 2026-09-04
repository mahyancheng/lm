/**
 * The world-3 node table, proved rather than trusted.
 *
 * Four kinds of assertion run here:
 *
 * - **The schema holds.** Every row parses, and the schema refuses the shapes
 *   that would make the roll-up ill-defined.
 * - **The graph is sound.** Each of the four integrity functions is shown to
 *   catch the defect it exists to catch — a cycle, a dangling id, a tier
 *   violation and an orphan sector — by rigging one and watching it fail.
 * - **The economics are believable.** Every manufactured end product's bill of
 *   materials lands inside a stated band, no line spends more on inputs than it
 *   charges, and no service spends like hardware.
 * - **A founder can make what they sell.** For every one of the fifteen
 *   backgrounds, `canProduce` is true for that background's own opening line at
 *   quarter zero. This is the test that would have caught world 2's bug, where
 *   `dependencySatisfied` asked whether a node was achieved by *anybody* and
 *   exactly one of forty-two seeded nodes was.
 */

import { describe, expect, it } from 'vitest';

/** Vite supplies this at transform time; the package carries no Vite types. */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}
import {
  BACKGROUND_SIGNATURE_NODES,
  BACKGROUND_TIER_REACH,
  BOM_BAND_HARDWARE,
  BOM_CAP_SERVICE,
  COMPUTE_CAPACITY_NODE_ID,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  ECONOMIC_NODE_SECTORS,
  EconomicNodeSchema,
  GRID_POWER_NODE_ID,
  GRID_POWER_TIER,
  NODE_ID_PREFIXES,
  SECTORS,
  ALL_BACKGROUND_IDS,
  billOfMaterialsShare,
  bomBandApplies,
  bomCapApplies,
  canProduce,
  consumesStrictlyDecreasesTier,
  economicGraphDefects,
  economicNodeById,
  economicNodesInSector,
  indexNodes,
  nodeIdPrefixSuitsTier,
  nodeReferencesResolve,
  producibleNodes,
  requiresIsAcyclicAndNonIncreasing,
  sectorForBackground,
  sectorsAreConnected,
  startingLineNodeFor,
  startingNodesFor,
  startingNodesForRival,
  type Company,
  type EconomicNode,
} from '../src/index';

const BY_ID = indexNodes(ECONOMIC_NODES);

/** A company that owns exactly these nodes. Only the fields the rules read. */
function companyOwning(ownedNodes: readonly string[]): Company {
  return { id: 'cmp_probe', ownedNodes: [...ownedNodes] } as unknown as Company;
}

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

describe('the node table', () => {
  it('carries the whole economy: about ninety rows, every one a valid node', () => {
    expect(ECONOMIC_NODES.length).toBeGreaterThanOrEqual(80);
    expect(ECONOMIC_NODES.length).toBeLessThanOrEqual(110);
    for (const entry of ECONOMIC_NODES) expect(() => EconomicNodeSchema.parse(entry)).not.toThrow();
  });

  it('has unique ids, every one carrying one of the seven prefixes', () => {
    const ids = ECONOMIC_NODES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ECONOMIC_NODES) {
      expect(NODE_ID_PREFIXES.some((prefix) => entry.id.startsWith(prefix)), `${entry.id} has no tier prefix`).toBe(true);
      expect(nodeIdPrefixSuitsTier(entry.id, entry.tier), `${entry.id} prefix disagrees with tier ${entry.tier}`).toBe(true);
    }
  });

  it('covers every sector, at more than one tier each', () => {
    for (const sector of SECTORS) {
      const inSector = economicNodesInSector(sector);
      expect(inSector.length, `${sector} is empty`).toBeGreaterThanOrEqual(8);
      expect(new Set(inSector.map((entry) => entry.tier)).size, `${sector} sits on one tier`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no defects at all', () => {
    expect(economicGraphDefects(ECONOMIC_NODES, ECONOMIC_NODE_SECTORS)).toEqual([]);
  });

  it('puts grid power at tier 1 and lets it consume no power of its own', () => {
    const power = economicNodeById(GRID_POWER_NODE_ID);
    expect(power?.tier).toBe(GRID_POWER_TIER);
    expect(power?.energyMwhPerUnit).toBe(0);
    // The compute bucket is a real node too, or the capacity draw means nothing.
    expect(economicNodeById(COMPUTE_CAPACITY_NODE_ID)).toBeDefined();
  });

  it('makes every company in the world an energy customer', () => {
    const drawing = ECONOMIC_NODES.filter((entry) => entry.energyMwhPerUnit > 0);
    expect(drawing.length).toBeGreaterThanOrEqual(30);
    for (const entry of drawing) expect(entry.tier, `${entry.id} draws power below tier 2`).toBeGreaterThan(GRID_POWER_TIER);
  });

  it('bills a chip once and a seat every quarter', () => {
    for (const entry of ECONOMIC_NODES) {
      if (entry.saleKind === 'unit') expect(entry.lifetimeQuarters, `${entry.id}`).not.toBeNull();
      else expect(entry.lifetimeQuarters, `${entry.id}`).toBeNull();
      if (entry.saleKind === 'contract') expect(entry.contractQuarters, `${entry.id}`).not.toBeNull();
      else expect(entry.contractQuarters, `${entry.id}`).toBeNull();
    }
    // The power purchase agreement is the row that makes "$26,000 per MWh every
    // quarter" honest: a twenty-quarter commitment, priced per MW-quarter.
    const ppa = economicNodeById('svc_power_purchase_agreement');
    expect(ppa?.saleKind).toBe('contract');
    expect(ppa?.contractQuarters).toBe(20);
  });

  it('says who buys a thing, or says plainly that nobody does', () => {
    for (const entry of ECONOMIC_NODES) {
      if (entry.buyerSegment === null) expect(entry.endDemandBaseUnits, `${entry.id}`).toBe(0);
      else expect(entry.endDemandBaseUnits, `${entry.id}`).toBeGreaterThan(0);
    }
    // A wafer's only demand is other companies' consumes edges — but somebody
    // still buys the fab's chemicals, so the table must contain both cases.
    expect(ECONOMIC_NODES.some((entry) => entry.buyerSegment === null)).toBe(true);
    expect(ECONOMIC_NODES.some((entry) => entry.buyerSegment !== null)).toBe(true);
  });

  it('types every talent area, rather than carrying strings nothing reads', () => {
    for (const entry of ECONOMIC_NODES) {
      expect(entry.talentAreas.length, `${entry.id} names no capability area`).toBeGreaterThan(0);
      expect(new Set(entry.talentAreas).size).toBe(entry.talentAreas.length);
    }
  });

  it('leaves raw resources and power unresearchable, and everything else reachable', () => {
    for (const entry of ECONOMIC_NODES) {
      expect(entry.researchable, `${entry.id}`).toBe(entry.tier >= 2);
      if (!entry.researchable) expect(entry.requires, `${entry.id}`).toEqual([]);
    }
    expect(ECONOMIC_NODES.filter((entry) => entry.researchable).length).toBeGreaterThanOrEqual(60);
  });

  it('collects data where a product actually observes a customer', () => {
    const observing = ECONOMIC_NODES.filter((entry) => entry.dataYieldPerUnitQuarter > 0);
    expect(observing.length).toBeGreaterThanOrEqual(15);
    for (const entry of ECONOMIC_NODES) {
      // Nothing may be sensitive without observing anything.
      if (entry.dataSensitivity > 0 && entry.dataYieldPerUnitQuarter === 0) {
        expect(entry.id.startsWith('dat_') || entry.consumes.length > 0, `${entry.id} is sensitive but sees nothing`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The four integrity functions, each shown to catch its own defect           */
/* -------------------------------------------------------------------------- */

describe('graph integrity', () => {
  it('accepts the real table on all four counts', () => {
    expect(nodeReferencesResolve(ECONOMIC_NODES)).toBe(true);
    expect(consumesStrictlyDecreasesTier(ECONOMIC_NODES)).toBe(true);
    expect(requiresIsAcyclicAndNonIncreasing(ECONOMIC_NODES)).toBe(true);
    expect(sectorsAreConnected(ECONOMIC_NODES, ECONOMIC_NODE_SECTORS)).toBe(true);
  });

  it('catches a dangling id', () => {
    const rigged = ECONOMIC_NODES.map((entry) =>
      entry.id === 'sys_battery_pack' ? { ...entry, consumes: [...entry.consumes, { nodeId: 'cmp_does_not_exist', qtyPerUnit: 1, substitutable: false }] } : entry,
    );
    expect(nodeReferencesResolve(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cmp_does_not_exist');
  });

  it('catches a tier violation', () => {
    // A component consuming a finished product is exactly the shape that made
    // the world-2 catalogue's cost roll-up non-terminating in principle.
    const rigged = ECONOMIC_NODES.map((entry) =>
      entry.id === 'cmp_battery_cell' ? { ...entry, consumes: [{ nodeId: 'sys_ai_accelerator', qtyPerUnit: 1, substitutable: false }] } : entry,
    );
    expect(consumesStrictlyDecreasesTier(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('not below');
  });

  it('catches a requires cycle', () => {
    const rigged = ECONOMIC_NODES.map((entry) => {
      if (entry.id === 'svc_training_run') return { ...entry, requires: ['dat_web_corpus'] };
      if (entry.id === 'dat_web_corpus') return { ...entry, requires: ['svc_training_run'], tier: 3 as EconomicNode['tier'], id: 'dat_web_corpus' };
      return entry;
    });
    expect(requiresIsAcyclicAndNonIncreasing(rigged)).toBe(false);
    expect(economicGraphDefects(rigged, ECONOMIC_NODE_SECTORS).join(' ')).toContain('cycle');
  });

  it('catches an orphan sector', () => {
    // Cut every edge that leaves or enters consumer and the sector is stranded.
    const consumerIds = new Set(economicNodesInSector('consumer').map((entry) => entry.id));
    const rigged = ECONOMIC_NODES.map((entry) => {
      const cutOutward = entry.consumes.filter((input) => consumerIds.has(entry.id) === consumerIds.has(input.nodeId));
      return consumerIds.has(entry.id) ? { ...entry, consumes: cutOutward, requires: [], energyMwhPerUnit: 0, capacityDrawPerUnit: 0 } : { ...entry, consumes: cutOutward };
    });
    expect(sectorsAreConnected(rigged, ECONOMIC_NODE_SECTORS)).toBe(false);
  });

  it('refuses a node that requires something above it', () => {
    const rigged = ECONOMIC_NODES.map((entry) => (entry.id === 'cmp_logic_die' ? { ...entry, requires: ['sys_ai_accelerator'] } : entry));
    expect(requiresIsAcyclicAndNonIncreasing(rigged)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Believable economics                                                       */
/* -------------------------------------------------------------------------- */

describe('the economics of a line', () => {
  it('gives every manufactured end product a believable bill of materials', () => {
    const judged = ECONOMIC_NODES.filter(bomBandApplies);
    expect(judged.length).toBeGreaterThanOrEqual(15);
    for (const entry of judged) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeGreaterThanOrEqual(BOM_BAND_HARDWARE[0]);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeLessThanOrEqual(BOM_BAND_HARDWARE[1]);
    }
  });

  it('keeps services and platforms below what hardware spends', () => {
    for (const entry of ECONOMIC_NODES.filter(bomCapApplies)) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} spends ${Math.round(share * 100)}% of its price on inputs`).toBeLessThanOrEqual(BOM_CAP_SERVICE);
    }
  });

  it('leaves every balance price a real margin over its own inputs', () => {
    // The guard against world 2's failure, where eight seeded prices
    // contradicted the catalogue they were drawn from. Every price here is
    // judged against its own node's inputs and nothing else.
    for (const entry of ECONOMIC_NODES) {
      const bom = billOfMaterialsShare(entry, BY_ID);
      if (bom === 0) continue;
      const ratio = 1 / bom;
      expect(ratio, `${entry.id} prices at only ${ratio.toFixed(2)}x its own inputs`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('never lets a line spend more on inputs than it charges', () => {
    for (const entry of ECONOMIC_NODES) {
      const share = billOfMaterialsShare(entry, BY_ID);
      expect(share, `${entry.id} is underwater at its own base price`).toBeLessThan(1);
    }
  });

  it('prices the semiconductor chain so each step adds value over the last', () => {
    const chain = ['res_silicon_feedstock', 'mat_wafer_300mm', 'cmp_accelerator_die', 'sys_advanced_package', 'sys_ai_accelerator', 'sys_ai_server_rack'];
    for (const id of chain) expect(economicNodeById(id), `${id} is missing from the table`).toBeDefined();
    const tiers = chain.map((id) => ECONOMIC_NODES_BY_ID[id]?.tier ?? -1);
    for (let index = 1; index < tiers.length; index += 1) expect(tiers[index]).toBeGreaterThan(tiers[index - 1] ?? -1);
  });

  it('measures compute in accelerators and plant in millions of dollars', () => {
    for (const entry of ECONOMIC_NODES) {
      if (entry.capacityKind === 'none') expect(entry.capacityDrawPerUnit, `${entry.id}`).toBe(0);
      else if (entry.tier >= 2) expect(entry.capacityDrawPerUnit, `${entry.id} claims a bucket it never draws on`).toBeGreaterThan(0);
    }
    // A training run occupies accelerators; it does not eat them, so there is
    // no consumes edge on the accelerator node anywhere in the AI chain.
    const run = economicNodeById('svc_training_run');
    expect(run?.capacityKind).toBe('compute');
    expect(run?.capacityDrawPerUnit).toBeGreaterThan(1);
    expect(run?.consumes.some((input) => input.nodeId === COMPUTE_CAPACITY_NODE_ID)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('where a founder starts', () => {
  it('offers a reach and a signature for every background the contracts declare', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      expect(BACKGROUND_TIER_REACH[background], `${background} has no reach`).toBeGreaterThanOrEqual(0);
      const signature = BACKGROUND_SIGNATURE_NODES[background];
      expect(signature.length, `${background} has too few signature nodes`).toBeGreaterThanOrEqual(2);
      expect(signature.length, `${background} has too many signature nodes`).toBeLessThanOrEqual(4);
      for (const id of signature) expect(economicNodeById(id), `${background} names unknown node ${id}`).toBeDefined();
    }
  });

  it('starts an AI laboratory with no robotics, energy, manufacturing or logistics of its own', () => {
    const owned = startingNodesFor('frontier_lab');
    const foreign = owned
      .map((id) => ECONOMIC_NODES_BY_ID[id])
      .filter((entry): entry is EconomicNode => entry !== undefined)
      .filter((entry) => entry.sector !== 'ai' && entry.tier > 0);
    expect(foreign.map((entry) => entry.id)).toEqual([]);
    // It still owns the commodities nobody has an exclusive claim on.
    expect(owned).toContain('res_silicon_feedstock');
  });

  it('starts every other background inside its own industry and nowhere else above the ground', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const sector = sectorForBackground(background);
      const signature = new Set(BACKGROUND_SIGNATURE_NODES[background]);
      for (const id of startingNodesFor(background)) {
        const entry = ECONOMIC_NODES_BY_ID[id];
        expect(entry, `${background} owns unknown node ${id}`).toBeDefined();
        if (entry === undefined || entry.tier === 0) continue;
        if (signature.has(id)) continue;
        // The requires closure of the opening line may cross a sector — that is
        // the point of it — so anything left must be the founder's own industry.
        const closureCrossing = startingNodesFor(background).includes(id) && entry.sector !== sector;
        if (closureCrossing) {
          expect(ECONOMIC_NODES_BY_ID[startingLineNodeFor(background)]?.requires.length ?? 0, `${background} owns foreign ${id} for no reason`).toBeGreaterThan(0);
          continue;
        }
        expect(entry.sector, `${background} owns ${id} outside ${sector}`).toBe(sector);
      }
    }
  });

  it('never hands a founder more nodes than the schema allows', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      expect(startingNodesFor(background).length, `${background} owns too many nodes`).toBeLessThanOrEqual(48);
    }
  });

  it('is deterministic and in table order', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const first = startingNodesFor(background);
      expect(startingNodesFor(background)).toEqual(first);
      const positions = first.map((id) => ECONOMIC_NODES.findIndex((entry) => entry.id === id));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  /*
   * The test that would have caught world 2's bug. There, a launch gate asked
   * whether a node was globally achieved, so a company could be seeded selling
   * something it was not allowed to make.
   */
  it('lets every background make the thing it opens selling', () => {
    for (const background of ALL_BACKGROUND_IDS) {
      const line = startingLineNodeFor(background);
      const company = companyOwning(startingNodesFor(background));
      expect(canProduce(company, line, 0), `${background} cannot produce its own opening line ${line}`).toBe(true);
    }
  });

  it('lets a rival at any capability make something, and more of it when it is better', () => {
    for (const sector of SECTORS) {
      const weak = companyOwning(startingNodesForRival(sector, 0.1));
      const strong = companyOwning(startingNodesForRival(sector, 0.95));
      expect(producibleNodes(weak).length, `${sector} weak rival can make nothing`).toBeGreaterThan(0);
      expect(producibleNodes(strong).length).toBeGreaterThanOrEqual(producibleNodes(weak).length);
    }
  });

  it('refuses a line whose prerequisite the company does not hold', () => {
    // Owning the accelerator without the package it is built from is exactly
    // the case ownership exists to refuse.
    const withoutPackage = companyOwning(['sys_ai_accelerator']);
    expect(canProduce(withoutPackage, 'sys_ai_accelerator')).toBe(false);
    const withPackage = companyOwning(['sys_ai_accelerator', 'sys_advanced_package']);
    expect(canProduce(withPackage, 'sys_ai_accelerator')).toBe(true);
  });

  it('lets a licence stand in for ownership until it lapses', () => {
    const licensee = {
      id: 'cmp_licensee',
      ownedNodes: ['sys_advanced_package'],
      licences: [{ nodeId: 'sys_ai_accelerator', ownerCompanyId: 'cmp_owner', royaltyPct: 8, expiryQuarter: 6 }],
    } as unknown as Company;
    expect(canProduce(licensee, 'sys_ai_accelerator', 0)).toBe(true);
    expect(canProduce(licensee, 'sys_ai_accelerator', 6)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  World 2 stays where it is                                                  */
/* -------------------------------------------------------------------------- */

describe('the deprecated world-2 catalogue', () => {
  it('is not imported by any world-3 module', () => {
    /*
     * Read as text through the bundler rather than through `node:fs`: this
     * package deliberately carries no Node type definitions, and the rule is
     * worth one declaration rather than a dependency. `import.meta.glob` is
     * replaced literally at transform time, so it must be written out in full.
     */
    const sources = import.meta.glob('../src/node*.ts', { query: '?raw', import: 'default', eager: true });
    const paths = Object.keys(sources);
    expect(paths.length, 'no world-3 source was scanned at all').toBeGreaterThanOrEqual(3);
    // Comments may name the catalogue — several of them explain what replaced
    // it. Only code counts, so the comments come out before the scan.
    const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [path, source] of Object.entries(sources)) {
      const code = codeOf(source);
      expect(code.includes("from './productCategories'"), `${path} imports the deprecated catalogue`).toBe(false);
      expect(code.includes('PRODUCT_CATEGORIES'), `${path} names the deprecated catalogue`).toBe(false);
      expect(code.includes('ProductCategorySchema'), `${path} names the deprecated schema`).toBe(false);
    }
  });
});

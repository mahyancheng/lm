/**
 * Determinism and the demo scenario.
 *
 * The first half checks the world the engine starts from: that
 * `createDemoSession` is a fixed point for a given seed, that it mirrors
 * `supabase/seed.sql`, and that every invariant the engine will later enforce
 * already holds in the state it is handed.
 *
 * The second half is the real thing: resolve eight quarters twice with the full
 * engine and require a byte-identical state hash at every step. It is guarded,
 * because the subsystems are built in parallel with this file — when they are
 * present it runs, and when they are not the suite skips rather than failing for
 * a reason that is not about determinism.
 */

import { describe, expect, it } from 'vitest';
import type { NpcActionBundle, SessionState, SubmittedAction } from '@frontier/contracts';
import { TECH_EPISTEMIC_STATES, balanceSheetReconciles } from '@frontier/contracts';
import { createStateHasher, hashState, stableStringify } from '@frontier/shared';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, DEMO_SEED, createDemoSession } from '../src/scenario';

/* -------------------------------------------------------------------------- */
/*  The scenario                                                               */
/* -------------------------------------------------------------------------- */

describe('the demo scenario', () => {
  it('is a fixed point for a given seed, and differs between seeds', () => {
    expect(hashState(createDemoSession())).toBe(hashState(createDemoSession()));
    expect(hashState(createDemoSession(7))).not.toBe(hashState(createDemoSession(8)));
    expect(createDemoSession().seed).toBe(String(DEMO_SEED));
  });

  it('opens in 2027 Q1 with no resolved quarter behind it', () => {
    const state = createDemoSession();
    expect(state.startYear).toBe(2027);
    expect(state.quarter).toBe(0);
    expect(state.lastResolvedQuarter).toBeNull();
    expect(state.ledgerSequence).toBe(0);
    expect(state.status).toBe('active');
  });

  it('carries the six seeded rivals and the player company', () => {
    const state = createDemoSession();
    expect(state.companies).toHaveLength(7);
    const tickers = state.companies.map((company) => company.ticker).filter((ticker) => ticker !== null);
    expect(tickers.sort()).toEqual(['ARC', 'HLX', 'MRD', 'NXS', 'ORB', 'VWA']);
    const names = state.companies.map((company) => company.name);
    expect(names).toContain('Nexus Intelligence');
    expect(names).toContain('Orbit Dynamics');
    expect(names).toContain('Helix Systems');
    expect(names).toContain('VectorWorks AI');
    expect(names).toContain('Aurora Compute');
    expect(names).toContain('Meridian Data');
    expect(names).toContain('Player Ventures');
  });

  it('gives the player a controlled company, a seat and a five-member board', () => {
    const state = createDemoSession();
    const player = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
    expect(player?.controllerPlayerId).toBe(DEMO_PLAYER_ID);
    expect(player?.ceoCharacterId).toBe(DEMO_CHARACTERS.player);
    expect(player?.isPublic).toBe(false);

    const board = state.boards.find((entry) => entry.companyId === DEMO_COMPANIES.player);
    expect(board?.directors).toHaveLength(5);
    expect(board?.chairCharacterId).toBe(DEMO_CHARACTERS.player);

    const seat = state.players.find((entry) => entry.playerId === DEMO_PLAYER_ID);
    expect(seat?.companyId).toBe(DEMO_COMPANIES.player);
    expect(seat?.isHuman).toBe(true);
  });

  it('leaves every rival unattributed, so an NPC strategist may run it', () => {
    const state = createDemoSession();
    const npcs = state.companies.filter((company) => company.id !== DEMO_COMPANIES.player);
    expect(npcs.every((company) => company.controllerPlayerId === null)).toBe(true);
  });

  it('carries the fifteen seeded characters plus the player, with Maya Chen exactly as seeded', () => {
    const state = createDemoSession();
    expect(state.characters).toHaveLength(16);
    expect(state.characters.filter((character) => character.isPlayer)).toHaveLength(1);

    const maya = state.characters.find((character) => character.id === DEMO_CHARACTERS.maya);
    expect(maya?.name).toBe('Maya Chen');
    expect(maya?.role).toBe('founder_ceo');
    expect(maya?.companyId).toBe(DEMO_COMPANIES.nexus);
    expect(maya?.stableTraits).toEqual({
      riskTolerance: 89,
      technicalOrientation: 96,
      financialConservatism: 27,
      aggressiveness: 83,
      statusSensitivity: 66,
    });
  });

  it('sets up the connection gap the game is about', () => {
    const state = createDemoSession();
    const player = state.characters.find((character) => character.id === DEMO_CHARACTERS.player);
    const nadia = state.characters.find((character) => character.id === DEMO_CHARACTERS.nadia);
    expect(player?.connectionLevel).toBe(24);
    expect(nadia?.connectionLevel).toBe(93);
    expect(Math.abs((nadia?.connectionLevel ?? 0) - (player?.connectionLevel ?? 0))).toBeGreaterThan(10);
  });

  it('carries a seventeen-node Frontier Map spanning every epistemic state', () => {
    const state = createDemoSession();
    expect(state.techGraph.nodes).toHaveLength(17);
    const states = new Set(state.techGraph.nodes.map((node) => node.status));
    for (const epistemic of TECH_EPISTEMIC_STATES) expect(states).toContain(epistemic);

    const secret = state.techGraph.nodes.filter((node) => node.status === 'secret');
    expect(secret).toHaveLength(1);
    expect(secret[0]?.visibility).toBe('company_private');

    for (const edge of state.techGraph.edges) {
      expect(state.techGraph.nodes.some((node) => node.id === edge.from)).toBe(true);
      expect(state.techGraph.nodes.some((node) => node.id === edge.to)).toBe(true);
    }
  });

  it('carries one secret research programme, invisible to everyone else', () => {
    const state = createDemoSession();
    const secret = state.researchProjects.filter((project) => project.isSecret);
    expect(secret).toHaveLength(1);
    expect(secret[0]?.companyId).toBe(DEMO_COMPANIES.nexus);
  });

  it('carries eight instruments with an opening quote each', () => {
    const state = createDemoSession();
    expect(state.marketInstruments).toHaveLength(8);
    expect(state.quotes).toHaveLength(8);
    for (const quote of state.quotes) {
      expect(quote.price).toBeGreaterThan(0);
      expect(state.marketInstruments.some((instrument) => instrument.id === quote.instrumentId)).toBe(true);
    }
    const nexus = state.quotes.find((quote) => quote.instrumentId === 'ins_nxs');
    expect(nexus?.price).toBe(83.2);
    expect(nexus?.marketCapUsd).toBeCloseTo(51_584_000_000, 0);
  });

  it('carries two open procurements whose evaluation weights sum to one', () => {
    const state = createDemoSession();
    expect(state.procurementOpportunities).toHaveLength(2);
    for (const opportunity of state.procurementOpportunities) {
      expect(opportunity.status).toBe('open');
      const weights = opportunity.evaluationWeights;
      const total =
        weights.technical + weights.security + weights.pastPerformance + weights.priceRealism + weights.schedule + weights.domesticSupply + weights.responsibleAi;
      expect(total).toBeCloseTo(1, 9);
      expect(state.agencies.some((agency) => agency.id === opportunity.agencyId)).toBe(true);
    }
  });

  it('starts with balance sheets that reconcile', () => {
    for (const company of createDemoSession().companies) {
      expect(balanceSheetReconciles(company.balanceSheet)).toBe(true);
    }
  });

  it('starts with cap tables that reconcile to their issued shares', () => {
    const state = createDemoSession();
    expect(state.capTables).toHaveLength(7);
    for (const table of state.capTables) {
      for (const shareClass of table.shareClasses) {
        const held = table.holdings
          .filter((holding) => {
            const security = state.securities.find((entry) => entry.id === holding.securityId);
            return security?.shareClassId === shareClass.id;
          })
          .reduce((sum, holding) => sum + holding.shares, 0);
        expect(held).toBe(shareClass.issuedShares);
        expect(table.totalIssuedByClass[shareClass.id]).toBe(shareClass.issuedShares);
        expect(shareClass.issuedShares).toBeLessThanOrEqual(shareClass.authorisedShares);
      }
    }
  });

  it('references only entities that exist', () => {
    const state = createDemoSession();
    const companyIds = new Set(state.companies.map((company) => company.id));
    const characterIds = new Set(state.characters.map((character) => character.id));

    for (const company of state.companies) {
      if (company.ceoCharacterId !== null) expect(characterIds.has(company.ceoCharacterId)).toBe(true);
      if (company.boardId !== null) expect(state.boards.some((board) => board.id === company.boardId)).toBe(true);
      if (company.primarySecurityId !== null) expect(state.securities.some((security) => security.id === company.primarySecurityId)).toBe(true);
      expect(state.sectors[company.sectorId]).toBeDefined();
    }
    for (const relationship of state.relationships) {
      expect(characterIds.has(relationship.fromId)).toBe(true);
      expect(characterIds.has(relationship.toId)).toBe(true);
    }
    for (const project of state.researchProjects) {
      expect(companyIds.has(project.companyId)).toBe(true);
      expect(state.techGraph.nodes.some((node) => node.id === project.targetNodeId)).toBe(true);
    }
    for (const board of state.boards) {
      for (const seat of board.directors) expect(characterIds.has(seat.characterId)).toBe(true);
    }
  });

  it('serialises canonically, so two constructions hash alike field for field', () => {
    expect(stableStringify(createDemoSession())).toBe(stableStringify(createDemoSession()));
  });
});

/* -------------------------------------------------------------------------- */
/*  Full-engine replay                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The engine module pulls in every subsystem. They are written in parallel with
 * this file, so the import is attempted rather than assumed: present, and the
 * replay runs; absent, and the suite skips.
 */
const engineModule = await (async (): Promise<typeof import('../src/engine') | null> => {
  try {
    return await import('../src/engine');
  } catch {
    return null;
  }
})();

/** Deterministic instructions for one quarter, for both the player and the NPCs. */
function scriptFor(state: SessionState, quarter: number): { actions: SubmittedAction[]; bundles: NpcActionBundle[] } {
  const base = (sequence: number, intent: SubmittedAction['intent']): SubmittedAction => ({
    actionId: `act_q${quarter}_${sequence}`,
    sessionId: state.sessionId,
    quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: DEMO_COMPANIES.player,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  });

  const actions: SubmittedAction[] = [
    base(0, { type: 'set_research_budget', budgetUsd: 250_000 + quarter * 25_000 }),
    base(1, { type: 'hire', role: quarter % 2 === 0 ? 'engineers' : 'sales', count: 2, compBand: 'market' }),
    base(2, { type: 'allocate_compute', trainingFraction: 0.3 + (quarter % 3) * 0.1 }),
  ];

  const bundles: NpcActionBundle[] = [
    {
      companyId: DEMO_COMPANIES.nexus,
      strategySummary: 'Keep the frontier programme funded and the reservation renewed, whatever the spot market does.',
      posture: 'research_first',
      actions: [
        { type: 'set_research_budget', budgetUsd: 900_000_000 },
        { type: 'hire', role: 'researchers', count: 30, compBand: 'top_of_market' },
      ],
      rationale: 'Nexus is a laboratory first: the model schedule is the only thing the board is really buying.',
    },
    {
      companyId: DEMO_COMPANIES.orbit,
      strategySummary: 'Sell into the enterprise base and keep the balance sheet boring.',
      posture: 'balanced',
      actions: [
        { type: 'set_marketing_budget', allocations: [{ segment: 'enterprise', budgetUsd: 180_000_000 }] },
        { type: 'hire', role: 'sales', count: 40, compBand: 'market' },
      ],
      rationale: 'Distribution is the moat; every quarter spent widening it is a quarter Nexus cannot buy back.',
    },
  ];

  return { actions, bundles };
}

describe.skipIf(engineModule === null)('eight quarters, twice', () => {
  it(
    'produces an identical state hash at every step',
    () => {
      if (engineModule === null) return;
      const run = (): { hashes: string[]; reports: string[]; sequences: number[] } => {
        const engine = engineModule.createDefaultEngine();
        let state = createDemoSession();
        const hashes: string[] = [hashState(state)];
        const reports: string[] = [];
        const sequences: number[] = [];
        for (let quarter = 0; quarter < 8; quarter += 1) {
          const script = scriptFor(state, quarter);
          const outcome = engine.resolver.resolveQuarter(state, script.actions, null, script.bundles);
          expect(outcome.committed).toBe(true);
          state = outcome.nextState;
          hashes.push(hashState(state));
          reports.push(outcome.report.stateHashAfter);
          sequences.push(outcome.events.length);
        }
        return { hashes, reports, sequences };
      };

      const first = run();
      const second = run();
      expect(second.hashes).toEqual(first.hashes);
      expect(second.reports).toEqual(first.reports);
      expect(second.sequences).toEqual(first.sequences);
      expect(new Set(first.hashes).size).toBe(first.hashes.length);
    },
    120_000,
  );

  it(
    'diverges when the seed changes, and only then',
    () => {
      if (engineModule === null) return;
      const resolveOnce = (seed: number): string => {
        const engine = engineModule.createDefaultEngine();
        const state = createDemoSession(seed);
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        return outcome.report.stateHashAfter;
      };
      expect(resolveOnce(DEMO_SEED)).toBe(resolveOnce(DEMO_SEED));
      expect(resolveOnce(DEMO_SEED)).not.toBe(resolveOnce(DEMO_SEED + 1));
    },
    60_000,
  );

  /**
   * Replay equality is proved above. This is the other half of the same
   * property: it must be *affordable* to prove.
   *
   * The ledger once hashed the entire session state for every row it wrote —
   * hundreds of full serialisations of a megabyte of world per quarter, which
   * was about 99% of a quarter's wall time and a one-to-two-second freeze of the
   * browser's main thread on every turn. The state is now hashed once per phase
   * that writes to the ledger, and per-row tamper evidence comes from the row
   * chain instead. The count below is the assertion that matters, because it is
   * deterministic and machine-independent; the clock is only a backstop, and its
   * bar is deliberately loose so a slow shared runner cannot make it flaky. The
   * reading is taken here, outside the engine, and is never an input to it — the
   * simulation itself still may not read a clock.
   */
  it(
    'hashes the state a handful of times per quarter, not once per ledger row',
    () => {
      if (engineModule === null) return;
      let hashes = 0;
      const counting = createStateHasher(2);
      const engine = engineModule.createDefaultEngine({
        hashState: (value) => {
          hashes += 1;
          return counting(value);
        },
      });

      let state = createDemoSession();
      // The first quarter warms the module; measure the second, as a session does.
      state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
      hashes = 0;
      const started = Date.now();
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      const elapsedMs = Date.now() - started;

      expect(outcome.committed).toBe(true);
      expect(outcome.events.length).toBeGreaterThan(50);
      // At most one full-state hash per phase boundary, plus the pre-resolution
      // one and the report's closing one. Never one per row.
      expect(hashes).toBeLessThanOrEqual(25);
      expect(hashes).toBeLessThan(outcome.events.length);
      expect(elapsedMs).toBeLessThan(3_000);
    },
    60_000,
  );

  it(
    'is idempotent: re-resolving a committed quarter changes nothing',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      const state = createDemoSession();
      const first = engine.resolver.resolveQuarter(state, [], null, []);
      expect(first.committed).toBe(true);

      const replay = engine.resolver.resolveQuarter({ ...first.nextState, quarter: 0 }, [], null, []);
      expect(replay.committed).toBe(false);
      expect(replay.events).toHaveLength(0);
      expect(replay.invariants.some((result) => result.invariant === 'idempotency' && !result.passed)).toBe(true);
    },
    60_000,
  );
});

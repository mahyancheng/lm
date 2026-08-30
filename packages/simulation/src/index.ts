/**
 * @frontier/simulation
 *
 * The deterministic world engine. The only component permitted to change
 * reality.
 *
 * > LLMs are allowed to think, propose, negotiate, communicate and reinterpret
 * > the future; only the simulation engine is allowed to make reality.
 *
 * A model proposes; this package validates, clamps, integrates and commits — or
 * refuses. Every quarter is `S_{t+1} = F(S_t, actions, modifiers, seed)`, and
 * `F` is `createQuarterResolver(...).resolveQuarter`.
 *
 * ```ts
 * import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
 *
 * const engine = createDefaultEngine();
 * const state = createDemoSession();               // 2027 Q1, seed 424242
 * const outcome = engine.resolver.resolveQuarter(state, [], null, []);
 * outcome.committed;        // true
 * outcome.report.headline;  // the one line at the top of the screen
 * outcome.nextState.quarter // 1
 * ```
 *
 * | Module          | Contains                                                  |
 * |-----------------|-----------------------------------------------------------|
 * | `engine`        | `createDefaultEngine` — every subsystem, wired            |
 * | `resolver`      | The eighteen phases, the ledger, the invariant gate        |
 * | `validator`     | All thirty-seven action rules and the board-matter gate    |
 * | `scenario`      | The 2027 Q1 demo world                                     |
 * | `economy`       | Macro drift, hazards, world modifiers, information reveal  |
 * | `markets`       | Anchors, beliefs, the return model, trade settlement       |
 * | `companies`     | People, products, financials, archetype behaviour          |
 * | `research`      | The Frontier Map, programmes, belief, player invention     |
 * | `government`    | Opportunities, bid scoring, awards, milestones             |
 * | `boards`        | Tallies, commitments, the consequences of a vote           |
 * | `relationships` | Trust, memory, connection levels, access                   |
 * | `social`        | Reach, engagement, press pickup                            |
 * | `targetPaths`   | The only door between a modifier and world state           |
 */

/* --- composition ---------------------------------------------------------- */
export { createDefaultEngine } from './engine';
export type { FrontierEngine } from './engine';

/* --- the pipeline --------------------------------------------------------- */
export * from './resolver';
export * from './validator';
export * from './scenario';

/* --- the subsystems ------------------------------------------------------- */
export * from './economy';
export * from './markets';
export * from './companies';
export * from './research';
export * from './government';
export * from './boards';
export * from './relationships';
export * from './social';
export * from './targetPaths';

/**
 * Four subsystems each define an identical `companyById(draft, id)` lookup.
 * A star export cannot choose between them, so the package index names one.
 * Nothing depends on which: they are the same three lines.
 */
export { companyById } from './boards';

/** Version of the engine surface. Recorded on quarters and snapshots. */
export const ENGINE_VERSION = '0.1.0';

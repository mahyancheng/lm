/**
 * @frontier/simulation — scenario
 *
 * Seed worlds, and the dispatcher that chooses between them.
 *
 * - **World 1** (`demo.ts`) is the frozen 2027 Q1 demo that mirrors
 *   `supabase/seed.sql`: six rival companies, fifteen named people and a
 *   seventeen-node Frontier Map. It never changes again, so a save made against
 *   it replays to the same state forever.
 * - **World 2** (`world2/`) is the multi-sector economy: six sectors, six
 *   regions, twenty-four rivals, forty-two Frontier Map nodes across six tracks,
 *   and share prices anchored to reported fundamentals.
 *
 * `createDemoSession` and `demoSessionInput` come from `session.ts` and pick
 * between the two on `setup.worldVersion`, which defaults to 1. In demo mode the
 * in-memory store is canonical — same engine, same invariants — which is exactly
 * what these modules make possible.
 */

export { createDemoSession, demoSessionInput } from './session';
export {
  DEMO_COMPANIES,
  DEMO_CHARACTERS,
  DEMO_PLAYER_ID,
  DEMO_SEED,
  NEW_GAME_BACKGROUNDS,
  NEW_GAME_BACKGROUND_IDS,
} from './demo';
export type { NewGameSetup, NewGameSetupInput, NewGameBackgroundId } from './demo';

/* --- world 2 -------------------------------------------------------------- */
export {
  W2_AGENCIES,
  W2_BOARDS,
  W2_CHARACTERS,
  W2_COMPANIES,
  W2_DEFAULT_SETUP,
  W2_FOUNDERS,
  W2_NODES,
  W2_OPPORTUNITY_SECTORS,
  W2_PLAYER_BACKGROUNDS,
  W2_SEED,
  W2_TRACKS,
  V2_COMPANY_SEEDS,
  createWorld2Session,
  world2SessionInput,
} from './world2';
export type { V2CompanySeed } from './world2';

/**
 * @frontier/simulation — scenario
 *
 * Seed worlds. One for now: the 2027 Q1 demo that mirrors
 * `supabase/seed.sql`, so a local session, a test fixture and a screenshot all
 * describe the same six companies, the same fifteen people and the same
 * seventeen-node Frontier Map.
 *
 * In demo mode the in-memory store is canonical — same engine, same invariants —
 * which is exactly what this module makes possible.
 */

export {
  createDemoSession,
  demoSessionInput,
  DEMO_COMPANIES,
  DEMO_CHARACTERS,
  DEMO_PLAYER_ID,
  DEMO_SEED,
  NEW_GAME_BACKGROUNDS,
  NEW_GAME_BACKGROUND_IDS,
} from './demo';
export type { NewGameSetup, NewGameSetupInput, NewGameBackgroundId } from './demo';

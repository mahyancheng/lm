/**
 * @frontier/simulation — scenario/session.ts
 *
 * The one door into a new world, and the only place that decides which one.
 *
 * A session records the world it was built from in `config.worldVersion`, and
 * the setup a player submits carries the same field. This module reads it once
 * and hands off:
 *
 * - **no setup at all**, or **`worldVersion: 1`** — the frozen single-sector
 *   world in `demo.ts`, byte for byte as it has always been. The unparsed setup
 *   is passed straight through so the frozen module parses it itself and no
 *   behaviour changes on the way past.
 * - **`worldVersion: 2`** — the multi-sector world in `world2/`.
 *
 * Defaulting to 1 is deliberate: `WorldVersionSchema` defaults to 1 so a save
 * written before the field existed still replays against the world it was made
 * in. A *new* game chooses 2 by passing it, which is what the new-game chat does.
 */

import type { NewGameSetupInput, SessionState, SessionStateInput } from '@frontier/contracts';
import { NewGameSetupSchema, SessionStateSchema } from '@frontier/contracts';
import { DEMO_SEED, createDemoSession as createWorld1Session, demoSessionInput as world1SessionInput } from './demo';
import { MULTI_SECTOR_WORLD_VERSION } from '../economy/sectors';
import { world2SessionInput } from './world2';

/**
 * Build the opening world for a session.
 *
 * `seed` sets `SessionState.seed` and the session id; the world data itself is
 * fixed, so the same seed and the same setup always produce a byte-identical
 * state. With no setup the result is the frozen world-1 demo, unchanged.
 */
export function createDemoSession(seed: number = DEMO_SEED, setup?: NewGameSetupInput): SessionState {
  if (setup === undefined) return createWorld1Session(seed);
  return SessionStateSchema.parse(demoSessionInput(seed, setup));
}

/** The unparsed input, for fixtures that want to vary one field before parsing. */
export function demoSessionInput(seed: number = DEMO_SEED, setupInput?: NewGameSetupInput): SessionStateInput {
  if (setupInput === undefined) return world1SessionInput(seed);
  const setup = NewGameSetupSchema.parse(setupInput);
  if (setup.worldVersion >= MULTI_SECTOR_WORLD_VERSION) return world2SessionInput(seed, setup);
  // The frozen module re-parses the setup itself; handing it the original input
  // keeps world 1 exactly the function it has always been.
  return world1SessionInput(seed, setupInput);
}

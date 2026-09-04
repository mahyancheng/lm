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
 * - **`worldVersion: 3`** — the node economy in `world3/`.
 *
 * The checks run newest first. World 3 satisfies world 2's version test as
 * well, so asking about 2 first would silently build world 2 for every new
 * game.
 *
 * Defaulting to 1 is deliberate: `WorldVersionSchema` defaults to 1 so a save
 * written before the field existed still replays against the world it was made
 * in. A *new* game chooses 2 by passing it, which is what the new-game chat does.
 */

import type {
  NewGameBackground,
  NewGameSetupInput,
  Region,
  Sector,
  SessionState,
  SessionStateInput,
  WorldVersion,
} from '@frontier/contracts';
import { CURRENT_WORLD_VERSION, NewGameSetupSchema, SessionStateSchema, backgroundsForSector } from '@frontier/contracts';
import { DEMO_SEED, createDemoSession as createWorld1Session, demoSessionInput as world1SessionInput } from './demo';
import { MULTI_SECTOR_WORLD_VERSION, NODE_ECONOMY_VERSION } from '../economy/sectors';
import { world2SessionInput } from './world2';
import { world3BackgroundsForSector, world3SessionInput } from './world3';

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
  // Newest world first: world 3 is a superset of the version test world 2 uses,
  // so asking about 2 before 3 would send every world-3 setup to world 2.
  if (setup.worldVersion >= NODE_ECONOMY_VERSION) return world3SessionInput(seed, setup);
  if (setup.worldVersion >= MULTI_SECTOR_WORLD_VERSION) return world2SessionInput(seed, setup);
  // The frozen module re-parses the setup itself; handing it the original input
  // keeps world 1 exactly the function it has always been.
  return world1SessionInput(seed, setupInput);
}

/* -------------------------------------------------------------------------- */
/*  The cards the picker draws                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The background cards for one sector, told in the numbers of the world a new
 * game will actually be built in.
 *
 * The same dispatch as `demoSessionInput` above, and it has to be: a card is a
 * promise about the session that button is going to create, so the two must
 * read `worldVersion` the same way and pick the same world from it.
 *
 * - **World 3** replaces each card's `highlights` with the figures
 *   `createWorld3Session` actually produces for that background in that region,
 *   pinned by `world3BackgroundCards.test.ts`. Everything else on the card —
 *   icon, label, tagline, blurb — is the contracts copy, untouched.
 * - **Worlds 1 and 2** get `backgroundsForSector` exactly as it stands, the
 *   same objects with the same strings they have always had. A player finishing
 *   a world-2 game sees the cards that world was described to them with.
 *
 * `region` is what the founder has chosen, or the sector's default when they
 * have not chosen yet — the same fallback `newGameSetupFromProposal` applies
 * when it builds the setup, so the card and the world agree.
 */
export function backgroundCardsFor(
  sector: Sector,
  region: Region,
  worldVersion: WorldVersion = CURRENT_WORLD_VERSION,
): readonly NewGameBackground[] {
  if (worldVersion >= NODE_ECONOMY_VERSION) return world3BackgroundsForSector(sector, region);
  return backgroundsForSector(sector);
}

/**
 * The people graph, reduced to what one founder may see.
 *
 * Two facts from `people.ts` shape everything on this screen:
 *
 * - **Connection level is public.** The engine emits the recompute as a
 *   `public` ledger row precisely so that everybody can see who is influential;
 *   that is what makes the gap rule legible rather than arbitrary.
 * - **Relationships are private and directional.** Only the edges incident to
 *   the player are theirs to read. How Maya Chen feels about Rebecca Aldana is
 *   not on this screen, and neither is what anyone privately remembers about
 *   the player.
 *
 * `checkAccess` is the engine's own pure query, and since `canReach` in the
 * validator delegates to it rather than restating it, the badge on a row and
 * the verdict on the action can never disagree. They once did: `canReach` read
 * the connection gap and the *stored* overrides only, so the twenty-seven
 * people world 2 makes reachable through a shared investor were marked
 * reachable here and refused by every rule that gates on reach.
 */

import type { AccessDecision, AccessOverride, Character, Memory, PlayerView, Relationship, SessionState } from '@frontier/contracts';
import { MEMORY_RECALL_THRESHOLD } from '@frontier/contracts';
import { checkAccess } from '@frontier/simulation';

/** Reachable now, reachable through an override, or gap-blocked. */
export type AccessState = 'open' | 'override' | 'blocked';

export interface DirectoryEntry {
  readonly character: Character;
  /** Employer name as the player may know it, or null for independents. */
  readonly companyName: string | null;
  readonly decision: AccessDecision;
  readonly state: AccessState;
  /** How the player regards them. Null when they have never dealt with each other. */
  readonly outbound: Relationship | null;
  /** How they regard the player, which the player learns by dealing with them. */
  readonly inbound: Relationship | null;
  /** People the player can reach who can in turn reach this person. */
  readonly brokerIds: readonly string[];
}

function stateOf(decision: AccessDecision): AccessState {
  if (!decision.allowed) return 'blocked';
  return decision.overrideId === null ? 'open' : 'override';
}

/**
 * Build the directory for one founder.
 *
 * `brokerIds` restates the validator's introduction rule exactly: an
 * introduction needs somebody the player can reach who can reach the target, so
 * the route the screen offers is the route the engine will accept.
 */
export function buildDirectory(session: SessionState, view: PlayerView, selfId: string): DirectoryEntry[] {
  const ownCompany = view.ownCompany;
  const names = new Map<string, string>();
  names.set(ownCompany.id, ownCompany.name);
  for (const rival of view.visibleCompanies) {
    if (rival.id !== undefined && rival.name !== undefined) names.set(rival.id, rival.name);
  }

  const others = session.characters.filter((character) => character.id !== selfId && character.isActive);
  const reachableFromSelf = new Map<string, boolean>();
  for (const character of others) {
    reachableFromSelf.set(character.id, checkAccess(session, selfId, character.id).allowed);
  }

  return others.map((character) => {
    const decision = checkAccess(session, selfId, character.id);
    const brokerIds =
      decision.allowed
        ? []
        : others
            .filter(
              (broker) =>
                broker.id !== character.id &&
                reachableFromSelf.get(broker.id) === true &&
                checkAccess(session, broker.id, character.id).allowed,
            )
            .map((broker) => broker.id);

    return {
      character,
      companyName: character.companyId === null ? null : (names.get(character.companyId) ?? null),
      decision,
      state: stateOf(decision),
      outbound: session.relationships.find((edge) => edge.fromId === selfId && edge.toId === character.id) ?? null,
      inbound: session.relationships.find((edge) => edge.fromId === character.id && edge.toId === selfId) ?? null,
      brokerIds,
    };
  });
}

/**
 * Overrides that touch the player, in both directions.
 *
 * A structural override — two directors of one board, two parties to a live
 * deal — is derived rather than stored, so it appears in `decision.reason`
 * rather than here. These are the ones somebody granted.
 */
export function overridesFor(session: SessionState, selfId: string): AccessOverride[] {
  return session.accessOverrides.filter((override) => override.fromId === selfId || override.toId === selfId);
}

/**
 * What the player remembers about one person.
 *
 * Only memories the player owns. What a character privately remembers about the
 * player is theirs, and it is the thing that makes them bring up a poaching
 * raid three years later — it is not a field this screen may read.
 */
export function memoriesAbout(session: SessionState, selfId: string, aboutId: string): Memory[] {
  return session.memories
    .filter((memory) => memory.ownerCharacterId === selfId && memory.aboutId === aboutId && memory.strength >= MEMORY_RECALL_THRESHOLD)
    .sort((a, b) => b.strength - a.strength);
}

/** Everything the player remembers, strongest first. */
export function ownMemories(session: SessionState, selfId: string): Memory[] {
  return session.memories
    .filter((memory) => memory.ownerCharacterId === selfId && memory.strength >= MEMORY_RECALL_THRESHOLD)
    .sort((a, b) => b.strength - a.strength);
}

/** A character by id, for rendering a broker or a memory subject. */
export function characterName(session: SessionState, id: string): string {
  return session.characters.find((character) => character.id === id)?.name ?? id;
}

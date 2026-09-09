/**
 * @frontier/simulation — relationships/connection.ts
 *
 * The connection hierarchy: how socially and institutionally powerful a person
 * is, recomputed every quarter from ten inputs.
 *
 * From `docs/MULTIPLAYER.md`:
 *
 * > founderReputation · companySignificance · personalWealth · boardPositions
 * > investorRelationships · governmentCredibility · mediaInfluence · priorExits
 * > publicFollowing · mutualRelationshipQuality
 * >
 * > It is emphatically **not** follower count.
 *
 * Every input is a **percentile within the session**, never a raw dollar amount
 * or a raw follower count, for the same reason the Founder Index uses
 * percentiles: otherwise one unbounded quantity eventually swamps the other
 * nine and the score stops saying anything. `publicFollowing` carries a weight
 * of 0.05 out of 1.0; `mutualRelationshipQuality` — knowing three powerful
 * people well — carries 0.12.
 */

import type { Character, ConnectionLevelInputs, ResolverContext, SessionState } from '@frontier/contracts';
import { clamp, emitEvent, line, percentileRank, ratio, round, score, unit } from './util';
import { characterById, companyById } from './relations';

/* -------------------------------------------------------------------------- */
/*  Weights                                                                    */
/* -------------------------------------------------------------------------- */

/** INVARIANT: the ten weights sum to exactly 1. */
export const CONNECTION_WEIGHTS = {
  founderReputation: 0.12,
  companySignificance: 0.16,
  personalWealth: 0.12,
  boardPositions: 0.1,
  investorRelationships: 0.1,
  governmentCredibility: 0.09,
  mediaInfluence: 0.08,
  priorExits: 0.06,
  publicFollowing: 0.05,
  mutualRelationshipQuality: 0.12,
} as const;

/** How much of last quarter's level survives. Standing moves slowly. */
export const CONNECTION_INERTIA = 0.6;

/** Largest single-quarter movement in connection level, in points. */
export const MAX_CONNECTION_STEP = 8;

/** How many mutual relationships count toward `mutualRelationshipQuality`. */
export const MUTUAL_RELATIONSHIP_DEPTH = 5;

/** Below this movement the change is not worth a ledger row. */
const CONNECTION_REPORT_THRESHOLD = 1;

/* -------------------------------------------------------------------------- */
/*  Raw inputs                                                                 */
/* -------------------------------------------------------------------------- */

interface RawInputs {
  readonly characterId: string;
  readonly founderReputation: number;
  readonly companySignificance: number;
  readonly personalWealth: number;
  readonly boardPositions: number;
  readonly investorRelationships: number;
  readonly governmentCredibility: number;
  readonly mediaInfluence: number;
  readonly priorExits: number;
  readonly publicFollowing: number;
  readonly mutualRelationshipQuality: number;
}

type RawKey = Exclude<keyof RawInputs, 'characterId'>;

const RAW_KEYS: readonly RawKey[] = [
  'founderReputation',
  'companySignificance',
  'personalWealth',
  'boardPositions',
  'investorRelationships',
  'governmentCredibility',
  'mediaInfluence',
  'priorExits',
  'publicFollowing',
  'mutualRelationshipQuality',
];

/** Enterprise value of a company, falling back to annualised revenue. */
function companyValue(draft: SessionState, companyId: string): number {
  const metric = draft.companyMetrics.find((m) => m.companyId === companyId);
  if (metric !== undefined && metric.enterpriseValueUsd > 0) return metric.enterpriseValueUsd;
  const company = companyById(draft, companyId);
  return company === null ? 0 : company.financials.revenueQuarterly * 4;
}

/** Boards this character actually sits on, plus whatever the character record claims. */
function boardSeats(draft: SessionState, characterId: string): number {
  const seated = draft.boards.reduce((n, board) => n + (board.directors.some((d) => d.characterId === characterId) ? 1 : 0), 0);
  const claimed = characterById(draft, characterId)?.boardSeatCount ?? 0;
  return Math.max(seated, claimed);
}

function rawInputsFor(draft: SessionState, character: Character): RawInputs {
  const company = character.companyId === null ? null : companyById(draft, character.companyId);

  // How the market regards the enterprise they are identified with, or — for
  // people without a company — how much respect they are shown by others.
  const received = draft.relationships.filter((r) => r.toId === character.id);
  const meanRespect = received.length === 0 ? 45 : received.reduce((s, r) => s + r.respect, 0) / received.length;
  const founderReputation =
    company === null ? meanRespect : company.reputation.public * 0.4 + company.reputation.investor * 0.3 + company.reputation.enterprise * 0.3;

  // Significance of what they run, or of the boards they sit on.
  const seatedCompanies = draft.boards.filter((b) => b.directors.some((d) => d.characterId === character.id)).map((b) => b.companyId);
  const seatedValue = seatedCompanies.length === 0 ? 0 : Math.max(...seatedCompanies.map((id) => companyValue(draft, id)));
  const companySignificance = company === null ? seatedValue * 0.5 : Math.max(companyValue(draft, company.id), seatedValue * 0.5);

  // Depth and quality of investor relationships, in both directions.
  const investorIds = new Set(draft.characters.filter((c) => c.role === 'investor' && c.isActive).map((c) => c.id));
  let investorRelationships = 0;
  for (const rel of draft.relationships) {
    if (rel.fromId === character.id && investorIds.has(rel.toId)) {
      investorRelationships += ((rel.trust + rel.respect) / 2) * (0.5 + (characterById(draft, rel.toId)?.connectionLevel ?? 50) / 200);
    }
    if (rel.toId === character.id && investorIds.has(rel.fromId)) {
      investorRelationships += ((rel.trust + rel.respect) / 2) * 0.6;
    }
  }

  // Standing with public buyers and regulators.
  const officialIds = new Set(draft.characters.filter((c) => (c.role === 'official' || c.role === 'regulator') && c.isActive).map((c) => c.id));
  const officialTies = draft.relationships.filter((r) => r.fromId === character.id && officialIds.has(r.toId));
  const officialQuality = officialTies.length === 0 ? 0 : officialTies.reduce((s, r) => s + (r.trust + r.respect) / 2, 0) / officialTies.length;
  const institutional = character.role === 'official' || character.role === 'regulator' ? 85 : 0;
  const governmentCredibility =
    company === null
      ? Math.max(institutional, officialQuality)
      : company.governmentPastPerformance * 0.6 + company.reputation.government * 0.4 + officialQuality * 0.2;

  // Ability to place and shape a story: account credibility across networks,
  // plus how often the press has actually named them.
  const accounts = draft.socialAccounts.filter((a) => a.ownerCharacterId === character.id && a.isActive);
  const accountWeight = accounts.reduce((s, a) => s + a.credibility * Math.log10(1 + a.followers), 0);
  const mentions = draft.mediaStories.reduce((s, story) => s + (story.subjectCharacterIds.includes(character.id) ? story.prominence : 0), 0);
  const authored = draft.mediaStories.reduce((s, story) => s + (story.authorCharacterId === character.id ? story.prominence : 0), 0);
  const mediaInfluence = accountWeight + mentions * 2 + authored * 3 + (character.role === 'journalist' ? 6 : 0);

  // Track record: wealth that the company they currently run does not explain.
  const currentStake = company === null ? 0 : companyValue(draft, company.id) * 0.15;
  const priorExits = Math.max(0, character.personalWealthUsd - currentStake);

  // Quality of high-value mutual relationships: three powerful people known
  // well beats thirty known slightly, so only the best few count.
  const mutuals: number[] = [];
  for (const out of draft.relationships) {
    if (out.fromId !== character.id) continue;
    const back = draft.relationships.find((r) => r.fromId === out.toId && r.toId === character.id);
    if (back === undefined) continue;
    const quality = Math.min((out.trust + out.respect) / 2, (back.trust + back.respect) / 2);
    const power = (characterById(draft, out.toId)?.connectionLevel ?? 50) / 100;
    mutuals.push(quality * power);
  }
  mutuals.sort((a, b) => b - a);
  const mutualRelationshipQuality = mutuals.slice(0, MUTUAL_RELATIONSHIP_DEPTH).reduce((s, v) => s + v, 0);

  return {
    characterId: character.id,
    founderReputation,
    companySignificance,
    personalWealth: character.personalWealthUsd,
    boardPositions: boardSeats(draft, character.id),
    investorRelationships,
    governmentCredibility,
    mediaInfluence,
    priorExits,
    publicFollowing: character.publicFollowing,
    mutualRelationshipQuality,
  };
}

/* -------------------------------------------------------------------------- */
/*  Percentile scaling                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The ten percentile inputs and the resulting level for every active character.
 * Pure with respect to the draft: it reads state and returns a projection.
 */
export function connectionInputs(draft: SessionState): ConnectionLevelInputs[] {
  const active = draft.characters.filter((c) => c.isActive);
  const raw = active.map((c) => rawInputsFor(draft, c));

  const population: Record<RawKey, number[]> = {
    founderReputation: [],
    companySignificance: [],
    personalWealth: [],
    boardPositions: [],
    investorRelationships: [],
    governmentCredibility: [],
    mediaInfluence: [],
    priorExits: [],
    publicFollowing: [],
    mutualRelationshipQuality: [],
  };
  for (const key of RAW_KEYS) {
    population[key] = raw.map((r) => r[key]);
  }

  return raw.map((r) => {
    const pct = (key: RawKey): number => percentileRank(population[key], r[key]);
    const inputs = {
      founderReputation: pct('founderReputation'),
      companySignificance: pct('companySignificance'),
      personalWealth: pct('personalWealth'),
      boardPositions: pct('boardPositions'),
      investorRelationships: pct('investorRelationships'),
      governmentCredibility: pct('governmentCredibility'),
      mediaInfluence: pct('mediaInfluence'),
      priorExits: pct('priorExits'),
      publicFollowing: pct('publicFollowing'),
      mutualRelationshipQuality: pct('mutualRelationshipQuality'),
    };
    const weighted =
      inputs.founderReputation * CONNECTION_WEIGHTS.founderReputation +
      inputs.companySignificance * CONNECTION_WEIGHTS.companySignificance +
      inputs.personalWealth * CONNECTION_WEIGHTS.personalWealth +
      inputs.boardPositions * CONNECTION_WEIGHTS.boardPositions +
      inputs.investorRelationships * CONNECTION_WEIGHTS.investorRelationships +
      inputs.governmentCredibility * CONNECTION_WEIGHTS.governmentCredibility +
      inputs.mediaInfluence * CONNECTION_WEIGHTS.mediaInfluence +
      inputs.priorExits * CONNECTION_WEIGHTS.priorExits +
      inputs.publicFollowing * CONNECTION_WEIGHTS.publicFollowing +
      inputs.mutualRelationshipQuality * CONNECTION_WEIGHTS.mutualRelationshipQuality;

    return {
      characterId: r.characterId,
      ...inputs,
      computedLevel: score(round(weighted * 100, 4)),
    } satisfies ConnectionLevelInputs;
  });
}

/* -------------------------------------------------------------------------- */
/*  Subsystem function                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Recompute every character's connection level from its ten inputs, with
 * inertia and a per-quarter step limit so standing cannot be farmed in a single
 * quarter.
 */
export function recomputeConnectionLevels(draft: SessionState, ctx: ResolverContext): void {
  const computed = connectionInputs(draft);
  const moved: { characterId: string; before: number; after: number }[] = [];

  for (const entry of computed) {
    const character = characterById(draft, entry.characterId);
    if (character === null) continue;
    const before = character.connectionLevel;
    const blended = before * CONNECTION_INERTIA + entry.computedLevel * (1 - CONNECTION_INERTIA);
    const stepped = clamp(blended, before - MAX_CONNECTION_STEP, before + MAX_CONNECTION_STEP);
    const after = score(round(stepped, 2));
    if (Math.abs(after - before) < 1e-9) continue;
    character.connectionLevel = after;
    moved.push({ characterId: entry.characterId, before, after });
  }

  if (moved.length === 0) return;

  const byMagnitude = [...moved].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  const eventId = emitEvent(
    draft,
    ctx,
    'relationship_changed',
    null,
    null,
    {
      kind: 'connection_level',
      inputs: computed.map((c) => ({
        characterId: c.characterId,
        computedLevel: c.computedLevel,
        companySignificance: round(c.companySignificance, 4),
        mutualRelationshipQuality: round(c.mutualRelationshipQuality, 4),
        publicFollowing: round(c.publicFollowing, 4),
      })),
      moved: moved.map((m) => ({ characterId: m.characterId, before: round(m.before, 2), after: round(m.after, 2) })),
    },
    // Connection levels are part of the public information set: everyone can
    // see who is influential, which is what makes the access rule legible.
    'public',
  );

  for (const entry of byMagnitude.slice(0, 3)) {
    const delta = entry.after - entry.before;
    if (Math.abs(delta) < CONNECTION_REPORT_THRESHOLD) continue;
    const name = characterById(draft, entry.characterId)?.name ?? entry.characterId;
    ctx.log({
      phase: 'relationship_update',
      text: line(`${name}'s connection level moved to ${round(entry.after, 1)} on company significance, board seats and the quality of their mutual relationships.`),
      deltaLabel: `${delta >= 0 ? '+' : ''}${round(delta, 1)}`,
      refEventIds: [eventId],
      tone: delta >= 0 ? 'positive' : 'negative',
      subjectId: entry.characterId,
    });
  }
}

/** Fraction of a character's connection level explained by one input. */
export function connectionContribution(inputs: ConnectionLevelInputs, key: keyof typeof CONNECTION_WEIGHTS): number {
  return unit(ratio(inputs[key] * CONNECTION_WEIGHTS[key] * 100, Math.max(inputs.computedLevel, 1e-9), 0));
}

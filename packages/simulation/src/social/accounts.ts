/**
 * @frontier/simulation — social/accounts.ts
 *
 * The networks and the accounts on them.
 *
 * Split out of `reach.ts` so that the two things which both need an account —
 * propagation (what a post does) and NPC authorship (that there is a post at
 * all) — can each import it without importing each other. There is no other
 * reason for this file to exist, and no behaviour in it that was not in
 * `reach.ts` before.
 *
 * `ensureAccount` is the reason a scenario does not have to seed an account for
 * every character it contains: a character who speaks in public and has no
 * account on that network gets one, derived from what the world already knows
 * about them (their following, their company's standing, their connection
 * level). The id is `makeId('soc', characterId, network)`, so the same character
 * on the same network always resolves to the same account, in any scenario, on
 * any replay.
 */

import type { Audience, NetworkArchetype, SessionState, SocialAccount } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { characterById, companyById, round, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Networks                                                                   */
/* -------------------------------------------------------------------------- */

export interface NetworkProfile {
  /** People reachable on this network at neutral attention. */
  readonly baseAudience: number;
  /** Follower composition of a typical account here. Shares sum to about 1. */
  readonly audienceMix: Readonly<Record<Audience, number>>;
  /** How readily material is reshared here. */
  readonly virality: number;
  /** How closely the press watches this network. */
  readonly pressAffinity: number;
  /** Share of a person's total following that lives here. */
  readonly followerShare: number;
}

export const NETWORK_PROFILES: Record<NetworkArchetype, NetworkProfile> = {
  fast_feed: {
    baseAudience: 40_000_000,
    audienceMix: { developers: 0.15, enterprise: 0.06, consumers: 0.3, investors: 0.15, regulators: 0.04, media: 0.18, talent: 0.12 },
    virality: 1.4,
    pressAffinity: 0.35,
    followerShare: 0.45,
  },
  professional: {
    baseAudience: 18_000_000,
    audienceMix: { developers: 0.12, enterprise: 0.3, consumers: 0.0, investors: 0.15, regulators: 0.08, media: 0.1, talent: 0.25 },
    virality: 0.8,
    pressAffinity: 0.2,
    followerShare: 0.2,
  },
  technical_forum: {
    baseAudience: 6_000_000,
    audienceMix: { developers: 0.55, enterprise: 0.1, consumers: 0.0, investors: 0.05, regulators: 0.03, media: 0.07, talent: 0.2 },
    virality: 0.9,
    pressAffinity: 0.15,
    followerShare: 0.12,
  },
  community: {
    baseAudience: 12_000_000,
    audienceMix: { developers: 0.2, enterprise: 0.07, consumers: 0.45, investors: 0.0, regulators: 0.04, media: 0.12, talent: 0.12 },
    virality: 1.1,
    pressAffinity: 0.18,
    followerShare: 0.1,
  },
  video: {
    baseAudience: 60_000_000,
    audienceMix: { developers: 0.1, enterprise: 0.02, consumers: 0.6, investors: 0.04, regulators: 0.02, media: 0.12, talent: 0.1 },
    virality: 1.6,
    pressAffinity: 0.22,
    followerShare: 0.08,
  },
  finance: {
    baseAudience: 9_000_000,
    audienceMix: { developers: 0.0, enterprise: 0.15, consumers: 0.07, investors: 0.5, regulators: 0.08, media: 0.2, talent: 0.0 },
    virality: 1.0,
    pressAffinity: 0.3,
    followerShare: 0.05,
  },
};

/* -------------------------------------------------------------------------- */
/*  Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/** Find the character's account on a network, creating a plausible one if absent. */
export function ensureAccount(draft: SessionState, characterId: string, network: NetworkArchetype): SocialAccount | null {
  const existing = draft.socialAccounts.find((a) => a.ownerCharacterId === characterId && a.network === network);
  if (existing !== undefined) return existing;
  const character = characterById(draft, characterId);
  if (character === null) return null;

  const profile = NETWORK_PROFILES[network];
  const company = character.companyId === null ? null : companyById(draft, character.companyId);
  const credibility = unit(
    0.25 + 0.35 * ((company?.reputation.public ?? 50) / 100) + 0.25 * (character.connectionLevel / 100) + 0.15 * ((company?.reputation.investor ?? 50) / 100),
  );
  const account: SocialAccount = {
    id: makeId('soc', characterId, network),
    network,
    handle: `@${character.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`,
    ownerCharacterId: characterId,
    ownerCompanyId: character.companyId,
    followers: Math.max(0, Math.round(character.publicFollowing * profile.followerShare)),
    credibility: round(credibility, 4),
    verified: character.connectionLevel >= 60,
    audienceMix: { ...profile.audienceMix },
    isActive: true,
  };
  draft.socialAccounts.push(account);
  return account;
}

/**
 * Who actually hears a post, and what the engine will do about it.
 *
 * Everything here is read from the social subsystem's own published tables —
 * `NETWORK_PROFILES` for the composition of each synthetic platform and
 * `INTENT_PROFILES` for what each intent does at the reference reach — plus the
 * author's real `audienceMix`. Nothing is invented, and nothing here claims a
 * reach figure: reach depends on a seeded draw inside the social phase, so the
 * compose preview shows *composition and direction*, never an outcome.
 */

import type { Audience, NetworkArchetype, PostIntent, SocialAccount } from '@frontier/contracts';
import { AUDIENCES } from '@frontier/contracts';
import { INTENT_PROFILES, NETWORK_PROFILES, REFERENCE_REACH } from '@frontier/simulation';

export { REFERENCE_REACH };

export interface AudienceRow {
  readonly audience: Audience;
  /** Share of the people who will hear it. */
  readonly share: number;
  /** Sentiment points this intent moves for that audience at the reference reach. */
  readonly effect: number;
}

const AUDIENCE_LABELS: Readonly<Record<Audience, string>> = {
  developers: 'Developers',
  enterprise: 'Enterprise',
  consumers: 'Consumers',
  investors: 'Investors',
  regulators: 'Regulators',
  media: 'Media',
  talent: 'Talent',
};

export function audienceLabel(audience: Audience): string {
  return AUDIENCE_LABELS[audience];
}

/**
 * The follower composition a post will actually reach: the author's own account
 * mix when they have one on that network, the platform's typical mix otherwise.
 */
export function audienceMixFor(account: SocialAccount | null, network: NetworkArchetype): Readonly<Record<Audience, number>> {
  const profile = NETWORK_PROFILES[network].audienceMix;
  if (account === null) return profile;
  const out: Record<Audience, number> = { ...profile };
  let any = false;
  for (const audience of AUDIENCES) {
    const share = account.audienceMix[audience];
    if (typeof share === 'number') {
      out[audience] = share;
      any = true;
    } else {
      out[audience] = 0;
    }
  }
  return any ? out : profile;
}

/** The audience table behind the compose preview, largest share first. */
export function predictedAudiences(
  account: SocialAccount | null,
  network: NetworkArchetype,
  intent: PostIntent,
): AudienceRow[] {
  const mix = audienceMixFor(account, network);
  const effects = INTENT_PROFILES[intent].audienceEffects;
  return AUDIENCES.map((audience) => ({
    audience,
    share: mix[audience],
    effect: effects[audience] ?? 0,
  })).sort((a, b) => b.share - a.share);
}

/** How relevant this intent is on this network, 0..1. Below 0.5 is a mismatch. */
export function networkFit(network: NetworkArchetype, intent: PostIntent): number {
  return INTENT_PROFILES[intent].networkFit[network] ?? 0;
}

/** The press bias and virality this intent carries, for the preview's warnings. */
export function intentProfile(intent: PostIntent): (typeof INTENT_PROFILES)[PostIntent] {
  return INTENT_PROFILES[intent];
}

/** Platform reading: who is on it and how fast things travel. */
export function networkProfile(network: NetworkArchetype): (typeof NETWORK_PROFILES)[NetworkArchetype] {
  return NETWORK_PROFILES[network];
}

const NETWORK_LABELS: Readonly<Record<NetworkArchetype, string>> = {
  fast_feed: 'Fast feed',
  professional: 'Professional',
  technical_forum: 'Technical forum',
  community: 'Community',
  video: 'Video',
  finance: 'Finance',
};

export function networkLabel(network: NetworkArchetype): string {
  return NETWORK_LABELS[network];
}

/**
 * A compact people count: "2.4m", "18k", "740".
 *
 * Followers and reach are counts of people, not money and not a fraction, so
 * none of the `@frontier/shared` money or percentage formatters apply. This is
 * locale-independent by construction — no `Intl`, no `toLocaleString` — for the
 * same reason every formatter in that package is.
 */
export function countLabel(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

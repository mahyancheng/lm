/**
 * "Who is coming for me", as one set of figures.
 *
 * The Street screen answers that question across eleven cards, an inbox and a
 * short book. The Market tab has to answer it in five numbers *above* the tap,
 * and the two must agree — so the stance context The Street builds inline is
 * built here once, from committed state, and both the register card's figures
 * and its holder rows are read off it.
 *
 * Nothing here computes an economic number. Every figure is a committed row —
 * `EconomyReport.capitalEntities`, `.capitalPositions`, `.shortInterest`, an
 * `ActivistCampaign`, a `DealProposal` obligation a capital desk wrote — passed
 * through the same `street/model.ts` functions The Street uses.
 *
 * Pure and total: same session and view in, same figures out.
 */

import type { PlayerView, SessionState } from '@frontier/contracts';
import {
  answerableCount,
  buyoutOf,
  disclosedHolders,
  offerInbox,
  shortInterestBadge,
  shortInterestFor,
  stanceOf,
  type ShortBadge,
  type StanceContext,
} from '@/components/screens/street';
import { capTableRows } from '@/components/screens/reporting/util';

export interface RegisterInput {
  readonly session: SessionState;
  readonly view: PlayerView;
  /** The company whose register this is — the founding company, as The Street reads it. */
  readonly companyId: string;
  /** The founder character; their holding and the player seat's are both "yours". */
  readonly founderId: string;
}

export interface RegisterHolder {
  readonly entityId: string;
  readonly name: string;
  /** Whole percent of the issued class, exactly as the position row discloses it. */
  readonly stakePct: number;
}

export interface RegisterFigures {
  readonly holders: readonly RegisterHolder[];
  /** The reader's own economic stake as a fraction of issued shares. */
  readonly ownStakePct: number;
  /** Whole percent of the float sold short, or null when no short book exists. */
  readonly shortInterestPct: number | null;
  readonly shortBadge: ShortBadge | null;
  readonly liveCampaigns: number;
  readonly dryPowderAimedAtYouUsd: number;
  readonly offers: number;
  readonly answerable: number;
}

/**
 * The stance context The Street hands every card, built from committed state.
 *
 * Exported because the derivation is the interesting part: an approach, an open
 * campaign, a proxy fight, a disclosed short and a relationship edge are the
 * five facts that decide whether an institution is aimed at you.
 */
export function stanceContextFor(input: RegisterInput): StanceContext {
  const { session, view, companyId, founderId } = input;
  const ownCompanyIds = new Set([companyId]);
  const report = view.economyReport;
  const campaigns = session.activistCampaigns ?? [];

  const trust = new Map<string, number>();
  const hostility = new Map<string, number>();
  for (const edge of session.relationships) {
    if (edge.toId !== founderId) continue;
    trust.set(edge.fromId, edge.trust);
    hostility.set(edge.fromId, edge.hostility);
  }

  const shortEntityIds = new Set<string>();
  for (const row of report?.shortInterest ?? []) {
    if (!ownCompanyIds.has(row.companyId)) continue;
    for (const id of row.disclosedEntityIds) shortEntityIds.add(id);
  }

  const approachEntityIds = new Set<string>();
  for (const deal of view.deals) {
    if (deal.status !== 'proposed' && deal.status !== 'accepted') continue;
    const offer = buyoutOf(deal);
    if (offer === null || !ownCompanyIds.has(offer.targetCompanyId)) continue;
    approachEntityIds.add(offer.entityId);
  }

  const open = campaigns.filter((campaign) => campaign.outcome === null && ownCompanyIds.has(campaign.targetCompanyId));
  return {
    ownCompanyIds,
    trustByPartnerId: trust,
    hostilityByPartnerId: hostility,
    approachEntityIds,
    campaignEntityIds: new Set(open.map((campaign) => campaign.entityId)),
    proxyFightEntityIds: new Set(open.filter((campaign) => campaign.stage === 'proxy_fight').map((campaign) => campaign.entityId)),
    shortEntityIds,
  };
}

/** How many holders the card names before it stops and lets The Street carry the rest. */
export const REGISTER_HOLDERS = 3;

export function registerFigures(input: RegisterInput): RegisterFigures {
  const { session, view, companyId, founderId } = input;
  const report = view.economyReport;
  const context = stanceContextFor(input);
  const entities = report?.capitalEntities ?? [];
  const nameOf = new Map(entities.map((row) => [row.entityId, row.name] as const));

  const holders = disclosedHolders(report, companyId)
    .slice(0, REGISTER_HOLDERS)
    .map((row) => ({ entityId: row.entityId, name: nameOf.get(row.entityId) ?? row.entityId, stakePct: row.stakePct }));

  const table = session.capTables.find((entry) => entry.companyId === companyId) ?? null;
  const ownStakePct =
    table === null
      ? 0
      : capTableRows(session, table)
          .filter((row) => row.holderId === founderId || row.holderId === view.playerId)
          .reduce((total, row) => total + row.economicPct, 0);

  const short = shortInterestFor(report, companyId)[0] ?? null;

  // Hostile or adversarial: the two stances that mean the cash is pointed at
  // you. `positions` is the whole register, because a stance is read against
  // every position an institution holds, not only the ones in your name.
  const positions = report?.capitalPositions ?? [];
  const dryPowderAimedAtYouUsd = entities
    .filter((row) => {
      const stance = stanceOf(row, positions, context);
      return stance === 'hostile' || stance === 'adversary';
    })
    .reduce((total, row) => total + row.dryPowderUsd, 0);

  const campaigns = session.activistCampaigns ?? [];
  // Campaigns, not campaigners: two funds running one campaign each against you
  // is two campaigns, and `campaignEntityIds` would collapse a fund running two.
  const liveCampaigns = campaigns.filter((campaign) => campaign.outcome === null && campaign.targetCompanyId === companyId).length;

  const offers = offerInbox({
    deals: view.deals,
    campaigns,
    companyIds: context.ownCompanyIds,
    quarter: session.quarter,
  });

  return {
    holders,
    ownStakePct,
    shortInterestPct: short === null ? null : short.shortInterestPct,
    shortBadge: short === null ? null : shortInterestBadge(short),
    liveCampaigns,
    dryPowderAimedAtYouUsd,
    offers: offers.length,
    answerable: answerableCount(offers),
  };
}

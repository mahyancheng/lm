/**
 * Briefings: `SessionState` → the pre-redacted inputs the LLM roles consume.
 *
 * The composers in `@frontier/llm` are the information boundary on the server;
 * these builders are the boundary on the way in. Nothing here reaches for a
 * rival's private research, internal confidence or undisclosed holdings, and
 * the NPC builder is explicitly scoped to what one company could know.
 *
 * All prose is assembled from committed state with `@frontier/shared`
 * formatters, so a briefing says the same numbers the screens do.
 */

import type {
  Company,
  ChiefOfStaffInput,
  LookupResult,
  NpcStrategistInput,
  SessionState,
  SimEvent,
  SocialAuthorInput,
  SocialPost,
  WorldDirectorInput,
  WorldState,
} from '@frontier/contracts';
import { WORLD_TARGET_PATHS, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import { impactBudgetFor, strategistCompanyIds } from '@frontier/simulation';
import { PLAYER_ID, drawWorldCandidates, playerCompanyOf } from './engine';
import { buildChiefOfStaffDossier } from './dossier';
import { metricsFor } from './playerView';

/* -------------------------------------------------------------------------- */
/*  Path reading                                                               */
/* -------------------------------------------------------------------------- */

/** Read a dotted world path such as `world.compute.spotPrice`. */
function readWorldPath(world: WorldState, path: string): number | null {
  const segments = path.split('.');
  if (segments[0] !== 'world') return null;
  let cursor: unknown = world;
  for (const segment of segments.slice(1)) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'number' ? cursor : null;
}

/** A human label for a world path: the last segment, de-camel-cased. */
function labelForPath(path: string): string {
  const leaf = path.split('.').pop() ?? path;
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Prose                                                                      */
/* -------------------------------------------------------------------------- */

/** A prose briefing on world conditions, shared by every role that needs one. */
export function worldBriefing(session: SessionState): string {
  const w = session.world;
  const events = session.activeEvents.filter((event) => event.visibility === 'public').slice(0, 4);
  const lines = [
    `${quarterLabel(session.startYear, session.quarter)}. Policy rate ${formatPct(w.macro.policyRate)}, inflation ${formatPct(w.macro.inflation)}, GDP growth ${formatPct(w.macro.gdpGrowth)}.`,
    `Capital markets: risk appetite ${w.capitalMarkets.riskAppetite.toFixed(2)}, venture liquidity ${w.capitalMarkets.ventureLiquidity.toFixed(2)}, IPO window ${w.capitalMarkets.ipoWindow.toFixed(2)}, debt availability ${w.capitalMarkets.debtAvailability.toFixed(2)}.`,
    `Compute: accelerator supply ${w.compute.acceleratorSupply.toFixed(2)}, spot price index ${w.compute.spotPrice.toFixed(2)}.`,
    `Talent: salary pressure ${w.talent.salaryPressure.toFixed(2)}, researcher supply ${w.talent.researcherSupply.toFixed(2)}.`,
    `Regulation and society: model rules ${w.regulation.modelRules.toFixed(2)}, antitrust ${w.regulation.antitrust.toFixed(2)}, public trust in AI ${w.society.aiTrust.toFixed(2)}, automation anxiety ${w.society.automationAnxiety.toFixed(2)}.`,
  ];
  if (events.length > 0) {
    lines.push(`Active: ${events.map((event) => event.title).join('; ')}.`);
  }
  return lines.join('\n');
}

/** A prose briefing on one company, in full. Only ever built for a company the caller owns. */
export function companyBriefing(session: SessionState, company: Company): string {
  const metrics = metricsFor(session, company.id);
  const staff = company.employees;
  const headcount = staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs;
  const lines = [
    `${company.name} (${company.ticker ?? 'private'}) — ${company.archetype.replace(/_/g, ' ')}, ${company.sectorId.replace(/_/g, ' ')}, headquartered in ${company.headquartersCity}. Posture ${company.posture.replace(/_/g, ' ')}.`,
    `Revenue ${formatMoney(company.financials.revenueQuarterly)} this quarter; cash ${formatMoney(company.financials.cash)}; debt ${formatMoney(company.financials.debt)}; quarterly burn ${formatMoney(company.financials.quarterlyBurn)}.`,
    metrics === null
      ? 'No derived metrics yet: the first quarter has not resolved.'
      : `Runway ${formatQuarterCount(metrics.runwayQuarters)}; gross margin ${formatPct(metrics.grossMarginPct)}; operating margin ${formatPct(metrics.operatingMarginPct)}.`,
    `Headcount ${headcount} (${staff.engineers} engineers, ${staff.researchers} researchers, ${staff.sales} sales, ${staff.ops} ops, ${staff.execs} executives); morale ${Math.round(staff.morale)}; ${staff.openRoles} open roles.`,
    `Compute: ${company.compute.ownedAccelerators} owned and ${company.compute.reservedAccelerators} reserved accelerators, ${formatPct(company.compute.trainingAllocation)} allocated to training, utilisation ${formatPct(company.compute.computeUtilisation)}.`,
    `Products: ${company.products.map((product) => `${product.name} at ${formatMoney(product.pricePerSeat)}/seat, ${product.activeCustomers} customers, churn ${formatPct(product.churnQuarterly)}`).join('; ') || 'none'}.`,
    `Reputation — public ${company.reputation.public}, developer ${company.reputation.developer}, enterprise ${company.reputation.enterprise}, government ${company.reputation.government}, investor ${company.reputation.investor}.`,
  ];
  return lines.join('\n');
}

/** Current spend lines, so "keep total burn roughly unchanged" can be honoured arithmetically. */
export function currentBudgets(company: Company): { label: string; amountUsd: number }[] {
  return [
    { label: 'Research and development', amountUsd: company.financials.rdSpend },
    { label: 'Marketing', amountUsd: company.financials.marketing },
    { label: 'Payroll', amountUsd: company.financials.payroll },
    { label: 'Cloud compute', amountUsd: company.compute.cloudSpendQuarterly },
    { label: 'Capital expenditure', amountUsd: company.financials.capex },
  ];
}

/** Matters awaiting the player. */
export function openDecisions(session: SessionState, company: Company): string[] {
  const decisions: string[] = [];
  for (const proposal of session.boardProposals) {
    if (proposal.companyId === company.id && proposal.status === 'tabled') {
      decisions.push(`Board proposal awaiting vote: ${proposal.title}.`);
    }
  }
  for (const deal of session.deals) {
    if (deal.counterpartyId === company.id && deal.status === 'proposed') {
      decisions.push(`Deal awaiting an answer: ${deal.summary}`);
    }
  }
  for (const opportunity of session.procurementOpportunities) {
    if (opportunity.status !== 'open') continue;
    if (opportunity.visibility !== 'public' && !opportunity.invitedCompanyIds.includes(company.id)) continue;
    decisions.push(`${opportunity.programme} is open until ${quarterLabel(session.startYear, opportunity.closeQuarter)}, ceiling ${formatMoney(opportunity.maxValue)}.`);
  }
  if (company.compute.reservationExpiryQuarter !== null && company.compute.reservationExpiryQuarter - session.quarter <= 2) {
    decisions.push('A compute reservation expires within two quarters.');
  }
  return decisions;
}

/* -------------------------------------------------------------------------- */
/*  Role inputs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the World Director's input for the open quarter.
 *
 * The candidates come from `drawWorldCandidates`, which forks the resolver's
 * own random stream, so the candidate ids here are the ids `resolveQuarter`
 * will match proposals against. When no candidate fires — a quiet quarter is a
 * legitimate outcome — this returns null and the caller passes no proposal.
 */
export function buildWorldDirectorInput(session: SessionState, previousWorld: WorldState | null): WorldDirectorInput | null {
  const candidates = drawWorldCandidates(session);
  if (candidates.length === 0) return null;

  const worldDigest = Object.keys(WORLD_TARGET_PATHS).flatMap((path) => {
    const value = readWorldPath(session.world, path);
    if (value === null) return [];
    const previous = previousWorld === null ? null : readWorldPath(previousWorld, path);
    return [{ path, value, delta: previous === null ? 0 : value - previous, label: labelForPath(path) }];
  });

  return {
    sessionId: session.sessionId,
    quarter: session.quarter,
    quarterLabel: quarterLabel(session.startYear, session.quarter),
    worldSummary: worldBriefing(session),
    worldDigest,
    sectorSummary: Object.values(session.sectors).map((sector) => ({
      sectorId: sector.sectorId,
      sentiment: sector.sentiment,
      multiple: sector.multiple,
      demand: sector.demand,
    })),
    eventCandidates: candidates,
    impactBudget: impactBudgetFor(session),
    recentEvents: session.activeEvents.slice(-8).map((event) => ({
      eventId: event.id,
      quarter: event.quarter,
      type: event.type,
      title: event.title,
      severity: event.severity,
      stillActive: event.quarter + event.durationQuarters > session.quarter,
    })),
    activeModifierSummaries: session.activeModifiers.map((modifier) => ({
      target: modifier.target,
      operation: modifier.operation,
      value: modifier.value,
      remainingQuarters: modifier.remainingQuarters,
      reason: modifier.reason,
    })),
    legalTargetPaths: Object.keys(WORLD_TARGET_PATHS),
    knownSectorIds: Object.keys(session.sectors),
    styleGuidance:
      'In-world reporting. No second person, no prediction of any player\'s outcome, no invented company names. Two to four sentences of copy per event.',
  };
}

/**
 * Build one NPC strategist's input.
 *
 * Scoped hard: this company's own position in full, the world as it would
 * understand it, and rivals reduced to public information. Nothing private
 * about another company crosses this boundary.
 */
export function buildNpcStrategistInput(session: SessionState, companyId: string): NpcStrategistInput | null {
  const company = session.companies.find((entry) => entry.id === companyId) ?? null;
  if (company === null) return null;

  const rivals = session.companies.filter((entry) => entry.id !== companyId && entry.isActive);
  const rivalBriefing = rivals
    .map((rival) => {
      if (!rival.isPublic) return `${rival.name} — private, ${rival.sectorId.replace(/_/g, ' ')}. Financials undisclosed.`;
      return `${rival.name} (${rival.ticker ?? '—'}) — ${rival.sectorId.replace(/_/g, ' ')}, revenue ${formatMoney(rival.financials.revenueQuarterly)} last reported, cash ${formatMoney(rival.financials.cash)}, enterprise reputation ${rival.reputation.enterprise}.`;
    })
    .join('\n');

  const cash = company.financials.cash;
  const constraints = [
    `Available cash ${formatMoney(cash)}.`,
    `Held compute ${company.compute.ownedAccelerators + company.compute.reservedAccelerators} accelerator-equivalents at ${formatPct(company.compute.computeUtilisation)} utilisation.`,
    company.boardId === null
      ? 'No board: financing, buybacks, share issuance and acquisitions are not available.'
      : 'Financing, buybacks, share issuance and acquisitions require a board proposal.',
  ];

  return {
    sessionId: session.sessionId,
    quarter: session.quarter,
    companyId,
    companyBriefing: companyBriefing(session, company),
    worldBriefing: worldBriefing(session),
    rivalBriefing,
    openOpportunities: session.procurementOpportunities
      .filter((opportunity) => opportunity.status === 'open' && (opportunity.visibility === 'public' || opportunity.invitedCompanyIds.includes(companyId)))
      .map((opportunity) => ({
        opportunityId: opportunity.id,
        programme: opportunity.programme,
        maxValueUsd: opportunity.maxValue,
        closeQuarter: opportunity.closeQuarter,
      })),
    incomingDeals: session.deals
      .filter((deal) => deal.counterpartyId === companyId && deal.status === 'proposed')
      .map((deal) => ({ dealId: deal.id, fromId: deal.proposerId, summary: deal.summary })),
    priorPosture: company.posture,
    priorStrategySummary: `Last quarter ${company.name} held a ${company.posture.replace(/_/g, ' ')} posture with risk tolerance ${company.riskTolerance.toFixed(2)}.`,
    constraints,
  };
}

/**
 * Which companies get a live strategist this quarter.
 *
 * Delegated to the engine's own selector, which is the only place that decides
 * it: major tier, not player-directed, ranked by trailing revenue then market
 * capitalisation then id, and **capped** at `MAX_LIVE_STRATEGISTS`.
 *
 * The cap is the whole point. This function used to return every active
 * major-tier rival, which was fine when the world held seven companies and is
 * a bill when it holds twenty-five across six sectors: each id here becomes one
 * model call per quarter, and each `claude-session` call spawns a Claude Code
 * subprocess on the operator's own subscription. Six keeps the per-quarter cost
 * flat however large the world grows; the rivals below the line run the
 * deterministic archetype policy, which is what the three-tier design says
 * should happen to them anyway.
 *
 * The ranking is pure and total, so the same state always names the same
 * companies — a replayed quarter asks for exactly the strategists the live
 * quarter asked for.
 */
export function strategistCompanies(session: SessionState): string[] {
  return [...strategistCompanyIds(session)];
}

/**
 * Build the social author's input for one post the engine has already made.
 *
 * The engine decided the author, the network, the typed intent and the target
 * before this function ran, and it wrote a template line the quarter is complete
 * without. All the model is asked for is the prose, so everything here is
 * context: who is speaking, who is listening, what just happened, and what may
 * not be said. Nothing private about another company crosses this boundary — the
 * situation is built from the post's own public facts.
 */
export function buildSocialAuthorInput(session: SessionState, post: SocialPost): SocialAuthorInput | null {
  const author = session.characters.find((character) => character.id === post.authorCharacterId) ?? null;
  if (author === null) return null;
  const account = session.socialAccounts.find((entry) => entry.id === post.accountId) ?? null;
  const company = author.companyId === null ? null : (session.companies.find((entry) => entry.id === author.companyId) ?? null);
  const target = post.targetCompanyId === null ? null : (session.companies.find((entry) => entry.id === post.targetCompanyId) ?? null);
  const parent = post.replyToPostId === null ? null : (session.socialPosts.find((entry) => entry.id === post.replyToPostId) ?? null);

  const traits = author.stableTraits;
  const authorBriefing = [
    `${author.name} — ${author.title || author.role.replace(/_/g, ' ')}${company === null ? '' : ` at ${company.name}`}.`,
    `Connection level ${Math.round(author.connectionLevel)}; ${Math.round(author.publicFollowing).toLocaleString('en-GB')} following across networks.`,
    `Traits: risk ${Math.round(traits.riskTolerance)}, technical ${Math.round(traits.technicalOrientation)}, financial caution ${Math.round(traits.financialConservatism)}, aggression ${Math.round(traits.aggressiveness)}, status sensitivity ${Math.round(traits.statusSensitivity)}.`,
    company === null
      ? 'They speak for themselves rather than for a company.'
      : `${company.name} — ${company.sectorId.replace(/_/g, ' ')}, public reputation ${company.reputation.public}, developer ${company.reputation.developer}, enterprise ${company.reputation.enterprise}.`,
  ].join('\n');

  const situation = [
    // The engine's own line, which is what this call is replacing. Supplying it
    // is what keeps the model on the subject rather than inventing one.
    `The line they are about to publish, written by the simulation: "${post.text}"`,
    parent === null ? null : `It answers a post on the same network: "${parent.text}"`,
    target === null ? null : `It is aimed at ${target.name}.`,
    `Quarter ${quarterLabel(session.startYear, post.quarter)}. Press attention ${formatPct(session.world.media.attentionLevel)}, dominant narrative ${session.world.media.dominantNarrative.replace(/_/g, ' ')}.`,
  ]
    .filter((entry): entry is string => entry !== null)
    .join('\n');

  const audienceMix = Object.entries(account?.audienceMix ?? {})
    .map(([audience, share]) => ({ audience, share: typeof share === 'number' ? share : 0 }))
    .sort((a, b) => b.share - a.share || a.audience.localeCompare(b.audience));

  return {
    authorCharacterId: author.id,
    authorBriefing,
    network: post.network,
    intent: post.intent,
    situation,
    audienceMix,
    constraints: [
      'Say only what the line above already says. Do not announce anything that has not happened.',
      'No undisclosed financials, no unannounced products, no contract terms under confidentiality.',
      'State positions, never outcomes: nothing about share prices, sentiment, reach or what the post will achieve.',
      'At most 560 characters, in this person\'s voice, on this network.',
    ],
  };
}

/**
 * Build the Chief of Staff's input for one message.
 *
 * The typed dossier is the substance; the prose fields below it are kept and
 * filled from the same state so a caller that predates the dossier — or a
 * request that had to drop it — still gets a usable briefing. Whichever is
 * present, the composer is the boundary: nothing private about another company
 * crosses it.
 *
 * `options.companyId` is STAGE 5's switcher: which company the conversation is
 * speaking for. Defaults to the founding company, so every caller from before
 * the switcher existed is unchanged. An id this seat does not actually
 * control falls back to the founding company too, rather than building a
 * briefing for a company the seat has no standing to instruct.
 */
export function buildChiefOfStaffInput(
  session: SessionState,
  playerMessage: string,
  conversationHistory: readonly { role: 'player' | 'chief_of_staff'; text: string }[],
  options: {
    readonly screen?: string;
    readonly ledger?: readonly SimEvent[];
    /**
     * The answers to the lookups the previous turn asked for, run by the client
     * through `runLookups`. Present only on the second turn of one message, and
     * its presence is what closes research mode for that turn.
     */
    readonly findings?: readonly LookupResult[];
    /** The company this conversation is speaking for. Defaults to the founding company. */
    readonly companyId?: string;
  } = {},
): ChiefOfStaffInput {
  const company =
    options.companyId === undefined
      ? playerCompanyOf(session)
      : (session.companies.find((entry) => entry.isActive && entry.id === options.companyId && entry.controllerPlayerId === PLAYER_ID) ??
        playerCompanyOf(session));
  const seat = session.players.find((player) => player.playerId === PLAYER_ID) ?? null;
  const dossier = buildChiefOfStaffDossier(session, options.ledger ?? [], company);
  return {
    sessionId: session.sessionId,
    quarter: session.quarter,
    playerId: PLAYER_ID,
    companyId: company.id,
    playerMessage,
    ...(options.screen === undefined ? {} : { screen: options.screen.slice(0, 80) }),
    ...(options.findings === undefined ? {} : { findings: [...options.findings] }),
    dossier,
    companyBriefing: companyBriefing(session, company),
    worldBriefing: worldBriefing(session),
    currentBudgets: currentBudgets(company),
    openDecisions: openDecisions(session, company),
    conversationHistory: conversationHistory.map((turn) => ({ role: turn.role, text: turn.text })),
    autoExecuteEnabled: seat?.autoExecuteRoutine ?? false,
  };
}

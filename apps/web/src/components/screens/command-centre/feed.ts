/**
 * The TODAY feed, derived.
 *
 * `PlayerView.alerts` is the engine's own alert list and is rendered verbatim
 * elsewhere in the shell. This builder produces the richer Command Centre feed:
 * the same conditions plus the ones the screen contract asks for — closing
 * procurements, pending board matters, the narrative the press is running,
 * frontier-map divergence and what rivals did last quarter — each with a tone
 * and the screen that resolves it.
 *
 * Everything here reads committed state or the last committed resolution
 * report. Nothing is invented, and order is stable so the feed does not
 * reshuffle between renders.
 */

import type { PlayerView, SessionState } from '@frontier/contracts';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import { formatMoney, formatQuarterCount } from '@frontier/shared';
import { toneOfLine, type Tone } from '@/components/ui';
import { humanise } from '../reporting/util';

export interface FeedItem {
  readonly id: string;
  readonly text: string;
  /** Short right-hand label: a figure, a count, a delta. */
  readonly meta?: string;
  readonly tone: Tone;
  /** The screen that resolves this line. */
  readonly href: string;
  readonly group: 'company' | 'world' | 'competition';
}

const CONFIDENCE_EDGE = 0.15;

export function buildFeed(
  session: SessionState,
  view: PlayerView,
  outcome: FrontierResolutionOutcome | null,
  blockedActions: number,
): FeedItem[] {
  const company = view.ownCompany;
  const items: FeedItem[] = [];

  /* --- your company ------------------------------------------------------- */

  const metrics = session.companyMetrics.find((entry) => entry.companyId === company.id) ?? null;
  if (metrics !== null && metrics.runwayQuarters < 6) {
    items.push({
      id: 'runway',
      text: `Runway is ${formatQuarterCount(metrics.runwayQuarters)} at the current burn.`,
      meta: formatMoney(company.financials.cash),
      tone: metrics.runwayQuarters < 3 ? 'loss' : 'warn',
      href: '/capital',
      group: 'company',
    });
  }
  if (company.financials.cash <= 0) {
    items.push({
      id: 'cash',
      text: 'Cash is exhausted. Financing or cuts are required this quarter.',
      meta: formatMoney(company.financials.cash),
      tone: 'loss',
      href: '/capital',
      group: 'company',
    });
  }

  const tabled = view.boardProposals.filter((proposal) => proposal.status === 'tabled');
  if (tabled.length > 0) {
    items.push({
      id: 'board',
      text: `${tabled.length} board matter${tabled.length === 1 ? '' : 's'} awaiting a vote.`,
      meta: `${tabled.length}`,
      tone: 'warn',
      href: '/boardroom',
      group: 'company',
    });
  }

  const inbound = view.deals.filter((deal) => deal.counterpartyId === company.id && deal.status === 'proposed');
  if (inbound.length > 0) {
    items.push({
      id: 'deals',
      text: `${inbound.length} deal${inbound.length === 1 ? '' : 's'} awaiting your answer.`,
      meta: `${inbound.length}`,
      tone: 'info',
      href: '/deal-room',
      group: 'company',
    });
  }

  for (const opportunity of view.opportunities) {
    if (opportunity.status !== 'open') continue;
    const remaining = opportunity.closeQuarter - session.quarter;
    if (remaining > 1) continue;
    items.push({
      id: `opp_${opportunity.id}`,
      text: `${opportunity.programme} closes ${remaining <= 0 ? 'this quarter' : 'next quarter'}.`,
      meta: formatMoney(opportunity.maxValue),
      tone: remaining <= 0 ? 'warn' : 'info',
      href: '/government',
      group: 'company',
    });
  }

  if (company.compute.reservationExpiryQuarter !== null) {
    const remaining = company.compute.reservationExpiryQuarter - session.quarter;
    if (remaining <= 2) {
      items.push({
        id: 'compute',
        text: `Compute reservation expires in ${Math.max(0, remaining)} quarter${remaining === 1 ? '' : 's'}.`,
        meta: `${company.compute.reservedAccelerators} units`,
        tone: 'warn',
        href: '/company',
        group: 'company',
      });
    }
  }

  if (company.employees.morale < 45) {
    items.push({
      id: 'morale',
      text: `Morale is ${Math.round(company.employees.morale)} and below the attrition threshold.`,
      meta: `${Math.round(company.employees.attrition * 100)}% attrition`,
      tone: 'warn',
      href: '/people',
      group: 'company',
    });
  }

  if (blockedActions > 0) {
    items.push({
      id: 'blocked',
      text: `${blockedActions} queued action${blockedActions === 1 ? '' : 's'} still need${blockedActions === 1 ? 's' : ''} your explicit confirmation.`,
      meta: `${blockedActions}`,
      tone: 'warn',
      href: '/end-quarter',
      group: 'company',
    });
  }

  /* --- the world ---------------------------------------------------------- */

  for (const event of view.activeEvents) {
    if (event.severity < 0.35) continue;
    items.push({
      id: `evt_${event.id}`,
      text: event.title,
      meta: `severity ${Math.round(event.severity * 100)}`,
      tone: event.severity >= 0.6 ? 'warn' : 'info',
      href: '/news',
      group: 'world',
    });
  }

  const media = view.world.media;
  if (media.dominantNarrative !== 'neutral') {
    items.push({
      id: 'narrative',
      text: `The press is running ${humanise(media.dominantNarrative).toLowerCase()}.`,
      meta: `attention ${Math.round(media.attentionLevel * 100)}`,
      tone: media.controversyIntensity >= 0.5 ? 'warn' : 'info',
      href: '/news',
      group: 'world',
    });
  }

  const divergent = view.techGraph.nodes.filter((node) => {
    const own = node.confidenceByCompany[company.id];
    return own !== undefined && Math.abs(own - node.publicConfidence) >= CONFIDENCE_EDGE;
  });
  if (divergent.length > 0) {
    items.push({
      id: 'frontier',
      text: `Frontier map: ${divergent.length} node${divergent.length === 1 ? '' : 's'} where your estimate differs from the market.`,
      meta: `${divergent.length}`,
      tone: 'info',
      href: '/research',
      group: 'world',
    });
  }

  /* --- competition -------------------------------------------------------- */

  if (outcome !== null) {
    const rivalLines = outcome.report.phases
      .filter((phase) => phase.phase === 'market_resolution' || phase.phase === 'government_resolution' || phase.phase === 'leaderboard_update')
      .flatMap((phase) => phase.lines)
      .filter((line) => line.subjectId !== null && line.subjectId !== company.id)
      .slice(0, 5);

    for (const [index, line] of rivalLines.entries()) {
      items.push({
        id: `rival_${index}_${line.subjectId ?? 'x'}`,
        text: line.text,
        meta: line.deltaLabel ?? undefined,
        tone: toneOfLine(line.tone),
        href: line.phase === 'market_resolution' ? '/markets' : '/quarter-resolution',
        group: 'competition',
      });
    }
  }

  return items;
}

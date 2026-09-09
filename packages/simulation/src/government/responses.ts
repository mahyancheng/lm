/**
 * @frontier/simulation — government/responses.ts
 *
 * The two things a company can do about an open competition other than bid on
 * it: decline it, and put a consortium together to bid it jointly.
 *
 * Both resolve at the top of `government_resolution`, before new competitions
 * open and before `ensureGovernmentBids` turns this quarter's `bid_government`
 * actions into stored bids — so a decline is on the record before scoring, and a
 * consortium invitation is on the table before the bid that would use it.
 *
 * A decline is not a no-op. Declining an invited competition is remembered by
 * the agency: the company comes off the invitation list for that programme and
 * its record with that agency moves slightly against it, which is what
 * `invitees()` reads the next time the agency runs something restricted.
 *
 * A consortium is not a contract. `form_consortium` creates one *proposed* deal
 * per invitee carrying a `consortium_membership` obligation, exactly as the
 * action's own description promises: each invitee must accept through the deal
 * system before the consortium is real.
 */

import type { DealProposal, ResolverContext, SessionState, SubmittedAction } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { ensureReputation, movePastPerformance } from './contracts';
import { companyById, emitEvent, line, round } from './util';

/** Past-performance cost of declining a competition you were invited to. */
export const DECLINE_PAST_PERFORMANCE_COST = 1;

/** Quarters a consortium invitation stays open before it lapses. */
export const CONSORTIUM_OFFER_QUARTERS = 2;

/** Actions of one type queued for this quarter, in submission order. */
function pending<T extends SubmittedAction['intent']['type']>(
  draft: SessionState,
  quarter: number,
  type: T,
): { action: SubmittedAction; intent: Extract<SubmittedAction['intent'], { type: T }> }[] {
  return draft.pendingActions
    .filter((action) => action.quarter === quarter && action.intent.type === type)
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : a.actionId < b.actionId ? -1 : 1))
    .map((action) => ({ action, intent: action.intent as Extract<SubmittedAction['intent'], { type: T }> }));
}

/** Consume `decline_opportunity` and `form_consortium` for this quarter. */
export function resolveOpportunityResponses(draft: SessionState, ctx: ResolverContext): void {
  /* --- declines ---------------------------------------------------------- */
  for (const { action, intent } of pending(draft, ctx.quarter, 'decline_opportunity')) {
    const opportunity = draft.procurementOpportunities.find((o) => o.id === intent.opportunityId);
    const company = companyById(draft, action.actorCompanyId);
    if (opportunity === undefined || company === null) continue;

    const wasInvited = opportunity.invitedCompanyIds.includes(company.id);
    opportunity.invitedCompanyIds = opportunity.invitedCompanyIds.filter((id) => id !== company.id);
    const record = ensureReputation(draft, company.id, opportunity.agencyId, ctx.quarter);
    record.lastUpdatedQuarter = ctx.quarter;
    // A company that walks away from an invitation is invited less often. One
    // point is deliberately small: this is a nudge, not a punishment.
    const after = wasInvited
      ? movePastPerformance(draft, company.id, opportunity.agencyId, -DECLINE_PAST_PERFORMANCE_COST, ctx.quarter)
      : company.governmentPastPerformance;

    const eventId = emitEvent(
      draft,
      ctx,
      'information_revealed',
      company.id,
      opportunity.id,
      {
        kind: 'opportunity_declined',
        programme: opportunity.programme,
        wasInvited,
        reason: intent.reason.slice(0, 300),
        pastPerformanceAfter: round(after, 2),
      },
      opportunity.visibility === 'public' ? 'sector' : 'company',
    );
    ctx.log({
      phase: 'government_resolution',
      text: line(
        `${company.name} formally declined ${opportunity.programme}${wasInvited ? '; the agency has taken it off their invitation list' : ''}.`,
      ),
      deltaLabel: wasInvited ? `-${DECLINE_PAST_PERFORMANCE_COST} standing` : 'declined',
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }

  /* --- consortium invitations -------------------------------------------- */
  for (const { action, intent } of pending(draft, ctx.quarter, 'form_consortium')) {
    const opportunity = draft.procurementOpportunities.find((o) => o.id === intent.opportunityId);
    const company = companyById(draft, action.actorCompanyId);
    if (opportunity === undefined || company === null) continue;
    const lead = companyById(draft, intent.leadCompanyId);

    const invited: string[] = [];
    for (const inviteeId of intent.inviteeCompanyIds) {
      const invitee = companyById(draft, inviteeId);
      if (invitee === null || !invitee.isActive || invitee.id === company.id) continue;
      const dealId = makeId('deal', draft.sessionId, ctx.quarter, 'consortium', opportunity.id, company.id, invitee.id);
      if (draft.deals.some((deal) => deal.id === dealId)) continue;

      const proposal: DealProposal = {
        id: dealId,
        proposerId: company.id,
        proposerKind: 'company',
        counterpartyId: invitee.id,
        counterpartyKind: 'company',
        gives: [{ kind: 'consortium_membership', opportunityId: opportunity.id }],
        gets: [{ kind: 'consortium_membership', opportunityId: opportunity.id }],
        confidentiality: 'private',
        expiresQuarter: Math.min(opportunity.closeQuarter, ctx.quarter + CONSORTIUM_OFFER_QUARTERS),
        binding: true,
        intentStatements: [
          `${lead?.name ?? intent.leadCompanyId} would be prime contractor and ${company.name} would take ${Math.round(intent.sharePct * 100)}% of the contract value.`,
        ],
        summary: line(
          `${company.name} proposes a joint bid on ${opportunity.programme} with ${lead?.name ?? intent.leadCompanyId} as prime contractor. Accepting joins the consortium for that competition.`,
        ),
        status: 'proposed',
        createdQuarter: ctx.quarter,
        respondedQuarter: null,
        conversationId: null,
        breachedByPartyId: null,
      };
      draft.deals.push(proposal);
      invited.push(invitee.id);

      emitEvent(
        draft,
        ctx,
        'deal_proposed',
        company.id,
        invitee.id,
        {
          dealId: proposal.id,
          kind: 'consortium_membership',
          opportunityId: opportunity.id,
          leadCompanyId: intent.leadCompanyId,
          sharePct: round(intent.sharePct, 4),
          expiresQuarter: proposal.expiresQuarter,
        },
        'company',
      );
    }

    if (invited.length === 0) continue;
    const eventId = emitEvent(
      draft,
      ctx,
      'information_revealed',
      company.id,
      opportunity.id,
      { kind: 'consortium_formed', programme: opportunity.programme, leadCompanyId: intent.leadCompanyId, invitedCompanyIds: invited },
      'company',
    );
    ctx.log({
      phase: 'government_resolution',
      text: line(
        `${company.name} put a consortium to ${invited.length} compan${invited.length === 1 ? 'y' : 'ies'} for ${opportunity.programme}; each has until Q${Math.min(opportunity.closeQuarter, ctx.quarter + CONSORTIUM_OFFER_QUARTERS)} to accept.`,
      ),
      deltaLabel: `${invited.length} invited`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

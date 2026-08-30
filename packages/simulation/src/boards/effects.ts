/**
 * @frontier/simulation — boards/effects.ts
 *
 * What actually changes when a board carries a matter.
 *
 * Most kinds are **authorisations**: the passed proposal is itself the record
 * that the capital, government or product phase may execute the linked action.
 * `BoardProposal.status === 'passed'` with a `linkedActionId` is the flag, which
 * is why no separate approvals collection exists in `SessionState`.
 *
 * One kind is different. `ceo_dismissal` separates two things the rest of the
 * genre conflates:
 *
 * > Being CEO and owning the company are separate states. A board can dismiss
 * > the player as chief executive; the campaign continues with the player as a
 * > 24% shareholder running a proxy campaign.
 *
 * So a dismissal clears `controllerPlayerId` — the company is now NPC-run — and
 * touches **nothing** on the cap table. The player keeps every share. That
 * separation is sacred and is asserted directly in the tests.
 */

import type { BoardProposal, BoardTally, ResolverContext, SessionState } from '@frontier/contracts';
import { rememberEvent } from '../relationships/relations';
import { boardForProposal } from './tally';
import { clamp, companyById, emitEvent, round, score100, signedScore100, unit, usdLabel } from './util';

export interface ProposalEffect {
  /** One sentence for the resolution report. */
  readonly summary: string;
  /** Ledger rows this effect emitted itself, if any. */
  readonly eventIds: string[];
  /** Machine-readable description of what changed, for the vote event payload. */
  readonly changes: Record<string, unknown>;
}

const NOTHING = (summary: string, changes: Record<string, unknown> = {}): ProposalEffect => ({ summary, eventIds: [], changes });

/* -------------------------------------------------------------------------- */
/*  Chief executive dismissal                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Remove the chief executive. Executive control moves; ownership does not.
 */
function dismissChiefExecutive(draft: SessionState, ctx: ResolverContext, proposal: BoardProposal, tally: BoardTally): ProposalEffect {
  const company = companyById(draft, proposal.companyId);
  if (company === null) return NOTHING('The company no longer exists.');

  const dismissedId = company.ceoCharacterId;
  const controllerBefore = company.controllerPlayerId;
  const board = boardForProposal(draft, proposal);

  // Executive control ends. Holdings are untouched — deliberately, and the
  // tests assert it.
  company.controllerPlayerId = null;

  // A successor from inside the company where possible, otherwise the chair.
  const successor =
    draft.characters.find((c) => c.isActive && c.companyId === company.id && c.role === 'executive' && c.id !== dismissedId) ??
    draft.characters.find((c) => c.isActive && c.companyId === company.id && c.id !== dismissedId) ??
    (board?.chairCharacterId === null || board?.chairCharacterId === undefined
      ? null
      : draft.characters.find((c) => c.id === board.chairCharacterId && c.id !== dismissedId) ?? null);
  company.ceoCharacterId = successor?.id ?? null;

  // Every seat's relationship is now with a different chief executive.
  if (board !== null) {
    for (const director of board.directors) {
      const vote = tally.perDirector.find((v) => v.directorCharacterId === director.characterId)?.vote ?? 'abstain';
      director.relationshipWithCeo = signedScore100(vote === 'support' ? 15 : vote === 'oppose' ? -10 : 0);
    }
  }

  const dismissedEventId = emitEvent(
    draft,
    ctx,
    'ceo_dismissed',
    proposal.proposedByCharacterId,
    company.id,
    {
      proposalId: proposal.id,
      dismissedCharacterId: dismissedId,
      controllerPlayerIdBefore: controllerBefore,
      controllerPlayerIdAfter: null,
      // The whole point of the separation, stated in the ledger so no consumer
      // can misread a dismissal as a confiscation.
      holdingsUnchanged: true,
      support: tally.support,
      against: tally.against,
    },
    'public',
  );

  const eventIds = [dismissedEventId];
  if (successor != null) {
    eventIds.push(
      emitEvent(
        draft,
        ctx,
        'ceo_appointed',
        proposal.proposedByCharacterId,
        company.id,
        { proposalId: proposal.id, appointedCharacterId: successor.id, interim: true },
        'public',
      ),
    );
  }

  // The dismissed chief executive remembers exactly who moved against them, and
  // a betrayal barely decays.
  if (dismissedId !== null && board !== null) {
    for (const vote of tally.perDirector) {
      if (vote.vote !== 'support') continue;
      rememberEvent(draft, ctx, {
        ownerCharacterId: dismissedId,
        aboutId: vote.directorCharacterId,
        kind: 'betrayal',
        summary: `They voted to remove me from ${company.name}.`,
        sentiment: -0.95,
        stableKey: `${proposal.id}_removed_by_${vote.directorCharacterId}`,
      });
    }
  }

  return {
    summary: `${company.name} dismissed its chief executive. Executive control passed to ${successor?.name ?? 'an interim office'}; shareholdings are untouched.`,
    eventIds,
    changes: {
      dismissedCharacterId: dismissedId,
      appointedCharacterId: successor?.id ?? null,
      controllerPlayerIdBefore: controllerBefore,
      controllerPlayerIdAfter: null,
      holdingsUnchanged: true,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Everything else                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Apply the consequences of one resolved proposal.
 *
 * Called for passed proposals, and for failed ones where failure is itself an
 * instruction — a lost continuation vote suspends the programme under review.
 */
export function applyProposalEffects(draft: SessionState, ctx: ResolverContext, proposal: BoardProposal, tally: BoardTally): ProposalEffect {
  const company = companyById(draft, proposal.companyId);
  const passed = proposal.status === 'passed';

  if (company === null) return NOTHING('The company no longer exists.');

  if (!passed) {
    if (proposal.kind === 'gov_contract' && proposal.linkedActionId !== null) {
      const contract = draft.governmentContracts.find((c) => c.id === proposal.linkedActionId);
      if (contract !== undefined && contract.status === 'active') {
        contract.status = 'suspended';
        return {
          summary: `The board refused to continue ${contract.id}; the programme is suspended pending withdrawal.`,
          eventIds: [],
          changes: { contractId: contract.id, contractStatus: 'suspended' },
        };
      }
    }
    return NOTHING('The matter failed; nothing was authorised.', { authorised: false });
  }

  switch (proposal.kind) {
    case 'ceo_dismissal':
      return dismissChiefExecutive(draft, ctx, proposal, tally);

    case 'restructuring': {
      const moraleBefore = company.employees.morale;
      company.posture = 'survival';
      company.employees.morale = score100(company.employees.morale - 12);
      company.employees.attrition = unit(company.employees.attrition + 0.03);
      company.reputation.public = score100(company.reputation.public - 2);
      return {
        summary: `${company.name} was put on a survival footing: morale ${Math.round(moraleBefore)} to ${Math.round(company.employees.morale)} and attrition up.`,
        eventIds: [],
        changes: {
          posture: 'survival',
          moraleBefore: round(moraleBefore, 2),
          moraleAfter: round(company.employees.morale, 2),
          attrition: round(company.employees.attrition, 4),
        },
      };
    }

    case 'ceo_comp': {
      const amount = proposal.amountUsd ?? 0;
      const strain = clamp(amount / Math.max(1, company.financials.payroll), 0, 2);
      const austerity = company.posture === 'survival' || company.employees.morale < 45;
      const publicHit = -(1 + 4 * strain + (austerity ? 4 : 0));
      const moraleHit = austerity ? -6 : -2 * strain;
      company.reputation.public = score100(company.reputation.public + publicHit);
      company.employees.morale = score100(company.employees.morale + moraleHit);
      return {
        summary: `The board approved a chief executive package of ${usdLabel(amount)}${austerity ? ' while the company is cutting back, which was noticed' : ''}.`,
        eventIds: [],
        changes: { amountUsd: amount, publicReputationDelta: round(publicHit, 2), moraleDelta: round(moraleHit, 2), austerity },
      };
    }

    case 'model_release': {
      const stringency = unit(0.5 * draft.world.regulation.modelRules + 0.5 * draft.world.regulation.safetyObligations);
      company.reputation.developer = score100(company.reputation.developer + 1.5);
      company.reputation.government = score100(company.reputation.government - 1.5 * stringency);
      return {
        summary: `${company.name} is cleared to release, with the safety obligations the board attached.`,
        eventIds: [],
        changes: { authorised: true, developerReputationDelta: 1.5, governmentReputationDelta: round(-1.5 * stringency, 2) },
      };
    }

    case 'csuite_appointment': {
      company.employees.morale = score100(company.employees.morale + 2);
      return {
        summary: `${company.name} filled the post the board approved.`,
        eventIds: [],
        changes: { authorised: true, moraleDelta: 2 },
      };
    }

    case 'gov_contract':
      return NOTHING(`${company.name} may accept the award, with the compliance burden the board has now formally taken on.`, {
        authorised: true,
        contractId: proposal.linkedActionId,
      });

    case 'ipo':
      return NOTHING(`${company.name} is authorised to list. The capital phase executes it when the window allows.`, {
        authorised: true,
        linkedActionId: proposal.linkedActionId,
        floatPct: proposal.dilutionPct,
      });

    case 'financing':
    case 'acquisition':
    case 'divestiture':
    case 'buyback':
    case 'annual_plan':
    default:
      return NOTHING(
        `${company.name}'s board authorised ${proposal.kind.replace(/_/g, ' ')}${proposal.amountUsd === null ? '' : ` at ${usdLabel(proposal.amountUsd)}`}.`,
        { authorised: true, linkedActionId: proposal.linkedActionId, amountUsd: proposal.amountUsd },
      );
  }
}

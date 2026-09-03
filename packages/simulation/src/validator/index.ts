/**
 * @frontier/simulation — validator
 *
 * Governance of actions. Runs server-side, always, against the canonical draft.
 *
 * The client is never authoritative. Neither is the Chief of Staff, an NPC
 * strategist, or the interface that offered the button: an action that cannot be
 * afforded, is not the actor's to take, or has not been to the board is clamped
 * or refused here regardless of what produced it. **NPCs are validated by
 * exactly this code path, with exactly these rules** — they cheat as much as
 * players do, which is to say not at all.
 *
 * The pipeline for one action:
 *
 * ```text
 * actor resolution        who is acting, for which company, as which character
 *   ↓
 * gate checks             quarter lock, control rights, chief-executive rights,
 *                         human confirmation for the always-confirm set
 *   ↓
 * type rule               one of the thirty-seven rules in rules.ts
 *   ↓
 * board matter            financing, listing, M&A, restructuring and the rest
 *                         become a submit_board_proposal instead of executing
 *   ↓
 * reservations            cash, compute, people and authorised shares are
 *                         committed against the rest of the submission
 * ```
 *
 * Nothing here mutates the draft. Validation is a read-only pass that produces
 * `ActionValidationResult`s; the resolver decides what to do with them.
 */

import type {
  ActionIntent,
  ActionType,
  ActionValidationResult,
  ActionValidator,
  SessionState,
  SubmittedAction,
} from '@frontier/contracts';
import { ActionIntentSchema, makeId, requiresExplicitConfirmation } from '@frontier/contracts';
import { BatchBudget, Verdict, findCompany, shareholderStake, type ValidationActor } from './context';
import { applyTypeRules, type RuleContext } from './rules';
import { isEliminated } from '../companies/entrants';
import { authorisedByBoard, boardMatterFor, toBoardProposalIntent } from './boardMatters';

export { BatchBudget, Verdict, canReach, researchComputeHeadroom, shareholderStake, type ValidationActor, type ReachDecision } from './context';
export { RULES, applyTypeRules, quarterlyHireCostUsd, reservableUnits, type RuleContext } from './rules';
export { availableActionsFor, availableActionTypes, type AvailabilityActor } from './availability';
export {
  BOARD_MATTER_BY_ACTION,
  BOARD_AUTHORISATION_WINDOW_QUARTERS,
  LAYOFF_BOARD_THRESHOLD_PCT,
  authorisedByBoard,
  boardMatterFor,
  toBoardProposalIntent,
  type BoardMatter,
} from './boardMatters';
// Only the validator's own balancing constants are re-exported. The
// compensation and compute figures in `./balance` deliberately restate
// `companies/balance.ts`, and re-exporting them here would make the package
// index ambiguous about which definition it means.
export {
  HIRING_CASH_COVER_QUARTERS,
  RESERVABLE_SHARE_OF_INSTALLED_BASE,
  MIN_RESERVABLE_UNITS,
  MAX_ROUND_DILUTION_PCT,
  MAX_IPO_FLOAT_PCT,
  MIN_IPO_FLOAT_PCT,
  BOARD_GOV_CONTRACT_REVENUE_MULTIPLE,
  BOARD_GOV_CONTRACT_FLOOR_USD,
  MIN_INTRODUCTION_PURPOSE_CHARS,
} from './balance';

/**
 * What a player who no longer directs their company may still do with it.
 *
 * Being chief executive and owning the company are separate states, and a
 * dismissal ends only the first. A founder who was voted out keeps every share,
 * and a shareholder of that size is not a spectator: they can trade, deal, speak
 * publicly, ask for an introduction, and — the route back — requisition a matter
 * for the board that removed them. Everything else needs the office.
 *
 * Ownership is the gate rather than the seat, so this is symmetrical: any player
 * holding a qualifying stake in a company they do not direct has the same
 * surface, and a player holding nothing has none of it.
 */
export const SHAREHOLDER_CAPACITY_ACTIONS: readonly ActionType[] = [
  'buy_shares',
  'sell_shares',
  'propose_deal',
  'accept_deal',
  'reject_deal',
  'social_post',
  'request_introduction',
  'submit_board_proposal',
];

/**
 * Ownership at which a shareholder may act in their own name against a company
 * they do not direct. Five per cent is the disclosure line the ownership
 * thresholds already use: below it a holder is anonymous, above it they are a
 * party the company has to deal with.
 */
export const SHAREHOLDER_ACTION_THRESHOLD = 0.05;

/**
 * Actions only the chief executive may take on a company's behalf.
 *
 * Governance and the company's public voice belong to the office, not to
 * whoever happens to be directing operations. A company with a vacant chief
 * executive seat (`ceoCharacterId === null`) is run by its controller, so the
 * gate does not apply — otherwise dismissing a chief executive would freeze the
 * company rather than change who runs it.
 */
export const CEO_ONLY_ACTIONS: readonly ActionType[] = [
  'submit_board_proposal',
  'lobby_director',
  'appoint_executive',
  'raise_round',
  'issue_debt',
  'issue_shares',
  'buyback',
  'ipo',
  'acquire_company',
  'meet_regulator',
  'give_guidance',
  'respond_crisis',
];

/* -------------------------------------------------------------------------- */
/*  One action                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate one action against a draft, with an explicit actor and an explicit
 * budget. This is the function `validate` and `validateBatch` both run; it is
 * exported so tests and tools can drive it directly.
 */
export function validateAction(
  draft: SessionState,
  intent: ActionIntent,
  actor: ValidationActor,
  budget: BatchBudget,
  actionId: string,
  submittedForQuarter: number = draft.quarter,
): ActionValidationResult {
  const verdict = new Verdict<ActionIntent>(intent);

  /* --- the intent has to be an intent ------------------------------------ */
  // CLAUDE.md rule 3: every proposal is zod-validated before the engine touches
  // it. TypeScript cannot enforce that at the process boundary — an action can
  // arrive from a client, a saved game or a model — so an instruction whose
  // shape or enum value is out of contract is refused here, where a refusal is
  // an ordinary verdict, rather than thrown out of a phase that indexed it.
  const parsed = ActionIntentSchema.safeParse(intent);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    verdict.reject(
      'illegal_value',
      `The instruction is not a well-formed ${typeof (intent as { type?: unknown })?.type === 'string' ? String((intent as { type: string }).type).replace(/_/g, ' ') : 'action'}: ${
        issue === undefined ? 'it does not match any action in the contract' : `${issue.path.join('.') || 'intent'} — ${issue.message}`
      }.`,
    );
    return verdict.toResult(actionId);
  }

  /* --- the quarter has to be the open one -------------------------------- */
  if (submittedForQuarter !== draft.quarter) {
    verdict.reject(
      'quarter_already_locked',
      `Submitted for quarter ${submittedForQuarter}; quarter ${draft.quarter} is the one open for planning.`,
    );
    return verdict.toResult(actionId);
  }
  if (draft.lastResolvedQuarter !== null && draft.lastResolvedQuarter >= draft.quarter) {
    verdict.reject('quarter_already_locked', `Quarter ${draft.quarter} has already resolved.`);
    return verdict.toResult(actionId);
  }

  /* --- the actor has to exist and have the right to act ------------------ */
  const company = findCompany(draft, actor.companyId);
  if (company === null) {
    verdict.reject('unknown_target', `No company "${actor.companyId}" exists in this session.`);
    return verdict.toResult(actionId);
  }
  if (!company.isActive) {
    verdict.reject('requirement_not_met', `${company.name} is no longer an operating company.`);
    return verdict.toResult(actionId);
  }
  // A seat whose company was wound up is out of the game. The husk stays on the
  // register and can still be bought — by somebody else. Nothing this seat
  // submits is executed again, in any capacity.
  if (actor.playerId !== null) {
    const seat = draft.players.find((player) => player.playerId === actor.playerId) ?? null;
    if (seat !== null && isEliminated(seat)) {
      const seatCompany = findCompany(draft, seat.companyId);
      verdict.reject('requirement_not_met', `${seatCompany?.name ?? seat.companyId} is in administration; the seat is closed.`);
      return verdict.toResult(actionId);
    }
  }
  let shareholderCapacity = false;
  if (actor.playerId !== null && company.controllerPlayerId !== actor.playerId) {
    if (!SHAREHOLDER_CAPACITY_ACTIONS.includes(intent.type)) {
      verdict.reject(
        'not_controller_of_company',
        `${actor.playerId} does not direct ${company.name}. As a shareholder they may still ${SHAREHOLDER_CAPACITY_ACTIONS.join(', ').replace(/_/g, ' ')}.`,
      );
      return verdict.toResult(actionId);
    }
    const stake = shareholderStake(draft, company.id, actor);
    if (stake < SHAREHOLDER_ACTION_THRESHOLD) {
      verdict.reject(
        'not_controller_of_company',
        `${actor.playerId} does not direct ${company.name} and holds ${(stake * 100).toFixed(1)}% of it; acting as a shareholder needs ${Math.round(
          SHAREHOLDER_ACTION_THRESHOLD * 100,
        )}%.`,
      );
      return verdict.toResult(actionId);
    }
    shareholderCapacity = true;
    verdict.note(
      'requirement_not_met',
      `${company.name} is not directed by ${actor.playerId}; this is taken in their own name as a ${(stake * 100).toFixed(1)}% shareholder.`,
    );
  }
  if (actor.playerId === null && company.controllerPlayerId !== null) {
    verdict.reject('not_controller_of_company', `${company.name} is directed by a player; an unattributed action cannot act for it.`);
    return verdict.toResult(actionId);
  }

  /* --- always-confirm actions need a human behind them ------------------- */
  if (actor.playerId !== null && requiresExplicitConfirmation(intent.type) && !actor.confirmedByHuman) {
    verdict.reject(
      'confirmation_required',
      `${intent.type.replace(/_/g, ' ')} always requires explicit human confirmation, whatever the auto-execute preference says.`,
    );
    return verdict.toResult(actionId);
  }

  /* --- some things only the chief executive may do ----------------------- */
  // A shareholder acting in their own name is not claiming the office: their
  // one governance action is to put a matter to the board, which is precisely
  // what a shareholder requisition is.
  if (
    !shareholderCapacity &&
    CEO_ONLY_ACTIONS.includes(intent.type) &&
    company.ceoCharacterId !== null &&
    actor.characterId !== null &&
    actor.characterId !== company.ceoCharacterId
  ) {
    verdict.reject(
      'not_controller_of_company',
      `Only the chief executive of ${company.name} may take that action, and that is not ${actor.characterId}.`,
    );
    return verdict.toResult(actionId);
  }

  /* --- the type rule ------------------------------------------------------ */
  const reservations: (() => void)[] = [];
  const ruleContext: RuleContext = {
    draft,
    actor,
    company,
    character: draft.characters.find((c) => c.id === actor.characterId) ?? null,
    budget,
    reservations,
  };
  applyTypeRules(intent, verdict, ruleContext);
  if (verdict.isRejected) return verdict.toResult(actionId);

  /* --- board matters become proposals rather than executing --------------- */
  const matter = company.boardId === null ? null : boardMatterFor(verdict.current, company);
  if (matter !== null && !authorisedByBoard(draft, company.id, matter.kind)) {
    verdict.replaceWith(
      toBoardProposalIntent(matter),
      'board_approval_required',
      `${intent.type.replace(/_/g, ' ')} is a ${matter.kind.replace(/_/g, ' ')} matter for the board of ${company.name}. It has been tabled as a proposal instead; win the vote and it executes.`,
    );
    // The proposal spends nothing this quarter, so the action's reservations
    // are discarded rather than applied.
    return verdict.toResult(actionId);
  }

  for (const reserve of reservations) reserve();
  return verdict.toResult(actionId);
}

/* -------------------------------------------------------------------------- */
/*  The validator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the action validator.
 *
 * Stateless between calls: every budget lives for exactly one `validateBatch`,
 * so validating the same submission twice gives the same answer.
 */
export function createActionValidator(): ActionValidator {
  return {
    /**
     * Validate one intent on behalf of a player.
     *
     * The acting company and character are resolved from the player's seat,
     * because `ActionIntent` deliberately carries neither. With no player there
     * is no seat and therefore no attributable actor: the action is refused
     * rather than guessed at. NPC actions reach the engine as
     * `SubmittedAction`s inside `validateBatch`, which is where their company
     * comes from.
     *
     * Human confirmation is assumed here so that the substantive verdict is
     * reported: this entry point exists to answer "would this work?" for a
     * client, and the confirmation gate is enforced for real in `validateBatch`,
     * against the submitted action's own `confirmedByHuman` flag.
     */
    validate(draft: SessionState, action: ActionIntent, actorPlayerId: string | null): ActionValidationResult {
      const actionId = makeId('act', 'preview', action.type);
      const seat = actorPlayerId === null ? undefined : draft.players.find((player) => player.playerId === actorPlayerId);
      if (actorPlayerId === null || seat === undefined) {
        const verdict = new Verdict<ActionIntent>(action);
        verdict.reject(
          'not_controller_of_company',
          actorPlayerId === null
            ? 'An action intent carries no company; validate it through a submitted action so the acting company is attributable.'
            : `No player "${actorPlayerId}" holds a seat in this session.`,
        );
        return verdict.toResult(actionId);
      }
      return validateAction(
        draft,
        action,
        { playerId: seat.playerId, companyId: seat.companyId, characterId: seat.characterId, confirmedByHuman: true },
        new BatchBudget(),
        actionId,
      );
    },

    /**
     * Validate a whole submission.
     *
     * Actions are *processed* in `(sequence, actionId)` order so that two
     * actions competing for the same cash resolve deterministically — the
     * earlier one wins the dollar — and *returned* in the caller's order so a
     * result can be matched to its action by index.
     */
    validateBatch(draft: SessionState, actions: readonly SubmittedAction[]): ActionValidationResult[] {
      const budget = new BatchBudget();
      const order = actions
        .map((action, index) => ({ action, index }))
        .sort((a, b) =>
          a.action.sequence !== b.action.sequence
            ? a.action.sequence - b.action.sequence
            : a.action.actionId < b.action.actionId
              ? -1
              : a.action.actionId > b.action.actionId
                ? 1
                : a.index - b.index,
        );

      const results = new Array<ActionValidationResult>(actions.length);
      const seenActionIds = new Set<string>();

      for (const { action, index } of order) {
        if (seenActionIds.has(action.actionId)) {
          const verdict = new Verdict<ActionIntent>(action.intent);
          verdict.reject('duplicate_action', `Action ${action.actionId} was submitted twice in one batch.`);
          results[index] = verdict.toResult(action.actionId);
          continue;
        }
        seenActionIds.add(action.actionId);

        const actor: ValidationActor = {
          playerId: action.actorPlayerId,
          companyId: action.actorCompanyId,
          characterId: action.actorCharacterId,
          confirmedByHuman: action.confirmedByHuman,
        };
        results[index] = validateAction(draft, action.intent, actor, budget, action.actionId, action.quarter);
      }

      // Every slot is written above; the fallback keeps the array total for the
      // compiler under noUncheckedIndexedAccess without changing behaviour.
      return results.map(
        (result, index) =>
          result ?? {
            actionId: actions[index]?.actionId ?? makeId('act', 'unknown', index),
            status: 'rejected' as const,
            reasons: ['The action was not validated.'],
            codes: ['illegal_value' as const],
            clampedAction: null,
          },
      );
    },
  };
}

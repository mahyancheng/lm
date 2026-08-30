/**
 * @frontier/simulation — resolver/actions.ts
 *
 * Action collection: the fourth phase, and the one place a decision becomes an
 * instruction the rest of the pipeline will execute.
 *
 * Three things happen here and nothing else does:
 *
 * 1. **NPC bundles become submitted actions.** An `NpcActionBundle` names a
 *    company and carries up to eight intents; each becomes a `SubmittedAction`
 *    with a deterministic id, attributed to that company's chief executive.
 * 2. **Everything is validated by the same validator.** Player submissions and
 *    NPC bundles go through one code path with one set of rules. An NPC that
 *    cannot afford a reservation gets it clamped exactly as a player would.
 * 3. **`pendingActions` is reduced to what will actually run.** Rejected actions
 *    are dropped; clamped actions are rewritten to their clamped form. Every
 *    later phase reads `pendingActions` and can therefore assume that anything
 *    still there is meant to happen — which is the contract the subsystem
 *    authors coded against.
 */

import type {
  ActionIntent,
  ActionValidationResult,
  ActionValidator,
  NpcActionBundle,
  ResolverContext,
  SessionState,
  SubmittedAction,
} from '@frontier/contracts';
import { makeId } from '@frontier/contracts';

/** One action and what validation decided about it. */
export interface ReviewedAction {
  readonly action: SubmittedAction;
  readonly result: ActionValidationResult;
  /** The action as it will run, with any clamp applied. Null when rejected. */
  readonly effective: SubmittedAction | null;
}

/* -------------------------------------------------------------------------- */
/*  Collection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything queued for this quarter, in one deterministic order.
 *
 * Player submissions keep the sequence numbers they were given. NPC actions are
 * appended after them, ordered by company id and then by their position in the
 * bundle, so a replay assigns the same sequence to the same intent.
 */
export function collectActions(
  draft: SessionState,
  submitted: readonly SubmittedAction[],
  npcBundles: readonly NpcActionBundle[],
): SubmittedAction[] {
  const own = submitted
    .filter((action) => action.quarter === draft.quarter && action.sessionId === draft.sessionId)
    .slice()
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : compare(a.actionId, b.actionId)));

  let sequence = own.reduce((max, action) => Math.max(max, action.sequence + 1), 0);
  const npc: SubmittedAction[] = [];

  const bundles = [...npcBundles].sort((a, b) => compare(a.companyId, b.companyId));
  for (const bundle of bundles) {
    const company = draft.companies.find((candidate) => candidate.id === bundle.companyId) ?? null;
    const characterId =
      company?.ceoCharacterId ??
      draft.characters.find((character) => character.companyId === bundle.companyId)?.id ??
      makeId('chr', 'unassigned', bundle.companyId);

    for (let index = 0; index < bundle.actions.length; index += 1) {
      const intent = bundle.actions[index];
      if (intent === undefined) continue;
      npc.push({
        actionId: makeId('act', draft.sessionId, draft.quarter, `npc_${bundle.companyId}_${index}`),
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        sequence,
        actorPlayerId: null,
        actorCompanyId: bundle.companyId,
        actorCharacterId: characterId,
        origin: 'npc_strategist',
        intent,
        // No human approved an NPC's action, and none is required: the
        // confirmation gate protects a human from their own automation.
        confirmedByHuman: false,
      });
      sequence += 1;
    }
  }

  return [...own, ...npc];
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate the quarter's actions and write the surviving set into
 * `draft.pendingActions`.
 *
 * Emits one ledger row per action carrying its outcome, and a report line for
 * everything that was refused or reduced — a player is entitled to know what the
 * engine did with their instruction and why, in the same screen that tells them
 * what happened to the world.
 */
export function reviewActions(
  draft: SessionState,
  validator: ActionValidator,
  actions: readonly SubmittedAction[],
  ctx: ResolverContext,
): ReviewedAction[] {
  const results = validator.validateBatch(draft, actions);
  const reviewed: ReviewedAction[] = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const result = results[index];
    if (action === undefined || result === undefined) continue;

    const effective =
      result.status === 'rejected'
        ? null
        : result.status === 'clamped' && result.clampedAction !== null
          ? { ...action, intent: result.clampedAction }
          : action;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: result.status === 'accepted' ? 'action_accepted' : result.status === 'clamped' ? 'action_clamped' : 'action_rejected',
      actorId: action.actorCompanyId,
      targetId: action.actionId,
      payload: {
        intentType: action.intent.type,
        origin: action.origin,
        status: result.status,
        codes: result.codes,
        reasons: result.reasons,
        actorCharacterId: action.actorCharacterId,
        actorPlayerId: action.actorPlayerId,
        clampedTo: result.clampedAction === null ? null : summariseIntent(result.clampedAction),
      },
      visibility: 'company',
    });

    if (result.status !== 'accepted') {
      ctx.log({
        phase: 'action_collection',
        text: `${labelFor(action.intent)} ${result.status === 'clamped' ? 'was reduced' : 'was refused'}: ${result.reasons[0] ?? 'no reason recorded'}`,
        deltaLabel: result.status === 'clamped' ? 'clamped' : 'rejected',
        refEventIds: [eventId],
        tone: result.status === 'clamped' ? 'warning' : 'negative',
        subjectId: action.actorCompanyId,
      });
    }

    reviewed.push({ action, result, effective });
  }

  draft.pendingActions = reviewed
    .map((entry) => entry.effective)
    .filter((action): action is SubmittedAction => action !== null);

  return reviewed;
}

/* -------------------------------------------------------------------------- */
/*  Reading the surviving set                                                  */
/* -------------------------------------------------------------------------- */

/** Actions of one type queued for this quarter, in submission order. */
export function pendingOfType<T extends ActionIntent['type']>(
  draft: SessionState,
  type: T,
): { action: SubmittedAction; intent: Extract<ActionIntent, { type: T }> }[] {
  const out: { action: SubmittedAction; intent: Extract<ActionIntent, { type: T }> }[] = [];
  const ordered = draft.pendingActions
    .filter((action) => action.quarter === draft.quarter)
    .slice()
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : compare(a.actionId, b.actionId)));
  for (const action of ordered) {
    if (action.intent.type === type) {
      out.push({ action, intent: action.intent as Extract<ActionIntent, { type: T }> });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Description                                                                */
/* -------------------------------------------------------------------------- */

/** A short human label for an intent, for report lines. */
export function labelFor(intent: ActionIntent): string {
  switch (intent.type) {
    case 'hire':
      return `Hiring ${intent.count} ${intent.role}`;
    case 'layoff':
      return `Cutting ${intent.count} ${intent.role}`;
    case 'raise_round':
      return `A ${intent.stage.replace(/_/g, ' ')} raise`;
    case 'issue_debt':
      return 'A debt issue';
    case 'acquire_company':
      return `An offer for ${intent.targetCompanyId}`;
    case 'bid_government':
      return `A bid on ${intent.opportunityId}`;
    case 'buy_shares':
      return `A purchase of ${intent.securityId}`;
    case 'sell_shares':
      return `A sale of ${intent.securityId}`;
    case 'reserve_compute':
      return `A reservation of ${intent.units} accelerators`;
    case 'start_research_project':
      return `A programme against ${intent.targetNodeId}`;
    case 'submit_board_proposal':
      return `The board matter "${intent.title}"`;
    case 'launch_product':
      return `The launch of ${intent.name}`;
    default:
      return `The instruction "${intent.type.replace(/_/g, ' ')}"`;
  }
}

/** Compact payload description of an intent, for the ledger. */
export function summariseIntent(intent: ActionIntent): Record<string, unknown> {
  const summary: Record<string, unknown> = { type: intent.type };
  for (const [key, value] of Object.entries(intent)) {
    if (key === 'type') continue;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) summary[key] = value;
    else if (typeof value === 'string') summary[key] = value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return summary;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

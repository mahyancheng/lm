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
 *    The name is *checked*, not trusted: the `companyId` on a bundle is a field
 *    a model wrote, so a bundle is refused unless it names the company the
 *    strategist was asked to plan for, that company exists, is active, and is
 *    nobody's player company. A strategist that sees one company's private
 *    position cannot spend another company's balance sheet.
 * 2. **Everything is validated by the same validator.** Player submissions and
 *    NPC bundles go through one code path with one set of rules. An NPC that
 *    cannot afford a reservation gets it clamped exactly as a player would. An
 *    intent whose shape is out of contract never reaches the rules at all: it is
 *    refused at the boundary, because a subsystem indexing a table by an enum
 *    value that does not exist is a crash, not a decision.
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
import { ActionIntentSchema, makeId } from '@frontier/contracts';
import { CEO_ONLY_ACTIONS } from '../validator';
import { rememberEvent } from '../relationships/relations';

/** One action and what validation decided about it. */
export interface ReviewedAction {
  readonly action: SubmittedAction;
  readonly result: ActionValidationResult;
  /** The action as it will run, with any clamp applied. Null when rejected. */
  readonly effective: SubmittedAction | null;
}

/**
 * A bundle together with the company its strategist was asked to plan for.
 *
 * The engine cannot infer this: `NpcActionBundle.companyId` is model output, and
 * a field that says which company it is about is worth nothing when the question
 * is whether the model wrote the right company there. A caller that knows which
 * company it asked about says so here, and the bundle is refused if the two
 * disagree.
 */
export interface NpcBundleSubmission {
  readonly requestedCompanyId: string;
  readonly bundle: NpcActionBundle;
}

/** A bundle, with or without the request it answers. */
export type NpcBundleInput = NpcActionBundle | NpcBundleSubmission;

/** Why a bundle was refused before any of its actions existed. */
export type NpcBundleRefusal = 'company_mismatch' | 'unknown_company' | 'not_npc_controlled' | 'duplicate_bundle';

const asSubmission = (input: NpcBundleInput): NpcBundleSubmission =>
  'bundle' in input ? input : { requestedCompanyId: input.companyId, bundle: input };

/* -------------------------------------------------------------------------- */
/*  Collection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything queued for this quarter, in one deterministic order.
 *
 * Player submissions keep the sequence numbers they were given. NPC actions are
 * appended after them, ordered by company id and then by their position in the
 * bundle, so a replay assigns the same sequence to the same intent.
 *
 * Bundles that fail the identity check contribute nothing and, where a context
 * is supplied, leave a private `action_rejected` row behind them: a strategist
 * writing another company's id is an agent-containment event, and the ledger is
 * where containment is recorded.
 */
export function collectActions(
  draft: SessionState,
  submitted: readonly SubmittedAction[],
  npcBundles: readonly NpcBundleInput[],
  ctx?: ResolverContext,
): SubmittedAction[] {
  const own = submitted
    .filter((action) => action.quarter === draft.quarter && action.sessionId === draft.sessionId)
    .slice()
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : compare(a.actionId, b.actionId)));

  let sequence = own.reduce((max, action) => Math.max(max, action.sequence + 1), 0);
  const npc: SubmittedAction[] = [];

  // Sorted by the company named, then by arrival, so a replay orders identical
  // input identically even when two bundles name the same company.
  const bundles = [...npcBundles]
    .map((input, arrival) => ({ ...asSubmission(input), arrival }))
    .sort((a, b) => (a.bundle.companyId !== b.bundle.companyId ? compare(a.bundle.companyId, b.bundle.companyId) : a.arrival - b.arrival));

  const honoured = new Set<string>();
  for (const { requestedCompanyId, bundle } of bundles) {
    const company = draft.companies.find((candidate) => candidate.id === bundle.companyId) ?? null;
    const refuse = (code: NpcBundleRefusal): void => refuseBundle(draft, ctx, requestedCompanyId, bundle, code);

    // The strategist wrote a company it was not asked about. This is the one
    // that matters: its prompt held that company's private position.
    if (bundle.companyId !== requestedCompanyId) {
      refuse('company_mismatch');
      continue;
    }
    if (company === null) {
      refuse('unknown_company');
      continue;
    }
    // A company somebody is directing is not an agent's to run, and neither is
    // one that has been acquired or wound up.
    if (!company.isActive || company.controllerPlayerId !== null) {
      refuse('not_npc_controlled');
      continue;
    }
    // Two bundles for one company would mint the same action ids twice and the
    // second set would be dropped as duplicates, silently deleting the first.
    if (honoured.has(bundle.companyId)) {
      refuse('duplicate_bundle');
      continue;
    }
    honoured.add(bundle.companyId);

    const characterId =
      company.ceoCharacterId ??
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

/** Record a refused bundle. Silent when no context is available. */
function refuseBundle(
  draft: SessionState,
  ctx: ResolverContext | undefined,
  requestedCompanyId: string,
  bundle: NpcActionBundle,
  refusal: NpcBundleRefusal,
): void {
  if (ctx === undefined) return;
  ctx.emit({
    sessionId: draft.sessionId,
    quarter: ctx.quarter,
    type: 'action_rejected',
    // Deliberately unattributed. Naming the companies on the row would make it
    // readable by whichever of them the projection thinks it belongs to, and
    // "a rival's strategist tried to spend your balance sheet" is not a fact
    // this game hands anybody for free. Both ids are in the payload, which is
    // private, and the row is engine business.
    actorId: null,
    targetId: null,
    payload: {
      origin: 'npc_strategist',
      scope: 'bundle',
      code: refusal,
      requestedCompanyId,
      claimedCompanyId: bundle.companyId,
      actionsDropped: bundle.actions.length,
    },
    visibility: 'private',
  });
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
 *
 * Every intent is re-parsed against `ActionIntentSchema` first. TypeScript
 * cannot vouch for an action that arrived from a browser, a saved game or a
 * model, and the rules downstream index tables by enum values: an intent whose
 * shape is out of contract is refused here as `illegal_value`, so a malformed
 * instruction costs its author a rejection rather than costing the session its
 * quarter. That is the boundary CLAUDE.md rule 3 describes.
 */
export function reviewActions(
  draft: SessionState,
  validator: ActionValidator,
  actions: readonly SubmittedAction[],
  ctx: ResolverContext,
): ReviewedAction[] {
  // The schema gate runs before the rules, and the rules never see what it
  // refused — a rule reading an out-of-contract intent is the crash we are
  // preventing, not the check that catches it. Order is preserved on both sides
  // so that two submissions sharing an id still get their own verdicts.
  const wellFormed = actions.map((action) => ActionIntentSchema.safeParse(action.intent).success);
  const validated = validator.validateBatch(
    draft,
    actions.filter((_, index) => wellFormed[index] === true),
  );
  const reviewed: ReviewedAction[] = [];
  let cursor = 0;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action === undefined) continue;
    let result: ActionValidationResult;
    if (wellFormed[index] === true) {
      result = validated[cursor] ?? malformed(action);
      cursor += 1;
    } else {
      result = malformed(action);
    }

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

    if (effective !== null) noteSubsidiaryOverrule(draft, ctx, effective);
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
    case 'buy_accelerators':
      return `A purchase of ${intent.units} accelerators${intent.sellerCompanyId === null ? '' : ` from ${intent.sellerCompanyId}`}`;
    case 'invest_capacity':
      return `A ${intent.kind} capacity investment`;
    case 'set_supply_terms':
      return `Publishing ${intent.productId} as a supply line`;
    case 'choose_supplier':
      return `Choosing a supplier for ${intent.productId}`;
    case 'start_research_project':
      return `A programme against ${intent.targetNodeId}`;
    case 'submit_board_proposal':
      return `The board matter "${intent.title}"`;
    case 'launch_product':
      return `The launch of ${intent.name}`;
    default: {
      // Defensive: this also labels an intent the schema gate refused, whose
      // `type` is whatever the sender wrote rather than a member of the union.
      const type: unknown = intent.type;
      return `The instruction "${typeof type === 'string' && type.length > 0 ? type.replace(/_/g, ' ') : 'unrecognised'}"`;
    }
  }
}

/**
 * The verdict for an instruction whose shape is not in the contract.
 *
 * Refused, not repaired: the engine has no way to know what a malformed
 * instruction meant, and guessing is how a client becomes authoritative.
 */
function malformed(action: SubmittedAction): ActionValidationResult {
  return {
    actionId: action.actionId,
    status: 'rejected',
    reasons: ['This instruction does not match any action in the contract, so the engine refused it rather than acting on a shape it cannot read.'],
    codes: ['illegal_value'],
    clampedAction: null,
  };
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

/**
 * A controller directing a subsidiary through a `CEO_ONLY_ACTIONS` instruction
 * their own character does not hold the office for is overruling whoever does
 * (`validator/index.ts` is where that is let through, deliberately, for
 * exactly this case). The incumbent CEO is not consulted; this is the record
 * of what that costs the relationship.
 *
 * At most one memory per subsidiary per quarter, however many such actions
 * land on it that quarter — the stable key collapses repeats, so directing a
 * subsidiary's whole plan in one sitting reads as one event, not eight.
 */
function noteSubsidiaryOverrule(draft: SessionState, ctx: ResolverContext, action: SubmittedAction): void {
  if (!CEO_ONLY_ACTIONS.includes(action.intent.type)) return;
  const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
  if (company === undefined || company.parentCompanyId === null || company.ceoCharacterId === null) return;
  if (company.controllerPlayerId !== action.actorPlayerId) return;
  if (action.actorCharacterId === company.ceoCharacterId) return;

  rememberEvent(draft, ctx, {
    ownerCharacterId: company.ceoCharacterId,
    aboutId: action.actorCharacterId,
    kind: 'personal',
    summary: `The parent company directed ${company.name} over my head again this quarter.`,
    sentiment: -0.4,
    stableKey: `overruled_${company.id}_${draft.quarter}`,
  });
}

/**
 * @frontier/simulation — companies/control.ts
 *
 * STAGE 4: who directs which company.
 *
 * `Company.controllerPlayerId` is the single source of truth for "who may
 * submit actions on this company's behalf" — the validator already keys on it
 * (`validator/index.ts`). This module is the derived read
 * (`controlledCompaniesOf`) and the one resolution pass that keeps it current
 * when control changes hands *without* a formal `acquire_company` offer: a
 * holder quietly crossing 50%+1 through `buy_shares`, a PE tender, an
 * activist campaign that wins control, or a funding round's term sheet
 * closing a majority stake. A subsidiary created by an acquisition sets
 * `controllerPlayerId` directly at the point of acquisition
 * (`resolver/capital.ts`); it never depends on this pass.
 *
 * A founding company — `SessionPlayer.companyId` — is deliberately exempt
 * from `resolveControlChanges`. Two reasons, not one:
 *
 * 1. A founder's own stake in their own company dips below 50%+1 through
 *    perfectly ordinary play (an IPO, a primary round, a dilutive stock
 *    acquisition) long before anyone else crosses it. Running this pass over
 *    founding companies would silently null out `controllerPlayerId` on a
 *    founder's own business the first time they raised capital, which is not
 *    what "losing the majority hands control back to incumbent management"
 *    is for.
 * 2. `playerCompanyOf`, elimination and the founder-wealth board all anchor
 *    on the founding company by id, not by who is decisive in its cap table.
 *    That anchor has to stay put for those to keep meaning what they say.
 *
 * A rival accumulating shares in a player's founding company still moves the
 * board-vote tally (`boards/tally.ts` already reads the decisive holder for
 * that) and still shows up as a stake on the portfolio screen; it just never
 * reassigns who submits that company's actions.
 */

import type { Company, ResolverContext, SessionState } from '@frontier/contracts';
import { isMultiSectorWorld } from '../economy/sectors';
import { controllingHolderId } from '../boards/tally';
import { emitEvent } from './util';

/* -------------------------------------------------------------------------- */
/*  Derived: what one seat controls                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every active company one seat directs, founding company first, then by
 * acquisition quarter (a majority stake with no acquisition record sorts by
 * `foundedQuarter` instead, since it was never bought outright).
 *
 * Derived, never stored: the only state this reads is `Company.controllerPlayerId`
 * and `SessionPlayer.companyId`.
 */
export function controlledCompaniesOf(session: SessionState, playerId: string): Company[] {
  const seat = session.players.find((player) => player.playerId === playerId) ?? null;
  const foundingId = seat?.companyId ?? null;

  const controlled = session.companies.filter((company) => company.isActive && company.controllerPlayerId === playerId);
  // controllerPlayerId is set on the founding company at creation, so it is
  // normally already in `controlled` — but a defensive union keeps this
  // correct even for a save where that has drifted, rather than silently
  // dropping the seat's own company from its own list.
  const founding = foundingId === null ? null : session.companies.find((company) => company.id === foundingId && company.isActive) ?? null;
  const byId = new Map<string, Company>();
  if (founding !== null) byId.set(founding.id, founding);
  for (const company of controlled) byId.set(company.id, company);

  return [...byId.values()].sort((a, b) => {
    if (a.id === foundingId) return -1;
    if (b.id === foundingId) return 1;
    const aq = a.acquisition?.quarter ?? a.foundedQuarter;
    const bq = b.acquisition?.quarter ?? b.foundedQuarter;
    if (aq !== bq) return aq - bq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/*  Resolution: majority control without a formal offer                       */
/* -------------------------------------------------------------------------- */

/** The player a cap-table holder maps to, or null for a fund, a character, or an NPC company. */
function controllerPlayerFor(draft: SessionState, holderId: string): string | null {
  const asPlayer = draft.players.find((player) => player.playerId === holderId);
  if (asPlayer !== undefined) return asPlayer.playerId;
  const asCompany = draft.companies.find((company) => company.id === holderId);
  if (asCompany !== undefined) return asCompany.controllerPlayerId;
  return null;
}

/**
 * Keep `controllerPlayerId` current with the decisive holder of each
 * non-founding company's cap table.
 *
 * Run once, late in the quarter — after `buy_shares`/`sell_shares` clear in
 * `market_resolution`, and after everything that can close a majority stake
 * in `capital_resolution` (a term sheet, an acquisition's stock consideration,
 * a PE tender or LBO, an activist campaign that wins control) has already
 * run. World version 1 never calls this; a world-1 acquisition still absorbs
 * outright and there is no "majority stake short of a full buy" concept for
 * it to notice.
 */
export function resolveControlChanges(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;
  const foundingIds = new Set(draft.players.map((player) => player.companyId));

  for (const company of draft.companies) {
    if (!company.isActive || foundingIds.has(company.id)) continue;

    const holderId = controllingHolderId(draft, company.id);
    const next = holderId === null ? null : controllerPlayerFor(draft, holderId);
    if (next === company.controllerPlayerId) continue;

    const from = company.controllerPlayerId;
    company.controllerPlayerId = next;

    const eventId = emitEvent(
      draft,
      ctx,
      'control_changed',
      company.id,
      next,
      { fromController: from, toController: next, holderId },
      'company',
    );
    ctx.log({
      phase: 'market_resolution',
      text:
        next === null
          ? `Nobody holds a decisive stake in ${company.name} any more; it reverts to incumbent management.`
          : `A holder crossed a decisive stake in ${company.name}; it is now directed by ${next}.`,
      deltaLabel: next === null ? 'control lost' : 'control gained',
      refEventIds: [eventId],
      tone: next === null ? 'warning' : 'neutral',
      subjectId: company.id,
    });
  }

  syncSubsidiaryPostures(draft);
}

/**
 * A live subsidiary whose parent is itself NPC-run takes its posture from the
 * parent every quarter, rather than developing one independently.
 *
 * This is the scoped approximation of "an NPC acquirer's subsidiary is
 * directed by the NPC strategist of the parent, with the parent's posture":
 * `strategistCompanyIds`/`applyNpcDefaults` already give the subsidiary its
 * own archetype planning once its `controllerPlayerId` is null (the same
 * eligibility every other non-player company gets), and syncing posture here
 * is what makes that planning follow the parent's stance without a live
 * strategist call per subsidiary. A subsidiary of a *player*-controlled
 * parent is untouched — its posture is the player's own decision.
 */
function syncSubsidiaryPostures(draft: SessionState): void {
  for (const company of draft.companies) {
    if (!company.isActive || company.parentCompanyId === null || company.controllerPlayerId !== null) continue;
    const parent = draft.companies.find((candidate) => candidate.id === company.parentCompanyId) ?? null;
    if (parent === null || !parent.isActive || parent.controllerPlayerId !== null) continue;
    company.posture = parent.posture;
  }
}

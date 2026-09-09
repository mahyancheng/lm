/**
 * @frontier/simulation — companies/partialFill.ts
 *
 * The one row a shortfall writes.
 *
 * From world version 2 an instruction is never silently cut. When a phase can
 * give less than was asked — the talent market filled six of forty, the fabs
 * could ship two hundred of a thousand, the float held nine thousand of the
 * fifty thousand shares somebody wanted — the difference is *stated*: a ledger
 * row carrying `{asked, got, reason}` and a report line in plain words.
 *
 * It is a `kind` on `information_revealed` rather than a new member of
 * `SIM_EVENT_TYPES`. That enum reaches the model through
 * `SimEventTypeSchema`, and the financial reconstruction in
 * `resolver/invariants.ts` treats any row carrying a `kind` as a staging row
 * that books nothing — which is exactly what this is. A shortfall moves no
 * money on its own; the money moved is booked by whatever did fill.
 */

import type { ResolutionPhase, ResolverContext, SessionState } from '@frontier/contracts';
import { emitEvent } from './util';

/** What a phase gave against what it was asked for. */
export interface PartialFillRow {
  /** The action type whose ask fell short, for the report and for tests. */
  readonly actionType: string;
  /** What the instruction asked for. */
  readonly asked: number;
  /** What the phase actually gave. Never above `asked`. */
  readonly got: number;
  /** Plural noun for the quantity: "roles", "accelerators", "shares". */
  readonly unit: string;
  /** Why the rest did not arrive, in the words the founder reads. */
  readonly reason: string;
  /** The resolver phase writing the row, for the report line. */
  readonly phase: ResolutionPhase;
  /** What the row is about — a product, a security, a node — or null. */
  readonly targetId?: string | null;
  /** The sentence the report prints. Defaults to a plain rendering of the row. */
  readonly line?: string;
}

/**
 * Write the shortfall and say it out loud.
 *
 * Returns the event id so a caller that is already emitting rows for the part
 * that *did* fill can reference both together.
 */
export function emitPartialFill(
  draft: SessionState,
  ctx: ResolverContext,
  companyId: string,
  row: PartialFillRow,
): string {
  const asked = Math.max(0, row.asked);
  const got = Math.max(0, Math.min(asked, row.got));
  const eventId = emitEvent(
    draft,
    ctx,
    'information_revealed',
    companyId,
    row.targetId ?? null,
    {
      kind: 'partial_fill',
      actionType: row.actionType,
      asked,
      got,
      shortfall: asked - got,
      unit: row.unit,
      reason: row.reason,
    },
    'company',
  );
  const company = draft.companies.find((candidate) => candidate.id === companyId);
  ctx.log({
    phase: row.phase,
    text:
      row.line ??
      `${company?.name ?? companyId} asked for ${Math.round(asked)} ${row.unit} and got ${Math.round(got)}. ${row.reason}`,
    deltaLabel: `${Math.round(got)}/${Math.round(asked)}`,
    refEventIds: [eventId],
    tone: got <= 0 ? 'warning' : 'neutral',
    subjectId: companyId,
  });
  return eventId;
}

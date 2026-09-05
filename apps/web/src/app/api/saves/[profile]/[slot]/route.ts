/**
 * `/api/saves/[profile]/[slot]` — one stored save.
 *
 * | Verb | Does | Answers with |
 * |---|---|---|
 * | `GET` | Reads the slot | `{ ok, envelope }`, or 404 `no_save` |
 * | `PUT` | Stores a save | `{ ok, envelope }`, or 409 with the server's summary |
 * | `DELETE` | Empties the slot | `{ ok, deleted }` |
 *
 * ## What a `PUT` promises
 *
 * The body is `{ file, ifRevision?, displayName? }`. `file` is a v5 save file,
 * unchanged: **no format version bump**, so every save already in a browser's
 * `localStorage` uploads as it stands. The server validates its *shape* with
 * the same pure parser the browser uses and then stores it **verbatim** — the
 * client is never authoritative over the engine, but a save is the player's own
 * record of their own game, and re-normalising it would be the server having an
 * opinion about a record it did not make.
 *
 * `ifRevision` is what makes two devices safe. Present, the write applies only
 * to the version the client last saw; a mismatch is 409 carrying `current`, the
 * server's summary without the file, and the client reconciles by the conflict
 * rule — **a save is never overwritten by an older one**, decided by
 * `savedQuarter` first, then `savedAtIso`, ties to the server copy — before
 * re-sending. Absent, the write is unconditional, and *then* the server applies
 * that rule itself, because nobody has looked at what would be replaced.
 *
 * Either way the loser is kept: whatever a write replaces is rotated to
 * `<slot>.prev.json` before the new file lands.
 */

import { type SaveSlot, isProfileSlug, isSaveSlot } from '@/lib/saves/store';
import { chargeRead, chargeWrite, guardWriteRequest, json, readBoundedJson, store } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ profile: string; slot: string }>;
}

/** The two names in the path, validated before anything touches the disk. */
async function target(context: RouteContext): Promise<{ profile: string; slot: SaveSlot } | Response> {
  const { profile, slot } = await context.params;
  if (!isProfileSlug(profile)) return json({ ok: false, reason: 'invalid_profile' }, 400);
  if (!isSaveSlot(slot)) return json({ ok: false, reason: 'invalid_slot' }, 400);
  return { profile, slot };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const limited = chargeRead(request);
  if (limited !== null) return limited;

  const where = await target(context);
  if (where instanceof Response) return where;

  const saves = store();
  if (saves === null) return json({ ok: false, reason: 'saves_disabled' }, 404);

  const envelope = saves.read(where.profile, where.slot);
  if (envelope === null) return json({ ok: false, reason: 'no_save' }, 404);
  return json({ ok: true, envelope });
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  // First, and before the body: a forged request costs a header comparison.
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;

  const limited = chargeWrite(request);
  if (limited !== null) return limited;

  const where = await target(context);
  if (where instanceof Response) return where;

  const saves = store();
  if (saves === null) return json({ ok: false, reason: 'saves_disabled' }, 404);

  const body = await readBoundedJson(request);
  if (!body.ok) return json({ ok: false, reason: body.reason }, body.status);
  if (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value)) {
    return json({ ok: false, reason: 'invalid_body' }, 400);
  }
  const parsed = body.value as Record<string, unknown>;
  if (parsed.file === undefined) return json({ ok: false, reason: 'missing_file' }, 400);

  const ifRevision = parsed.ifRevision;
  if (ifRevision !== undefined && (typeof ifRevision !== 'number' || !Number.isInteger(ifRevision) || ifRevision < 0)) {
    return json({ ok: false, reason: 'invalid_if_revision' }, 400);
  }
  const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : undefined;

  const result = saves.write(where.profile, where.slot, parsed.file, {
    ...(ifRevision === undefined ? {} : { ifRevision }),
    ...(displayName === undefined ? {} : { displayName }),
  });
  if (!result.ok) {
    return json({ ok: false, reason: result.reason, ...(result.current === undefined ? {} : { current: result.current }) }, result.status);
  }
  return json({ ok: true, envelope: result.envelope });
}

/**
 * Empty a slot. Absent is success — a delete that finds nothing has achieved
 * what it was asked for — and the file is rotated to `<slot>.prev.json` first,
 * so a mis-tap on the wrong row is recoverable.
 *
 * No content type is demanded: there is no body to type, and the origin checks
 * are what stand between this and a cross-site page.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const forged = guardWriteRequest(request, false);
  if (forged !== null) return forged;

  const limited = chargeWrite(request);
  if (limited !== null) return limited;

  const where = await target(context);
  if (where instanceof Response) return where;

  const saves = store();
  if (saves === null) return json({ ok: false, reason: 'saves_disabled' }, 404);

  const existed = saves.read(where.profile, where.slot) !== null;
  const removed = saves.remove(where.profile, where.slot);
  if (!removed) return json({ ok: false, reason: 'delete_failed' }, 500);
  return json({ ok: true, deleted: existed });
}

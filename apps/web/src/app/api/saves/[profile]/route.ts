/**
 * `GET /api/saves/[profile]` — one profile's four slot summaries.
 *
 * A profile the host has never seen is not an error: the start page asks for a
 * name before there is anything under it, and the picker needs four rows to
 * draw either way. So an unknown profile answers 200 with `exists: false` and
 * four empty slots, and only a *malformed* name is refused.
 *
 * Summaries never carry the save file — see `summaryOf`. Listing four slots is
 * something a picker does on every visit, and shipping four whole games to draw
 * four rows would make the cheapest screen in the app the most expensive.
 */

import { emptySlot, SAVE_SLOTS, isProfileSlug } from '@/lib/saves/store';
import { chargeRead, json, store } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ profile: string }> }): Promise<Response> {
  const limited = chargeRead(request);
  if (limited !== null) return limited;

  const { profile } = await context.params;
  if (!isProfileSlug(profile)) return json({ ok: false, reason: 'invalid_profile' }, 400);

  const saves = store();
  if (saves === null) return json({ ok: false, reason: 'saves_disabled' }, 404);

  const listing = saves.readProfile(profile);
  if (listing === null) {
    return json({
      ok: true,
      exists: false,
      profile,
      displayName: profile,
      createdAtIso: '',
      updatedAtIso: '',
      slots: SAVE_SLOTS.map((slot) => emptySlot(profile, slot)),
    });
  }
  return json({ ok: true, exists: true, ...listing });
}

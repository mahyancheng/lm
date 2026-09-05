/**
 * `GET /api/saves/profiles` — every profile this host holds, with its slots.
 *
 * This is the route that makes decision 1 work: a cookie is per-browser and can
 * never make the phone and the laptop the same game, so the laptop has to be
 * able to *see* the name the phone chose and pick it. Listing is therefore the
 * whole point, not a convenience.
 *
 * On a host with no `SAVE_DIR` it answers `{ ok: true, enabled: false,
 * profiles: [] }` — a definite "this host does not do server saves", which is
 * what lets the client stay on `localStorage` without guessing from a 404.
 *
 * Nothing here is secret, so nothing here is gated beyond the read limiter: on
 * a tailnet-only household host, everyone who can reach the port is the
 * household, and the names are the household's own.
 */

import { chargeRead, json, store } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const limited = chargeRead(request);
  if (limited !== null) return limited;

  const saves = store();
  if (saves === null) return json({ ok: true, enabled: false, profiles: [] });
  return json({ ok: true, enabled: true, profiles: saves.listProfiles() });
}

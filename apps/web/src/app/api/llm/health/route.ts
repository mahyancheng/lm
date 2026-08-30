import { NextResponse } from 'next/server';
import { gateway, modelName, transportAvailable, transportKind } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/llm/health` — is a model configured, and which one?
 *
 * The client memoises this for three seconds and uses it to decide whether to
 * consult the World Director and the NPC strategists before resolving a
 * quarter. A `none` transport is a valid answer, not a failure: the game plays
 * in full on deterministic fallbacks.
 */
export function GET(): NextResponse {
  const kind = transportKind();
  let ready = transportAvailable();

  if (ready) {
    try {
      // Constructing the gateway proves the transport can be built at all.
      ready = gateway().transportKind !== 'none';
    } catch {
      ready = false;
    }
  }

  return NextResponse.json(
    {
      available: ready,
      transportKind: kind,
      model: ready ? modelName() : null,
    },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

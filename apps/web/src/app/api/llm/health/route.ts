import { NextResponse } from 'next/server';
import { serverBuildStamp } from '@/lib/version';
import { gateway, limiterSnapshot, modelName, transportAvailable, transportKind } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/llm/health` — is a model configured, and which one, and is it busy?
 *
 * The client memoises this for three seconds and uses it to decide whether to
 * consult the World Director and the NPC strategists before resolving a
 * quarter. A `none` transport is a valid answer, not a failure: the game plays
 * in full on deterministic fallbacks.
 *
 * `queueDepth` and `runningRole` ride along so a caller can tell "no credential
 * configured" (nothing would ever start) apart from "the model is busy
 * resolving the quarter" (something is already running, work is queued, and it
 * will clear) — the distinction `describeLlmStatus` in `apps/web/src/lib/llm`
 * turns into the sentence the Chief of Staff dock shows. Reading the limiter is
 * free: it is the same process-wide singleton every role route already shares.
 *
 * `build` rides along because this is the route anything watching the Pi
 * already polls; it is the same stamp `GET /api/version` returns, and the
 * fields above it are unchanged.
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

  const build = serverBuildStamp();
  const snapshot = limiterSnapshot();

  return NextResponse.json(
    {
      available: ready,
      transportKind: kind,
      model: ready ? modelName() : null,
      queueDepth: snapshot.queued,
      runningRole: snapshot.runningRole,
      build: { sha: build.sha, shortSha: build.shortSha, builtAt: build.builtAt },
    },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

import { NextResponse } from 'next/server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeCodexAppServerAccount } from '@frontier/llm';
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
export async function GET(): Promise<NextResponse> {
  const kind = transportKind();
  let ready = transportAvailable();
  let cliAvailable: boolean | null = null;
  let signedIn: boolean | null = null;

  if (ready && kind === 'codex-app-server') {
    const env = process.env;
    const cwd = env['CODEX_WORKDIR']?.trim() || (env['CODEX_HOME']?.trim() ? join(env['CODEX_HOME'].trim(), 'workspace') : undefined);
    if (cwd !== undefined) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const account = await probeCodexAppServerAccount({
      env,
      command: env['CODEX_COMMAND'],
      codexHome: env['CODEX_HOME'],
      cwd,
    });
    cliAvailable = account.cliAvailable;
    signedIn = account.signedIn;
    ready = account.cliAvailable && account.signedIn;
  } else if (ready) {
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
      cliAvailable,
      signedIn,
      setup: kind === 'codex-app-server' && signedIn === false ? 'Run `codex login` as the game service user.' : null,
      build: { sha: build.sha, shortSha: build.shortSha, builtAt: build.builtAt },
    },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

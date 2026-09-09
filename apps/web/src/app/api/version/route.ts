import { NextResponse } from 'next/server';
import { serverBuildStamp } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/version` — which build is this process running?
 *
 * Nothing here is secret and nothing here is authenticated: a commit sha and a
 * build time are exactly what a founder needs to answer "did the Pi update?"
 * from a phone, and `deploy/pi/update.sh` reads the same route after health
 * comes up. Never cached — a cached answer would describe the build that
 * replied last time, which is the one question this route exists to settle.
 */
export function GET(): NextResponse {
  const stamp = serverBuildStamp();
  return NextResponse.json(
    { sha: stamp.sha, shortSha: stamp.shortSha, builtAt: stamp.builtAt },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

/**
 * `GET /api/version`.
 *
 * The route exists to answer one question from a phone — "which build is the
 * Pi running?" — so what must never regress is small and absolute:
 *
 * 1. **It reports the process, not the bundle.** The runtime pair wins over
 *    the inlined `NEXT_PUBLIC_` pair, because the container answering is the
 *    thing being asked about.
 * 2. **An unstamped build answers `dev` and a null time**, never a blank.
 * 3. **It is never cached.** A cached answer describes whichever build replied
 *    last, which is precisely the confusion this route removes.
 *
 * No server and no fetch: the handler is called directly, as the other route
 * tests here do.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const SHA = 'a09e1f0c4b2d8e6f1a3c5b7d9e0f2a4c6b8d0e2f';
const KEYS = ['BUILD_SHA', 'BUILD_TIME', 'NEXT_PUBLIC_BUILD_SHA', 'NEXT_PUBLIC_BUILD_TIME'] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function body(): Promise<{ sha: string; shortSha: string; builtAt: string | null }> {
  return (await GET().json()) as { sha: string; shortSha: string; builtAt: string | null };
}

describe('GET /api/version', () => {
  it('reports the build the image was stamped with', async () => {
    process.env.BUILD_SHA = SHA;
    process.env.BUILD_TIME = '2026-09-03T12:17:04Z';
    expect(await body()).toEqual({ sha: SHA, shortSha: 'a09e1f0', builtAt: '2026-09-03T12:17:04Z' });
  });

  it('prefers the running process over the values inlined into the bundle', async () => {
    process.env.NEXT_PUBLIC_BUILD_SHA = 'bbbbbbbbbbbb';
    process.env.NEXT_PUBLIC_BUILD_TIME = '2026-01-01T00:00:00Z';
    process.env.BUILD_SHA = SHA;
    process.env.BUILD_TIME = '2026-09-03T12:17:04Z';
    expect(await body()).toMatchObject({ shortSha: 'a09e1f0', builtAt: '2026-09-03T12:17:04Z' });
  });

  it('falls back to the inlined pair when only the bundle was stamped', async () => {
    process.env.NEXT_PUBLIC_BUILD_SHA = SHA;
    process.env.NEXT_PUBLIC_BUILD_TIME = '2026-09-03T12:17:04Z';
    expect(await body()).toMatchObject({ shortSha: 'a09e1f0', builtAt: '2026-09-03T12:17:04Z' });
  });

  it('says dev rather than nothing on an unstamped build', async () => {
    expect(await body()).toEqual({ sha: 'dev', shortSha: 'dev', builtAt: null });
  });

  it('is never cached', () => {
    expect(GET().headers.get('cache-control')).toContain('no-store');
  });
});

/**
 * The client bundle may not reach the Claude gateway.
 *
 * > **INVARIANT: nothing outside `src/app/api` imports `@frontier/llm`.**
 *
 * The gateway's default transport drives a Claude Code session through
 * `@anthropic-ai/claude-agent-sdk`, which spawns a subprocess and reads the
 * filesystem. Importing it — even for one pure helper, even transitively
 * through a barrel — drags `node:child_process`, `node:crypto` and `node:fs`
 * into a browser chunk, and `next build` fails with `UnhandledSchemeError`
 * rather than a type error. `pnpm typecheck` and `pnpm test` both stay green
 * while this is broken, which is exactly why it needs its own test: a pure
 * function that happens to live in that package is the tempting mistake.
 *
 * The fix, when this fails: move the pure thing into `@frontier/contracts`,
 * which both sides already depend on, and re-export it from `@frontier/llm`
 * so server-side importers are unchanged.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
/** Route handlers run on the server, so they may import the gateway. */
const SERVER_ONLY = join(SRC, 'app', 'api');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('the client bundle', () => {
  it('never imports the Claude gateway outside the route handlers', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(SERVER_ONLY))
      .filter((file) => /from '@frontier\/llm'|from "@frontier\/llm"/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(offenders, `these would pull node:child_process into a browser chunk: ${offenders.join(', ')}`).toEqual([]);
  });

  it('finds the files it is meant to be scanning', () => {
    // A guard that greps nothing passes for the wrong reason.
    expect(sourceFiles(SRC).length).toBeGreaterThan(200);
  });
});

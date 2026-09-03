# Handoff — Pi deployment

Written from a linux/x64 session that **could not build or run the arm64
image**. Everything below is either (a) verified here on x64, (b) read out of
the installed packages, or (c) explicitly flagged as unverified. The Mac session
owns the arm64 verification.

---

## 1. What changed outside `deploy/pi/`

| File | Change | Why |
|---|---|---|
| `packages/llm/src/transport/limited.ts` | new — FIFO async semaphore + `withConcurrencyLimit` | bound the number of Claude Code subprocesses |
| `packages/llm/src/index.ts` | `createGateway` wraps the model-bearing transports; `LLM_MAX_CONCURRENCY`; `GatewayOptions.concurrencyLimiter`; `LlmGateway.maxConcurrency` | wire the bound in one place every caller shares |
| `packages/llm/test/limited.test.ts` | new — 13 deterministic tests | FIFO order, permits, env parsing |
| `apps/web/src/app/api/llm/_gateway.ts` | one process-wide limiter, handed to every gateway rebuild | a credential paste must not reset the bound mid-quarter |
| `apps/web/next.config.ts` | `serverExternalPackages: ['@anthropic-ai/claude-agent-sdk']` | stop Next inlining the SDK — see §3 |
| `apps/web/package.json` | declares `@anthropic-ai/claude-agent-sdk@0.3.251` | **required** for the line above to take effect — see §3 |
| `apps/web/src/lib/llm/client.ts` | `QUARTER_ROLE_TIMEOUT_MS` 20 s → 90 s | queue time is not model time — see §2 |

`pnpm-lock.yaml` moved only to record the new direct dependency. `pnpm install`
reported `reused 196, downloaded 0` — the same packages at the same versions,
one extra symlink. The proven `pnpm install --frozen-lockfile` install on arm64
should be unaffected in content and duration.

---

## 2. Decisions taken that you may want to revisit

### The client-side quarter timeout (a change outside the stated scope)

`apps/web/src/lib/llm/client.ts` had `QUARTER_ROLE_TIMEOUT_MS = 20_000` — a
per-request `AbortController` on the World Director and NPC strategist calls.
There is **no** timeout in `apps/web/src/app/api/llm/*` (checked all 12 routes:
no `AbortSignal`, no `maxDuration`, no per-request timer), so this client
constant was the only one that could fire.

With the calls serialised it fires every quarter. The last rival waits behind
four calls; at 4–10 s each it is aborted before it is ever dispatched, and the
client's `null` path drops that company to its archetype default — precisely the
silent degradation the concurrency bound exists to avoid. Aborting also does not
free the server's permit or stop the subprocess, so the early timeout buys
nothing and throws away work already paid for.

Raised to 90 s (five sequential turns at the measured 4–10 s, plus room for the
transport's one permitted repair attempt). **Decide whether you prefer a
different shape**, e.g.:

- surface the bound on `GET /api/llm/health` (the gateway now exposes
  `maxConcurrency`, and `_gateway.ts` exports `maxConcurrency()`) and have the
  client compute its own ceiling; or
- give the whole quarter one budget instead of a per-call ceiling, so five fast
  calls do not each get 90 s of rope.

The overlay says "Rival strategists are planning" for the whole stretch, so the
worst case is a ~50 s wait that looks like progress. That is a product call.

One neighbour of this, left alone: `POST /api/llm/token/test` — the Settings →
AI connection test — also goes through the semaphore now, and its client
timeout (`TEST_TIMEOUT_MS = 60_000` in `apps/web/src/lib/llm/token.ts`) is only
just wide enough if someone presses Test while a quarter is resolving. Nobody
does that in practice, and widening it would make a genuinely broken credential
take a minute to say so, so it stays. Worth knowing if a "network" failure is
ever reported at a suspicious moment.

### The generated `next.config.js` in the runtime image

`next start` reads the config at boot. With `next.config.ts` it calls
`require.resolve('typescript')` and, when that fails, **tries to install
TypeScript from the network** (`next/dist/build/next-config-ts/transpile-config`
→ `verifyTypeScriptSetup` → `installDependencies`). The production prune removes
`typescript`, and the Pi is tailnet-only, so that is a boot failure.

The Dockerfile therefore writes a plain `next.config.js` (Next checks `.js`
before `.ts`) mirroring the two options, and deletes `next.config.ts` from the
runtime tree. **Verified on x64:** clean start, no warnings, `/api/llm/health`
answers, `/` returns 200.

Rejected alternative: generating the config from
`.next/required-server-files.json`. It loads, but re-serialising Next's resolved
config emits four warnings on every boot (`amp`, `publicRuntimeConfig`,
`serverRuntimeConfig`, unrecognised `configFileName`/`trustHostHeader`) and
turns `htmlLimitedBots` from a RegExp into a string.

**The generated file duplicates two lines of `apps/web/next.config.ts`.** If
that file grows anything the *running server* acts on — `basePath`, `headers()`,
`rewrites()`, `images` — the mirror must grow with it. There is a
`KEEP IN SYNC WITH` comment at the site. A better long-term answer is a shared
`next.config.mjs` that both stages read.

### Build-layer caching traded for correctness

The Dockerfile does one `COPY . .`, deletes every `node_modules` it finds, and
*then* installs — rather than the usual manifests-first layout. A macOS arm64
`node_modules` reaching a linux/arm64 image is the fastest way to ship a broken
platform binary, and it would not surface until the first role call. If build
times annoy you, restore the manifests-first layout **and** keep the purge.

---

## 3. The bundling finding (Part 1b) — real, and worse than expected

**Finding: Next was inlining the entire Claude Agent SDK into a server chunk,
with the build machine's absolute path baked in as a string literal.**

Evidence from a real `pnpm --filter @frontier/web build`, before the fix:

```
.next/server/chunks/598.js   1,415,865 bytes
  (0,l.createRequire)("file:///home/user/lm/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.251_…/sdk.mjs")
  (0,v.fileURLToPath)("file:///home/user/lm/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.251_…/sdk.mjs")
```

The SDK finds its platform binary with
`createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-linux-arm64/claude')`
(confirmed in `sdk.mjs`; the error string is `Native CLI binary for
${platform}-${arch} not found`). Webpack rewrote `import.meta.url` to a literal,
so the lookup was anchored to wherever the build ran, not to where the code
runs. The build is green either way.

**`serverExternalPackages` alone did not fix it.** Added it, rebuilt, and the
1.4 MB chunk with the baked path was still there — byte-identical but for the
chunk id. The reason is in `next/dist/build/handle-externals.js`:
`resolveExternal(...)` runs a `baseResolveCheck` that resolves the request a
second time **from the Next project directory** and refuses to externalise
unless both resolutions agree. `@anthropic-ai/claude-agent-sdk` was a dependency
of `packages/llm`, not of `apps/web`, and under pnpm's strict layout
`apps/web/node_modules/@anthropic-ai/` contained only `sdk`. The base resolve
returned null, so the package was bundled.

**The complete fix is both halves**: `serverExternalPackages` in
`next.config.ts` *and* `@anthropic-ai/claude-agent-sdk` declared in
`apps/web/package.json`. After both, rebuilt from a clean `.next`:

```
$ grep -rl "claude-agent-sdk" .next/server --include=*.js
  … all 12 /api/llm/* route chunks …
$ grep -rho 'import("@anthropic-ai/claude-agent-sdk")' .next/server --include=*.js | wc -l
  12
$ grep -rc 'file:///home/user/lm' .next/server --include=*.js
  0
```

The 1.4 MB chunk is gone; every route now carries a bare dynamic
`import("@anthropic-ai/claude-agent-sdk")` resolved through the deployed
`node_modules`. Build: `✓ Compiled successfully in 29.3s`, all 12 LLM routes
emitted.

**This matters for the existing Render deployment too.** Render installs and
builds on the same machine it runs on, so the baked path happened to be correct
there and the defect was invisible. It would have broken the moment the build
and run steps stopped sharing a filesystem path — which is exactly what a Docker
multi-stage build, a build cache restore, or a `docker save`/`load` does. The
fix is strictly an improvement there: 1.4 MB less in every LLM route chunk and
no dependence on path identity.

**Escape hatch if the arm64 image still cannot find the binary:** the SDK honours
`options.pathToClaudeCodeExecutable`, and `buildQueryOptions` in
`packages/llm/src/transport/claudeSession.ts` is the one place that would set
it. Not implemented — the build-time gate should make it unnecessary — but it is
a four-line change if §4 fails.

---

## 4. What the Mac session must verify

Nothing in `deploy/pi/` has been executed. In rough order of "if this is wrong,
nothing else matters":

1. **`docker build --platform linux/arm64 -f deploy/pi/Dockerfile .` completes.**
   The final `RUN` resolves and executes the platform binary and asserts
   `2.1.251`; a build that reaches the end has proved the packaging can run an
   agent turn. Verified on x64 that the resolution script and the version string
   are right: `node -e "createRequire(require.resolve('@anthropic-ai/claude-agent-sdk',{paths:[cwd]})).resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude')"`
   resolves, and `claude --version` prints `2.1.251 (Claude Code)` with exit 0.
   Only the `-linux-arm64` name and the arm64 executable itself are unverified.
2. **The production prune.** *Run on x64 and verified there* — see §5 for the
   measurements and the decision it invites. The layout it must preserve is
   `.pnpm/@anthropic-ai+claude-agent-sdk@0.3.251_…/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64`
   → a symlink to
   `.pnpm/@anthropic-ai+claude-agent-sdk-linux-arm64@0.3.251/node_modules/…/claude`.
   Step 1's gate runs *after* the prune, so a prune that drops the binary fails
   the build rather than shipping.
3. **`COPY --from=build --chown=node:node /app /app` preserves symlinks and the
   executable bit.** `COPY` copies symlinks as symlinks; step 1 would catch a
   regression, since a dereferenced or non-executable binary fails to run.
4. **The image starts and answers.** `docker run --rm -p 8110:3000 --env-file
   deploy/pi/.env frontier-capital:pi`, then
   `curl localhost:8110/api/llm/health` →
   `{"available":true,"transportKind":"claude-session","model":"sonnet"}`.
   Verified on x64 with the exact Pi environment (`NEXT_PUBLIC_DEMO_MODE=true` +
   `LLM_TRANSPORT=claude-session` + `LLM_MODEL=sonnet` + `LLM_MAX_CONCURRENCY=1`)
   against the built `.next` and the generated `next.config.js`.
5. **A real quarter with live AI, watching `docker stats`.** This is the only
   thing that tests the actual hypothesis: peak RSS with one Next server plus one
   Claude Code subprocess, against `mem_limit: 1g`. If it sits comfortably under,
   nothing to do. If it is over, raise `mem_limit`/`memswap_limit` before
   touching `LLM_MAX_CONCURRENCY`.
6. **Time a quarter.** README claims 20–50 s blocking. If the real number is
   materially higher, the 90 s client timeout in §2 needs to move with it.
7. **Nothing in the Dockerfile is a syntax surprise.** Each non-trivial `RUN`
   was executed here in `/bin/sh` against real files: the `find … -prune -exec
   rm -rf {} +` purge (exit 0, no matches and with matches), the `printf` that
   writes `next.config.js` (output re-`require`d and checked), and the whole
   build-gate script with `-linux-x64` substituted for `-linux-arm64` (exit 0,
   printed `2.1.251 (Claude Code)`). What remains unverified is the *arm64*
   package name and executable, not the shell.
8. **`Dockerfile.dockerignore` is honoured.** BuildKit reads
   `<dockerfile>.dockerignore` in preference to the context's; if your buildx
   does not, the only symptom is a slow context upload (the Dockerfile's purge
   still keeps the result correct). If it is slow, consider a root
   `.dockerignore` — deliberately not added here, since it would change every
   other build in the repository.

---

## 5. The production prune, measured — a decision for you

Run on x64 against this repository:

```
$ pnpm install --frozen-lockfile --prod
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY   # ← would have failed the build

$ CI=true pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false
Packages: -60      devDependencies: skipped

  binary resolves … /claude   214,326,616 bytes   mode 755
  next ok · react ok · zod ok
  typescript pruned · vitest pruned · tailwindcss pruned

$ du -sh node_modules
667M   # …and 667M before the prune, too
```

Three things fall out of that:

- **The `--prod` install needs both non-TTY answers.** Switching a dev modules
  directory to a prod one makes pnpm ask before purging, and with no TTY the
  question is fatal. The Dockerfile now sets `CI=true` *and* passes
  `--config.confirmModulesPurge=false`. Without this the arm64 build would have
  failed at that line — the one bug this x64 session found by running the step
  rather than reasoning about it.
- **The prune preserves everything that matters.** Optional dependency intact,
  executable bit intact, resolvable by the SDK's own lookup.
- **It saves essentially nothing.** `du` reports 667M either way: the platform
  binary, Next and React are the tree. What the prune actually *does* is remove
  `typescript` — which is the sole reason the runtime image needs the mirrored
  `next.config.js` in §2.

So there is a simpler image available if you want it: **drop the `--prod`
install and the generated config**, ship the dev tree, and let `next start` read
`next.config.ts` through the `typescript` that is then still present. You lose
~0 MB and the config-duplication hazard goes with it. Kept as-is here because
the work order asked for a real production tree, and because "the runtime image
contains a test runner" is a fair thing to dislike on its own terms. Your call.

---

## 6. Follow-ups

**Persist the AI credential across restarts — DONE, on the owner's request.**
The posture change ("in memory, gone on restart" → "at rest on the volume") was
taken on purpose: the owner asked for it once the game moved to an always-on
host. Implementation in `apps/web/src/app/api/llm/_persist.ts`, wired through
`_runtime.ts`: the one-year token from the in-app connect flow is sealed with
AES-256-GCM under SHA-256(`LLM_KEY_SECRET`) to `$LLM_STATE_DIR/credential.enc.json`
(the image sets `LLM_STATE_DIR=/home/node/.claude/frontier-capital`, inside the
`claude-home` volume), directory 0700 and file 0600, written by temp-file
rename, restored once per process on the first `resolveLlmEnv()` /
status read, still an override over the environment, and deleted by the same
disconnect route. Off without `LLM_KEY_SECRET` and on serverless (`VERCEL`).
Wrong key, tampered bytes or an unreadable file fail closed to "not connected".
Tests: `_persist.test.ts` (sealing, permissions, restore-across-a-restart).

What to verify on the Pi: connect once through Settings → AI, `docker compose
restart`, and `GET /api/llm/health` should report the credential without a
re-paste; `ls -la` the volume path to confirm 0600.

**Report the concurrency bound to the client.** `GET /api/llm/health` could
include `maxConcurrency` (the gateway exposes it; `_gateway.ts` exports
`maxConcurrency()`). That would let `client.ts` derive its quarter timeout
instead of hardcoding a number chosen for the worst case, and would let the
end-quarter overlay say "4 rivals, one at a time" rather than sitting mute.

**Share one `next.config` between build and runtime** so the Dockerfile's
mirrored `next.config.js` can go away (§2).

**Nothing was added to `deploy/vps/`,** which is untouched. If that deployment
stays, note that it inherits the §3 fix for free and would want the same
`LLM_MAX_CONCURRENCY` reasoning applied to whatever host it targets.


---

## 7. Fix order from the Mac session — resolved

Two defects the Mac session had to hand-patch on the Pi, plus the doc
corrections it asked for, are in the repository now:

1. **`docker-compose.yml` was invalid** — `platform:` nested under `build:`;
   Compose v5 rejects the file. Now `build.platforms: [linux/arm64]` (a list,
   per the spec); the service-level `platform:` is unchanged.
2. **`docker-compose.ghcr.yml` was a silent no-op** — its service key was
   `frontier-capital` (the container name) instead of `app` (the service), so
   the merge *added* a second service and `update.sh` reported success while
   the old container kept serving. Fixed to `app`, and `update.sh` now runs
   `docker compose config` first and refuses to proceed unless the merge
   yields exactly the one `app` service running the GHCR image.
3. **Memory limits are inert on this kernel** (no memory cgroup controller):
   stated plainly in the README and the compose comment; the operator step
   (`cgroup_enable=memory cgroup_memory=1` in `/boot/firmware/cmdline.txt` +
   reboot) is documented as the owner's call because the reboot drops the
   household backend. Not done by anyone.
4. **Layout decision: the Pi is a git checkout** at
   `/home/ycmah/frontier-capital` with `.env` at `deploy/pi/.env`, updated by
   `git pull --ff-only && deploy/pi/update.sh` — so a fix to the compose files
   or the updater reaches the Pi with everything else. Mac session: please
   restructure the flat directory into the checkout (move the existing `.env`
   to `deploy/pi/.env`); the README's bring-up section is written for it.
5. **`update.sh` prints the image digest** (and image id, and the checkout's
   commit) on success, and "Already on the latest image: <digest>" when nothing
   moved.

Untouched, as instructed: port 8110, demo mode, `LLM_MAX_CONCURRENCY=1`,
tailnet-only, the in-app setup-secret credential flow. Still unverified by
anyone: a real quarter with live AI under `docker stats` — needs the owner's
subscription connected first.

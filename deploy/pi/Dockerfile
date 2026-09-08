# syntax=docker/dockerfile:1.7
#
# Frontier Capital — Raspberry Pi (linux/arm64) image.
#
# Built on a Mac with colima, exported with `docker save`, loaded on the Pi.
# See README.md in this directory for the bring-up, and HANDOFF.md for what the
# building machine must verify.
#
# ## The one thing this image is really about
#
# `LLM_TRANSPORT=codex-app-server` starts the Codex CLI as a local stdio
# app-server. Its authenticated ChatGPT state and persisted threads live in a
# dedicated `CODEX_HOME` volume; it never reuses the old Claude profile.
#
# The image pins the CLI package rather than accepting a moving global install.
# The runtime gate executes `codex --version`; login is deliberately a separate
# one-time host operation, never part of an image build or environment file.

# ## The build stamp
#
# `GIT_SHA` and `BUILD_TIME` are supplied by .github/workflows/pi-image.yml —
# the commit the image was built from, and an ISO instant minted by the
# workflow rather than by anything in here. They are declared before the first
# FROM so both stages can pull them into scope with a bare `ARG`, and they
# default to a value that says so, because a local build of this file is a dev
# build. Everything downstream — /api/version, /api/llm/health, the start page
# footer, `deploy/pi/update.sh` — reads exactly these two values.
ARG GIT_SHA=dev
ARG BUILD_TIME=

########################################################################
#  Build                                                               #
########################################################################

FROM --platform=linux/arm64 node:22-bookworm-slim AS build

# `CI=true` matters for more than logging: the production prune below switches
# the modules directory from a dev install to a prod one, and pnpm asks for
# confirmation before purging it. With no TTY that question is fatal
# (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`), so the answer is given twice —
# here and, explicitly, on the command itself.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true

WORKDIR /app

# pnpm comes from the `packageManager` field in the root package.json, so the
# version is pinned by the repository rather than by this file.
RUN corepack enable

# The whole workspace in one copy. A `.dockerignore` keeps the context small,
# but the `find` below is what makes this *correct*: whatever the context
# happens to contain, no `node_modules` from the building machine — a macOS
# arm64 tree, most likely — survives into the install. That is the single
# fastest way to produce an image whose native binaries are for the wrong
# platform, and it fails at runtime rather than at build time.
COPY . .
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf apps/web/.next

# Measured on real arm64: ~1m07s with pnpm 10.33.0. Optional dependencies and
# the root `pnpm.onlyBuiltDependencies` allowlist (which includes the Agent SDK,
# sharp, @tailwindcss/oxide and esbuild) are both honoured by a plain install.
RUN pnpm install --frozen-lockfile

# `NEXT_PUBLIC_*` variables are inlined by the bundler *here*, not read at
# runtime. Demo mode does not actually need one — with no Supabase variables
# set, `isDemoMode()` is already true — but stating it makes the build's intent
# legible and survives someone later adding a `NEXT_PUBLIC_` read.
#
# The build stamp has to be set BEFORE `next build` for the same reason: the
# footer that answers "which build is this?" runs in a browser, and the only
# way a browser can know is if the bundler substituted the value. The unprefixed
# pair is set too, so a `pnpm --filter @frontier/web build` run here reports the
# same thing a server route would.
ARG GIT_SHA
ARG BUILD_TIME
ENV NEXT_PUBLIC_DEMO_MODE=true \
    NEXT_PUBLIC_BUILD_SHA=${GIT_SHA} \
    NEXT_PUBLIC_BUILD_TIME=${BUILD_TIME} \
    BUILD_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}
RUN pnpm --filter @frontier/web build

# Drop to production dependencies. A second install rather than a hand-rolled
# prune: it re-reads the same lockfile, keeps optional dependencies (the
# platform binary is one of them), and honours the root
# `pnpm.onlyBuiltDependencies` allowlist. The store is already warm, so nothing
# is downloaded.
#
# Verified on x64: 60 dev packages removed, and the 214 MB platform binary comes
# through with mode 755, still resolvable by exactly the lookup the SDK performs
# at runtime. Note how little space this buys — the binary, Next and React
# dominate the tree — so its real effect is removing `typescript`, which is what
# the generated config below then has to work around.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# `next start` reads the config file at boot, and `next.config.ts` makes it
# resolve — and, failing that, try to *install from the network* — the
# `typescript` package that the production prune just removed. On a tailnet-only
# Pi that is a boot failure. The two options below are build-time settings that
# the running server does not act on; they are mirrored rather than dropped so
# that the runtime config is a faithful subset of the real one.
#
#   KEEP IN SYNC WITH apps/web/next.config.ts
#
# `.next/cache` is the build cache and is dead weight in the runtime image.
RUN printf '%s\n' \
      '// Generated by deploy/pi/Dockerfile — mirrors apps/web/next.config.ts.' \
      '// `next start` must not need TypeScript to read its own config.' \
      'module.exports = {' \
      '  transpilePackages: ["@frontier/contracts", "@frontier/shared", "@frontier/simulation", "@frontier/llm"],' \
      '  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],' \
      '};' \
      > apps/web/next.config.js \
 && rm -f apps/web/next.config.ts \
 && rm -rf apps/web/.next/cache

########################################################################
#  Runtime                                                             #
########################################################################

FROM --platform=linux/arm64 node:22-bookworm-slim AS runtime

# Codex's native HTTPS client needs the OS trust store. Node's bundled CAs
# can make network probes pass even when device sign-in cannot reach OpenAI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt

# Verified against the app-server protocol used by this integration. Bump only
# after regenerating/validating its app-server schema and smoke-testing a turn.
ARG CODEX_CLI_VERSION=0.151.0-alpha.2

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/node \
    CODEX_HOME=/home/node/.codex \
    CODEX_WORKDIR=/home/node/.codex/workspace \
    LLM_STATE_DIR=/home/node/.codex/frontier-capital \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The build stamp again, for the running process rather than for the bundle:
# `GET /api/version` and `GET /api/llm/health` report these, and
# `deploy/pi/update.sh` prints them after health comes up. ARGs do not cross
# stages, hence the second declaration.
ARG GIT_SHA
ARG BUILD_TIME
ENV BUILD_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

# `node` (uid 1000) already exists in this image and owns /home/node. Install
# the pinned arm64 CLI before dropping privileges, then keep its state private.
RUN npm install --global --omit=dev "@openai/codex@${CODEX_CLI_VERSION}" \
 && install -d -o node -g node -m 0700 /home/node/.codex /home/node/.codex/workspace

COPY --from=build --chown=node:node /app /app

USER node
WORKDIR /app/apps/web

# Build gate: confirms the pinned arm64 CLI is executable. It never starts
# login and never reaches a model service.
RUN set -eu; version="$(codex --version)"; echo "codex --version: ${version}"; \
    case "${version}" in *"${CODEX_CLI_VERSION}"*) ;; *) echo "unexpected Codex CLI version" >&2; exit 1 ;; esac

EXPOSE 3000

# No pnpm and no corepack at runtime: `next` is invoked directly out of the
# workspace's own node_modules, with the app directory as the working directory
# so it finds `.next` and its config.
CMD ["node", "./node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

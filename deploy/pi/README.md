# Frontier Capital on a Raspberry Pi

A tailnet-only deployment: demo mode (no Supabase, no accounts) with **live
AI** through Claude Code sessions on the operator's subscription.

Reachable at `http://<pi>:8110`. There is no public URL, no reverse proxy, no
domain and no TLS in this deployment — every one of those is deliberate, and
none of them is a step you are missing below.

The Pi is a **shared** machine. It also runs the household WhatsApp/Routine
backend and a Postgres belonging to another application, and it has ~2.1 GB of
its 3.7 GB free. Everything about this deployment — the memory limits, the
concurrency bound, the port — is a promise to those other tenants.

---

## The shape of it

| | |
|---|---|
| Image | `frontier-capital:pi`, `linux/arm64`, built on the Mac |
| Transport | `docker save` on the Mac → `ssh` → `docker load` on the Pi |
| Port | `8110` on the host → `3000` in the container |
| Memory | `mem_limit 1g`, `memswap_limit 2g` (1 GB RAM + up to 1 GB of the host's swap) |
| Server-side state | one named volume, `claude-home` → `/home/node/.claude` |
| Game saves | **in the player's browser**, not on the server — see below |
| Credentials | none in the image, none in the repository; pasted in through Settings → AI |

---

## Bring-up, from a clean checkout

### 1. On the Mac: build the arm64 image

`colima` must be running with enough memory to build (the build stage peaks
around 1.85 GB before pruning).

```sh
colima start --cpu 4 --memory 8 --arch aarch64   # once
cd <repo root>
docker build --platform linux/arm64 -f deploy/pi/Dockerfile -t frontier-capital:pi .
```

The build ends by executing the Claude Code binary it just packaged and
asserting `2.1.251`. If that step fails, the image would have started fine on
the Pi and then failed at the first role call instead — read HANDOFF.md.

Tag the build so you can roll back to it later:

```sh
docker tag frontier-capital:pi frontier-capital:pi-$(git rev-parse --short HEAD)
```

### 2. Ship it

```sh
docker save frontier-capital:pi frontier-capital:pi-$(git rev-parse --short HEAD) \
  | ssh ycvps 'docker load'
```

~1 GB over the tailnet. `gzip -1` in the pipe helps on a slow link and costs
CPU on both ends; the image is mostly an already-compressed executable, so the
saving is modest.

### 3. On the Pi: configure and start

```sh
mkdir -p ~/frontier-capital && cd ~/frontier-capital
# deploy/pi/docker-compose.yml and .env live here
cp .env.example .env && chmod 600 .env
$EDITOR .env          # fill in LLM_SETUP_SECRET and LLM_KEY_SECRET
docker compose up -d
```

`.env` already exists at `/home/ycmah/frontier-capital/.env` (mode 0600) with
exactly the names in `.env.example`.

### 4. Check it

```sh
curl -s http://localhost:8110/api/llm/health
# {"available":true,"transportKind":"claude-session","model":"sonnet"}
docker compose ps            # should read "healthy" within ~90s
```

`available: true` means the transport is *configured and can run here*. It does
not mean a credential has been accepted yet — that is step 5.

### 5. Connect the AI

Open `http://<pi>:8110` on the tailnet, go to **Settings → AI**, and paste the
token from `claude setup-token`. The panel will ask for the setup secret: that
is `LLM_SETUP_SECRET` from `.env`, sent as an `x-setup-secret` header, and it is
what lets a non-localhost caller with no Supabase admin write the credential.

**The credential lives in the server process's memory and nowhere else.** It is
not written to the volume, not written to `.env`, and not persisted anywhere.
After `docker compose restart`, after `docker compose up -d` on a new image, and
after any container crash, **you must paste it again**. See HANDOFF.md for the
proposed follow-up that would fix this.

---

## Logs, health, rollback

```sh
docker compose logs -f --tail=200          # follow
docker compose logs --since 1h app         # a window
docker inspect --format '{{.State.Health.Status}}' frontier-capital
docker stats --no-stream frontier-capital  # memory against the 1g limit
```

Rolling back is a retag, because the previous image is still on the Pi:

```sh
docker image ls frontier-capital           # find the tag you want
docker tag frontier-capital:pi-<old-sha> frontier-capital:pi
docker compose up -d                       # recreates from the retagged image
```

`pull_policy: never` means compose will never reach for a registry, and the
`build:` section will not fire as long as the image exists locally. Re-paste the
AI credential afterwards.

---

## What a quarter costs

Every role call spawns a Claude Code subprocess, and the gateway runs
**one at a time** (`LLM_MAX_CONCURRENCY=1`). Ending a quarter therefore blocks
on five sequential model turns: the World Director, then one strategist for each
of the ~4 rival companies.

At the 4–10 s per session turn measured for this project:

| | |
|---|---|
| World Director | 4–10 s |
| ~4 rival strategists, one after another | 16–40 s |
| **Blocking total per quarter** | **roughly 20–50 s** |

The deterministic 18-phase resolution that follows is milliseconds. The
narrator runs *after* the quarter is committed and does not block the screen.

Two things worth knowing about that number:

- **It is queue time, not slowness.** Raising `LLM_MAX_CONCURRENCY` to 2 roughly
  halves it and roughly doubles peak memory. On this host, don't — the second
  subprocess is what takes the machine down. It is the right knob on a bigger
  box.
- **Nothing degrades while waiting.** Queued calls are never refused, so every
  rival still gets a real plan. The client waits up to 90 s per quarter call for
  exactly this reason.

If a quarter *does* time out or the model is unreachable, the game resolves on
its deterministic fallbacks: the Director's drawn events fire on their family
templates and rivals run their archetype defaults. A degraded quarter, never a
blocked one.

---

## Where the state actually is

**Game saves are in the browser.** In demo mode the server holds no world at
all: the simulation runs in the player's tab and the autosave plus three manual
slots are `localStorage` keys on **that device**. Two consequences that surprise
people:

- Opening the game from a different device or browser shows a fresh world. There
  is no sync, because there is no server-side session to sync with.
- Redeploying, restarting, or deleting the container loses nothing. Clearing the
  browser's site data loses everything.

**The volume holds Claude Code session transcripts, and only those.**
`claude-home` is mounted at `/home/node/.claude` (`CLAUDE_CONFIG_DIR`), which is
where the Agent SDK writes the sessions that a Chief-of-Staff thread or a
character conversation is resumed from. Strategic calls — the World Director and
every NPC strategist — deliberately open a *fresh* session each quarter, so they
never touch it. Deleting the volume costs conversational memory and nothing
else; threads simply start again.

**The AI credential is in process memory.** Not in the volume, not in `.env`,
not in the image. Re-paste after every restart.

---

## Troubleshooting

**`available: false` from `/api/llm/health`.** `LLM_TRANSPORT` is not reaching
the process. Check `docker compose config` and that `env_file: .env` resolved.

**Roles answer but always with `fallback: true`.** No credential has been
pasted, or the pasted one was rejected. Settings → AI shows which.

**Settings → AI refuses the write with `setup_secret_required` or
`setup_disabled`.** `LLM_SETUP_SECRET` is unset or does not match. It is
compared in constant time and rate-limited to 10 attempts a minute per process.

**The container is killed, or quarters get very slow.** Check
`docker stats` against `mem_limit`. Raising `mem_limit` (and `memswap_limit`
with it) is the first knob; lowering `NODE_OPTIONS=--max-old-space-size` is the
second. Never raise `LLM_MAX_CONCURRENCY` to buy speed on this host.

**`Native CLI binary for linux-arm64 not found` in the logs.** The image was
built on the wrong platform or with optional dependencies suppressed. The
build-time gate is supposed to make this impossible; see HANDOFF.md.

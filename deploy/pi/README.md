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
| Image | `ghcr.io/mahyancheng/lm/frontier-capital:pi`, `linux/arm64`, built by GitHub Actions on every push (a Mac `docker build` remains an alternative) |
| Transport | the Pi pulls from GHCR through `deploy/pi/update.sh` (anonymous pull; the package is public) |
| Port | `8110` on the host → `3000` in the container |
| Memory | `mem_limit 1g` / `memswap_limit 2g` are declared but **inert on this kernel** (no memory cgroup controller) — the bound that holds is `LLM_MAX_CONCURRENCY=1` + `NODE_OPTIONS=--max-old-space-size=384`; see *Memory* below |
| Layout on the Pi | a git checkout at `/home/ycmah/frontier-capital`; compose files, `update.sh` and `.env` live in its `deploy/pi/` |
| Server-side state | one named volume, `claude-home` → `/home/node/.claude` |
| Game saves | **in the player's browser**, not on the server — see below |
| Credentials | none in the image, none in the repository; pasted in through Settings → AI |

---

## Bring-up, from a clean checkout

The Pi holds a **real git checkout** of this repository, so a fix to the
compose files or to `update.sh` reaches the Pi with the same `git pull` that
fetches everything else — the alternative (files copied flat into a directory)
is exactly how two compose defects once had to be hand-patched on the host.

### 1. On the Pi: check out and configure

```sh
git clone --depth 1 --branch claude/opus5-agents-vercel-supabase-kz1ehf \
  https://github.com/mahyancheng/lm /home/ycmah/frontier-capital
cd /home/ycmah/frontier-capital/deploy/pi
cp .env.example .env && chmod 600 .env
$EDITOR .env          # LLM_SETUP_SECRET and LLM_KEY_SECRET; the other names as in the example
```

`.env` lives **beside the compose file** (`deploy/pi/.env`): compose resolves
`env_file` relative to the compose file, and `update.sh` runs from that
directory. The existing `/home/ycmah/frontier-capital/.env` from the flat
layout moves to `deploy/pi/.env` when the directory becomes a checkout.

### 2. Pull the image and start

```sh
./update.sh
```

That validates the compose merge, pulls
`ghcr.io/mahyancheng/lm/frontier-capital:pi` (the image the last push built —
see *Updating*), starts the service through the GHCR overlay, waits for
`/api/llm/health`, and prints the image **digest** it is now running.

### 3. Check it

```sh
curl -s http://localhost:8110/api/llm/health
# {"available":true,"transportKind":"claude-session","model":"sonnet"}
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml ps   # "healthy" within ~90s
```

`available: true` means the transport is *configured and can run here*. It does
not mean a credential has been accepted yet — that is step 4.

### 4. Connect the AI

Open `http://<pi>:8110` on the tailnet. The **Set up AI** button in the
masthead (or **Settings → AI · Claude** inside the game) asks for the setup
secret — `LLM_SETUP_SECRET` from `.env` — and then offers **Connect with
Claude**. The token it issues is sealed to the `claude-home` volume under
`LLM_KEY_SECRET` and restored on every boot, so this is done once.

### Alternative: build on a Mac and ship by hand

Still supported, unchanged, for a build that must not wait for CI:

```sh
colima start --cpu 4 --memory 8 --arch aarch64   # once
docker build --platform linux/arm64 -f deploy/pi/Dockerfile -t frontier-capital:pi .
docker save frontier-capital:pi | ssh ycvps 'docker load'
# on the Pi:
cd /home/ycmah/frontier-capital/deploy/pi && docker compose up -d   # base file only: pull_policy never
```

The build ends by executing the Claude Code binary it packaged and asserting
`2.1.251`; if that fails the image would have started and then failed at the
first role call — read HANDOFF.md.

---

## Updating without the Mac

Every push to the deployment branch that touches the app, the packages or
`deploy/pi/` runs `.github/workflows/pi-image.yml`, which builds this same
`Dockerfile` for `linux/arm64` under QEMU (slow — 20–40 minutes — but free) and
publishes it as `ghcr.io/mahyancheng/lm/frontier-capital:pi` (plus a
`pi-<sha>` tag per commit). The Pi then updates itself:

```sh
cd /home/ycmah/frontier-capital && git pull --ff-only && deploy/pi/update.sh
```

`git pull` first, so the compose files and `update.sh` itself are current
before they run. `update.sh` then validates the compose merge (it refuses to
continue if the overlay would produce anything but the one `app` service),
tags the running image `frontier-capital:rollback`, pulls the new one,
restarts through the `docker-compose.ghcr.yml` overlay, waits for
`/api/llm/health`, prints the **digest** now serving (the tag reads the same
before and after; the digest is the proof the image moved), and rolls back
automatically if health does not come up. Run it from any SSH app on a phone
over the tailnet, or let a timer do it:

```ini
# /etc/systemd/system/frontier-update.service
[Unit]
Description=Update Frontier Capital from GHCR
[Service]
Type=oneshot
User=ycmah
WorkingDirectory=/home/ycmah/frontier-capital
ExecStart=/bin/sh -c 'git pull --ff-only && deploy/pi/update.sh'

# /etc/systemd/system/frontier-update.timer
[Unit]
Description=Check for a new Frontier Capital image
[Timer]
OnCalendar=hourly
RandomizedDelaySec=10m
[Install]
WantedBy=timers.target
```

`systemctl enable --now frontier-update.timer`. Unchanged image → no restart.

The package is public, so the pull is anonymous; if it is ever made private
again, `docker login ghcr.io` once on the Pi with a read-only token
(`read:packages`).

## Memory

**The compose memory limits do nothing on this Pi today.** Its kernel boots
without the memory cgroup controller — `cat /sys/fs/cgroup/cgroup.controllers`
prints `cpuset cpu io pids` — so every `docker compose up` warns
`Your kernel does not support memory limit capabilities or the cgroup is not
mounted. Limitation discarded.` and `docker stats` shows `0B / 0B`. The
`mem_limit: 1g` / `memswap_limit: 2g` lines stay in the compose file because
they are correct and take effect the moment the kernel supports them, but
**there is no second net under the application today**: what bounds memory is
`LLM_MAX_CONCURRENCY=1` (one ~213 MB Claude Code subprocess at a time) plus
`NODE_OPTIONS=--max-old-space-size=384` on the Next process.

**Enabling the controller is an operator step, and a reboot.** Append
`cgroup_enable=memory cgroup_memory=1` to the single line in
`/boot/firmware/cmdline.txt` and reboot the Pi. The reboot drops the household
WhatsApp/Routine backend for as long as it takes, which is why nobody has done
it in passing — it is the owner's call. After it, the same compose file starts
enforcing the limits with no other change, and `docker stats` shows a real
ceiling.

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
`build:` section will not fire as long as the image exists locally. The AI
credential survives the rollback (it lives on the volume).

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

**The volume holds two things.** `claude-home` is mounted at
`/home/node/.claude` (`CLAUDE_CONFIG_DIR`):

- Claude Code session transcripts, which the Agent SDK writes and which a
  Chief-of-Staff thread or a character conversation is resumed from. Strategic
  calls — the World Director and every NPC strategist — deliberately open a
  *fresh* session each quarter, so they never touch it.
- The AI credential, at `frontier-capital/credential.enc.json` inside it
  (`LLM_STATE_DIR`, set in the image). The token the in-app **Connect with
  Claude** flow issues is a one-year token; it is sealed with AES-256-GCM under
  `LLM_KEY_SECRET` and restored on the next boot, so a restart, a new image, or
  a `docker compose down && up` comes back **already connected**. Disconnecting
  in Settings deletes the file. Rotating `LLM_KEY_SECRET` makes the file
  unreadable (by design) — connect once more afterwards.

Deleting the volume costs conversational memory and the connection, nothing
else; threads start again and the player connects again.

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
`docker stats` (which reports a real ceiling only once the memory controller is enabled — see *Memory*). Raising `mem_limit` (and `memswap_limit`
with it) is the first knob; lowering `NODE_OPTIONS=--max-old-space-size` is the
second. Never raise `LLM_MAX_CONCURRENCY` to buy speed on this host.

**`Native CLI binary for linux-arm64 not found` in the logs.** The image was
built on the wrong platform or with optional dependencies suppressed. The
build-time gate is supposed to make this impossible; see HANDOFF.md.

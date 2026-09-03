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
| Server-side state | two named volumes: `claude-home` → `/home/node/.claude` (Agent SDK sessions + the sealed credential) and `saves` → `/data` (game saves, `SAVE_DIR=/data/saves`) |
| Game saves | **on the Pi**, keyed by a profile name the player picks — the browser keeps an offline cache; see *Saves* below |
| Credentials | none in the image, none in the repository; connected through Settings → AI (no unlock secret on the tailnet: `LLM_TOKEN_SETUP=local`) and sealed to the volume |

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
$EDITOR .env          # LLM_KEY_SECRET (long, random); keep LLM_TOKEN_SETUP=local; the rest as in the example
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
masthead (or **Settings → AI · Claude** inside the game) offers **Connect with
Claude** directly — no unlock secret, because `LLM_TOKEN_SETUP=local` in
`.env` tells the gate that everything reaching a tailnet-only host is the
household. The token it issues is sealed to the `claude-home` volume under
`LLM_KEY_SECRET` and restored on every boot, so this is done once.

(`LLM_SETUP_SECRET` is the gate for a host the public can reach; it is ignored
while `LLM_TOKEN_SETUP=local` is set, and may be left empty here.)

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

### How to tell which build the Pi is running

Every image is stamped by CI with the commit it was built from and the moment
it was built, and three surfaces read the same stamp back so "did it update?"
never needs guessing: the **start page footer** reads `Build <shortSha> ·
<date>` (e.g. `Build a09e1f0 · 3 Sep 12:17 UTC`) beside the AI status line, for
whoever is holding the phone; `curl -s http://localhost:8110/api/version`
returns `{"sha","shortSha","builtAt"}` for a script; and `update.sh` prints a
`version:` line next to the image `digest:` line on every run, updated or not.
`Build dev` anywhere means nothing was ever stamped — only a Mac build without
`GIT_SHA`/`BUILD_TIME` passed as build-args does that; the CI-built image
always carries a real sha. **If the timer has not pulled** — the footer is
stuck on an old sha, or `systemctl list-timers` shows `frontier-update.timer`
overdue or missing — run `deploy/pi/update.sh` by hand (`cd
/home/ycmah/frontier-capital && git pull --ff-only && deploy/pi/update.sh`);
`systemctl list-timers` shows when it last fired and is due next, and
`systemctl status frontier-update.timer` / `journalctl -u
frontier-update.service` show why it didn't.

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
on the World Director, then up to `NEXT_PUBLIC_LLM_STRATEGISTS_PER_QUARTER`
(default 4) rival strategists — the ones whose plan actually bears on the
player's next move: mid-deal with the player, head-to-head on a bid, same
sector, same region, largest, in that order (`strategistPriority` in
`@frontier/simulation`). World 2's roster runs to two dozen companies across
six sectors; this ordering, not just the count, is what keeps a quarter from
scaling with the size of the world.

At the 4–10 s per session turn measured for this project:

| | |
|---|---|
| World Director | 4–10 s |
| up to 4 rival strategists, one after another | 16–40 s |
| **Blocking total per quarter, worst case** | **roughly 20–50 s** |

The deterministic 18-phase resolution that follows is milliseconds — measured
at 250–400 ms on world 2's full 25-company roster in this project's own CI
sandbox, well inside the generous ceiling `packages/simulation/test/resolvePerformance.test.ts`
asserts. The narrator runs *after* the quarter is committed and does not block
the screen.

Three things worth knowing about that number:

- **It is queue time, not slowness.** Raising `LLM_MAX_CONCURRENCY` to 2 roughly
  halves it and roughly doubles peak memory. On this host, don't — the second
  subprocess is what takes the machine down. It is the right knob on a bigger
  box.
- **A time budget bounds the worst case.** `NEXT_PUBLIC_LLM_QUARTER_BUDGET_MS`
  (default 90 s) is the ceiling on the World Director plus every strategist
  *together* — when it runs out, whichever rivals have not had their turn yet
  fall back to their archetype policy immediately, and the resolving overlay's
  own progress list says which ones ("Basalt Compute strategist · on policy
  (budget)") rather than leaving the player guessing why a quarter felt
  shorter than usual.
- **Strategist calls start before End Quarter is even clicked.** The moment a
  quarter opens, the client starts each priority rival's call in the
  background (`apps/web/src/lib/game/strategistPrefetch.ts`) — a strategist's
  plan depends only on state at the start of the quarter, so by the time the
  player actually ends it, some or all of that work is already done and the
  overlay only waits for whichever call genuinely is not back yet.
- **Nothing degrades while waiting.** Queued calls are never refused, so every
  rival that gets a live call gets a real plan. The client waits up to 90 s
  per quarter-role call for exactly this reason — see `QUARTER_ROLE_TIMEOUT_MS`
  in `apps/web/src/lib/llm/client.ts`.

If a quarter *does* time out or the model is unreachable, the game resolves on
its deterministic fallbacks: the Director's drawn events fire on their family
templates and rivals run their archetype defaults. A degraded quarter, never a
blocked one.

---

## Saves

Saves work on this host in two layers, and the first one is the one that has
always been there.

**Layer one: the browser.** In demo mode the simulation runs in the player's
tab. The autosave and three manual slots are `localStorage` keys on that
device, written synchronously after every move. This is unchanged, and it is
still the layer the game actually depends on: the Pi being off, the tailnet
dropping, or `SAVE_DIR` never being set costs a status chip and nothing else.

**Layer two: this host.** With `SAVE_DIR` set, the app also keeps a copy under
a **profile** — a name the player types on the start page ("YC"), normalised to
a slug. It is not an account: no password, no email, nothing to reset. On a
tailnet-only household host a password would be theatre, and a cookie is
per-browser by construction, so it could never make the phone and the laptop
the same game. A name that the laptop can *see in a list and pick* can. Every
write goes to the browser first and to this host second, debounced and retried,
never blocking the game.

### Where it lives

- Volume `saves`, mounted at **`/data`**; `SAVE_DIR=/data/saves` in `.env`.
- Layout: `SAVE_DIR/<profile>/<slot>.json` for slot ∈ `autosave`, `1`, `2`, `3`,
  plus `<slot>.prev.json` — the version one overwrite ago, kept on **every**
  write, so a single bad save is always undoable — and `profile.json`.
- Files are `0600`, directories `0700`, and every write is a temp file plus
  `rename`, so a crash mid-write leaves the previous file rather than a torn one.
- `claude-home` is untouched by any of this. Saves are the player's own record
  and a model cache is disposable; they do not share a volume, and deleting
  `claude-home` to reclaim space costs no saves.

### Caps

Three, and they are refusals rather than silent evictions:

| Cap | Value | What happens past it |
|---|---|---|
| Per save file | **4 MB** | `413 save_too_large`; the save stays in the browser |
| Slots per profile | **4** (`autosave`, `1`, `2`, `3`) | there is no fifth slot to ask for |
| Profiles per host | **32** | `507 profile_limit` on the 33rd, with a reason |

A hundred-quarter session with a checkpoint is a few hundred kilobytes, so the
4 MB ceiling is about an order of magnitude of headroom — enough that no honest
game is refused, small enough that a broken client cannot fill the card one
`PUT` at a time.

### The conflict rule

> **A save is never overwritten by an older one. "Older" is decided by
> `savedQuarter` first, then `savedAtIso`; ties go to the server copy.**

Quarter leads because it is the only monotone fact about a session — it counts
decisions actually taken — while a timestamp is a clock two devices need not
agree on, and a phone whose date is a year out would otherwise win every
reconciliation.

The rule is one function, applied on both sides. The client sends the revision
it last saw on every write; a mismatch comes back as `409` with the server's
summary (never the file), and the client reconciles by that same rule before
re-sending or standing down. **Neither copy is ever dropped**: the loser is kept
as `<slot>.prev.json` on this host, or under a `frontier-saves-backup-*` key in
the browser.

### First run on a device (migration)

The first time a browser picks a profile with this host reachable, each of the
four slots is reconciled:

- the host does not have it → it is **uploaded**;
- both have it → the conflict rule decides, and if the host's is newer the
  local copy is set aside under a backup key **before** the host's is adopted;
- only the host has it → it is adopted here.

Never the reverse: a server save is **never** deleted because a browser lacks
it, and an older local save is never written over a newer server one. The
landing page says one line about what the first reconciliation did. The
reconciliation itself runs on every load and is idempotent, which is also what
makes an interrupted push heal itself — the browser's copy is then newer, so
the next load sends it.

### Nothing breaks

**There is no save-format version bump.** The file is still v5, byte for byte;
the host wraps it in an envelope and stores the file **verbatim**. Every save
already sitting in a browser's `localStorage` stays readable and is uploaded
as-is on the first reconciliation. With `SAVE_DIR` unset the routes answer
`enabled: false` and the game behaves exactly as it did before any of this
existed.

### Backing it up

```bash
docker run --rm -v frontier-capital_saves:/data -v "$PWD":/out alpine \
  tar czf /out/frontier-saves-$(date +%F).tgz -C /data saves
```

Restore by untarring back into the same volume. The files are plain JSON —
`cat` one when something looks wrong.

---

## Where the state actually is

**Game saves are in the browser, and optionally also on this host.** In demo
mode the server holds no world at all: the simulation runs in the player's tab
and the autosave plus three manual slots are `localStorage` keys on that device.
With `SAVE_DIR` set (see *Saves*) a profile-keyed copy is also kept in the
`saves` volume, which is what lets the laptop pick up the game the phone
started. Three consequences:

- With `SAVE_DIR` unset, opening the game from a different device shows a fresh
  world — there is nothing server-side to sync with. With it set, picking the
  same profile name on the second device brings the game across.
- Redeploying, restarting or deleting the **container** loses nothing either
  way. Deleting the `saves` **volume** loses the host's copies; the browsers
  still have theirs, and the next load uploads them again.
- Clearing a browser's site data loses that browser's copies. With server saves
  on, the host still has them and the next load brings them back.

**`claude-home` holds two things**, and no saves. It is mounted at
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

Deleting `claude-home` costs conversational memory and the connection, nothing
else; threads start again and the player connects again. Saves are in the other
volume and are unaffected.

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

**The start page says "This host does not keep saves" although `SAVE_DIR` is
set.** The directory is not writable by `node` (uid 1000) — the usual cause is a
fresh named volume, whose mount point Docker creates as root. Run the one-time
command in the `saves` volume comment in `docker-compose.yml`. Until then the
game behaves exactly as it did before server saves existed; nothing is lost and
nothing errors.

**A save will not upload: `save_too_large`.** The file is over the 4 MB cap. It
is still saved in the browser. Nothing prunes it automatically; export it from
Settings if it matters.

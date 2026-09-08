# Frontier Capital

**An LLM-powered AI corporate grand-strategy game.** You begin as the founder
of a small AI startup — a few million dollars, a founding team, one
technological thesis — inside an AI economy that existed before you arrived
and keeps moving whether or not you act. Over many quarters you can end up
controlling a public AI conglomerate, sitting on rival boards, supplying
governments, and competing for control of a technological frontier that
nobody — including the game itself — knows with certainty.

Every important company and character has goals, memory and agency. An LLM
**World Director** perturbs a **deterministic economic simulation** through
validated, bounds-checked modifier proposals. LLMs think, propose, negotiate
and reinterpret the future; **only the simulation engine makes reality.**

## Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js (App Router), self-hosted as one always-on Node process (`deploy/pi`) |
| Canonical state, auth, realtime | **Supabase** (Postgres, RLS, Broadcast) |
| All LLM roles | **Codex app-server** — managed ChatGPT CLI authentication and persistent threads |
| Engine | Pure TypeScript deterministic simulation (`packages/simulation`) |

The default live backend is Codex app-server. See [Codex backend setup](docs/CODEX_APP_SERVER.md).

## Quickstart (demo mode — no keys required)

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. Demo mode runs a fully local, deterministic
single-player session: the real engine, seeded world, rule-based NPC rivals,
and every screen live — no Supabase project or Anthropic key needed.

### Turning on the live model

Run the supported one-time `codex login` ceremony on the self-hosted game
machine or container. Managed ChatGPT login and Codex thread rollouts stay in
the dedicated persistent `CODEX_HOME`; the game does not use a browser-pasted
token or API key. See [Codex backend setup](docs/CODEX_APP_SERVER.md).

**The game is self-hosted on purpose.** Codex app-server runs as a local
subprocess, so deployment is one always-on Node process (the Raspberry Pi kit
or generic VPS service), not a serverless function.

## Full stack setup

1. **Supabase**: create a project, then `supabase db push` (or apply
   `supabase/migrations/*.sql` in order) and load `supabase/seed.sql`.
2. **Codex**: follow [Codex backend setup](docs/CODEX_APP_SERVER.md) and run
   the supported CLI login once under the persistent `CODEX_HOME`.
3. **Env**: copy `.env.example` to `apps/web/.env.local`, set
   `LLM_TRANSPORT=codex-app-server`, fill in Supabase keys, and set
   `NEXT_PUBLIC_DEMO_MODE=false`.
4. **Host it**: `deploy/pi/` (Docker, linux/arm64, the Raspberry Pi this game
   lives on — see its README and HANDOFF) or `deploy/vps/install.sh` (any
   Ubuntu/Debian VPS, one `curl | sudo bash`). Both run the app as a single
   always-on Node process where Codex app-server can run locally. Serverless
   hosts are not a target.

## Commands

```bash
pnpm dev        # run the web app
pnpm build      # production build
pnpm typecheck  # tsc across all packages
pnpm test       # vitest across all packages (engine determinism suite etc.)
```

## Architecture

```text
Player ──► Chief of Staff (LLM) ──► ActionIntent ──► Validator ──► World Engine
                                                        ▲             │
World Director (LLM) ── structured modifier proposals ──┘             ▼
NPC strategists (LLM/rules) ◄──────────── visible state ◄──────── Supabase
```

- **Deterministic resolver** — `S_{t+1} = F(S_t, actions, modifiers, seed)`;
  an append-only `sim_events` ledger makes every price move explainable.
- **Truth vs belief** — markets price public information and rumours, not the
  database; leaks, guidance and credibility are gameplay.
- **Frontier Map** — a typed, session-mutable technology graph: what this
  world currently *believes* the future looks like. Players can propose novel
  research theses that become real nodes.
- **Tiered agents** — a handful of major rivals get full LLM deliberation;
  background companies run deterministic archetypes until they matter.

See `docs/` for the full design: game design, simulation, economy, LLM
contracts, world events, government contracting, markets, and UI system.

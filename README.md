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
| Frontend + API | Next.js (App Router) on **Vercel** |
| Canonical state, auth, realtime | **Supabase** (Postgres, RLS, Broadcast) |
| All LLM roles | **Claude Code sessions** — Claude Agent SDK, subscription OAuth, **Sonnet** |
| Engine | Pure TypeScript deterministic simulation (`packages/simulation`) |

No OpenAI/ChatGPT dependency anywhere.

## Quickstart (demo mode — no keys required)

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. Demo mode runs a fully local, deterministic
single-player session: the real engine, seeded world, rule-based NPC rivals,
and every screen live — no Supabase project or Anthropic key needed.

### Turning on the live model without editing a file

Open **Settings → AI · Claude** (the gear in the status bar, or the "Offline"
chip beside it). Three ways to connect, all with no restart:

- **Connect with Claude (subscription)** — tap the button, a link comes out, tap
  *Open Claude to approve*, approve, and paste the code the page shows back into
  the panel. The server runs the same OAuth flow as `claude setup-token` and
  stores the token for you. No terminal.
- **Paste a token or API key** — an `sk-ant-api…` key, or a subscription token
  from `claude setup-token`.

The status dot flips to **Live · sonnet** and every role — World Director, Chief
of Staff, NPC rivals, characters — runs on Sonnet. **Test connection** spends one
real call to prove it; **Disconnect** falls back to whatever the environment
supplies. A pasted or connected token lives in that one server process and is
never written to disk or stored in the browser.

**On the public (Vercel) game, use an API key for live AI.** The subscription
transport spawns the Claude Code CLI as a subprocess, which serverless functions
cannot do — so a subscription token there is *connected but runs only when
self-hosted*, and the panel says exactly that instead of a false "Live". Paste an
`sk-ant-api…` key (or set `LLM_TRANSPORT=api` + `ANTHROPIC_API_KEY`) for live AI
on the hosted game; keep the subscription path for `pnpm start` on your own
machine, a container, or a VM.

**Who may set it.** On your own machine the form is offered to the local
connection only — a dev server listens on every interface, and nobody else on
your network should spend your subscription. On a **public deployment** with no
Supabase admin, set `LLM_SETUP_SECRET` to a long random string: the panel then
shows a one-time **Unlock setup** field, and whoever has the secret can connect.
Reached over the network with neither, it says so and names the alternatives
(`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` in the env, `LLM_SETUP_SECRET`, or
`LLM_TOKEN_SETUP=local` behind a proxy). See `docs/DEPLOYMENT.md` § 5.1–5.2.

## Full stack setup

1. **Supabase**: create a project, then `supabase db push` (or apply
   `supabase/migrations/*.sql` in order) and load `supabase/seed.sql`.
2. **Claude (OAuth, no API key)**: run `claude setup-token` with your Claude
   subscription and put the result in `CLAUDE_CODE_OAUTH_TOKEN` — or paste it
   into **Settings → AI · Claude** in the running app, which needs no restart
   but lives only in that server process. Every in-game LLM role (World
   Director, Chief of Staff, NPC rivals, characters) runs as a Claude Code
   session on **Sonnet** through the Claude Agent SDK.
3. **Env**: copy `.env.example` to `apps/web/.env.local` and fill in the
   Supabase URL/keys and the OAuth token; set `NEXT_PUBLIC_DEMO_MODE=false`.
4. **Vercel**: import the repo, set the root directory to `apps/web`, add the
   same environment variables, deploy. Because Vercel functions are serverless,
   the `claude-session` subprocess **cannot spawn there** — set
   `LLM_TRANSPORT=api` and `ANTHROPIC_API_KEY` for live AI on the hosted game
   (or let a player paste an `sk-ant-api…` key in-app). The subscription path is
   for self-hosting on a normal Node process. To let players set the credential
   in-app on the public deployment, also set `LLM_SETUP_SECRET` to a long random
   string and share it with them (§ 5.1 of `docs/DEPLOYMENT.md`).

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

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

Run `claude setup-token`, then open **Settings → AI · Claude** (the gear in the
status bar, or the "Offline" chip beside it) and paste the token. The status
dot flips to **Live · sonnet** and every role — World Director, Chief of Staff,
NPC rivals, characters — runs on Sonnet from that moment. **Test connection**
spends one real call to prove it; **Disconnect** falls back to whatever the
environment supplies.

The pasted token lives in that one server process and is never written to disk
or stored in the browser, so it is the right path for `pnpm dev` and
`pnpm start` on your own machine. A multi-instance deployment (Vercel) starts
each instance empty — set `CLAUDE_CODE_OAUTH_TOKEN` in the environment there.

The form is offered only when the request comes from the machine the server is
running on: a dev server listens on every interface, and nobody else on your
network should be able to set the credential their calls — and your Claude
subscription — would be spent on. Reached over the network it says so and
explains the two alternatives (`CLAUDE_CODE_OAUTH_TOKEN`, or `LLM_TOKEN_SETUP=local`
when the deployment really is a local one behind a proxy or in a container).

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
   same environment variables, deploy. LLM routes run on the Node.js runtime
   (the Agent SDK spawns a Claude Code session per call). If your Vercel plan
   can't run them, self-host the resolver worker (`docs/DEPLOYMENT.md`) or
   set `LLM_TRANSPORT=api` as fallback.

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

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

## Full stack setup

1. **Supabase**: create a project, then `supabase db push` (or apply
   `supabase/migrations/*.sql` in order) and load `supabase/seed.sql`.
2. **Claude (OAuth, no API key)**: run `claude setup-token` with your Claude
   subscription and put the result in `CLAUDE_CODE_OAUTH_TOKEN`. Every
   in-game LLM role (World Director, Chief of Staff, NPC rivals, characters)
   runs as a Claude Code session on **Sonnet** through the Claude Agent SDK.
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

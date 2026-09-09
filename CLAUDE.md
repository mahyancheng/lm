# Frontier Capital

An LLM-powered AI corporate grand-strategy simulation: a persistent AI-industry
economy in which every important company and character has goals, memory and
agency; an LLM World Director perturbs a deterministic economic simulation;
players build companies, negotiate, invest, win government contracts, control
boards and compete against humans and AI founders.

**Stack:** pnpm monorepo · TypeScript · Next.js (self-hosted: the owner's
always-on Raspberry Pi via `deploy/pi`, the only deployment target) · Supabase (Postgres,
Auth, Realtime) · Claude via **Claude Code sessions** (Claude Agent SDK with
subscription OAuth, **Sonnet** for every in-game role).
There is no OpenAI/ChatGPT dependency anywhere in this project.

## The one-sentence architectural rule

> LLMs are allowed to think, propose, negotiate, communicate and reinterpret
> the future; only the simulation engine is allowed to make reality.

## Simulation rules (non-negotiable)

1. Supabase Postgres is canonical state. In demo mode, the in-memory store is
   canonical — same engine, same invariants.
2. The client is never authoritative.
3. LLM output never writes state directly. Every LLM result is a *proposal*
   validated by zod schemas in `@frontier/contracts`, then bounds-checked by
   the engine before any mutation.
4. All quarter resolution is server-side and deterministic:
   `S_{t+1} = F(S_t, actions, modifiers, seed)`. Same state + same recorded
   decisions + same seed = same outcome. No `Math.random()` in the engine —
   use the seeded RNG from `@frontier/shared`.
5. No arbitrary LLM-generated JavaScript executes in clients. The Frontier Map
   is a typed `TechGraph` rendered by trusted React/SVG code.
6. Every economic mutation creates a `sim_event` (append-only ledger).
7. Share ownership must always reconcile to issued shares; balance-sheet
   invariants must pass before a quarter commits.
8. Quarter resolution is idempotent — a quarter cannot resolve twice.
9. Private facts (canonical reality) do not automatically become public
   (market belief). Markets price beliefs, not the database.
10. LLM outage has deterministic fallback behaviour (`packages/llm` fallback
    strategies); the game never blocks on a model.
11. Database schema changes require migrations in `supabase/migrations`.
12. Every new gameplay feature requires deterministic tests.

## Repository layout

- `apps/web` — Next.js App Router frontend + API routes (deployed as one
  always-on Node process on the owner's Pi via the `deploy/pi` Docker kit;
  Vercel and Render are retired — do not add deployment config for them).
- `packages/contracts` — zod schemas + types: the single source of truth for
  world state, actions, GM proposals, tech graph, deals, sim events, and the
  subsystem interfaces the engine implements.
- `packages/simulation` — deterministic world engine: economy, markets,
  companies, research, government, boards, relationships, resolver.
- `packages/llm` — Claude gateway: World Director, Chief of Staff, NPC
  strategists, character dialogue, innovation interpreter. Transport-pluggable:
  the default `claude-session` transport drives Claude Code sessions through
  `@anthropic-ai/claude-agent-sdk` `query()` (OAuth subscription auth via
  `CLAUDE_CODE_OAUTH_TOKEN` or the local Claude Code login; model `sonnet`;
  no tools, single turn, JSON-only prompting validated by zod with one
  retry). An optional `api` transport (`@anthropic-ai/sdk`,
  `messages.parse` + `zodOutputFormat`) exists as fallback; `none` yields
  deterministic rule-based fallbacks. LLM output is always a zod-validated
  proposal — never a state write.
- `packages/shared` — seeded RNG, ids, formatting, math utilities.
- `supabase/` — migrations, RLS policies, seed data.
- `docs/` — design docs (game design, simulation, economy, LLM contracts...).

## Conventions

- Package manager: pnpm. Workspace deps use `workspace:*`.
- Packages export TypeScript source directly (`main: src/index.ts`); the Next
  app transpiles them via `transpilePackages`. Do not add build steps to
  packages.
- Pinned versions: TypeScript 5.9.3, zod 3.25.76, Next 15.5.24, React 19.2.8,
  Tailwind CSS 4 (via `@tailwindcss/postcss`), `@anthropic-ai/sdk` 0.122.0.
- Commands: `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm dev`.
- LLM usage: all in-game roles run on **Sonnet** through the `claude-session`
  transport (Claude Agent SDK, OAuth). Never require an `ANTHROPIC_API_KEY`
  for the default path. If touching the fallback `api` transport: adaptive
  thinking is the default (never send `budget_tokens`); use typed error
  classes; use `messages.parse` with `zodOutputFormat`.

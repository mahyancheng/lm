# LLM Contracts

Frontier Capital has no single "AI" process. It has **seven specialised roles
with sharply separated authority**, governed by one rule:

> **LLMs are allowed to think, propose, negotiate, communicate and reinterpret
> the future; only the simulation engine is allowed to make reality.**

`@frontier/contracts` is where that rule is made mechanical: every model result
is a *proposal*, parsed by a zod schema there and bounds-checked by the engine
before any mutation. `packages/llm` calls the models and has no write access to
state of any kind.

## 1. Role architecture

```text
                       WORLD DIRECTOR / GM
                       structured modifiers
                                 │
                                 ▼
PLAYER ──► CHIEF OF STAFF ──► ACTION VALIDATOR ──► WORLD ENGINE
                                 ▲                       │
                                 │                       ▼
                       NPC DECISION AGENTS ◄──────────  STATE
                 (CEO agents · character agents · media agents)
```

| Role (`AgentRole`) | Sees | Produces |
|---|---|---|
| `world_director` | World digest, event candidates, impact budget | Event proposals and modifiers |
| `chief_of_staff` | The player's own state, in full | `ActionIntent` objects |
| `npc_strategist` | Only what that company could know | An `NpcActionBundle` |
| `character_dialogue` | One character's traits, memory, ties | A reply and optional commitment |
| `innovation_interpreter` | The Frontier Map and company resources | An `InnovationProposal` |
| `social_author` | An actor's intent and audiences | A `SocialPostDraft` |
| `narrator` | Committed ledger events only | Prose describing what happened |

The distinction between **World Director** and **Chief of Staff** is the
most important one in the architecture. The **World Director is mostly
invisible**: it does not narrate the player's story; it sees a world-state summary
and the candidate skeletons the hazard engine already drew, and outputs legal
modifier proposals. It is never asked what should happen to a specific player,
and never sees a player's private state.

The **Chief of Staff is conversational** — the interface through which the player
talks to the game: *"What worries you most this quarter?"*, *"What happens if we
cut prices by half?"*, *"I don't care about growth next year, get us
profitable."* It reads state, explains options and translates intention into
`ActionIntent` objects. It never submits anything.

## 2. Authority boundaries

| A role **may** | A role **may never** |
|---|---|
| Propose an event and the variables it moves | Choose whether the event fires, or its family |
| Propose a modifier value inside the impact budget | Write a world variable directly |
| Interpret a player instruction into typed actions | Submit an action, or bypass a confirmation |
| Decide what an NPC company *attempts* | Decide whether the attempt succeeds |
| Produce a conditional commitment from dialogue | Change a director's support score |
| Draft a social post | Compute reach, engagement or sentiment shifts |
| Propose a new Frontier Map node | Add it to the graph, or set its real cost |
| Narrate committed ledger rows | Introduce a number that was not supplied |

Three enforcement layers stand behind that table, and all three must pass:

1. **Schema.** Output is parsed by the role's schema; a parse failure is retried
   once with error feedback, and a second failure engages the deterministic
   fallback. `LlmValidationResult` records `ok`, `schemaName`, `issues`, `repaired`.
2. **Bounds.** The engine checks target paths against `WORLD_TARGET_PATHS`,
   magnitudes against the `ImpactBudget`, actions against affordability and
   ownership, node proposals against real resources. Values are clamped and the
   clamps logged.
3. **Ledger.** Anything surviving both layers emits a `SimEvent`. No event, no
   effect.

## 3. Per-role contracts

Every schema below lives in `@frontier/contracts`. `AGENT_OUTPUT_SCHEMA_NAMES`
maps role to output schema, so a role can never be wired to the wrong one.

### 3.1 World Director

- **Input:** `WorldDirectorInputSchema` — session, quarter label, prose world
  summary, a `WorldVariableReading[]` digest with deltas, per-sector conditions,
  `WorldEventCandidate[]`, the `ImpactBudget`, recent events (so cascades read as
  consequences), active modifier summaries, every legal target path, known sector
  ids and style guidance.
- **Output:** `GmProposalBatchSchema` — up to 8 `GmEventProposal`s plus a
  `quarterSummary`. **An empty array is a legitimate and often correct answer.**
  Each carries a `GmProposedEvent` (candidateId echoed verbatim, or `"novel"`),
  up to 12 `WorldModifierProposal`s, a `rationale` for the designer log and the
  Quarter Resolution report, and a `confidence`.

```json
{
  "event": {
    "candidateId": "cand_q7_compute_1", "familyId": "fam_compute_supply",
    "type": "compute_supply_shock", "titleKey": "advanced_packaging_disruption",
    "title": "Advanced packaging capacity disrupted",
    "description": "…two to four sentences of in-world reporting…",
    "severity": 0.63, "visibility": "public", "durationQuarters": 3,
    "causalParentId": null, "affectedSectorIds": ["semiconductors", "cloud_infrastructure"]
  },
  "modifiers": [
    { "target": "world.compute.acceleratorSupply", "operation": "multiply", "value": 0.84,
      "decay": "linear", "durationQuarters": 3, "reason": "Packaging is the binding constraint." },
    { "target": "world.compute.spotPrice", "operation": "multiply", "value": 1.24,
      "decay": "linear", "durationQuarters": 3, "reason": "Scarce supply repriced on the spot market." },
    { "target": "sector.semiconductors.sentiment", "operation": "add", "value": 0.11,
      "decay": "exponential", "durationQuarters": 2, "reason": "Pricing power accrues to incumbents." }
  ],
  "rationale": "…", "confidence": 0.78
}
```

The engine checks that these targets exist, that the operations are permitted on
them, that values fall inside the impact budget, that the duration is reasonable
and that the event does not contradict an active modifier. **Only then does it
alter the world.** That is the distinction from a game master saying "a chip
shortage occurs and your share price crashes": the latter is storytelling, the
former is simulation.

### 3.2 Chief of Staff

The Chief of Staff answers questions, gives advice and translates instructions.
`mode` on the output says which of the three this reply is — `answer`, `plan`,
`act` — and only the last two carry actions.

- **Input:** `ChiefOfStaffInputSchema` — the player's message, the route they
  asked from, a **typed dossier** (`ChiefOfStaffDossierSchema`), the compact
  server-side `memory` of this thread, and the prose company and world
  briefings, budget lines, open decisions, conversation history and
  auto-execute flag that predate it. The prose fields are filled from the same
  state as the dossier and kept for callers that send no dossier.
- **Output:** `ChiefOfStaffInterpretationSchema` — a `mode`, the `reply` the
  founder reads, up to 12 `ActionIntent`s (empty in `answer` mode), a
  plain-language `summary` for a glance-check, `questions` it needs answered,
  `requiresConfirmation`, a `confidence` (below 0.7 the interface presents a
  draft) and `unsupportedRequests`, said plainly rather than silently dropped.

**The dossier** carries finances with the last eight filed `FinancialQuarter`s,
product lines, people, board and ownership, markets, capital, research,
government, the ten public-record items that name this company, what is waiting
on the founder — and `availableActions`. That last section is produced by
`availableActionsFor` in `@frontier/simulation`, which **probes the engine's own
validator** once per action type: an entry says whether the action would be
accepted today, the validator's own sentence when it would not, whether it
becomes a board matter, the bounds on every numeric field (tightened to whatever
the validator's clamp allowed) and the legal targets. It is derived, never
described alongside the rules, so it cannot drift from them. The role is
instructed to propose nothing the list marks unavailable.

**Memory.** The Claude session is resumed by the derived conversation key, and a
bounded `ChiefOfStaffMemory` is held server-side under the same key: the last
eight exchanges and up to six standing preferences, each stamped with the
quarter it came from. That is what survives the restarts and compactions that
take a transcript.

**Offline.** With no transport the route does not answer null. `offlineChiefOfStaff`
answers cash, runway, burn, best and worst product, who is circling us, what
needs deciding and what is possible, by arithmetic over the same dossier, and
interprets nothing into an action. Answering is safe without a model;
translating an instruction into a binding proposal is not.

`requiresConfirmation` is advisory only. The binding rule is the fourteen types
in `CONFIRMATION_REQUIRED_ACTIONS`, checked by the engine: `raise_round`,
`issue_debt`, `buyback`, `issue_shares`, `ipo`, `set_dividend_policy`,
`acquire_company`, `layoff`, `bid_government`, `submit_board_proposal`,
`propose_deal`, `accept_deal`, `sell_shares`, `buy_shares`. Any of those with
`confirmedByHuman === false` is rejected with `confirmation_required`.

### 3.3 NPC strategist

- **Input:** `NpcStrategistInputSchema` — its own position in full; world
  conditions as that company would understand them; **public information only**
  about rivals; visible procurement; incoming deals; last quarter's posture and
  strategy (so behaviour has continuity); hard constraints.
- **Output:** `NpcActionBundleSchema` — `companyId`, `strategySummary`, a
  `CompanyPosture`, at most 8 `ActionIntent`s and a `rationale`.

```json
{ "companyId": "cmp_nexus_ai", "posture": "aggressive_growth",
  "strategySummary": "Lock supply before the shortage prices in…", "rationale": "…",
  "actions": [
    { "type": "reserve_compute", "units": 45000, "quarters": 6, "maxPricePerUnitUsd": 20000 },
    { "type": "raise_round", "stage": "series_d", "targetAmountUsd": 1200000000, "maxDilutionPct": 0.16 }
  ] }
```

The engine resolves whether those attempts succeed. Rival private state is never
in the input; an NPC that "knows" a secret is a bug in the input builder.

### 3.4 Character dialogue

- **Input:** `CharacterUtteranceContextSchema` — the speaking `Character` with
  traits and beliefs; the `Relationship` in both directions (characters sense
  asymmetry); `Memory[]` strongest first; the topic; verified `GameFact[]`;
  conversation history; the `accessBasis`; any pending proposal.
- **Output:** `CharacterReplySchema` — `text` (≤1200 chars), a nullable
  `ConditionalCommitment`, `RelationshipDeltas` (−10..10 per dimension; most
  conversations move trust by 0 to 2) and a nullable `MemoryDraft`.

Characters argue from supplied facts and may not invent others. A conversation
never changes a support score; it can only produce a machine-checkable promise:

```json
{
  "actorCharacterId": "chr_sarah_zhou", "proposalKind": "acquisition", "stance": "support",
  "conditions": [
    { "field": "purchasePriceUsd", "comparator": "lte", "value": 5500000000 },
    { "field": "stockComponentPct", "comparator": "gte", "value": 0.35 }
  ],
  "commitmentStrength": 0.86, "expiresQuarter": 19, "targetCompanyId": "cmp_vector",
  "rationale": "Their enterprise retention is deteriorating…"
}
```

Negotiation matters because a character has committed to something a machine can
verify (`commitmentConditionsHold`).

### 3.5 Innovation interpreter

- **Input:** `InnovationInterpreterInputSchema` — the player's idea in their own
  words, the current Frontier Map, the company's real capabilities and resources,
  and world context bearing on feasibility.
- **Output:** `InnovationProposalSchema` — title, summary, `novelty`,
  `plausibility` (be honest: a low-plausibility proposal is not rejected, it
  becomes an expensive speculative node), required capabilities, estimated cost
  and duration, dependencies on existing node ids, visibility and a rationale.

The rules engine then returns an `InnovationIntegrationResult` with an
`adjustedPlausibility`, `adjustedCostUsd` and `adjustedQuarters` — which may be
far higher than the proposer estimated. If accepted it becomes **a real node in
that session's technology graph**, credited to its inventor for the session.

### 3.6 Social author

- **Input:** `SocialAuthorInputSchema` — who is posting, the network archetype,
  the `PostIntent`, the situation, the account's real audience mix and hard
  constraints (undisclosed material information, confidential terms).
- **Output:** `SocialPostDraftSchema` — author, network, ≤560 characters of text,
  intent and an optional target company.
- The model writes the words. **The engine computes everything else**: reach as
  credibility × follower graph × relevance × novelty, engagement, per-audience
  `SentimentShift`s, press pickup and competitor hostility. A model cannot state
  that developer sentiment rose twelve points.

### 3.7 Narrator

- **Input:** `NarratorInputSchema` — `committedLines`, every one of which already
  traces to a committed ledger event. **These are the only facts available.**
- **Output:** `NarratorOutputSchema` — a headline, two to five short paragraphs
  and a tone the facts support; never a number that was not supplied. The
  narrator explains what the simulator did; it decides nothing.

**Deal extraction** is a supporting contract rather than an eighth role:
`DealExtractionSchema` watches a conversation for an emerging agreement and
returns `dealDetected`, a nullable `DealProposalDraft`, a `confidence` (below 0.6
the interface shows a suggestion rather than pre-filling) and `ambiguities`.
Detecting a deal never creates one — see [MULTIPLAYER.md](./MULTIPLAYER.md).

## 4. LLM-facing schema discipline

Schemas handed to a model obey a strict subset so they survive structured
outputs intact: every field required (`.nullable()`, never `.optional()`);
explicit `z.enum` for every categorical value; `z.number()` with `.describe()`
documenting bounds and units; no `z.record`, no `.transform`.
`z.discriminatedUnion` is fine and used heavily (`ActionIntentSchema`,
`DealObligationSchema`).

Bounds are expressed **twice on purpose**: as `.min()`/`.max()` so the package
validates locally whatever the provider does with the constraint keyword, and in
prose inside `.describe()` so the model reads them.

The sixteen LLM-facing schemas: `GmEventProposalSchema`, `GmProposalBatchSchema`,
`WorldModifierProposalSchema`, `NpcActionBundleSchema`, `ActionIntentSchema`,
`ChiefOfStaffInterpretationSchema`, `InnovationProposalSchema`,
`ConditionalCommitmentSchema`, `CharacterReplySchema`, `MemoryDraftSchema`,
`SocialPostDraftSchema`, `GovernmentBidSchema`, `DealProposalDraftSchema`,
`DealObligationSchema`, `DealExtractionSchema`, `NarratorOutputSchema`.
Internal/state schemas use optionals, records and defaults freely and are
**never** handed to a model.

## 5. Tiered agent economics

Not every company gets an expensive deliberation every quarter.

| Tier | Population | Decision method | Calls / quarter |
|---|---:|---|---:|
| `major` | 4–10 companies | Full LLM strategic planning | 1 each |
| `significant` | 20–50 companies | Rule strategy + occasional LLM | ~1 per 4 quarters each |
| `background` | Hundreds | Deterministic archetype AI | 0 |
| Named characters | Important subset | LLM when interacted with or event-relevant | on demand |

A background startup becomes a detailed agent only when it becomes strategically
relevant — when a player begins evaluating it for acquisition, say. That yields a
huge living economy without hundreds of agent conversations every turn.

Per-quarter call budget for a standard single-player session:
`world_director` 1 · `chief_of_staff` 0–6 (only when the player types) ·
`npc_strategist` 6 majors + ~8 significant rotation · `character_dialogue` 0–10 ·
`innovation_interpreter` 0–1 · `social_author` 0–4 · `narrator` 1 —
**typically 16–25 calls per resolved quarter.**

Cost controls — tiering, prompt caching of the stable prefix, per-quarter budgets
and role-level disabling — are in [DEPLOYMENT.md](./DEPLOYMENT.md).

## 6. Run logging and reproducibility

Every important LLM result is written as an `AgentRunRecord`: `id · sessionId ·
quarter · agentRole · agentVersion · modelId · schemaVersion · contextHash ·
inputStateVersion · structuredOutput · validationResult · engineResult · latencyMs
· tokens{input,output} · fallbackUsed · error`.

- `agentVersion` versions the prompt and tooling, so a behaviour change is
  attributable; `schemaVersion` records `CONTRACTS_VERSION`, so an old logged
  output can always be interpreted.
- `contextHash` hashes the exact input and `inputStateVersion` is the state hash
  at call time; two runs with the same pair and model are comparable.
- `engineResult` records what the engine did after bounds checking: accepted,
  clamped or rejected. `latencyMs` and `tokens` are diagnostics and cost tracking
  — **neither is ever an input to the simulation.**

Rows live in `agent_runs`, which is service-role only with **no RLS policy at
all**: raw model output and rejected proposals are never readable by a client.
This makes bugs reproducible and replays honest — a deterministic replay uses the
*recorded* structured output rather than re-calling a model, so it reproduces the
session exactly even if the model has since changed.

## 7. Deterministic fallback behaviour

**An LLM outage is a degraded quarter, never a blocked one.** Every role has a
deterministic fallback in `LLM_FALLBACK_STRATEGIES`:

| Role | Fallback |
|---|---|
| `world_director` | Apply the candidate skeletons using their family template modifiers at the drawn severity. The quarter still has weather; it just has less character. |
| `chief_of_staff` | Fall back to the normal controls. The player submits through the interface; nothing is auto-interpreted. |
| `npc_strategist` | Run the deterministic archetype policy for that company's posture — the same policy background-tier companies always use. |
| `character_dialogue` | Return a short templated reply consistent with traits and relationship, and store **no** commitment. Commitments are never fabricated by a fallback. |
| `innovation_interpreter` | Decline the proposal with an explanation and leave the Frontier Map unchanged. A node is never added without interpretation. |
| `social_author` | Publish nothing. Structured marketing campaigns still run; personal posting is simply unavailable that quarter. |
| `narrator` | Render the resolution report lines directly. They are already human-readable by construction. |

Each engagement writes an `LlmFallbackRecord` with a reason from `timeout`,
`rate_limited`, `invalid_output`, `api_error` or `disabled`. Sessions stay
deterministic and playable straight through an outage — which is why
`LLM_TRANSPORT=none` is supported, and is the basis of demo mode.

## 8. Transports

`packages/llm` is transport-pluggable; `LLM_TRANSPORT` selects one:

| Transport | Mechanism | Auth | Model |
|---|---|---|---|
| `claude-session` *(default)* | Claude Code sessions via `@anthropic-ai/claude-agent-sdk` `query()` | `CLAUDE_CODE_OAUTH_TOKEN` (subscription OAuth) | `sonnet` |
| `api` *(fallback)* | `@anthropic-ai/sdk` `messages.parse` | `ANTHROPIC_API_KEY` (metered) | `claude-sonnet-5` by default |
| `none` | No model at all | — | — |

The default path is deliberately **not** metered API billing: it drives Claude
Code sessions with the operator's subscription OAuth token, generated with
`claude setup-token`. Calls are single-turn, tool-free, JSON-only prompting
validated by zod with one retry; never require an `ANTHROPIC_API_KEY` for it.
`none` yields the rule-based fallbacks for every role and is what demo mode runs
on — which is why demo mode needs no credentials at all.

## 9. Anthropic API conventions (the `api` transport)

These conventions are mandatory when touching the fallback transport.

**Structured outputs.** Use `messages.parse` with `zodOutputFormat`, never
hand-rolled JSON prompting:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GmProposalBatchSchema } from '@frontier/contracts';

const response = await new Anthropic().messages.parse({
  model: 'claude-sonnet-5',
  max_tokens: 16000,
  system: worldDirectorSystemPrompt,   // stable prefix — cache this
  messages: [{ role: 'user', content: renderWorldDirectorInput(input) }],
  output_config: { format: zodOutputFormat(GmProposalBatchSchema) },
});

// parsed_output is null when parsing failed — guard, never assert blindly.
const batch = response.parsed_output;
if (batch === null) return fallback('invalid_output');
```

**Model ids.** Every role runs on Sonnet — `sonnet` through the default
`claude-session` transport, `claude-sonnet-5` (env `ANTHROPIC_MODEL` override)
on the `api` fallback. Use the exact id string — never append a date suffix.
**Thinking** is adaptive (`thinking: { type: 'adaptive' }` where used); **never
send `budget_tokens`**, which is rejected on current models.

**Typed errors.** Use the SDK's exception classes, most specific first, never
string matching:

```ts
try { … } catch (e) {
  if (e instanceof Anthropic.RateLimitError)      return fallback('rate_limited');
  if (e instanceof Anthropic.BadRequestError)     return fallback('invalid_output');
  if (e instanceof Anthropic.AuthenticationError) return fallback('disabled');
  if (e instanceof Anthropic.APIError)            return fallback('api_error');
  throw e;
}
```

**Caching.** The stable per-role system prefix carries
`cache_control: { type: 'ephemeral' }`; volatile content — the quarter digest,
the candidate list — goes *after* the breakpoint. Verify with
`usage.cache_read_input_tokens`; a persistent zero means a silent invalidator.

**Never in a prompt.** Another company's private state, `isTruthful` on a
disclosure, a rival's `confidenceByCompany` entry or secret research programme,
or any player's real-world identity.

## 10. Generated interface, not generated code

The Frontier Map and every other generative surface follow one pipeline:
`LLM → TechGraph JSON → schema validation (TechGraphSchema) → gameplay
validation → Supabase → trusted React/SVG renderer → dynamic UI`. The interface
**is** generative — nodes, topology, confidence, descriptions and visual emphasis
all change dynamically — but the model cannot inject scripts, because it never
produces markup or code, only typed data.

> **LLM proposes semantics; trusted game code renders and executes them.**

Invariant `tech_graph_safety`. It applies to every screen.

## 11. Context and session continuity

A Claude Code session is never blank, but the two interaction shapes get their
context differently:

**Strategic calls are fresh sessions opened with a composed dossier.** The
World Director's quarterly proposal and each NPC strategist's planning call
start a new session whose prompt is built by the gateway's per-role
`ContextComposer` from canonical state: the character's stable traits and
current beliefs, relationship scores toward every relevant actor, `memories`
rows, and its own past decisions with their engine outcomes (from
`agent_runs`). Rebuilding context per call is what *enforces* the information
boundary — an NPC is told only what its company could plausibly know, and
nothing it saw in a previous life can leak past the composer. It also keeps
40-quarter campaigns inside any context window and makes every decision
replayable from `AgentRunRecord.contextHash`.

**Conversations are persistent sessions, resumed by id.** A game conversation
(Chief of Staff thread, a negotiation with a director) maps 1:1 to one Claude
Code session. The Agent SDK's `resume` option continues it on every message,
so dialogue has genuine multi-turn memory. The mapping lives in the
service-role-only `conversation_llm_sessions` table (migration 0017); clients
never see it. When a conversation goes quiet, its game-relevant residue is
distilled into structured state — a `ConditionalCommitment`, relationship
deltas, a `Memory` draft — and *that* is what future dossiers contain. The
transcript is disposable; the database is the long-term memory.

Quarterly memory consolidation applies `Memory.decayRate` so old grudges fade
unless reinforced — characters remember how you treated them, at the
resolution the engine chooses, not at raw-transcript resolution.

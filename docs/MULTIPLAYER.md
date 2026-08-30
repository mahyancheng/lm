# Multiplayer

Multiplayer is designed around **shared session worlds**, not a global chat
room. A session is one world, one seed, one canonical timeline of quarters and a
fixed roster of participants.

```text
1–8 human founders · 4–10 major AI competitors
20–50 significant simulated companies · hundreds of background companies
Investors · Government agencies · Media · Employees · Customers
```

A solo session simply contains one human and more AI-controlled companies. The
same engine, the same invariants, the same schema.

## 1. One world, one set of events

The interesting property of a shared session is that every player faces **the
same world events**. We never give players different random disasters to
manufacture variety.

```text
GLOBAL SHOCK · GPU supply -22%

Player A: Secures long-term reservations
Player B: Pivots toward smaller models
Player C: Acquires a distressed infrastructure startup
Player D: Signs a compute-sharing arrangement with Player B
Nexus (NPC): Raises $3B and locks supply
Government: Launches a domestic semiconductor programme
```

Strategic divergence comes from decisions against a shared constraint. That is
also why the same session produces a genuine conversation afterwards: everyone
was in the same weather.

## 2. Asynchronous quarter cadence

The mode is **asynchronous, quarter-based**. There is no real-time economic
race.

```text
QUARTER OPENS
  ↓ PLANNING WINDOW      (hours or days of wall-clock, configurable)
    Operate company · Talk to NPCs · Talk to reachable players
    Negotiate deals · Campaign publicly · Adjust research
    Prepare bids · Lobby boards · Submit quarter instructions
  ↓ LOCK                 all players submitted, or the window closes
  ↓ RESOLUTION           one canonical state, eighteen phases
  ↓ QUARTER RESOLUTION REPORT   delivered to every player simultaneously
```

`SessionPlayer.hasSubmittedThisQuarter` gates the lock. `SessionStatus` moves
`active → resolving → active`, and no action may be submitted while the resolver
runs.

Because everything resolves against one state, **"who clicked first" is never
economically decisive.** `SubmittedAction.sequence` exists only as a
deterministic tie-break when two actions compete for the same scarce resource —
the same cash, the same accelerators, the same shares. It is documented as a
tie-break, not a race, and the UI never surfaces it as a timer.

Wall-clock time appears in exactly one place: the length of the planning window,
which is session configuration, not simulation state. No engine code reads a
clock.

## 3. Connection level versus relationship

Two concepts, deliberately kept apart:

```text
CONNECTION LEVEL   How powerful this person is.     Gates who may open a channel.
RELATIONSHIP       How one actor feels about        Shapes how that conversation
                   another.                         goes.
```

`Character.connectionLevel` is a 0–100 score computed from ten inputs
(`ConnectionLevelInputs`), recomputed every quarter in `relationship_update`:

```text
founderReputation · companySignificance · personalWealth · boardPositions
investorRelationships · governmentCredibility · mediaInfluence · priorExits
publicFollowing · mutualRelationshipQuality
```

It is emphatically **not** follower count. `publicFollowing` is one input of
ten, and `mutualRelationshipQuality` — knowing three powerful people well counts
for more than knowing thirty slightly — carries real weight.

`Relationship` is directional and four-dimensional: `trust`, `respect`,
`hostility`, `dependence`, each 0–100. A rival can respect the player deeply
while trusting them not at all. A can respect B while B is indifferent to A.
"Likes you" is not one number.

## 4. The access rule

```text
gap = | connectionLevel(a) - connectionLevel(b) |

gap ≤ 10   →  either party may initiate
gap > 10   →  only the higher-connection actor may initiate, downward
```

`CONNECTION_GAP_RULE.symmetricGap` is 10, and `canInitiateContact` is a pure,
deterministic check.

```text
Player A 72 · Player B 68 · relationship A↔B +18
→ gap 4. Either may open a channel.

Sovereign-fund chief 93 · new founder 17
→ gap 76. The founder cannot simply open a DM with one of the most influential
  people in the economy.
```

Bots use the exact same model. A rival chief executive may decide the player has
become important enough to contact personally:

> **Nexus CEO:** We don't particularly like each other, but we're both exposed
> to the same export restrictions. I think we should talk.

### Access overrides

The gap is not a wall, it is a routing problem. Eight override kinds
(`ACCESS_OVERRIDE_KINDS`):

| Kind | Duration | How it arises |
|---|---|---|
| `shared_board` | While the shared seat lasts | Both hold seats on one board |
| `shared_investor` | While both are held | A common investor |
| `consortium` | The transaction | A joint government bid |
| `introduction` | Temporary, convertible to permanent | Someone spends standing on you |
| `conference` | Time-boxed window | A session event |
| `negotiation` | The transaction | An acquisition approach, a deal |
| `litigation` | The proceeding | Forced contact, wanted or not |
| `media` | The story | A journalist puts you in the same room |

`request_introduction` is the main legitimate route upward. The person asked
must be reachable by you *and* must think well enough of you to spend their
standing — and the introducer takes a reputational stake in how it goes.

```text
Player 22 · target investor 81 · direct access: NO
  ↓ Player builds a strong relationship with Partner X (54)
  ↓ Partner X introduces the player          AccessOverride 'introduction'
  ↓ Temporary access granted                 expiresQuarter set
  ↓ Meeting occurs                           character_dialogue
  ↓ Good interaction                         trust +3, respect +5
  ↓ Permanent relationship established       isPermanent = true
```

Networking becomes gameplay rather than a number to grind. A low-status founder
can engineer a route to the top; they simply cannot skip it.

Access is enforced **server-side** by `RelationshipsSubsystem.checkAccess`,
which returns an `AccessDecision` with the gap, the reason and any override id —
and again by Supabase RLS on `conversation_participants`. Hiding the UI is not
enforcement.

## 5. Deals: the simulation knows what is binding

Human-to-human conversation may change game outcomes, but **free text never
writes state**.

One player types:

> I'll supply you 10,000 GPUs for two quarters if you let us use your retrieval
> technology.

The deal-extraction agent (`DealExtractionSchema`) detects a possible agreement
and produces a structured draft:

```text
Proposed Strategic Agreement

Player A provides:  10,000 accelerator-equivalent units · 2 quarters
Player B provides:  Enterprise licence, Retrieval Engine V3 · 4 quarters
Confidentiality:    Private

[Propose Deal]
```

Player B sees and accepts the structured proposal. **Only then does it enter the
game ledger** (`deal_proposed` → `deal_accepted` → `deal_executed`).

Extraction is conservative by contract: `dealDetected` is false for a maybe,
`ambiguities` lists terms discussed but left vague so the interface can ask the
player to pin them down, and below `confidence` 0.6 the draft is shown as a
suggestion rather than pre-filled.

### Obligations are typed

`DealObligation` is a discriminated union of eight kinds, so the engine executes
each variant without inspecting free text: `compute_supply`, `tech_license`,
`cash_payment`, `equity_transfer`, `board_vote_pledge`, `public_endorsement`,
`consortium_membership`, `investment`.

Eleven agreement patterns are supported end to end
(`SUPPORTED_DEAL_PATTERNS`): joint ventures, technology licensing, investment,
share purchases, M&A, government bid consortiums, commercial partnerships,
research collaboration, board voting arrangements, compute agreements and public
endorsements.

### Binding versus non-binding

This distinction is the whole point of the subsystem, so it is explicit in the
data.

- **Binding** — `binding: true`, `status: 'accepted'`. Obligations are
  mechanically enforced *every quarter*, not just on acceptance. A supplier who
  no longer holds the capacity is in breach: value transfers, the relationship
  is permanently damaged, and `deal_breached` hits the ledger.
- **Non-binding** — `intentStatements[]` holds things like *"We intend to
  support you next quarter."* Recorded, visible to both parties, **never
  enforced**.

That second category is not an oversight. It is what makes genuine human
bluffing possible while removing the argument:

> "But the other player promised me this in chat."

The simulation always knows what was promised and what was merely said.

## 6. Moderation and safety

Player-to-player content is a first-class product requirement, not an
afterthought.

**Account-bound.** Every message is sent either by a real player's profile or by
an NPC character flagged `is_npc = true`. There is no third state and no
anonymous sender. The database enforces it structurally, not just by policy.

**Connection-gated.** Conversations are purposeful. Participation is explicit
rows in `conversation_participants`, gated by the access rule above. **There is
no random or anonymous chat anywhere in the product**, by design.

**Reportable and blockable.** `reports` and `blocks` are among the six tables in
the entire schema with a client write path, and both are scoped to the acting
user. `SocialPost.reportedCount` surfaces on moderation queues.

**NPCs labelled.** `SocialPost.isAiGenerated` and
`ConversationMetadata.isModerated` exist so the interface can label every
AI-generated character message visibly, everywhere it appears. A player must
never be unable to tell whether they are talking to a person.

**Filtering.** Outbound player text passes a moderation check before it is
broadcast or stored; failing content is rejected at the API route, not hidden
client-side.

## 7. Realtime architecture

Postgres is the source of truth. **Realtime Broadcast** carries chat, presence
and live session updates, because Postgres Changes incurs an authorisation check
per subscribed user and scales differently.

| Channel | Read | Write |
|---|---|---|
| `session:{session_id}:events` | session members | **nobody** — server broadcast only |
| `session:{session_id}:presence` | session members | server only |
| `session:{session_id}:conversation:{conversation_id}` | participants | participants |

```ts
const channel = supabase.channel(
  `session:${sessionId}:conversation:${conversationId}`,
  { config: { private: true } },
);
```

`private: true` is required — it is what makes Realtime consult the policies.
Policies on `realtime.messages` decode the topic with `realtime.topic()` and
delegate to the same helpers the table policies use
(`is_session_member`, `is_conversation_participant`). A malformed or
unauthorised topic simply fails to join.

The event feed being **read-only for clients is the point**: a browser cannot
fabricate a world event, a market tick or a quarter commit. Chat channels accept
participant writes for latency; the durable copy still goes through the
`messages` table, so the ledger and the transcript never diverge.

## 8. Authorisation model

Supabase Auth owns credentials; the game owns identity. Every player identity is
persistent and account-bound, which is what connection-gating and moderation
both depend on.

Four visibility tiers, enforced by RLS:

1. **Public information set** — readable by any session member: companies,
   market instruments and quotes, market beliefs, public disclosures, public
   world events, agencies, opportunities, contracts, contractor reputation,
   characters, connection scores, public social posts and media stories, public
   tech nodes, leaderboards.
2. **Private company reality** — the controlling player only, via
   `owns_company(company_id)`: quarter metrics, resources, workforce, unlaunched
   products, undisclosed holdings, contract milestones, own bids, secret
   research projects.
3. **Participant-only** — conversations, messages and deal proposals via
   `is_conversation_participant()`; boardroom material via `can_see_board()`.
4. **Canonical truth** — service role only, with RLS enabled and **no policy at
   all**: `world_snapshots`, `world_modifiers`, `agent_profiles`, `agent_runs`,
   `agent_actions`. Omniscient world state, raw model output, rejected proposals
   and NPC intentions live there and a client cannot read them under any
   circumstances.

The client write surface is deliberately tiny: `player_actions` (own player,
quarter still planning), `messages` (own profile, must be a participant),
`reports`, `blocks`, `profiles` and `player_settings` — all self-scoped.
Everything else — cash, shares, prices, contracts, board outcomes, leaderboard
scores — has **no client write path whatsoever**.

## 9. Leaderboards

Session-native and server-computed. Ten boards (`LEADERBOARD_BOARDS`):

| Board | Ranking basis |
|---|---|
| `company_value` | Controlled enterprise value |
| `founder_wealth` | Personal net worth |
| `revenue` | Trailing revenue |
| `profit` | Operating and free-cash-flow performance |
| `innovation` | Frontier achievements |
| `market_influence` | Ownership and control across the industry |
| `network` | Connection level |
| `government` | Procurement credibility and strategic access |
| `reputation` | Multi-audience trust |
| `founder_index` | Composite performance |

Ten boards exist so that a technically brilliant company can lose financially, a
rich founder can lose control, and a small company can become indispensable to
governments.

Each `LeaderboardEntry` carries `rank`, `previousRank` (so the resolution screen
shows movement, not just position), the raw `value`, its `percentile` within the
session, and the `delta`.

### The Founder Index

```text
FI = .22W + .18E + .15I + .12R + .10N + .10G + .08F + .05S
```

| Weight | Component | Input |
|---:|---|---|
| 0.22 | `wealth` | Founder wealth percentile |
| 0.18 | `enterprise` | Controlled enterprise-value percentile |
| 0.15 | `innovation` | Innovation percentile |
| 0.12 | `reputation` | Multi-audience reputation percentile |
| 0.10 | `network` | Network / connection percentile |
| 0.10 | `government` | Government credibility percentile |
| 0.08 | `financialResilience` | Financial resilience percentile |
| 0.05 | `sessionObjectives` | Session objectives percentile |

**INVARIANT:** the eight weights sum to exactly 1. Every input is a **percentile
within the session, never a raw dollar amount** — otherwise wealth eventually
overwhelms every other dimension and the composite stops saying anything. The
weights live in `FOUNDER_INDEX_WEIGHTS` as data, deliberately held out of
frontend logic so they remain a balancing variable.

`founderIndex(inputs)` is pure and deterministic.

### Recomputation and integrity

Leaderboards are recomputed **server-side every quarter from the ledger**, in
phase 16. `leaderboard_snapshots` has no `INSERT`, `UPDATE` or `DELETE` policy
at all. The browser can never submit "score = 900000". That is invariant
`authoritative_backend`.

### Industry Power network

Beside the numerical boards sits a network visualisation, so players can see
*why* somebody with less wealth has more influence:

```text
                Sovereign Fund
             ┌────────┴────────┐
          Player A          Nexus AI
             │   ╲            ╱
             │    Investor X
          Board Z ── Player B
```

Nodes are characters, companies and funds; edges are holdings above a threshold,
board seats, shared investors and live deals. It is rendered from typed session
state by trusted code — the same rule as the Frontier Map.

## 10. Session lifecycle

`SessionStatus`: `lobby → active → (resolving ⇄ active) → completed | abandoned`.

`SessionConfig` is chosen at creation and immutable thereafter: player count
(1–8), difficulty, tier populations, `scenarioId`, `startYear`, an optional
`quarterLimit` (null for an open-ended sandbox), whether the reference market is
displayed, whether player innovation is allowed, and the default auto-execute
preference.

A player who leaves sets `isActive = false`; their company continues under NPC
control at its existing tier, which keeps the world coherent rather than
deleting a competitor mid-session. A returning player resumes the same
character — with every relationship and memory other characters formed about
them still in place.

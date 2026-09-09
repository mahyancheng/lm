# Markets

Two market planes and one hard rule.

- The **in-world exchange** carries the fictional securities of a session. It is
  fully simulated, has no real-money leg, and prices *beliefs*.
- The **live reference market** is an **optional** read-only tape of real-world
  instruments, supplied through an adapter. It is **disabled by default**. No
  modifier, no event and no player action may change it.

> Reality is not ours to modify. A reference quote is a fact we display, never a
> variable we simulate.

Markets resolve in phase 13 (`market_resolution`), after disclosures and before
social propagation. That ordering is what makes the information model work.

## 1. The in-world exchange

`MarketInstrument` covers both planes and distinguishes them twice: by `kind`
(`in_world_equity`, `in_world_index`, versus the five `reference_*` kinds) and
by an explicit `isReference` boolean, so a **single field guards every mutation
path**.

In-world instruments carry a `symbol`, the `companyId` and `securityId` they
price, a `sectorId` for the sector beta, `sharesOutstanding`, the
`listedQuarter` and a `beta` (1.0 moves with the market; 1.8 is a high-beta
frontier lab).

`Quote` is one instrument's price for one quarter: `price`, `return`, `volume`
and `marketCapUsd`.

> **INVARIANT (`market_integrity`):** an in-world price is never negative and
> never NaN. A price that would go non-positive is floored and the company is
> marked distressed instead. The database restates it as `CHECK (price > 0)`.

Note for implementers: `return` is a reserved word — read it as `quote.return`
rather than destructuring it bare.

History is bounded. `SessionState.quotes` retains a rolling window
(`quoteHistoryQuarters`, default 24); everything older lives in snapshots and
the ledger.

A session's exchange therefore reads:

```text
IN-WORLD EXCHANGE
Nexus Intelligence     NXS        $83.20   ▲2.1%
Orbit Dynamics         ORB        $41.72   ▼0.8%
VectorWorks AI         VWA        $18.91   ▼6.4%
Player Corporation     ---        $67.44   ▲3.7%
FCAI Index                      1,284.10   ▲1.2%
```

These are virtual securities only. There is no real-money transaction, no
conversion and no cash-out anywhere in the product.

## 2. The reference tape (optional, off by default)

Real-time equity data is a licensed product. We therefore never scrape and never
hard-code a vendor. The contract is an interface:

```ts
interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote | null>;
  getDailyBars(symbol: string, days: number): Promise<readonly Quote[]>;
  getIndex(symbol: string): Promise<Quote | null>;
  getFx(pair: string): Promise<number | null>;
  getReferenceSnapshot(): Promise<ReferenceSnapshot | null>;
}
```

`SessionConfig.enableReferenceMarket` gates it, and **the default is `false`**.
With no provider configured the game is complete: the Markets screen simply
shows the in-world exchange, and session calibration uses the scenario's seeded
constants instead of a live snapshot. Demo mode never touches it.

When a provider *is* configured, its only two jobs are:

**1. One-time calibration.** `ReferenceSnapshot` is captured at
`capturedAtQuarter` — normally quarter 0 only — and initialises:

```text
Interest-rate environment       riskFreeRate
Risk-free benchmark             → in-world discounting
Major index level               majorIndexLevel
Semiconductor sector reference  semiconductorIndexLevel
Volatility calibration          volatilityLevel → the σ of the noise term
Selected reference prices       display only
```

**2. Display.** A read-only tape beside the in-world exchange.

Once a session runs faster than real time, **its causality must branch.** A
player who progresses from 2027 Q1 to 2030 Q4 in one evening cannot have their
economy continuously overwritten with this month's real prices without
destroying cause and effect. So the snapshot is taken once and never re-applied.

The engine enforces the separation structurally: `getTargetPathSpec` has no
entry for any reference instrument, and a modifier naming one is rejected with
`targets_reference_market`.

## 3. Belief-based pricing

The stock market prices what participants **believe**, not what the database
knows. Truth and belief are stored in separate places in `SessionState` and
nothing crosses between them except through the disclosure phase.

```text
CANONICAL PRIVATE REALITY        companies · researchProjects
        │
        │  only via disclosure_resolution
        ▼
PUBLIC INFORMATION SET           disclosures
        │
        │  updateBeliefs()
        ▼
MARKET BELIEF                    beliefs
        │
        │  priceMarket()
        ▼
PRICE                            quotes
```

A `MarketBelief` is a probability the market currently assigns to a topic about
a company, a sector or the world. Fifteen topics
(`MARKET_BELIEF_TOPICS`): `model_delay`, `model_success`, `revenue_beat`,
`revenue_miss`, `margin_pressure`, `contract_win`, `contract_loss`,
`fundraise_needed`, `acquisition_target`, `acquisition_acquirer`,
`regulatory_action`, `leadership_change`, `safety_incident`,
`accounting_concern`, `talent_exodus`.

Each belief stores its `priorProbability` from last quarter so the UI can show
what moved, and `evidenceDisclosureIds` so a player can ask why the market
thinks that.

The worked case:

```text
CANONICAL PRIVATE REALITY
Model programme:  2 quarters late · cost overrun +31% · internal confidence 42%

PUBLIC INFORMATION SET
Company guidance: "on schedule", expected launch next quarter

MARKET BELIEF
Probability of delay: 26%
```

The price reflects 26%, not 100%. That gap is the game.

## 4. The pricing model

```text
r_{i,t} = β_m·M_t + β_s·S_t + α_fundamental + E_public + N_sentiment
          + L_liquidity + σ_i·ε

P_{i,t+1} = P_{i,t} · e^{r_{i,t}}
```

Fundamentals pull the price toward the `ValuationAnchor` over several quarters;
public information, sentiment and volatility create short-term deviations. The
anchor method is chosen by company maturity — see [ECONOMY.md](./ECONOMY.md) §6.

Every price move is stored as a `ReturnDecomposition` whose seven components
**must sum to `total` within 1e-9** (`returnDecompositionSums`). That invariant
is why the Markets screen can always answer "why did my stock move?" without
asking a model to invent a reason:

```text
Q19 · ORBIT INTELLIGENCE                        -4.2%

Earnings miss                                   -4.1%   publicInfoEffect
Government contract win                         +3.4%   publicInfoEffect
Sector sell-off                                 -2.2%   sectorBeta
CEO controversy                                 -1.7%   sentimentEffect
Model benchmark beat                            +0.9%   fundamentalAlpha
Noise / liquidity                               -0.5%   noise + liquidityEffect
```

The noise term is drawn from the seeded RNG. It is genuinely random-looking and
completely deterministic given the seed, which is what lets a replay reproduce a
price series exactly.

## 5. Disclosures, leaks and rumours

`PublicDisclosure` is the bridge between private reality and market belief.
Seven kinds, with sharply different credibility behaviour:

| Kind | Source | Starting credibility |
|---|---|---|
| `guidance` | The company, on the record | Near `reputation.investor` |
| `earnings` | The company, on the record | Near `reputation.investor` |
| `press_release` | The company | Slightly below guidance |
| `regulatory_filing` | Mandatory | High, and not chosen |
| `analyst_note` | Third party | Mid, weighted by that analyst's record |
| `leak` | Unattributed | Low — typically 0.2–0.4 |
| `rumour` | Unattributed | Low — typically 0.15–0.35 |

Belief update, per topic:

```text
weight  = disclosure.credibility
        × sourceStanding(sourceCharacterId)
        × topicRelevance
        × world.media.institutionalTrust adjustment

belief.probability = clamp01(
    belief.probability × (1 - weight) + assertedProbability × weight
)
```

Low institutional trust makes rumours travel further than corrections — which is
`world.media.institutionalTrust` doing exactly what it says.

### Credibility is a spendable resource

`PublicDisclosure.isTruthful` records whether a statement matched canonical
reality **at the time it was made**. It is `INTERNAL ONLY` and must never reach
a client. Next quarter, `disclosure_resolution` compares asserted `metrics`
against what actually happened and moves `reputation.investor` accordingly:
meeting guidance builds credibility slowly; missing it costs several times as
much.

The crisis arc this enables:

```text
Anonymous leak alleges model delay
 ↓
Rumour credibility = 31%              belief.probability 0.09 → 0.26
 ↓
Stock -2.4%                            publicInfoEffect
 ↓
Player denies leak                     respond_crisis · 'deny'
 ↓
Credibility temporarily recovers       belief 0.26 → 0.14, price rebounds
 ↓
Two quarters later the delay is public research_setback becomes visible
 ↓
Market discovers the denial was misleading   isTruthful was false
 ↓
CEO credibility collapses              reputation.investor −20, permanent floor
 ↓
Board pressure increases               a director tables a proposal
```

`CrisisResponse` gives four honest options and two expensive ones: `deny`
recovers credibility now and destroys it later if the allegation proves true;
`acknowledge` and `investigate` cost less over time; `silence` lets the story
run; `counter_attack` shifts attention at the cost of hostility.

### Where leaks come from

Leaks are not a player action. `disclosure_resolution` computes a leak hazard
per secret fact — a `ResearchProject` with `isSecret`, an undisclosed holding, a
contract term under confidentiality — from `world.media.controversyIntensity`,
the number of people who know, staff `morale`, `attrition`, and whether a
journalist character has an active relationship with anyone inside. A
`social_post` with `intent: 'leak'` carries its own chance of being traced back
to its author.

## 6. Ownership, disclosure and control

Positions live in the cap table, not in the market. Buying "3% of a public
rival" means acquiring shares of a `Security`, settled in `settleTrades` and
subject to the cap-table reconciliation invariant.

Simplified fictional thresholds (`OWNERSHIP_THRESHOLDS`):

```text
<1%       Portfolio investment
1–4.9%    Strategic holding — undisclosed
5%        Significant holder — the position becomes public
10%       Major holder — standing to demand meetings
15–20%    Board pressure — a seat can be credibly demanded
25%+      Blocking stake — supermajority matters can be blocked
50%+      Control of ordinary shareholder votes
```

Crossing one upward emits `ownership_threshold_crossed` and, at 5%, flips
`Holding.isDisclosed`. That is usually the moment the target's CEO notices —
and the moment a `Memory` of kind `negotiation` or `public_attack` is stored
against you.

**Actual control is not percentage.** `VotingPower` separates `economicPct` from
`votingPct`, and they diverge wherever `founder_super_voting` stock exists (up to
50 votes per share). Institutional blocs (`HolderKind: 'fund'`) vote as one.
The `public_float` votes only partially and predictably. A founder with 12% of
the economics and Class B stock can hold a voting majority; an activist with 26%
of the economics may hold 9% of the votes.

### Accumulating quietly

`buy_shares` takes a `targetPct` **or** an exact `shares` count, plus a
`maxPricePerShareUsd`. Accumulating without moving the price is a skill: large
purchases feed `liquidityEffect` in the return decomposition and push the price
against the buyer. `Quote.volume` caps how much can be absorbed in one quarter.
Buying slowly stays below the disclosure threshold longer; buying fast crosses
5% before the target can react but pays for the privilege.

Lock-ups (`Holding.lockupUntilQuarter`) apply after an IPO or a stock-funded
acquisition, and an attempted sale inside one is rejected with `lockup_active`.

## 7. Proxy contests

Being dismissed as CEO does not end a campaign. A dismissed founder with 24% of
the stock has a live route back, and the proxy contest is how they take it.

A contest is assembled from existing mechanics rather than a bespoke minigame:

1. **A stake.** Cross `board_pressure` (15%) at minimum; `blocking_stake` (25%)
   makes the campaign credible.
2. **Allies.** Institutional `fund` holders vote as blocs. Each has a
   `Character` who can be met — subject to the connection rules in
   [MULTIPLAYER.md](./MULTIPLAYER.md) — and persuaded. A
   `ConditionalCommitment` from a bloc holder is the mechanical form of "we will
   support your slate if the buyback is cancelled".
3. **A public case.** `social_post` and `marketing_campaign` with theme
   `thought_leadership` move `reputation.investor` and the beliefs the float
   uses to vote. `world.media.attentionLevel` amplifies both directions.
4. **The vote.** A `board_proposal` of kind `csuite_appointment`,
   `restructuring` or `ceo_dismissal`, tallied by `tallyProposal` against every
   director's traits, mandate, relationship and live commitments.

The float's participation is deliberately imperfect: a fraction abstains, and the
rest vote with management unless belief has moved far enough. That fraction
scales with `world.media.attentionLevel` and the credibility gap between the
incumbent's guidance record and reality — so a contest against a CEO who has
missed three consecutive guidance numbers is genuinely winnable, and one against
a credible operator is not.

## 8. Screen contract

The Markets screen must show, for any in-world instrument:

- Price, quarterly return, market cap, volume, and the rolling quote history.
- The `ValuationAnchor`: method, value, per-share value, confidence, and the
  named `inputs` that produced it — the working, not just the answer.
- The current `ReturnDecomposition` broken into its seven components, each
  linked to the ledger rows behind it.
- Live `MarketBelief` rows with `probability`, `priorProbability` and the
  disclosures that moved them.
- The player's own holdings, cost basis, and the highest ownership threshold
  crossed in each name.

And, when `enableReferenceMarket` is on, a visually distinct read-only panel for
the reference tape, labelled as such, with no interaction affordances at all.

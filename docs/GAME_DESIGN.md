# Game Design

Frontier Capital is an original corporate grand-strategy simulation set in a
persistent AI-industry economy. It is not a clone of any existing title. We take
economic *principles* from the genre — operating a business into departments,
financial statements, boards and public listings; a quarter-based AI-company loop
built on cash, compute, talent, data and reputation; ownership and board control
as a strategic layer above operations — and build our own interface,
terminology, formulas, content and progression on top of them.

The one-sentence concept:

> A persistent AI-industry corporate simulator in which every important company
> and character has goals, memory and agency; an LLM World Director perturbs a
> deterministic economic simulation; players build companies, negotiate, invest,
> acquire influence, win government contracts, control boards and compete
> against humans and AI founders inside a world whose technological future is
> itself uncertain.

The governing architectural rule, which every other document in this directory
elaborates:

> **LLMs are allowed to think, propose, negotiate, communicate and reinterpret
> the future; only the simulation engine is allowed to make reality.**

## 1. The player's arc

The player does not begin operating a giant corporation. They begin as the
founder of an AI startup: a modest office, roughly `BASELINE_SESSION_CAPITAL_USD`
($4,000,000), a small founding team, limited compute and one technological
thesis. Over many quarters that same founder might end up controlling a public
AI conglomerate, sitting on five boards, owning strategic positions in
competitors, supplying governments, funding semiconductor infrastructure and
competing for control of the technological frontier.

```text
FOUNDER
   ↓
EARLY STARTUP
Product-market fit • Hiring • Compute • Seed funding
   ↓
GROWTH COMPANY
Products • Enterprise sales • Marketing • R&D • Series funding
   ↓
INDUSTRY PLAYER
Major customers • Government bids • Acquisitions • Strategic alliances
   ↓
LATE-STAGE CORPORATION
Board politics • Institutional shareholders • Debt • IPO preparation
   ↓
PUBLIC COMPANY
Stock market • Earnings • Activists • M&A • Government scrutiny
   ↓
POWER NETWORK
Cross-holdings • Multiple boards • Political/institutional influence
   ↓
INDUSTRY EMPIRE
Technology leadership • Infrastructure • Capital allocation • Geopolitics
```

Progression is not a level track. Each rung is a set of subsystems that become
*reachable* — a company with no board cannot play board politics; a private
company has no share price to defend; a contractor with no past-performance
record is locked out of the largest programmes by
`OpportunityRequirements.minimumPastPerformance`.

## 2. The quarter

The **quarter** is the principal strategic unit. It is not a menu of scripted
choices: a single quarter can contain actions across thirteen domains, drawn
from the members of `ActionIntentSchema` (`ACTION_TYPES`, `@frontier/contracts`).

| Domain | Example action | `ActionIntent.type` |
|---|---|---|
| Research | Begin a new reasoning architecture programme | `start_research_project` |
| Product | Launch a product into one of thirty-six industry lines — a frontier model, a warehouse robot, a battery, a grid-storage line | `launch_product` |
| People | Recruit a rival's chief scientist | `poach_executive` |
| Compute | Reserve 40,000 accelerators for four quarters | `reserve_compute` |
| Capacity | Build plant, fleet or grid capacity for a non-compute line | `invest_capacity` |
| Capital | Raise a Series C or issue corporate debt | `raise_round`, `issue_debt` |
| Ownership | Purchase 3% of a public rival | `buy_shares` |
| Board | Lobby directors to approve an acquisition | `lobby_director` |
| Government | Bid on a sovereign AI infrastructure contract | `bid_government` |
| Social | Announce an open-weight model strategy | `publish_research`, `social_post` |
| Regulatory | Meet a regulator about a proposed framework | `meet_regulator` |
| Relationships | Negotiate a partnership with another player | `propose_deal` |
| Markets | Reallocate the corporate investment portfolio | `buy_shares`, `sell_shares` |
| Communication | Give earnings guidance or handle a crisis | `give_guidance`, `respond_crisis` |

Every action is an **attempt**, never an outcome. `raise_round` attempts a
raise; the engine decides whether the market clears it. `poach_executive` makes
an approach; the target — a character with traits, relationships and memory —
decides.

## 3. Three scales, one causal chain

The experience operates at three scales simultaneously.

**Company scale.** Operating economics: products, employees, compute, offices,
pricing, marketing, sales, research, debt, cash and customers. A product is
not just a segment (who buys it) but a real industry line — one of the
thirty-six categories in `PRODUCT_CATEGORIES`, spanning all six sectors: a
software seat is a different business from a frontier model, which is a
different business from a chip, a battery, a grid-storage line or a
last-mile shipment. Each carries its own unit, price, elasticity, churn and
the capacity it is served from — compute for AI and software lines, invested
plant, fleet or grid for everything physical. Some lines require a Frontier
Map node before a company may launch into them at all; some can be sold as
another company's input, which is the graph the supply-chain layer builds
real transactions on. See [ECONOMY.md](./ECONOMY.md) §2.

**Capital scale.** Ownership: fundraising, dilution, public equity,
institutional investors, board seats, acquisitions, shareholder blocs, personal
wealth and corporate investments. See [ECONOMY.md](./ECONOMY.md) and
[MARKETS.md](./MARKETS.md).

**World scale.** An evolving AI economy affected by technology, politics,
regulation, conflict, recessions, energy constraints, semiconductor supply,
capital cycles, public opinion and government expenditure. See
[SIMULATION.md](./SIMULATION.md) and [WORLD_EVENTS.md](./WORLD_EVENTS.md).

The design principle is that all three must feed each other. This chain is the
target experience, and every link in it is a real subsystem:

```text
WORLD
 ↓
Compute shortage                      world.compute.acceleratorSupply falls
 ↓
Training costs rise                   world.compute.spotPrice rises
 ↓
Smaller AI firms struggle             burn exceeds runway
 ↓
Their valuations decline              valuation anchor + sentiment fall
 ↓
Player acquires one                   acquire_company
 ↓
Player receives its technology/staff  techCapabilities merge, headcount moves
 ↓
Regulator becomes concerned           world.regulation.antitrust rises
 ↓
Government contract scoring changes   agency priorities shift weights
 ↓
Competitor runs a media campaign      marketing_campaign / social_post
 ↓
Public sentiment shifts               reputation.public falls
 ↓
Player stock falls                    sentimentEffect in the return decomposition
 ↓
Board pressures the player            board proposal tabled against strategy
```

That kind of chain reaction — not individual minigames — is what makes a
campaign memorable. Every arrow above is an engine consequence with a ledger
row behind it.

## 4. Success is plural

There is **no conventional fixed victory screen**. Sessions can carry explicit
objectives (`SessionObjective`, ten metrics from `OBJECTIVE_METRICS`), but the
sandbox measures several independent forms of success.

| Dimension | What it represents | Leaderboard |
|---|---|---|
| Enterprise Value | Size of controlled operating businesses | `company_value` |
| Founder Net Worth | Personal economic outcome | `founder_wealth` |
| Revenue | Quality and scale of the actual business | `revenue` |
| Profit | Operating and free-cash-flow performance | `profit` |
| Innovation | Contribution to the technological frontier | `innovation` |
| Market Power | Share of strategically important markets | `market_influence` |
| Network Power | Access to influential people and organisations | `network` |
| Institutional Influence | Government and regulatory credibility | `government` |
| Public Trust | Broader social legitimacy | `reputation` |
| Legacy | Composite long-run session performance | `founder_index` |

This deliberately avoids reducing the simulation to "largest valuation wins". A
technically brilliant company can lose financially. A rich founder can lose
control of their own company. A smaller company can become indispensable to
governments. Another founder can own minority stakes throughout the industry and
exercise disproportionate board influence.

The composite **Founder Index** consumes percentiles, never raw dollars —
otherwise wealth eventually overwhelms every other dimension and the composite
stops saying anything:

```text
FI = .22W + .18E + .15I + .12R + .10N + .10G + .08F + .05S
```

where W is founder wealth percentile, E controlled enterprise value, I
innovation, R reputation, N network, G government credibility, F financial
resilience and S session objectives. The weights live in
`FOUNDER_INDEX_WEIGHTS` as data, not in frontend logic, so they remain a
balancing variable. See [MULTIPLAYER.md](./MULTIPLAYER.md).

### 4.1 There is one way to lose

Success is plural; failure is not. From world version 2 a company that closes two
consecutive quarters with negative cash is wound up, and if it was the player's
company the seat is closed for good — the shell shows a verdict screen with the
run's length, its cause, its final standing on every board and the last eight
quarters of revenue and cash, and the only button founds a new company. The save
survives, marked ended, and can be loaded to read the verdict.

The industry does not pause for it. Every wind-up, the player's included, is a
gap somebody else fills: a new company is founded into the dead company's sector,
backed by whichever fund still has the dry powder, and it competes from the next
quarter like anyone else. Failing is expensive and it is not the end of the
world's story — only of yours in it.

## 5. Being CEO and owning the company are separate states

This is the single most important structural decision in the design.

`Company.controllerPlayerId` records who directs the company's actions.
`CapTable.holdings` records who owns it. `Board.directors` records who can
change the first of those. All three move independently.

A board can dismiss the player as chief executive (`BoardProposalKind` =
`ceo_dismissal`, a supermajority matter under `DEFAULT_QUORUM_RULE`). **The
campaign does not end.** The player might remain a 24% shareholder, wage a proxy
campaign, become an investor, start another business, join another board and
eventually regain control. `SessionPlayer.companyId` can change; the player's
character, holdings, relationships and memories persist.

Conversely, control is not percentage. `founder_super_voting` share classes carry
up to 50 votes per share; `VotingPower` reports `economicPct` and `votingPct`
separately, and they diverge on purpose. Institutional blocs (`HolderKind` =
`fund`) vote as one; the `public_float` votes only partially and predictably.

That one separation produces far richer corporate stories than treating the
company as an extension of the player's body.

## 6. Talking to the game

The player operates a quarter through **both normal controls and natural
language**, and neither is a second-class path.

For exact interactions, clicking remains fastest:

```text
Research Budget:   $42m
Enterprise Price:  $38 / seat
Hire:              17 engineers
GPU Reservation:   12,000 units
```

But the player can also tell their conversational Chief of Staff:

> We are getting too dependent on consumer revenue. Pull back most consumer
> advertising, increase enterprise sales, keep the total burn roughly unchanged,
> and see whether we can recruit a senior infrastructure person from Helix
> without creating a public fight.

The Chief of Staff returns a `ChiefOfStaffInterpretation` — a *proposal*:

```text
Interpreted instructions

Consumer marketing          $18m → $6m
Enterprise sales            $12m → $21m
Developer relations         $7m → $9m
Total quarterly spend       approximately unchanged

Recruiting mandate:
Senior infrastructure executive
Preferred sources: Helix + adjacent firms
Approach: private
Compensation ceiling: current policy +20%

No binding action has been submitted yet.
[Approve] [Edit]
```

Players may enable **"execute routine instructions automatically"**. It never
applies to the thirteen action types in `CONFIRMATION_REQUIRED_ACTIONS`:
financing, debt, buybacks, share issuance, IPO, acquisitions, layoffs,
government bids, board proposals, deal proposals and acceptances, and share
purchases and sales. Those always require an explicit human confirmation
(`SubmittedAction.confirmedByHuman`). See [UI_SYSTEM.md](./UI_SYSTEM.md).

## 7. The Frontier Map

The technology layer is a signature mechanic and deliberately not called a tech
tree. A tree tells the player that A leads to B leads to C, which implicitly
claims the designers already know the future.

> The **Frontier Map** represents what the current inhabitants of this
> particular simulated world believe the technological future might look like.

It is probabilistic, contested and mutable. World events move beliefs and the
rendered graph rearranges. Players can propose technologies the seed graph never
contained, and an accepted `InnovationProposal` becomes a real node credited to
its inventor for the rest of the session.

### 7.1 Four states, four questions

A node used to show a founder nine things at once — epistemic state, public and
private confidence, novelty, plausibility, a cost range, compute intensity,
capability tags with percentages, visibility and an arrival window — and answer
none of the questions they actually had. The map now shows **four states and
nothing else**:

| State | What the tile says |
|---|---|
| **Locked** | What is missing, in one line: *"Needs Sparse Expert Reasoning"* |
| **Available** | Nothing is in the way |
| **In progress** | How far and how long: *"44% done · 5q left"* |
| **Done** | Who demonstrated it |

Opening a node answers **four questions, in this order**:

1. **What it gets you.** The capability areas reaching it raises, the
   technologies it makes credible and the ones it unblocks. A node that opens
   nothing mechanical says so, and says what it does move: standing, and the
   valuation that follows it.
2. **What it takes.** Quarters, cost per quarter, total cash, researchers and
   compute units — every figure from `programmeForecast`, none recomputed by
   the screen.
3. **Who else is close.** The world's confidence as three words — *likely*,
   *unclear*, *doubtful* — and the rivals whose programmes are public. A secret
   programme is absent here, not redacted.
4. **The risk.** The per-quarter setback probability as low, medium or high,
   with the whole percent behind it, and one sentence naming what is short.

The epistemic state, the raw confidences, the novelty, the plausibility and the
arrival window all still exist and all still drive the simulation. They sit
behind **Details**, because none of them changes what a founder does next.

### 7.2 One control: effort

A programme used to need three sliders and a checkbox. It now needs one choice.

| Effort | What it asks for | Cost per quarter |
|---|---|---|
| **Light** | Half the node's requirement | Half |
| **Standard** | Exactly what the node asks for, capped by what is free | The cost midpoint over eight quarters |
| **All-in** | One and a half times the requirement, capped by what is free | Half again |

The presets are engine-owned (`effortPlan` / `effortIntent`) and built from the
validator's own bounds — free compute headroom and unassigned researchers — so
**the Standard preset is never clamped**. Under it the screen states the three
figures and the forecast live; **Adjust** opens the three sliders for a founder
who wants them, and the validator's verdict shows either way, because the
validator is the truth and a preset is only a good default.

Secrecy is one toggle with one line of consequence. Publication is one
**Announce** action with three plain choices — publish a paper, show it in a
product, brief government and investors privately — each with its consequence
stated on the label.

### 7.3 A running programme

A programme under way shows how far it has come, how many quarters are left at
the pace it is actually being given, what it has spent, and — when it is slow —
**one sentence** naming the shortage: *"Short of compute: 300 of 600 units."*
Next to that sentence is a **Fix** button, which pre-fills an
`adjust_research_project` with the node's own requirement capped by what is now
free. Re-resourcing lands before the quarter advances, so the fix a founder made
this quarter is the resourcing this quarter runs on.

Setbacks and successes are reported in the quarter report in the same words:
*"Setback on Sparse Expert Reasoning: 16% of the progress so far was lost and
the programme slipped a quarter; it was short of compute."*

See [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) and [UI_SYSTEM.md](./UI_SYSTEM.md).

## 8. First playable

We develop vertically: prove that one complete quarter is genuinely fun before
expanding the number of systems.

**First playable contains:** one human founder; approximately five major AI
rivals; a functioning twelve-domain world state; deterministic quarter
resolution across all eighteen phases; employees; products; compute;
fundraising; an evolving Frontier Map; the World Director modifier pipeline; and
a simulated market.

The test is not how many menus exist. It is whether this story can occur **from
actual interacting systems**, with every line traceable to a ledger row:

```text
Quarter 8
World:      Compute supply tightens.
Player:     Delays frontier model. Pivots compute into enterprise inference.
            Raises prices slightly.
Rival:      Borrows heavily to continue training.
Market:     Rival valuation increases on AI excitement.
Government: Publishes sovereign-model procurement.
Player:     Bids using efficient inference as the advantage.
Board:      One director objects to the capital commitment.
Player:     Negotiates board support.

Quarter 9
Player wins the contract. Rival model underperforms. Interest rates rise.
Rival debt becomes problematic. Rival shares collapse.
Player starts accumulating rival shares.

Quarter 11
Player crosses a significant ownership threshold.
Rival CEO becomes hostile. A board seat becomes negotiable.
```

If that works convincingly, the underlying game works.

**Build 2** adds the full corporate layer: cap tables, public securities,
boards, government contracting, M&A, social propagation, the public/private
information split and deeper agents.

**Build 3** adds shared sessions: human competition, Connection Levels,
structured player agreements, live messaging, session leaderboards and
moderation.

## 9. Target screen map

Twenty-one screens. Every one is specified in [UI_SYSTEM.md](./UI_SYSTEM.md).

| # | Screen | Purpose |
|---:|---|---|
| 1 | **Command Centre** | Quarter summary, cash, runway, valuation, alerts |
| 2 | **Company** | Operating structure, subsidiaries, offices |
| 3 | **Products** | Products, pricing, customers, unit economics |
| 4 | **Research / Frontier** | The generative technology graph |
| 5 | **People** | Employees, executives, culture, compensation |
| 6 | **Network** | Investors, founders, officials, directors, journalists |
| 7 | **Markets** | In-world exchange, ownership, reference tape |
| 8 | **Capital** | Funding, debt, treasury, cap table |
| 9 | **Boardroom** | Agenda, directors, votes, governance |
| 10 | **Government** | Opportunities, bids, active contracts |
| 11 | **Social** | Synthetic social networks, PR, marketing |
| 12 | **News** | World events and public information |
| 13 | **Deal Room** | M&A, licensing, partnerships, negotiations |
| 14 | **Financials** | P&L, balance sheet, cash flow, segment results |
| 15 | **Leaderboard** | Session rankings and the power network |
| 16 | **Chief of Staff** | Conversational control interface |
| 17 | **End Quarter** | Review actions and lock submission |
| 18 | **Quarter Resolution** | Explain exactly what changed and why |
| 19 | **Sector** | The six-sector chain, goods prices, market share, freight tolls |
| 20 | **The Street** | Funds, their dry powder, their offers and their short books |
| 21 | **Portfolio** | Subsidiaries, stakes, shorts and funds held outside the company |

Visually the game must not look like a chatbot with a business theme. The LLM is
infrastructure behind a serious strategy interface. The aesthetic target is:

```text
Premium financial terminal
        ×
Modern venture/startup dashboard
        ×
Corporate strategy game
        ×
Living social network
```

## 10. What the game should feel like

Not "a management game with a language model added". It should feel like this:

> You have entered an AI economy that existed before you arrived, will continue
> changing regardless of what you do, contains companies that genuinely compete
> against one another, contains people who remember how you treated them,
> contains markets that respond to information, contains governments with
> objectives of their own, and contains a technological future that nobody —
> including the game itself — knows with certainty.

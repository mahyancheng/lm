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
from the 37 members of `ActionIntentSchema`.

| Domain | Example action | `ActionIntent.type` |
|---|---|---|
| Research | Begin a new reasoning architecture programme | `start_research_project` |
| Product | Launch an enterprise coding agent | `launch_product` |
| People | Recruit a rival's chief scientist | `poach_executive` |
| Compute | Reserve 40,000 accelerators for four quarters | `reserve_compute` |
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
pricing, marketing, sales, research, debt, cash and customers. See
[ECONOMY.md](./ECONOMY.md).

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

It is probabilistic, contested and mutable. Nodes carry an epistemic state
(`established`, `emerging`, `forecast`, `speculative`, `company_thesis`,
`secret`, `discredited`, `achieved`, `dead_end`), a public confidence, a private
per-company confidence, an estimated arrival window and a cost range that is an
*estimate*, not the truth. World events move beliefs; the rendered graph
rearranges. Players can propose technologies the seed graph never contained, and
an accepted `InnovationProposal` becomes a real node credited to its inventor
for the rest of the session. See [LLM_CONTRACTS.md](./LLM_CONTRACTS.md) and
[UI_SYSTEM.md](./UI_SYSTEM.md).

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

Eighteen screens. Every one is specified in [UI_SYSTEM.md](./UI_SYSTEM.md).

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

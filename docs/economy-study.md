# Economy Study — Plutocracy and the benchmark business sims

**Audience:** the game owner (read on a phone) and the agents who will implement
from it.
**Status:** design study. Nothing here is implemented. Section 4 is the work order.
**Written against:** the engine as of world version 2 in-flight
(`packages/simulation/src`, `packages/contracts/src`).

---

## 0. Provenance and how to read this

Every factual claim about another game carries an inline source link. Two
honesty markers are used throughout:

- **(inferred)** — my reading, not the source's words.
- **(unverified)** — a community claim I could not corroborate from a second
  source. Treat the *shape* as real and the *number* as indicative.

**Method caveat, stated once and applying to all of Section 1 and 2.** The
research pass that produced this material could not fetch pages directly — the
egress proxy blocked `steamcommunity.com`, `store.steampowered.com`,
`steamdb.info`, `capitalismlab.com`, `capitalism2.com`, `vic3.paradoxwikis.com`,
`anno1800.fandom.com`, `offworldtradingcompany.fandom.com` and the rest. The
content was extracted from a search engine's synthesis of those exact pages. The
URLs are correct and the claims are attributable to them; the wording is
close-paraphrase rather than verified verbatim quotation. Numbers quoted from
developer patch notes and wikis are stronger than numbers quoted from forum
posts, and I have said which is which.

Everything in Sections 3, 4 and 5 is about **our own code**, which I read
directly. Those claims are not caveated.

---

## 1. Plutocracy's economy, explained precisely

[Plutocracy](https://store.steampowered.com/app/754500/Plutocracy/) (Redwood
Games, Steam app 754500, Early Access since 2019) is the reference point. It is
worth being exact about what it actually is, because the thing people admire
about it is not the thing it looks like.

### 1.1 It is not a logistics sim. It is a modifier stack over a reference price.

There are no trucks and no warehouses to route. Every company runs a per-quarter
income statement in which:

- the **revenue side** is a base market price multiplied by a stack of
  modifiers — market share, cartel membership, advertising relative to the
  sector average, government subsidy;
- the **cost side** is raw materials plus transport bought, by default, "at
  market prices, based on the average price in the country," plus wage fund,
  administrative expense, taxes and loan interest.
  ([Holdings update](https://store.steampowered.com/news/app/754500/view/546722128842458675),
  [SteamDB patch 16852471](https://steamdb.info/patchnotes/16852471/))

You do not move goods. **You move the multipliers.** That single sentence is the
most transferable idea in the game.

The consequence is that the whole economy has one legible anchor: a national
average price per good. Every advantage a player engineers is visible as a
deviation from that anchor, and every deviation is something they *did*.

### 1.2 The chains are shallow and named

Coal mining + ore mining → metallurgy. Oil production → oil refining. Transport
sits astride both. Scenario setup exposes these as selectable industry sets:
"All industries" = coal mining, transport, oil production, oil refining, ore
mining, metallurgical; "Oil" drops the ore and metal steps; "Metallurgical"
drops the oil steps.
([industry sets discussion](https://steamcommunity.com/app/754500/discussions/0/2565312892639247244/))
Media companies were added later as a *modifier-producing* industry rather than
a physical one.
([media update](https://store.steampowered.com/news/app/754500/view/4645982290500918269))
Marketing copy mentions 14 industries; I could not verify a full list
(unverified).

Two or three steps deep, no intermediate goods, scenario-scoped. That is the
depth that keeps every ownership decision one mental step from a visible
consequence.

The instructive *negative*: you cannot found a company at all — you start owning
100% of one you name and acquire the rest. Forum posters wanted more.
([no-founding thread](https://steamcommunity.com/app/754500/discussions/0/4294816752261734407/))
We should not copy that; founding is core to Frontier Capital.

### 1.3 The price modifier stack, itemised

This is the heart of it. A company's realised sell price is the base price
multiplied by:

| Modifier | Rule | Source |
|---|---|---|
| Market share | Price "depends on market share"; share is shown at state / country / world in a per-company financials tab | [share and price](https://steamcommunity.com/app/754500/discussions/0/3044979493854436180/) |
| Cartel bonus | Scales with combined nationwide market share, with a stated floor: "at minimum a 5% bonus to product price in the worst case" | [cartel guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921) |
| Advertising | Relative, not absolute: spend above the sector average earns a price markup, spend below it a penalty; the cost of advertising rises non-linearly against its effectiveness | [advertising](https://store.steampowered.com/news/app/754500/view/4645982290500918269) |
| Government subsidy / grant | "Politics Grants increases the price of your goods with Government subsidies"; a contract "will greatly increase net income" | [politics guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921), [subsidy update](https://store.steampowered.com/news/app/754500/view/2997683031141534775) |
| Monopoly ceiling | The stated arc: dump to squeeze rivals out, "then raise the price three-fold" | [store page](https://store.steampowered.com/app/754500/Plutocracy/) |

And on the cost side, one modifier that matters more than all of them:

| Modifier | Rule | Source |
|---|---|---|
| Holding supply | Replacing a third-party supplier with one you control substitutes that supplier's price for the national average — "the lower the price, the greater the benefit to the holding" | [Holdings update](https://store.steampowered.com/news/app/754500/view/546722128842458675) |
| Transport toll | Buy out the region's transport companies and "increase the price of supplies for competitors" several times over, while your own firms keep low internal tariffs | [store page](https://store.steampowered.com/app/754500/Plutocracy/) |

The cartel bonus and the holding supply discount are **separate multiplicative
systems that must compose** — there is a bug report where a cartel added to a
holding as a supplier failed to accrue its share-based price bonus, which is
exactly the evidence that they are independent stacks.
([bug report](https://steamcommunity.com/app/754500/discussions/0/3044979493854436180/))

### 1.4 Vertical integration: the margin engine

A "holding" is a supply-related company in which you hold a controlling stake.
The December 2024 update simplified it: you no longer need to make the supplier a
formal subsidiary, only to hold control.
([SteamDB 16852471](https://steamdb.info/patchnotes/16852471/))
The canonical developer example: "cheap oil from your oil production company,
coupled with low transportation tariffs, allows you to get significant savings,
which improves the final margin of the refinery, and therefore its
competitiveness in the market."
([Holdings update](https://store.steampowered.com/news/app/754500/view/546722128842458675))

The player's job is reframed as *hunting for the supplier with the lowest price*.
Two purchases produce one visibly fatter margin on a third company. It compounds
and it is self-evident, and it needs no new verbs.

The same purchase is simultaneously offensive: cheap inputs for you means
"depriving competitors of cheap raw materials." Holding efficiency and total
benefit are surfaced in a table.

### 1.5 Cartels and trusts: two different alliances

Both require 50%+1 in **both** companies, and both work across state borders.
([guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921))

- **Cartel** — same industry. Gives a price bonus scaled by combined US-wide
  market share, floor 5%. A player complaint reveals the curve is share-based
  rather than size-based, and that combining can be worth roughly a 2× income
  swing (player report, unverified).
- **Trust** — an alliance whose distinctive effect is technological: "all
  companies in it adjust to the highest tech level in the Trust" over time. The
  community optimisation is to assemble a trust whose members' maximums cover
  different technologies and let diffusion do the work.
  ([trust thread](https://steamcommunity.com/app/754500/discussions/0/1750142526436093680/))

A trust turns R&D from a per-company grind into a portfolio problem. A cartel
turns horizontal expansion into a superlinear payoff, because each acquisition
raises the price on everything you already owned.

### 1.6 The stock exchange: limited float, price impact, negotiated blocks

The stock market shipped as its own module in update 0.210 with the stated goal
of "a full simulation of price behavior on the stock market with a direct
correlation between how many shares you buy or sell and the respective prices."
([stock market update](https://store.steampowered.com/news/app/754500/view/3077640948782877270))

Four properties matter:

1. **Limited float.** From 0.223, "the stock exchange has a limited number of
   shares circulating, and to obtain 100% of a company, you must buy all the
   company's shares on the stock exchange AND negotiate with significant
   shareholders."
   ([float thread](https://steamcommunity.com/app/754500/discussions/0/1657817111855637228/))
   This is the key move: the last tranche is a *social* problem, not a cash one.
2. **Own-order price impact.** Your buying moves the price against you.
3. **Negotiated blocks priced by the counterparty.** "High Economics and
   Diplomacy skills in shareholders can make the price higher." Starting a
   negotiation costs Influence; the player's Psychology skill reduces that cost,
   Eloquence adds negotiation phases, Etiquette reduces the loyalty damage of a
   failed one. There was an era when negotiating cheap and reselling on the
   exchange was an arbitrage; after a rework, players report "you would always
   pay more than it is worth when negotiating."
   ([negotiation thread](https://steamcommunity.com/app/754500/discussions/0/669453270933050209/))
4. **Events reprice.** "Any strike or accident at a company will lead to a fall
   in prices, allowing players to manipulate the market."

Dilution is a weapon as well as a fundraiser. The community "Rags to Riches"
chain — maxed share issue, buy in with your own cash, max the loan, offer a
merger, issue again, sell at +200%, repeat — is a documented money loop.
([guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921),
[gameplay.tips](https://gameplay.tips/guides/8178-plutocracy.html))
It is also a balance hole we must not reproduce.

Mergers are not unilateral even at control: shareholders vote, and you must pay
out the dissenters.
([merger thread](https://steamcommunity.com/app/754500/discussions/0/4854406951637576975/))

### 1.7 Banking: the rate ladder

Two tiers. The Central Bank lends to private banks at a rate influenced by the
economy; private banks lend to companies and the public at a higher rate
influenced by the bank's own development level. Quarterly loan repayments split
into principal and interest, the payment falls as the balance amortises, and
early repayment reduces future payments.
([banking thread](https://steamcommunity.com/app/754500/discussions/0/2912094978031140419/))

Player-reported spread for owning a bank: borrow from the FED at ~2%, on-lend to
your own companies at ~3–3.5%, issue retail loans at ~20% against borrowers with
under 10% default probability (player reports, indicative only).

The design lesson is the **cap**, not the spread: a rebalance patch added "the
loan amount for a company in a bank or for a bank in the Central Bank can no
longer be greater than the net assets of the borrower, including all existing
loans."
([SteamDB patch notes](https://steamdb.info/app/754500/patchnotes/))
That single ratio turns leverage from an exploit into a number you must grow.
Bankruptcy has two triggers — debts exceeding assets, and cash falling below the
quarter's debt service — so over-leverage can kill you two different ways.

### 1.8 The exploitation dial

One set of controls: raise the production plan, lengthen the working day, cut
wages. Administrative expense and the wage fund fall — and "the threat of a
strike will grow, the accident rate of the enterprise will increase." A strike
cuts production volume; resolving one forces a wage rise. An accident risks a
safety fine unless concealed. The CEO handles both automatically, with success
keyed to their Economics skill; a captured official makes concealing an accident
or dispersing a strike much cheaper.
([store page](https://store.steampowered.com/app/754500/Plutocracy/),
[guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921))

This is the game's best single mechanic: a smooth, certain, small saving traded
against a lumpy, stochastic, large loss. Players over-exploit and get punished in
a way that feels earned.

### 1.9 CEOs and shareholder votes

CEO Economics governs technology throughput per quarter and emergency-resolution
odds; Diplomacy governs *how many* technologies a CEO can run at once — a
five-star CEO manages five areas simultaneously. Each CEO has a specialisation
that improves its area twice as fast. A Headhunter agent lets you poach any
experienced CEO from any company, "thereby weakening a competitor and
strengthening your corporation."
([CEO thread](https://steamcommunity.com/app/754500/discussions/0/3936769740292975902/),
[guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921))

Two orthogonal stats — throughput and breadth — make hiring a decision rather
than a bigger-number purchase. Poaching is the standout: one hire buffs you and
debuffs a named rival at the same time.

Shareholders vote every quarter on which technology the CEO develops.
Above 50% that vote is a unilateral choice; below it, it is a negotiation. This
is what makes 51% *felt* every single quarter rather than once.

### 1.10 Agents, blackmail, media, politics

- **Agents of influence** — 36+ named characters in 12 categories, each with a
  specific effect rather than a generic buff: a Detective who finds dirt, a
  Journalist who raises or lowers reputation, a Priest who repairs hostile
  relationships, a Courtesan who alters the Influence needed to open a
  negotiation, "The Pianist" who sets strike rate to 0%, a Bandit who takes
  illegal actions at a standing risk of police capture.
  ([agents update](https://store.steampowered.com/news/app/754500/view/4645982290500918401))
  Naming and portraying each one turns an ability list into a roster of
  accomplices.
- **Blackmail** was reworked to separate loyalty from coercion: loyal characters
  sit at 5/5 loyalty; puppets are "characters you have forced into submission
  using dirt on them." Successful blackmail drops the target's loyalty to zero
  and *also* costs loyalty across their inner circle. Puppets then act
  autonomously — they run in elections and climb the career ladder on their own,
  and you periodically sponsor the promising ones.
  ([SteamDB 21632139](https://steamdb.info/patchnotes/21632139/))
- **Media** — owning a controlling stake in a newspaper lets you influence
  election candidates, change public opinion on laws, and destroy or revive a
  company's business reputation. Effectiveness scales with circulation, and it
  combines with dirt: with blackmail in hand, a journalist can destroy a
  reputation in one article.
  ([media update](https://store.steampowered.com/news/app/754500/view/4645982290500918269))
- **Politics** — lobbyists, campaign sponsorship, elected governors, treasurers,
  prosecutors and police. The cleverest bit: **laws are price modifiers on the
  political system itself** — passing the right law "reduces the amount of money
  it costs to bribe politicians." Political capture compounds.

### 1.11 Antitrust is the brake, and it is buyable

"The public, represented by politicians at the federal and local levels, will
oppose you through antitrust laws, restrictions on labor practices, and raising
taxes." And: "every illegal action is strictly punishable by the court, or you
can make sure that the judge and the prosecutor are on your side."
([store page](https://store.steampowered.com/app/754500/Plutocracy/))

Without this, every one of the price-power mechanics above compounds to
infinity. Making the brake political and *purchasable* rather than a hard cap is
what preserves agency: the game never says no, it says "that will cost you a
governor." The sequencing lesson is sharp — you capture the prosecutor *before*
you commit the crime.

### 1.12 So why does it feel like one of the best-done economies?

Four reasons, in order of importance:

1. **One anchor, many levers.** A single national reference price per good, and
   five or six named, independently-purchasable ways to deviate from it. Every
   strategic act resolves to "I moved my price up 12% / my cost down 18%."
2. **Ownership is the only verb that matters, and it has one threshold.** 50%+1
   gates mergers, cartels, trusts, holdings, media influence, CEO appointment and
   the dividend rate. The player is always reading one progress bar.
3. **The same purchase attacks and defends.** Buying the region's transport
   lowers your cost *and* raises everyone else's. Poaching a CEO buffs you and
   debuffs a rival. That is what makes the economy feel populated rather than
   procedural.
4. **The brake is a system, not a cap.** Concentration buys you price power and
   buys you enemies, and the enemies are purchasable too.

### 1.13 The one thing it gets badly wrong

**Legibility.** The simulation is richer than its readout. Market share is in a
financials tab; a production-volume-to-demand relationship is in the Company
Economy window; and per-state supply and demand for a specific good is *not
shown at all* — a forum user asks for it directly.
([supply/demand request](https://steamcommunity.com/app/754500/discussions/0/3044979493854436180/))
Players describe the game as overwhelming, with every state full of NPCs
demanding attention.
([overwhelm thread](https://steamcommunity.com/app/754500/discussions/0/669453270933050209/))

The contrast is instructive. The mechanics that land are the ones with a number
a player can quote: the 5% cartel floor, the 3× monopoly ceiling, the
2%/3.5%/20% rate ladder. The ones that don't land are the ones you can only feel.

**For us, this is the actionable finding:** ship Plutocracy's modifier stack and
show it as an itemised, signed list. Frontier Capital's append-only `sim_event`
ledger (rule 6) is already the right substrate for a "why did this change?"
drill-down that Plutocracy never built.

---

## 2. The benchmarks, compared

| Game | Price formation | Chain propagation | Stability clamps | Legibility |
|---|---|---|---|---|
| **Plutocracy** | National average price per good × a multiplicative modifier stack (share, cartel, ads-vs-sector-average, subsidy, transport toll) | Explicit 2–3 step chains; owning a supplier substitutes its price for the national average; owning regional transport raises every rival's input cost ([Holdings](https://store.steampowered.com/news/app/754500/view/546722128842458675)) | Cartel bonus floored at 5%; loans capped at borrower net assets ([patch notes](https://steamdb.info/app/754500/patchnotes/)); antitrust/politics as the systemic brake | **Weak.** Modifiers exist, the causal chain does not surface. Per-state supply/demand is not shown at all |
| **Capitalism Lab / Capitalism II** | Composite Overall Rating from Quality/Price/Brand with per-product weights summing to 100% (Cigarettes 15/25/60; Car 35/30/35; Bread 35/35/30), compared to the **city average** including a synthetic "white brand" ([Cigarettes](https://capitalismlab.fandom.com/wiki/Cigarettes), [Car](https://capitalismlab.fandom.com/wiki/Car), [relative rating](https://www.capitalism2.com/forum/viewtopic.php?t=3754)) | B2B prices drift toward clearing over months; shared seaport supply congests and raises import prices for everyone drawing on it ([supply/demand](https://www.capitalism2.com/forum/viewtopic.php?t=7300)) | Quality is scored **relative to the world's best technology**, so a lead decays without rubber-banding ([quality](https://www.capitalism2.com/forum/viewtopic.php?t=3174)); imports capped "one notch below average"; corporate-brand dilution penalty for spanning unrelated categories ([branding](https://www.capitalism2.com/forum/viewtopic.php?t=2508)) | **Best in class.** One Overall Rating bar split into three coloured segments — green quality, yellow price, beige brand — beside a market-share bar; a brown 100% utilisation bar that tells you when every other lever is a no-op ([utilisation](https://www.capitalism2.com/forum/viewtopic.php?f=14&t=814)) |
| **Victoria 3** | Stateless: `price = base × (1 + 0.75 × clamp((BUY−SELL)/min(BUY,SELL), −1, +1))`, hard range 25%–175% of base ([Market](https://vic3.paradoxwikis.com/Market)) | Trade routes create buy orders in one market and sell orders in the other; the ordinary formula then produces convergence. Local price = `MAPI × MarketPrice + (1−MAPI) × StatePrice` | The **clamp is the stability**. Beyond 2:1 imbalance the price stops carrying information and a separate, stateful shortage debuff takes over: −5% throughput on trigger, −1%/day to a −75% floor, healing only 1%/day ([shortage](https://games.gg/victoria-3/guides/victoria-3-market-mechanics-tips-and-tricks/)) | **Good.** Buy-order and sell-order bars side by side: the imbalance *is* the price. Base price is a permanent mental anchor |
| **Offworld Trading Company** | Path-dependent market maker: every unit traded moves the price, bounded ("never more than 100 units bought to increase the price by $1"), scaling with player count ([Market](https://offworldtradingcompany.fandom.com/wiki/Market)) | No chains to speak of. The Offworld Market is a separate, higher, rising price track that acts as an export valve and permanently removes supply from the local market ([Offworld Market](https://offworldtradingcompany.fandom.com/wiki/Offworld_Market)) | Infinite-liquidity counterparty (you are never told "no", only "expensive"); bounded per-unit step; monotone colony demand ramp guarantees gluts are temporary; sabotage costs escalate per use and duration decays as `1/(1+0.1n)` ([Hacker Array](https://offworldtradingcompany.fandom.com/wiki/Hacker_Array)) | **Radically simple.** One number per resource, always tradeable, no order book to read. Share price trends toward `TotalValue/100,000`; takeover is 6 of 10 blocks, doubled price for contested blocks ([Stock](https://offworldtradingcompany.fandom.com/wiki/Stock)) |
| **Anno 1800** | **None.** Traders buy and sell at fixed prices ([Trade](https://anno1800.fandom.com/wiki/Trade)) | Strict conservation: 1 ton in → 1 ton out, so a chain is balanced exactly when every stage's t/min rate is equal ([Production](https://anno1800.fandom.com/wiki/Production)) | Conservation is the clamp. Consumption scales with a house's *maximum* capacity, not its occupancy, which kills the growth→demand→shortage oscillation ([Needs](https://anno1800.fandom.com/wiki/Needs)); exploitation dial bounded at ±40 happiness | **Best UI in the genre.** Twin bars per good — blue "need" over green "produce" — with a third darkened state meaning "produced but not arriving" ([Statistics](https://anno1800.fandom.com/wiki/Statistics)) |
| **Coffee Inc 2** | Not a market model — margin is a per-store P&L, and the game's substance is the three financial statements | None (single industry) | Turn-based and offline; delegation to managers is the complexity valve | **Excellent for our purposes.** Real income statement / balance sheet / cash flow as the primary screens; a weekly in-game newspaper as the single event feed; IPO behind an explicit checklist (executive floor, CFO, three consecutive profitable quarters, minimum shares) ([App Store](https://apps.apple.com/us/app/coffee-inc-2/id6749188193)). Known anti-pattern: sliders with no type-in box ([feedback](https://gamingroute.com/4224-2/)) |
| **Big Ambitions** | Per-product, per-district: a four-column `MarketInsider` table — demand, lowest market price, import price index, provider count ([pricing guide](https://bigambitionsguide.wiki/guides/pricing-guide/)) | Tiered supply ladder: wholesaler → importer (weekly delivery limits) → warehouse (needs a Logistics Manager and a Delivery Driver) → repeating orders | Hard customer-capacity ceiling per building, 4–75 customers/hour, separate from demand ([Buildings](https://big-ambitions.fandom.com/wiki/Buildings)); promotion capped at 100 with marketing contributing at half rate | **Very good.** Margin exposed as three named layers (equipment, purchase cost, shelf price); customer satisfaction as a composite with named, individually-fixable sub-scores |
| **Railway Empire** | Flat $2,000/wagon delivery fee; real profit is spatial arbitrage between purchase and sale prices | Demand derived from population ÷ 50,000, with a new product unlocked every 5,000 inhabitants ([Cities](https://railway-empire.fandom.com/wiki/Cities)) | One threshold does the work: above 60% demand fulfilment a city grows, below it stalls | **The overlay to steal.** "Flow of Goods" — one tap (barrels icon / hotkey G) shows supply and demand for every commodity at once, with a count *and* a share bar per row ([overlay](https://steamcommunity.com/sharedfiles/filedetails/?id=1715094944)) |
| **Game Dev Tycoon** | N/A — a quality score, not a price | N/A | Scored against **your own previous best plus 10–20%**, so a good result stays meaningful at every company size ([review algorithm](https://gamedevtycoon.fandom.com/wiki/Review_Algorithm/1.4.4)); the third platform carries a *negative* coefficient | **Mixed.** The composite allocation bar under three sliders is excellent; the per-genre target ratio is hidden, which is the anti-pattern |

**The synthesis.** Every one of these games keeps its numbers stable with
**bounds, not dynamics** — V3 clamps the multiplier, OTC bounds the per-unit
step, Anno bounds by conservation, Capitalism bounds by scoring quality relative
to the frontier. None of them uses a stochastic price process. That is directly
compatible with rule 4.

And the one legibility pattern that recurs in every game that has it: **show the
composition and the total as the same glyph.** Capitalism's three-segment rating
bar, Anno's twin need/produce bars, Victoria 3's buy/sell order bars, Game Dev
Tycoon's composite allocation bar. All the same idea.

---

## 3. Frontier Capital today — an honest gap analysis

I read the engine. Here is what is actually there, and what is not.

### 3.1 What we already have that is genuinely strong

- **A real return decomposition.** `packages/simulation/src/markets/pricing.ts`
  produces seven named components (market beta, sector beta, fundamental alpha,
  public information, sentiment, liquidity, noise) that are *reconciled to sum to
  the applied total* even when the floor truncates. The Markets screen can
  already answer "why did my stock move?" from committed rows. Almost no
  commercial sim does this.
- **A fundamentals anchor with sector bands.**
  `markets/fundamentalValue.ts` — `multiple = lerp(sectorBand.low, high, quality)
  × marketIndex`, quality from growth (65%) and margin position in band (35%),
  bands from `SECTOR_META` (`contracts/sectors.ts`): logistics 1–3×, AI 6–24×.
  Whole dollars out. This is the Capitalism-style "relative to your sector's
  achievable range" idea, already shipped.
- **A relative price benchmark.** `companies/util.ts:218`
  `segmentReferencePrice` is the customer-weighted mean price of every active
  product in the segment across the session, falling back to a constant only when
  nobody sells there. That is exactly Capitalism's "compare to the market
  average" and Plutocracy's national reference — we already have it, and it is
  better implemented than in either.
- **A frontier-relative quality benchmark.** `segmentFrontierQuality` blends the
  best product in the segment with the world frontier capability, so a rival's
  R&D erodes your quality edge with no adversarial logic. Capitalism's best idea,
  already shipped.
- **A hard capacity constraint that rations demand.** `companies/products.ts`
  — new demand is rationed by `capacityRatio` outright and the retained base
  degrades at a bounded rate (`CAPACITY_BASE_LOSS_CEILING`), with a
  `capacity_constraint` report line. This is Big Ambitions' capacity ceiling and
  Capitalism's brown utilisation bar.
- **A supply gate along the six-sector chain.** `economy/sectors.ts` —
  `tightness = 2s/(s + 0.35·downstream)` per sector, and a per-sector realisation
  gate `SUPPLY_GATE_FLOOR + (1−floor)·tightness` with the floor at 0.75.
- **Region indices with exactly one call site each.** `economy/regions.ts` — an
  admirably disciplined table: talent cost → hiring, energy cost → compute cost,
  procurement appetite → government, capital depth → rounds, sector affinity →
  demand. The comment "applying an index twice would compound it" is the right
  instinct.
- **Bounded, per-instrument price shocks with a recorded reason.**
  `V2_MAX_ABS_LOG_RETURN = 0.18` ordinary, `0.45` shocked, 4% chance per
  instrument per quarter from its own forked stream. "No price moves more than
  the bound without a recorded reason" is a checkable invariant.
- **Limited float and absorption on secondary trading.**
  `markets/settlement.ts` — buys come out of `public_float` holdings, capped by
  the prior quote's volume, and lock-ups are enforced. Plutocracy's limited float,
  already there.
- **Double-entry that throws rather than laundering.**
  `companies/financials.ts` derives closing equity from the closing sheet,
  separately predicts it as opening + net income, and throws with a diagnostic on
  any defect. An opening imbalance is *carried, never absorbed*.
- **Eighteen phases, forked RNG per phase, an invariant gate before commit,
  idempotency, and a two-hash-chain ledger.** `resolver/index.ts`,
  `resolver/invariants.ts`.

That is a stronger foundation than any of the benchmark games had at
equivalent maturity. The gaps below are about *tension and legibility*, not
correctness.

### 3.2 Gap 1 — There is no price on the six-sector chain

`economy/sectors.ts` computes `tightness` per sector, but tightness only feeds
`supplyGate`, which only rations **downstream demand realisation**, and only by
25% at worst (`SUPPLY_GATE_FLOOR = 0.75`). Tightness **does not touch price and
does not touch cost.**

`inputCostMultiplier` is built from exactly two things:
`(1 + ENERGY_COST_PASS_THROUGH × energyExposure × (electricityPrice − 1)) ×
(1 − AI_PRODUCTIVITY_MAX_UPLIFT × adoption)`, bounded to `[0.85, 1.40]`. Energy
and AI. **Nothing else.** A manufacturing collapse does not raise robotics' input
cost by a cent; it merely gates robotics' demand by up to 25%.

There is no sector price index anywhere in `SessionState`. The only endogenous
prices in the world are `world.compute.spotPrice` and
`world.energy.electricityPrice`, and those drift toward targets computed from
*other world variables* in `economy/macro.ts` — never from what the companies in
the session actually produced.

**Consequence:** the six sectors are a demand-cycle table and a gate, not an
economy. There is no goods/price tension for a player to trade against, no reason
to own an upstream sector, and no way for a shortage to become news.

### 3.3 Gap 2 — Regions are static indices, and logistics has no chokehold

`economy/regions.ts` returns constants from `REGION_META`. North America's talent
index is 130 in quarter 1 and 130 in quarter 40. There is no regional supply, no
regional demand, no regional price, and no way for a player's actions to move a
region's cost basis.

Logistics is one of the six sectors, its `outputs` are `manufacturing` and
`consumer`, and the only thing a logistics squeeze does is tighten those two
sectors' realisation gate by at most 25%. **Nothing in the engine lets a company
that dominates logistics raise a rival's input costs.** The single most flavourful
cross-sector lever in Plutocracy has no analogue here.

### 3.4 Gap 3 — No cartels, no trusts, and antitrust is a coin flip

`form_consortium` exists (`contracts/actions.ts:354`) but it is a *government
bidding* construct. `DEAL_OBLIGATION_KINDS` includes `consortium_membership`
(`contracts/deals.ts`). Neither produces a price effect.

There is no market-share or concentration metric anywhere in the engine. I
grepped: `marketShare`, `hhi`, `concentration` — the only hits are the antitrust
event family and the narrative bias table.

Antitrust exists as `fam_antitrust` in `economy/eventFamilies.ts:517`, drawn by
the hazard engine, gated on `world.regulation.antitrust > 0.25`, with company
subject selection by `selectCompanySubject(draft, 'concentration', rng)`
(`economy/hazards.ts:340`). So: *whether* an investigation happens is a random
draw against a world-level dial that has nothing to do with what the player did;
only *who* it hits is weighted by scale. **Concentration does not raise the
probability of enforcement.** Plutocracy's central feedback loop — the brake that
makes the accelerator worth pressing — is absent.

### 3.5 Gap 4 — Price competition is one-directional

`companies/products.ts` has a genuinely good elasticity model: segment
elasticities of 1.6 (consumer) / 0.7 (enterprise) / 1.2 (developer_api) / 0.4
(government), `priceFactor = 1 − elasticity × (price/reference − 1)`, bounded.
And `priceShock` + `PRICE_SHOCK_CHURN = 0.75` punish a price *rise* hard enough
that repricing upward is a strategy with a cost, not a lever that prints revenue.

But **a price cut is purely self-harm.** You gain demand via `priceFactor` and
lose margin. Nothing about your cut touches a rival's demand. There is no
predation, no price war, no dumping. `PRICE_MOVE_BAND = {min: 0.25, max: 4}` per
quarter is a validator clamp (`validator/rules.ts:256`), not a strategic
statement. There is no published monopoly ceiling.

Since `segmentReferencePrice` is customer-weighted, a dominant seller *does*
drag the reference with it — so a Plutocracy-style monopoly price arrives
emergently. But no rival ever feels the pressure of your cut in the quarter you
make it, which is the part that reads as an attack.

### 3.6 Gap 5 — Capital structure is rich, but there are no dividends and no takeover pressure

`resolver/capital.ts` settles six things well: rounds (with a region-scaled
clearing probability), debt (with a real risk-premium ladder in
`offeredDebtRate`), primary issues (at a 3% discount to last trade), listings
(with a share-count normalisation so the price reads like a price), buybacks
(retiring shares, cash and equity down together) and acquisitions (with goodwill,
bargain-purchase gains, integration friction and a 4-quarter lock-up on stock
consideration). That is more balance-sheet correctness than any benchmark game.

What is missing:

- **Dividends do not exist.** I grepped the whole of `packages/contracts/src` and
  `packages/simulation/src` for "dividend": zero hits. This is the single
  cleanest decision in a quarterly business sim — the growth-versus-extraction
  slider that both Plutocracy and Capitalism build their late game around — and
  we do not have it.
- **No convex cost to accumulating a stake.** Buying a rival is capped by float
  and prior volume (`markets/settlement.ts`) and nudges the price through
  `liquidityEffect` (clamped to ±0.1 log return, and that is the *whole
  instrument's* return, not a per-trade execution price). Nobody pays more for the
  last 10% than the first 10%. Both OTC (+2% price per 1% bought is Capitalism's
  version; OTC doubles the price of contested blocks) and Plutocracy make the
  final tranche the expensive one.
- **Crossing 50% has no engine consequence.** `ownership_threshold_crossed` is
  emitted and `OWNERSHIP_THRESHOLDS` exists, but control does not flip anything.
  Board voting (`boards/tally.ts`) computes stances from director attributes and
  world conditions; a majority holder is not decisive. Plutocracy's whole design
  hangs on 50%+1 being *the* threshold, and Coffee Inc 2 makes M&A the only exit.
- **Hostile takeover is not a distinct verb.** `acquire_company` requires board
  approval (`BOARD_PROPOSAL_KINDS` includes `acquisition`), so a raid on an
  unwilling target is not expressible.

### 3.7 Gap 6 — There are no agents and no covert actions

`poach_executive` (`companies/hiring.ts:318`, `validator/rules.ts:434`) is the
only hostile action in the game, and it is the *right* shape — it buffs you and
debuffs a named rival, which is Plutocracy's Headhunter. There is nothing else:
no analyst who reveals a rival's private fundamentals, no PR operator who moves
market belief, no supply pre-buy, no regulatory complaint. Rule 9 (markets price
beliefs) creates a large, obvious action surface that nothing currently uses.

### 3.8 Gap 7 — Legibility is ledger-shaped, not screen-shaped

We have twenty screens (`apps/web/src/components/screens`), a `sim_event` ledger
with a hash chain, and resolution lines that reference emitted events. That is
the substrate Plutocracy lacks. But there is currently no equivalent of:

- Railway Empire's one-tap whole-economy overlay,
- Anno's twin demand/supply bars per sector,
- Capitalism's three-segment composite rating bar,
- Big Ambitions' four-column market table.

Every proposal below therefore specifies its mobile surface in the same terms
the Wave 1 work established: **one number, one percentage, one slider.**

### 3.9 One engineering constraint that governs all of Section 4

`isMultiSectorWorld(state)` (`economy/sectors.ts:51`) is the single gate on
world version, and world version 1 is frozen so legacy saves replay
byte-identically. **Every proposal below must be gated the same way.**

The decision the owner needs to make: world version 2 is in-flight. If any v2
save must survive, introduce `PRICED_ECONOMY_WORLD_VERSION = 3` and gate on
`config.worldVersion >= 3`. If v2 is still unreleased, fold these into v2 and
keep one gate. **My recommendation: fold into v2 while it is still in flight** —
two gates in `sectors.ts` is a permanent tax on every future reader (inferred; it
is a judgement call, not a fact).

Also load-bearing, and easy to break:
- `SECTORS` order (`contracts/sectors.ts:42`) — appending is safe, reordering is
  not; it drives cycle phase and every per-sector iteration.
- `WORLD_DRIFT_SPECS` order (`economy/macro.ts`) — determines RNG draw order.
  **Append only.**
- `SIM_EVENT_TYPES` (`contracts/sim.ts:25`) is a zod enum. **Append only.**
- Phase RNG is forked per phase (`phaseStream`), so adding a draw in one phase
  cannot shift another's. Adding a *phase* would.

---

## 4. Proposals

Priority is by **living-economy feel per unit of risk**, not by ambition.

### P0 — the five that most change the feel, with the least risk

---

#### P0-1. Sector goods prices along the six-sector chain, with a stateful shortage

**The mechanic.** Each of the six sectors gets a price index, whole number,
baseline 100. It is a stateless function of last quarter's supply and demand
aggregates, exactly like Victoria 3's — no random walk, no memory, no drift. The
one stateful piece is a shortage counter that takes over when the price clamp
saturates, exactly like Victoria 3's throughput debuff.

**Why this one first.** It is the missing noun. Right now the six sectors are a
cycle table; with a price they become an economy you can trade against, and every
later proposal (tolls, cartels, dumping) has something to modify.

**The rule.**

```
supply[s]   = Σ annualised revenue of active companies in sector s
              (already computed — supplyBySector in economy/sectors.ts)

demand[s]   = SUPPLY_COUPLING × Σ_{d ∈ SECTOR_META[s].outputs} supply[d]
              + endDemand[s]

endDemand[s] = supply[s] × sectorDemandCycle(s, quarter) × sectorEndShare[s]

imbalance[s] = clamp((demand[s] − supply[s]) / max(1, min(demand[s], supply[s])), −1, +1)

priceIndex[s] = round(100 × (1 + SECTOR_PRICE_SWING × imbalance[s]))
```

with `SECTOR_PRICE_SWING = 0.75`, giving a hard range of **25 to 175**. Both ends
are reachable at a 2:1 imbalance, which is a number the player can hold in their
head.

`sectorEndShare[s]` is the fraction of a sector's output that goes to end
customers rather than to the other five sectors — proposed constants (inferred,
tune in playtest): ai 0.60, robotics 0.80, manufacturing 0.30, energy 0.20,
logistics 0.30, consumer 1.00. The complement, `1 − sectorEndShare[s]`, is the
**trade share** used below.

**Shortage** (the stateful half, the only one):

```
if imbalance[s] >= 1.0:   shortage[s] = min(60, shortage[s] + 10)
else:                     shortage[s] = max(0,  shortage[s] − 5)
```

Whole number 0..60, deepening twice as fast as it heals. It replaces the current
soft floor in the supply gate:

```
supplyGate[s] = min over inputs i of (1 − shortage[i] / 100)
```

so a fully-developed shortage upstream costs 60% of realised demand — sharp
enough to be a crisis, and it takes six quarters of neglect to get there and
twelve to recover.

**Where the price lands.** Two call sites, one each side of the trade:

1. **Buyer** — in `sectorEconomy()`, replace the input-cost term:
   ```
   inputPrice[s] = mean over i ∈ sectorInputs(s) of (priceIndex[i] / 100)
   inputCostMultiplier[s] = (existing energy × productivity term) × inputPrice[s]
   ```
   Widen `SECTOR_INPUT_COST_BOUNDS` from `[0.85, 1.40]` to `[0.70, 1.80]`.
2. **Seller** — in `companies/financials.ts`, a new revenue line:
   ```
   tradeUplift = round(revenue × (1 − sectorEndShare[s]) × (priceIndex[s]/100 − 1))
   ```
   bounded to ±25% of revenue. Booked as revenue, so equity moves with it and
   double entry is undisturbed.

**Honest note on conservation.** This creates and destroys value without a
counterparty. So does the existing `sectorCostAdjustment` in
`companies/financials.ts:297`. The proposal is therefore *consistent with current
practice*, not a new sin — but a strict inter-sector conservation invariant is
worth doing later (see P2-5).

**Determinism.** Pure function of the draft. No RNG. Prices are computed from
*last* quarter's revenue, because `financial_resolution` is phase 11 and this
runs in phase 1 — which is correct and makes them plannable. Say so in the doc
comment.

**Engine phase.** New `EconomySubsystem.priceSectors(draft, ctx)`, called in
`world_events` immediately after `updateMacro` and before
`computeEventCandidates`. New state: `SessionState.sectorPrices: Record<Sector,
number>` and `sectorShortages: Record<Sector, number>`. Both whole numbers.
`sectorEconomy()` stays pure — it now reads two more fields off the draft.

**sim_events.** Append two types to `SIM_EVENT_TYPES`:
- `sector_price_set` — payload `{ sector, priceIndex, priceIndexBefore, supplyUsd,
  demandUsd, imbalance, shortage }`, visibility `public`. One per sector per
  quarter.
- `sector_shortage_changed` — only when the counter moves, payload
  `{ sector, before, after, gateEffectPct }`, visibility `public`.

Report lines on any move ≥ 5 index points, plus a `warning`-tone line whenever a
shortage deepens.

**Mobile surface — the "Sector Flow" screen.** One tap from home (Railway
Empire's barrels icon). Six rows, one per sector:

- **one number** — the price index, printed bare: `112`. Baseline 100 is the
  anchor the player learns once.
- **twin bars** — demand over supply (Anno's blue-over-green), so the imbalance
  *is* the price and cause sits above effect.
- **one badge** — `SHORT −30%` when `shortage > 0`, in warning colour, with the
  number counting up quarter by quarter so "this is getting worse" is
  unmistakable.

No slider on this screen; it is a readout.

**Tests that pin it.**
1. `sectorPriceIsPureFunctionOfDraft` — same draft, twice, identical prices.
2. `sectorPriceStaysInBand` — over a fuzz of 500 seeded random-ish states, every
   index is an integer in `[25, 175]`.
3. `priceRisesWithDownstreamDemand` — doubling robotics revenue strictly raises
   the manufacturing index (monotonicity).
4. `shortageDeepensBy10AndHealsBy5` — exact step sizes, exact 60 cap, exact 0
   floor.
5. `shortageGateMatchesCounter` — `supplyGate == 1 − shortage/100` for the
   binding input.
6. `worldVersionGateIsByteIdentical` — a v1 (and, if we keep two gates, a v2)
   session replays to the same state hash as before the change. This is the
   important one.
7. Extend `test/determinism.test.ts` to cover a 12-quarter run with prices on.

---

#### P0-2. Regional price basis and the logistics toll

**The mechanic.** Plutocracy's Rockefeller squeeze, made deterministic. A company
that controls a region's logistics sets a toll that every rival in that region
pays on its inputs — and that its own group does not.

**Why.** It is the single most flavourful cross-sector lever available to us,
logistics already exists as a sector with nothing interesting to do, and it makes
a boring low-margin business into a weapon. It also gives regions a reason to be
dynamic rather than a static index table.

**The rule.** All whole numbers, no RNG.

```
logisticsRevenue(r)      = Σ annualised revenue of active logistics companies based in r
controllerRevenue(r, c)  = same, restricted to companies whose ultimate controller is c
dominantShare(r)         = max over c of controllerRevenue(r,c) / max(1, logisticsRevenue(r))

toll(r) = round(TOLL_MAX_PCT × clamp((dominantShare(r) − TOLL_FLOOR_SHARE)
                                     / (1 − TOLL_FLOOR_SHARE), 0, 1))
```

with `TOLL_FLOOR_SHARE = 0.40` and `TOLL_MAX_PCT = 25`. Below 40% regional share
the toll is exactly 0 — you must genuinely dominate before anyone feels it. At
100% it is 25%.

Applied in `companies/financials.ts`, on the cash COGS only:

```
tollPaidPct = (controller of this company === dominant controller of its region) ? 0 : toll(region)
cashCogs   *= (1 + tollPaidPct / 100)
```

The exemption is the holding benefit: your own group rides free. That one line is
the entire Plutocracy fantasy.

**Regional energy basis.** Fold the sector price from P0-1 into the existing
regional energy factor, which is already applied at exactly one call site:

```
regionalEnergyIndex(r) = round(priceIndex.energy × regionEnergyCostFactor(r))
```

`companyEnergyCostFactor` then returns `regionalEnergyIndex(r)/100`. No new call
site, no double-compounding — this respects the discipline `regions.ts` already
enforces.

**Determinism.** Pure. Ties in `dominantShare` break on `REGIONS` order then
company id, as everywhere else.

**Engine phase.** Toll is computed in the same `priceSectors` step as P0-1 (it is
a function of the same aggregates) and stored as
`SessionState.regionTolls: Record<Region, number>`. Consumed in
`financial_resolution`.

**sim_events.** No new type. Extend the existing `cost_recognised` payload with
`{ logisticsTollPct, tollExempt, regionalEnergyIndex }`, and extend
`sector_price_set` (P0-1) with `regionTolls`. Emit a report line — tone
`negative` for payers, `positive` for the controller — the quarter a toll first
becomes non-zero in a region.

**Mobile surface.** On the Financials cost breakdown:

- **one percentage** — `Logistics toll +18%` as a signed line in the itemised
  cost stack, or `Logistics toll — exempt (your group controls 61% of North
  America)` when you are the one charging it.

On Sector Flow, a per-region chip under the logistics row showing the toll.

**Tests.**
1. `tollIsZeroBelowFloorShare` — at 39.9% share the toll is exactly 0.
2. `tollIsMonotoneAndCapped` — non-decreasing in share, never exceeds 25.
3. `dominantControllerIsExempt` — the controller's own companies pay 0.
4. `tollAppearsInCostRecognisedPayload` — auditability: the number on screen
   traces to a committed row.
5. `energyFactorIsNotCompounded` — assert exactly one call site for
   `companyEnergyCostFactor` (a grep test, or a counter in a test build).
6. Determinism and world-version gate, as P0-1.

---

#### P0-3. Trusts and cartels, with antitrust exposure as the brake

**The mechanic.** A price accord between companies in the same sector pays a
bonus that scales with their combined share — floor 5%, as Plutocracy states.
Signing one, dominating a sector, tolling a region and buying rivals all feed one
engine-tracked **antitrust exposure** score, and exposure is what makes the
investigation fire. Accelerator and brake, wired to each other.

**Why.** Without a brake, P0-1 through P0-4 all compound to infinity. And today
antitrust enforcement is a coin flip that has nothing to do with the player's
behaviour, which is the single largest missed feedback loop in the engine.

**The rule — the accord.** A new `DealObligation` kind, `price_accord`, on
`contracts/deals.ts` (the discriminated union appends safely). Binding, both
sides, minimum two companies in the same `Sector`. While active:

```
combinedShare = Σ member annualised revenue / max(1, supply[sector])
cartelBonusPct = 5 + round(25 × clamp01(combinedShare))     // 5 at any share, 30 at 100%
```

Applied to the seller's trade uplift from P0-1:

```
tradeUplift = round(revenue × tradeShare × ((priceIndex/100) × (1 + cartelBonusPct/100) − 1))
```

still bounded to ±25% of revenue, so the accord cannot break the P0-1 clamp.

**The rule — exposure.** A whole 0..100 score per company, recomputed each
quarter in `leaderboard_update` (where `recomputeMetrics` already walks every
company):

```
sectorShare   = company annualised revenue / max(1, supply[its sector])
acqRecent     = acquisitions completed by this company in the last 4 quarters
tollCharged   = toll(region) if this company's controller is dominant there, else 0

raw = 0.90 × exposure_t
    + 40 × sectorShare
    + 25 × (member of an active price_accord ? 1 : 0)
    + 8  × min(2, acqRecent)
    + 20 × (tollCharged / TOLL_MAX_PCT)
    + 8  × predatoryQuarters                                  // from P0-4

exposure_{t+1} = clamp(round(raw), 0, 100)
```

The 0.90 factor means exposure decays about 10% a quarter with no activity, so a
player can *de-escalate* — which is what makes it a decision rather than a
ratchet.

**The rule — enforcement.** In `economy/hazards.ts`, replace the blind draw for
`fam_antitrust` with an exposure-driven hazard:

```
familyHazard(fam_antitrust) = baseHazard × (0.25 + 1.75 × maxExposure / 100)
```

and change `selectCompanySubject(draft, 'concentration', rng)` to weight by
`exposure` rather than by scale alone. The seeded draw stays; only the weights
change, so determinism is untouched.

When it fires, the engine applies a **bounded remedy**, not a narrative:
```
fine     = min(round(cash × 0.05), round(revenueTtm × 0.02))
accordSuspended for ACCORD_SUSPENSION_QUARTERS = 6
exposure -= 30                                    // the investigation clears the air
```
The fine moves cash and equity together. The suspension is an `ActiveModifier`
with `decay: 'none'` and `durationQuarters: 6` — the existing modifier machinery
already handles expiry and ledger rows.

**Determinism.** The exposure score is pure. The firing is a seeded draw from the
existing hazard stream against a changed weight — no new RNG consumption, no
draw-order shift, provided `familyHazard` is changed in place rather than by
adding a draw.

**Engine phase.** Exposure in `leaderboard_update` (phase 16, alongside
`recomputeMetrics`). Accord bonus read in `financial_resolution` (phase 11).
Enforcement in `world_events` (phase 1) via the existing hazard path.

**sim_events.** One new type: `antitrust_exposure_changed`, payload
`{ companyId, before, after, drivers: { sectorShare, accord, acquisitions, toll,
predation } }`, visibility `company` (it is your own compliance risk; rivals
should not see your exact score — this is rule 9 working for us). Reuse
`deal_executed` / `deal_breached` for accords and `world_event_applied` for the
investigation.

**Mobile surface.** On the Company screen:

- **one number** — `Antitrust exposure 62 / 100`, with a three-band colour
  (0–39 calm, 40–74 watched, 75–100 exposed) and, on tap, the five named drivers
  as a signed list. That drill-down is the thing Plutocracy never built.
- **one percentage** — `Cartel bonus +18%` on the accord card in Deal Room.

**Tests.**
1. `cartelBonusFloorIsFive` — at any positive combined share, bonus ≥ 5.
2. `cartelBonusCapIsThirty`.
3. `upliftRespectsP0BoundWithCartel` — accord cannot push trade uplift past ±25%
   of revenue.
4. `exposureDecaysTenPercentWhenIdle` — with all drivers zero, exposure falls by
   exactly `round(0.9 × e)` each quarter and reaches 0.
5. `exposureIsMonotoneInEachDriver` — five separate assertions.
6. `enforcementProbabilityRisesWithExposure` — over a fixed seed set, firing
   count at exposure 90 strictly exceeds firing count at exposure 10.
7. `fineIsBoundedAndBalances` — fine ≤ both caps; balance sheet reconciles after.
8. `accordSuspensionExpiresAfterSixQuarters`.
9. `hazardDrawOrderUnchanged` — the pre-change and post-change RNG consumption
   counts for `world_events` are equal.

---

#### P0-4. Dumping and price wars

**The mechanic.** Make a price cut an *attack* on rivals rather than only a cost
to yourself, and make sustained below-cost pricing feed antitrust exposure. The
monopoly payoff arrives emergently, because `segmentReferencePrice` is
customer-weighted and a dominant seller already drags the reference with it.

**Why.** It closes the loop on the sharpest existing asymmetry: today a price
rise is punished hard (`PRICE_SHOCK_CHURN = 0.75`) and a price cut is free of
consequence for anyone but you. Price wars are the most legible form of
competition a business sim has, and we have the elasticity model already.

**The rule.**

```
undercut(p)  = clamp(1 − price / segmentReferencePrice(segment), 0, 0.60)
predatory(p) = (product gross margin < 0) AND (undercut(p) >= 0.20)
```

Per company, a whole counter:
```
predatoryQuarters = min(8, predatoryQuarters + 1)   when any product is predatory
                  = max(0, predatoryQuarters − 1)   otherwise
```

Rivals in the same segment take a bounded demand penalty in the same quarter:

```
predatorSegmentShare = predator customers in segment / total segment customers
pressure = clamp(PRESSURE_MAX × predatorSegmentShare × (undercut / 0.20), 0, PRESSURE_MAX)
```

with `PRESSURE_MAX = 0.12`. Applied as one more multiplicative term on each
rival's `grossAdds` in `companies/products.ts` — the same place `priceFactor`,
`qualityFactor` and `sectorDemandFactor` already multiply, so it costs one line
and one bound. Pressures from multiple predators combine as
`1 − Π(1 − pressure_k)`, capped at 0.25 total, so a three-way price war cannot
zero out the segment.

And `predatoryQuarters` feeds `antitrust exposure` at 8 points each (P0-3), which
is how the endgame gets its brake.

**What we deliberately do NOT add:** a special monopoly price ceiling. Plutocracy
markets a "3× monopoly price". We get it for free: at ≥ 60% segment share your
own price *is* most of the customer-weighted reference, so the elasticity term
stops penalising you and you can walk the price up over several quarters. It is
emergent, it needs no code, and it is a better story. **State the achievable
ceiling in the UI anyway** — a target the player can hold in their head is the
whole lesson of Section 1.13.

**Determinism.** Pure. Order-independent: compute every product's `undercut` and
`predatory` flag first, then apply pressures, so no company's pressure depends on
the iteration order.

**Engine phase.** `product_demand_resolution` (phase 10), inside the existing
per-company loop but with the segment-wide pass hoisted above it (the same
pattern `sectorEconomy()` already uses to avoid a quadratic walk).

**sim_events.** One new type: `predatory_pricing_flagged`, payload
`{ companyId, productId, segment, price, referencePrice, undercutPct,
grossMarginPct, predatoryQuarters }`, visibility `public` — a price war is public
by nature and it *should* move belief. Extend `demand_resolved` with
`{ rivalPricePressurePct, pressureFrom: [companyId] }` so a rival can see who is
squeezing them.

**Mobile surface.** On the Products screen, per product:

- **one percentage, itemised** — the Plutocracy fix:
  `$38 · segment avg $52 → −27%` with the resulting demand and margin effects as
  two signed lines beneath.
- **one badge** — `PREDATORY · 3 quarters · +24 antitrust` when the flag is set.
- On a squeezed rival: one line in Quarter Resolution — *"Helion cut to $19 and
  took 6% of your gross adds."* Naming the attacker is what makes it feel like a
  populated economy.

**Tests.**
1. `pressureIsZeroWithoutPredator`.
2. `pressureIsBoundedPerPredatorAndInTotal` — ≤ 0.12 each, ≤ 0.25 combined.
3. `pressureIsOrderIndependent` — shuffle company order, identical result.
4. `predatoryRequiresBothConditions` — negative margin alone, or a 30% undercut
   at positive margin, does not flag.
5. `predatoryQuartersDecaysByOne`, caps at 8.
6. `predationFeedsExposureByEight` — cross-check with P0-3.
7. `priceRisePathUnchanged` — the existing `priceShock`/churn behaviour is
   byte-identical, so we have not disturbed a tuned mechanic.

---

#### P0-5. Dividends, convex stake accumulation, and control that means something

**The mechanic.** Three small additions that together turn the existing, correct
capital machinery into a takeover game: a payout slider, a rising marginal price
for buying a rival, and a 50%+1 threshold that actually flips control.

**Why.** Dividends are the single cleanest decision in a quarterly business sim
and we have none. The rising marginal price is what makes the last 10% of a
company hurt, in both Capitalism (+2% price per 1% acquired) and OTC (doubled
price for contested blocks). And Plutocracy's whole design hangs on 50%+1 being
*the* threshold.

**Rule (a) — dividend policy.** New action
`set_dividend_policy { payoutPct: int 0..80 }`, and a new
`BOARD_PROPOSAL_KINDS` entry `dividend` (appending to that array is safe). New
company field `dividendPolicyPct: number` (whole, default 0).

Settled in `capital_resolution` (phase 6), on **last** quarter's net income —
because `financial_resolution` is phase 11, and saying this out loud in the doc
comment is what stops a future reader from "fixing" it:

```
payable  = max(0, netIncomeLastQuarterUsd) × dividendPolicyPct / 100
dividend = round(min(payable, cash × 0.5))
```

Cash and equity both fall by `dividend`; holders receive pro rata, and the
player's own slice lands in their personal cash. The identity holds by
construction.

Two second-order effects, both bounded:
- `reputation.investor += min(6, round(dividendPolicyPct / 10) × 2)` while a
  payout is being made — the market likes being paid.
- Retained capital falls, so growth slows. That is the tension, and it needs no
  code: it falls out of the cash balance.

**Rule (b) — convex accumulation.** In `markets/settlement.ts`, an execution
price rather than a flat quote:

```
floatFraction  = sharesBought / max(1, floatShares)
impactPct      = round(100 × STAKE_IMPACT × floatFraction)      // STAKE_IMPACT = 1.0
executionPrice = round2(quote × (1 + impactPct / 100))

// blocks not in the public float — a named holder's position — cost double
blockPrice     = round2(quote × BLOCK_PREMIUM)                  // BLOCK_PREMIUM = 2.0
```

Buying the entire float costs 2× the quote; picking up a named holder's block
costs 2× flat. Both bounded, both whole-cent, both deterministic. This is the
"the last 10% is the expensive 10%" property, and it is what pushes a raider out
of the anonymous market and into negotiation — which is where our LLM characters
live.

**Rule (c) — control.** Two thresholds with engine consequences, taken from
`OWNERSHIP_THRESHOLDS`:

- **≥ 25%** — an information right. The holder's `disclosure_resolution`
  projection includes the target's reported fundamentals a quarter early. Routed
  through the existing `resolver/projection.ts` audience machinery, so rule 9 is
  respected: it is an *entitlement*, not a leak.
- **≥ 50% + 1 share** — in `boards/tally.ts`, the controlling holder's stance is
  decisive on every `BoardProposalKind` except `ceo_dismissal` (which stays a
  genuine board matter, so a controlling player can still be fired — that is a
  better story). Below 50%, tallying is unchanged.

**Determinism.** All pure except the existing seeded paths, which are untouched.
The dividend is whole dollars. Execution price is whole cents.

**Engine phase.** Dividends in `capital_resolution` (phase 6), after buybacks and
before acquisitions, so a company cannot pay a dividend with money it needs for a
deal it already agreed. Accumulation in `market_resolution` (phase 13, in
`settleTrades`). Control in `board_resolution` (phase 5).

**sim_events.** One new type: `dividend_paid`, payload
`{ companyId, payoutPct, netIncomeBasisUsd, dividendUsd, perShareUsd,
cashAfterUsd }`, visibility `public`. Extend `shares_traded` with
`{ quotePriceUsd, executionPriceUsd, impactPct, blockPremiumApplied }`. Reuse
`ownership_threshold_crossed` for control, with a new payload field
`{ grantsControl: boolean }`.

**Mobile surface.**

- **one slider** — payout 0–80% in steps of 5, on the Capital screen, paired with
  a numeric field (Coffee Inc 2's documented mobile anti-pattern is
  slider-without-type-in), and a live preview: *"At 30%: $4.2m to shareholders,
  $9.8m retained."* Showing the counterfactual is the thing Plutocracy never does.
- **one number** — `Your stake 41% · control at 50%` with a progress bar to 50,
  on the Markets screen. One number, one target, the whole Plutocracy loop.
- **one percentage** — `Price impact +7%` shown *before* the buy is confirmed, so
  slippage is a decision and not a surprise.

**Tests.**
1. `dividendBalancesTheSheet` — assets, liabilities and equity reconcile after a
   payout, at every payout percentage from 0 to 80 in steps of 5.
2. `dividendIsCappedAtHalfCash`.
3. `dividendOfZeroPaysNothingAndEmitsNothing`.
4. `dividendUsesPriorQuarterNetIncome` — an explicit regression test, because
   this is the thing a future reader will "fix".
5. `executionPriceIsMonotoneInSize` and `neverExceedsDoubleQuote`.
6. `blockPurchaseCostsDouble`.
7. `capTableReconcilesAfterEveryTrade` — extend the existing ownership invariant
   test to the new price path.
8. `controlFlipsAtFiftyPercentPlusOne` — at exactly 50.0% the holder is not
   decisive; at 50% + 1 share they are.
9. `ceoDismissalIsNotControlled` — a controlling holder can still lose the vote.

---

### P1 — the next tier

Shorter treatment; each is a real proposal, none is a P0 risk.

**P1-1. Agents: costed covert actions with visible detection risk.**
Plutocracy's roster of named specialists
([agents](https://store.steampowered.com/news/app/754500/view/4645982290500918401)),
minus the crimes. Four to start: an **Analyst** (reveals a rival's private
fundamentals for one quarter), a **Comms Operator** (moves one market belief's
probability by a bounded amount), a **Supply Buyer** (pre-buys a sector's output,
raising `demand[s]` in P0-1 for two quarters), a **Complainant** (raises a named
rival's antitrust exposure by 10, once). Each has a cash cost, a named character,
and a **shown** detection probability; detection is a seeded roll that costs
reputation and relationship standing. Escalating cost per use and OTC's
`1/(1+0.1n)` diminishing duration are the anti-spam clamps — import them
verbatim, because our LLM strategists *will* find a dominant harassment loop.
Crucially: an agent's effect is engine-computed order flow or a bounded belief
delta; the LLM supplies only the character's words. Rule 3, exactly.

**P1-2. A media/narrative asset.** Buying a controlling stake in a media company
lets you shift *public belief* about a company without touching its private
fundamentals — which is rule 9 made into a purchasable asset. Effectiveness
scales with circulation
([media update](https://store.steampowered.com/news/app/754500/view/4645982290500918269)).
The engine owns the belief delta; the LLM writes the article. This is our
strongest thematic fit and it slots into `markets/beliefs.ts` with no new
machinery.

**P1-3. Operating modes (Victoria 3 production methods).** Two or three named
recipes per sector — "in-house compute" vs "rented compute", "human ops" vs
"robotic ops" — that change the input mix and headcount, with a one-quarter
installation lag and automatic fallback when an input becomes unavailable
([production methods](https://vic3.paradoxwikis.com/Production_method)). This is
what turns an input-price shock from something you suffer into something you
respond to, and it gives the LLM strategists a small discrete action space that
produces good reasoning traces.

**P1-4. Marketing relative to the sector average, with a reach cap.** Two
imports that compose: Plutocracy's relative benchmark (spend above the sector
mean earns a price markup, below it a penalty) and Capitalism's reach ceiling
(brand awareness cannot exceed the summed rating points of your contracted
channels, so money sets the *rate* of climb and channels set the *ceiling*)
([advertising](https://www.capitalism2.com/forum/viewtopic.php?t=8339)). Today
`marketingLift` is a saturating function of absolute spend; making it relative
turns it self-balancing, and making the ceiling channel-bound kills the "spend
more" dominant strategy.

**P1-5. Credit rating and a financing window that shuts.** We already have a
real risk-premium ladder in `offeredDebtRate`. Surface it as a letter grade
(AAA…D) computed from leverage, interest coverage and earnings volatility, and
narrow or close the issuance window when the macro model contracts
([bonds](https://www.capitalismlab.com/banking-dlc/corporate-bonds/)). Add
Plutocracy's cap — **loans may not exceed the borrower's net assets** — as a
balance-sheet invariant of exactly the kind the gate already enforces. Combined
with P0-5 this creates the full distress loop: cheap money → overexpansion → rate
rise → covenant stress → forced share sales → raid.

**P1-6. Rival personas drawn from a difficulty-widened distribution.**
Capitalism samples each AI's temperament from a range whose *width* is the
difficulty setting, rather than shifting every rival uniformly, and decomposes
difficulty into price aggressiveness, expansion aggressiveness and competence
([AI settings](https://capitalism2.com/forum/viewtopic.php?t=8007)). Persist a
persona per NPC company and feed it into the strategist prompt so the LLM argues
in character while the engine bounds what it can do. **Heed the documented
failure:** giving AI competitors very large starting capital made the game
*easier*, because it removed their urgency. Constrain rival cash and enforce
solvency pressure, or our LLM rivals will read as inert.

**P1-7. Trusts that converge technology.** Plutocracy's trust — members climb
toward the alliance's maximum tech level over time — mapped onto our typed
`TechGraph`. A deterministic convergence rate per quarter, negotiable by LLM
rivals, giving the tech graph a social dimension
([trust thread](https://steamcommunity.com/app/754500/discussions/0/1750142526436093680/)).

### P2 — later, or only if playtest asks

- **P2-1. Product tiers.** One product line sold at two or three quality/price
  points against different segments
  ([product customization](https://www.capitalismlab.com/subsidiary-dlc/product-customization/)).
  Multiplies depth with no new subsystem — the same rating math runs per tier —
  but it multiplies screen count on a phone. Gate behind mid-game.
- **P2-2. Government procurement as a supply sink.** Winning a contract should
  measurably tighten the open market for that sector's output, so procurement
  matters to companies that did not bid — OTC's Offworld Market, applied
  ([Offworld Market](https://offworldtradingcompany.fandom.com/wiki/Offworld_Market)).
  Cheap once P0-1 exists: a won contract adds to `demand[s]` for its term.
- **P2-3. An off-the-shelf procurement rail.** Every input purchasable at a small
  premium and a slightly-below-frontier quality, always available, congesting as
  everyone leans on it — Capitalism's seaport, capped "one notch below average"
  so the shortcut is viable early and degrades exactly as you outgrow it
  ([Seaport](https://capitalismlab.fandom.com/wiki/Seaport)).
- **P2-4. Analyst expectations as a self-referential benchmark.** Score a quarter
  against the player's own trailing best plus 10–20%, and let beats and misses
  move the stock — which is both Game Dev Tycoon's review algorithm and how real
  earnings work
  ([review algorithm](https://gamedevtycoon.fandom.com/wiki/Review_Algorithm/1.4.4)).
  Our belief-pricing layer is the natural home.
- **P2-5. An inter-sector conservation invariant.** Assert that the sum of trade
  uplifts paid by buyers equals the sum received by sellers, to within a
  tolerance, and add it to `SIMULATION_INVARIANTS`. This would retire the honest
  caveat in P0-1 and in the existing `sectorCostAdjustment`.
- **P2-6. Brand as awareness + loyalty.** Awareness bought with spend and
  decaying 1–2 points a quarter; loyalty earned from delivered quality and able
  to go *negative* after a scandal; awareness gates the rate at which loyalty can
  grow ([brand](https://www.capitalismlab.com/resources/gameplay-faq/brand/)). A
  genuinely better model than a single reputation score — but we have four
  reputation audiences already, and doubling that is a lot of screen for the gain.

---

## 5. What NOT to copy, and why

**Against determinism (rule 4).**

1. **OTC's real-time per-trade price mutation.** Price as mutable state that
   every transaction rewrites, continuously, is fundamentally incompatible with
   `S_{t+1} = F(S_t, actions, modifiers, seed)`
   ([Market](https://offworldtradingcompany.fandom.com/wiki/Market)). The
   adaptation is what P0-5(b) does: process recorded trades in a fixed
   deterministic order within one quarter's resolution, against a bounded impact
   function. Same feel, replayable.
2. **Any stochastic price *process*.** None of the benchmark games uses one, and
   we should not start. Bounds, not dynamics.
3. **Anything that would add a resolution phase or reorder `WORLD_DRIFT_SPECS`,
   `SECTORS` or `SIM_EVENT_TYPES`.** RNG is forked per phase precisely so a new
   draw cannot shift another phase's sequence; a new *phase* would shift
   everything. Append, never insert.
4. **Wall-clock anything.** `durationMs` is zero by construction in
   `resolver/index.ts` for exactly this reason.

**Against LLM-proposal-only (rule 3).**

5. **Plutocracy's negotiation as the *source* of price.** In Plutocracy the
   counterparty's Economics and Diplomacy skills set the price, and the
   negotiation itself moves it
   ([negotiation](https://steamcommunity.com/app/754500/discussions/0/669453270933050209/)).
   If we let an LLM negotiate a price, an LLM will eventually talk its way past
   the bounds. The rule for every deal we build: **the engine computes the
   acceptable price band from the counterparty's deterministic stats; the LLM
   supplies the words and a stance inside that band.**
6. **Letting the World Director set a sector price.** It may only propose bounded
   modifiers on registered target paths, clamped by the impact budget — which is
   what `clampGmBatch` and `validateModifierProposals` already enforce. If sector
   prices become a modifier target, register them with explicit bounds in the
   target-path registry like every other index.
7. **Media that writes a belief.** In P1-2 the engine owns the belief delta; the
   model writes only the article text.

**Against phone legibility.**

8. **Plutocracy's opacity — the actual failure.** A modifier stack you cannot
   itemise is a slot machine with spreadsheets
   ([supply/demand request](https://steamcommunity.com/app/754500/discussions/0/3044979493854436180/)).
   Every proposal in Section 4 specifies its surface for this reason. The rule:
   **if the engine multiplies it, the screen must name it and sign it.**
9. **Game Dev Tycoon's hidden target ratio.** A per-genre optimum you can only
   learn from community cheat sheets is fine on a desktop with a wiki open; it is
   hostile on a phone
   ([success guide](https://gamedevtycoon.fandom.com/wiki/Success_Guide)). Where
   we adopt a target band, show the band.
10. **Deep production chains with per-unit logistics.** Anno's chains work
    because there is a map and the game is about the map
    ([production chains](https://anno1800.fandom.com/wiki/Production_chains)). We
    have no map and four decisions a quarter. Two to three steps, no
    intermediates — which is exactly what `SECTOR_META` already declares.
11. **Per-city, per-store micromanagement.** Coffee Inc 2's own reviewers
    describe the game as overwhelming, and Plutocracy's forum says the same about
    fifty states of NPCs
    ([review](https://appstoreview.com/review/coffee-inc-2-ios)). Every mechanic
    we add must either be a slider or be delegable.
12. **Slider-only numeric entry.** A documented mobile anti-pattern: players ask
    for a type-in box because a slider cannot hit an exact wage or an exact share
    count ([feedback](https://gamingroute.com/4224-2/)). Pair every slider with a
    numeric field and preset chips.

**Against balance.**

13. **Plutocracy's share-issue money loop.** Max the issue, buy in with your own
    cash, max the loan, merge, issue again, sell at +200%, repeat
    ([guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2334105921)).
    Bound issue size relative to existing market cap, require a board vote
    (`BOARD_PROPOSAL_KINDS` already has `financing`), and cap leverage at net
    assets (P1-5).
14. **Capitalism's buyback accounting bug.** Players report buybacks booked as a
    P&L expense rather than as a capital movement
    ([thread](https://www.capitalism2.com/forum/viewtopic.php?t=8192)). Ours is
    already correct — `resolveBuybacks` moves cash and equity together and does
    not touch income. Do not "fix" it into a cost line.
15. **Capitalism's issue/buyback book-value arbitrage** — issue, wait for
    price/book to fall to ~0.7, buy back, watch it climb to 1.2, repeat
    ([thread](https://www.capitalism2.com/forum/viewtopic.php?t=5086)). We are
    protected by design: our anchor is fundamentals *and* belief, not book value,
    and `V2_ANCHOR_PULL` is partial. Keep it that way.
16. **Giving NPC rivals large starting capital to make them harder.** It made
    Capitalism *easier*, because a rival with no cash pressure makes lazy
    decisions ([thread](https://capitalism2.com/forum/viewtopic.php?p=42368)).
    Our LLM strategists will do the same. Constrain their cash.

**Against tone and product.**

17. **Plutocracy's illegal-action catalogue** — arson, staged accidents, hitmen,
    the Bandit agent ([store page](https://store.steampowered.com/app/754500/Plutocracy/)).
    Wrong game and wrong product. P1-1 keeps to business-legal hardball with a
    reputational cost.
18. **Acquisition as the only verb.** Plutocracy will not let you found a
    company, and its own players say so
    ([thread](https://steamcommunity.com/app/754500/discussions/0/4294816752261734407/)).
    Founding is the Frontier Capital fantasy.
19. **Anno's fixed prices as the whole model.** It works there because scarcity is
    spatial and permanent ([Trade](https://anno1800.fandom.com/wiki/Trade)); for
    us it would contradict rule 9 outright. *Do* keep the narrow version: a
    government contract at a fixed price is a legitimate island of stability
    inside a volatile market, and Anno shows players find that restful rather than
    boring when the interesting decision lives elsewhere.

---

## Appendix — files a P0 implementer will touch

| Proposal | Contracts | Simulation | Web |
|---|---|---|---|
| P0-1 | `sectors.ts` (constants), `world.ts`/`session.ts` (`sectorPrices`, `sectorShortages`), `sim.ts` (2 event types), `engine.ts` (`priceSectors` on `EconomySubsystem`) | `economy/sectors.ts`, new `economy/prices.ts`, `economy/index.ts`, `companies/financials.ts`, `resolver/index.ts` (phase 1 call) | new Sector Flow screen |
| P0-2 | `sectors.ts` (`TOLL_*`), `session.ts` (`regionTolls`) | `economy/prices.ts`, `economy/regions.ts`, `companies/financials.ts` | `financials`, Sector Flow chips |
| P0-3 | `deals.ts` (`price_accord`), `company.ts` (`antitrustExposure`), `sim.ts` (1 event type) | `economy/hazards.ts`, `economy/eventFamilies.ts`, `companies/metrics.ts`, `companies/financials.ts`, `resolver/routing.ts` | `company`, `deal-room` |
| P0-4 | `sim.ts` (1 event type), `company.ts` (`predatoryQuarters`) | `companies/products.ts`, `companies/balance.ts` | `products`, `quarter-resolution` |
| P0-5 | `actions.ts` (`set_dividend_policy`), `governance.ts` (`dividend` kind), `company.ts` (`dividendPolicyPct`), `sim.ts` (1 event type) | `resolver/capital.ts`, `markets/settlement.ts`, `boards/tally.ts`, `validator/rules.ts` | `capital`, `markets`, `boardroom` |

Five new `SIM_EVENT_TYPES` in total: `sector_price_set`,
`sector_shortage_changed`, `antitrust_exposure_changed`,
`predatory_pricing_flagged`, `dividend_paid`. All appended. Everything else
reuses an existing type with additional payload fields, which keeps the ledger's
audit surface stable.

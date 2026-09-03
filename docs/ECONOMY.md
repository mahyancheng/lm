# Economy

How a company earns, spends, is valued, is financed and is bought. Everything
here is resolved deterministically in phases 6 through 13 of the quarter
resolver; nothing in this document is an LLM decision.

## 1. The company

A company is not the player. The player controls a *character*, who may or may
not be the CEO and may or may not own a controlling stake.
`Company.controllerPlayerId` records who directs actions; ownership lives in the
cap table; executive control lives in the board. A board can separate the two at
any time and the campaign continues.

### Archetypes and tiers

Eight archetypes shape cost structure, demand curve and capability priors:
`frontier_lab`, `enterprise_ai`, `consumer_ai`, `infrastructure`, `chip_maker`,
`cloud`, `data`, `defence_ai`.

Three simulation-fidelity tiers control how much thinking a company gets:

| Tier | Population | Decision method |
|---|---:|---|
| `major` | 4–10 | Full LLM strategic planning every quarter |
| `significant` | 20–50 | Rule-based strategy, occasional LLM deliberation |
| `background` | Hundreds | Deterministic archetype AI |

A background startup is promoted only when it becomes strategically relevant —
for example when a player begins evaluating it for acquisition. That yields the
illusion of a huge living economy without hundreds of model calls per turn.

Eight postures drive quarterly behaviour: `aggressive_growth`, `balanced`,
`efficiency`, `research_first`, `land_grab`, `consolidation`, `defensive`,
`survival`.

## 2. Products and demand

Each `Product` carries a segment (`consumer`, `enterprise`, `developer_api`,
`government`), a price per seat per quarter, active customers, quarterly churn
and gross growth, gross margin, compute intensity and a quality score relative
to the market frontier.

Demand resolution, per product, in `product_demand_resolution`:

```text
base demand   = segmentDemand(sector.demand, world.society.*, world.macro.consumerDemand)
quality edge  = qualityScore - marketFrontierQuality(segment)
price effect  = elasticity(segment) × (price / referencePrice - 1)
reputation    = reputation.<audience for segment> / 100
capacity cap  = servingCapacity(compute) / computeIntensity

grossAdds     = base × (1 + quality edge) × (1 - price effect) × reputation
                × marketing lift × company.demandMultiplier
customers_t+1 = min(capacity cap, customers_t × (1 - churn) + grossAdds)
revenue       = customers_t+1 × pricePerSeat
```

Two properties matter. **Capacity is a hard cap**: a company that sells more
inference than it can serve does not book the revenue, it books churn instead.
And **churn is segment-shaped**: 0.05 per quarter is healthy enterprise, 0.20 is
a leaking consumer product.

Elasticity by segment (design defaults, held as balancing data):

| Segment | Price elasticity | Typical churn | Reputation audience |
|---|---:|---:|---|
| `consumer` | 1.6 | 0.12–0.22 | `public` |
| `enterprise` | 0.7 | 0.03–0.08 | `enterprise` |
| `developer_api` | 1.2 | 0.06–0.14 | `developer` |
| `government` | 0.4 | 0.01–0.03 | `government` |

## 3. People

`EmployeeBase` holds headcount across five roles (`engineers`, `researchers`,
`sales`, `ops`, `execs`), average fully loaded annual compensation, morale (0–100),
attrition and open roles.

Hiring fills at a rate determined by talent supply, the company's reputation
with the talent audience and the chosen `CompBand` (`below_market`, `market`,
`above_market`, `top_of_market`). Raising the band fills roles faster and lifts
retention, at proportionally higher payroll and with a knock-on effect on
existing staff expectations.

```text
fillRate      = base(role) × world.talent.<role>Supply × repFactor × bandFactor
attrition_t+1 = f(morale, world.talent.salaryPressure, compBand, layoffs,
                  controversial contracts, missed promises)
payroll       = headcount × avgComp / 4 + loaded cost of open roles
```

Researchers are the binding constraint on research throughput far more often
than money is. Layoffs always damage morale; the size of the damage depends on
severance (`severanceQuartersOfPay`) and on what else the company is spending on
at the same time.

## 4. Compute

`ComputeHoldings` distinguishes three procurement modes with genuinely different
risk:

| Mode | Field | Exposure |
|---|---|---|
| Owned | `ownedAccelerators` | Depreciating capital; immune to spot swings |
| Reserved | `reservedAccelerators`, `reservationExpiryQuarter` | Locked price for a term |
| On-demand | `cloudSpendQuarterly` | Fully flexible, fully exposed to `world.compute.spotPrice` |

`trainingAllocation` splits held capacity between training and serving; serving
gets the remainder. Pivoting compute from training into enterprise inference is
the canonical way to survive a shortage.

```text
computeCost = ownedAccelerators × depreciationPerQuarter
            + reservedAccelerators × reservedRate(locked at reservation time)
            + cloudSpendQuarterly × world.compute.spotPrice
            + energyDraw × world.energy.electricityPrice
```

Letting a reservation lapse into a shortage is a classic way to lose a session.
`computeUtilisation` punishes both directions: sustained low utilisation is
wasted capital, sustained high utilisation blocks new training runs.

### 4.1 Every purchase has a counterparty (world version 2)

Compute used to be bought from a price index: money left the buyer and arrived
nowhere. From world version 2 it is bought from a **named company**, out of
capacity that company actually holds, at a price its own region and its own load
produce. World 1 is untouched — it has no sellers at all, and its ledger and its
frozen hash are unchanged.

| Offering | Sold by | Bound on what they can sell |
|---|---|---|
| `cloud` | infrastructure, cloud and chip companies | held capacity beyond their own serving need |
| `reservation` | the same companies | the same capacity |
| `accelerators` | manufacturers: `chip_maker`, or the `semiconductors` sector | a quarter of fab output, from their plant at list price |

Sellers are **derived, never stored**: `sellersFor(draft, offering, buyer)` reads
who is active, what they hold and what they are using, and sorts cheapest first
with ties broken by id. `resolveComputeSeller` honours a named counterparty when
it still has something to sell and otherwise takes the cheapest company that
could fill the order whole — so the validator, the resolver and the interface all
name the same company.

**Price.** A seller's quote is the world index times a per-seller factor:

```text
sellerFactor = clamp(1 + 0.5 × (regionalEnergyIndex/100 − 1)
                       + 0.3 × (utilisation − 0.5),  0.7, 1.5)

cloudUnitPrice       = CLOUD_UNIT_COST_USD_PER_QUARTER    × spotPrice     × sellerFactor
reservationUnitPrice = RESERVED_UNIT_COST_USD_PER_QUARTER × reservedPrice × sellerFactor
acceleratorPrice     = ACCELERATOR_UNIT_PRICE_USD
                     × (0.5 + 0.5 × spotPrice)                  // half contracted, half market
                     × clamp(1.5 − mean(acceleratorSupply, fabCapacity), 0.6, 1.5)
                     × sellerFactor
```

Energy because a datacentre's marginal cost is electricity and electricity is the
one input priced locally; utilisation because a seller with a full fleet is
selling the last of it. The chosen factor is stored on the buyer's
`ComputeHoldings` (`cloudProviderFactor`, `reservationProviderFactor`) so the
recurring charge keeps tracking the world's indices while the counterparty's own
premium stays fixed until the order is rewritten.

### 4.2 Owning capacity: `buy_accelerators`

`buy_accelerators { units, maxPricePerUnitUsd, sellerCompanyId }` buys
accelerators outright. `ACCELERATOR_UNIT_PRICE_USD` is $32,000, chosen against
the rent: reserving costs $2,100 a quarter forever, so the cash is paid back in
about fifteen quarters and the P&L charge is lighter from the first quarter
(declining-balance depreciation opens at $1,760 against $2,100 of rent).

- **Validator.** Refused in world 1 (`requirement_not_met`). Refused for zero
  units. Clamped to the seller's shippable units. Cash is *noted*, never
  clamped — the note states where the balance lands and the solvency clock.
- **Resolution, phase 10.** `ownedAccelerators += units`, and a sim event
  `accelerators_bought {buyerCompanyId, sellerCompanyId, units, unitPriceUsd,
  totalUsd, ownedBefore, ownedAfter}`. A clearing price above the buyer's
  ceiling fails instead, with a `cost_recognised` row of kind
  `accelerator_purchase_failed`.
- **Cash, phase 11.** The compute phase stages the order on
  `pendingAcceleratorPurchases`; the financial phase — the only phase that moves
  cash — pays for it: cash down, property/plant/equipment up by the same figure,
  `financials.capex` set to the total, and the investing line of the filed
  `FinancialQuarter` carrying it. Equity does not move, so the double-entry gate
  sees a matched pair.

### 4.3 The seller's side

`counterpartyCharges(draft)` restates, per quarter, exactly what `computeCost`
has already billed each buyer — reserved units at the reserved index times the
provider's factor, cloud spend at the spot index — plus each staged accelerator
purchase, and attributes it to the **seller**. The financial phase adds that to
the seller's revenue and books COGS against it at the seller's own realised
margin from the quarter it last filed (`counterpartyMarginOf`, defaulting to 45%
for a company with no filed revenue). The buyer's books are untouched by this: it
has already been charged once, and charging it twice is the failure mode the
whole arrangement is built to avoid.

A seller that has since been wound up is skipped rather than credited: a balance
sheet that no longer exists cannot recognise revenue, and the buyer's cost stands
either way. NPC purchases go through the same validator and the same resolution,
so rivals buy from rivals on identical terms.

## 5. Financial statements

`Financials` is the quarterly P&L and cash position; every figure is for the
quarter just resolved, not annualised.

```text
revenueQuarterly        product revenue + recognised contract milestones
- cogs                  serving compute + support + delivery
= grossProfit
- payroll
- marketing
- rdSpend               excludes compute booked to capex
= operatingIncome
- interestExpense       debt × rate
= netIncome
+ depreciation - capex - Δworking capital
= freeCashFlow
```

`quarterlyBurn` is the signed net cash movement.

In **world version 1**, cash is floored at zero: the unfunded shortfall is
pushed into `payables`, the company is "financed by its suppliers", and a
`bridge` round is forced.

From **world version 2** cash is signed and the floor is gone — see
[§5.1 Solvency](#51-solvency).

`deferredRevenue` (billed, not yet recognised) and `backlogUsd` (contracted, not
yet billed) exist principally for government work: an award creates backlog
before it creates revenue.

### 5.1 Solvency

Two rules, and they are the owner's words:

> You should not reject or clamp a user decision because of cash available.
>
> Bankruptcy is counted when a player — including bots — has a negative cash
> balance for two straight quarters.

World version 2 implements exactly that and world 1 is untouched.

**Cash never refuses an instruction.** Every `insufficient_cash` site in
`validator/rules.ts` still *reserves* the commitment in the batch budget — the
previews, the next action in the same submission and the ledger all need to know
what was promised — but instead of rejecting or clamping it records a note:

```text
Takes cash from $4m to -$9.2m; 2 quarters below zero and the company is wound up.
```

The note carries `insufficient_cash` as an **advisory** code, so the interface
colours it as a warning. Reasons that are not about cash — supply, headcount, an
unknown target, a value out of bounds, a board matter — reject and clamp exactly
as before.

**The overdraft charge.** A negative balance is an unsecured loan nobody agreed
to make, so it is priced:

```text
overdraftCharge = max(0, -openingCash) × (world.macro.policyRate + OVERDRAFT_SPREAD) / 4
```

`OVERDRAFT_SPREAD` is 6% a year over the policy rate. The charge is struck on
the **opening** overdraft — the quarter's own spending has not been financed yet
— and booked as `interestExpense`, so it flows through net income, through the
double-entry roll-forward and through `financial_integrity`, which reads it
inside the `interestUsd` figure on the quarter's `cost_recognised` row. A
separate `cost_recognised` staging row (`kind: 'overdraft_interest'`) states the
charge on its own for the ledger drawer; being kinded, it is not counted twice.

**The clock.** `negativeCashQuarters(company)` counts consecutive closed quarters
with `balance.cashUsd < 0` from the tail of `financialHistory`. It is derived,
never stored: there is no counter to drift away from the accounts, and a save
restored from any quarter recomputes the same figure.

- After the **first** negative close: an `information_revealed`
  (`kind: 'solvency_warning'`) row, a report line — *"one more quarter below zero
  and X is wound up"* — and an alert on the Command Centre. Posture becomes
  `survival`.
- After the **second** consecutive negative close
  (`SOLVENCY_NEGATIVE_QUARTERS = 2`): `enterAdministration` with the cause
  `insolvent`. The row and the report line say *"two quarters of negative cash"*.
  This is the whole bankruptcy rule of world 2, for the player's company and for
  every bot; the world-1 routes (`failed_rescues`, `chronic_distress`) are not
  reached at all.

**The bridge asymmetry.** A company whose `controllerPlayerId` is not null is
**never** force-bridged: the founder raises, borrows, sells or cuts, or the clock
runs out. An NPC company still gets `queueBridgeRound` when its cash closes
negative — that bridge is the bot's own raise, and it can still fail on investor
appetite.

**Estate arithmetic.** A wind-up realises the estate at
`ADMINISTRATION_ASSET_RECOVERY` and pays creditors in order out of what it
raises. An overdrawn estate can be worth less than nothing, so it pays nobody and
every obligation is written off; the equity movement the administration row
declares is still exactly `writtenOff - impairment`, which is what keeps
`financial_integrity` satisfied through a wind-up.

### Market entry, and the seat that closes

**A failure is a gap and the money finds somebody else.** In the same phase,
immediately after the distress step, one new company is founded for every company
wound up this quarter — at most `ENTRANTS_PER_QUARTER` (2), and none at all once
active non-husk companies reach `ACTIVE_COMPANY_CAP` (40). The entrant takes the
dead company's sector; its region, archetype, name, founder and seed cheque are
drawn from `ctx.rng` and from state, the cheque sized off the sector, the
region's capital depth and `world.capitalMarkets.ventureLiquidity`. A venture
entity with the dry powder leads the round and takes the stake, which is the same
accounting a term sheet does: `dryPowderUsd` moves, and the
`funding_round_closed` row declares the movement so `capital_integrity` can
reconstruct it.

**A bankrupt player is out.** When the company a player directs is wound up,
`SessionPlayer.eliminatedQuarter` is set and the validator refuses every later
instruction from that seat. Nothing else changes: the husk stays purchasable, and
an entrant is founded into the player's slot exactly as into a bot's.

See [SIMULATION.md §9.1](./SIMULATION.md#91-solvency-and-what-the-validator-is-for).

### Balance sheet invariant

```text
assets      = cash + ppe + goodwill + investments + receivables
liabilities = debt + payables + deferredRevenue

INVARIANT:  | assets - liabilities - equity |  ≤  BALANCE_SHEET_TOLERANCE_USD ($1)
```

Checked for every company before every quarter commit
(`balanceSheetReconciles`). A failing check blocks the commit and restores the
pre-resolution snapshot. Equity may legitimately be negative for a distressed
company; the identity still has to hold.

## 6. Valuation anchors

Fundamental value is estimated by a method chosen from company maturity, and
prices are pulled toward the anchor over several quarters rather than snapping
to it.

| Maturity | `ValuationMethod` | Inputs |
|---|---|---|
| Early startup | `revenue_multiple` | Revenue multiple + probability-weighted growth |
| Growth company | `forward_revenue_quality` | Forward revenue + gross margin + net retention + growth |
| Mature company | `earnings_fcf` | FCF/earnings + growth + balance sheet |
| Infrastructure | `asset_cashflow_utilisation` | Cash flow + asset value + utilisation |
| Pre-revenue frontier lab | `technology_option_value` | Option value + capital requirement + strategic probability |

Each anchor stores the named `inputs` that produced it, so the Markets screen
can show the working, plus a `confidence`. Low confidence widens the band in
which sentiment dominates — which is exactly right for a pre-revenue lab.

Worked shape for a growth company:

```text
anchor = forwardRevenue
       × baseMultiple(sector)
       × world.capitalMarkets.sectorMultiples
       × sector.multiple
       × qualityAdj(grossMargin, netRetention, growth)
       ÷ discountAdj(world.macro.policyRate + world.macro.creditSpreads)
```

## 7. The quarterly return model

```text
r_{i,t} = β_m·M_t + β_s·S_t + α_fundamental + E_public + N_sentiment
          + L_liquidity + σ_i·ε

P_{i,t+1} = P_{i,t} · e^{r_{i,t}}
```

Fundamentals gradually pull prices toward the valuation anchor while public
information, sector sentiment and volatility create short-term deviations. Every
term is stored in a `ReturnDecomposition`:

| Term | Field | Source |
|---|---|---|
| β_m·M_t | `marketBeta` | Instrument beta × in-world market factor |
| β_s·S_t | `sectorBeta` | Sector sentiment and multiple movement |
| α_fundamental | `fundamentalAlpha` | Pull toward the anchor: what was actually delivered |
| E_public | `publicInfoEffect` | Guidance, earnings surprise, awards, leaks |
| N_sentiment | `sentimentEffect` | Narrative unsupported by fundamentals |
| L_liquidity | `liquidityEffect` | Index inclusion, block purchases, forced selling |
| σ_i·ε | `noise` | Seeded RNG residual — deterministic given the seed |

**INVARIANT:** the seven components sum to `total` within
`RETURN_DECOMPOSITION_TOLERANCE` (1e-9), so the "why did my stock move?" screen
always adds up. A company can therefore carry a fully explained premium:

```text
Estimated fundamental value       $52/share
Current market price               $74/share

Market premium decomposition
AI-sector euphoria                 +17%
Strong recent launch               +11%
Momentum/speculation                +8%
Regulatory concern                  -5%
Execution risk                      -4%
```

Full market mechanics, beliefs and disclosures: [MARKETS.md](./MARKETS.md).

## 8. Ownership and dilution

Three share-class kinds: `common` (one vote), `preferred` (liquidation
preference, protective rights) and `founder_super_voting` (up to 50 votes per
share — how a founder retains control well below 50% economic ownership).

**INVARIANT (`ownership_reconciles`):** for every share class,
`sum(holdings.shares for that class) === totalIssuedByClass[classId]`, checked at
`quarter_commit`. On failure the quarter does not commit.

`VotingPower` reports `economicPct` and `votingPct` separately for every holder,
and they diverge wherever super-voting stock exists. Holder kinds: `player`,
`company`, `character`, `fund` (an institutional bloc that votes as one) and
`public_float` (the anonymous remainder, which votes only partially and
predictably).

### Ownership thresholds

Simplified, fictional thresholds rather than an attempt to reproduce real
securities law. Crossing one upward emits `ownership_threshold_crossed`.

| Threshold | Label | Effect |
|---:|---|---|
| <1% | portfolio investment | No standing |
| 1–4.9% | strategic holding | Undisclosed accumulation is possible |
| 5% | `significant_holder_disclosure` | Position becomes public; media and the target learn who is accumulating |
| 10% | `major_holder` | Standing to demand meetings and put questions to management |
| 15% | `board_pressure` | Can credibly demand a seat; refusal becomes a governance story |
| 25% | `blocking_stake` | Can block supermajority matters, including a sale |
| 50% | `control` | Controls ordinary shareholder votes, subject to super-voting classes |

`Holding.isDisclosed` is false below the 5% line. An undisclosed accumulation is
one of the sharpest weapons in the game, and losing it is usually the moment the
target's CEO notices you.

## 9. Funding rounds

Nine stages (`FUNDING_STAGES`), each demanding different evidence: `seed` is
priced on team and thesis, `series_c` on revenue quality and retention, `growth`
on profitability trajectory. `bridge` is an emergency top-up and signals distress
to the market.

```text
postMoney = preMoney + amount
dilution  = amount / postMoney
pricePerShare = preMoney / preRoundFullyDilutedShares
newShares = amount / pricePerShare
```

Whether a raise clears depends on `world.capitalMarkets.ventureLiquidity`,
`world.capitalMarkets.riskAppetite`, the company's metrics and the market's
belief about its prospects. **Rounds can fail** (`status: 'failed'`), and a
failed raise is itself public information that moves belief.

`raise_round` carries `maxDilutionPct`: the raise fails rather than clearing
above it. `boardSeatsGranted` is a condition of the round, and the lead investor
usually takes one. Founders who ignore cumulative dilution arrive at a public
listing owning nothing — which is a legitimate and instructive way to lose.

An IPO (`ipo`) requires board approval and an open window
(`world.capitalMarkets.ipoWindow`; below 0.3 a listing usually fails or prices
badly). It brings quarterly disclosure, activists and permanent scrutiny.

## 10. Debt

`issue_debt` carries a principal, a `maxRatePct` and a term.

```text
offeredRate = world.macro.policyRate
            + world.macro.creditSpreads
            + riskPremium(leverage, revenue quality, runway, sector)
            - qualityDiscount(reputation.investor, government backlog)

clears iff  offeredRate ≤ maxRatePct
       and  world.capitalMarkets.debtAvailability > threshold(size)
```

Debt is cheaper than equity while rates and spreads are low, and a trap when
they rise. `interestExpense` is settled every quarter in
`financial_resolution`; a rate shock plus a leveraged training programme is the
standard route from "aggressive rival" to "distressed acquisition target".

## 11. Acquisitions

`acquire_company` proposes an offer for a whole company: total value, and a
cash/stock split (`cashPct` + `stockPct`, normalised to 1 by the validator).

Sequence:

1. **Board approval.** `acquisition` is a supermajority matter under
   `DEFAULT_QUORUM_RULE`. Directors negotiate hard over `purchasePriceUsd` and
   `stockComponentPct` — the two fields most conditional commitments reference.
2. **Target consent.** A private target's board and holders decide; a public
   target's holders are offered a premium to the current market price.
3. **Regulatory screen.** High `world.regulation.antitrust` can block a deal
   outright or attach conditions, and a large deal raises the variable further.
4. **Settlement** in `capital_resolution`: cash leaves the acquirer, new shares
   are issued for the stock component (with a lock-up), and holdings transfer.
5. **Consolidation.** The target's `parentCompanyId` is set and `isActive`
   becomes false. Its `techCapabilities` merge into the acquirer at a discount
   for integration friction; headcount transfers with elevated attrition;
   goodwill is recognised as `offerValue - fairValueOfNetAssets`.

Cash and shares must reconcile before commit. An acquisition that would break
either the balance-sheet or the ownership invariant is rejected at validation,
not repaired afterwards.

## 12. The portfolio

Everything a company owns outside itself, read by one projection:
`portfolioOf(session, companyId)` in `@frontier/simulation`. It is pure, it
computes no new economics, and it is what the Portfolio screen renders. There is
no second reading of these figures anywhere in the app.

**The four kinds of row.**

| Kind | What it is | Where it comes from |
|---|---|---|
| Subsidiary | A company bought outright (`absorbed`), or one held past `CONTROL_DECISIVE_PCT` and still filing (`controlled`) | `Company.parentCompanyId` and `Company.acquisition` for the first; the register for the second |
| Stake | A minority position in another company's security | `CapTable.holdings` where `holderId` is this company |
| Short | An open cash-settled exposure | `SessionState.shortPositions` where `entityId` is this company |
| Fund | A partner's position in a `CapitalEntity` | `CapitalEntity.partnerCharacterIds`; a company is nobody's limited partner, so this is a founder row only |

**The valuation basis, stated because it is not obvious.** The engine carries
investments **at cost**: `runSettlement` adds the consideration to
`balanceSheet.assets.investments` on a purchase and removes the pro-rata carrying
value on a sale. So the portfolio reports two different figures side by side and
never conflates them:

- **cost** — the holding's `costBasisUsd`, or the acquisition record's
  `priceUsd`. This is what reconciles to the balance sheet.
- **value** — shares multiplied by the quote when the company is listed, by the
  fundamental anchor's per-share value when it is not. The row says which
  (`priceBasis`).

**Reconciliation.** `portfolio.reconciliation` states
`investmentsLineUsd`, the `stakesCostUsd` attributed to listed rows, and the
`unattributedUsd` remainder. The check is an inequality, not an equality:
attributed cost may never exceed the line, and the remainder is explained rather
than hidden. A remainder is normal and has exactly two causes — a world-2 seed
that opens with an investments balance no cap-table position backs, and an
acquirer that absorbs its target's whole investments line without inheriting a
single holding.

**An absorbed subsidiary is worth zero on this list.** Its cash, plant, staff,
products and revenue moved to the parent in the quarter it was bought, so they
are already inside the parent's own figures. Counting the husk again would
double-count the parent. The row carries what it cost and what goodwill it
created, and says so.

**Durable residue, because the ledger is not state.** `sim_event`s are an
append-only ledger outside `SessionState`, and a save carries none of them. Three
optional, world-2-only fields keep what the portfolio would otherwise have to
invent quarters later:

| Field | On | Written by |
|---|---|---|
| `Company.acquisition` | The company that was bought | `capital_resolution` |
| `Holding.dividendsReceivedUsd` | The position paid | `capital_resolution` |
| `Company.realisedInvestmentGainsUsd` | The seller | `runSettlement` |

Each is `.optional()` and is never written in world version 1, so that frozen
world grows no key and keeps hashing to the value it has always hashed to.

**History.** The carrying line over the last eight filed quarters is derived from
`financialHistory[].balance.investmentsUsd` — the investments half of other
assets, restated on the filed statement rather than stored a second time. World 1
files no statements, so it has no history to show.

**The founder.** `founderPortfolioOf(session, playerId)` does the same for a
person, their own company's shares included. It values every row at
`enterpriseValue / issuedShares`, which is what `founderWealthOf` uses, so
`netWorthUsd` is exactly the figure the founder-wealth leaderboard ranks. It is
deliberately *not* the exchange quote: a net worth that disagreed with the board
it is ranked on would be the second computation this projection exists to remove.

## 13. Balance-sheet and economy invariants

| Invariant | Where enforced |
|---|---|
| `assets - liabilities == equity` (±$1) | `balanceSheetReconciles`, per company, at commit |
| Per class, holdings sum to issued shares | `CapTableCheck`, at commit |
| `issuedShares ≤ authorisedShares` | Action validation and a database `CHECK` |
| `Holding.shares ≥ 0` — no short positions | Schema and database `CHECK` |
| No negative or NaN in-world price | `Quote.price` floored; company marked distressed instead |
| Cash cannot go negative without financing | Action validation (`insufficient_cash`) or forced restructuring |
| Every economic mutation emits a `SimEvent` | `ctx.emit()` in every subsystem |

`QuarterFinancialTotals` aggregates session-wide revenue, cash, debt and the
count of insolvent companies each quarter — a cheap sanity check that the whole
economy has not drifted, and the data behind the economy dashboard.

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

`quarterlyBurn` is the signed net cash movement. Reaching zero cash triggers
emergency financing or restructuring — not instant death, but a `bridge` round
that signals distress, or a `restructuring` board proposal.

`deferredRevenue` (billed, not yet recognised) and `backlogUsd` (contracted, not
yet billed) exist principally for government work: an award creates backlog
before it creates revenue.

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

## 12. Balance-sheet and economy invariants

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

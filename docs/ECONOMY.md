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

## 2. Products, categories and demand

Each `Product` carries a segment (`consumer`, `enterprise`, `developer_api`,
`government` — who buys it), a price per unit per quarter, active customers,
quarterly churn and gross growth, gross margin, compute intensity and a
quality score relative to the market frontier — and, from world version 2, a
`categoryId`: which of the thirty-six industry lines in
`PRODUCT_CATEGORIES` (`packages/contracts/src/productCategories.ts`) it
actually is. A segment says who buys; a category says what is being sold. Two
enterprise products can sell into the same segment and be nothing alike — a
frontier model licensed by the token and an accelerator sold by the unit both
say `enterprise`, and the category is what tells them apart.

### 2.1 World 1 is unchanged

World version 1 has no catalogue. Every `SEGMENT_*` table in
`packages/simulation/src/companies/balance.ts` is exactly what it always was,
`Product.categoryId` is never written onto a world-1 product, and the frozen
world's pinned hash (`world2Scenario.test.ts`) does not move. Everything in
this section from here on is world version 2 only.

### 2.2 The category catalogue

A category (`ProductCategory`) is the industry line's own unit economics:

- **`unitLabel`** — what one unit is: `seat`, `1M tokens`, `unit`, `MWh`,
  `shipment`, `subscription`, `wafer lot`, `accelerator-hour`…
- **`referencePriceUsd`, `elasticity`, `churnBand`, `baseAddRate`, `seedPool`,
  `supportCostShare`, `grossMarginBaselinePct`** — the same shape the old
  `SEGMENT_*` tables had, specialised per line rather than shared across
  everything that sells into one segment. The *fallback* only: the real
  reference price a product is judged against is still the customer-weighted
  mean price of every active product in its **segment**, exactly as before —
  a category's own number is what a brand-new line falls back to before any
  real market exists to read a reference off.
- **`capacityKind`** — `compute`, `plant`, `fleet`, `grid` or `none`. Which
  physical or virtual capacity the line is served from (§2.4).
- **`computeIntensityBaseline`** — only meaningful when `capacityKind` is
  `compute`.
- **`requiresNodeIds`** — Frontier Map node ids the company must have
  achieved, or have public access to, before it may launch into this
  category. Empty for a commodity line (§2.5).
- **`regionAffinityWeight`** — how much a company's regional sector fit
  should weigh on this specific line relative to the sector average.
- **`inputs`** (`{ categoryId, share, required }[]`) and **`canSupply`** —
  the supply graph: what a line is built on, and whether it can be sold as
  someone else's input. `required` edges are acyclic
  (`requiredSupplyGraphIsAcyclic`, asserted by the contract tests). This is
  the graph the supply-chain stage builds real transactions on; nothing in
  this stage moves goods along it yet.

`categoryOf(company, product)` (`packages/simulation/src/companies/
categories.ts`) is the one place the engine resolves a product to its row:
the product's own `categoryId` when it has one, otherwise
`defaultCategoryFor(sector, segment)` — the first catalogue entry in the
company's sector whose `buyerSegment` matches the product's segment, falling
back to that sector's first entry. The derivation is **read-only**: a
category is never written back onto a product that did not carry one, which
is what keeps a promoted or pre-catalogue save byte-identical until it
actually launches something new.

The full catalogue, one row per line (`referencePriceUsd` and `elasticity`
are the catalogue's own numbers; a product's real reference is the segment's
live blend):

| Category | Sector | Unit | Ref. price | Elasticity | Capacity |
|---|---|---|---:|---:|---|
| `ai_software` | ai | seat | $38 | 0.7 | compute |
| `ai_frontier_models` | ai | 1M tokens | $1,800 | 0.9 | compute |
| `ai_agents` | ai | seat | $5,200 | 0.7 | compute |
| `ai_inference_api` | ai | 1M tokens | $900 | 1.4 | compute |
| `ai_data_labelling` | ai | dataset | $1,100 | 1.0 | none |
| `ai_safety_evals` | ai | audit | $4,200 | 0.5 | none |
| `ai_cloud_infrastructure` | ai | accelerator-hour | $5,800 | 0.5 | compute |
| `ai_developer_tools` | ai | seat | $480 | 1.3 | none |
| `ai_model_hosting` | ai | 1M tokens | $1,400 | 1.1 | compute |
| `robotics_industrial_arms` | robotics | unit | $42,000 | 0.6 | plant |
| `robotics_warehouse` | robotics | unit | $9,400 | 0.65 | fleet |
| `robotics_humanoids` | robotics | unit | $68,000 | 0.4 | plant |
| `robotics_drones` | robotics | unit | $68,000 | 0.3 | plant |
| `robotics_software` | robotics | seat | $1,800 | 1.0 | none |
| `manufacturing_accelerators` | manufacturing | unit | $240,000 | 0.5 | plant |
| `manufacturing_fabs_packaging` | manufacturing | wafer lot | $320,000 | 0.4 | plant |
| `manufacturing_sensors` | manufacturing | unit | $34,000 | 0.7 | plant |
| `manufacturing_batteries` | manufacturing | unit | $18,000 | 0.8 | plant |
| `manufacturing_machine_tools` | manufacturing | unit | $96,000 | 0.5 | plant |
| `manufacturing_contract_mfg` | manufacturing | shipment | $52,000 | 0.7 | plant |
| `energy_generation` | energy | MWh | $26,000 | 0.4 | grid |
| `energy_grid_storage` | energy | MW connected | $320,000 | 0.35 | grid |
| `energy_datacentre_power` | energy | MW contracted | $42,000 | 0.45 | grid |
| `energy_fuel_hydrogen` | energy | tonne | $22,000 | 0.6 | plant |
| `energy_transmission` | energy | connection | $12,000 | 0.3 | grid |
| `logistics_freight` | logistics | shipment | $46,000 | 0.9 | fleet |
| `logistics_last_mile` | logistics | shipment | $42 | 1.3 | fleet |
| `logistics_ports_fleets` | logistics | vessel-call | $74,000 | 0.6 | fleet |
| `logistics_supply_chain_software` | logistics | seat | $1,600 | 1.0 | none |
| `logistics_cold_chain` | logistics | shipment | $21,000 | 0.8 | fleet |
| `consumer_apps` | consumer | subscription | $14 | 1.7 | none |
| `consumer_devices` | consumer | unit | $320 | 1.3 | plant |
| `consumer_media` | consumer | subscription | $22 | 1.5 | none |
| `consumer_marketplaces` | consumer | subscription | $36 | 1.4 | none |
| `consumer_subscriptions` | consumer | subscription | $20 | 1.5 | none |
| `consumer_retail_commerce` | consumer | unit | $9 | 1.8 | fleet |

### 2.3 Demand resolution, per product, in `product_demand_resolution`

```text
category      = categoryOf(company, product)          // world 2 only; null in world 1
reference     = segmentReferencePrice(segment, category.referencePriceUsd)
base demand   = segmentDemand(sector.demand, world.society.*, world.macro.consumerDemand)
quality edge  = qualityScore - marketFrontierQuality(segment)
price effect  = category.elasticity × (price / reference - 1)
reputation    = reputation.<audience for segment> / 100
capacity cap  = capacityFor(category.capacityKind) / requiredPerUnit(category)

grossAdds     = (customers + category.seedPool) × category.baseAddRate
                × (1 + quality edge) × (1 - price effect) × reputation
                × marketing lift × company.demandMultiplier
customers_t+1 = min(capacity cap, customers_t × (1 - churn(category.churnBand)) + grossAdds)
revenue       = customers_t+1 × pricePerSeat
```

World 1 (and any world-2 product whose category never resolves — never
happens, but the fallback is there) runs the identical arithmetic with the
old flat `SEGMENT_*` constants instead of `category.*`, byte for byte.

Two properties matter, unchanged from before this catalogue existed.
**Capacity is a hard cap**: a company that sells more than it can serve does
not book the revenue, it books churn instead. And **churn is shaped by the
line it is**: a humanoid line runs a tight 1–5% band; a last-mile shipment
line runs double digits.

Elasticity by segment (the world-1 tables, and every category's own
fallback before a category overrides it):

| Segment | Price elasticity | Typical churn | Reputation audience |
|---|---:|---:|---|
| `consumer` | 1.6 | 0.12–0.22 | `public` |
| `enterprise` | 0.7 | 0.03–0.08 | `enterprise` |
| `developer_api` | 1.2 | 0.06–0.14 | `developer` |
| `government` | 0.4 | 0.01–0.03 | `government` |

### 2.4 Capacity kinds

`capacityKind: 'compute' | 'plant' | 'fleet' | 'grid' | 'none'` says what a
line is rationed against:

- **`compute`** — accelerator-equivalents, exactly the mechanism §4 always
  described. Unchanged.
- **`plant` / `fleet` / `grid`** — cash invested via `invest_capacity`
  (§4.2's companion action; same shape, same two-phase staging contract as
  `buy_accelerators`), held on `Company.capacity` as
  `{ plantUsd, fleetUsd, gridUsd }`. A category's `capacityYieldPerUnit` is
  how many customers a **million dollars** of that capacity kind serves —
  the same role `SERVE_CUSTOMERS_PER_ACCELERATOR` plays for compute, in
  dollar terms instead of accelerator terms. `invest_capacity`'s cash lands
  in `balanceSheet.assets.ppe` (capex, exactly like an owned accelerator)
  and in the matching bucket, and both depreciate at the same
  `PPE_DEPRECIATION_PER_QUARTER` rate.
- **`none`** — never capacity-constrained. A marketplace or a subscription
  app grows on demand alone.

Rationing runs **one bucket per capacity kind a company's products actually
touch**, not one company-wide pool: a manufacturer selling both accelerators
(`plant`) and a robot-software seat (`none`) never has one line's shortage
bleed into the other's growth. World 1, and any world-2 company whose
products are all `compute`-kind, reduces to exactly the single-bucket
arithmetic the phase always ran.

In **world 3** a bucket is shared between the company's lines on it by
`bucketShare` (`graph/market.ts`): a quarter of the bucket
(`CAPACITY_FOOTHOLD_SHARE`) is split equally among every line drawing on it,
and the rest follows what each line drew last quarter (equally when none of
them drew). A line alone on its bucket holds all of it; a line the quarter it
launches opens on its foothold and grows into more as it sells; two lines
that both want everything converge on an even split. The foothold exists
because a share taken purely from last quarter's draw gave a freshly launched
line exactly nothing, forever. The launch flow quotes the same formula
(`launchCapacityPreview`) on its cost step before the founder commits.

A company that has **never recorded a `plant`/`fleet`/`grid` position** —
never invested, and not seeded with one — reads as unconstrained rather than
rationed to nothing: `company.capacity === undefined` is "not tracked yet",
never "tracked at zero". This is what lets a promoted or freshly-launched
company grow before it has to think about capacity at all, exactly the same
"absent means the neutral value" rule every other optional field in this
priced-economy block already reads by. The twenty-four world-2 seed
companies whose category needs `plant`/`fleet`/`grid` are seeded with a real
opening position sized to their starting customer base plus headroom
(`startingCapacityFor` in `scenario/world2/seeds.ts`), mirroring how
`seed.compute` already gave every company a real opening compute position
rather than starting every accelerator count at zero.

### 2.5 Tech-gated categories

A category's `requiresNodeIds` is a **launch gate**, not a demand input:
checked once, at `launch_product`, against `dependencySatisfied` — the same
node-ownership rule research already uses (the node is publicly `achieved`,
or this company privately holds a `succeeded` project against it). Missing
even one required node **refuses** the launch outright
(`requirement_not_met`) rather than clamping it smaller: this is structural,
per `docs/SIMULATION.md` §11's KEEP-vs-REALISE table, not a matter of money
or scale.
Empty `requiresNodeIds` means commodity — capital and demand are the only
gate. A `launch_product` naming `categoryId: null` resolves to
`defaultCategoryFor(sector, segment)` and clamps back the chosen category on
the action, the same way a null `providerCompanyId` resolves to the cheapest
seller with capacity. A `TechNode` may carry `unlocksCategoryIds`, so the
research screen can say "unlocks: Humanoids" beside a programme.

### 2.6 The supply chain

The owner's second north star: *"if any company publishes a public API for
its LLM, any other company with a harness can decide if they want to put a
product on the other company's LLM."* §2.2 already declared the graph —
every category's `inputs` (upstream lines it is built on, each with a
`share` and a `required` flag) and `canSupply` (whether it can be somebody
else's input). This section is what turns that declared graph into real
transactions between two named companies, priced by the seller.

**The two actions.** `set_supply_terms { productId, terms }` publishes,
reprices or closes a `canSupply` product line as an input — `terms.openToAll:
true` is a public API; `false` with `exclusiveCustomerIds` is a private
deal. `choose_supplier { productId, inputCategoryId, supplierCompanyId,
supplierProductId }` is the buyer's half: build on a named company's
product, or name `null` for the open market (or, on a `required` input, a
deliberate refusal to fill it). Both are structural-refusal-only per
`docs/SIMULATION.md` §11: an unknown product, company or category, a
supplier that is closed to this buyer, or a product naming itself as its own
supplier are refused; everything else — a price far from reference, a
required input left genuinely unfilled — realises.

**Resolving one input.** `resolveSupplyLine(draft, buyer, product, input)`
in `@frontier/simulation`'s `companies/supply.ts` answers one of three
statuses, and additivity is the rule that governs all three:

- **`open_market`** — no entry in `Product.supply` for this input at all
  (every product launched before this stage, and every input a founder has
  never touched), *or* an explicit `null` supplier on an input that is not
  `required`. Costs nothing beyond what the category's own
  `grossMarginBaselinePct` already assumes, and moves no counterparty's
  revenue — every product's margin was tuned against that baseline before
  this module existed, so "the market" is the model's existing cost, not a
  new one stacked on top of it.
- **`unsupplied`** — a `required` input whose chosen supplier is an
  explicit `null`, or whose named company/product no longer exists, no
  longer matches the category, or no longer admits this buyer. The product
  **ships zero units** this quarter (`requiredInputUnsupplied` forces
  `desiredCustomers` to zero in `product_demand_resolution`), with its own
  report line — a founder who launched ahead of a supplier, or who was cut
  off and never switched, pays for it in lost revenue, not in a refusal.
- **`supplied`** — a live, named, category-matched, currently-admitting
  supplier. This is the only status that moves real quality or real money.

**Quality.** `effectiveQuality(draft, company, product, switchedThisQuarter)`
blends a product's own `qualityScore` with each `supplied` input's supplier
product quality by that input's `share`:
`quality = own + Σ share × (supplierQuality − own)` over every `supplied`
line. An agents line built on a weak model reads close to the weak model; on
the frontier it reads close to the frontier. `open_market` and `unsupplied`
lines contribute nothing — there is no real product to blend in. A line
`choose_supplier` moved *this* quarter has its pull dampened to
`SWITCH_QUALITY_FACTOR` (0.7) for the one quarter the switch lands in — the
"switching costs one quarter of degraded quality, stated" the owner asked
for — and is undamped every quarter after.

**Cost and revenue.** `resolveSupplyLedger(draft)` is the one function both
sides read, so a buyer's spend and a seller's revenue can never disagree.
For every `supplied` line it prices `unitsRequested = (revenue × share) ÷
supplierCategory.referencePriceUsd` — a normalised quantity, independent of
what the seller actually charges — then rations every buyer of one supplying
product **proportionally** against that supplier's own spare capacity (§2.4):
`fillRatio = min(1, spareUnits ÷ Σ unitsRequested)`, exactly the rule
`sellableCapacityUnits` already applies to compute. `costUsd = unitsFilled ×
price`, where `price` is the supplier's own `supplyTerms.pricePerUnitUsd`,
bounded to `SUPPLY_PRICE_FACTOR_BOUNDS` (0.25×–4×) of its category's
reference — real leverage in both directions without one mis-keyed price
collapsing or exploding a buyer's cost base. `financial_resolution` adds
this into the same `interCompanyRevenue`/`interCompanyCogs` figure
compute's counterparty charges already use (§4.1): the buyer's COGS rises by
exactly what the seller's revenue rises by, recognised at the **seller's
own realised margin** (`counterpartyMarginOf`), and a supplier at full
capacity degrades every buyer's fill proportionally and says so
(`supply_capacity_short`).

**Leverage.** A supplier's price change hits every buyer's margin the
moment it is set — priced by the seller, felt by every customer on the
line, which is the weapon the owner's north star describes.
`blockedCustomerIds`, a narrowed `exclusiveCustomerIds`, or closing
`openToAll` does **not** cut an existing buyer immediately: the affected
line's `cutOffNoticeQuarter` is set to next quarter, the buyer stays
`supplied` (and is told, `supply_terms_changed`) for one more quarter to
react, and only then drops to `unsupplied` (`supply_cut_off`) — the same
notice-then-effect shape `reserve_compute`'s expiry already uses.

**Dependence.** `dependenceOn(draft, company, supplierCompanyId)` is
derived, never stored: the share of a company's revenue riding on one named
supplier, recomputed on every read (`Σ supplied-line revenue ÷ total
revenue`) so the dossier and the feed always read the live position — "62%
of your revenue runs on Aletheia's API."

**NPC policy.** A `significant` or `background` company's archetype default
(`companies/npc.ts`) publishes open terms the first quarter a `canSupply`
line exists (`defaultSupplyTerms`: `openToAll: true` at `1.1×` its
category's reference), and chooses a supplier for every input by
`chooseSupplierDefault`: best quality-per-dollar among `suppliersFor`'s
open offers, never a direct rival in the same category unless nothing else
is on offer, sticky unless the best available option is materially
better (>15% higher quality-per-dollar) than the one already chosen. A
major company's LLM strategist reaches the same two actions through the
ordinary action union.

**Events.** `supply_started`, `supply_switched`, `supply_terms_changed` and
`supply_cut_off` are `kind`s on the existing `cost_recognised` vocabulary
(company-visibility for an ordinary choice, public when a line is first
published or reworked — the market should see a public API appear);
`supply_capacity_short` is emitted at settlement, in `financial_resolution`,
alongside the ordinary partial-fill row a rationed buyer gets.

World version 1 has no product categories, so every function here is a
no-op or an empty result for it, `Product.supply`/`supplyTerms` are absent
on a world-1 product, and the frozen world's hash does not move.

### 2.7 World 3: the chain is the product — slots, roles, target markets, publishing

World version 3 retires the category catalogue for one **node table**
(`ECONOMIC_NODES` in `@frontier/contracts`, ninety-odd nodes across eight
tiers from what comes out of the ground to a tier-7 *operation* such as line
haul). A line produces a node; what it is made of is no longer a fixed list
of input ids but a set of **slots**, and what a founder puts in those slots,
buys them from and aims the line at is the product. The owner's three
sentences are the specification: *"One product launch, for example a
consumer app. I can't choose what model, what harness, to which sector."*
*"LLM node connects to software node, then software node to computer node."*
*"If any company publishes a public API for its LLM, any other company with a
harness can decide if they want to put a product on the other company's
LLM."* Sector means both the industry sold into and the customer type; the
harness is a layer the player chooses; and this applies to every sector.

**Roles and slots.** A **role** (`NODE_ROLES`, `packages/contracts/src/nodeRoles.ts`)
is "things a buyer could put in the same slot": `model` holds the frontier,
small and robot-policy models; `harness` the agent harness and the copilot
framework; `battery_pack` the NMC and LFP packs; `generation_asset` solar,
wind and the SMR; and so on. Every node carries `slots: NodeSlot[]` (at most
six), each `{ id, role, label, qtyPerUnit, required, blocking, accepts,
defaultNodeId, kind }`: `accepts: []` admits every node of the role, a
narrower list narrows it; `required: false` may be left empty; `blocking`
means the line ships nothing while nobody in the world can make any
admissible node (the old `substitutable: false`, one to one); `kind:
'delivery'` is what the node ships *on* — a device under an app — and is
drawn on the output side of the card. `economicGraphDefects` holds the table
to it: every `accepts` id exists and carries the slot's role, defaults are
admissible, `blocking ⇒ required`, every node of a slot's role sits strictly
below its owner's tier, all admissible nodes of a slot share a `unitLabel`,
`requires` is acyclic and the graph is connected through every admissible
node. `admissibleNodesFor`, `slotById` and `slotsAccepting(nodeId)` are the
readers. A node sells into a **market** rather than to one buyer segment:
`market: { customers: Record<Segment, weight>, industries: Record<Sector,
weight> }`.

**Composition lives on the product.** `Product.slots: ProductSlotFill[]` —
`{ slotId, nodeId | null, supplierCompanyId | null, supplierProductId | null,
cutOffNoticeQuarter | null, changedQuarter | null }` — and
`Product.targetIndustry: Sector`; the customer type is the existing
`Product.segment`. Both are optional on the schema so a world-1 or world-2
save reads unchanged. `resolveFill` in `graph/slots.ts` is the one place a
fill becomes a route, and every reader — the roll-up, the market's derived
demand, the production and data passes, the launch preview, the canvas, the
Chief of Staff — goes through it: the fill (or the launch preview's
override), then the node (the fill's, else the slot's default; a node the
slot does not admit falls back to the default rather than being trusted),
then `make` when the company runs a line on it and the fill names itself or
nobody, `buy` when the fill names another company whose line is live,
published and open to this buyer with no cut-off notice in force, otherwise
`market`, and `blocked` only on a `blocking` slot whose resolved node nobody
in the world owns or licences. A fill naming a rival while the company runs
its own line is honoured as a buy: **declining MAKE is allowed**, and the
fill is what says so.

**Cost.** `unitCostOf(state, company, nodeId, cache?, override?)` iterates
the node's slots and prices each resolved fill through the same ladder §2.6
used: a `make` route at the company's own roll-up for that node (recursively,
to `MAX_COST_DEPTH`), a `buy` route at the seller's published ask as
`namedSupplierPriceUsd` charges it — held inside `SUPPLIER_ASK_BOUNDS`
(0.5×–2.5×) of the node's market price so neither a gift nor a hostage price
escapes the market's gravity — and a `market` route at the node's market
price times `OPEN_MARKET_PREMIUM` (1.08). A row is keyed `slot:${slotId}` and
carries `slotId` and `nodeId`, so the breakdown stays stable when a founder
swaps the node in a slot. The `override.fills` argument serves the launch
preview and is never memoised: what the Inputs step shows is what the profit
and loss will book. `world3Repair.test.ts` holds that identity to the cent.

**Quality, and the switch cost.** `effectiveQuality` is recomputed every
quarter from three terms: the line's craft through the one quality-tier
lever, the company's data edge in the node's sector, and what its inputs
deliver — every `buy` **and** every `make` route, weighted by its share of
the input value of one unit, so a better model behind your own API raises
the API, and a die that is nine tenths of a package's cost carries nine
tenths of its supplier's quality. The open market and an empty slot
contribute nothing. A fill whose `changedQuarter` is this quarter contributes
at `SWITCH_QUALITY_FACTOR` (0.7): the one quarter of degraded quality a
switch costs. There is no cross-phase set remembering who switched; replay
reads it off the fill.

**Target markets.** Demand for a node is a grid of cells, the industry sold
into by the customer type inside it:

```text
w(n,i,c)          = market.industries[i] × market.customers[c]
cellDemand(n,i,c) = endDemandBaseUnits × w × appetite(c) × sectorDemandCycle(i) × sizeFactor(i,c)
sizeFactor(i,c)   = c ∈ {enterprise, developer_api} ? clamp(sectorRevenue[i] / industryBaselineUsd[i], 0.5, 2) : 1
```

A line is aimed at exactly one cell — `targetOf(product, node)` and
`product.segment` — and draws its orders from that cell's pool. **B2B buyers
are the industry**: the demand a logistics company's slot fills create for an
inference API lands in the cell (API, logistics, enterprise), so "AI software
aimed at logistics enterprises" grows with the logistics sector, and
`industryBaselineUsd` is written once at seed so the size factor reads
neutral on the day the world opens (and on any save without it). Selling to
the public has no industry: a consumer line collapses to the single cell
(n, consumer, consumer). A line aimed at a cell its node's market gives no
weight draws nothing and is told so in an advisory, never refused.

**The actions.** `launch_product` gains `targetIndustry` and `slots[]` (a
slot the node does not carry is dropped with a clamp; a required slot
emptied is refused; a named source that cannot supply is clamped to the open
market and said so). `fill_slot { productId, slotId, nodeId, supplierCompanyId,
supplierProductId }` changes the node in a slot, its source, or both, and
stamps `changedQuarter` only when something actually moved — a re-stated fill
writes nothing and restarts no switch cost. `set_target_market { productId,
targetIndustry, segment }` aims a line. `choose_supplier` is refused in
world 3 with "use fill_slot". One line per node per company: a second launch
on a node you already sell is refused with "change its slots instead". The
ledger records `slot_filled` and `target_market_set`.

**Publishing.** Anything you produce you may publish: `set_supply_terms` on a
node line takes a node branch and ignores the world-2 `canSupply` flag.
`openToAll: true` is a public API in the owner's sense; a narrowed
`exclusiveCustomerIds`, a `blockedCustomerIds` entry or closing the line sets
the affected buyer's `cutOffNoticeQuarter` so it stays supplied one quarter
and then falls to the open market, the notice-then-effect shape §2.6 already
used. A company nobody directs publishes every node line open at its list
price the quarter it has none and reprices when the list has moved more than
`NPC_SUPPLY_REPRICE_THRESHOLD` (5%) from what it published.

**Rivals compose too.** `companies/npcSlots.ts` fills every slot of every
undirected line by **quality per dollar**: each admissible node from each
source — the company's own line at its roll-up cost and its own quality,
each published seller at the ask the roll-up would charge and that line's
quality, the open market at the premium and `MARKET_QUALITY` (0.5) — with
ties broken by own line, then lower company id, then table order, so two runs
of one state compose identically. It is sticky at `NPC_SLOT_SWITCH_THRESHOLD`
(1.15), and a fill the company moved fewer than `NPC_SLOT_SETTLE_QUARTERS`
(4) quarters ago is not judged again: the switch cost itself depresses a
seller's stamped quality for the quarter it switched in, and a buyer reading
that dip as a signal moved off the seller and back again two quarters running
before the settle window existed. A direct rival — a company selling the node
this company publishes — is excluded unless nothing else is on offer, and a
fill standing on one is not sticky once something else is. A slot left empty
is left alone. No RNG anywhere in it.

**The seeded world.** `scenario/world3/lines.ts` composes every rival on
purpose — Sable's inference API on Sable's own small model, Basalt's on
Aletheia's frontier model, Aletheia's software suite on Basalt's API,
Ironvale's warehouse robot on Cinder's LFP pack and Wrenford's policy model,
Overland's routing platform on Sable's API, Copa's marketplace on Basalt's —
and `BACKGROUND_OPENING_LINE` gives each of the fifteen backgrounds a
composed opening line (enterprise AI: a suite on Basalt's API with an agent
harness from the open market, aimed at logistics enterprises). Published seed
lines open with terms at list price. Rivals then recompose by their own
policy from quarter one, which is the point: the seed is a starting position,
not a promise.

**What the founder sees.** The launch flow is *What to sell → Inputs → Target
→ Cost to make → Price*; tapping a slot opens the candidate sheet
(`SlotCandidateSheet`) with every admissible node — market price, best route
price, quality, producer count — and under the picked node every route,
make yourself, each named seller, open market, all tappable and none
disabled. The line drawer carries the same rows, the target, the cost by
slot and "Sell this to other companies". The canvas draws slot ports under
each of the founder's cards, the filled node with its supplier beneath, the
delivery device one column right, and the target under the card. The Chief
of Staff describes a line with `describeLine` — *"your AI software suite on
Basalt Compute's inference API with an agent harness from the open market,
aimed at logistics enterprises"* — answers `unit_cost` by slot and
`slot_candidates` with a `fill_slot` on every row, and its `suppliers` lookup
in world 3 answers with the slot's candidates.

Worlds 1 and 2 are untouched: nothing on their paths imports the node table,
every new `Product` and `SessionState` field is optional, and both frozen
hashes hold.

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

### 4.2b Owning plant, fleet or grid capacity: `invest_capacity`

`invest_capacity { kind, amountUsd }` (`kind` one of `plant`, `fleet`, `grid`)
is `buy_accelerators`' companion for every capacity kind that is not compute
(§2.4). Same shape, same two-phase contract:

- **Validator.** Refused in world 1. Refused for a non-positive amount. Cash
  is *noted*, never clamped, exactly like every other world-2 capital
  commitment.
- **Resolution, phase 10** (`resolveCapacityOrders`, called alongside
  `resolveComputeOrders`). Stages the investment on
  `company.capacity.pendingInvestments`; a sim event `capacity_invested
  {companyId, kind, amountUsd}`.
- **Cash, phase 11.** The financial phase settles the pending investment:
  cash down, `balanceSheet.assets.ppe` up by the same figure (folded into the
  same `capex` an accelerator purchase uses), and the matching
  `company.capacity.{plant,fleet,grid}Usd` bucket depreciates at the opening
  balance's own rate and then receives the quarter's investment, the same
  "decay then add" `ppe` itself does.

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

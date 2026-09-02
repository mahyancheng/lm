# Capital Entities — venture, buyout and hedge funds as real actors

**Audience:** the game owner (read on a phone) and the agents who will implement
from it.
**Status:** design study and work order. Nothing here is implemented.
**Written against:** the engine as of world version 2 with Wave 3 (`docs/economy-study.md`
§4 P0 and §6 V1–V8) in flight — `packages/contracts/src`, `packages/simulation/src`,
`apps/web/src`, all read directly.

> **The directive this answers, verbatim in intent:** *"Include VC, PE and hedge
> funds in the game. Not only for the player but also outcomes. All companies and
> entities inside are also part of the game just like Plutocracy. They are not
> functions you trigger when you need something. They are real actual entities."*

---

## 0. Provenance and how to read this

Sections 1, 3.1 and every claim about our own code were read directly out of the
repository and carry a file and, where useful, a line reference. Those claims are
not caveated.

Claims about market practice carry an inline source link. The research pass could
fetch search-engine syntheses of those pages rather than the pages themselves, so
— exactly as `docs/economy-study.md` §0 says of its own material — **the URLs are
correct and the claims are attributable to them; the wording is close-paraphrase
rather than verified verbatim quotation.** Two honesty markers are used:

- **(inferred)** — my reading or my adaptation, not the source's words.
- **(practice)** — how the real business works, stated because it is the reason a
  rule has the shape it has, not because the number is transferable.

Plutocracy claims are re-cited from `docs/economy-study.md` §1, which carries its
own method caveat.

**Numbers.** Every constant proposed here is a whole number or a whole
percentage, bounded on both sides, and computed with no `Math.random()`. Where a
real-world figure is quoted, the figure we adopt is stated separately and the
mapping between them is shown, because a real 5.5× EBITDA multiple means nothing
in an engine with no EBITDA line.

---

## 1. What exists today, verified

The honest baseline. Funds are already *named* and already *on the register* —
they are just furniture.

### 1.1 A fund is a string on a cap table

`HOLDER_KINDS` (`contracts/ownership.ts:77`) is
`['player','company','character','fund','public_float']`, and the description of
`'fund'` already says the right thing: *"an institutional bloc that votes as
one."* But a `Holding` is the whole of a fund's existence. There is no `Fund`
type, no cash, no thesis, no partner, no behaviour, and nothing anywhere in
`packages/simulation` that reads a fund id for any purpose except splitting
shares and taking a block premium.

World 2 seeds six blocs, one per region
(`scenario/world2/seeds.ts:378`):

```
seawall · tessera · kaido · indus · qadr · altiplano
```

`FUND_FOR_REGION` gives every company its local bloc, and North America's
companies get Tessera as the crossover while everyone else gets Seawall
(`seeds.ts:386`). Every register is built the same way
(`buildV2CapTable`, `seeds.ts:405`):

| | CEO | local fund | crossover fund | float |
|---|---|---|---|---|
| listed | 5% | 11% | 7% | 77% |
| private | 62% | 24% | 14% | — |

So **every one of the twenty-four rivals already has two institutional
shareholders**, and eighteen per cent of every listed company is already fund
money. The blocs are not a new fiction to introduce; they are an existing fact to
switch on.

### 1.2 Each bloc already has a partner, with goals, memory and a board seat

`W2_FUND_PRINCIPALS` (`scenario/world2/people.ts:46`) maps each fund to a
character, and all six are seeded as full `Character` rows with traits, beliefs,
wealth, board counts and a connection level (`people.ts:404–497`):

| Fund | Partner | Connection | Personal wealth | Boards |
|---|---|---|---|---|
| Seawall Capital | Helena Ward | 91 | $840m | 7 |
| Tessera Industrial | Stefan Koll | 78 | $290m | 5 |
| Kaido Partners | Mei-Lan Ho | 84 | $410m | 6 |
| Indus Growth | Asha Rege | 72 | $96m | 4 |
| Qadr Sovereign Fund | Tariq Al-Muhairi | 94 | $0 | 3 |
| Altiplano Capital | Ricardo Salas | 66 | $74m | 3 |

They already sit on rival boards as `Director` rows whose `representedHolderId`
is the fund id (`people.ts:718`, `733`, `747`, `761`), so a fund's vote is already
counted by `tallyProposal`. They already have relationships, memories and beliefs
because they are ordinary characters. **Nothing about the person layer needs to
be invented.**

And the best fact in this document: **the player's own opening round is already
led by Helena Ward.** `scenario/world2/index.ts:182` seeds
`rnd_player_ventures_seed` with `leadInvestorCharacterId: W2_CHARACTERS.helena`,
`participantHolderIds: ['fund_seawall']` and `boardSeatsGranted: 1`. From quarter
zero the player has a venture fund on their cap table and its partner in their
boardroom. Everything in §3.2 lands on a relationship the scenario already
established; there is no onboarding to write.

### 1.3 Wave 3 has already built the takeover engine, by accident

Three things landed for other reasons and together are a hostile-takeover system
nobody has pointed at a fund yet:

- **Control flips at 50% + 1.** `boards/tally.ts:362` walks every non-float
  holder in id order and returns the first that satisfies `grantsControl`; that
  holder is decisive on every proposal kind except `ceo_dismissal`
  (`CONTROL_EXEMPT_PROPOSAL_KINDS`). The walk does not care that the holder is a
  fund. A fund at 50% + 1 **already** carries an acquisition vote.
- **Accumulation is convex, and blocks cost double.** `markets/settlement.ts:195`
  prices the float tranche at `stakeExecutionPriceUsd` — buying the whole float
  costs twice the quote — and `settlement.ts:205` lets a buyer take shares out of
  a **named `holderKind === 'fund'` block at a flat `BLOCK_PREMIUM` of 2×**. The
  code that makes the last tranche expensive is written and the counterparty it
  reaches for is, literally, a fund.
- **Dividends, tolls, accords and antitrust exposure exist.** `resolveDividends`
  (`resolver/capital.ts:395`), `logisticsTollPct`, `price_accord` on
  `DEAL_OBLIGATION_KINDS`, and a 0–100 `antitrustExposure` on every company.
  A dividend recap and a roll-up have somewhere to land.

### 1.4 What is missing

- No entity: no AUM, no dry powder, no vintage, no thesis, no track record.
- **No shorts.** `HoldingSchema.shares` says *"Never negative: short positions are
  not modelled"* (`ownership.ts:92`), and that sentence is load-bearing —
  `checkOwnershipIntegrity` sums that array against `totalIssuedByClass`.
- No fund agency. `resolveFundingRounds` invents a throwaway holder per round —
  `makeId('fund','venture',company.id)` (`resolver/capital.ts:588`) — with
  `leadInvestorCharacterId: null` (`capital.ts:617`). Every round in the game is
  led by nobody, on behalf of a fund that exists for one company and never acts
  again.
- Rounds are only ever *requested*. `raise_round` is a player/NPC action; nothing
  in the engine ever offers money to anyone.
- Nothing is ever bought hostile, shorted, squeezed or agitated at.

---

## 2. The entity model

### 2.1 The name, and the identity rule

**`CapitalEntity`**, in a new `packages/contracts/src/capital.ts`.

Not `Fund`: `Holding.holderKind === 'fund'` already means *a position held by a
bloc*, and a type called `Fund` sitting next to it makes every future reader ask
which one they have. Not `Investor`: `CharacterRole` already has `'investor'`,
and that is the *person*, not the institution. `CapitalEntity` is unambiguous and
it reads correctly for a sovereign fund, which is neither a fund manager nor an
investor in the venture sense.

**The identity rule, and it is the most important sentence in this document:**

> `CapitalEntity.id` **is** the holder id already on the cap tables:
> `fund_seawall`, `fund_tessera`, and so on. An entity is not a new owner; it is
> the thing that was always at the other end of those holdings.

Consequences worth stating out loud, because they are what make this cheap:

- Every long position a fund has, has, or will ever have is an ordinary `Holding`
  with `holderKind: 'fund'`. **No second ownership ledger.** The cap-table
  invariant is untouched.
- Every fund vote is already counted by `tallyProposal`.
- Every fund block is already reachable by a raider at `BLOCK_PREMIUM`.
- `deployedUsd` is **derived** — the sum of `costBasisUsd` over live holdings
  whose `holderId` is the entity id — and is never stored, because a stored copy
  drifts the first time `takeFromFloat` rebases a cost basis.

### 2.2 The schema

```ts
CAPITAL_ENTITY_KINDS = ['vc', 'pe', 'hedge_fund', 'sovereign'] as const;

CapitalEntitySchema = z.object({
  id, name, kind,                       // id === the cap-table holder id
  region: RegionSchema,
  sectorAffinity: Record<Sector, 0..100>,   // whole numbers, six keys
  stageBand: [FundingStage, FundingStage],  // VC only; ['growth','growth'] elsewhere
  thesis: string(max 160),              // one line, shown on The Street

  committedCapitalUsd,                  // AUM. Fixed for the life of a vintage.
  dryPowderUsd,                         // the only stored cash figure
  realisedProceedsUsd,                  // cumulative cash back from exits
  feesPaidUsd, borrowFeesPaidUsd, carryPaidUsd,   // cumulative, for the audit

  vintageQuarter, termQuarters, investmentPeriodQuarters,
  exitHorizonQuarters,                  // per-holding target hold length

  riskAppetite: 0..100,
  trackRecord: 0..100,                  // reputation; moves on realised outcomes
  partnerCharacterIds: string[1..3],    // ordinary Characters, role 'investor'
  isActive: boolean,
});
```

Everything else a player sees is **derived per quarter** into the economy report
(§5.1), never stored: NAV, DPI, LP pressure, stance toward the player, portfolio,
short book. This mirrors `companyMetrics` and `EconomyReport`, which are rebuilt
every quarter and never accumulated — the reason `docs/economy-study.md` gives
for that is that a long session has to stay survivable on a phone, and it applies
here identically.

### 2.3 Lifecycle, and why LP pressure is the best mechanic in this section

A venture fund runs a ten-year term with a three-to-five-year investment period,
after which it harvests; and from roughly year six onward LPs judge it on **DPI**
— cash actually distributed — because paper marks are not money
([VC Lab benchmarks](https://govclab.com/2026/08/17/venture-capital-fund-benchmarks),
[Carta on the J-curve](https://carta.com/learn/private-funds/management/fund-performance/j-curve/)).

We adopt the shape and one whole number:

```
FUND_TERM_QUARTERS            = 40      // ten years
INVESTMENT_PERIOD_QUARTERS    = 20      // five years
MANAGEMENT_FEE_PCT_PER_QUARTER = 0.5    // 2%/yr on committed capital, from dry powder
CARRY_PCT                     = 20      // on realised gains above cost

age  = quarter − vintageQuarter
dpi  = clamp(realisedProceedsUsd / max(1, committedCapitalUsd), 0, 2)
lpPressure = clamp(round(100 × age / FUND_TERM_QUARTERS − 100 × dpi), 0, 100)
```

Zero at vintage, 50 at the end of the investment period with nothing returned,
100 at term — and every 0.1 of DPI knocks ten points off it. One number the
player can hold in their head, and it is the thing that makes a fund behave like
a fund rather than like a wallet:

| LP pressure | What changes | Why it matters to the player |
|---|---|---|
| 0–39 | nothing | a patient backer |
| 40–59 | `exitHorizonQuarters − 4`; target multiple falls 3 → 2 | your investor starts asking about the exit |
| 60–84 | no new term sheets; sells `EXIT_TRANCHE_PCT` every quarter | your cap table is being sold down whatever the price |
| 85–100 | forced seller: sells the tranche regardless of the limit price | **blocks come loose and cheap — the best buying window in the game** |

That last row is the whole point of modelling a fund's clock: an old fund is a
seller who does not care what you pay, which is a buying opportunity the player
can *see coming four quarters out* on The Street screen. Nothing random creates
it; a date does.

The fee is not decoration either. `MANAGEMENT_FEE_PCT_PER_QUARTER` on committed
capital is what puts every fund under water for its first years — the J-curve —
so a young fund is hungry and an old one is desperate, which is exactly the
asymmetry that makes negotiating with two different funds feel different.

### 2.4 Shorts: one new ledger, and the invariant that dictates its shape

Shorting is the one genuinely new mechanic. The design is decided by a single
constraint:

> `checkOwnershipIntegrity` (`resolver/invariants.ts:385`) sums `holdings.shares`
> per class against `totalIssuedByClass`. A negative holding would either break
> that sum or force the invariant to special-case a sign — and that invariant is
> the spine of the game.

So: **`Holding.shares` stays non-negative and a short is never a holding.**
A short is a separate, cash-settled exposure in its own array, it never votes, it
never counts toward an ownership percentage, and it never touches a company's
balance sheet.

```ts
ShortPositionSchema = z.object({
  id, entityId, securityId, instrumentId, companyId,
  shares,                       // always positive; the direction is the type
  openedQuarter,
  openPriceUsd,                 // the quote it was struck at
  markPriceUsd,                 // last quarter's mark, for the P&L step
  marginPostedUsd,
  borrowFeePctPerQuarter,       // recomputed every quarter from utilisation
  isDisclosed: boolean,
});
```

**The honest note, stated once.** A real short borrows a specific lender's shares
and sells them to a real buyer, so the lender's economic position and the
buyer's are both real and the register still adds up. We do not model the borrow
leg. What we model is the *price* of borrowing and the *pressure* of covering,
which is where all the gameplay is. The cost of the simplification is that short
interest does not appear anywhere on the register; the benefit is that the one
invariant everything else rests on is not touched. **(inferred — this is a
deliberate design trade, not a claim about markets.)**

**The bounds.** All whole numbers, all checkable:

```
SHORT_INTEREST_CAP_PCT   = 20   // per instrument, session-wide, as % of float
SHORT_MARGIN_PCT         = 50   // dry powder posted when the position opens
SHORT_MAINTENANCE_PCT    = 30   // below this, the position is force-covered
SHORT_DISCLOSURE_PCT     =  5   // a position this size becomes public
```

**Borrow cost rises with utilisation.** In the real stock-loan market a name with
abundant lendable supply trades near zero ("general collateral") and one where
demand outruns supply becomes "hard to borrow", with the fee rationing the
scarce shares and sometimes moving daily; GameStop's borrow fee ran at about 1%
in January 2019 and about 34% during the squeeze
([IBKR on borrow fees](https://www.interactivebrokers.com/campus/traders-insight/securities/short-selling/the-risks-of-shorting-series-part-ii-borrow-fees/),
[S3 Partners on US borrow fees](https://www.s3partners.com/articles/us-stock-borrow-fees)).

We take the shape and tame the range **(inferred)**:

```
shortInterestPct = round(100 × totalSharesShort / floatShares)
borrowFeePctPerQuarter = 1 + round(19 × shortInterestPct / SHORT_INTEREST_CAP_PCT)
```

1% a quarter at zero utilisation, **20% a quarter at the cap**. Charged on
notional out of dry powder, every quarter, with a `borrow_cost_charged` row. A
crowded short bleeds; a lonely one is nearly free. That single line is the whole
reason a hedge fund cannot sit short forever waiting to be right.

**The squeeze**, deterministic, no draw:

```
if quarterReturnPct >= SQUEEZE_RETURN_TRIGGER_PCT (15)
   and shortInterestPct >= SQUEEZE_MIN_SHORT_INTEREST_PCT (10):
       every short position covers SQUEEZE_COVER_SHARE_PCT (25) of its shares
       at this quarter's quote, in entity order
```

Rising borrow fees and a rising price force covering, and the covering itself
pushes the price further — that is the real mechanism
([Evidence Investor on squeezes](https://www.evidenceinvestor.com/post/the-consequences-of-short-squeezes)).
Ours feeds the forced-cover volume into next quarter's `liquidityEffect`, which
is already clamped to ±0.1 log return (`markets/pricing.ts:307`), so a squeeze is
sharp and cannot run away. **A squeeze is a consequence, never an event draw.**

**Margin.** A position whose `marginPostedUsd` falls below
`SHORT_MAINTENANCE_PCT` of current notional is closed in full, immediately, at
the quote. This is the assertion in the "shorts covered" test: at every commit,
every open short is inside its margin, and the sum of shares short per instrument
is inside the cap.

### 2.5 What is a CapitalEntity, and what is not

| Thing | Verdict | Reason |
|---|---|---|
| **VC, PE, hedge fund** | `CapitalEntity` | The directive, and they allocate capital rather than operate a business. |
| **Sovereign fund** | `CapitalEntity`, `kind: 'sovereign'` | Qadr is *already seeded* with a CIO on connection 94 and holdings on eight registers. Deleting it to keep the kind list at three would break world 2's opening register for no gain. It gets its own behaviour profile (§3.6) and a charter cap that stops it ever taking control. |
| **Bank** | **Company** | A bank has revenue, staff, a balance sheet and products; it is an operating business, and `offeredDebtRate` (`resolver/capital.ts:666`) plus `world.capitalMarkets.debtAvailability` already models the *credit market* it would sell into. Making a bank a `CapitalEntity` would put an operating P&L inside a type designed to have none. If lending ever becomes a player business, it is a `Company` in a new sector — not this. |
| **Corporate / strategic VC arm** | **Company behaviour** | `buy_shares` already lets one company take a stake in another, and `holderKind: 'company'` already exists for it. A strategic stake should read as *that company* doing it, not as a fund. |
| **The public float** | unchanged | `public_float` stays the anonymous remainder. It is not an entity and has no opinion. |

### 2.6 The roster

**World 2: eleven entities — the six that already exist, promoted, plus five
new.** Four VC, three PE, three hedge, one sovereign.

The six existing names are kept exactly as seeded. Renaming them would rewrite
every world-2 register and every director's `representedHolderId` for the sake of
tidiness, and the names are good.

| # | Id | Name | Kind | Region | Strategy / stage | AUM | Dry powder | Partner |
|---|---|---|---|---|---|---|---|---|
| 1 | `fund_seawall` | Seawall Capital | vc | north_america | Multi-stage crossover, series_a → growth; the biggest cheque in the game | $18bn | 55% | Helena Ward |
| 2 | `fund_indus` | Indus Growth | vc | south_asia | Growth only, series_c → growth; revenue-quality discipline | $2.4bn | 60% | Asha Rege |
| 3 | `fund_altiplano` | Altiplano Capital | vc | latin_america | Seed → series_a, regional, small cheques, high hit rate | $900m | 65% | Ricardo Salas |
| 4 | `fund_ironwood` | **Ironwood Ventures** | vc | europe | Seed → series_b deep tech; robotics and manufacturing affinity | $600m | 70% | **Britt Halvorsen** |
| 5 | `fund_tessera` | Tessera Industrial | pe | europe | Control buyouts and roll-ups in manufacturing and logistics | $9bn | 40% | Stefan Koll |
| 6 | `fund_grantwood` | **Grantwood Partners** | pe | north_america | Large-cap take-privates, dividend recaps, operational squeeze | $14bn | 45% | **Ellis Maddox** |
| 7 | `fund_straits` | **Straits Industrial Partners** | pe | east_asia | Mid-market roll-ups; energy and logistics affinity | $5bn | 50% | **Ken Sarawan** |
| 8 | `fund_kaido` | Kaido Partners | hedge_fund | east_asia | Activist long; takes seats and demands change | $6bn | 55% | Mei-Lan Ho |
| 9 | `fund_coldbrook` | **Coldbrook Capital** | hedge_fund | north_america | Fundamental long/short; publishes short reports | $3.2bn | 70% | **Dov Ferreira** |
| 10 | `fund_perihelion` | **Perihelion Capital** | hedge_fund | europe | Event-driven and merger arbitrage; trades the public record | $2bn | 75% | **Nadia Brandt** |
| 11 | `fund_qadr` | Qadr Sovereign Fund | sovereign | middle_east | Patient, long-only, energy and infrastructure; never above 25% | $40bn | 30% | Tariq Al-Muhairi |

The five new partner characters are ordinary `Character` rows with
`role: 'investor'`, seeded exactly like the six that exist, at connection levels
**below** the incumbents (Ellis Maddox 82, Ken Sarawan 70, Dov Ferreira 68,
Nadia Brandt 64, Britt Halvorsen 58) so that a first-quarter founder can actually
reach one of them under `CONNECTION_GAP_RULE` — the whole roster sitting at 90+
would make the offers inbox the only way to meet anybody, which defeats the
Network screen.

The five new entities take **no** opening holdings, so world 2's registers do not
change by one share and `world2Scenario.test.ts` keeps passing on its existing
assertions. They arrive as cash looking for a home, which is also the right
story: the incumbents own the past, the newcomers have the dry powder.

**World 1: gated off entirely.**

`isMultiSectorWorld(state)` (`economy/sectors.ts:51`) is the single world-version
gate, and `docs/economy-study.md` §3.9 is explicit that world 1 is frozen so
legacy saves replay byte-identically. World 1 holds three passive blocs
(`fund_lattice`, `fund_halberd`, `fund_albahr`, `scenario/demo.ts:848–921`) and
two `role: 'investor'` directors. They stay exactly what they are: strings on a
register that vote through `tallyProposal` and sell blocks at a premium. A
world-1 session grows no `capitalEntities` key, no `shortPositions`, no
`capitalOrders`, and hashes exactly as it always has. This is not caution for its
own sake — it is the same rule `npcPostingEnabled` follows in
`social/npcPosts.ts`, and for the same reason: a frozen world that suddenly grew
eleven fund actors would replay to prices the player never saw.

---

## 3. Behaviour: what each kind does, every quarter

### 3.1 The common shape

Every desk in this section is the same four steps, and every step is pure:

```
1. SCORE     every eligible company, 0..100, from state only. No draw.
2. THRESHOLD one whole number. Below it, nothing happens at all.
3. CAP       a hard count per entity per quarter, and a hard size per order.
4. ORDER     write a DealProposal, a CapitalOrder, or a BoardProposal —
             structures the engine already resolves.
```

Ties break the way they break everywhere else in this engine: by the declared
entity order, then by company id. There is no RNG anywhere in the scoring. Where
a sub-stream is needed for a tie-break of last resort, it is
`ctx.rng.fork('capital_desks')` — a *fork*, exactly as `resolveCapital` already
takes `ctx.rng.fork('capital')` (`resolver/capital.ts:327`) — so the desk cannot
shift any other consumer's draw sequence.

**The work budget.** Eleven entities scoring twenty-four companies is trivial
arithmetic, but the *output* must be bounded or the feed and the state both blow
up. One session-wide ceiling, applied after per-entity caps, in priority order:

```
CAPITAL_DESK_ORDER_BUDGET = 40      // orders + deals + proposals per quarter
```

For comparison, `npcPostBudget` caps the world's whole social output at 15 posts
plus 5 replies. Forty capital rows a quarter across eleven institutions is the
same order of magnitude and is what a phone can render.

### 3.2 Venture capital

**Sourcing.** For each (fund, company) where the company is active, private or
recently listed, and inside the fund's `stageBand`:

```
growth   = clamp(round(100 × revenueGrowthYoY / 0.60), 0, 100)   // 60% YoY = full marks
affinity = sectorAffinity[fund][company.sector]                   // 0..100, seeded
stageFit = 100 in band · 50 one stage out · 0 beyond
founder  = ceo.connectionLevel                                    // 0..100, already state
relation = relationship(partner → ceo).trust                      // 0..100, already state

sourcingScore = round(30×growth + 20×affinity + 20×stageFit + 15×founder + 15×relation) / 100
```

Five terms, each already a number in state, each explicable in one line on the
offer card. `relation` is what makes the player's history matter: a founder who
burned Helena Ward two years ago is scored fifteen points lower by Seawall
forever, and the card says so.

**Issue a term sheet** when all of:

```
sourcingScore >= VC_TERM_SHEET_FLOOR (62)
dryPowderUsd  >= cheque + fee reserve
no offer to this company within VC_REOFFER_COOLDOWN_QUARTERS (4)
lpPressure    <  60
```

capped at `VC_TERM_SHEETS_PER_QUARTER = 2` per fund, highest score first.

**The terms**, every one of them computed:

```
chequePctOfAum   = { pre_seed 1, seed 1, series_a 2, series_b 4, series_c 6, growth 8 }
cheque           = min(round(committedCapitalUsd × chequePctOfAum / 100),
                       round(dryPowderUsd × 25 / 100))

priceMultiplier  = clamp(1 + (sourcingScore − 62) / 38 × 0.60, 0.70, 1.60)
preMoneyUsd      = round(estimateValuationUsd(draft, company) × priceMultiplier)
dilutionPct      = round(100 × cheque / (preMoneyUsd + cheque))

boardSeats       = dilutionPct >= 15 ? 1 : 0        // matches capital.ts:618 exactly
proRata          = stage >= series_a
protective       = dilutionPct >= 20
liquidationPref  = 1× non-participating, always
```

The last line is not laziness. 1× non-participating is the ordinary Series A
outcome — roughly 70% of Carta-tracked deals — and the standard document suite
carries pro-rata rights in the Investor Rights Agreement and board composition in
the Voting Agreement
([Pillar Legal on liquidation preference](https://www.pillarlegalpc.com/series-a-term-sheet-liquidation-preference/),
[NVCA model documents](https://nvca.org/wp-content/uploads/2019/06/NVCA-Model-Term-Sheet-1.doc)).
Holding the preference constant means the *one* economic dial on the card is the
price, and the *one* control dial is the board seat — which is what a phone can
show honestly. `ShareClass` already carries
`liquidationPreferenceMultiple` and `participating` (`ownership.ts:43`), so this
costs nothing.

**Follow-ons.** If the fund already holds and `revenueGrowthYoY >= 20%`, it
offers its pro-rata share of the next round automatically. Two consecutive
quarters of negative growth and the follow-on stops — *and the partner's trust in
the founder falls by 6*, which is a real, visible consequence of a bad year that
has nothing to do with the share price.

**Pressure in the boardroom.** Nothing new. The fund's director already votes
through `tallyProposal` on `growthPreference`, `financialDiscipline` and
`relationshipWithCeo`. What the desk adds is a per-quarter derived `goal`:

```
push_growth        while quartersHeld < exitHorizon/2 and growth >= 20%
push_profitability while runwayQuarters < 6 or operatingMargin < 0
push_exit          while quartersHeld >= exitHorizon − 4 or lpPressure >= 40
defend_position    while a rival fund is accumulating in the same name
```

The goal is what the partner *talks about* — it is the only thing handed to the
LLM (§4.5) — and it is derived, so the words can never disagree with the vote.

**Exits**, in this order:

1. Listed, outside lock-up, and `unrealisedMultiple >= TARGET_MULTIPLE (3, or 2
   at lpPressure ≥ 40)` or `quartersHeld >= exitHorizon`: sell
   `EXIT_TRANCHE_PCT = 25` of the position per quarter through the existing
   settlement path, so the sale moves the price through `liquidityEffect` like
   anyone else's.
2. Private and `world.capitalMarkets.ipoWindow >= IPO_WINDOW_FLOOR (0.3)`: the
   fund's director tables a board proposal of kind `ipo`. The player can lose
   that vote — which is the point.
3. A standing buyout approach from a PE fund at or above the fund's carrying
   value: the fund votes for it.

### 3.3 Private equity

**Targeting.** For each (fund, listed or large-private company):

```
maturity  = 100 when growthYoY <= 12% and revenueTtm >= PE_MIN_REVENUE_USD ($200m),
            scaled linearly below
cashflow  = clamp(round(100 × operatingMarginPct / 0.25), 0, 100)
cheapness = clamp(round(100 × (1 − marketCapUsd / max(1, anchorValueUsd))), 0, 100)
levercap  = clamp(round(100 × (1 − debt / max(1, revenueTtm))), 0, 100)
affinity  = sectorAffinity[fund][company.sector]

targetScore = round(25×maturity + 25×cashflow + 25×cheapness + 15×levercap + 10×affinity) / 100
```

`cheapness` is the term that makes the player's *stock price* a vulnerability
rather than a scoreboard: trade far enough below your own fundamental anchor for
long enough and Grantwood arrives. That is rule 9 of the project working in the
player's disfavour for once, and it is the best possible argument for managing
belief.

**Approach when `targetScore >= PE_APPROACH_FLOOR (66)`**, one per fund per
quarter, `PE_REAPPROACH_COOLDOWN_QUARTERS = 6` against the same target. Then the
sequence, which is the drama:

| Q | Stage | Rule | What the player sees |
|---|---|---|---|
| 1 | **Private approach** | `offer = round(max(marketCap, anchor) × (100 + PE_CONTROL_PREMIUM_PCT (25)) / 100)`, a confidential `DealProposal` | An offer in the inbox, with a now→after preview of the cash it puts in their pocket |
| 2 | **Bear hug** | Same offer made public: a `PublicDisclosure` plus an NPC post. Premium `+ BEAR_HUG_BUMP_PCT (10)`, capped at `PE_MAX_PREMIUM_PCT (60)`. Belief `acquisition_target` rises | Headline in the feed; the share price gets a floor under it and the board gets letters |
| 3+ | **Tender** | Accumulate through `runSettlement` toward 50% + 1, paying `stakeExecutionPriceUsd` on the float and `BLOCK_PREMIUM` on other funds' blocks | A stake bar climbing toward the control line, quarter by quarter, in public |

At 50% + 1 the fund is decisive on the board (`tally.ts:362`) and its own
acquisition proposal carries. **No new takeover verb is needed.** The verb was
built in Wave 3; this points it at somebody.

**Defences the player can raise** — each an existing structure, each with a
price:

| Defence | Mechanism | Cost |
|---|---|---|
| **Poison pill** | Board proposal of kind `financing`: issue shares pro rata to every holder *except* the raider, diluting them by `POISON_PILL_DILUTION_PCT = 20`. `authorisedShares` must be raised in the same step or `checkAuthoritativeBackend` refuses the quarter (`invariants.ts:485`) | −8 investor reputation; usable once per raider; raises the raider's cost by ~25% |
| **Staggered board** | A new `Board.staggered` boolean (appending a defaulted field is safe), set at IPO or by a `restructuring` proposal. A controlling holder becomes decisive only `STAGGERED_DELAY_QUARTERS = 2` quarters after crossing | Two quarters of protection, bought once; −4 investor reputation for entrenchment |
| **White knight** | A `DealProposal` to a rival `CapitalEntity`. Its acceptance is deterministic: `targetScore >= PE_APPROACH_FLOOR − 10` and dry powder sufficient. It counter-bids at `WHITE_KNIGHT_BUMP_PCT = 5` over the standing offer | You still lose the company — to somebody who will treat you better |

Those three are the canonical set: a rights plan that dilutes the bidder on
crossing a threshold in the mid-teens to twenty per cent, a staggered board that
stretches the timeline, and a friendly bidder who outbids
([Icon Partners on poison pills](https://www.icon.partners/post/what-is-a-poison-pill-in-corporate-law),
[hostile takeover defences](https://ibinterviewquestions.com/blog/hostile-takeovers-defense-strategies)).
Ours are the same three, priced.

**The LBO.** The consideration is equity plus debt placed on the *target*:

```
newDebt = min( round(target.revenueTtmUsd × LBO_DEBT_TO_REVENUE_PCT (100) / 100),
               round(targetNetAssetsUsd) )                        // Plutocracy's cap
equityCheque = offerValueUsd − newDebt                            // from dry powder
rate = offeredDebtRate(draft, target) + LBO_SPREAD_PCT (2) / 100
```

Sponsored buyouts ran at roughly 5.5× debt/EBITDA in 2024
([MSCI](https://www.msci.com/research-and-insights/quick-take/the-walking-debt-buyout-against-the-leverage-wall)).
We have no EBITDA line, so the mapping is stated explicitly: at the ~18–20%
operating margins world 2's mature companies carry, 5.5× EBITDA is about **1.0×
revenue**, which is where `LBO_DEBT_TO_REVENUE_PCT` is set **(inferred)**. The
second cap — debt may never exceed the borrower's net assets — is Plutocracy's
own rebalance and is the single ratio that turns leverage from an exploit into a
number you have to grow
([SteamDB patch notes](https://steamdb.info/app/754500/patchnotes/)).

The bookkeeping, spelled out because this is where a reviewer will worry:

```
target:   liabilities.debt += newDebt ; assets.cash += newDebt      (debt_issued row)
then the acquisition settles through the existing resolveAcquisitions path,
with cashComponent = equityCheque + newDebt drawn from the target's own cash,
and acquisition_completed carrying { acquirerKind: 'fund', sponsorId, lboDebtUsd,
equityChequeUsd }.
```

Both movements are already read by `equityMovementsFromLedger` — `debt_issued`
moves assets and liabilities together and therefore needs no equity row at all,
and `acquisition_completed` is already a declared flow (`invariants.ts:331`).
**This is not a coincidence; it is the design rule of §4.2.**

**Operational squeeze.** A PE fund that controls a company writes it ordinary
actions in phase 4, facing the ordinary validator:

```
layoff              PE_SQUEEZE_LAYOFF_PCT (8) of one role per quarter,
                    for at most PE_SQUEEZE_QUARTERS (4)
set_marketing_budget to 60% of last quarter's
set_product_price    +5%
set_dividend_policy  up to 40%
```

Not one line of new economics. Morale, attrition and the price-rise churn
penalty (`PRICE_SHOCK_CHURN = 0.75`) already punish it, so the squeeze is a real
trade rather than free margin — and a rival the player watches being squeezed is
a rival whose customers become available.

**Roll-ups.** When a fund controls two or more companies in the same sector, it
tables `acquisition` to merge the smaller into the larger, one per fund per
quarter, through the existing `acquire_company` path. Each completion appends to
`recentAcquisitionQuarters`, which already feeds `antitrustExposure`. The brake
is wired before the accelerator is built.

**Group control and the toll.** `ultimateControllerId` (`economy/prices.ts:134`)
walks `parentCompanyId` chains. Extend it — gated, with its own test — so a
decisive `CapitalEntity` holder resolves as the group root. A Tessera roll-up in
European logistics then charges a toll its own portfolio does not pay, which is
the Plutocracy holding fantasy delivered by a fund rather than by a conglomerate
([Holdings update](https://store.steampowered.com/news/app/754500/view/546722128842458675)).
Flagged as the **one change in this document that alters existing behaviour**;
everything else is additive.

**Dividend recap.** On a controlled company with `debt < revenueTtm` and positive
trailing net income: issue `RECAP_DEBT_TO_REVENUE_PCT = 50` of revenue in new
debt and set `dividendPolicyPct` to `RECAP_PAYOUT_PCT = 60`. Sponsored dividend
recaps averaged 5.1× leverage in 2024
([PitchBook](https://pitchbook.com/news/articles/opportunity-knocks-leveraged-loan-dividend-deals-take-flight)),
so an incremental 0.5× revenue on top of a 1.0× LBO is conservative
**(inferred)**. It needs no new mechanic: `dividendUsd` is already capped at half
of cash (`DIVIDEND_CASH_CAP_SHARE`), and the company falling under six quarters
of runway already flips it to `survival` posture in `applyNpcDefaults`.

### 3.4 Hedge funds

**The signal.** Per listed instrument, per quarter:

```
gap  = clamp(round(100 × (anchorValueUsd − marketCapUsd) / max(1, marketCapUsd)), −100, 100)
news = signed, credibility-weighted sum of this quarter's public disclosures and
       stories about the company, bounded to ±40
conviction = clamp(round(0.7 × gap + 0.3 × news), −100, +100)
```

`gap` is the fundamentals-versus-price gap the engine already computes for its
own return decomposition; `news` is the feed. Nothing is invented.

```
LONG_CONVICTION_FLOOR  = +25
SHORT_CONVICTION_FLOOR = −25
```

**Sizing — three caps, and every one of them is a test:**

```
notional = min( round(dryPowderUsd × POSITION_SIZE_PCT (15) / 100),
                round(floatShares × price × FLOAT_SIZE_PCT (10) / 100),
                round(lastQuote.volume × price) )
shares   = floor(notional × abs(conviction) / 100 / executionPrice)
```

Dry powder, float, and one quarter's absorption. A fund cannot spend money it
does not have, cannot own more of a company than exists, and cannot move more
than the market took last quarter.

**Activism**, the campaign ladder. Opened when a long position crosses
`OWNERSHIP_THRESHOLDS` 10% (`major_holder`) and conviction has held ≥ +40 for two
consecutive quarters:

| Stage | Gate | Structure it uses |
|---|---|---|
| `private_letter` | 10% | A private `DealProposal` whose `intentStatements` carry the demands |
| `public_letter` | 15% (`board_pressure`) | A `PublicDisclosure` (`analyst_note`) + an NPC post + a belief move |
| `board_demand` | 15% and a seat, or a friendly director | A `BoardProposal` of the kind the demand maps to |
| `proxy_fight` | 25% (`blocking_stake`) | The proposal goes to a vote the fund can block or, at 50%+1, carry |

Demands come from a five-entry enum, each mapping to an existing proposal kind:
`sell_the_company → divestiture`, `replace_ceo → ceo_dismissal`,
`cut_costs → restructuring`, `return_capital → dividend`,
`split_the_business → divestiture`.

**Settlement should be the common outcome, not the fight.** Activists secured 112
US board seats in the first half of 2025 with about 92% of them won through
settlement rather than a vote, and of 57 campaigns launched in the first ten
months of 2025 only eight reached a ballot
([Cleary Gottlieb, 2025 activism trends](https://www.clearygottlieb.com/news-and-insights/publication-listing/2025-shareholder-activism-trends-and-what-to-expect-in-2026),
[Harvard corpgov on hedge fund activism](https://corpgov.law.harvard.edu/2024/05/06/ma-developments-hedge-fund-activism/)).
So the settlement rule is deterministic and generous:

```
the target settles — grants one board seat and adopts one demand — when
  tallyProposal(demand).support / (support + against) >= 0.40
  or the fund's stake >= 25%
```

which means most campaigns end in a negotiated seat, a few go to a vote, and the
player's *board relationships* decide which — precisely the lever the game
already has and under-uses.

**Short reports.** When a fund is short and `conviction <= -55`, once per
`SHORT_REPORT_COOLDOWN_QUARTERS (4)` per fund, it publishes a `PublicDisclosure`
of kind `analyst_note` with a `beliefTopic` chosen from the fundamental that
drove the gap (`accounting_concern`, `revenue_miss`, `margin_pressure`), and:

```
credibility = clamp01(0.7 × trackRecord / 100 + 0.3 × pastReportHitRate)
```

The existing belief machinery (`markets/beliefs.ts`) then moves the price. **The
engine owns the belief delta; the model owns only the prose.** That is
`docs/economy-study.md` §5 rule 7, applied without exception.

And the report is scored. Within `SHORT_REPORT_JUDGEMENT_QUARTERS (4)`:

```
target's anchor fell >= 10%   →  trackRecord + 8
target's anchor rose >= 10%   →  trackRecord − 12
```

Asymmetric on purpose — the same asymmetry `GUIDANCE_MISS_PENALTY` already uses
against companies (`resolver/disclosure.ts:39`). A fund that cries wolf becomes a
fund nobody believes, and its next report moves the price less. That is a
reputation loop with an actual mechanism, and it is the answer to "why can't a
hedge fund just publish a report every quarter forever?"

**Event-driven.** On any `acquisition_completed`, `contract_awarded`,
`ipo_completed`, antitrust remedy or `dividend_paid` in the public record, an
event-driven fund takes a bounded position next quarter — for a merger, long the
target and short the acquirer at `ARB_SIZE_PCT = 5` of dry powder — capped at
`EVENT_TRADES_PER_QUARTER = 2` per fund. This is the mechanism that makes the
public record *tradeable*, which is the thing that makes reading the feed feel
like an edge.

### 3.5 Outcomes for everyone, not just the player

Stated as a requirement because it is the half of the directive most easily
lost:

> The desks score **every active company**. The player's company is one row in
> the same table, ranked by the same five terms, and it is usually not the top
> one.

Three consequences the tests pin in §6:

- Over twelve quarters of the world-2 default seed, at least one **rival** is
  bought out, at least one **rival** is the subject of an activist campaign, and
  at least one **rival** is shorted.
- The targets of those three events are at least three distinct companies.
- Every one of them appears in the public record with a headline, so the player
  learns about their industry by reading it rather than by being told.

### 3.6 The sovereign, in one paragraph

Qadr is long-only, never shorts, never approaches hostile, never agitates, has
`lpPressure` permanently 0 (it has no LPs), holds for `exitHorizonQuarters = 60`,
and is bound by a charter cap of **25% of any company** — which is exactly the
`CONTROL_INFORMATION_PCT` line, so it takes information rights and never control.
Its cheque is the largest in the game and it doubles when
`world.capitalMarkets.riskAppetite < 0.35`. It is the buyer of last resort: in a
downturn, when every other fund is under LP pressure and selling, Qadr is bidding.
That gives the world a stabiliser with a face, and gives the player one
counterparty who is always there and always slow.

---

## 4. Integration

### 4.1 The phase map

No new resolution phase. `RESOLUTION_PHASES` stays at eighteen — adding a phase
would shift every phase stream after it, which `docs/economy-study.md` §5 lists
as the third thing never to do.

| Phase | # | What runs | What it calls / writes |
|---|---|---|---|
| `action_collection` | 4 | `runCapitalDesks(draft, ctx)`, **after** `applyNpcDefaults` | Writes `DealProposal`s (term sheets, approaches, white-knight invitations), `CapitalOrder`s, and PE portfolio actions as ordinary `SubmittedAction`s with a new `ActionOrigin` `'sponsor'` |
| `board_resolution` | 5 | unchanged | `tallyProposal` already counts fund directors and already flips on `grantsControl`; activist and defence proposals resolve here |
| `capital_resolution` | 6 | `resolveSponsorCapital(draft, ctx)` inside `resolveCapital`, after `routeDeals` | Accepted term sheets → `resolveFundingRounds` path with a **real** `leadInvestorCharacterId` and `participantHolderIds`; LBOs → `debt_issued` on the target then `resolveAcquisitions`; recaps → `issue_debt` + `set_dividend_policy`; fees and capital calls move `dryPowderUsd` |
| `disclosure_resolution` | 12 | `publishSponsorDisclosures(draft, ctx)` | Short reports and public activist letters become `PublicDisclosure` rows with a computed `credibility` and a `beliefTopic`; 5%+ fund positions and 5%+ short positions publish |
| `market_resolution` | 13 | `runSettlement` extended; `settleShorts(draft, ctx)` | Fund longs settle through the **same** path as everyone else; shorts open, mark, accrue borrow cost, force-cover on squeeze or margin |
| `social_resolution` | 14 | two new `NpcPostCandidate` kinds | Activist letters and short reports get a voice inside the **existing** `npcPostBudget`; no new budget |
| `relationship_update` | 15 | unchanged | Partner relationships and memories move through `relationships/reactions.ts` on the quarter's fund events |
| `leaderboard_update` | 16 | `recomputeCapitalEntities(draft, ctx)`, then `rebuildLeaderboards` | NAV, DPI, LP pressure, track record; two new boards |

**Ordering notes that must be in the doc comments**, because a future reader will
otherwise "fix" them:

- The desk runs **after** `applyNpcDefaults` so it sees what the world already
  decided this quarter, and takes a **forked** stream so it cannot move
  `applyNpcDefaults`'s hiring jitter.
- Shorts settle **after** `priceMarket`, so a short opened this quarter is struck
  at this quarter's quote and its P&L lands next quarter. Plannable, and stated.
- Term sheets are offered in phase 4 of quarter *t* and can only be accepted by
  an action submitted in quarter *t+1*. **A fund's offer is never resolved in the
  quarter it is made.** That is what makes the offers inbox a decision rather
  than a notification.

### 4.2 The rule that governs everything: declared flows

This is the single hardest constraint in the codebase and every implementer must
read it before writing a line.

`checkFinancialIntegrity` (`resolver/invariants.ts:145`) does not merely check
that assets − liabilities = equity. It **reconstructs** each company's equity
movement from the quarter's ledger rows via `equityMovementsFromLedger`
(`invariants.ts:243`), which switches on a closed set of event types:
`revenue_recognised`, `cost_recognised`, `funding_round_closed`, `shares_issued`,
`ipo_completed`, `buyback_executed`, `dividend_paid`, `acquisition_completed`,
`shares_traded`, `world_event_applied` (antitrust remedy) and
`information_revealed` (administration). A movement explained by none of them is
an *unexplained gap*, and the quarter does not commit.

Therefore:

> **A `CapitalEntity` may move a company's equity only through a row the
> reconstruction already reads. Everything a fund does to its own books must
> touch no company balance sheet at all.**

Which is satisfied for free, and is why the design above looks the way it does:

| Fund act | Row it produces | Read by the reconstruction? |
|---|---|---|
| Term sheet accepted | `funding_round_closed` (+ `shares_issued`) | yes, `amountUsd` |
| Buy shares | `shares_traded` side `buy` | yes, `considerationUsd` |
| Sell shares / exit | `shares_traded` side `sell` | yes |
| LBO debt | `debt_issued` | not needed — assets and liabilities move together |
| Buyout completes | `acquisition_completed` | yes, `stockUsd` / `bargainGainUsd` |
| Dividend recap | `dividend_paid` | yes, and it already names corporate recipients |
| Poison pill issue | `shares_issued` (`proceedsUsd: 0`) | yes; equity correctly unchanged |
| **Open a short** | `short_position_opened` | **no — and it must not be**, because it touches only the entity's dry powder |
| **Borrow fee** | `borrow_cost_charged` | no — entity only |
| **Mark to market** | `capital_entity_marked` | no — entity only |

A new **`capital_integrity`** invariant (appending to `SIMULATION_INVARIANTS`, a
zod enum, is safe) does for entities what `financial_integrity` does for
companies: every movement of `dryPowderUsd` in the quarter must be explained by
the quarter's rows, and `dryPowderUsd >= 0`. Ship it as a state invariant that
rolls the quarter back; promote it into `ENGINE_INVARIANTS` (which throws) only
after a clean forty-quarter soak.

### 4.3 New state, new event types, and everything that is reused

**New `SessionState` fields** (all `.default([])`, all absent in world 1):

```
capitalEntities:   CapitalEntity[]          durable
shortPositions:    ShortPosition[]          durable
activistCampaigns: ActivistCampaign[]       durable, pruned 12 quarters after close
capitalOrders:     CapitalOrder[]           cleared at ledger_commit, like pendingActions
```

`CapitalOrder` is a small discriminated union — `buy | sell | short_open |
short_cover | publish_report | campaign_step` — and nothing else. Term sheets and
buyout approaches are written straight into `deals` because `routeDeals` already
resolves those; inventing a parallel offer pipeline would be the second-worst
decision available here.

**Ten new `SIM_EVENT_TYPES`, appended, never inserted.** Each earns its place by
carrying something no existing type can:

| # | Type | Payload | Visibility | The surface it feeds |
|---|---|---|---|---|
| 1 | `short_position_opened` | `{ entityId, instrumentId, securityId, shares, priceUsd, notionalUsd, shortInterestPctAfter, borrowFeePct, marginPostedUsd }` | `private` below 5% of float, `public` at or above | Markets short-interest row; The Street short book |
| 2 | `short_position_covered` | `{ entityId, instrumentId, shares, priceUsd, realisedPnlUsd, forced, reason: 'target'\|'squeeze'\|'margin'\|'horizon' }` | same rule | Feed; fund track record |
| 3 | `short_interest_published` | `{ instrumentId, shortInterestPct, before, borrowFeePct, holders }` | `public` | Markets, one whole percentage per instrument |
| 4 | `short_squeeze_triggered` | `{ instrumentId, returnPct, shortInterestPctBefore, forcedCoverShares, entityIds }` | `public` | Feed headline; next quarter's liquidity effect |
| 5 | `borrow_cost_charged` | `{ entityId, instrumentId, notionalUsd, feePct, feeUsd }` | `private` | The entity's own books; `capital_integrity` |
| 6 | `activist_campaign_opened` | `{ entityId, targetCompanyId, stakePct, demands, convictionPct }` | `company` at private-letter stage, `public` after | Offers inbox; feed |
| 7 | `activist_campaign_escalated` | `{ entityId, targetCompanyId, fromStage, toStage, stakePct }` | `public` | Feed; boardroom |
| 8 | `activist_campaign_closed` | `{ entityId, targetCompanyId, outcome: 'settled'\|'won'\|'defeated'\|'withdrawn', quartersRun, seatsGranted }` | `public` | Feed; track record |
| 9 | `takeover_defence_raised` | `{ companyId, defence, raiderEntityId, costUsd, reputationDelta, effect }` | `public` | Feed; the raider's next-quarter cost |
| 10 | `capital_entity_marked` | `{ entityId, navUsd, dryPowderUsd, deployedUsd, realisedProceedsUsd, dpiPct, lpPressure, trackRecord, positions }` | `public` | The Street; both new leaderboards |

**Everything else reuses an existing type with an added payload field**, which is
the discipline `docs/economy-study.md` §Appendix sets and the reason the ledger's
audit surface stays stable:

- Term sheets and approaches → `deal_proposed` / `deal_accepted` / `deal_rejected`
  with `{ dealKind: 'term_sheet' | 'buyout_approach', entityId, … }`.
- A closed term sheet → `funding_round_closed`, at last with a real
  `leadInvestorCharacterId`.
- An LBO → `acquisition_completed` with
  `{ acquirerKind: 'fund', sponsorId, lboDebtUsd, equityChequeUsd }`.
- Every fund trade → `shares_traded` with `{ holderKind: 'fund', entityId }`, and
  `ownership_threshold_crossed` unchanged.
- A short report → `disclosure_published`, then `belief_updated`.
- A recap → `debt_issued` + `dividend_paid`.

**Append-only lists that grow, all of them zod enums where appending is safe:**

```
SIM_EVENT_TYPES          + the ten above
SIMULATION_INVARIANTS    + 'capital_integrity'
LEADERBOARD_BOARDS       + 'capital_returns', 'assets_under_management'
LEADERBOARD_SUBJECT_KINDS + 'fund'
DEAL_OBLIGATION_KINDS    + 'term_sheet', 'buyout_offer'   (union grows at the end)
ACTION_ORIGINS           + 'sponsor'
MEMORY_KINDS             unchanged — 'investment', 'negotiation', 'deal_broken' cover it
AGENT_ROLES              unchanged — see §4.5
```

### 4.4 Counterplay: what the player actually does

Every fund act has an answer, and the answer is an existing action:

| The fund does | The player answers with | Bound |
|---|---|---|
| Term sheet | `accept_deal` | resolves next quarter through the round path |
| | **Counter** — a `propose_deal` back with amended terms | price within `COUNTER_BAND_PCT = ±20`, board seats ±1. Acceptance is deterministic: the fund accepts if the countered price is inside the band its own score computed. **The engine computes the band; the partner supplies the words.** |
| | `reject_deal` | costs nothing the first time; a second rejection inside the cooldown costs 4 trust |
| Buyout approach | `reject_deal`, or a board vote against | a *hostile* fund then tenders in public, and the player sees the stake bar climb |
| Bear hug | `respond_crisis` (already exists) | moves belief; does not move the offer |
| Tender toward 50% | poison pill / staggered board / white knight (§3.3) | each has a stated cost, shown on the confirm button |
| Activist letter | `respond_crisis`, `lobby_director`, or concede a demand | conceding closes the campaign as `settled` and costs one board seat |
| Short report | `give_guidance` and then **meet it** | the existing credibility loop is the counter-weapon; beating guidance after a short report is the most satisfying revenge the game can offer |
| Squeeze | none — but you can *cause* one by buying your own float back (`buyback`) | already implemented |

And symmetrically, what the player gains: an **offers inbox** that is a source of
capital they did not have to ask for, a **short interest** figure that tells them
what the smart money thinks, and an **exit** — a fund that wants to sell its
stake is a fund the player can buy out of their own cap table.

### 4.5 The LLM boundary

**No new `AgentRole`.** The existing seven cover it: `character_dialogue`
produces the partner's reply in a negotiation (and can emit a
`ConditionalCommitment`, which is already machine-checked against the real
proposal numbers by `commitmentConditionsHold`), and `social_author` produces the
prose of a public letter or a short report. Adding a "capital partner" role would
buy nothing and cost a permanent widening of the authority surface.

**What a model may write:** the partner's words. The rationale on a term sheet.
The body of an activist letter. The headline of a short report. A stance inside a
band the engine computed.

**What a model may never decide:** whether an offer is made, to whom, at what
price, in what size, on what premium, with how many board seats, at what
credibility, whether a campaign escalates, whether a defence works, whether a
vote passes, or the value of any number on any of those. If a model could set a
price, a model would eventually talk its way past the bounds — the reason is
`docs/economy-study.md` §5 rule 5 and it applies here more than anywhere.

**The cap.** `LLM_MAX_CONCURRENCY` defaults to **1** and the limiter is FIFO with
no timeout (`packages/llm/src/transport/limited.ts`), because the deployment
target is a 4 GB single-board machine that cannot afford two Claude Code
subprocesses. A quarter already spends its budget on the World Director and the
rival strategists. So:

```
CAPITAL_PARTNER_UTTERANCES_PER_QUARTER = 2
```

chosen by salience — the offer or campaign that most concerns the player first,
then the largest by value. Everything else uses the deterministic template
renderer, built exactly like `renderNpcText` (`social/npcPosts.ts:357`): the
partner's traits pick a voice, the seeded stream picks a variant inside it. The
game reads well with the model switched off entirely, which is rule 10.

---

## 5. Player surfaces

Every surface below obeys `docs/economy-study.md` §6.3: whole numbers, one
primary figure per card, full-width bars, no table wider than the phone, every
slider paired with a numeric field, and **every derived number a tap target that
opens the ledger row it came from** (§6.2).

### 5.1 "The Street" — a new screen

Route `apps/web/src/app/(game)/street/page.tsx`, added to the **Capital** group in
`src/lib/nav.ts` beside Markets and Capital. Eleven cards, scrolling.

Each card:

- **one number** — AUM, bare: `$18bn`.
- **one bar** — dry powder as a share of AUM, the V7 headroom pattern:
  `Dry powder $9.9bn · 55%`. This is the single most useful number on the screen,
  because it is how much they can still do to you.
- **one line** — the thesis, from the entity row.
- **one chip** — stance toward you, derived, four states:

  ```
  BACKER     holds >= 5% of one of your companies and trust >= 55
  WATCHING   default
  HOSTILE    hostility >= 55, or an open short or campaign against you
  ADVERSARY  an open buyout approach or proxy fight against you
  ```
- **one line** — last move: *"Bought 1.2% of Kestrel"*, *"Cut Basalt to 6%"*,
  *"Opened a short in HELN"*.
- **one meter** — LP pressure, 0–100, three bands (calm / harvesting / forced),
  because a forced seller is a buying opportunity and the player should be able
  to see it four quarters out.

Tapping a card opens a drawer: full portfolio (company, stake %, since quarter,
unrealised multiple), short book (instrument, short interest %, since), track
record (`trackRecord`, DPI, realised multiple), the partner with a link into
Network, and every ledger row this entity produced this quarter.

### 5.2 The offers inbox

A section on Command Centre showing the count, and the full list on The Street.
Three kinds of card — term sheet, approach, activist letter — each with the V5
**now → after** preview, which is the pattern the whole Wave 3 visual contract
turns on:

```
Seawall Capital · Series B · $60m at $340m pre

  Now                     After
  You own      62%        You own      53%
  Cash         $18m       Cash         $78m
  Board        5 seats    Board        6 seats (Seawall takes one)

  Pro-rata rights · protective provisions · 1× non-participating

  [ Accept ]   [ Counter ]   [ Decline ]
```

`Counter` opens a two-slider sheet — price and board seats — each paired with a
numeric field, each showing the band the fund will accept **before** the player
commits, because the band is engine-computed and there is no reason to hide it.

A buyout approach card shows the premium as one percentage against the last
close, and the three defences as present-but-disabled verbs with the reason and
the cost — the V4 pattern: *"Poison pill — needs a board vote · −8 investor
reputation"*.

### 5.3 Markets

Per instrument, two additions:

- **Short interest** — one whole percentage with a bar against the 20% cap, and
  the borrow fee beside it: `Short interest 14% · borrow 14%/qtr`. When a squeeze
  fires, a warning-tone badge: `SQUEEZE · 25% force-covered`.
- **Holders** — a 13F-style list of *disclosed* positions only. Crossing 5% is
  what makes a position public in this engine and it is what makes it public in
  the real one: an initial Schedule 13D is due within five business days of
  crossing 5%, and a passive Schedule 13G filer has its own accelerated deadline
  ([Skadden on the 2024 deadlines](https://www.skadden.com/insights/publications/2024/09/new-schedule-13g-accelerated-filing-deadlines),
  [SEC fact sheet](https://www.sec.gov/files/33-11030-fact-sheet.pdf)).
  Below 5% the row is absent — **not blurred, not summarised, absent** — which is
  the redaction rule `resolver/projection.ts` and `publicRecord.ts` already
  enforce. An undisclosed accumulation is the game's sharpest weapon and the UI
  must not soften it.

The existing Wave 3 card `Your stake 41% · control at 50%` gains the other side
of the fight: `Grantwood 22% · +4pp this quarter`.

### 5.4 Feed, Leaderboard, Network

- **Feed** — fund moves arrive as ordinary disclosures and posts, so
  `projectPublicRecord` needs no new source, only new `whyItMatters` cases:
  *"Coldbrook is short 9% of you"*, *"Grantwood raised its offer to $6.4bn — 22%
  above your last close"*, *"Seawall is selling: LP pressure 71"*.
- **Leaderboard** — two new boards, subject kind `fund`: **Capital Returns**
  (realised + unrealised multiple, the only ranking in the game a player cannot
  enter) and **Assets Under Management**. Funds on the leaderboard is what makes
  them peers rather than scenery.
- **Network** — the eleven partners are already `Character` rows, so they appear
  with a relationship level and a connection level for free. Tariq at 94 and
  Helena at 91 are unreachable to a new founder under `CONNECTION_GAP_RULE`,
  which is correct and is the best argument the game has for
  `request_introduction`. Britt Halvorsen at 58 is the door.

---

## 6. Tests that pin it

Grouped by what they protect. Assertion shapes given because the shape is the
specification.

**Determinism and world gating**

1. `capitalDesksAreDeterministic` — twelve quarters, same seed, twice; the
   post-commit state hash is equal.
2. `worldOneIsByteIdentical` — a world-1 session replays to the same state hash
   as before the change, and `state.capitalEntities` is `[]`, `shortPositions`
   `[]`, `capitalOrders` `[]`.
3. `resolutionPhasesUnchanged` — `RESOLUTION_PHASES.length === 18` and the array
   deep-equals its frozen literal.
4. `simEventTypesAreAppendOnly` — the first *N* entries equal the frozen prefix;
   the ten new ones are at the end.
5. `existingPhaseDrawCountsUnchanged` — RNG consumption per phase is equal before
   and after, proving the desk forked its own stream.

**Bounds**

6. `noEntityExceedsDryPowder` — over a 500-case fuzz of seeded states, no order
   settles for more than the entity's `dryPowderUsd`, and `dryPowderUsd >= 0` at
   every commit.
7. `noPositionExceedsFloatShare` — settled shares ≤ `FLOAT_SIZE_PCT` of float and
   ≤ last quarter's volume, per order.
8. `shortInterestNeverExceedsCap` — for every instrument at every quarter,
   `sum(shortPositions.shares) <= floatShares × SHORT_INTEREST_CAP_PCT / 100`.
9. `everyShortIsMarginedOrCovered` — at every commit, every open short satisfies
   `marginPostedUsd >= notional × SHORT_MAINTENANCE_PCT / 100`; any that did not
   is closed in the same quarter with `forced: true`.
10. `borrowFeeIsMonotoneAndBounded` — non-decreasing in short interest, always in
    `[1, 20]`, always a whole number.
11. `squeezeIsBoundedAndDeterministic` — a squeeze covers exactly
    `SQUEEZE_COVER_SHARE_PCT` of each position, and the resulting price move
    stays inside `V2_MAX_ABS_LOG_RETURN` unless a `sentiment_shifted`
    `price_shock` row exists (which `checkMarketIntegrity` already demands).
12. `lboDebtRespectsBothCaps` — never above `revenueTtm × 1.0` and never above the
    target's net assets.

**Invariants**

13. `capTableReconcilesAfterEveryFundTrade` — extend the existing ownership
    invariant test with fund buys, sells, blocks and a poison-pill issue.
14. `balanceSheetsBalanceThroughAnLbo` — after an LBO the target's
    assets − liabilities = equity, the acquirer's dry powder fell by exactly the
    equity cheque, and `checkFinancialIntegrity` reports zero unexplained
    movement.
15. `poisonPillRespectsAuthorisedShares` — an issue that would exceed
    `authorisedShares` is refused, not clamped.
16. `capitalIntegrityExplainsEveryDryPowderMove` — the new invariant, run over a
    forty-quarter session; zero unexplained movements.
17. `shortsNeverAppearInHoldings` — no `Holding.shares` is ever negative, and no
    short contributes to `VotingPower` or to an ownership percentage.

**Outcomes — the tests that prove the directive was met**

18. `rivalsAreBoughtSqueezedAndShorted` — twelve quarters on the world-2 default
    seed:

    ```ts
    const rows = run(createWorld2Session(), 12).events;
    const buyouts = rows.filter(e => e.type === 'acquisition_completed'
                                  && e.payload.acquirerKind === 'fund');
    const campaigns = rows.filter(e => e.type === 'activist_campaign_opened');
    const shorts   = rows.filter(e => e.type === 'short_position_opened');

    expect(buyouts.length).toBeGreaterThanOrEqual(1);
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    expect(shorts.length).toBeGreaterThanOrEqual(1);

    // and none of it is about the player
    const targets = new Set([...buyouts, ...campaigns, ...shorts]
      .map(e => String(e.targetId ?? e.payload.targetCompanyId)));
    expect(targets.size).toBeGreaterThanOrEqual(3);
    expect([...targets].some(id => id !== W2_COMPANIES.player)).toBe(true);
    ```

19. `everyFundActIsInThePublicRecord` — for each of those events, at least one
    `PublicRecordItem` visible to a neutral seat references it.
20. `settlementsOutnumberProxyFights` — over the same run,
    `outcome === 'settled'` occurs at least as often as `'won'` + `'defeated'`,
    matching the real distribution cited in §3.4.
21. `theBudgetHolds` — no quarter produces more than
    `CAPITAL_DESK_ORDER_BUDGET` capital rows.

**Player-facing**

22. `termSheetNeverResolvesInTheQuarterItIsOffered`.
23. `counterInsideTheBandIsAcceptedAndOutsideIsNot` — the deterministic
    negotiation rule, both directions.
24. `undisclosedPositionsAreAbsentFromTheProjection` — a fund at 4% appears
    nowhere in `projectPublicRecord` or `PlayerView`; at 5% it appears.

---

## 7. Build plan

Four stages, run after Wave 3 lands. **File ownership is exclusive**: a stage
never edits a file another stage owns, which is what lets B and C run in
parallel.

### Stage A — contracts and scenario

**Owns:** `packages/contracts/src/capital.ts` (new), and edits to `ownership.ts`,
`sim.ts`, `deals.ts`, `session.ts`, `economy.ts`, `governance.ts` (the
`Board.staggered` field), `engine.ts`, `index.ts`; plus
`packages/simulation/src/scenario/world2/{seeds,people,index}.ts`.

**Does:** the `CapitalEntity`, `ShortPosition`, `ActivistCampaign` and
`CapitalOrder` schemas; the two new `DealObligation` variants; the ten event
types; the enum appends; the constants table (§Appendix); the eleven-row roster
and five new partner characters; the `EconomyReport` additions for The Street.

**Returns to B and C:** the id map (`CapitalEntity.id === the cap-table holder
id`), the constants module, the `CapitalDesksSubsystem` interface signature, and
the derived report row shapes.

**Must not:** touch `packages/simulation/src/resolver`, `markets`, `economy`, or
anything in `apps/web`.

### Stage B — engine behaviour

**Owns:** `packages/simulation/src/capital/**` (new directory: `desks.ts`,
`vc.ts`, `pe.ts`, `hedge.ts`, `shorts.ts`, `entities.ts`), and edits to
`resolver/capital.ts`, `resolver/disclosure.ts`, `resolver/leaderboards.ts`,
`resolver/invariants.ts`, `resolver/index.ts` (call sites only),
`markets/settlement.ts`, `economy/prices.ts` (`ultimateControllerId` only),
`social/npcPosts.ts`, `validator/rules.ts`, `engine.ts`; and
`packages/simulation/test/capitalEntities.test.ts` plus extensions to
`determinism.test.ts` and `invariants.test.ts`.

**Does:** everything in §3 and §4, in the phase order of §4.1, plus the
`capital_integrity` invariant and every test in §6.

**Returns to C:** the populated `EconomyReport` rows and a worked example of one
committed quarter's ledger for the surfaces to read.

**Must not:** touch `packages/contracts` (if a schema is wrong, that is a
message back to A, not an edit) or `apps/web`.

### Stage C — surfaces

**Owns:** `apps/web/src/app/(game)/street/page.tsx` and
`src/components/screens/street/**` (new), plus additive edits to the Markets,
Capital, Command Centre, Feed, Leaderboard and Network screens, and the one entry
in `src/lib/nav.ts`.

**Does:** §5, entirely from committed rows. No screen computes an economic number
of its own.

**Must not:** touch `packages/simulation` or `packages/contracts`, or
`components/ui/**` and `components/shell/**` beyond the nav entry, which three
agents share.

### Stage D — balance pass

**Owns:** the constants module only (`packages/contracts/src/capital.ts`
constants block) and a new `packages/simulation/test/capitalOutcomes.test.ts`.

**Does:** runs forty quarters on three seeds and tunes exactly the numbers in the
Appendix table until §6's outcome assertions hold with margin, without touching a
line of behaviour. Keeping the constants in one block is what makes this stage
possible as a separate, low-risk pass.

---

## 8. What NOT to do

**Against determinism (rule 4).**

1. **Do not add a resolution phase.** RNG is forked per phase precisely so a new
   draw cannot shift another phase's sequence; a new *phase* shifts everything.
   Every behaviour here fits inside the existing eighteen.
2. **Do not draw a random number to decide whether a fund acts.** A buyout, a
   campaign and a short are all consequences of scores the player can see. The
   moment "will they bid?" becomes a coin flip, The Street screen becomes a slot
   machine with portraits.
3. **Do not read a clock, and do not reorder `SIM_EVENT_TYPES`, `SECTORS`,
   `WORLD_DRIFT_SPECS`, `LEADERBOARD_BOARDS` or `RESOLUTION_PHASES`.** Append.

**Against the invariants.**

4. **Do not make `Holding.shares` negative**, and do not add a sign field, a
   `direction` enum, or a "synthetic holding" to the cap table. The one array
   `checkOwnershipIntegrity` sums stays a set of positive longs.
5. **Do not move a company's equity through a new event type.** §4.2. A new type
   is invisible to `equityMovementsFromLedger` and the quarter will not commit.
6. **Do not let a fund issue shares it did not authorise.** A poison pill raises
   `authorisedShares` in the same step or it is refused.
7. **Do not model rehypothecated borrow, naked shorts, or a securities-lending
   market.** The borrow fee ladder carries all of the gameplay and none of the
   accounting risk.

**Against LLM-proposal-only (rule 3).**

8. **Do not let a model set a price, a cheque, a premium, a position size, a
   credibility, or a campaign stage.** The engine computes the band; the partner
   supplies the words and a stance inside it.
9. **Do not add an `AgentRole`.** `character_dialogue` and `social_author`
   already have exactly the authority these characters need, and no more.
10. **Do not fan out one model call per fund per quarter.** The limiter is FIFO
    at concurrency 1 on a 4 GB machine; eleven queued calls is a quarter that
    takes minutes. Two utterances, chosen by salience, everything else templated.

**Against phone legibility.**

11. **Do not build a holdings table with a column per fund.** Eleven columns is
    not a phone surface. Cards, one entity each, scrolling.
12. **Do not show an undisclosed position, blurred or summarised.** Below 5% the
    row is *absent*. Redaction, never repair — the rule `publicRecord.ts` already
    holds.
13. **Do not add a second numeric scale.** LP pressure, track record, conviction,
    antitrust exposure and reputation are all 0–100 with the same three bands.
    A fund's "quality" is not a new five-star system.
14. **Do not put a slider on a screen without a numeric field and a now→after
    preview.** V5, and Coffee Inc 2's documented mobile anti-pattern
    ([feedback](https://gamingroute.com/4224-2/)).

**Against balance and tone.**

15. **Do not give funds unbounded or unmodelled capital.** Capitalism's own
    forum records that handing AI competitors large starting capital made the
    game *easier*, because it removed their urgency
    ([thread](https://capitalism2.com/forum/viewtopic.php?p=42368)). Dry powder,
    fees, LP pressure and the J-curve exist to keep every fund under pressure.
16. **Do not let a fund act outside the action, deal, board and settlement
    paths.** No private mechanics, no free money, no hidden information — the
    same rule `applyNpcDefaults` follows for background companies.
17. **Do not build a fund-of-funds layer, an LP market, a fundraising minigame or
    a secondaries market.** Eleven institutions with clocks is already a
    populated economy; a capital-structure tower on top of it is a spreadsheet.
18. **Do not add a "call your investor" button that resolves instantly.**
    Everything is a quarter. An offer made in *t* is answered in *t+1*, and that
    delay is what makes the inbox a decision.
19. **Do not make the player the only target.** The scoring table has one row per
    company and the player's is usually not the top one. Test 18 exists to keep
    it that way.
20. **Do not model crimes.** No bribery of a portfolio company's auditor, no
    planted stories, no market cornering as an explicit verb. A short report is a
    published argument with a credibility score and a reputational consequence
    for being wrong — that is business-legal hardball, and it is the right
    register for this product.

---

## Appendix A — the constants, in one block

Stage A puts these in `packages/contracts/src/capital.ts`; Stage D is allowed to
change any number here and nothing else.

| Constant | Value | Governs |
|---|---|---|
| `CAPITAL_ENTITY_KINDS` | vc, pe, hedge_fund, sovereign | §2.5 |
| `MAX_CAPITAL_ENTITIES` | 12 | state size |
| `CAPITAL_DESK_ORDER_BUDGET` | 40 | rows per quarter, session-wide |
| `FUND_TERM_QUARTERS` | 40 | lifecycle |
| `INVESTMENT_PERIOD_QUARTERS` | 20 | lifecycle |
| `MANAGEMENT_FEE_PCT_PER_QUARTER` | 0.5 | the J-curve |
| `CARRY_PCT` | 20 | partner wealth |
| `DRY_POWDER_FLOOR_PCT` | 5 | reserve never deployed |
| `SHORT_INTEREST_CAP_PCT` | 20 | per instrument |
| `SHORT_MARGIN_PCT` / `SHORT_MAINTENANCE_PCT` | 50 / 30 | forced cover |
| `SHORT_DISCLOSURE_PCT` | 5 | when a short becomes public |
| borrow fee | `1 + round(19 × util)` | 1–20% per quarter |
| `SQUEEZE_RETURN_TRIGGER_PCT` | 15 | squeeze |
| `SQUEEZE_MIN_SHORT_INTEREST_PCT` | 10 | squeeze |
| `SQUEEZE_COVER_SHARE_PCT` | 25 | squeeze |
| `VC_TERM_SHEET_FLOOR` | 62 | VC |
| `VC_TERM_SHEETS_PER_QUARTER` | 2 | VC |
| `VC_REOFFER_COOLDOWN_QUARTERS` | 4 | VC |
| `VC_PRICE_STRETCH_PCT` | 60 | VC price multiplier, bounded 0.70–1.60 |
| `TARGET_MULTIPLE` | 3 (2 under LP pressure) | exits |
| `EXIT_TRANCHE_PCT` | 25 | exits |
| `PE_APPROACH_FLOOR` | 66 | PE |
| `PE_MIN_REVENUE_USD` | 200m | PE |
| `PE_CONTROL_PREMIUM_PCT` | 25 | PE |
| `BEAR_HUG_BUMP_PCT` / `PE_MAX_PREMIUM_PCT` | 10 / 60 | PE |
| `PE_REAPPROACH_COOLDOWN_QUARTERS` | 6 | PE |
| `LBO_DEBT_TO_REVENUE_PCT` | 100 | LBO, second-capped at net assets |
| `LBO_SPREAD_PCT` | 2 | LBO |
| `RECAP_DEBT_TO_REVENUE_PCT` / `RECAP_PAYOUT_PCT` | 50 / 60 | recap |
| `PE_SQUEEZE_LAYOFF_PCT` / `PE_SQUEEZE_QUARTERS` | 8 / 4 | squeeze |
| `POISON_PILL_DILUTION_PCT` | 20 | defence |
| `STAGGERED_DELAY_QUARTERS` | 2 | defence |
| `WHITE_KNIGHT_BUMP_PCT` | 5 | defence |
| `LONG_CONVICTION_FLOOR` / `SHORT_CONVICTION_FLOOR` | +25 / −25 | hedge |
| `POSITION_SIZE_PCT` / `FLOAT_SIZE_PCT` | 15 / 10 | hedge sizing |
| `ARB_SIZE_PCT` / `EVENT_TRADES_PER_QUARTER` | 5 / 2 | event-driven |
| `SHORT_REPORT_COOLDOWN_QUARTERS` | 4 | short reports |
| `SHORT_REPORT_JUDGEMENT_QUARTERS` | 4 | track record |
| short report hit / miss | +8 / −12 | track record |
| `COUNTER_BAND_PCT` | ±20 | negotiation |
| `CAPITAL_PARTNER_UTTERANCES_PER_QUARTER` | 2 | LLM cap |
| `SOVEREIGN_CHARTER_CAP_PCT` | 25 | sovereign |

## Appendix B — files each stage touches

| Stage | Contracts | Simulation | Web |
|---|---|---|---|
| A | `capital.ts` (new), `ownership.ts`, `sim.ts`, `deals.ts`, `session.ts`, `economy.ts`, `governance.ts`, `engine.ts`, `index.ts` | `scenario/world2/{seeds,people,index}.ts` | — |
| B | — | `capital/**` (new), `resolver/{capital,disclosure,leaderboards,invariants,index}.ts`, `markets/settlement.ts`, `economy/prices.ts`, `social/npcPosts.ts`, `validator/rules.ts`, `engine.ts`, `test/**` | — |
| C | — | — | `app/(game)/street/**`, `components/screens/street/**`, `components/screens/{markets,capital,command-centre,feed,leaderboard,network}/**`, `lib/nav.ts` |
| D | `capital.ts` constants block only | `test/capitalOutcomes.test.ts` | — |

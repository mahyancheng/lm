# Government

Public procurement is a complete strategic subsystem, not "government customer,
plus one hundred million dollars of revenue". It resolves in phase 7
(`government_resolution`) of the quarter, after boards and capital, before
talent and research.

The subsystem's design claim: **winning is not automatically good.** A large
award brings backlog, credibility, stable demand and access to specialised
projects, and it also brings compliance cost, capacity lock-in, employee unease,
public criticism, export restrictions, IP constraints, conflict with commercial
customers and cost-overrun risk. A player who bids on everything loses.

## 1. Agencies

An `Agency` is a buyer with a budget and a worldview.

| Field | Role |
|---|---|
| `jurisdiction` | `federal_civil`, `defence`, `intelligence`, `state_regional`, `supranational`, `allied_foreign` |
| `budgetQuarterlyUsd` | Scales with `world.government.procurementBudget` |
| `priorities` | Ordered `AgencyPriority[]` — what this agency actually cares about |
| `contactCharacterIds` | Officials a player can meet, subject to the connection rules |
| `clearanceAuthority` | Whether it can sponsor clearances for a contractor's staff |

The eight priorities are `national_security`, `cost_efficiency`,
`domestic_industry`, `responsible_ai`, `speed_of_delivery`, `vendor_diversity`,
`data_sovereignty` and `workforce_modernisation`. Priorities bias the evaluation
weights the agency publishes on each opportunity, so understanding them changes
how you bid — and understanding them is exactly what a well-connected founder
gets from a meeting.

Defence and intelligence jurisdictions carry clearance requirements and heavier
public scrutiny: their contracts raise `publicControversyLevel`, which feeds
employee morale and media attention.

## 2. Lifecycle

```text
world.government.* rises
   ↓
openOpportunities()          ProcurementOpportunity created, status 'open'
   ↓
visibility check             public / invited / classified
   ↓
players and NPCs decide      bid_government · form_consortium · decline_opportunity
   ↓
closeQuarter reached         status 'evaluating'
   ↓
requirements gate            fail any → disqualified, not scored
   ↓
scoreBids()                  seven axes × evaluation weights
   ↓
awardContracts()             highest weightedTotal wins
   ↓
GovernmentContract created   milestones, compliance burden, export flags
   ↓
advanceMilestones()          every quarter: deliver, recognise, penalise
   ↓
ContractorReputation         governmentPastPerformance updated — permanently
```

Visibility tiers matter as much as the terms:

- **`public`** — appears on the Government screen for every session member.
- **`invited`** — reaches only companies with sufficient standing or an
  introduction. This is where the Network screen pays for itself.
- **`classified`** — requires clearance to see the opportunity exists at all.

## 3. What an opportunity looks like

```text
UNITED FEDERATION DEPARTMENT OF DEFENCE

Programme:
Sovereign Intelligence Platform

Maximum value:
$2.4B over 5 years

Contract:
Cost-plus incentive

Evaluation:
Technical capability            30%
Security & reliability          20%
Past performance                15%
Price / cost realism            15%
Delivery schedule               10%
Domestic supply chain            5%
Responsible AI compliance        5%

Requirements:
Security clearance      Level IV
Domestic inference      Required
Model audit             Required
Uptime                   99.99%
Data sovereignty         Required
Minimum past performance      55
```

Every number there is machine-readable. The weights are
`EvaluationWeightsSchema`, which **refuses to parse unless the seven values sum
to 1.0 within 1e-6**. `DEFAULT_EVALUATION_WEIGHTS` is exactly the weighting
above. The requirements are `OpportunityRequirementsSchema` — hard gates, not
scored axes.

## 4. Contract forms

| Form | Overrun risk | Upside | Evaluation consequence |
|---|---|---|---|
| `fixed_price` | Contractor bears it | Efficiency gains are kept | Price scored directly |
| `cost_plus` | Buyer bears most of it | Capped by the incentive fee | **Cost realism** examined: an implausibly low proposed cost scores *badly*, not well |

Cost realism is the mechanic that stops bid-price from being a pure dominant
strategy. `priceRealism` scores a parabola, not a slope: both an implausibly low
price (which the engine tests against the bidder's real unit costs) and an
uncompetitively high one score near zero.

## 5. The bid strategy space

A player choosing how to engage picks from:

```text
Bid as prime contractor
Form a consortium
Become a subcontractor
Decline
Request clarification
Partner with another human player
License another company's technology
```

The bid itself (`GovernmentBidSchema`) is a set of genuine trade-offs, each with
a cost somewhere else in the company:

| Field | The trade-off |
|---|---|
| `price` | Margin against win probability, against cost-realism scoring |
| `technicalScoreInputs` | Claims are **discounted by real `techCapabilities`** — promising what you cannot deliver scores well now and destroys past performance later |
| `computeCommitment` | Accelerators locked to the programme are unavailable for commercial work, for `quarters` quarters |
| `staffCommitment` | `clearedStaff` are scarce and slow to create; clearance takes quarters to obtain |
| `timeline` | More milestones mean earlier revenue recognition **and** more chances to miss |
| `subcontractors` | Reach capability you lack, at a share of contract value |
| `ipConcessions` | `none` → `government_use_rights` → `joint_ownership` → `full_transfer`; each step raises technical and responsible-AI scores and permanently reduces the commercial value of the work elsewhere |
| `auditRights` | `continuous` scores well and adds a standing compliance cost |
| `domesticSourcingPct` | Directly scores the domestic-supply axis; usually costs margin |
| `consortiumMemberIds` | Joint prime, shared accountability |
| `narrative` | **Colour only.** The score comes from the numbers. |

That last row is a deliberate design statement: the pitch is written by a model
or by the player, and it changes nothing. Procurement in this game is not a
persuasion minigame.

## 6. Scoring

```text
for each bid:
    if any requirement fails → disqualified, notes explain which, no score

    technical       = Σ(claim_i × credibility_i) / n
                      credibility_i = min(1, realCapability_i / claimed_i)
    security        = f(securityPosture claim × ops headcount × incident record)
    pastPerformance = g(ContractorReputation for this agency,
                        then the government-wide aggregate)
    priceRealism    = parabola(price, engineEstimatedCost, competitorPrices)
    schedule        = h(deliveryQuarters vs engine estimate,
                        milestone granularity, staff and compute committed)
    domesticSupply  = domesticSourcingPct
    responsibleAi   = i(auditRights, ipConcessions, responsibleAiCommitment,
                        company safety record)

    weightedTotal   = Σ(axis × evaluationWeights[axis])

rank by weightedTotal descending; ties broken by pastPerformance, then by
submission sequence (deterministic)
```

Every bid receives a `BidScoreBreakdown` with all seven axis scores, the
weighted total, the rank and human-readable `notes`. **The breakdown is shown to
the bidder after award**, so losing never feels like a dice roll — you can see
that you lost on cost realism by four points and adjust.

The engine discounts claims by capability rather than rejecting them, which
creates the subsystem's sharpest trap: a bid that over-promises can still win,
and then fails its milestones.

## 7. Contracts in flight

An award creates a `GovernmentContract`:

- `milestones` — revenue recognition, penalties and past-performance movement
  all hang off milestones, never off the contract as a whole. Each has a
  `dueQuarter`, a `valueUsd` released on acceptance, a `qualityScore` (below 0.5
  the agency accepts with reservations, which still damages past performance)
  and a `computeRequiredUnits` that **must be available in the delivery
  quarter**.
- `complianceBurdenQuarterlyUsd` — a standing cost while the contract is live:
  audit, clearance maintenance, reporting, segregated infrastructure.
- `exportRestricted` — true when the work restricts what the company may sell
  abroad. This can conflict directly with commercial customers, and
  `fam_export_control` firing can flip it on new awards.
- `publicControversyLevel` — drives employee morale effects and media attention.
- `status` — `active`, `completed`, `terminated`, `suspended`. **Termination for
  default is the worst outcome available in this subsystem** and follows the
  company for the rest of the session.

The benefits and costs, side by side, as the Government screen presents them
before a player commits:

```text
+ Contracted backlog              - Compliance expense
+ Credibility                     - Lower flexibility
+ Government relationship         - Capacity commitment
+ Stable demand                   - Employee morale controversy
+ Access to specialised projects   - Public criticism
+ Potential co-funded research    - Export restrictions
                                  - IP constraints
                                  - Conflict with other customers
                                  - Cost overrun risk
```

## 8. Past performance persists

`ContractorReputation` is the memory of this subsystem, and it is an evaluation
weight in every future competition.

| Field | Behaviour |
|---|---|
| `pastPerformanceScore` | 0–100. Slow to build, quick to damage. Feeds `Company.governmentPastPerformance` |
| `onTimeDeliveryPct` | Fraction of milestones delivered on or before due quarter |
| `costOverrunPct` | Average overrun against proposed cost; negative means under budget |
| `securityIncidents` | Reportable incidents on public work |
| `contractsWon` / `contractsLost` | Competition record |
| `terminationsForDefault` | Each is close to disqualifying for the largest programmes |

Reputations are kept **per agency and in aggregate** (`agencyId` nullable). A
company can have an excellent record with a civil modernisation agency and a
poor one with defence, and each agency scores its own history first.

A failed programme therefore damages far more than one quarter of revenue:

```text
Delivery missed by 2 quarters
 ↓
Penalty                              contract.penaltiesUsd
 ↓
Government reputation -14            pastPerformanceScore and reputation.government
 ↓
Future bid score falls               15% of every subsequent evaluation
 ↓
Board Risk Committee investigates    directors on the 'risk' committee
 ↓
Press coverage                       MediaStory, angle 'regulatory'
 ↓
Public stock -6%                     publicInfoEffect in the return decomposition
 ↓
Rival wins next procurement
```

`minimumPastPerformance` on large programmes means new entrants are genuinely
locked out until they build a record on smaller work. That is the intended
progression: a first-quarter founder cannot bid on a $2.4B sovereign platform,
and should not be able to.

## 9. Consortiums and subcontracting

`form_consortium` proposes a joint bid: an opportunity, invitees, a lead
(prime) company accountable for the whole programme, and your share of contract
value. **Each invitee must accept through the deal system before the consortium
is real** — `DealObligation` of kind `consortium_membership`. Free text in a
conversation never forms a consortium.

This is how a specialist reaches a programme it could not deliver alone: a
company with world-class `efficiency` capability and no cleared staff joins a
prime that has clearances and no efficient inference. It is also the most common
route to a genuine human-to-human alliance, because both parties gain
mechanically and both are bound by an enforceable obligation.

Subcontracting (`Subcontractor` on the bid) is the lighter version: a share of
contract value flows through, the prime remains accountable, and the
subcontractor's capability is folded into the technical score at a discount.

## 10. Connections help discovery, never award

This is a non-negotiable design principle.

**Connections legitimately do:**

- surface `invited` opportunities a player would not otherwise see
- obtain introductions to `contactCharacterIds` at an agency
- reveal an agency's `priorities`, so a bid can be shaped to them
- open the door to a consortium with a company that already has standing
- provide advance notice that a programme is coming, through a `meet_regulator`
  or a relationship with an official

**Connections never do:**

- add points to a bid score
- override a hard requirement
- act as a hidden bribery statistic that decides who wins

There is no such statistic anywhere in the schema. `BidScoreBreakdown` has seven
axes and none of them is "relationship". This preserves the political-strategy
fantasy — knowing the right people genuinely matters — without making corrupt
conduct the core optimisation loop of the game.

The mechanical expression: relationships and connection level change *which
opportunities appear in `PlayerView.opportunities`* and *what the player knows
about them*. They never touch `scoreBids`.

## 11. Meeting regulators and officials

`meet_regulator` takes a `RegulatorTopic` (`model_rules`, `privacy`,
`antitrust`, `copyright`, `safety_obligations`, `export_controls`,
`procurement_policy`), a `RegulatorPosture` (`cooperative`, `defensive`,
`lobbying`, `informational`) and optional concessions.

- `cooperative` builds institutional standing slowly and reliably.
- `informational` mostly buys knowledge: agency priorities, likely timing.
- `lobbying` can shift a rule and **is remembered by everyone it
  disadvantages** — a `Memory` of kind `negotiation` with negative sentiment for
  every affected party.
- `defensive` protects against an active investigation at a standing cost.

Concessions offered — early access to evaluations, an audit commitment, a
delayed release — are recorded and **expected to be honoured**. A broken
concession damages `reputation.government` far more than never having offered.

No posture guarantees a rule change. `world.regulation.*` moves through the
event system and through engine dynamics; a meeting adjusts a probability and a
relationship, not a variable.

## 12. Government revenue in the financial model

- An award creates **backlog** (`Financials.backlogUsd`), not revenue.
- Milestone delivery moves value into `deferredRevenue`, then recognises it into
  `revenueQuarterly` in `financial_resolution`.
- `CompanyQuarterMetrics.governmentRevenueShare` tracks the concentration. High
  values bring stability and constraint together: a company at 60% government
  revenue has a smooth revenue line, an export-restricted product roadmap, a
  compliance cost base and a board that will ask hard questions the first time a
  milestone slips.
- `complianceBurdenQuarterlyUsd` is booked to operating expenses every quarter
  the contract is live, whether or not a milestone falls due.

A `gov_contract` board proposal is required before accepting a major award: the
board is explicitly voting to accept the risk and compliance burden, and a
director with a high `safetyOrientation` will interrogate the responsible-AI
commitments before agreeing.

# Action capability inventory (static audit)

**Baseline:** repository working tree at audit time (source branch includes `ActionIntent` additions through world 3). **Method:** read-only static tracing of the contract union, validator tables/gates, resolver phase dispatch, and subsystem readers. No test/build commands were run. A route is marked verified only where a concrete reader/dispatcher was found; a string occurrence in availability, UI, or validator code alone does not count as execution.

## Counts and invariants

- `ActionIntent` / `ACTION_TYPES`: **52 discriminants** (`packages/contracts/src/actions.ts`, `ACTION_TYPES`).
- Validator rule registrations: **52 keys** (`packages/simulation/src/validator/rules.ts`, `RULES`, mapped as `{ [K in ActionType] }`). The mapping is compile-time exhaustive.
- All 52 types have a validator rule registration.
- All 52 have a concrete resolver/subsystem reader in the current source trace. The two easy-to-miss government responses are consumed by `GovernmentSubsystem.openOpportunities → resolveOpportunityResponses`; they are not handled by `resolver/routing.ts`.
- `packages/simulation/test/actionCoverage.test.ts` is a dynamic execution coverage guard, but this audit did not run it. Its opening prose still says “forty-four” and “five action types”; those numbers are stale relative to the 52-member contract.

## Who may act and confirmation policy

The validator first resolves the acting company and controller. A player controller may submit the full operating surface, subject to CEO office gates and type rules. An NPC/system actor (`actor.playerId === null`) may act only for a company with no player controller; it is refused for a player-directed company. A non-controlling player can act only through the 5% shareholder capacity set below. Chief of Staff/advisor output is an action proposal with a player actor at submission; the origin does not bypass these gates. NPC strategists/defaults use the same validator path when queued.

| Capability gate | Types |
|---|---|
| Shareholder (>=5%) capacity when not controller | `buy_shares`, `sell_shares`, `propose_deal`, `accept_deal`, `reject_deal`, `social_post`, `request_introduction`, `submit_board_proposal` |
| CEO-only office gate (with documented controller/subsidiary exceptions) | `submit_board_proposal`, `lobby_director`, `appoint_executive`, `raise_round`, `issue_debt`, `issue_shares`, `buyback`, `ipo`, `acquire_company`, `meet_regulator`, `give_guidance`, `respond_crisis`, `merge_subsidiary` |
| Always requires explicit human confirmation for player actions | `raise_round`, `issue_debt`, `buyback`, `issue_shares`, `ipo`, `set_dividend_policy`, `acquire_company`, `layoff`, `bid_government`, `submit_board_proposal`, `propose_deal`, `accept_deal`, `sell_shares`, `buy_shares`, `buy_accelerators`, `invest_capacity`, `set_supply_terms`, `merge_subsidiary`, `license_node`, `publish_licence_terms` |

The confirmation check is skipped for unattributed NPC/system actions because it is explicitly conditioned on `actor.playerId !== null`; NPC actions still face all substantive validator rules and company-control rules.

## Complete route catalogue

`Validator` is the rule key in `RULES`. `Consumer / phase` names the concrete reader and the resolution phase that invokes it. `Actor surface` is the normal principal; all rows remain subject to the gates above. “Advisor” means the Chief of Staff can propose/translate the intent; it does not become an authority class.

### Research, products, people, compute and supply

| Action type | Validator | Consumer / phase | Actor surface | Confirm? |
|---|---|---|---|---|
| `set_research_budget` | yes | `companies/policy.researchEnvelopeUsd` via product staging / `product_demand_resolution` | CEO/controller; NPC | no |
| `start_research_project` | yes | `resolver/routing.ensureResearchProjects` / `research_resolution` | CEO/controller; NPC | no |
| `adjust_research_project` | yes | `resolver/routing.applyResearchAdjustments` / `research_resolution` | CEO/controller; NPC | no |
| `abandon_research_project` | yes | `resolver/routing.applyResearchAbandonments` / `research_resolution` | CEO/controller; NPC | no |
| `set_data_policy` | yes | `resolver/routing.applyDataPolicies` / `research_resolution` | CEO/controller; NPC | no |
| `propose_innovation` | yes | `resolver/index` and `research/experiments` + `research/innovation.integrateInnovationProposal` / `research_resolution` | CEO/controller; NPC | no |
| `publish_research` | yes | `resolver/disclosure` and `research/confidence` / `disclosure_resolution` | CEO/controller; NPC | no |
| `set_product_price` | yes | `companies/products.applyProductActions` / `product_demand_resolution` | CEO/controller; NPC | no |
| `launch_product` | yes | `companies/products` (staging and launch) / `product_demand_resolution` | CEO/controller; NPC | no |
| `sunset_product` | yes | `companies/products.applyProductActions` / `product_demand_resolution` | CEO/controller; NPC | no |
| `set_marketing_budget` | yes | `companies/policy` + product staging / `product_demand_resolution` | CEO/controller; NPC | no |
| `marketing_campaign` | yes | `companies/policy` + product staging / `product_demand_resolution` | CEO/controller; NPC | no |
| `hire` | yes | `companies/hiring.resolveHiring` / `talent_resolution` | CEO/controller; NPC | no |
| `layoff` | yes | `companies/hiring.resolveHiring` / `talent_resolution` (large layoffs may become board matter) | CEO/controller; NPC | **yes** |
| `poach_executive` | yes | `companies/hiring.resolveHiring` / `talent_resolution` | CEO/controller; NPC | no |
| `appoint_executive` | yes | board matter conversion where applicable; company hiring/appointment path / `talent_resolution` | CEO/controller; NPC | no |
| `reserve_compute` | yes | `companies/compute.resolveComputeOrders` / `product_demand_resolution` | CEO/controller; NPC | no |
| `buy_cloud_capacity` | yes | `companies/compute.resolveComputeOrders` / `product_demand_resolution` | CEO/controller; NPC | no |
| `buy_accelerators` | yes | `companies/compute.resolveComputeOrders`; quote receipt precheck in resolver / `product_demand_resolution` | CEO/controller; NPC | **yes** |
| `allocate_compute` | yes | `companies/compute.resolveComputeOrders` / `product_demand_resolution` | CEO/controller; NPC | no |
| `invest_capacity` | yes | `companies/capacity.resolveCapacityOrders` / `product_demand_resolution` | CEO/controller; NPC | **yes** |
| `set_supply_terms` | yes | `companies/supply.resolveSupplyOrders` / `product_demand_resolution` | CEO/controller; NPC | **yes** |
| `choose_supplier` | yes | `companies/supply.resolveSupplyOrders` / `product_demand_resolution` | CEO/controller; NPC | no |
| `fill_slot` | yes | `companies/products.resolveCompositionOrders` / `product_demand_resolution` | CEO/controller; NPC | no |
| `set_target_market` | yes | `companies/products.resolveCompositionOrders` / `product_demand_resolution` | CEO/controller; NPC | no |

### Capital, governance and government

| Action type | Validator | Consumer / phase | Actor surface | Confirm? |
|---|---|---|---|---|
| `raise_round` | yes | `resolver/capital.resolveCapital` (board-routed first when required) / `capital_resolution` | CEO/controller; NPC | **yes** |
| `issue_debt` | yes | board execution then `resolver/capital` / `board_resolution`, `capital_resolution` | CEO/controller; NPC | **yes** |
| `buyback` | yes | `resolver/capital.resolveCapital` / `capital_resolution` | CEO/controller; NPC | **yes** |
| `issue_shares` | yes | `resolver/capital.resolveCapital` (board-routed first when required) / `capital_resolution` | CEO/controller; NPC | **yes** |
| `ipo` | yes | `resolver/capital.resolveCapital` (board-routed first when required) / `capital_resolution` | CEO/controller; NPC | **yes** |
| `set_dividend_policy` | yes | `resolver/capital` / `capital_resolution` | CEO/controller; NPC | **yes** |
| `set_logistics_toll` | yes | `resolver/capital` / `capital_resolution` | CEO/controller; NPC | no |
| `buy_shares` | yes | `markets/pricing` and `markets/settlement` / `market_resolution` | Controller or qualifying shareholder; NPC | **yes** |
| `sell_shares` | yes | `markets/pricing` and `markets/settlement` / `market_resolution` | Controller or qualifying shareholder; NPC | **yes** |
| `acquire_company` | yes | `resolver/capital.resolveCapital` (board matter where required) / `capital_resolution` | CEO/controller; NPC | **yes** |
| `submit_board_proposal` | yes | `resolver/routing.ensureBoardProposals`; board tally/effects / `board_resolution` | CEO/controller or qualifying shareholder requisition; NPC | **yes** |
| `lobby_director` | yes | `boards/commitments` / `board_resolution` | CEO/controller; NPC | no |
| `transfer_between_group` | yes | `resolver/capital.resolveCapital` / `capital_resolution` | Group controller/sponsor; NPC where eligible | no |
| `merge_subsidiary` | yes | `resolver/capital.resolveCapital` / `capital_resolution` | CEO/controller; NPC | **yes** |
| `bid_government` | yes | `resolver/routing.ensureGovernmentBids` then government scoring/award / `government_resolution` | CEO/controller; NPC | **yes** |
| `decline_opportunity` | yes | `government/responses.resolveOpportunityResponses` via `GovernmentSubsystem.openOpportunities` / `government_resolution` | CEO/controller; NPC | no |
| `form_consortium` | yes | `government/responses.resolveOpportunityResponses` via `GovernmentSubsystem.openOpportunities` / `government_resolution` | CEO/controller; NPC | no |
| `meet_regulator` | yes | `relationships/reactions` via `relationships.updateRelationships` / `relationship_update` | CEO/controller; NPC | no |

### Disclosure, relationships, deals and licensing

| Action type | Validator | Consumer / phase | Actor surface | Confirm? |
|---|---|---|---|---|
| `social_post` | yes | `resolver/routing.ensureSocialPosts`, `social/reach` / `social_resolution` | Controller or qualifying shareholder; NPC | no |
| `give_guidance` | yes | `resolver/disclosure.resolveDisclosures` / `disclosure_resolution` | CEO/controller; NPC | no |
| `respond_crisis` | yes | `resolver/disclosure.resolveDisclosures` / `disclosure_resolution` | CEO/controller; NPC | no |
| `propose_deal` | yes | `resolver/capital.resolveCapital → resolver/routing.routeDeals` / `capital_resolution` (relationship memories update later) | Controller or qualifying shareholder; NPC | **yes** |
| `accept_deal` | yes | `resolver/capital.resolveCapital → resolver/routing.routeDeals` / `capital_resolution` (relationship memories update later) | Controller or qualifying shareholder; NPC | **yes** |
| `reject_deal` | yes | `resolver/capital.resolveCapital → resolver/routing.routeDeals` / `capital_resolution` (relationship memories update later) | Controller or qualifying shareholder; NPC | no |
| `request_introduction` | yes | `resolver/routing.applyIntroductionRequests` / `relationship_update` | Controller or qualifying shareholder; NPC | no |
| `license_node` | yes | `resolver/capital.resolveCapital → resolver/routing.routeNodeLicences` / `capital_resolution` (relationship memories update later) | CEO/controller; NPC | **yes** |
| `publish_licence_terms` | yes | `resolver/capital.resolveCapital → resolver/routing.routeNodeLicences` / `capital_resolution` (relationship memories update later) | CEO/controller; NPC | **yes** |

## Prioritized follow-up gaps / risks

**Static route gaps found:** none in the 52-type catalog after tracing indirect subsystem calls. In particular, `routeDeals` and `routeNodeLicences` are called from `resolver/capital.resolveCapital` (around lines 347–351), and government response actions are called from `GovernmentSubsystem.openOpportunities`; a search limited to `resolver/index.ts` would falsely label these orphaned.

1. **Runtime proof still needs to be run separately.** This document intentionally does not run `actionCoverage.test.ts`; the dynamic guard should be run by the implementation owner before changing routes. Its stale prose should be corrected when tests are next touched.
2. **Route naming is uneven.** Most actions use the shared `pendingOfType`/`intentsOfType` helpers, while government responses, markets, relationships and some company paths scan `pendingActions` directly. Future audits should preserve these explicit readers in an action-to-phase registry so a route cannot disappear behind a broad subsystem call.
3. **Board conversion can create a second action.** Financing, IPO, debt, acquisition, and related board matters are validated as proposals first and may enqueue a `board_execution` action after a passing vote. Inventory consumers must count both the proposal trace and the execution path.
4. **NPC defaults are finite and scenario-dependent.** “NPC can act” here is a validator/control statement, not a claim that every NPC archetype emits every type each quarter. The current default bundle behavior and any `compute_supply`/recurring supply behavior require separate scenario/runtime auditing.
5. **Action contracts versus prose are drifting.** The validator module header says “thirty-seven rules,” and the action coverage test says “forty-four kinds”; the executable contract and `RULES` table both currently enumerate 52. These comments should be treated as documentation defects, not coverage evidence.

6. **Confirmed appointment semantic bug (static trace).** `appoint_executive` validates `intent.characterId` in `packages/simulation/src/validator/rules.ts` (rule and `packages/simulation/src/validator/boardMatters.ts` conversion), but `ensureBoardProposals` in `packages/simulation/src/resolver/routing.ts` stores only the acting character as `proposedByCharacterId`; the requested candidate is present only in the proposal summary. `packages/simulation/src/boards/effects.ts` (`csuite_appointment`) then selects the CEO from `proposal.proposedByCharacterId`. Consequently a normal CEO appointment can resolve as a no-op or appoint the proposer, while a shareholder reinstatement is overloaded onto proposer identity. Existing board tests pin this behavior, and validation checks the proposal rather than the eventual target. Static consumer presence therefore does not prove correct target effect.

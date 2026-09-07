# Open-ended research

World 3 previously hid the innovation entry point behind the old map layout.
Research now exposes both custom technology proposals and exploratory experiments.

In **Research → Open-ended experiments → New experiment**, describe a question
(e.g. using spare compute to evolve a population of black-box agents), optionally
specify a method, and set cash per quarter, compute, researchers and a review
interval. By default, the team keeps investigating automatically under a separate
total cash authorisation; uncheck this for manual checkpoints. Develop the method with the live model or run the founder's own wording.
Preview and queue the mandate, then resolve the quarter as usual.

The engine records work, books cash within the existing R&D envelope accounting,
and pauses at the checkpoint. Resources are released for subsequent quarters.
Nothing assumes a breakthrough or completes a technology just because time passes.
An interrupted round records only the work it could actually fund and staff.

At the checkpoint, ongoing investigations consult the existing innovation interpreter
automatically during quarter resolution. Manual investigations can request the same
review from their card. The interpreter generates fictional
in-game findings from the mandate, recorded work and previous findings. Automatic reviews are recorded as research-agent actions and replay exactly.
Manual reviews are previewed before the founder queues them. Findings distinguish observations from
interpretation, can be negative or inconclusive, and suggest new directions.
Validated capability gains are limited to known areas and a total of 0.02 per
review, and are not applied to failed evaluations. No generated code executes.

A review may create up to three distinct, persistent hypotheses on the map. They
have engine-assessed plausibility and costs, are linked to their parent investigation,
and remain unfunded until pursued. Discovery does not require being able to afford
the eventual programme. Duplicate leads do not create extra nodes.

For ongoing investigations, the team chooses an adapted method after each review
and starts the next round within the original cash, compute and staff mandate.
Each review receives previous findings, existing branches and remaining budget.
It can continue, ask the founder for a different objective or resources, or recommend
stopping. The engine stops at the total spending limit and does not run unfunded work.
Close the investigation at any time, or override its next direction and allocation.
Manual investigations still require the founder to approve each next round. Custom hypotheses appear beneath the world-3 map.

## Compatibility and boundaries

- This uses the existing Claude integration and `/api/llm/innovation` route.
  Reviews share the existing quarter time budget, with at most two automatic
  research reviews per quarter and rotation between pending investigations.
  No new provider, credentials or database migration is required.
- With the model offline, work can run and remain paused indefinitely. No fallback
  invents findings, and waiting does not incur additional experiment spend.
- Experiments and notebooks are private to their company. Public projections omit
  notebooks even if a programme becomes public.
- Model output is schema-validated, then applied as a recorded input to deterministic
  resolution. Reviews must match the company, project, round and elapsed work.
  Duplicate and stale reviews cannot grant another effect.
- New saved fields are optional for old campaign/replay compatibility. The model
  wire schema makes those fields required-but-nullable; transport parsing removes
  only those null extension fields before canonical validation and storage.
- Experimental compute used during a quarter remains unavailable to production
  during that quarter even when the checkpoint releases its future allocation.

## Verification

`pnpm test` and `pnpm typecheck` cover the contract, model transports, simulation
and rendered interface. The experiment suite exercises checkpoints, resource loss,
cash booking, privacy, save roundtrips, continuation, stale reviews and replay.

Manual live-model acceptance: start an ongoing evolving-agent investigation with
a total spending limit. Resolve several quarters without resubmitting the question.
Check that methods adapt, distinct discoveries persist, and the budget ceiling stops
spending. Reload mid-investigation and continue. Also test manual checkpoints.
Confirm resources and findings survive and the next round reflects the previous
result. Repeat with the model unavailable: the experiment should wait at no further
experimental cost. Check the Research sheet at 390px and desktop widths.

# Industry research and production boundaries

World 3 is the current cross-industry economy. The simulation preserves World 1 and World 2 replay semantics; the web save parser supports the current save format rather than offering a general legacy-save import. World 2 product categories are frozen and are not an input source for World 3 node recipes.

## Concrete World 3 coverage

| Sector | Catalogue chain represented | Commercial outputs that can be researched and launched |
| --- | --- | --- |
| AI | materials and accelerators → models, inference and data services | model APIs, agent software, cloud capacity, enterprise applications |
| Robotics | components, sensors, actuators and control stacks → robots | industrial automation, warehouse robots, field and service robots |
| Manufacturing | feedstock, wafers, dies, packages and industrial equipment | chips, battery systems, electronics, fabrication and automated production |
| Energy | fuel, generation, storage, grid and power-electronics assets | generation, storage, grid services and contracted power |
| Logistics | vehicles, warehouse systems, routing and fleet software | freight, warehouse automation, routing platforms and logistics operations |
| Consumer | materials, devices, marketplaces and brands | devices, consumer subscriptions, commerce and retail operations |

Every World 3 line uses a typed bill of materials, one capacity bucket (`compute`, `plant`, `fleet`, `grid`, or none), labour and energy draw, a sale kind, a market cell, price elasticity and a research programme. Node-market pricing is set before production from last quarter's derived demand, so input demand intentionally reaches prices one quarter later. Production then observes capacity, input fill, quality, demand and backlog before financials book the resulting unit cost and revenue.

## Research versus launch

An innovation proposal always creates a **company thesis** first. It is descriptive: it has a mechanism, cost range, duration, dependencies and capability requirements, but cannot sell anything. A proposal with a product blueprint additionally creates an engine-authored economic node. It is still unlaunchable until the thesis's paid research project succeeds; success grants both the thesis and its exact blueprint node to the company. `launch_product` must then name both the achieved thesis and the launchable node. This prevents a persuasive description from being treated as a product.

Innovation provenance comes from the submitted action, using object identity in normal resolution and a canonical structural fingerprint after replay/reparse. The title is only presentation text and is never used to decide whose balance sheet or research rights apply.

## Custom recipes

A recipe is bounded to one through six typed inputs and an enum output stage (`material`, `component`, `subsystem`, `system`, `platform`, or `operation`). The LLM supplies ids, quantities and that bounded stage only; the engine resolves the nodes and fixes the tier, role, sector-aware capacity profile, cost, market and research range. Inputs must be lower tier. This supports a private material or component feeding later research as well as a finished offer, while keeping the DAG finite. No generated code, free-form formula, or custom action executes.

Catalogue inputs remain importable through the open market. They inherit the node's market price, which rises with modelled supply/demand and world shocks; a named supplier or self-production moves the route to a capacity-constrained line. This is intentionally a broad external-trade abstraction for unmodelled producers, so it does not claim that every commodity has a fully modelled supplier allocation or shipment schedule.

A session-created input has stronger provenance: only the company that has achieved or licensed it may use it in a later recipe. That slot is blocking, so it cannot be replaced by a fictitious external import. During the production pass, private inputs are allocated in current-quarter topological order: zero upstream capacity means zero downstream output, and each downstream stage sees the feasible output of the stage before it. This prevents a material from being reused through a private A→B→C chain. A custom material through system can occupy tiers 2–5; a platform is tier 6 and an operating offer tier 7. Inputs must always be lower tier, so a custom chain cannot cycle and cannot extend past the operation tier.

## Current limits

The economy does model capacity rationing, prices, shortages, backlog and the deliberate one-quarter derived-demand lag for active node lines. Owned accelerator hardware is a specific exception: World 2 and World 3 use named manufacturer allocation, and World 3 reserves direct hardware against the same current-quarter accelerator line that supplies anonymous node-market sales. It does not yet model universal physical inventory, ports, customs, supplier reservations, or multi-quarter delivery contracts for every catalogue commodity. Those remain explicit external-market abstractions.

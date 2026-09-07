# Review fixes

Bounded audit notes for the research-to-product and adjacent launch review.

- Optional contract extensions now preserve compatibility: only schema-optional
  null extension values are removed during transport normalization, while
  required nullable values remain preserved.
- Chat proposals are length-bounded and privacy-aware; private research does
  not become rival-visible merely because it exists.
- An accepted product-research proposal records a bounded, session-local recipe
  beside its still-unproven technology. The proposer cannot launch it until
  successful demonstration grants ownership. A recipe has a validated label,
  sector, customer segment, sale kind and at most four distinct existing
  lower-tier catalogue inputs with explicit quantities; it cannot add
  production code or overwrite the catalogue.
- Company-chat executable contracts now settle binding cash-only deals in the
  quarter after acceptance, and binding node licences on signing. A node
  licence may include bilateral cash consideration in the same atomic signing
  bundle; other proposed terms remain non-binding until supported by a contract
  action.
- Debt and deal actions retain explicit confirmation, exact approval checks and
  coupon/mandate validation.
- Product launch UI and validator use the same technology-link ownership check,
  session-aware recipe registry, prerequisites and research cost floor. An
  owned custom recipe is selectable and carries its technology link onto the
  launch ticket; an unowned rival's private recipe is absent. Foreign-sector
  options are visible but locked rather than silently offered for free.
- Slow innovation responses are invalidated when the session or draft context
  changes, preventing stale proposals from replacing newer founder input.

Deterministic regression coverage was added for product blueprints, ownership
and launch validation, alongside the existing research, privacy and schema
tests. Full-suite and build results are tracked by the orchestration run; this
note intentionally does not claim counts that have not been verified here.

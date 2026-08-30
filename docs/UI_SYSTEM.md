# UI System

The interface must not look like a chatbot with a business theme. The language
model is infrastructure behind a serious strategy interface, and the player
should mostly be unaware of it.

## 1. Aesthetic target

```text
Premium financial terminal  ×  Modern venture/startup dashboard
        ×  Corporate strategy game  ×  Living social network
```

What that means in practice:

- **Dense, legible numbers.** Tabular figures, aligned decimals, consistent
  units. A terminal earns trust by never making you squint at a number.
- **Deltas everywhere.** Almost every figure has a previous value. Show the
  change and its direction; the whole loop is quarter-over-quarter.
- **Restraint in colour.** Colour carries meaning — positive, negative, warning,
  neutral (`RESOLUTION_LINE_TONES`) — and nothing else. No decorative gradients
  behind data.
- **Explanations one click away, never in the way.** Every derived number can
  open its working: anchor inputs, return decomposition, ledger rows.
- **People have faces and histories.** Social and network surfaces are warm
  where financial surfaces are cool. A director's card shows their traits, their
  mandate and what they remember about you.

**Responsive is a requirement.** Desktop is primary, but every screen must be
usable on a tablet and readable on a phone. Wide tables scroll inside their own
container; the page body never scrolls horizontally.

## 2. The eighteen screens

### 1. Command Centre

*Quarter summary, cash, runway, valuation, alerts.* The landing screen, and the
one a returning player reads first.

```text
2031 Q2                 ORBIT INTELLIGENCE

Market Cap  $48.2B ▲4.8%     WORLD
Revenue     $2.8B  ▲11%      Policy rate       5.25%
Cash        $6.1B            AI sentiment      Bullish
Runway      34 mo            Compute supply    Tight
Employees   4,281            Regulation        Rising
Connection  77
Gov. Rating AA-              TODAY
                             ● Defence ministry opens $4.1B bid
                             ● Nexus AI model launch underperforms
                             ● Director Wong wants meeting
                             ● #OrbitLeaks trending
                             ● Frontier Map updated: 3 technologies
```

Components: `MetricTile` (value, delta, sparkline), `WorldStrip` (four world
readings chosen for this company's exposure), `AlertFeed` (from
`PlayerView.alerts`, each linking to the screen that resolves it), `QuarterClock`
(quarter label, planning-window state, submission status).

### 2. Company

*Operating structure, subsidiaries, offices.* Archetype, sector, tier, posture
and risk tolerance; the org tree including acquired subsidiaries
(`parentCompanyId`); `Office` cards with headcount capacity, cost and
utilisation; the five-audience `Reputation` radar; a `TechCapabilities` bar chart
across the twelve capability areas.

### 3. Products

*Products, pricing, customers, unit economics.* One row per `Product`: segment,
price, active customers, churn, growth, gross margin, compute intensity and
quality relative to the market frontier. A price slider previews the elasticity
response before committing. Serving-capacity headroom is shown prominently —
selling past capacity is a failure mode players must see coming.

### 4. Research / Frontier

*The generative technology graph.* See §4 below.

### 5. People

*Employees, executives, culture, compensation.* Headcount by role with fill
pipeline and attrition forecast; morale with its recent drivers; the comp band
against `world.talent.salaryPressure`; C-suite cards showing the character behind
each post; `poach_executive` approaches in flight, in both directions.

### 6. Network

*Investors, founders, officials, directors, journalists.* A filterable directory
of visible `Character`s, each showing role, connection level, the four
relationship dimensions **in both directions**, and whether contact is currently
permitted. When it is not, the card states the gap and lists the overrides that
would open it, with `request_introduction` one click away. The Industry Power
graph lives here.

### 7. Markets

*In-world exchange, ownership, reference tape.* Per the screen contract in
[MARKETS.md](./MARKETS.md) §8. The optional reference tape is a visually
distinct, clearly labelled read-only panel with no interaction affordances.

### 8. Capital

*Funding, debt, treasury, cap table.* Cap table by class with economic and voting
percentages side by side; dilution history across every round; debt schedule with
rates, terms and interest coverage; runway projection under three burn scenarios;
live `raise_round` / `issue_debt` / `ipo` attempts with their ceilings.

### 9. Boardroom

*Agenda, directors, votes, governance.* Director cards with traits, mandate,
committees, relationship with the CEO, and any live `ConditionalCommitment`
rendered in plain language ("supports below $5.5B, or with ≥35% stock"). The
agenda shows each `BoardProposal` with its required threshold and a projected
tally. Post-vote, minutes show every director's vote and rationale.

### 10. Government

*Opportunities, bids, active contracts.* Opportunity cards showing evaluation
weights as a bar and hard requirements as a pass/fail checklist against this
company. The bid composer surfaces each trade-off's cost elsewhere in the
company. Active contracts show milestone timelines, compliance burden, export
restrictions and controversy level. `ContractorReputation` sits permanently in
the header — it is an input to every future bid.

### 11. Social

*Synthetic social networks, PR, marketing.* Six network archetypes as tabs.
Composing a personal post shows the audience mix that will actually hear it
before publishing. Published posts show their computed `EngagementResult`: reach,
per-audience sentiment shifts, press pickup, virality, competitor hostility.
Structured `marketing_campaign` sits beside personal posting as the deliberate
alternative. **Every NPC-authored post carries a visible AI label.**

### 12. News

*World events and public information.* The quarter's `quarterSummary` as the
headline, then `WorldEvent`s grouped by category with severity and duration and —
critically — a **causal chain view** drawn from `causalParentId`, so a cascade
reads as one story rather than five coincidences. Public disclosures and media
stories interleave, with credibility shown.

### 13. Deal Room

*M&A, licensing, partnerships, negotiations.* Inbound and outbound
`DealProposal`s with obligations rendered term by term, binding status prominent,
and `intentStatements` visually separated under a heading that says they are not
enforceable. Source conversations are linked. Live multi-quarter obligations show
their per-quarter discharge status.

### 14. Financials

*P&L, balance sheet, cash flow, segment results.* Quarterly and trailing views,
segment revenue splits, and the balance sheet with the reconciliation check shown
as a passed assertion rather than hidden. Every line opens the ledger rows behind
it.

### 15. Leaderboard

*Session rankings and the power network.* Ten board tabs, rank movement against
last quarter, percentile alongside raw value, and the Founder Index broken into
its eight weighted components so a player can see which dimension is holding
them back.

### 16. Chief of Staff

*Conversational control interface.* See §5 below.

### 17. End Quarter

*Review actions and lock submission.* Every `SubmittedAction` grouped by the
resolution phase that will consume it, each showing its
`ActionValidationResult`: accepted, clamped (with the reduced form shown), or
rejected (with reason and code). Actions in `CONFIRMATION_REQUIRED_ACTIONS`
lacking `confirmedByHuman` are blocked here with an explicit confirm control.
Cash, compute and headcount are projected after the submitted set, so a player
sees they have committed 120% of their cash before the engine tells them.

### 18. Quarter Resolution

*Explain exactly what changed and why.* See §3.

## 3. The quarter-resolution moment

This is the emotional centre of the game loop, and mechanically it is a
rendering of the ledger.

```text
RESOLVING Q2 2031

WORLD                          MARKETS
✓ Export restriction announced ✓ Earnings surprise positive
✓ Compute price +11%           ! Regulation repricing negative

COMPETITION                    ORBIT                           +3.7%
✓ Nexus cut enterprise prices  NEXUS                           -6.4%
✓ Helix acquired VectorDB      HELIX                           +8.2%

YOUR COMPANY                   SESSION RANK
✓ Revenue +13%                 Company Value        #2 → #2
✓ Gross margin -2.1pp          Innovation           #3 → #1
✓ Government proposal shortlisted   Founder Index   #4 → #3
✓ 12 researchers hired
! Chief Scientist morale declining
```

Rules for this screen:

1. **Every line is a `ResolutionLine`** with a `phase`, `text`, an optional
   `deltaLabel`, a `tone` and `refEventIds`. **INVARIANT: every line must
   reference at least one committed ledger event.** Nothing here is narrative
   invention.
2. **Phases arrive in pipeline order**, revealed progressively. The pacing is the
   drama: world, then competition, then your company, then markets, then rank.
   The player can skip to the end, and the skip is remembered.
3. **The `!` tone (`warning`) is reserved** for something that has not gone wrong
   yet. It is the game pointing at next quarter.
4. **Every line is clickable** and opens its ledger rows. "Why did my stock
   fall?" is answered from committed facts, decomposed into the seven return
   components, never by asking a model to invent a reason.
5. **The narrator is optional colour**, rendered above the lines. Its input is
   `committedLines` and nothing else. If the model is unavailable the lines
   render directly — they are human-readable by construction.

## 4. Frontier Map rendering

The map is the most visibly generative surface, and the place where the safety
rule matters most.

```text
LLM → TechGraph JSON → schema validation (TechGraphSchema)
    → gameplay validation → Supabase (tech_nodes / tech_edges)
    → trusted React/SVG renderer → dynamic UI
```

> **No generated code executes in a client. Ever.** The model produces a typed
> `TechGraph`; trusted React and SVG render it. That is invariant
> `tech_graph_safety`.

**Layout.** Deterministic, seeded from `TechGraph.version` and node ids, so the
same graph always lays out the same way and spatial memory survives a reload.
A four-stage Sugiyama pipeline: longest-path layering, dummy slots for edges
spanning multiple layers (so no edge can route through a card), barycenter
crossing minimisation (alternating sweeps, stable tiebreaks), then a shared
row grid with right-out/left-in ports and horizontal-tangent cubics. A
geometric test pins the demo graph at zero edge crossings and zero
edge-through-node intersections — a ratchet that may tighten, never loosen.
Transitions between versions are animated so the graph visibly *rearranges*
when beliefs move — that motion is the point.

**Node encoding.** Calm white cards; state carries colour, form carries class.

| Channel | Encodes |
|---|---|
| Left accent bar + dot | `status` — the nine epistemic states (fill only for `achieved`'s soft wash) |
| Confidence bar | `publicConfidence`, with a tick marker for this company's own conviction |
| Border | dashed for `company_thesis`, `secret` and `discredited`; struck title for dead ends |
| Size | `computeIntensity` |
| Badge | `achievedByCompanyId`, plus an inventor mark for player-proposed nodes |
| Focus | hover/keyboard focus lights incident edges and 1-hop neighbours, hushes the rest |

That last row is the informational edge a research bet is made on, and it should
be immediately visible: a node the world rates at 0.31 and you rate at 0.68 is
where a thesis lives.

**Edges.** `depends` solid and directional; `unlocks` lighter; `informs` dotted.
Width encodes `strength`.

**Belief movement.** A `TechConfidenceUpdate` renders as an annotated transition,
with the causing event linked:

```text
Huge dense models              confidence 74% → 51%
Efficient sparse inference     confidence 47% → 73%
Specialised accelerator design expected 2032 → 2030
```

**Information boundary.** `confidenceByCompany` must be reduced to the viewing
player's own entry plus the public figure **before it leaves the server**
(`PlayerView.techGraph`). Sending the full record would leak every rival's
private conviction.

**Proposing a node.** The player writes the idea in their own words; the
Innovation Interpreter returns an `InnovationProposal`; the engine returns an
`InnovationIntegrationResult` with adjusted plausibility, cost and duration. The
UI shows the adjustment honestly — "you estimated $280m; we estimate $610m and
eleven quarters" — and lets the player commit or walk away.

## 5. Chief of Staff interaction contract

Three steps, always in this order, with no shortcuts:
**interpret → propose → confirm.**

**Interpret.** The player types freely. The Chief of Staff receives the message
plus company and world briefings, current budget lines, open decisions and
conversation history.

**Propose.** It returns a `ChiefOfStaffInterpretation`, which the UI renders as a
diff — old value, new value, one line per change — never as prose the player has
to parse:

```text
Interpreted instructions

Consumer marketing          $18m → $6m
Enterprise sales            $12m → $21m
Developer relations         $7m → $9m
Total quarterly spend       approximately unchanged

Recruiting mandate:  Senior infrastructure executive
Preferred sources: Helix + adjacent firms · Approach: private
Compensation ceiling: current policy +20%

No binding action has been submitted yet.
[Approve] [Edit]
```

The last line is mandatory copy. `questions` render as an inline prompt block —
asking is better than guessing. `unsupportedRequests` render plainly, because
silently dropping part of an instruction is the worst possible behaviour here.
Below `confidence` 0.7 the panel is styled as a draft.

**Confirm.** Approving queues `SubmittedAction`s with `origin: 'chief_of_staff'`
and `confirmedByHuman: true`. Editing opens the normal controls pre-filled — the
conversational path and the click path produce the same objects, and either can
finish what the other started.

### Auto-execute

Players may enable "execute routine instructions automatically"
(`SessionPlayer.autoExecuteRoutine`). It applies **only** to low-risk actions.
The thirteen types in `CONFIRMATION_REQUIRED_ACTIONS` always require an explicit
human confirmation, regardless of the preference and regardless of what the model
set `requiresConfirmation` to:

```text
raise_round · issue_debt · buyback · issue_shares · ipo · acquire_company
layoff · bid_government · submit_board_proposal · propose_deal · accept_deal
buy_shares · sell_shares
```

Financing, mergers, layoffs, stock issuance, major contracts and large spending
commitments stay explicit. The engine rejects any of them with
`confirmedByHuman: false` and the code `confirmation_required` — the preference
is a UI convenience, never an authorisation.

### Character conversations

The same contract governs talking to directors, investors, regulators and rival
CEOs. Dialogue renders as conversation; anything concrete that emerges renders as
a **structured card**:

```text
Sarah Zhou — Independent Director

"At $6.4 billion I don't support it. Their enterprise retention is
deteriorating and you're paying for projected synergies."

┌─ Conditional commitment recorded ──────────────────────┐
│ Will SUPPORT acquisition if:                           │
│   purchase price   ≤ $5.5B                             │
│   stock component  ≥ 35%                               │
│ Commitment strength  0.86        Expires  2031 Q4      │
└────────────────────────────────────────────────────────┘
```

The support score is engine state throughout. The conversation created a testable
promise; it did not change reality. The UI must make that legible — persuading a
character means *getting a commitment*, not *talking a number up*.

## 6. Cross-cutting components

| Component | Contract |
|---|---|
| `MetricTile` | Value, unit, delta, direction, optional sparkline, click-through to its working |
| `LedgerLink` | Any figure derived from events links to the `SimEvent` rows behind it |
| `AiLabel` | Applied to every NPC-authored message, post and reply, without exception |
| `AccessBadge` | On any character surface: reachable, reachable via override, or gap-blocked with the gap shown |
| `ValidationBanner` | Renders `ActionValidationResult`: accepted, clamped (with the reduced form), rejected (reason + code) |
| `ConfirmGate` | Wraps every `CONFIRMATION_REQUIRED_ACTIONS` control; cannot be satisfied programmatically |
| `TruthBoundary` | Dev-mode assertion that a component never received a field marked INTERNAL |

## 7. Rules the interface may not break

1. **The client is never authoritative.** Every control submits an intent; the
   server validates, clamps and resolves. A disabled button is a courtesy, not a
   rule.
2. **No generated markup or code is rendered.** Generative surfaces render typed
   data through trusted components.
3. **Private fields never reach a client.** `PublicDisclosure.isTruthful`, other
   companies' `confidenceByCompany`, rival secret projects, raw agent output. The
   projection is `PlayerView`, not `SessionState`.
4. **NPCs are always labelled** — in conversations, the social feed, the deal
   room and the boardroom.
5. **Nothing on the Quarter Resolution screen lacks a ledger reference.**
6. **No screen invents a number.** If a figure is not in state or derived from
   state by documented code, it does not render.

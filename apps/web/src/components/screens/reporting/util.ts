/**
 * Shared derivations for the money-and-reporting cluster.
 *
 * Command Centre, Financials, Markets, Capital, Leaderboard and News all read
 * the same five or six things out of state, and they must read them the same
 * way. Every function here is pure, deterministic and derives only from
 * committed state — no screen in this cluster invents a number, and neither
 * does this file.
 *
 * The information boundary is respected at the call site: anything about
 * another company is looked up through `PlayerView`, never through
 * `SessionState.companies`.
 */

import type {
  ActiveModifier,
  BalanceSheet,
  CapTable,
  Company,
  CompanyFundamentals,
  DominantNarrative,
  Financials,
  MarketInstrument,
  PlayerView,
  PublicDisclosure,
  Quote,
  ResolutionLine,
  ResolutionPhase,
  ResolutionReport,
  SessionState,
  SimulationInvariant,
  ValuationAnchor,
} from '@frontier/contracts';
import {
  DOMINANT_NARRATIVES,
  LEADERBOARD_BOARDS,
  RESOLUTION_PHASES,
  SECTOR_IDS,
  SIMULATION_INVARIANTS,
  SIM_EVENT_TYPES,
  WORLD_EVENT_TYPES,
  balanceSheetReconciles,
  getTargetPathSpec,
  ownershipThresholdFor,
  quarterLabel,
  targetPathEntityId,
  type OwnershipThreshold,
} from '@frontier/contracts';
import { formatCount as groupCount, formatMoney, formatPct, formatScore } from '@frontier/shared';
import { isNewEntrant, perSharePriceOf } from '@frontier/simulation';
import { quotesFor } from '@/lib/game';

/* -------------------------------------------------------------------------- */
/*  Small text helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The badge a company founded mid-session wears for its first four quarters, or
 * null for everybody else.
 *
 * The window is the engine's (`NEW_ENTRANT_QUARTERS`), not the screen's: market
 * entry decides who is new and for how long, and this only spells it. A rival
 * whose `foundedQuarter` is redacted away carries no badge rather than a guess.
 */
export function newEntrantLabel(company: Pick<Partial<Company>, 'foundedQuarter'>, quarter: number, startYear: number): string | null {
  const founded = company.foundedQuarter;
  if (founded === undefined) return null;
  if (!isNewEntrant({ foundedQuarter: founded }, quarter)) return null;
  return `New · ${quarterLabel(startYear, founded)}`;
}

/** `enterprise_ai` becomes `Enterprise ai`. Renders an id; never invents a fact. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  if (spaced.length === 0) return value;
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/** Title-cases every word: `fund_al_bahr` → `Al Bahr` once the prefix is dropped. */
export function titleise(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/**
 * Group an integer count with ASCII separators: `12000000` → `12,000,000`.
 *
 * Now lives in `@frontier/shared` beside the money and percentage formatters;
 * re-exported here so the reporting cluster keeps one import path.
 */
export { formatCount } from '@frontier/shared';

/**
 * A five-band label for a 0..1 world reading.
 *
 * The bands are fixed and the labels are supplied by the caller, so the same
 * number always reads the same way on every screen.
 */
export function bandLabel(value: number, labels: readonly [string, string, string, string, string]): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.2) return labels[0];
  if (value < 0.4) return labels[1];
  if (value < 0.6) return labels[2];
  if (value < 0.8) return labels[3];
  return labels[4];
}

/* -------------------------------------------------------------------------- */
/*  Player-facing text: no raw token reaches the player                        */
/* -------------------------------------------------------------------------- */

/**
 * Curated labels for the resolution pipeline's phase ids. Generic `humanise`
 * would render `product_demand_resolution` as "Product demand resolution",
 * which is accurate and clumsy; every phase gets a short label here instead,
 * and any phase the contract adds later still falls back to `humanise` rather
 * than disappearing.
 */
const RESOLUTION_PHASE_LABEL: Readonly<Record<ResolutionPhase, string>> = {
  world_events: 'World events',
  gm_modifiers: 'World modifiers',
  information_reveal: 'Information reveal',
  action_collection: 'Actions collected',
  board_resolution: 'Board decisions',
  capital_resolution: 'Capital moves',
  government_resolution: 'Government',
  talent_resolution: 'Talent',
  research_resolution: 'Research',
  product_demand_resolution: 'Product demand',
  financial_resolution: 'Financials',
  disclosure_resolution: 'Disclosures',
  market_resolution: 'Markets',
  social_resolution: 'Social',
  relationship_update: 'Relationships',
  leaderboard_update: 'Leaderboard',
  ledger_commit: 'Ledger commit',
  snapshot: 'Snapshot',
};

/**
 * The plain label for a resolution phase id. Never the raw phase key.
 *
 * Takes `string` rather than `ResolutionPhase`: `EnginePhaseTiming.phase` is a
 * diagnostics field typed loosely (it can carry a sub-phase the eighteen-entry
 * contract enum does not name), and every caller — a `ResolutionLine.phase` or
 * a phase timing — should read the same table without a cast at the call site.
 * Anything not in the table still gets a plain word via `humanise`.
 */
export function phaseLabel(phase: string): string {
  return (RESOLUTION_PHASE_LABEL as Readonly<Record<string, string>>)[phase] ?? humanise(phase);
}

/** Curated labels for the simulation invariants — `humanise` alone mangles the acronyms and mislabels one. */
const SIMULATION_INVARIANT_LABEL: Readonly<Record<SimulationInvariant, string>> = {
  deterministic_replay: 'Deterministic replay',
  financial_integrity: 'Financial integrity',
  ownership_integrity: 'Ownership integrity',
  market_integrity: 'Market integrity',
  llm_containment: 'Model containment',
  idempotency: 'Idempotency',
  information_boundary: 'Information boundary',
  authoritative_backend: 'Authoritative backend',
  // Not the US benefits programme: who may read a restricted conversation.
  social_security: 'Social access control',
  auditability: 'Auditability',
  tech_graph_safety: 'Tech graph safety',
  agent_reproducibility: 'Model reproducibility',
  failure_mode: 'Failure mode',
  capital_integrity: 'Capital integrity',
};

/** The plain label for a simulation invariant id. Never the raw invariant key. */
export function invariantLabel(invariant: SimulationInvariant): string {
  return SIMULATION_INVARIANT_LABEL[invariant] ?? humanise(invariant);
}

/** Curated labels for the press's dominant narrative — matches the map overlay's wording. */
const DOMINANT_NARRATIVE_LABEL: Readonly<Record<DominantNarrative, string>> = {
  ai_optimism: 'AI optimism',
  productivity_miracle: 'Productivity miracle',
  bubble_concern: 'Bubble concern',
  safety_alarm: 'Safety alarm',
  labour_disruption: 'Labour disruption',
  concentration_backlash: 'Concentration backlash',
  geopolitical_race: 'Geopolitical race',
  energy_backlash: 'Energy backlash',
  scandal_cycle: 'Scandal cycle',
  neutral: 'No dominant story',
};

/** The plain label for the press's dominant narrative. Never the raw enum value. */
export function narrativeLabel(value: DominantNarrative): string {
  return DOMINANT_NARRATIVE_LABEL[value] ?? humanise(value);
}

/**
 * The human label the modifier registry already carries for a target path.
 *
 * A fixed path (`world.compute.spotPrice`) reads as the registry's own
 * one-line description — it is already plain English, written for exactly
 * this purpose. A pattern path (`company.<id>.reputationPublic`,
 * `sector.<id>.sentiment`) is prefixed with the company or sector it names, so
 * "reputationPublic" never reaches the player as a bare metric key.
 */
export function targetPathLabel(path: string, session: SessionState): string {
  const spec = getTargetPathSpec(path);
  const entity = targetPathEntityId(path);
  if (entity === null) return spec?.description ?? humanise(path.split('.').pop() ?? path);
  const subject =
    entity.entity === 'company'
      ? (session.companies.find((company) => company.id === entity.id)?.name ?? titleise(entity.id.replace(/^cmp_/, '')))
      : titleise(entity.id);
  return `${subject} — ${spec?.description ?? humanise(entity.metric)}`;
}

/**
 * Active modifiers one seat may see.
 *
 * A world-wide or sector-wide modifier is public by construction — it is the
 * world moving, and every player is standing in the same world. A modifier
 * that names a specific company is visible only when it names one of this
 * seat's own companies: a modifier privately nudging a rival's attrition rate
 * or cost multiplier is exactly the kind of fact the information boundary
 * keeps off this seat's screen until the rival, or some other event, makes it
 * public. This mirrors `eventConsequence`'s own ranking in
 * `@frontier/simulation`'s public-record projection, restated here because
 * this list — the whole roster of active modifiers — is not itself projected
 * anywhere the way `PlayerView` projects companies and disclosures.
 */
export function visibleActiveModifiers(modifiers: readonly ActiveModifier[], ownCompanyIds: ReadonlySet<string>): readonly ActiveModifier[] {
  return modifiers.filter((modifier) => {
    const entity = targetPathEntityId(modifier.target);
    if (entity === null || entity.entity !== 'company') return true;
    return ownCompanyIds.has(entity.id);
  });
}

/**
 * Every enum token the resolution and news screens are known to embed in
 * prose, mapped to its plain label. Built once from the contracts themselves,
 * so a value appended to any of these unions is covered automatically.
 */
const KNOWN_TOKEN_LABEL: ReadonlyMap<string, string> = new Map<string, string>([
  ...RESOLUTION_PHASES.map((phase) => [phase, phaseLabel(phase)] as const),
  ...SIMULATION_INVARIANTS.map((invariant) => [invariant, invariantLabel(invariant)] as const),
  ...DOMINANT_NARRATIVES.map((value) => [value, narrativeLabel(value)] as const),
  ...SECTOR_IDS.map((id) => [id, titleise(id)] as const),
  ...WORLD_EVENT_TYPES.map((type) => [type, humanise(type)] as const),
  ...SIM_EVENT_TYPES.map((type) => [type, humanise(type)] as const),
  ...LEADERBOARD_BOARDS.map((board) => [board, humanise(board)] as const),
]);

/** Anything left that still looks like `some_snake_case_token`. */
const SNAKE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Strip every raw identifier out of one piece of player-facing prose.
 *
 * The resolution report and the public feed are both built by the engine
 * interpolating live values into template sentences — "shifted from
 * `ai_optimism` to `energy_backlash`", a company id used as a name-lookup
 * fallback — and a screen cannot always reach the call site that wrote the raw
 * value. This runs after the fact, on the finished sentence:
 *
 * 1. A company or character id in `session` becomes its name (longest id
 *    first, so one id cannot be half-replaced by a shorter id that is a
 *    prefix of it).
 * 2. A known enum value (a phase, a narrative, a sector id, an event type...)
 *    becomes its plain label.
 * 3. Anything left that still matches `snake_case` — a token neither table
 *    above knows, from a source this screen does not control — is humanised
 *    on the spot rather than shown raw. This backstop is what the "no
 *    snake_case token reaches the player" test relies on: a value can be
 *    absent from every table above and the player still never sees it as
 *    written.
 *
 * Pure: the same text and the same session delint the same way every time.
 */
export function delintText(text: string, session: SessionState): string {
  let out = text;

  const ids = [
    ...session.companies.map((entry) => ({ id: entry.id, name: entry.name })),
    ...session.characters.map((entry) => ({ id: entry.id, name: entry.name })),
  ]
    .filter((entry) => out.includes(entry.id))
    .sort((a, b) => b.id.length - a.id.length);
  for (const entry of ids) out = out.split(entry.id).join(entry.name);

  return out.replace(SNAKE_TOKEN_RE, (token) => KNOWN_TOKEN_LABEL.get(token) ?? humanise(token));
}

/** `delintText`, applied to every player-facing string one resolution line carries. */
function delintLine(line: ResolutionLine, session: SessionState): ResolutionLine {
  return {
    ...line,
    text: delintText(line.text, session),
    deltaLabel: line.deltaLabel === null ? null : delintText(line.deltaLabel, session),
  };
}

/**
 * `delintText`, applied to a whole resolution report: the headline and every
 * line of every phase. Grouping and linking are untouched — `phase`,
 * `subjectId`, `refEventIds` and `tone` carry the meaning the screen sorts and
 * links on, and none of them are prose.
 */
export function delintReport(report: ResolutionReport, session: SessionState): ResolutionReport {
  return {
    ...report,
    headline: delintText(report.headline, session),
    phases: report.phases.map((phase) => ({ ...phase, lines: phase.lines.map((line) => delintLine(line, session)) })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Income statement                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The quarterly profit and loss, derived from `Financials` by the arithmetic
 * `ProfitAndLoss` documents.
 *
 * Tax is not modelled by the engine, so the bottom line is stated as pre-tax
 * rather than dressed up as net income.
 */
export interface IncomeStatement {
  readonly revenue: number;
  readonly cogs: number;
  readonly grossProfit: number;
  readonly grossMarginPct: number;
  readonly payroll: number;
  readonly marketing: number;
  readonly rdSpend: number;
  readonly operatingExpenses: number;
  readonly operatingIncome: number;
  readonly operatingMarginPct: number;
  readonly interestExpense: number;
  readonly preTaxIncome: number;
  readonly preTaxMarginPct: number;
  readonly capex: number;
  readonly quarterlyBurn: number;
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

export function incomeStatementOf(financials: Financials): IncomeStatement {
  const grossProfit = financials.revenueQuarterly - financials.cogs;
  const operatingExpenses = financials.payroll + financials.marketing + financials.rdSpend;
  const operatingIncome = grossProfit - operatingExpenses;
  const preTaxIncome = operatingIncome - financials.interestExpense;
  return {
    revenue: financials.revenueQuarterly,
    cogs: financials.cogs,
    grossProfit,
    grossMarginPct: ratio(grossProfit, financials.revenueQuarterly),
    payroll: financials.payroll,
    marketing: financials.marketing,
    rdSpend: financials.rdSpend,
    operatingExpenses,
    operatingIncome,
    operatingMarginPct: ratio(operatingIncome, financials.revenueQuarterly),
    interestExpense: financials.interestExpense,
    preTaxIncome,
    preTaxMarginPct: ratio(preTaxIncome, financials.revenueQuarterly),
    capex: financials.capex,
    quarterlyBurn: financials.quarterlyBurn,
  };
}

/* -------------------------------------------------------------------------- */
/*  Balance sheet                                                              */
/* -------------------------------------------------------------------------- */

export interface BalanceSheetView {
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  readonly equity: number;
  /** assets − liabilities − equity. The invariant holds when this is within $1. */
  readonly discrepancy: number;
  readonly reconciles: boolean;
}

export function balanceSheetView(sheet: BalanceSheet): BalanceSheetView {
  const totalAssets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
  const totalLiabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
  return {
    totalAssets,
    totalLiabilities,
    equity: sheet.equity,
    discrepancy: totalAssets - totalLiabilities - sheet.equity,
    reconciles: balanceSheetReconciles(sheet),
  };
}

/* -------------------------------------------------------------------------- */
/*  Identity lookups that respect the boundary                                 */
/* -------------------------------------------------------------------------- */

/** Display name for a company id, from the projection the player may read. */
export function companyNameOf(view: PlayerView, companyId: string | null): string {
  if (companyId === null) return '—';
  if (companyId === view.ownCompany.id) return view.ownCompany.name;
  const rival = view.visibleCompanies.find((entry) => entry.id === companyId);
  return rival?.name ?? companyId;
}

/** Ticker for a company id where one is public, or null. */
export function tickerOf(view: PlayerView, companyId: string | null): string | null {
  if (companyId === null) return null;
  if (companyId === view.ownCompany.id) return view.ownCompany.ticker;
  return view.visibleCompanies.find((entry) => entry.id === companyId)?.ticker ?? null;
}

/**
 * The company record a player may read for one id: their own in full, a rival
 * as the redacted projection, `null` for anything not on the register.
 *
 * Every screen that wants a rival's sector, region or filed fundamentals goes
 * through here rather than through `SessionState.companies`.
 */
export function companyOf(view: PlayerView, companyId: string | null): Partial<Company> | null {
  if (companyId === null) return null;
  if (companyId === view.ownCompany.id) return view.ownCompany;
  return view.visibleCompanies.find((entry) => entry.id === companyId) ?? null;
}

/**
 * Every company on the register, the player's own first.
 *
 * The order is the player, then rivals by id, so a list built from it is stable
 * across quarters — a rival that grew does not jump the queue.
 */
export function allVisibleCompanies(view: PlayerView): readonly Partial<Company>[] {
  return [view.ownCompany, ...[...view.visibleCompanies].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))];
}

/**
 * Display label for a cap-table holder.
 *
 * Characters and companies resolve to their names; an institutional bloc
 * resolves to a rendering of its own id rather than a name we made up; the
 * anonymous remainder is exactly that.
 */
export function holderLabel(session: SessionState, holderId: string, holderKind: string): string {
  if (holderKind === 'public_float') return 'Public float';
  if (holderKind === 'character' || holderKind === 'player') {
    const character = session.characters.find((entry) => entry.id === holderId);
    if (character !== undefined) return character.name;
    const player = session.players.find((entry) => entry.playerId === holderId);
    if (player !== undefined) return player.displayName;
  }
  if (holderKind === 'company') {
    const company = session.companies.find((entry) => entry.id === holderId);
    if (company !== undefined) return company.name;
  }
  if (holderKind === 'fund') return `${titleise(holderId.replace(/^fund_/, ''))} (fund)`;
  return titleise(holderId.replace(/^(fund|float|hld)_/, ''));
}

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

export interface OwnershipRow {
  readonly holdingId: string;
  readonly holderId: string;
  readonly holderKind: string;
  readonly label: string;
  readonly shareClassId: string;
  readonly shareClassLabel: string;
  readonly securityId: string;
  readonly shares: number;
  readonly costBasisUsd: number;
  /** Share of issued equity across every class. */
  readonly economicPct: number;
  /** Share of total votes, which diverges wherever super-voting stock exists. */
  readonly votingPct: number;
  /** Share of the fully diluted count, option pool included. */
  readonly fullyDilutedPct: number;
  readonly threshold: OwnershipThreshold | null;
  readonly isDisclosed: boolean;
  readonly lockupUntilQuarter: number | null;
}

/** Every position in one cap table, ordered by economic size, then by holder id. */
export function capTableRows(session: SessionState, table: CapTable): OwnershipRow[] {
  const classById = new Map(table.shareClasses.map((entry) => [entry.id, entry]));
  const securityById = new Map(session.securities.map((entry) => [entry.id, entry]));
  const issuedTotal = table.shareClasses.reduce((total, entry) => total + entry.issuedShares, 0);
  const votesTotal = table.shareClasses.reduce((total, entry) => total + entry.issuedShares * entry.votesPerShare, 0);

  const rows = table.holdings.map((holding) => {
    const security = securityById.get(holding.securityId) ?? null;
    const shareClass = security === null ? null : classById.get(security.shareClassId) ?? null;
    const votesPerShare = shareClass?.votesPerShare ?? 1;
    const economicPct = issuedTotal === 0 ? 0 : holding.shares / issuedTotal;
    return {
      holdingId: holding.id,
      holderId: holding.holderId,
      holderKind: holding.holderKind,
      label: holderLabel(session, holding.holderId, holding.holderKind),
      shareClassId: shareClass?.id ?? '—',
      shareClassLabel: shareClass?.label ?? 'Unclassified',
      securityId: holding.securityId,
      shares: holding.shares,
      costBasisUsd: holding.costBasisUsd,
      economicPct,
      votingPct: votesTotal === 0 ? 0 : (holding.shares * votesPerShare) / votesTotal,
      fullyDilutedPct: table.fullyDilutedShares === 0 ? 0 : holding.shares / table.fullyDilutedShares,
      threshold: ownershipThresholdFor(economicPct),
      isDisclosed: holding.isDisclosed,
      lockupUntilQuarter: holding.lockupUntilQuarter,
    } satisfies OwnershipRow;
  });

  return rows.sort((a, b) => (b.economicPct !== a.economicPct ? b.economicPct - a.economicPct : a.holderId.localeCompare(b.holderId)));
}

/** Issued shares across every class of one cap table. */
export function issuedSharesOf(table: CapTable): number {
  return table.shareClasses.reduce((total, entry) => total + entry.issuedShares, 0);
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                    */
/* -------------------------------------------------------------------------- */

export interface PerSharePrice {
  readonly value: number;
  /** `quote` when the company is listed, `anchor` when it is not, `none` when neither exists. */
  readonly basis: 'quote' | 'anchor' | 'none';
}

/**
 * Price per share: the last traded price when the company is listed, the
 * fundamental anchor's per-share value when it is not.
 *
 * Delegated to the engine, which is where the portfolio projection reads it
 * from. Two copies of "what is one share worth" is exactly the kind of second
 * computation a screen must not own: they would agree until the day the anchor
 * fallback changed in one of them.
 */
export function perSharePrice(session: SessionState, companyId: string): PerSharePrice {
  return perSharePriceOf(session, companyId);
}

/** The valuation anchor for a company, or null. */
export function anchorOf(session: SessionState, companyId: string): ValuationAnchor | null {
  return session.valuationAnchors.find((entry) => entry.companyId === companyId) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Instruments                                                                */
/* -------------------------------------------------------------------------- */

export interface InstrumentRow {
  readonly instrument: MarketInstrument;
  readonly quote: Quote | null;
  readonly history: readonly number[];
  readonly companyName: string;
  readonly anchorValueUsd: number | null;
  readonly anchorPerShareUsd: number | null;
  /** (price − anchor per share) / anchor per share, or null when there is no anchor. */
  readonly premiumToAnchor: number | null;
  /**
   * The company behind the instrument, as the player may read it. `null` for an
   * index, which stands for a basket rather than for a business.
   */
  readonly company: Partial<Company> | null;
  /**
   * Trailing revenue, growth, margin and share count — but only where they are
   * public. A listed company files them; the player's own company is their own
   * business; a private rival's are absent, not redacted.
   */
  readonly fundamentals: CompanyFundamentals | null;
  /** Market capitalisation over trailing revenue, or null without both. */
  readonly revenueMultiple: number | null;
}

/**
 * The exchange tape: one row per in-world instrument, with its rolling history
 * and the anchor it is trading against.
 *
 * Anchors are attached only where they are public knowledge — a listed
 * company's anchor is derived from what it files, and the player's own company
 * is their own business. A private rival's anchor is not shown.
 */
export function instrumentRows(session: SessionState, view: PlayerView, includeReference = false): InstrumentRow[] {
  return session.marketInstruments
    .filter((instrument) => (includeReference ? true : !instrument.isReference))
    .map((instrument) => {
      const quotes = quotesFor(session, instrument.id);
      const quote = quotes.length === 0 ? null : quotes[quotes.length - 1] ?? null;
      const companyId = instrument.companyId;
      const listed = companyId === null ? false : companyId === view.ownCompany.id || isListedRival(view, companyId);
      const anchor = companyId === null || !listed ? null : anchorOf(session, companyId);
      const anchorPerShare = anchor?.perShareValueUsd ?? null;
      const company = companyOf(view, companyId);
      // The projection already withholds a private rival's fundamentals, so
      // reading them straight off it needs no second gate here.
      const fundamentals = company?.fundamentals ?? null;
      const revenue = fundamentals?.revenueTtmUsd ?? 0;
      return {
        instrument,
        quote,
        history: quotes.map((entry) => entry.price),
        companyName: companyId === null ? instrument.name : companyNameOf(view, companyId),
        anchorValueUsd: anchor?.anchorValueUsd ?? null,
        anchorPerShareUsd: anchorPerShare,
        premiumToAnchor:
          quote === null || anchorPerShare === null || anchorPerShare <= 0 ? null : quote.price / anchorPerShare - 1,
        company,
        fundamentals,
        revenueMultiple: quote === null || revenue <= 0 ? null : quote.marketCapUsd / revenue,
      } satisfies InstrumentRow;
    })
    .sort((a, b) => (b.quote?.marketCapUsd ?? 0) - (a.quote?.marketCapUsd ?? 0));
}

function isListedRival(view: PlayerView, companyId: string): boolean {
  const rival = view.visibleCompanies.find((entry) => entry.id === companyId);
  return rival?.isPublic === true;
}

/* -------------------------------------------------------------------------- */
/*  Valuation anchor inputs                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How each anchor input is written down.
 *
 * `ValuationAnchor.inputs` is an open bag of numbers, and the anchor gained
 * three of them with the fundamentals method — a sector revenue multiple, a
 * quality score and the fundamental value itself. A blanket "big numbers are
 * money, small numbers are percentages" rule renders a 28× multiple as 2,800%,
 * so the units are declared per key instead, and an unknown key falls back to
 * the old heuristic rather than disappearing.
 */
const ANCHOR_INPUT_UNITS: Readonly<Record<string, { readonly label: string; readonly unit: 'money' | 'percent' | 'multiple' | 'score' }>> = {
  forwardRevenue: { label: 'Forward revenue', unit: 'money' },
  grossMargin: { label: 'Gross margin', unit: 'percent' },
  cash: { label: 'Cash', unit: 'money' },
  debt: { label: 'Debt', unit: 'money' },
  fundamentalValueUsd: { label: 'Fundamental value', unit: 'money' },
  sectorRevenueMultiple: { label: 'Sector revenue multiple', unit: 'multiple' },
  qualityScore: { label: 'Quality score', unit: 'score' },
};

export interface AnchorInputRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * The anchor's working, in a fixed order: the declared inputs first, in the
 * order they are documented above, then anything the engine has since added.
 */
export function anchorInputRows(anchor: ValuationAnchor): readonly AnchorInputRow[] {
  const known = Object.keys(ANCHOR_INPUT_UNITS).filter((key) => anchor.inputs[key] !== undefined);
  const extra = Object.keys(anchor.inputs)
    .filter((key) => ANCHOR_INPUT_UNITS[key] === undefined)
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...extra].map((key) => {
    const value = anchor.inputs[key] ?? 0;
    const spec = ANCHOR_INPUT_UNITS[key];
    if (spec === undefined) {
      return { key, label: humanise(key), value: Math.abs(value) >= 1000 ? formatMoney(value) : formatPct(value) };
    }
    const rendered =
      spec.unit === 'money'
        ? formatMoney(value)
        : spec.unit === 'percent'
          ? formatPct(value)
          : spec.unit === 'multiple'
            ? `${groupCount(value)}x`
            : formatScore(value * 100);
    return { key, label: spec.label, value: rendered };
  });
}

/* -------------------------------------------------------------------------- */
/*  Disclosures                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Public disclosures for one company, newest first.
 *
 * `isTruthful` is INTERNAL and is never read here, never returned and never
 * branched on.
 */
export function disclosuresFor(view: PlayerView, companyId: string | null): PublicDisclosure[] {
  return view.disclosures
    .filter((entry) => (companyId === null ? true : entry.companyId === companyId))
    .slice()
    .sort((a, b) => (b.quarter !== a.quarter ? b.quarter - a.quarter : a.id.localeCompare(b.id)));
}

/** Earnings filings for one company, oldest first — the only per-quarter history state keeps. */
export function earningsHistory(view: PlayerView, companyId: string): PublicDisclosure[] {
  return view.disclosures
    .filter((entry) => entry.companyId === companyId && entry.kind === 'earnings')
    .slice()
    .sort((a, b) => a.quarter - b.quarter);
}

/** A named numeric metric from a disclosure, or null when it was not asserted. */
export function disclosedMetric(disclosure: PublicDisclosure, key: string): number | null {
  const value = disclosure.metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/*  Company shorthand                                                          */
/* -------------------------------------------------------------------------- */

/** Total headcount across the five staff roles. */
export function headcountOf(company: Company): number {
  const e = company.employees;
  return e.engineers + e.researchers + e.sales + e.ops + e.execs;
}

/**
 * @frontier/simulation — resolver/disclosure.ts
 *
 * The twelfth phase: the only bridge from canonical private reality to public
 * information.
 *
 * This is where the game's central separation is enforced in code. The engine
 * knows a programme is two quarters late, 31% over budget and running at 42%
 * internal confidence. The *market* knows what was disclosed. Nothing crosses
 * except through this phase, and this phase publishes only what its source is
 * entitled to publish:
 *
 * - a listed company reports its quarter, because listed companies report;
 * - a private company reports nothing at all;
 * - a **secret** research programme produces no disclosure of any kind, which is
 *   why a secret setback damages internal research and leaves the share price
 *   untouched until it leaks;
 * - guidance is recorded with an `isTruthful` flag the client never sees, so a
 *   denial that later proves misleading can be punished two quarters later. The
 *   flag lives on the disclosure row of canonical state and on a **private**
 *   ledger row; it is never written into a public payload, because a public
 *   payload is exactly the thing every reader is entitled to read, and a row
 *   saying "that statement was a lie" is the one fact the liar's rivals must
 *   have to earn. `social/reach.ts` keeps the same rule for posts.
 *
 * The phase also settles the previous quarters' promises: guidance whose target
 * quarter has arrived is compared against what actually happened, and management
 * credibility moves in both directions — up a little for meeting it, down
 * several times as far for missing it.
 */

import type { Company, GuidanceMetric, PublicDisclosure, ResolverContext, SessionState } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { pendingOfType } from './actions';

/** Credibility gained for meeting guidance, on the 0..1 scale. */
export const GUIDANCE_BEAT_CREDIT = 3;
/** Credibility lost for missing it. Several times the gain, deliberately. */
export const GUIDANCE_MISS_PENALTY = 9;
/**
 * How far a guided number may sit from the engine's own projection and still
 * count as an honest statement *at the time it was made*. Wide on purpose:
 * guiding optimistically is not lying, and this flag exists to catch the company
 * that guides against what it privately knows.
 */
export const GUIDANCE_TRUTH_TOLERANCE = 0.25;

/**
 * How far short of its own guidance a company may land and still be said to
 * have met it. Narrow on purpose: this is the market's judgement, not a
 * charitable reading, and missing it costs several times what meeting it pays.
 */
export const GUIDANCE_MET_TOLERANCE = 0.02;

/* -------------------------------------------------------------------------- */
/*  The phase                                                                  */
/* -------------------------------------------------------------------------- */

export function resolveDisclosures(draft: SessionState, ctx: ResolverContext): void {
  evaluateStandingGuidance(draft, ctx);
  publishEarnings(draft, ctx);
  publishGuidance(draft, ctx);
  publishResearchResults(draft, ctx);
  publishCrisisResponses(draft, ctx);
}

/* ------------------------------- earnings --------------------------------- */

function publishEarnings(draft: SessionState, ctx: ResolverContext): void {
  for (const company of orderedCompanies(draft)) {
    // A private company discloses nothing. This is the information boundary,
    // and it is a one-line rule on purpose.
    if (!company.isPublic || !company.isActive) continue;

    const id = makeId('dsc', company.id, draft.quarter, 'earnings');
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const revenue = company.financials.revenueQuarterly;
    const grossMargin = revenue > 0 ? (revenue - company.financials.cogs) / revenue : 0;
    const operatingIncome = operatingIncomeOf(company);

    const disclosure: PublicDisclosure = {
      id,
      companyId: company.id,
      quarter: draft.quarter,
      kind: 'earnings',
      headline: `${company.name} reports ${compactUsd(revenue)} of quarterly revenue`,
      body: `${company.name} reported revenue of ${compactUsd(revenue)} at a ${(grossMargin * 100).toFixed(1)}% gross margin, with operating ${
        operatingIncome >= 0 ? 'income' : 'loss'
      } of ${compactUsd(Math.abs(operatingIncome))} and ${compactUsd(company.financials.cash)} of cash on the balance sheet.`,
      metrics: {
        revenue: round(revenue, 2),
        grossMargin: round(grossMargin, 4),
        operatingIncome: round(operatingIncome, 2),
        cash: round(company.financials.cash, 2),
        debt: round(company.financials.debt, 2),
      },
      credibility: clamp01(0.55 + 0.4 * (company.reputation.investor / 100)),
      sourceCharacterId: company.ceoCharacterId,
      // Reported figures are the resolved figures: an earnings release is true
      // by construction. Guidance is where a company can mislead.
      isTruthful: true,
      beliefTopic: null,
    };
    draft.disclosures.push(disclosure);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'disclosure_published',
      actorId: company.id,
      targetId: disclosure.id,
      payload: { kind: 'earnings', metrics: disclosure.metrics, credibility: round(disclosure.credibility, 3) },
      visibility: 'public',
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${company.name} reported ${compactUsd(revenue)} of revenue at a ${(grossMargin * 100).toFixed(1)}% gross margin.`,
      deltaLabel: operatingIncome >= 0 ? `+${compactUsd(operatingIncome)} op` : `-${compactUsd(Math.abs(operatingIncome))} op`,
      refEventIds: [eventId],
      tone: operatingIncome >= 0 ? 'positive' : 'neutral',
      subjectId: company.id,
    });
  }
}

/* ------------------------------- guidance --------------------------------- */

function publishGuidance(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'give_guidance')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    if (company === undefined || !company.isPublic) continue;

    const id = makeId('dsc', company.id, draft.quarter, 'guidance', intent.metric, String(intent.quarter));
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const projected = projectMetric(draft, company, intent.metric);
    const truthful = isConsistentWithReality(intent.metric, intent.value, projected);

    const disclosure: PublicDisclosure = {
      id,
      companyId: company.id,
      quarter: draft.quarter,
      kind: 'guidance',
      headline: `${company.name} guides ${intent.metric.replace(/_/g, ' ')} for quarter ${intent.quarter}`,
      body: `${company.name} told investors to expect ${describeGuidance(intent.metric, intent.value)} in quarter ${intent.quarter}.`,
      metrics: { [intent.metric]: round(intent.value, 4), targetQuarter: intent.quarter },
      credibility: clamp01(0.4 + 0.6 * (company.reputation.investor / 100)),
      sourceCharacterId: action.actorCharacterId,
      // INTERNAL ONLY. Whether the statement matched reality when it was made.
      isTruthful: truthful,
      beliefTopic: beliefTopicFor(intent.metric),
    };
    draft.disclosures.push(disclosure);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'disclosure_published',
      actorId: company.id,
      targetId: disclosure.id,
      payload: {
        kind: 'guidance',
        metric: intent.metric,
        value: round(intent.value, 4),
        targetQuarter: intent.quarter,
      },
      visibility: 'public',
    });
    // What the company privately knew when it said that, on its own row.
    recordTruthAssessment(draft, ctx, company.id, disclosure.id, {
      kind: 'guidance',
      metric: intent.metric,
      value: round(intent.value, 4),
      projected: projected === null ? null : round(projected, 4),
      isTruthful: truthful,
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${company.name} guided ${describeGuidance(intent.metric, intent.value)} for quarter ${intent.quarter}, spending management credibility to do it.`,
      deltaLabel: 'guidance',
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/** Compare standing guidance against the quarter that has now resolved. */
function evaluateStandingGuidance(draft: SessionState, ctx: ResolverContext): void {
  for (const disclosure of draft.disclosures) {
    if (disclosure.kind !== 'guidance') continue;
    if (disclosure.metrics.targetQuarter !== draft.quarter) continue;
    if (disclosure.companyId === null) continue;
    const company = draft.companies.find((candidate) => candidate.id === disclosure.companyId);
    if (company === undefined) continue;

    const metric = guidedMetricOf(disclosure);
    if (metric === null) continue;
    const guided = disclosure.metrics[metric];
    if (guided === undefined) continue;
    const actual = projectMetric(draft, company, metric);
    if (actual === null) continue;

    const met = metric === 'model_launch_quarter' ? actual <= guided : actual >= guided * (1 - GUIDANCE_MET_TOLERANCE);
    const before = company.reputation.investor;
    company.reputation.investor = clampScore(before + (met ? GUIDANCE_BEAT_CREDIT : -GUIDANCE_MISS_PENALTY));

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'guidance_evaluated',
      actorId: company.id,
      targetId: disclosure.id,
      payload: {
        metric,
        guided: round(guided, 4),
        actual: round(actual, 4),
        met,
        investorReputationBefore: round(before, 2),
        investorReputationAfter: round(company.reputation.investor, 2),
      },
      visibility: 'public',
    });
    recordTruthAssessment(draft, ctx, company.id, disclosure.id, {
      kind: 'guidance_settled',
      metric,
      met,
      isTruthful: disclosure.isTruthful,
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: met
        ? `${company.name} met its ${metric.replace(/_/g, ' ')} guidance, and management credibility improved.`
        : `${company.name} missed its ${metric.replace(/_/g, ' ')} guidance of ${describeGuidance(metric, guided)}; credibility fell several times as far as it would have risen.`,
      deltaLabel: met ? `+${GUIDANCE_BEAT_CREDIT}` : `-${GUIDANCE_MISS_PENALTY}`,
      refEventIds: [eventId],
      tone: met ? 'positive' : 'negative',
      subjectId: company.id,
    });
  }
}

/* ---------------------------- research releases ---------------------------- */

function publishResearchResults(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'publish_research')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    const node = draft.techGraph.nodes.find((candidate) => candidate.id === intent.nodeId);
    if (company === undefined || node === undefined) continue;

    const id = makeId('dsc', company.id, draft.quarter, 'publication', node.id);
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const disclosure: PublicDisclosure = {
      id,
      companyId: company.id,
      quarter: draft.quarter,
      kind: 'press_release',
      headline: `${company.name} publishes its ${node.title} result`,
      body: `${company.name} released its work on ${node.title} as ${intent.mode.replace(/_/g, ' ')}. Stated rationale: ${
        intent.rationale.length > 0 ? intent.rationale : 'none given'
      }.`,
      metrics: { publicConfidenceBefore: round(node.publicConfidence, 4) },
      credibility: clamp01(0.6 + 0.4 * (company.reputation.developer / 100)),
      sourceCharacterId: company.ceoCharacterId,
      isTruthful: true,
      beliefTopic: 'model_success',
    };
    draft.disclosures.push(disclosure);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'research_published',
      actorId: company.id,
      targetId: node.id,
      payload: { mode: intent.mode, disclosureId: disclosure.id, nodeTitle: node.title },
      visibility: 'public',
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${company.name} published its ${node.title} result as ${intent.mode.replace(/_/g, ' ')}, buying reputation and handing rivals the method.`,
      deltaLabel: intent.mode === 'open_weights' ? 'open weights' : 'published',
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: company.id,
    });
  }
}

/* ---------------------------- crisis responses ----------------------------- */

function publishCrisisResponses(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'respond_crisis')) {
    const company = draft.companies.find((candidate) => candidate.id === action.actorCompanyId);
    if (company === undefined) continue;

    const id = makeId('dsc', company.id, draft.quarter, 'crisis', intent.crisisEventId);
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const event = draft.activeEvents.find((candidate) => candidate.id === intent.crisisEventId) ?? null;
    const namesCompany = event !== null && event.affectedCompanyIds.includes(company.id);
    // A denial of something that did happen is the misleading statement the
    // engine punishes later; everything else is recorded as said.
    const truthful = intent.responseKind !== 'deny' || !namesCompany;

    const disclosure: PublicDisclosure = {
      id,
      companyId: company.id,
      quarter: draft.quarter,
      kind: 'press_release',
      headline: `${company.name} responds: ${intent.responseKind.replace(/_/g, ' ')}`,
      body: intent.statement.length > 0 ? intent.statement : `${company.name} issued a ${intent.responseKind.replace(/_/g, ' ')} response.`,
      metrics: {},
      credibility: clamp01(credibilityOfResponse(intent.responseKind) * (0.5 + 0.5 * (company.reputation.public / 100))),
      sourceCharacterId: action.actorCharacterId,
      isTruthful: truthful,
      beliefTopic: null,
    };
    draft.disclosures.push(disclosure);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'disclosure_published',
      actorId: company.id,
      targetId: disclosure.id,
      payload: { kind: 'crisis_response', responseKind: intent.responseKind, crisisEventId: intent.crisisEventId },
      visibility: 'public',
    });
    recordTruthAssessment(draft, ctx, company.id, disclosure.id, {
      kind: 'crisis_response',
      responseKind: intent.responseKind,
      crisisEventId: intent.crisisEventId,
      namesCompany,
      isTruthful: truthful,
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${company.name} answered the ${event?.title ?? 'story'} with a ${intent.responseKind.replace(/_/g, ' ')}.`,
      deltaLabel: intent.responseKind,
      refEventIds: [eventId],
      tone: intent.responseKind === 'deny' && namesCompany ? 'warning' : 'neutral',
      subjectId: company.id,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Projection and truth                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write the engine's private judgement of a statement to its own ledger row.
 *
 * The public row says what was said. This one says what was true, and it is
 * `private` so that reaching it requires the information boundary to be crossed
 * deliberately — by a leak, by a rumour, or by the guided quarter arriving —
 * rather than by reading the ledger a rival is entitled to read.
 */
function recordTruthAssessment(
  draft: SessionState,
  ctx: ResolverContext,
  companyId: string,
  disclosureId: string,
  payload: Record<string, unknown>,
): void {
  ctx.emit({
    sessionId: draft.sessionId,
    quarter: draft.quarter,
    type: 'disclosure_published',
    actorId: companyId,
    targetId: disclosureId,
    payload: { ...payload, assessment: 'internal' },
    visibility: 'private',
  });
}

/** What the metric actually is, from canonical state. */
export function projectMetric(draft: SessionState, company: Company, metric: GuidanceMetric): number | null {
  switch (metric) {
    case 'revenue':
      return company.financials.revenueQuarterly;
    case 'gross_margin':
      return company.financials.revenueQuarterly > 0
        ? (company.financials.revenueQuarterly - company.financials.cogs) / company.financials.revenueQuarterly
        : 0;
    case 'operating_income':
      return operatingIncomeOf(company);
    case 'customers':
      return company.products.reduce((sum, product) => sum + (product.isActive ? product.activeCustomers : 0), 0);
    case 'model_launch_quarter': {
      let earliest: number | null = null;
      for (const project of draft.researchProjects) {
        if (project.companyId !== company.id || project.status !== 'active') continue;
        const eta = draft.quarter + Math.max(0, project.expectedQuarters - project.quartersElapsed);
        earliest = earliest === null ? eta : Math.min(earliest, eta);
      }
      return earliest;
    }
    default:
      return null;
  }
}

/** Whether a guided figure was consistent with reality when it was given. */
export function isConsistentWithReality(metric: GuidanceMetric, value: number, projected: number | null): boolean {
  if (projected === null) return true;
  if (metric === 'model_launch_quarter') return value >= projected;
  const denominator = Math.max(1, Math.abs(projected));
  return Math.abs(value - projected) / denominator <= GUIDANCE_TRUTH_TOLERANCE;
}

function guidedMetricOf(disclosure: PublicDisclosure): GuidanceMetric | null {
  const metrics: GuidanceMetric[] = ['revenue', 'gross_margin', 'operating_income', 'customers', 'model_launch_quarter'];
  for (const metric of metrics) if (disclosure.metrics[metric] !== undefined) return metric;
  return null;
}

function beliefTopicFor(metric: GuidanceMetric): PublicDisclosure['beliefTopic'] {
  switch (metric) {
    case 'revenue':
      return 'revenue_beat';
    case 'gross_margin':
      return 'margin_pressure';
    case 'model_launch_quarter':
      return 'model_delay';
    default:
      return null;
  }
}

function credibilityOfResponse(kind: string): number {
  switch (kind) {
    case 'acknowledge':
      return 0.8;
    case 'investigate':
      return 0.75;
    case 'apologise':
      return 0.7;
    case 'deny':
      return 0.55;
    case 'counter_attack':
      return 0.4;
    default:
      return 0.3;
  }
}

function describeGuidance(metric: GuidanceMetric, value: number): string {
  switch (metric) {
    case 'revenue':
    case 'operating_income':
      return `${compactUsd(value)} of ${metric.replace(/_/g, ' ')}`;
    case 'gross_margin':
      return `a ${(value * 100).toFixed(1)}% gross margin`;
    case 'customers':
      return `${Math.round(value)} customers`;
    case 'model_launch_quarter':
      return `a launch by quarter ${Math.round(value)}`;
    default:
      return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

const orderedCompanies = (draft: SessionState): Company[] =>
  draft.companies.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const operatingIncomeOf = (company: Company): number => {
  const f = company.financials;
  return f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${strip((abs / 1e9).toFixed(2))}bn`;
  if (abs >= 1e6) return `${sign}$${strip((abs / 1e6).toFixed(1))}m`;
  if (abs >= 1e3) return `${sign}$${strip((abs / 1e3).toFixed(0))}k`;
  return `${sign}$${Math.round(abs)}`;
}

function strip(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

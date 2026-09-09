/**
 * The Chief of Staff going and sourcing.
 *
 * The claim under test is that the loop is **two turns and cannot become
 * three**, and that with no model at all "buy a small data centre" still comes
 * back with the sellers, the price, the units, the cash afterwards and an action
 * to approve.
 *
 * No live model is contacted. Every function here is pure: the composer, the
 * policies and the offline responder are all functions of their arguments.
 */

import { describe, expect, it } from 'vitest';
import type { ChiefOfStaffInterpretation, LookupResult } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema, LookupResultSchema, MAX_LOOKUPS_PER_TURN } from '@frontier/contracts';
import { composeChiefOfStaff, enforceInterpretationPolicy, enforceResearchPolicy, renderFinding } from '../src/compose/chiefOfStaff';
import { actionsFromFindings, answerFromFinding, offlineChiefOfStaff, sourcingRequestsFor, unitsInMessage } from '../src/chiefOfStaffOffline';
import { chiefOfStaffDossier, chiefOfStaffInput } from './fixtures';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A compute-market finding shaped exactly as `runLookups` produces one. */
function computeMarketFinding(): LookupResult {
  return LookupResultSchema.parse({
    kind: 'compute_market',
    summary: '500 accelerators cost 21000000 dollars bought outright from Tessellate Fabrication.',
    units: 500,
    ownedUnits: 1_200,
    reservedUnits: 400,
    cloudUnits: 90,
    heldUnits: 1_690,
    ownedQuarterlyCostUsd: 1_400_000,
    reservedQuarterlyCostUsd: 1_300_000,
    cloudQuarterlyCostUsd: 1_900_000,
    purchaseCostUsd: 21_000_000,
    cashUsd: 4_000_000,
    cashAfterPurchaseUsd: -17_000_000,
    solvencyLine: '1 more quarter below zero and the company is wound up.',
    sellers: [
      {
        companyId: 'cmp_tessellate',
        name: 'Tessellate Fabrication',
        offering: 'accelerators',
        sectorId: 'semiconductors',
        region: 'east_asia',
        unitPriceUsd: 42_000,
        sellableUnits: 8_000,
        quarterlyCostPerUnitUsd: 2_310,
        energyFactorPct: 96,
        utilisationPct: 71,
        intent: { type: 'buy_accelerators', units: 500, maxPricePerUnitUsd: 46_200, sellerCompanyId: 'cmp_tessellate' },
      },
      {
        companyId: 'cmp_basalt',
        name: 'Basalt Compute',
        offering: 'cloud',
        sectorId: 'cloud_infrastructure',
        region: 'north_america',
        unitPriceUsd: 3_600,
        sellableUnits: 120_000,
        quarterlyCostPerUnitUsd: 3_600,
        energyFactorPct: 104,
        utilisationPct: 62,
        intent: { type: 'buy_cloud_capacity', quarterlySpendUsd: 1_800_000, providerCompanyId: 'cmp_basalt', commitmentQuarters: 0 },
      },
    ],
  });
}

function ownPositionFinding(): LookupResult {
  return LookupResultSchema.parse({
    kind: 'own_position',
    summary: '4000000 dollars of cash, moving -900000 a quarter, 4 quarters of runway.',
    cashUsd: 4_000_000,
    quarterlyBurnUsd: -900_000,
    runwayQuarters: 4,
    negativeCashQuarters: 0,
    solvencyQuartersAllowed: 2,
    statements: [{ quarter: 6, revenueUsd: 12_000_000, netIncomeUsd: -800_000, cashUsd: 4_000_000, headcount: 240 }],
  });
}

const interpretation = (over: Partial<ChiefOfStaffInterpretation> = {}): ChiefOfStaffInterpretation =>
  ChiefOfStaffInterpretationSchema.parse({
    mode: 'answer',
    reply: 'Cash is $4m.',
    interpretedInstructions: [],
    summary: 'Nothing was interpreted. Nothing has been submitted yet.',
    questions: [],
    requiresConfirmation: true,
    confidence: 0.8,
    unsupportedRequests: [],
    lookups: [],
    ...over,
  });

/* -------------------------------------------------------------------------- */
/*  The prompt                                                                 */
/* -------------------------------------------------------------------------- */

describe('the prompt opens and then closes sourcing', () => {
  it('offers the catalogue on a turn with no findings', () => {
    const { system, prompt } = composeChiefOfStaff(chiefOfStaffInput({ dossier: chiefOfStaffDossier() }));
    expect(system).toContain('compute_market');
    expect(system).toContain('acquisition_targets');
    expect(system).toContain(`at most ${MAX_LOOKUPS_PER_TURN} requests`);
    expect(prompt).toContain('A question about the market that the dossier cannot answer gets `research`');
    expect(prompt).not.toContain('What you went and looked up');
  });

  it('closes it on a turn that arrived carrying findings, and states the figures', () => {
    const { prompt } = composeChiefOfStaff(
      chiefOfStaffInput({ dossier: chiefOfStaffDossier(), findings: [computeMarketFinding(), ownPositionFinding()] }),
    );
    expect(prompt).toContain('What you went and looked up');
    expect(prompt).toContain('Research mode is closed for this turn');
    expect(prompt).toContain('`research` is not available on this turn');
    expect(prompt).toContain('Tessellate Fabrication (cmp_tessellate)');
    expect(prompt).toContain('the company is wound up');
  });

  it('renders a finding in whole figures and names the counterparty', () => {
    const text = renderFinding(computeMarketFinding());
    expect(text).toContain('Basalt Compute (cmp_basalt) sells cloud');
    expect(text).toContain('8000 available');
    expect(text).not.toMatch(/\$\d+\.\d{3,}/);
  });
});

/* -------------------------------------------------------------------------- */
/*  The loop cannot spin                                                       */
/* -------------------------------------------------------------------------- */

describe('the sourcing loop is bounded at one round', () => {
  const research = interpretation({ mode: 'research', reply: 'Checking the compute market.', lookups: [{ kind: 'own_position' }] });

  it('lets a first research turn through untouched', () => {
    const out = enforceResearchPolicy(research, false);
    expect(out.mode).toBe('research');
    expect(out.lookups).toHaveLength(1);
  });

  it('rewrites a second one into an answer and drops the lookups', () => {
    const out = enforceResearchPolicy(research, true);
    expect(out.mode).toBe('answer');
    expect(out.lookups).toEqual([]);
    expect(out.interpretedInstructions).toEqual([]);
    // The words survive: the founder reads what the model wrote, not a spinner.
    expect(out.reply).toBe('Checking the compute market.');
  });

  it('strips actions off a research turn in both directions', () => {
    const withActions = interpretation({
      mode: 'research',
      lookups: [{ kind: 'debt_headroom' }],
      interpretedInstructions: [{ type: 'set_research_budget', budgetUsd: 1_000_000 }],
    });
    expect(enforceResearchPolicy(withActions, false).interpretedInstructions).toEqual([]);
  });

  it('empties lookups on a reply that is not research', () => {
    const stray = interpretation({ mode: 'plan', lookups: [{ kind: 'own_position' }] });
    expect(enforceResearchPolicy(stray, false).lookups).toEqual([]);
  });

  it('is applied by the whole policy, which still forces confirmation', () => {
    const out = enforceInterpretationPolicy(
      interpretation({
        mode: 'research',
        lookups: [{ kind: 'own_position' }],
        interpretedInstructions: [],
        requiresConfirmation: false,
      }),
      true,
    );
    expect(out.mode).toBe('answer');
    expect(out.lookups).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Offline parity                                                             */
/* -------------------------------------------------------------------------- */

describe('sourcing with no model at all', () => {
  it('reads a size out of the message', () => {
    expect(unitsInMessage('buy 500 accelerators')).toBe(500);
    expect(unitsInMessage('buy 1,200 gpus')).toBe(1_200);
    expect(unitsInMessage('buy a small data centre')).toBe(0);
  });

  it('turns the canonical phrasings into lookups', () => {
    expect(sourcingRequestsFor('buy a small data center').map((request) => request.kind)).toEqual(['compute_market', 'own_position']);
    expect(sourcingRequestsFor('who could we acquire?').map((request) => request.kind)).toEqual(['acquisition_targets', 'own_position']);
    expect(sourcingRequestsFor('can we borrow against this?').map((request) => request.kind)).toEqual(['debt_headroom', 'own_position']);
    expect(sourcingRequestsFor('what government work is open').map((request) => request.kind)).toEqual(['government_programmes', 'own_position']);
    expect(sourcingRequestsFor('what does it cost to hire an engineer').map((request) => request.kind)).toEqual(['hiring_market', 'own_position']);
    // A question the dossier already answers asks for nothing.
    expect(sourcingRequestsFor('how much cash have we got?')).toEqual([]);
  });

  it('never asks for more than one round', () => {
    for (const message of ['buy a data centre', 'acquire somebody', 'borrow money', 'hire engineers']) {
      expect(sourcingRequestsFor(message).length).toBeLessThanOrEqual(MAX_LOOKUPS_PER_TURN);
    }
  });

  it('answers "buy a small data centre" in two turns, with an action to approve', () => {
    const first = offlineChiefOfStaff(chiefOfStaffInput({ dossier: chiefOfStaffDossier(), playerMessage: 'buy a small data centre' }));
    expect(first.mode).toBe('research');
    expect((first.lookups ?? []).map((request) => request.kind)).toEqual(['compute_market', 'own_position']);
    expect(first.interpretedInstructions).toEqual([]);

    const second = offlineChiefOfStaff(
      chiefOfStaffInput({
        dossier: chiefOfStaffDossier(),
        playerMessage: 'buy a small data centre',
        findings: [computeMarketFinding(), ownPositionFinding()],
      }),
    );
    expect(second.mode).toBe('plan');
    // Is there any, from whom, at what price, and what it does to cash.
    expect(second.reply).toContain('Tessellate Fabrication');
    expect(second.reply).toContain('$42,000 each');
    expect(second.reply).toContain('the company is wound up');
    const [action] = second.interpretedInstructions;
    expect(action?.type).toBe('buy_accelerators');
    if (action?.type === 'buy_accelerators') expect(action.sellerCompanyId).toBe('cmp_tessellate');
    // Nothing is ever submitted without a human saying so.
    expect(second.requiresConfirmation).toBe(true);
  });

  it('takes its actions verbatim from the rows the engine built', () => {
    const finding = computeMarketFinding();
    const [action] = actionsFromFindings([finding]);
    expect(action).toEqual(finding.kind === 'compute_market' ? finding.sellers[0]?.intent : null);
  });

  it('reads every kind of finding back in whole figures', () => {
    expect(answerFromFinding(computeMarketFinding())).toContain('8,000 accelerators');
    expect(answerFromFinding(computeMarketFinding())).toContain('Basalt Compute');
    expect(answerFromFinding(ownPositionFinding())).toContain('4 quarters of runway');
  });
});

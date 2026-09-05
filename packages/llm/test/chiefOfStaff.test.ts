/**
 * The Chief of Staff as an assistant rather than an interpreter: the typed
 * dossier reaching the prompt, the three modes, the offline responder that
 * answers the canonical questions with no model at all, and the bounded memory
 * that lets one thread survive a forty-quarter campaign.
 *
 * No live model is contacted here. Every function under test is pure.
 */

import { describe, expect, it } from 'vitest';
import type { ChiefOfStaffDossier, LookupResult } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema, ChiefOfStaffMemorySchema, EMPTY_CHIEF_OF_STAFF_MEMORY, LookupResultSchema } from '@frontier/contracts';
import { composeChiefOfStaff, enforceInterpretationPolicy, enforceModePolicy, renderDossier, renderFinding } from '../src/compose/chiefOfStaff';
import {
  actionsFromFindings,
  answerFromDossier,
  answerFromFinding,
  bestProduct,
  classifyQuestion,
  namedLine,
  offlineChiefOfStaff,
  worstProduct,
} from '../src/chiefOfStaffOffline';
import { forgetBefore, readMemory, rememberExchange, standingPreferenceOf } from '../src/chiefOfStaffMemory';
import { chiefOfStaffDossier, chiefOfStaffInput } from './fixtures';

/* -------------------------------------------------------------------------- */
/*  World-3 fixtures: a composed line and a slot_candidates finding             */
/* -------------------------------------------------------------------------- */

const SUITE_COMPOSITION = "your AI software suite on Basalt Compute's inference API with a copilot framework from the open market, aimed at logistics enterprises";
const COPILOT_COMPOSITION = "your consumer subscription on Sable Reasoning's inference API with an agent harness from the open market, aimed at consumers";

/** The Nexus dossier with both lines composed, as the world-3 dossier builder would hand them over. */
function composedDossier(): ChiefOfStaffDossier {
  const base = chiefOfStaffDossier();
  const [agent, copilot] = base.products.lines;
  if (agent === undefined || copilot === undefined) throw new Error('fixture has two lines');
  return chiefOfStaffDossier({
    products: {
      ...base.products,
      lines: [
        { ...agent, categoryId: 'app_ai_software_suite', unitCostUsd: 582, marketPriceUsd: 2_385, ownsNode: true, targetIndustry: 'logistics', composition: SUITE_COMPOSITION },
        { ...copilot, categoryId: 'app_consumer_subscription', unitCostUsd: 12, marketPriceUsd: 40, ownsNode: true, targetIndustry: 'consumer', composition: COPILOT_COMPOSITION },
      ],
    },
  });
}

function slotCandidatesFinding(): LookupResult {
  return {
    kind: 'slot_candidates',
    summary: "3 ways to fill the model slot of AI software suite: best on quality per dollar is an inference API from Basalt Compute's line at 9 dollars; today it runs on Basalt Compute's inference API.",
    nodeId: 'app_ai_software_suite',
    slotId: 'model',
    slotLabel: 'Model',
    productId: 'prd_enterprise_agent',
    rows: [
      {
        nodeId: 'svc_inference_api',
        label: 'Inference API',
        tier: 5,
        sourceKind: 'buy',
        sellerCompanyId: 'cmp_basalt',
        sellerName: 'Basalt Compute',
        unitPriceUsd: 9,
        qualityScorePct: 85,
        blocked: false,
        intent: { type: 'fill_slot', productId: 'prd_enterprise_agent', slotId: 'model', nodeId: 'svc_inference_api', supplierCompanyId: 'cmp_basalt', supplierProductId: 'prd_basalt_line2' },
      },
      {
        nodeId: 'svc_inference_api',
        label: 'Inference API',
        tier: 5,
        sourceKind: 'buy',
        sellerCompanyId: 'cmp_sable',
        sellerName: 'Sable Reasoning',
        unitPriceUsd: 13,
        qualityScorePct: 80,
        blocked: false,
        intent: { type: 'fill_slot', productId: 'prd_enterprise_agent', slotId: 'model', nodeId: 'svc_inference_api', supplierCompanyId: 'cmp_sable', supplierProductId: 'prd_sable_line2' },
      },
      {
        nodeId: 'svc_inference_api',
        label: 'Inference API',
        tier: 5,
        sourceKind: 'market',
        sellerCompanyId: '',
        sellerName: '',
        unitPriceUsd: 11,
        qualityScorePct: 50,
        blocked: true,
        intent: null,
      },
    ],
  };
}

function unitCostFinding(): LookupResult {
  return {
    kind: 'unit_cost',
    summary: "One seat of AI software suite costs 582 dollars to make, of which 360 is the model slot, on Basalt Compute's inference API; the market pays 2385.",
    nodeId: 'app_ai_software_suite',
    label: 'AI software suite',
    unitLabel: 'seat',
    unitCostUsd: 582,
    marketPriceUsd: 2_385,
    grossMarginPct: 76,
    madeInHouseSharePct: 0,
    blockedInputs: [],
    rows: [
      { key: 'slot:model', label: 'Inference API', amountUsd: 360, sharePct: 62, sourceKind: 'buy', sourceName: 'Basalt Compute', slotId: 'model', nodeId: 'svc_inference_api' },
      { key: 'support', label: 'Support and delivery', amountUsd: 53, sharePct: 9, sourceKind: 'conversion', sourceName: '', slotId: '', nodeId: '' },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  The dossier in the prompt                                                  */
/* -------------------------------------------------------------------------- */

describe('the typed dossier', () => {
  const dossier = chiefOfStaffDossier();

  it('renders every section in whole figures', () => {
    const text = renderDossier(dossier);
    expect(text).toContain('Cash $2.1bn');
    expect(text).toContain('Runway 7 quarters');
    expect(text).toContain('Nexus Enterprise Agent');
    expect(text).toContain('Headcount 1240');
    expect(text).toContain('The founder holds 24%');
    expect(text).toContain('Seawall Capital');
    // No stray decimals in a money figure.
    expect(text).not.toMatch(/\$\d+\.\d{3,}/);
  });

  it('names, for every action, whether this company could take it and why not', () => {
    const text = renderDossier(dossier);
    expect(text).toContain('set_research_budget');
    expect(text).toContain('budgetUsd (Quarterly research budget): $0 to $2.1bn');
    expect(text).toContain('ipo — NOT POSSIBLE: Nexus Intelligence is already listed.');
    expect(text).toContain('always needs explicit confirmation');
  });

  it('reaches the composed prompt, and the prose briefing is not repeated beside it', () => {
    const { prompt, system } = composeChiefOfStaff(chiefOfStaffInput({ dossier }));
    expect(prompt).toContain('Actions available to this company right now');
    expect(prompt).toContain('Cash $2.1bn');
    // The prose company briefing is the fallback for a caller without a
    // dossier; with one it would be a second, staler copy of the same facts.
    expect(prompt).not.toContain('1,240 staff, two products');
    expect(system).toContain('Check the available-actions list before proposing anything');
    expect(system).toContain('State numbers as whole figures');
  });

  it('keeps the prose path working for a caller that sends no dossier', () => {
    const { prompt } = composeChiefOfStaff(chiefOfStaffInput());
    expect(prompt).toContain('1,240 staff, two products');
    expect(prompt).toContain('Total committed spend: $220m');
  });

  it('tells the model which screen the founder asked from', () => {
    const { prompt } = composeChiefOfStaff(chiefOfStaffInput({ dossier, screen: '/capital' }));
    expect(prompt).toContain('the /capital screen');
  });

  it('prints each composed line as its composition sentence, after the price', () => {
    const text = renderDossier(composedDossier());
    expect(text).toContain(`$900 per seat against $582 to make, market $2.4k`);
    expect(text).toContain(`Built as: ${SUITE_COMPOSITION}`);
    expect(text).toContain(`Built as: ${COPILOT_COMPOSITION}`);
    // The price clause comes first, the composition closes the line.
    const line = text.split('\n').find((entry) => entry.includes('Nexus Enterprise Agent')) ?? '';
    expect(line.indexOf('$900 per seat')).toBeLessThan(line.indexOf('Built as:'));
    // A world-2 line, with no composition, prints no empty clause.
    expect(renderDossier(dossier)).not.toContain('Built as:');
  });

  it('tells the model about the composed line: the slot_candidates lookup and the two actions that change a line', () => {
    const { system } = composeChiefOfStaff(chiefOfStaffInput({ dossier: composedDossier() }));
    expect(system).toContain('slot_candidates');
    expect(system).toContain('`fill_slot` changes the node in one slot and who supplies it');
    expect(system).toContain('`set_target_market` changes who the line is aimed at');
    expect(system).toContain('quote them when asked what a line is built on');
  });

  it('puts standing preferences and remembered exchanges in front of the model', () => {
    const memory = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, {
      quarter: 3,
      founderSaid: 'Never lay anyone off without asking me twice.',
      chiefReplied: 'Understood.',
    });
    const { prompt } = composeChiefOfStaff(chiefOfStaffInput({ dossier, memory }));
    expect(prompt).toContain('What you remember of this thread');
    expect(prompt).toContain('Never lay anyone off without asking me twice.');
  });
});

/* -------------------------------------------------------------------------- */
/*  Mode policy                                                                */
/* -------------------------------------------------------------------------- */

describe('mode policy', () => {
  const base = {
    mode: 'answer' as const,
    reply: 'Cash is $2.1bn.',
    interpretedInstructions: [],
    summary: 'Nothing was interpreted. No binding action has been submitted yet.',
    questions: [],
    requiresConfirmation: false,
    confidence: 0.9,
    unsupportedRequests: [],
    lookups: [],
  };

  it('leaves an answer with no actions alone', () => {
    expect(enforceModePolicy(base).mode).toBe('answer');
  });

  it('relabels an "answer" that carries actions rather than discarding them', () => {
    const result = enforceModePolicy({
      ...base,
      interpretedInstructions: [{ type: 'set_research_budget', budgetUsd: 1_000_000 }],
    });
    expect(result.mode).toBe('plan');
    expect(result.interpretedInstructions).toHaveLength(1);
  });

  it('applies the confirmation policy alongside it', () => {
    const result = enforceInterpretationPolicy({
      ...base,
      interpretedInstructions: [{ type: 'layoff', role: 'engineers', count: 40, severanceQuartersOfPay: 1 }],
    });
    expect(result.mode).toBe('plan');
    expect(result.requiresConfirmation).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  The offline responder                                                      */
/* -------------------------------------------------------------------------- */

describe('the offline responder', () => {
  const dossier = chiefOfStaffDossier();

  it('classifies the canonical questions', () => {
    expect(classifyQuestion('how much cash have we got?')).toBe('cash');
    expect(classifyQuestion('What is our runway?')).toBe('runway');
    expect(classifyQuestion('how much are we burning')).toBe('burn');
    expect(classifyQuestion('which is our best product')).toBe('best_product');
    expect(classifyQuestion('what is our worst line')).toBe('worst_product');
    expect(classifyQuestion('who is attacking us')).toBe('threats');
    expect(classifyQuestion('what needs deciding this quarter')).toBe('decisions');
    expect(classifyQuestion('what can I do right now')).toBe('capabilities');
    expect(classifyQuestion('what is our headcount')).toBe('people');
    expect(classifyQuestion('who is on the board')).toBe('board');
    expect(classifyQuestion('how is the group doing?')).toBe('group');
    expect(classifyQuestion('give me the consolidated numbers')).toBe('group');
    expect(classifyQuestion('write me a haiku about compute')).toBe('unclassified');
    expect(classifyQuestion('Rewrite the strategy deck in iambic pentameter.')).toBe('unclassified');
  });

  it('reads runway before cash, because "how long does our cash last" is a runway question', () => {
    expect(classifyQuestion('how long will our cash last before we run out')).toBe('runway');
  });

  it('hears "what is my app built on" as a question about the composition', () => {
    expect(classifyQuestion('what is my app built on?')).toBe('composition');
    expect(classifyQuestion('Which model does our suite run on?')).toBe('composition');
    expect(classifyQuestion('what harness are we using')).toBe('composition');
    expect(classifyQuestion('who is our copilot aimed at')).toBe('composition');
    // "run on" is not "run out".
    expect(classifyQuestion('are we about to run out of money')).toBe('runway');
  });

  it('answers the composition from the line\'s own sentence, naming the line the founder named', () => {
    const composed = composedDossier();
    const every = answerFromDossier('composition', composed);
    expect(every).toContain(`Nexus Enterprise Agent — Your AI software suite on Basalt Compute's inference API`);
    expect(every).toContain(`Nexus Copilot — Your consumer subscription on Sable Reasoning's inference API`);

    const one = answerFromDossier('composition', composed, 'what is Nexus Copilot built on?');
    expect(one).toContain('Nexus Copilot: Your consumer subscription');
    expect(one).not.toContain('Nexus Enterprise Agent');
    expect(one).toContain('fill_slot');
    expect(one).toContain('set_target_market');
    // Named by the node it sells, when the founder says the node rather than the line.
    expect(namedLine(composed.products.lines, 'which model is the ai software suite on')?.productId).toBe('prd_enterprise_agent');

    // A world-2 dossier has no composition to read, and says so rather than inventing one.
    expect(answerFromDossier('composition', dossier)).toContain('not composed by slot');
  });

  it('answers "what is my app built on" offline, from the dossier, pointing at Products', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ dossier: composedDossier(), playerMessage: 'what is my app built on?' }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.mode).toBe('answer');
    expect(result.reply).toContain("Basalt Compute's inference API");
    expect(result.reply).toContain('aimed at logistics enterprises');
    expect(result.reply).toContain('Products');
    expect(result.interpretedInstructions).toEqual([]);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('reads a slot_candidates finding back and takes its fill verbatim', () => {
    const finding = slotCandidatesFinding();
    expect(LookupResultSchema.safeParse(finding).success).toBe(true);

    const rendered = renderFinding(finding);
    expect(rendered).toContain('what could fill this slot');
    expect(rendered).toContain('from Basalt Compute (cmp_basalt) at $9 a unit, quality 85 of 100 — fill_slot ready');
    expect(rendered).toContain('from the open market at $11 a unit, quality 50 of 100 — BLOCKED');
    expect(rendered).not.toMatch(/\$\d+\.\d{3,}/);

    const answer = answerFromFinding(finding);
    expect(answer).toContain('3 ways to fill the model slot');
    expect(answer).toContain('Inference API from Basalt Compute at $9 a unit');
    expect(answer).toContain('(blocked: nobody owns it)');

    const [action] = actionsFromFindings([finding]);
    expect(action).toEqual(finding.kind === 'slot_candidates' ? finding.rows[0]?.intent : null);
    if (action?.type === 'fill_slot') expect(action.supplierCompanyId).toBe('cmp_basalt');

    // The second-turn offline reply carries the finding and the fill to approve.
    const second = offlineChiefOfStaff(chiefOfStaffInput({ dossier: composedDossier(), playerMessage: 'which model could our suite run on?', findings: [finding] }));
    expect(second.mode).toBe('plan');
    expect(second.reply).toContain('Basalt Compute');
    expect(second.interpretedInstructions[0]?.type).toBe('fill_slot');
    expect(second.requiresConfirmation).toBe(true);
  });

  it('renders a unit-cost finding by slot', () => {
    const finding = unitCostFinding();
    expect(LookupResultSchema.safeParse(finding).success).toBe(true);
    const rendered = renderFinding(finding);
    expect(rendered).toContain('model slot: Inference API — $360, 62% of the unit cost, from Basalt Compute');
    expect(rendered).toContain('- Support and delivery — $53');
    expect(rendered).not.toContain(' slot: Support');
    expect(answerFromFinding(finding)).toContain('the biggest line of that is inference API at $360');
  });

  it('ranks products by revenue and by margin', () => {
    expect(bestProduct(dossier.products.lines)?.productId).toBe('prd_enterprise_agent');
    expect(worstProduct(dossier.products.lines)?.productId).toBe('prd_consumer_copilot');
    expect(bestProduct([])).toBeNull();
    expect(worstProduct([])).toBeNull();
  });

  it('answers each canonical question from state, in whole figures', () => {
    expect(answerFromDossier('cash', dossier)).toContain('$2B');
    expect(answerFromDossier('runway', dossier)).toContain('7 quarters');
    expect(answerFromDossier('burn', dossier)).toContain('$210M');
    expect(answerFromDossier('best_product', dossier)).toContain('Nexus Enterprise Agent');
    expect(answerFromDossier('worst_product', dossier)).toContain('Nexus Copilot');
    expect(answerFromDossier('threats', dossier)).toContain('Seawall Capital');
    expect(answerFromDossier('threats', dossier)).toContain('Orbit Dynamics');
    expect(answerFromDossier('decisions', dossier)).toContain('BP-14');
    expect(answerFromDossier('capabilities', dossier)).toContain('set research budget');
    expect(answerFromDossier('people', dossier)).toContain('1,240 people');
    expect(answerFromDossier('board', dossier)).toContain('24%');
    expect(answerFromDossier('unclassified', dossier)).toBeNull();
  });

  it('answers the group question — STAGE 5, offline responder too', () => {
    // The fixture directs one company: nothing to consolidate, and the
    // response says so rather than inventing a group.
    expect(answerFromDossier('group', dossier)).toContain('one company');

    const withSubsidiary = chiefOfStaffDossier({
      group: {
        companyCount: 2,
        revenueUsd: 1_100_000_000,
        netIncomeUsd: -50_000_000,
        cashUsd: 2_400_000_000,
        debtUsd: 500_000_000,
        headcount: 1_500,
        marketValueUsd: 21_000_000_000,
      },
    });
    const answer = answerFromDossier('group', withSubsidiary);
    expect(answer).toContain('2 companies');
    expect(answer).toContain('$1B');
    expect(answer).toContain('1,500 people');
  });

  it('names the open approach when there is one, rather than the biggest rival', () => {
    const circled = chiefOfStaffDossier({
      capital: {
        ...dossier.capital,
        approaches: [{ id: 'act_1', kind: 'activist_letter', fromName: 'Seawall Capital', summary: 'Split the consumer business.', quarter: 4 }],
      },
    });
    const answer = answerFromDossier('threats', circled);
    expect(answer).toContain('1 open approach');
    expect(answer).toContain('activist letter');
  });

  it('produces a schema-valid answer that interprets nothing', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ dossier, playerMessage: 'What is our runway?' }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.mode).toBe('answer');
    expect(result.reply).toContain('7 quarters');
    expect(result.interpretedInstructions).toEqual([]);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('offers the click path with the answer', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ dossier, playerMessage: 'which is our best product?' }));
    expect(result.reply).toContain('Products');
  });

  it('asks rather than guesses when it cannot classify the message', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ dossier, playerMessage: 'Rewrite the strategy deck in iambic pentameter.' }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.interpretedInstructions).toEqual([]);
    expect(result.questions).toHaveLength(1);
    expect(result.reply).toContain('cash, runway, burn');
  });

  it('falls back to the echo when there is no dossier at all', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ playerMessage: 'What is our runway?' }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.summary).toContain('nothing has been interpreted');
  });

  it('is deterministic', () => {
    const input = chiefOfStaffInput({ dossier, playerMessage: 'how much cash have we got?' });
    expect(offlineChiefOfStaff(input)).toEqual(offlineChiefOfStaff(input));
  });

  it('survives an absurdly long message without breaking the schema', () => {
    const result = offlineChiefOfStaff(chiefOfStaffInput({ dossier, playerMessage: 'x'.repeat(20_000) }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Memory                                                                     */
/* -------------------------------------------------------------------------- */

describe('thread memory', () => {
  it('records an exchange with the quarter it happened in', () => {
    const memory = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, { quarter: 4, founderSaid: 'How are we doing?', chiefReplied: 'Cash is $2.1bn.' });
    expect(memory.exchanges).toEqual([{ quarter: 4, founderSaid: 'How are we doing?', chiefReplied: 'Cash is $2.1bn.' }]);
    expect(ChiefOfStaffMemorySchema.safeParse(memory).success).toBe(true);
  });

  it('bounds the window by dropping the oldest', () => {
    let memory = EMPTY_CHIEF_OF_STAFF_MEMORY;
    for (let index = 0; index < 30; index += 1) {
      memory = rememberExchange(memory, { quarter: index, founderSaid: `q${index}`, chiefReplied: `a${index}` });
    }
    expect(memory.exchanges).toHaveLength(8);
    expect(memory.exchanges[0]?.founderSaid).toBe('q22');
    expect(memory.exchanges.at(-1)?.founderSaid).toBe('q29');
    expect(ChiefOfStaffMemorySchema.safeParse(memory).success).toBe(true);
  });

  it('clips a long turn to something a prompt can carry', () => {
    const memory = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, { quarter: 1, founderSaid: 'x'.repeat(5_000), chiefReplied: 'y'.repeat(5_000) });
    expect(memory.exchanges[0]?.founderSaid.length).toBeLessThanOrEqual(240);
    expect(ChiefOfStaffMemorySchema.safeParse(memory).success).toBe(true);
  });

  it('never mutates the memory it was given', () => {
    const before = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, { quarter: 1, founderSaid: 'a', chiefReplied: 'b' });
    const snapshot = JSON.stringify(before);
    rememberExchange(before, { quarter: 2, founderSaid: 'c', chiefReplied: 'd' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('picks out a standing preference and leaves an ordinary instruction alone', () => {
    expect(standingPreferenceOf('Never lay anyone off without asking me twice.')).toBe('Never lay anyone off without asking me twice.');
    expect(standingPreferenceOf('From now on keep total burn flat.')).toBe('From now on keep total burn flat.');
    expect(standingPreferenceOf('Cut consumer marketing to six million.')).toBeNull();
  });

  it('takes the preference sentence, not the question beside it', () => {
    const stated = standingPreferenceOf('Always tell me the runway first. What is our cash?');
    expect(stated).toBe('Always tell me the runway first.');
  });

  it('replaces a restated preference rather than accumulating it, keeping the later quarter', () => {
    let memory = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, { quarter: 2, founderSaid: 'Never dilute below 25%.', chiefReplied: 'Noted.' });
    memory = rememberExchange(memory, { quarter: 9, founderSaid: 'Never dilute below 25%.', chiefReplied: 'Still noted.' });
    expect(memory.preferences).toHaveLength(1);
    expect(memory.preferences[0]?.quarter).toBe(9);
  });

  it('bounds preferences too', () => {
    let memory = EMPTY_CHIEF_OF_STAFF_MEMORY;
    for (let index = 0; index < 20; index += 1) {
      memory = rememberExchange(memory, { quarter: index, founderSaid: `Always do thing ${index}.`, chiefReplied: 'ok' });
    }
    expect(memory.preferences).toHaveLength(6);
    expect(ChiefOfStaffMemorySchema.safeParse(memory).success).toBe(true);
  });

  it('reads a corrupted stored memory back as the empty one', () => {
    expect(readMemory({ exchanges: 'not an array' })).toEqual(EMPTY_CHIEF_OF_STAFF_MEMORY);
    expect(readMemory(undefined)).toEqual(EMPTY_CHIEF_OF_STAFF_MEMORY);
  });

  it('can forget everything before a quarter when a caller asks', () => {
    let memory = rememberExchange(EMPTY_CHIEF_OF_STAFF_MEMORY, { quarter: 1, founderSaid: 'Always be early.', chiefReplied: 'ok' });
    memory = rememberExchange(memory, { quarter: 12, founderSaid: 'How are we doing?', chiefReplied: 'Fine.' });
    const recent = forgetBefore(memory, 10);
    expect(recent.exchanges).toHaveLength(1);
    expect(recent.preferences).toHaveLength(0);
  });
});

/**
 * The Chief of Staff as an assistant rather than an interpreter: the typed
 * dossier reaching the prompt, the three modes, the offline responder that
 * answers the canonical questions with no model at all, and the bounded memory
 * that lets one thread survive a forty-quarter campaign.
 *
 * No live model is contacted here. Every function under test is pure.
 */

import { describe, expect, it } from 'vitest';
import { ChiefOfStaffInterpretationSchema, ChiefOfStaffMemorySchema, EMPTY_CHIEF_OF_STAFF_MEMORY } from '@frontier/contracts';
import { composeChiefOfStaff, enforceInterpretationPolicy, enforceModePolicy, renderDossier } from '../src/compose/chiefOfStaff';
import { answerFromDossier, bestProduct, classifyQuestion, offlineChiefOfStaff, worstProduct } from '../src/chiefOfStaffOffline';
import { forgetBefore, readMemory, rememberExchange, standingPreferenceOf } from '../src/chiefOfStaffMemory';
import { chiefOfStaffDossier, chiefOfStaffInput } from './fixtures';

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
    expect(classifyQuestion('write me a haiku about compute')).toBe('unclassified');
    expect(classifyQuestion('Rewrite the strategy deck in iambic pentameter.')).toBe('unclassified');
  });

  it('reads runway before cash, because "how long does our cash last" is a runway question', () => {
    expect(classifyQuestion('how long will our cash last before we run out')).toBe('runway');
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

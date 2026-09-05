/**
 * Fallback tests.
 *
 * An LLM outage is a degraded quarter, never a blocked one — so every fallback
 * has to be schema-valid, deterministic and free of randomness or clocks. These
 * tests assert exactly that: run each one twice and compare, then parse the
 * result against the contract schema it will be handed to.
 */

import { describe, expect, it } from 'vitest';
import { CharacterReplySchema, ChiefOfStaffInterpretationSchema, NarratorOutputSchema } from '@frontier/contracts';
import { dialogueRegister, fallbackCharacterReply, fallbackChiefOfStaff, fallbackNarratorOutput, narratorTone } from '../src/fallbacks';
import { chiefOfStaffInput, mayaChen, narratorInput, relationship, utteranceContext } from './fixtures';

describe('chief of staff fallback', () => {
  it('interprets nothing, echoes the instruction and demands confirmation', () => {
    const result = fallbackChiefOfStaff(chiefOfStaffInput());
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.interpretedInstructions).toEqual([]);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.summary).toContain('Get us profitable');
    expect(result.summary).toContain('nothing has been submitted');
    expect(result.questions).toHaveLength(1);
  });

  it('stays inside the schema bounds for an extremely long instruction', () => {
    const result = fallbackChiefOfStaff(chiefOfStaffInput({ playerMessage: 'x'.repeat(20_000) }));
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(1200);
    expect(result.questions[0]?.length ?? 0).toBeLessThanOrEqual(240);
  });

  it('is deterministic', () => {
    expect(fallbackChiefOfStaff(chiefOfStaffInput())).toEqual(fallbackChiefOfStaff(chiefOfStaffInput()));
  });
});

describe('character dialogue fallback', () => {
  it('replies in a register drawn from the relationship, and never fabricates a commitment', () => {
    const result = fallbackCharacterReply(utteranceContext());
    expect(CharacterReplySchema.safeParse(result).success).toBe(true);
    expect(result.newCommitment).toBeNull();
    expect(result.memoryToStore).toBeNull();
    expect(result.relationshipDeltas).toEqual({ trust: 0, respect: 0, hostility: 0 });
    expect(result.text).toContain('a six-quarter capacity swap');
  });

  it('classifies the register from the relationship alone', () => {
    expect(dialogueRegister(utteranceContext({ relationship: null }))).toBe('unacquainted');
    expect(dialogueRegister(utteranceContext({ relationship: relationship({ hostility: 78 }) }))).toBe('hostile');
    expect(dialogueRegister(utteranceContext({ relationship: relationship({ trust: 82 }) }))).toBe('warm');
    expect(dialogueRegister(utteranceContext({ relationship: relationship({ trust: 40, respect: 88 }) }))).toBe('respectful');
    expect(dialogueRegister(utteranceContext({ relationship: relationship({ trust: 12, respect: 20 }) }))).toBe('guarded');
    expect(dialogueRegister(utteranceContext({ relationship: relationship({ trust: 50, respect: 50, hostility: 5 }) }))).toBe('neutral');
  });

  it('changes voice with traits, and quotes a supplied fact rather than inventing one', () => {
    const cautious = fallbackCharacterReply(
      utteranceContext({ character: mayaChen({ stableTraits: { riskTolerance: 20, technicalOrientation: 40, financialConservatism: 88, aggressiveness: 20, statusSensitivity: 30 } }) }),
    );
    expect(cautious.text).toContain('what it costs');
    expect(cautious.text).toContain('180,000 units through 2028');

    const bare = fallbackCharacterReply(utteranceContext({ gameFacts: [] }));
    expect(bare.text).not.toContain('180,000');
    expect(CharacterReplySchema.safeParse(bare).success).toBe(true);
  });

  it('stays inside 1200 characters with a very long topic', () => {
    const result = fallbackCharacterReply(utteranceContext({ topic: 'z'.repeat(200) }));
    expect(result.text.length).toBeLessThanOrEqual(1200);
    expect(CharacterReplySchema.safeParse(result).success).toBe(true);
  });

  it('is deterministic', () => {
    expect(fallbackCharacterReply(utteranceContext())).toEqual(fallbackCharacterReply(utteranceContext()));
  });
});

describe('narrator fallback', () => {
  it('renders the committed lines directly, grouped by phase', () => {
    const result = fallbackNarratorOutput(narratorInput());
    expect(NarratorOutputSchema.safeParse(result).success).toBe(true);
    expect(result.headline).toContain('4 recorded changes');
    expect(result.body).toContain('Accelerator supply tightened');
    expect(result.body).toContain('markets:');
  });

  it('handles a quarter with nothing in it', () => {
    const result = fallbackNarratorOutput(narratorInput({ committedLines: [], focusCompanyId: null }));
    expect(NarratorOutputSchema.safeParse(result).success).toBe(true);
    expect(result.tone).toBe('steady');
    expect(result.body.length).toBeGreaterThanOrEqual(20);
  });

  it('derives tone from the shape of the deltas, not from the prose', () => {
    const line = (deltaLabel: string | null) => ({ phase: 'world', text: 'something happened', deltaLabel });
    expect(narratorTone([line('+1'), line('+2'), line('+3'), line('+4')])).toBe('triumphant');
    expect(narratorTone([line('+1'), line('+2'), line('-1'), line('-1')])).toBe('steady');
    expect(narratorTone([line('+1'), line('-1'), line('-1'), line('-1')])).toBe('strained');
    expect(narratorTone([line('-1'), line('-2'), line('-3'), line('-4')])).toBe('grim');
    expect(narratorTone([line(null), line(null)])).toBe('steady');
  });

  it('truncates a very long report into the schema bounds', () => {
    const lines = Array.from({ length: 400 }, (_, index) => ({ phase: 'companies', text: `line ${index} with a good deal of explanatory text attached`, deltaLabel: '-1%' }));
    const result = fallbackNarratorOutput(narratorInput({ committedLines: lines }));
    expect(NarratorOutputSchema.safeParse(result).success).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1500);
    expect(result.headline.length).toBeLessThanOrEqual(160);
  });

  it('is deterministic', () => {
    expect(fallbackNarratorOutput(narratorInput())).toEqual(fallbackNarratorOutput(narratorInput()));
  });
});

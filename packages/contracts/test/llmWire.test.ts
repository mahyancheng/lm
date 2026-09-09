import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionIntentSchema, InnovationProposalSchema, fromLlmWire, llmWireSchema } from '../src/index';

describe('model wire compatibility', () => {
  it('never deletes required nullable fields based on their names', () => {
    const canonical = z.object({ productBlueprint: z.string().nullable(), debtTerms: z.string().nullable(), experimentReview: z.string().nullable() });
    const value = { productBlueprint: null, debtTerms: null, experimentReview: null };
    expect(canonical.parse(fromLlmWire(canonical, value))).toEqual(value);
  });

  it('omits nested optional keys without reintroducing undefined properties', () => {
    const canonical = z.object({ rows: z.array(z.object({ arbitraryExtension: z.string().optional(), owner: z.string().nullable() })) });
    const result = canonical.parse(fromLlmWire(canonical, { rows: [{ arbitraryExtension: null, owner: null }] }));
    expect(result.rows).toEqual([{ owner: null }]);
    expect(Object.hasOwn(result.rows[0]!, 'arbitraryExtension')).toBe(false);
  });

  it('requires nullable extensions on the wire and leaves legacy canonical objects unchanged', () => {
    const canonical = z.object({ id: z.string(), extension: z.string().min(12).optional(), owner: z.string().nullable() });
    const wire = llmWireSchema(canonical);
    expect(wire.safeParse({ id: 'a', owner: null }).success).toBe(false);
    const value = { id: 'a', extension: null, owner: null };
    expect(wire.safeParse(value).success).toBe(true);
    expect(canonical.parse(fromLlmWire(canonical, value))).toEqual({ id: 'a', owner: null });
    expect(canonical.safeParse(fromLlmWire(canonical, { ...value, extension: 'short' })).success).toBe(false);
  });

  it('normalizes nullable experiment direction inside the action union without adding saved keys', () => {
    const action = { type: 'adjust_research_project', projectId: 'rsp_test', budgetUsd: 1000, computeUnits: 1, researchersAssigned: 1 };
    expect(llmWireSchema(ActionIntentSchema).safeParse({ ...action, experimentDirection: null }).success).toBe(true);
    expect(ActionIntentSchema.parse(fromLlmWire(ActionIntentSchema, { ...action, experimentDirection: null }))).toEqual(action);
    expect(ActionIntentSchema.parse(fromLlmWire(ActionIntentSchema, action))).toEqual(action);
  });

  it('preserves a real experiment while omitting an unused review', () => {
    const plan = { question: 'Can agent populations discover a useful method?', method: 'Evolve variants and evaluate them on independent held-out tasks.', budgetUsd: 1000, computeUnits: 10, researchersAssigned: 1, reviewAfterQuarters: 1 };
    const proposal = { nodeType: 'player_hypothesis', title: 'An open investigation', summary: 'Investigate evolving agents without assuming a technology result.', novelty: 0.5, plausibility: 0.5, requiredCapabilities: ['agents'], estimatedCost: 1000, estimatedQuarters: 1, dependencies: [], initialVisibility: 'company_private', rationale: 'Test an unknown with a bounded allocation.', experiment: plan, experimentReview: null };
    expect(llmWireSchema(InnovationProposalSchema).safeParse({ ...proposal, productBlueprint: null, experiment: { ...plan, autonomous: null, spendingLimitUsd: null } }).success).toBe(true);
    const parsed = InnovationProposalSchema.parse(fromLlmWire(InnovationProposalSchema, proposal));
    expect(parsed.experiment).toEqual(plan);
    expect(Object.hasOwn(parsed, 'experimentReview')).toBe(false);
  });
});

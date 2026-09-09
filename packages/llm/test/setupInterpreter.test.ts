/**
 * The new-game conversation's reader.
 *
 * Three things must hold, and they are the three that make it safe to call a
 * model before any session exists:
 *
 * 1. It **never** returns anything but a schema-valid proposal — including when
 *    nothing schema-valid came back, where it returns what the conversation had
 *    already established rather than inventing a world.
 * 2. It repairs the one contradiction a model reliably produces: a background
 *    that belongs to a different sector than the one it just named.
 * 3. It asks for a fresh session every time. There is no thread to resume: the
 *    whole conversation is in the prompt, and a resumable key before a session
 *    exists would be a key two tabs could share.
 */

import { describe, expect, it } from 'vitest';
import { SetupProposalSchema } from '@frontier/contracts';
import { EMPTY_SETUP_PROPOSAL, composeSetupInterpreter, interpretSetup, normaliseSetupProposal } from '../src/setupInterpreter';
import { createNullTransport } from '../src/transport/none';
import { createMockTransport } from './fixtures';

const ESTABLISHED = SetupProposalSchema.parse({
  sector: 'robotics',
  region: 'east_asia',
  confidence: 0.9,
  missing: ['companyName', 'founderName', 'backgroundId'],
});

describe('interpretSetup', () => {
  it('returns what the conversation established when no model answers', async () => {
    const result = await interpretSetup(createNullTransport(), {
      message: 'a robotics startup in East Asia',
      history: [],
      established: ESTABLISHED,
    });
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toEqual(ESTABLISHED);
  });

  it('returns the empty proposal when there is nothing established either', async () => {
    const result = await interpretSetup(createNullTransport(), { message: 'hello', history: [], established: null });
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toEqual(EMPTY_SETUP_PROPOSAL);
    expect(result.output.missing).toHaveLength(5);
  });

  it('names its own schema and always asks for a fresh session', async () => {
    const transport = createMockTransport(() => ({
      companyName: 'Kestrel Dynamics',
      founderName: null,
      sector: 'robotics',
      region: 'east_asia',
      backgroundId: 'humanoid_lab',
      confidence: 0.8,
      missing: ['founderName'],
    }));
    const result = await interpretSetup(transport, { message: 'call it Kestrel Dynamics', history: [], established: ESTABLISHED });

    expect(result.fallbackUsed).toBe(false);
    expect(result.output.companyName).toBe('Kestrel Dynamics');
    expect(transport.calls[0]?.schemaName).toBe('SetupProposalSchema');
    expect(transport.calls[0]?.sessionKey).toBeNull();
  });

  it('drops a background belonging to another sector and re-derives what is missing', async () => {
    const transport = createMockTransport(() => ({
      companyName: 'Kestrel Dynamics',
      founderName: 'Rae Fontaine',
      sector: 'energy',
      region: 'east_asia',
      // Belongs to robotics, not energy.
      backgroundId: 'humanoid_lab',
      confidence: 0.9,
      // And the model's own accounting of what is missing is wrong.
      missing: [],
    }));
    const result = await interpretSetup(transport, { message: 'actually, energy', history: [], established: ESTABLISHED });

    expect(result.output.backgroundId).toBeNull();
    expect(result.output.sector).toBe('energy');
    expect(result.output.missing).toEqual(['backgroundId']);
  });

  it('falls back rather than passing on a proposal the schema refuses', async () => {
    const transport = createMockTransport(() => ({ sector: 'shipbuilding', confidence: 2, missing: [] }));
    const result = await interpretSetup(transport, { message: 'shipbuilding', history: [], established: ESTABLISHED });
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toEqual(ESTABLISHED);
  });
});

describe('composeSetupInterpreter', () => {
  it('shows every id the model is allowed to use, and nothing about any session', () => {
    const composed = composeSetupInterpreter({
      message: 'a robotics startup in East Asia',
      history: [{ role: 'chief_of_staff', text: 'Where do we begin?' }],
      established: ESTABLISHED,
    });

    // Every enumerated value it may return is in front of it.
    for (const sector of ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer']) {
      expect(composed.prompt).toContain(sector);
    }
    for (const region of ['north_america', 'europe', 'east_asia', 'south_asia', 'middle_east', 'latin_america']) {
      expect(composed.prompt).toContain(region);
    }
    expect(composed.prompt).toContain('humanoid_lab');
    // What the conversation already settled is carried, so it can be overturned.
    expect(composed.prompt).toContain('sector: robotics');
    expect(composed.prompt).toContain('a robotics startup in East Asia');
    // And it is pure: the same input composes the same words.
    expect(composeSetupInterpreter({
      message: 'a robotics startup in East Asia',
      history: [{ role: 'chief_of_staff', text: 'Where do we begin?' }],
      established: ESTABLISHED,
    })).toEqual(composed);
  });
});

describe('normaliseSetupProposal', () => {
  it('keeps a background whose sector has not been stated', () => {
    const proposal = normaliseSetupProposal(
      SetupProposalSchema.parse({ backgroundId: 'humanoid_lab', confidence: 0.5, missing: [] }),
    );
    expect(proposal.backgroundId).toBe('humanoid_lab');
    expect(proposal.missing).toContain('sector');
  });
});

/**
 * The deterministic half of the new-game conversation.
 *
 * This is the reader that has to work when no model is configured, so every
 * case here is the offline path: same sentence, same proposal, every time. The
 * three failures it exists to prevent, in the order they matter:
 *
 * 1. **Guessing.** "Something in Asia" names two regions and must establish
 *    neither, because the founder lives in the region they get.
 * 2. **Capturing a phrase as a name.** "I'm building a robotics company"
 *    matches the same pattern as "I'm Rae Fontaine".
 * 3. **Carrying a contradiction.** A background belongs to a sector; changing
 *    the sector may not leave the old background standing.
 *
 * Relative imports throughout: the `@/` alias is wired up in vitest.config.mts
 * only so the modules under test can resolve their own imports; test files keep
 * to relative paths.
 */

import { describe, expect, it } from 'vitest';
import { ALL_BACKGROUNDS, CURRENT_WORLD_VERSION, NewGameSetupSchema, REGIONS, defaultRegionFor, missingSetupSlots } from '@frontier/contracts';
import { createSession, getEngine } from './engine';
import {
  EMPTY_SETUP_PROPOSAL,
  SETUP_ASK_ORDER,
  SETUP_CONFIDENCE,
  applySetupChoice,
  clearSetupSlot,
  looksLikeName,
  mergeSetupProposals,
  nextSetupSlot,
  normaliseSetupProposal,
  parseSetupMessage,
  setupAcknowledgement,
  setupFromProposal,
  setupQuickReplies,
  setupSummaryLine,
  setupUnderstood,
} from './setupChat';

/* -------------------------------------------------------------------------- */
/*  Reading a sentence                                                         */
/* -------------------------------------------------------------------------- */

describe('the keyword reader establishes only what was said', () => {
  it('reads sector, region and company name out of one sentence', () => {
    const proposal = parseSetupMessage('a robotics startup in East Asia, call it Kestrel Dynamics');
    expect(proposal.sector).toBe('robotics');
    expect(proposal.region).toBe('east_asia');
    expect(proposal.companyName).toBe('Kestrel Dynamics');
    expect(proposal.founderName).toBeNull();
    expect(proposal.missing).toEqual(['founderName', 'backgroundId']);
  });

  it('is deterministic: the same sentence twice is the same proposal', () => {
    const first = parseSetupMessage('grid-scale energy in the Middle East. I am Rae Fontaine.');
    const second = parseSetupMessage('grid-scale energy in the Middle East. I am Rae Fontaine.');
    expect(first).toEqual(second);
    expect(first.sector).toBe('energy');
    expect(first.region).toBe('middle_east');
    expect(first.founderName).toBe('Rae Fontaine');
  });

  it('prefers the longest matching phrase, so a warehouse robot is not freight', () => {
    const proposal = parseSetupMessage('warehouse robotics, please');
    expect(proposal.sector).toBe('robotics');
    expect(proposal.backgroundId).toBe('warehouse_robotics');
  });

  it('prefers "latin america" over the "america" inside it', () => {
    expect(parseSetupMessage('manufacturing in Latin America').region).toBe('latin_america');
    expect(parseSetupMessage('manufacturing in America').region).toBe('north_america');
  });

  it('reads through punctuation and case', () => {
    expect(parseSetupMessage('EAST-ASIA, robotics!').region).toBe('east_asia');
  });

  it('takes a background as a statement of its sector', () => {
    const proposal = parseSetupMessage('the humanoid lab');
    expect(proposal.backgroundId).toBe('humanoid_lab');
    expect(proposal.sector).toBe('robotics');
  });
});

/* -------------------------------------------------------------------------- */
/*  Ambiguity establishes nothing                                              */
/* -------------------------------------------------------------------------- */

describe('ambiguity lands in missing rather than in a slot', () => {
  it('refuses "Asia", which names two of the six regions', () => {
    const proposal = parseSetupMessage('somewhere in Asia');
    expect(proposal.region).toBeNull();
    expect(proposal.missing).toContain('region');
  });

  it('refuses a description that names no sector', () => {
    const proposal = parseSetupMessage('something physical, I think');
    expect(proposal.sector).toBeNull();
    expect(proposal.missing).toContain('sector');
  });

  it('reads nothing at all out of a greeting, and says so in every slot', () => {
    const proposal = parseSetupMessage('hello there');
    expect(proposal.missing).toEqual(missingSetupSlots(EMPTY_SETUP_PROPOSAL));
    expect(proposal.confidence).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Names                                                                      */
/* -------------------------------------------------------------------------- */

describe('a description is not a name', () => {
  it('refuses "I am building a robotics company" but keeps the sector', () => {
    const proposal = parseSetupMessage("I'm building a robotics company");
    expect(proposal.founderName).toBeNull();
    expect(proposal.sector).toBe('robotics');
    expect(proposal.missing).toContain('founderName');
  });

  it('accepts a name of up to four words and refuses a sentence', () => {
    expect(looksLikeName('Rae Fontaine')).toBe(true);
    expect(looksLikeName('building a robotics company')).toBe(false);
    expect(looksLikeName('a'.repeat(41))).toBe(false);
    expect(looksLikeName('')).toBe(false);
  });

  it('cuts a captured name at the conjunction that follows it', () => {
    const proposal = parseSetupMessage('call it Kestrel Dynamics and put us in Europe');
    expect(proposal.companyName).toBe('Kestrel Dynamics');
    expect(proposal.region).toBe('europe');
  });

  it('tells "call me" from "call it"', () => {
    const proposal = parseSetupMessage('call it Vantage Labs, and call me Dana Vale');
    expect(proposal.companyName).toBe('Vantage Labs');
    expect(proposal.founderName).toBe('Dana Vale');
  });

  it('reads a name loosely, and says so in the confidence', () => {
    expect(parseSetupMessage('robotics').confidence).toBe(SETUP_CONFIDENCE.keyword);
    expect(parseSetupMessage('call it Kestrel Dynamics').confidence).toBe(SETUP_CONFIDENCE.name);
  });
});

/* -------------------------------------------------------------------------- */
/*  Merging and correcting                                                     */
/* -------------------------------------------------------------------------- */

describe('the newest statement wins and never contradicts itself', () => {
  it('carries earlier slots forward', () => {
    const first = parseSetupMessage('robotics in East Asia');
    const second = parseSetupMessage('call it Kestrel Dynamics', first);
    expect(second.sector).toBe('robotics');
    expect(second.region).toBe('east_asia');
    expect(second.companyName).toBe('Kestrel Dynamics');
  });

  it('lets a founder change their mind about the sector, dropping the old background', () => {
    const first = parseSetupMessage('the humanoid lab');
    expect(first.backgroundId).toBe('humanoid_lab');
    const second = parseSetupMessage('actually, energy', first);
    expect(second.sector).toBe('energy');
    expect(second.backgroundId).toBeNull();
    expect(second.missing).toContain('backgroundId');
  });

  it('merges a model reading underneath the keyword reading, never over it', () => {
    const keywords = parseSetupMessage('robotics, call it Kestrel Dynamics');
    const model = normaliseSetupProposal({
      companyName: 'Something Else',
      founderName: 'Rae Fontaine',
      sector: 'consumer',
      region: 'europe',
      backgroundId: null,
      confidence: 0.9,
      missing: [],
    });
    const merged = mergeSetupProposals(keywords, model);
    expect(merged.companyName).toBe('Kestrel Dynamics');
    expect(merged.sector).toBe('robotics');
    // The model still contributes the slots the keywords left open.
    expect(merged.founderName).toBe('Rae Fontaine');
    expect(merged.region).toBe('europe');
  });

  it('takes the lowest confidence of the readings that contributed', () => {
    const keywords = parseSetupMessage('call it Kestrel Dynamics');
    const model = normaliseSetupProposal({ ...EMPTY_SETUP_PROPOSAL, sector: 'robotics', confidence: 0.95 });
    expect(mergeSetupProposals(keywords, model).confidence).toBe(SETUP_CONFIDENCE.name);
  });
});

/* -------------------------------------------------------------------------- */
/*  Chips                                                                      */
/* -------------------------------------------------------------------------- */

describe('choices made by tapping', () => {
  it('records a chip at full confidence when nothing loose has been read', () => {
    const proposal = applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', 'energy');
    expect(proposal.sector).toBe('energy');
    expect(proposal.confidence).toBe(SETUP_CONFIDENCE.chosen);
  });

  it('does not launder a loose name reading', () => {
    const read = parseSetupMessage('call it Kestrel Dynamics');
    expect(applySetupChoice(read, 'sector', 'energy').confidence).toBe(SETUP_CONFIDENCE.name);
  });

  it('ignores a value the world does not have', () => {
    expect(applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', 'shipbuilding')).toEqual(EMPTY_SETUP_PROPOSAL);
    expect(applySetupChoice(EMPTY_SETUP_PROPOSAL, 'backgroundId', 'nowhere')).toEqual(EMPTY_SETUP_PROPOSAL);
  });

  it('clears the background with the sector it belonged to', () => {
    const chosen = applySetupChoice(applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', 'robotics'), 'backgroundId', 'humanoid_lab');
    const cleared = clearSetupSlot(chosen, 'sector');
    expect(cleared.sector).toBeNull();
    expect(cleared.backgroundId).toBeNull();
  });

  it('offers one chip per sector, backgrounds only once a sector is known, and none for a name', () => {
    expect(setupQuickReplies('sector', EMPTY_SETUP_PROPOSAL)).toHaveLength(6);
    expect(setupQuickReplies('backgroundId', EMPTY_SETUP_PROPOSAL)).toHaveLength(0);
    const robotics = applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', 'robotics');
    expect(setupQuickReplies('backgroundId', robotics).map((chip) => chip.value)).toEqual(['warehouse_robotics', 'humanoid_lab']);
    expect(setupQuickReplies('companyName', robotics)).toHaveLength(0);
  });

  it('orders the region chips by how well they suit the chosen sector', () => {
    const energy = applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', 'energy');
    const ordered = setupQuickReplies('region', energy).map((chip) => chip.value);
    expect(ordered).toHaveLength(6);
    expect(new Set(ordered).size).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/*  Asking, and finishing                                                      */
/* -------------------------------------------------------------------------- */

describe('the conversation asks for what is missing and stops when it is not', () => {
  it('asks in world-then-company order', () => {
    let proposal = EMPTY_SETUP_PROPOSAL;
    const asked: string[] = [];
    for (let step = 0; step < SETUP_ASK_ORDER.length; step += 1) {
      const slot = nextSetupSlot(proposal);
      expect(slot).not.toBeNull();
      if (slot === null) break;
      asked.push(slot);
      const value =
        slot === 'sector'
          ? 'robotics'
          : slot === 'region'
            ? 'east_asia'
            : slot === 'backgroundId'
              ? 'humanoid_lab'
              : slot === 'companyName'
                ? 'Kestrel Dynamics'
                : 'Rae Fontaine';
      proposal = applySetupChoice(proposal, slot, value);
    }
    expect(asked).toEqual([...SETUP_ASK_ORDER]);
    expect(nextSetupSlot(proposal)).toBeNull();
  });

  it('builds a world-2 setup only once every slot is established', () => {
    const partial = parseSetupMessage('robotics in East Asia, call it Kestrel Dynamics');
    expect(setupFromProposal(partial)).toBeNull();

    const complete = parseSetupMessage('I am Rae Fontaine', applySetupChoice(partial, 'backgroundId', 'humanoid_lab'));
    const setup = setupFromProposal(complete);
    expect(setup).not.toBeNull();
    expect(setup?.worldVersion).toBe(CURRENT_WORLD_VERSION);
    expect(setup?.sector).toBe('robotics');
    expect(setup?.region).toBe('east_asia');
    expect(setup?.backgroundId).toBe('humanoid_lab');
    // The engine is handed nothing this schema has not accepted.
    expect(NewGameSetupSchema.safeParse(setup).success).toBe(true);
  });

  it('says back what it just learned, and nothing when it learned nothing', () => {
    const before = EMPTY_SETUP_PROPOSAL;
    const after = parseSetupMessage('robotics in East Asia', before);
    expect(setupAcknowledgement(before, after)).toBe('Robotics · East Asia.');
    expect(setupAcknowledgement(after, after)).toBeNull();
  });

  it('summarises the company in one sentence and lists every established slot', () => {
    const proposal = parseSetupMessage(
      'warehouse robotics in East Asia, call it Kestrel Dynamics, I am Rae Fontaine',
    );
    expect(nextSetupSlot(proposal)).toBeNull();
    expect(setupSummaryLine(proposal)).toContain('Kestrel Dynamics');
    expect(setupUnderstood(proposal).map((row) => row.slot)).toEqual([
      'sector',
      'region',
      'backgroundId',
      'companyName',
      'founderName',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  What the conversation hands the engine                                     */
/* -------------------------------------------------------------------------- */

describe('every world the conversation can ask for is a world the engine builds', () => {
  it('founds a session for each of the fifteen openings, in the region the chat would default to', () => {
    for (const background of ALL_BACKGROUNDS) {
      const proposal = applySetupChoice(
        applySetupChoice(
          applySetupChoice(
            applySetupChoice(EMPTY_SETUP_PROPOSAL, 'sector', background.sector),
            'backgroundId',
            background.id,
          ),
          'companyName',
          'Kestrel Dynamics',
        ),
        'founderName',
        'Rae Fontaine',
      );
      // The region is the one slot the chat leaves to the sector's own default
      // when a founder never names one.
      const setup = setupFromProposal({ ...proposal, region: defaultRegionFor(background.sector) });
      expect(setup).not.toBeNull();

      const session = createSession({ seed: 424242, setup: setup ?? undefined });
      expect(session.config.worldVersion).toBe(CURRENT_WORLD_VERSION);
      const player = session.companies.find((company) => company.controllerPlayerId !== null);
      expect(player?.name).toBe('Kestrel Dynamics');
      expect(player?.sector).toBe(background.sector);
      expect(player?.region).toBe(defaultRegionFor(background.sector));
    }
  });

  it('resolves a quarter in a world the conversation founded, invariants and all', () => {
    const setup = setupFromProposal({
      companyName: 'Kestrel Dynamics',
      founderName: 'Rae Fontaine',
      sector: 'robotics',
      region: 'east_asia',
      backgroundId: 'humanoid_lab',
      confidence: 1,
      missing: [],
    });
    const session = createSession({ seed: 424242, setup: setup ?? undefined });
    // Nothing queued: the point is that the world itself commits — balance
    // sheets, share ownership and market integrity all pass on quarter 0.
    const outcome = getEngine().resolver.resolveQuarter(session, [], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.nextState.quarter).toBe(1);
  });

  it('founds a session in every region for one opening', () => {
    for (const region of REGIONS) {
      const setup = setupFromProposal({
        companyName: 'Kestrel Dynamics',
        founderName: 'Rae Fontaine',
        sector: 'robotics',
        region,
        backgroundId: 'humanoid_lab',
        confidence: 1,
        missing: [],
      });
      expect(setup?.region).toBe(region);
      const session = createSession({ seed: 424242, setup: setup ?? undefined });
      expect(session.companies.find((company) => company.controllerPlayerId !== null)?.region).toBe(region);
    }
  });
});

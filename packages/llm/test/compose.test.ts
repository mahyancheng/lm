/**
 * Composer tests.
 *
 * Two things are being checked: that the dossier actually contains the material
 * the role needs, and — more importantly — that a composer refuses to serialise
 * state the actor may not see. The second half is the information boundary, and
 * it is the half that must fail loudly.
 */

import { describe, expect, it } from 'vitest';
import { LlmContextLeakError } from '../src/compose/redaction';
import { composeWorldDirector } from '../src/compose/worldDirector';
import { STRATEGIST_FULL_BRIEFING_INTERVAL, composeNpcStrategist, isFullBriefingQuarter, quartersSinceFullBriefing } from '../src/compose/npcStrategist';
import { composeChiefOfStaff, enforceConfirmationPolicy } from '../src/compose/chiefOfStaff';
import { composeCharacterDialogue, composeCharacterPersona } from '../src/compose/characterDialogue';
import { composeInnovationInterpreter } from '../src/compose/innovationInterpreter';
import { composeSocialAuthor } from '../src/compose/socialAuthor';
import { composeNarrator, groupLinesByPhase } from '../src/compose/narrator';
import {
  DANIEL_ID,
  MAYA_ID,
  NEXUS_ID,
  ORBIT_ID,
  chiefOfStaffDossier,
  chiefOfStaffInput,
  innovationInput,
  memory,
  narratorInput,
  npcStrategistInput,
  relationship,
  researchProject,
  socialInput,
  utteranceContext,
  worldDirectorInput,
} from './fixtures';

describe('world director composer', () => {
  it('carries the candidates, the budget and the legal target paths', () => {
    const { system, prompt } = composeWorldDirector(worldDirectorInput());
    expect(system).toContain('World Director');
    expect(system).toContain('empty array is a legitimate');
    expect(prompt).toContain('cand_q1_compute_1');
    expect(prompt).toContain('severity band [0.3, 0.7]');
    expect(prompt).toContain('engine drew 0.55');
    expect(prompt).toContain('maxSingleModifierMagnitude: 0.35');
    expect(prompt).toContain('world.compute.acceleratorSupply');
    expect(prompt).toContain('wev_energy_q0');
  });

  it('renders deltas with an explicit sign so direction is unambiguous', () => {
    const prompt = composeWorldDirector(worldDirectorInput()).prompt;
    expect(prompt).toContain('-0.07 vs last quarter');
    expect(prompt).toContain('+0.11 vs last quarter');
  });

  it('is deterministic', () => {
    const a = composeWorldDirector(worldDirectorInput());
    const b = composeWorldDirector(worldDirectorInput());
    expect(a).toEqual(b);
  });

  it('refuses a world summary that was built by serialising internal state', () => {
    expect(() => composeWorldDirector(worldDirectorInput({ worldSummary: 'Nexus internalConfidence is 0.48 on the agent programme.' }))).toThrow(LlmContextLeakError);
  });
});

describe('npc strategist composer', () => {
  it('includes the company state, its own memories and relationships, and bounded decision history', () => {
    const { prompt } = composeNpcStrategist(npcStrategistInput(), {
      researchProjects: [researchProject()],
      memories: [memory()],
      relationships: [relationship()],
      rivalSignals: [{ companyId: ORBIT_ID, basis: 'a published enterprise case study', observation: 'They are winning on deployment time, not on model quality.' }],
      recentPublicEvents: [{ eventId: 'wev_energy_q0', quarter: 0, type: 'energy_price_shock', title: 'Grid pricing reform lands early', severity: 0.4, stillActive: true }],
      pastDecisions: [
        { quarter: -0 + 0, posture: 'balanced', strategySummary: 'oldest, should be trimmed', outcomeSummary: 'x' },
        { quarter: 1, posture: 'balanced', strategySummary: 'q1', outcomeSummary: 'ok' },
        { quarter: 2, posture: 'balanced', strategySummary: 'q2', outcomeSummary: 'ok' },
        { quarter: 3, posture: 'balanced', strategySummary: 'q3', outcomeSummary: 'ok' },
        { quarter: 4, posture: 'aggressive_growth', strategySummary: 'q4', outcomeSummary: 'reservation cleared at 18k per unit' },
      ],
      ownCharacterIds: [MAYA_ID],
    });

    expect(prompt).toContain('Nexus Intelligence (NXS)');
    expect(prompt).toContain('rp_nexus_agents');
    expect(prompt).toContain('Orbit approached two of my inference engineers');
    expect(prompt).toContain('They are winning on deployment time');
    expect(prompt).toContain('reservation cleared at 18k per unit');
    // Only the last four quarters of decisions survive.
    expect(prompt).not.toContain('oldest, should be trimmed');
  });

  it('throws when handed another company\'s secret research programme', () => {
    expect(() =>
      composeNpcStrategist(npcStrategistInput(), {
        researchProjects: [researchProject({ id: 'rp_orbit_secret', companyId: ORBIT_ID, isSecret: true })],
        memories: [],
        relationships: [],
        rivalSignals: [],
        recentPublicEvents: [],
        pastDecisions: [],
        ownCharacterIds: [],
      }),
    ).toThrow(/secret programme belonging to/);
  });

  it('throws on a rival programme even when it is not secret', () => {
    expect(() =>
      composeNpcStrategist(npcStrategistInput(), {
        researchProjects: [researchProject({ id: 'rp_orbit_open', companyId: ORBIT_ID, isSecret: false })],
        memories: [],
        relationships: [],
        rivalSignals: [],
        recentPublicEvents: [],
        pastDecisions: [],
        ownCharacterIds: [],
      }),
    ).toThrow(LlmContextLeakError);
  });

  it('throws when handed somebody else\'s memories or feelings', () => {
    const base = {
      researchProjects: [],
      relationships: [],
      rivalSignals: [],
      recentPublicEvents: [],
      pastDecisions: [],
      ownCharacterIds: [MAYA_ID],
    };
    expect(() => composeNpcStrategist(npcStrategistInput(), { ...base, memories: [memory({ ownerCharacterId: DANIEL_ID })] })).toThrow(/does not work for/);
    expect(() =>
      composeNpcStrategist(npcStrategistInput(), { ...base, memories: [], relationships: [relationship({ fromId: DANIEL_ID, toId: MAYA_ID })] }),
    ).toThrow(/another actor's feelings are not knowable/);
  });

  it('throws when a rival briefing mentions an internal field', () => {
    expect(() => composeNpcStrategist(npcStrategistInput({ rivalBriefing: 'Orbit has an isSecret programme on sparse inference.' }))).toThrow(LlmContextLeakError);
  });

  it('accepts a company\'s own secret programme', () => {
    const { prompt } = composeNpcStrategist(npcStrategistInput(), {
      researchProjects: [researchProject({ isSecret: true })],
      memories: [],
      relationships: [],
      rivalSignals: [],
      recentPublicEvents: [],
      pastDecisions: [],
      ownCharacterIds: [],
    });
    expect(prompt).toContain('concealed');
  });
});

describe('npc strategist persona and delta', () => {
  const CAUTIOUS = {
    characterId: MAYA_ID,
    name: 'Ines Okafor',
    title: 'CEO — Nexus Intelligence',
    role: 'founder_ceo' as const,
    traits: { riskTolerance: 18, technicalOrientation: 22, financialConservatism: 88, aggressiveness: 14, statusSensitivity: 12 },
    beliefs: [{ topic: 'market_bubble' as const, level: 'high' as const }],
  };

  it('opens with the person, states what their traits mean, and carries the grudges', () => {
    const { system, prompt } = composeNpcStrategist(npcStrategistInput());
    expect(prompt.indexOf('You are Maya Chen')).toBeLessThan(prompt.indexOf('Your position'));
    expect(prompt).toContain('82 on technical depth');
    expect(prompt).toContain('compute scarcity high');
    // The traits have to bite: a directive, not a number to admire.
    expect(prompt).toContain('You attack.');
    expect(prompt).toContain('You spend ahead of revenue');
    expect(prompt).toContain('Who you have not forgotten');
    expect(prompt).toContain('approached two of my inference engineers');
    expect(prompt).toContain('still at 34 out of 100');
    expect(prompt).toContain('A frontier lab spending ahead of revenue');
    expect(prompt).toContain('Unchanged since Q1');
    expect(prompt).toContain('requisitions reduced from 400 to 24');
    expect(system).toContain('Two companies in the same position should not produce the same bundle');
  });

  it('gives two rivals with different traits and different memories materially different prompts', () => {
    const aggressive = composeNpcStrategist(npcStrategistInput()).prompt;
    const cautious = composeNpcStrategist(
      npcStrategistInput({
        persona: CAUTIOUS,
        memory: { standingStrategy: 'An enterprise software company protecting the margin.', standingStrategyQuarter: 4, grudges: [], attempts: [] },
        relationships: [{ counterpartyId: ORBIT_ID, counterpartyName: 'Orbit Dynamics', isPlayerCompany: false, trust: 71, respect: 66, hostility: 4 }],
      }),
    ).prompt;

    expect(cautious).not.toEqual(aggressive);
    expect(cautious).toContain('You do not pick fights');
    expect(cautious).toContain('You watch the cash');
    expect(cautious).not.toContain('You attack.');
    expect(cautious).not.toContain('approached two of my inference engineers');
    expect(aggressive).not.toContain('You watch the cash');
  });

  it('is deterministic', () => {
    expect(composeNpcStrategist(npcStrategistInput())).toEqual(composeNpcStrategist(npcStrategistInput()));
  });

  it('sends a delta instead of the full dossier, and the delta is smaller', () => {
    const full = composeNpcStrategist(npcStrategistInput(), {
      researchProjects: [researchProject()],
      memories: [],
      relationships: [],
      rivalSignals: [{ companyId: ORBIT_ID, basis: 'a published case study', observation: 'They are winning on deployment time.' }],
      recentPublicEvents: [{ eventId: 'wev_energy_q0', quarter: 0, type: 'energy_price_shock', title: 'Grid pricing reform lands early', severity: 0.4, stillActive: true }],
      pastDecisions: [{ quarter: 1, posture: 'balanced', strategySummary: 'q1', outcomeSummary: 'ok' }],
      ownCharacterIds: [MAYA_ID],
    }).prompt;

    const delta = composeNpcStrategist(
      npcStrategistInput({
        quarter: 9,
        changedSinceLastQuarter: {
          isFullBriefing: false,
          quartersSinceFullBriefing: 1,
          changes: [
            { kind: 'own_move', detail: 'hire: requisitions reduced from 400 to 24.' },
            { kind: 'world', detail: 'Compute spot price 1.31 (+0.09).' },
          ],
        },
      }),
      {
        researchProjects: [researchProject()],
        memories: [],
        relationships: [],
        rivalSignals: [{ companyId: ORBIT_ID, basis: 'a published case study', observation: 'They are winning on deployment time.' }],
        recentPublicEvents: [{ eventId: 'wev_energy_q0', quarter: 0, type: 'energy_price_shock', title: 'Grid pricing reform lands early', severity: 0.4, stillActive: true }],
        pastDecisions: [{ quarter: 1, posture: 'balanced', strategySummary: 'q1', outcomeSummary: 'ok' }],
        ownCharacterIds: [MAYA_ID],
      },
    ).prompt;

    expect(delta.length).toBeLessThan(full.length);
    expect(delta).toContain('What changed since quarter 8');
    expect(delta).toContain('Compute spot price 1.31');
    // What a fresh session cannot do without still travels on a delta call.
    expect(delta).toContain('You are Maya Chen');
    expect(delta).toContain('Your position');
    expect(delta).toContain('Hard constraints');
    // What the refresh is for does not.
    expect(delta).not.toContain('The world, as you understand it');
    expect(delta).not.toContain('Rivals — public information only');
    expect(full).toContain('The world, as you understand it');
  });

  it('fires the periodic refresh, on the first call of a run and every eighth quarter after', () => {
    expect(STRATEGIST_FULL_BRIEFING_INTERVAL).toBe(8);
    // No prior context — a fresh run or a just-loaded save — is always full.
    expect(isFullBriefingQuarter(5, false)).toBe(true);
    expect(isFullBriefingQuarter(5, true)).toBe(false);
    expect(isFullBriefingQuarter(8, true)).toBe(true);
    expect(isFullBriefingQuarter(16, true)).toBe(true);
    expect(quartersSinceFullBriefing(11)).toBe(3);
    expect(quartersSinceFullBriefing(16)).toBe(0);
    const quarters = Array.from({ length: 40 }, (_, index) => index + 1);
    expect(quarters.filter((quarter) => isFullBriefingQuarter(quarter, true))).toEqual([8, 16, 24, 32, 40]);
  });

  it('never writes another company\'s private state into a rival\'s prompt', () => {
    // The boundary in one assertion: strings that only exist inside another
    // company's own state must not appear, whichever field they are smuggled in.
    const PRIVATE = 'Orbit internalConfidence is 0.48 on the agent programme';
    expect(() => composeNpcStrategist(npcStrategistInput({ rivalBriefing: PRIVATE }))).toThrow(LlmContextLeakError);
    expect(() => composeNpcStrategist(npcStrategistInput({ worldBriefing: PRIVATE }))).toThrow(LlmContextLeakError);
    expect(() =>
      composeNpcStrategist(
        npcStrategistInput({
          changedSinceLastQuarter: { isFullBriefing: false, quartersSinceFullBriefing: 1, changes: [{ kind: 'rival', detail: 'Orbit has an isSecret programme on sparse inference.' }] },
        }),
      ),
    ).toThrow(LlmContextLeakError);
    expect(() =>
      composeNpcStrategist(
        npcStrategistInput({
          memories: [
            { quarter: 3, kind: 'meeting', aboutId: ORBIT_ID, aboutName: 'Orbit Dynamics', summary: 'Their isSecret programme is behind schedule.', sentiment: 0, strength: 0.5 },
          ],
        }),
      ),
    ).toThrow(LlmContextLeakError);

    // And a persona that does not work here is refused rather than written.
    expect(() =>
      composeNpcStrategist(npcStrategistInput({ persona: { ...CAUTIOUS, characterId: DANIEL_ID } }), {
        researchProjects: [],
        memories: [],
        relationships: [],
        rivalSignals: [],
        recentPublicEvents: [],
        pastDecisions: [],
        ownCharacterIds: [MAYA_ID],
      }),
    ).toThrow(/does not work for/);

    // A clean prompt carries nothing of the sort.
    const clean = composeNpcStrategist(npcStrategistInput()).prompt;
    for (const marker of ['internalConfidence', 'isSecret', 'isTruthful', 'confidenceByCompany']) {
      expect(clean).not.toContain(marker);
    }
  });
});

describe('chief of staff composer', () => {
  it('gives the model the arithmetic it needs to honour "keep burn roughly unchanged"', () => {
    const { system, prompt } = composeChiefOfStaff(chiefOfStaffInput());
    expect(prompt).toContain('Research: $180m');
    expect(prompt).toContain('Total committed spend: $220m');
    expect(prompt).toContain('Get us profitable');
    expect(prompt).toContain('Automatic execution is off');
    expect(system).toContain('raise_round');
    expect(system).toContain('You interpret and advise. You never submit.');
  });

  it('describes the auto-execute carve-out when it is enabled', () => {
    const { prompt } = composeChiefOfStaff(chiefOfStaffInput({ autoExecuteEnabled: true }));
    expect(prompt).toContain('always require an explicit confirmation');
  });

  // STAGE 5: a "how is the group doing" question is only answerable if the
  // dossier's group figures actually reach the prompt text — the model is
  // instructed to cite only the dossier, so a field the render skipped could
  // never be quoted back.
  it('renders the group section from the typed dossier, single company and consolidated', () => {
    const solo = composeChiefOfStaff(chiefOfStaffInput({ dossier: chiefOfStaffDossier() }));
    expect(solo.prompt).toContain('Group');
    expect(solo.prompt).toContain('You direct one company');

    const consolidated = composeChiefOfStaff(
      chiefOfStaffInput({
        dossier: chiefOfStaffDossier({
          group: {
            companyCount: 2,
            revenueUsd: 1_100_000_000,
            netIncomeUsd: -50_000_000,
            cashUsd: 2_400_000_000,
            debtUsd: 500_000_000,
            headcount: 1_500,
            marketValueUsd: 21_000_000_000,
          },
        }),
      }),
    );
    expect(consolidated.prompt).toContain('2 companies');
    expect(consolidated.prompt).toContain('$1.1bn');
  });
});

describe('confirmation policy', () => {
  const base = {
    mode: 'act' as const,
    reply: 'Nothing needs doing.',
    interpretedInstructions: [],
    summary: 'nothing to do here',
    questions: [],
    requiresConfirmation: false,
    confidence: 0.9,
    unsupportedRequests: [],
    lookups: [],
  };

  it('leaves a routine interpretation alone', () => {
    const result = enforceConfirmationPolicy({ ...base, interpretedInstructions: [{ type: 'set_research_budget', budgetUsd: 1_000_000 }] });
    expect(result.requiresConfirmation).toBe(false);
  });

  it('forces confirmation for an always-confirm action regardless of what the model said', () => {
    const result = enforceConfirmationPolicy({
      ...base,
      interpretedInstructions: [{ type: 'layoff', role: 'engineers', count: 40, severanceQuartersOfPay: 1 }],
    });
    expect(result.requiresConfirmation).toBe(true);
  });
});

describe('character dialogue composer', () => {
  it('builds the persona from stable traits, beliefs and both directions of the relationship', () => {
    const persona = composeCharacterPersona(utteranceContext());
    expect(persona).toContain('Maya Chen');
    expect(persona).toContain('Risk tolerance 89/100');
    expect(persona).toContain('you will poach, litigate and escalate in public');
    expect(persona).toContain('compute_scarcity: high');
    expect(persona).toContain('trust 44/100');
    expect(persona).toContain('You sense they regard you with trust 31/100');
    expect(persona).toContain('may not invent a number');
    expect(persona).toContain('Continuity');
  });

  it('says plainly when the two have never met', () => {
    const persona = composeCharacterPersona(utteranceContext({ relationship: null, counterpartRelationship: null }));
    expect(persona).toContain('You have never met this person');
    expect(persona).toContain('You have no read on how they regard you');
  });

  it('carries memories and verified facts into the turn dossier', () => {
    const { prompt } = composeCharacterDialogue(utteranceContext());
    expect(prompt).toContain('Orbit approached two of my inference engineers');
    expect(prompt).toContain('Nexus reserved capacity: 180,000 units through 2028');
    expect(prompt).toContain('twelve points over spot');
  });

  it('throws when handed another character\'s memories', () => {
    expect(() => composeCharacterDialogue(utteranceContext({ memories: [memory({ ownerCharacterId: DANIEL_ID })] }))).toThrow(LlmContextLeakError);
  });

  it('throws when the relationship is not the speaker\'s own', () => {
    expect(() => composeCharacterDialogue(utteranceContext({ relationship: relationship({ fromId: DANIEL_ID }) }))).toThrow(/not by the speaker/);
    expect(() => composeCharacterDialogue(utteranceContext({ counterpartRelationship: relationship({ fromId: DANIEL_ID, toId: ORBIT_ID }) }))).toThrow(/not at the speaker/);
  });
});

describe('innovation composer', () => {
  it('gives the interpreter the map, the capabilities and the money', () => {
    const { system, prompt } = composeInnovationInterpreter(innovationInput());
    expect(prompt).toContain('tech_agentic_planning');
    expect(prompt).toContain('cash: $2.1bn');
    expect(prompt).toContain('researchers: 310');
    expect(prompt).toContain('simulated economy');
    expect(system).toContain('Be honest');
  });
});

describe('social composer', () => {
  it('matches the register to the network and states the hard constraints', () => {
    const { system, prompt } = composeSocialAuthor(socialInput());
    expect(prompt).toContain('Engineers, researchers and developers will check the claim');
    expect(prompt).toContain('developers: 58%');
    expect(prompt).toContain('No contract terms under confidentiality');
    expect(system).toContain('State positions, never outcomes');
  });
});

describe('narrator composer', () => {
  it('groups committed lines by phase and keeps their order', () => {
    const grouped = groupLinesByPhase(narratorInput().committedLines);
    expect(grouped.map((group) => group.phase)).toEqual(['world', 'companies', 'markets']);
    expect(grouped[0]?.entries).toEqual(['Accelerator supply tightened after a packaging disruption (-7%)', 'Compute spot price repriced upward (+11%)']);
  });

  it('states that the supplied lines are the only facts available', () => {
    const { system, prompt } = composeNarrator(narratorInput());
    expect(system).toContain('the ONLY facts you have');
    expect(prompt).toContain(`Write from the point of view of ${NEXUS_ID}`);
    expect(composeNarrator(narratorInput({ focusCompanyId: null })).prompt).toContain('from no company');
  });
});

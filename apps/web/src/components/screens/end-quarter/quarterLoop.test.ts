/**
 * Regression tests for the quarter-loop surfaces.
 *
 * These cover the pure helpers behind Network, Social, the Deal Room, End
 * Quarter and Quarter Resolution — the parts that decide what a player is told.
 * They run against the real engine and the real demo world, because a screen
 * that reads correctly against a fixture and wrongly against the game is worse
 * than no test at all.
 *
 * Relative imports throughout: `apps/web` has no vitest config, so the `@/`
 * alias is a Next-only convenience and does not resolve here.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@frontier/contracts';
import { ACTION_TYPES, RESOLUTION_PHASES } from '@frontier/contracts';
import { createSession, getEngine, playerCharacterOf, playerCompanyOf } from '../../../lib/game/engine';
import { projectPlayerView } from '../../../lib/game/playerView';
import { PHASE_OF_ACTION, cashEffectOf, describeIntent, phaseOfIntent } from './intents';
import { buildDirectory, memoriesAbout, overridesFor } from '../network/directory';
import { audienceMixFor, networkFit, predictedAudiences } from '../social/audiences';
import { blankObligation, cashInObligations, describeObligation } from '../deal-room/obligations';
import { groupLines, lineCount, sectionOf } from '../quarter-resolution/sections';

describe('intent description', () => {
  it('routes every action type to a real resolution phase', () => {
    for (const type of ACTION_TYPES) {
      const phase = PHASE_OF_ACTION[type];
      expect(RESOLUTION_PHASES).toContain(phase);
    }
  });

  it('describes an intent with its terms', () => {
    const intent: ActionIntent = { type: 'hire', role: 'researchers', count: 6, compBand: 'top_of_market' };
    const described = describeIntent(intent, 2027);
    expect(described.label).toBe('Recruit 6 researchers');
    expect(described.terms.map((term) => term.label)).toContain('Compensation band');
    expect(phaseOfIntent(intent)).toBe('talent_resolution');
  });

  it('estimates hiring cash from the validator\'s own model', () => {
    const session = createSession();
    const effect = cashEffectOf(session, { type: 'hire', role: 'engineers', count: 4, compBand: 'market' });
    expect(effect.outflowUsd).toBeGreaterThan(0);
    expect(effect.inflowUsd).toBe(0);
    expect(effect.note).not.toBeNull();
  });

  it('treats a raise as sought, never received', () => {
    const session = createSession();
    const effect = cashEffectOf(session, { type: 'raise_round', stage: 'series_a', targetAmountUsd: 12_000_000, maxDilutionPct: 0.2 });
    expect(effect.outflowUsd).toBe(0);
    expect(effect.inflowUsd).toBe(12_000_000);
  });
});

describe('the people graph', () => {
  it('reads every other character with an access verdict', () => {
    const session = createSession();
    const view = projectPlayerView(session);
    const founder = playerCharacterOf(session);
    const directory = buildDirectory(session, view, founder.id);

    expect(directory).toHaveLength(15);
    expect(directory.every((entry) => entry.character.id !== founder.id)).toBe(true);
    expect(directory.every((entry) => ['open', 'override', 'blocked'].includes(entry.state))).toBe(true);
  });

  it('finds a broker for at least one blocked contact', () => {
    const session = createSession();
    const view = projectPlayerView(session);
    const founder = playerCharacterOf(session);
    const directory = buildDirectory(session, view, founder.id);

    const blocked = directory.filter((entry) => entry.state === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((entry) => entry.brokerIds.length > 0)).toBe(true);
  });

  it('never returns a memory the player does not own', () => {
    const session = createSession();
    const founder = playerCharacterOf(session);
    for (const character of session.characters) {
      for (const memory of memoriesAbout(session, founder.id, character.id)) {
        expect(memory.ownerCharacterId).toBe(founder.id);
      }
    }
  });

  it('only surfaces overrides that touch the player', () => {
    const session = createSession();
    const founder = playerCharacterOf(session);
    for (const override of overridesFor(session, founder.id)) {
      expect([override.fromId, override.toId]).toContain(founder.id);
    }
  });
});

describe('social preview', () => {
  it('uses the account mix when there is one and the platform mix otherwise', () => {
    const session = createSession();
    const account = session.socialAccounts.find((entry) => entry.handle === '@avery_sinclair') ?? null;
    const own = audienceMixFor(account, 'fast_feed');
    const platform = audienceMixFor(null, 'fast_feed');
    expect(Object.values(own).some((share) => share > 0)).toBe(true);
    expect(Object.values(platform).some((share) => share > 0)).toBe(true);
  });

  it('reports intent effects alongside audience shares', () => {
    const rows = predictedAudiences(null, 'technical_forum', 'recruit');
    const talent = rows.find((row) => row.audience === 'talent');
    expect(talent).toBeDefined();
    expect(talent?.effect).toBeGreaterThan(0);
    expect(networkFit('technical_forum', 'recruit')).toBeGreaterThan(0.5);
  });
});

describe('deal obligations', () => {
  it('produces a legal blank for every kind', () => {
    const kinds = [
      'compute_supply',
      'tech_license',
      'cash_payment',
      'equity_transfer',
      'board_vote_pledge',
      'public_endorsement',
      'consortium_membership',
      'investment',
    ] as const;
    for (const kind of kinds) {
      const obligation = blankObligation(kind, 0);
      expect(obligation.kind).toBe(kind);
      expect(describeObligation(obligation).length).toBeGreaterThan(0);
    }
  });

  it('sums only the cash obligations', () => {
    const total = cashInObligations([
      { kind: 'cash_payment', amount: 5_000_000 },
      { kind: 'compute_supply', units: 100, quarters: 2 },
      { kind: 'investment', amount: 2_000_000, securityId: 'sec_x' },
    ]);
    expect(total).toBe(7_000_000);
  });
});

describe('the resolution report', () => {
  it('groups every line, and every line carries a ledger reference', () => {
    const engine = getEngine();
    const session = createSession();
    const outcome = engine.resolver.resolveQuarter(session, [], null, []);
    expect(outcome.committed).toBe(true);

    const company = playerCompanyOf(session);
    const founder = playerCharacterOf(session);
    const ownIds = new Set<string>([company.id, founder.id]);
    const actorIds = new Set<string>([
      ...session.companies.map((entry) => entry.id),
      ...session.characters.map((entry) => entry.id),
    ]);

    const sections = groupLines(outcome.report, ownIds, actorIds);
    const grouped = sections.reduce((total, section) => total + section.lines.length, 0);
    expect(grouped).toBe(lineCount(outcome.report));
    expect(sections.map((section) => section.id)).toContain('world');
    expect(sections.map((section) => section.id)).toContain('company');

    for (const phase of outcome.report.phases) {
      for (const line of phase.lines) {
        expect(line.refEventIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('sends a frontier-belief line to the world rather than to a rival', () => {
    const ownIds = new Set<string>(['cmp_player_ventures']);
    const actorIds = new Set<string>(['cmp_player_ventures', 'cmp_nexus']);
    const id = sectionOf(
      {
        phase: 'research_resolution',
        text: 'Confidence in Sparse Expert Reasoning moved to 61%.',
        deltaLabel: '-5.5pp',
        refEventIds: ['evt_1'],
        tone: 'neutral',
        subjectId: 'tech_sparse_expert_reasoning',
      },
      ownIds,
      actorIds,
    );
    expect(id).toBe('world');
  });

  it('reaches the leaderboards and a rank row after one quarter', () => {
    const engine = getEngine();
    const session = createSession();
    const outcome = engine.resolver.resolveQuarter(session, [], null, []);
    expect(outcome.nextState.leaderboards).toHaveLength(10);
    const founder = playerCharacterOf(outcome.nextState);
    const company = playerCompanyOf(outcome.nextState);
    const listed = outcome.nextState.leaderboards.filter((board) =>
      board.entries.some((entry) => entry.subjectId === founder.id || entry.subjectId === company.id),
    );
    expect(listed.length).toBeGreaterThan(0);
  });
});

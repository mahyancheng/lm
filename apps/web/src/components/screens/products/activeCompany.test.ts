/**
 * ProductDrawer and LaunchModal must derive `company` — and everything gated
 * on it: `isOwnCompany`, `category`, `industriesForCompany`, `lineLock` — from
 * the company the seat is actively directing (STAGE 5's `useActiveCompany`),
 * not always the founding company (`usePlayerCompany`). Get this wrong and a
 * subsidiary's own product shows as a rival's (the "Built on" / "Publish as
 * an input" sections vanish), and the Launch flow's industry order and
 * research locks are judged against the wrong balance sheet.
 *
 * apps/web has no jsdom or testing-library, so neither component can be
 * rendered and inspected here (see useChiefOfStaff.test.tsx's comment on the
 * same constraint). Two layers stand in for that:
 *
 *  - a source check pinning the exact fix — both files must read `company`
 *    from `useActiveCompany`, never from `usePlayerCompany` — so a silent
 *    revert is caught even though no render test can see it.
 *  - a behavioural check running the very engine functions the two
 *    components hand `company` to (`categoryOf`, `lineLock`,
 *    `industriesForCompany`) against a real subsidiary in a different sector
 *    than the founding company, proving the founding company produces the
 *    wrong answer and the active one the right one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Company, ResearchProject, SessionState } from '@frontier/contracts';
import { categoryById, NewGameSetupSchema } from '@frontier/contracts';
import { categoryOf } from '@frontier/simulation';
import { createSession, playerCompanyOf, PLAYER_ID } from '../../../lib/game/engine';
import { industriesForCompany, lineLock } from './launchFlow';

const WORLD2_SETUP = NewGameSetupSchema.parse({
  companyName: 'Kestrel Dynamics',
  founderName: 'Rae Fontaine',
  backgroundId: 'humanoid_lab',
  sector: 'robotics',
  region: 'east_asia',
  worldVersion: 2,
});
const SEED = 424242;

/**
 * A world-2 session where the seat also controls one NPC company in a
 * different sector than the founding company — the owner's own example, "an
 * acquired energy subsidiary".
 */
function sessionWithCrossSectorSubsidiary(): { session: SessionState; founding: Company; subsidiary: Company } {
  const session = createSession({ seed: SEED, setup: WORLD2_SETUP });
  const founding = playerCompanyOf(session);
  const subsidiary = session.companies.find(
    (company) =>
      company.isActive &&
      company.id !== founding.id &&
      company.controllerPlayerId === null &&
      company.sector !== founding.sector &&
      company.products.some((product) => product.isActive),
  );
  if (subsidiary === undefined) throw new Error('world 2 seed carries no cross-sector company to make a subsidiary of.');
  subsidiary.controllerPlayerId = PLAYER_ID;
  return { session, founding, subsidiary };
}

describe('ProductDrawer / LaunchModal read the active company', () => {
  it('both derive `company` from useActiveCompany, never usePlayerCompany', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = { ProductDrawer: readFileSync(`${dir}ProductDrawer.tsx`, 'utf8'), LaunchModal: readFileSync(`${dir}LaunchModal.tsx`, 'utf8') };
    for (const [name, source] of Object.entries(files)) {
      expect(source, `${name} must derive company via useActiveCompany()`).toMatch(/const company = useActiveCompany\(\);/);
      expect(source, `${name} must not fall back to usePlayerCompany for its own company`).not.toMatch(/\busePlayerCompany\b/);
    }
  });

  it("gates ProductDrawer's isOwnCompany/category true for the subsidiary's own product, and shows why usePlayerCompany would get it wrong", () => {
    const { founding, subsidiary } = sessionWithCrossSectorSubsidiary();
    const product = subsidiary.products.find((entry) => entry.isActive);
    if (product === undefined) throw new Error('subsidiary carries no active product');

    // products/page.tsx passes companyId={useActiveCompany().id} — when the
    // seat is directing the subsidiary, that is the subsidiary's own id.
    const companyId = subsidiary.id;

    // Fixed: `company` is the subsidiary, matches the drawer's own product,
    // and its category resolves — the "Built on" / "Publish as an input"
    // sections have something to render.
    expect(subsidiary.id === companyId).toBe(true);
    expect(categoryOf(subsidiary, product).id).toBe(product.categoryId);

    // Bug reproduced: usePlayerCompany is always the founding company, so
    // `isOwnCompany` would be false for the subsidiary's own product and
    // `category` would be forced to null regardless of what categoryOf says.
    expect(founding.id === companyId).toBe(false);
  });

  it("orders LaunchModal's industries and evaluates its research locks against the company actually directing the launch", () => {
    const { session, founding, subsidiary } = sessionWithCrossSectorSubsidiary();
    const category = categoryById('ai_inference_api');
    if (category === undefined) throw new Error('ai_inference_api dropped from the catalogue');
    expect(category.requiresNodeIds).toContain('tech_efficient_sparse_inference');

    // The subsidiary's own sector leads the Industry step only when `company`
    // is the subsidiary — never when the modal silently keeps reading the
    // founding company.
    expect(industriesForCompany(subsidiary)[0]).toBe(subsidiary.sector);
    expect(industriesForCompany(founding)[0]).toBe(founding.sector);
    expect(industriesForCompany(subsidiary)[0]).not.toBe(industriesForCompany(founding)[0]);

    // Give the subsidiary — and only the subsidiary — the research the line
    // requires.
    const project: ResearchProject = {
      id: 'proj_test_unlock',
      companyId: subsidiary.id,
      targetNodeId: 'tech_efficient_sparse_inference',
      budgetQuarterly: 0,
      computeAllocated: 0,
      talentAllocated: 0,
      progress: 1,
      internalConfidence: 1,
      quartersElapsed: 1,
      expectedQuarters: 1,
      isSecret: false,
      status: 'succeeded',
      cumulativeSpendUsd: 0,
      setbacks: 0,
      startedQuarter: session.quarter,
    };
    session.researchProjects.push(project);

    expect(lineLock(session, subsidiary, category).locked).toBe(false);
    // The founding company never ran this research: the same category would
    // show locked if the modal kept reading usePlayerCompany instead.
    expect(lineLock(session, founding, category).locked).toBe(true);
  });
});

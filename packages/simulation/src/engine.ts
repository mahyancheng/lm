/**
 * @frontier/simulation — engine.ts
 *
 * Composition. The one file that knows every subsystem exists.
 *
 * Everything else in the package is written against the interfaces in
 * `@frontier/contracts/engine` and receives its collaborators by injection —
 * which is why the resolver can be exercised in full against stubs, and why a
 * subsystem can be rewritten without the resolver noticing. This file, and the
 * package index, are the only places the concrete factories are named.
 */

import type { ActionValidator, Subsystems } from '@frontier/contracts';
import { createEconomySubsystem } from './economy';
import { createMarketsSubsystem } from './markets';
import { createCompaniesSubsystem } from './companies';
import { createResearchSubsystem } from './research';
import { createGovernmentSubsystem } from './government';
import { createBoardsSubsystem } from './boards';
import { createRelationshipsSubsystem } from './relationships';
import { createSocialSubsystem } from './social';
import { createActionValidator } from './validator';
import { createQuarterResolver, type FrontierQuarterResolver, type ResolverOptions } from './resolver';

/** Everything a host needs to run a session. */
export interface FrontierEngine {
  readonly subsystems: Subsystems;
  readonly validator: ActionValidator;
  readonly resolver: FrontierQuarterResolver;
}

/**
 * Build the default engine: every subsystem, the action validator, and the
 * quarter resolver wired over them.
 *
 * Stateless. One engine can serve every session in a process, because all
 * session state lives in the `SessionState` passed to `resolveQuarter` and
 * every subsystem is a pure mutator of the draft it is handed.
 */
export function createDefaultEngine(options: ResolverOptions = {}): FrontierEngine {
  const validator = createActionValidator();

  const subsystems: Subsystems = {
    economy: createEconomySubsystem(),
    markets: createMarketsSubsystem(),
    companies: createCompaniesSubsystem(),
    research: createResearchSubsystem(),
    government: createGovernmentSubsystem(),
    boards: createBoardsSubsystem(),
    relationships: createRelationshipsSubsystem(),
    social: createSocialSubsystem(),
    actionValidator: validator,
  };

  return {
    subsystems,
    validator,
    resolver: createQuarterResolver(subsystems, options),
  };
}

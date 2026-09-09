/**
 * @frontier/simulation — scenario/world2/government.ts
 *
 * Public buyers in a six-sector world. Five agencies, and one open programme
 * per sector so that whichever sector a founder starts in there is public work
 * they could plausibly bid for by the third or fourth quarter.
 *
 * ## Region appetite is applied, not described
 *
 * Each programme is let by an agency that sits in a region, and its ceiling
 * value is scaled by that region's `procurementAppetite` index — the Middle East
 * at 120 lets a programme a fifth larger than the same programme in Europe at
 * 110, and Latin America at 60 lets one little more than half the size. The
 * scaling is a pure function of the tables in `@frontier/contracts`: no draw, no
 * clock, and the same six programmes on every machine.
 */

import type { Agency, ProcurementOpportunity, Region, Sector } from '@frontier/contracts';
import { REGION_INDEX_BASELINE, regionMeta } from '@frontier/contracts';
import { W2_CHARACTERS } from './people';

const M = 1_000_000;
const BN = 1_000_000_000;

/** Which region each agency buys from. Not a schema field: appetite only. */
const AGENCY_REGION: Readonly<Record<string, Region>> = {
  agy_defence: 'north_america',
  agy_energy: 'middle_east',
  agy_transit: 'east_asia',
  agy_industry: 'europe',
  agy_digital: 'south_asia',
};

export const W2_AGENCIES: readonly Agency[] = [
  {
    id: 'agy_defence',
    name: 'United Federation Department of Defence',
    shortName: 'UFDOD',
    jurisdiction: 'defence',
    mission: 'Sovereign capability, secure autonomy and assured access to frontier systems.',
    budgetQuarterlyUsd: 16.4 * BN,
    priorities: ['national_security', 'domestic_industry', 'data_sovereignty'],
    contactCharacterIds: [W2_CHARACTERS.amara],
    clearanceAuthority: true,
  },
  {
    id: 'agy_energy',
    name: 'Gulf Grid and Water Authority',
    shortName: 'GGWA',
    jurisdiction: 'state_regional',
    mission: 'Firm power for industry and datacentres without letting the grid fall over.',
    budgetQuarterlyUsd: 7.1 * BN,
    priorities: ['speed_of_delivery', 'domestic_industry', 'cost_efficiency'],
    contactCharacterIds: [W2_CHARACTERS.tariq],
    clearanceAuthority: false,
  },
  {
    id: 'agy_transit',
    name: 'Regional Transit and Ports Board',
    shortName: 'RTPB',
    jurisdiction: 'state_regional',
    mission: 'Move freight and people through a corridor that is already at capacity.',
    budgetQuarterlyUsd: 3.4 * BN,
    priorities: ['cost_efficiency', 'workforce_modernisation', 'vendor_diversity'],
    contactCharacterIds: [],
    clearanceAuthority: false,
  },
  {
    id: 'agy_industry',
    name: 'European Industrial Strategy Office',
    shortName: 'EISO',
    jurisdiction: 'supranational',
    mission: 'Keep critical manufacturing capacity inside the union, at any reasonable price.',
    budgetQuarterlyUsd: 4.8 * BN,
    priorities: ['domestic_industry', 'workforce_modernisation', 'responsible_ai'],
    contactCharacterIds: [W2_CHARACTERS.martin],
    clearanceAuthority: false,
  },
  {
    id: 'agy_digital',
    name: 'National Digital Services Bureau',
    shortName: 'NDSB',
    jurisdiction: 'federal_civil',
    mission: 'Deliver citizen services to a billion people without losing public trust.',
    budgetQuarterlyUsd: 1.9 * BN,
    priorities: ['cost_efficiency', 'vendor_diversity', 'responsible_ai'],
    contactCharacterIds: [W2_CHARACTERS.amara],
    clearanceAuthority: false,
  },
];

/** A programme before its region's appetite has been applied to the ceiling. */
interface ProgrammeSeed {
  readonly id: string;
  readonly sector: Sector;
  readonly agencyId: string;
  readonly programme: string;
  readonly description: string;
  /** Ceiling at appetite 100. The region's index scales it. */
  readonly baseValue: number;
  readonly contractForm: ProcurementOpportunity['contractForm'];
  readonly durationQuarters: number;
  readonly weights: ProcurementOpportunity['evaluationWeights'];
  readonly requirements: ProcurementOpportunity['requirements'];
  readonly closeQuarter: number;
  readonly visibility: ProcurementOpportunity['visibility'];
  readonly allowsConsortium: boolean;
}

const PROGRAMME_SEEDS: readonly ProgrammeSeed[] = [
  {
    id: 'opp_sovereign_reasoning',
    sector: 'ai',
    agencyId: 'agy_defence',
    programme: 'Sovereign Reasoning Platform',
    description:
      'A reasoning and analysis platform operated entirely on domestic infrastructure, with full model audit and assured availability. The largest single award on the board, and the one with the highest bar to clear.',
    baseValue: 2.2 * BN,
    contractForm: 'cost_plus',
    durationQuarters: 20,
    weights: { technical: 0.3, security: 0.2, pastPerformance: 0.15, priceRealism: 0.15, schedule: 0.1, domesticSupply: 0.05, responsibleAi: 0.05 },
    requirements: { clearanceLevel: 'level_iv', domesticInference: true, modelAudit: true, uptimePct: 99.99, dataSovereignty: true, minimumPastPerformance: 55 },
    closeQuarter: 3,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'opp_field_autonomy',
    sector: 'robotics',
    agencyId: 'agy_defence',
    programme: 'Perimeter Field Autonomy',
    description:
      'Unmanned ground systems for perimeter and logistics duty on installations, judged on how rarely they need a person and how well they behave when they do.',
    baseValue: 780 * M,
    contractForm: 'fixed_price',
    durationQuarters: 12,
    weights: { technical: 0.28, security: 0.18, pastPerformance: 0.18, priceRealism: 0.16, schedule: 0.12, domesticSupply: 0.05, responsibleAi: 0.03 },
    requirements: { clearanceLevel: 'level_iii', domesticInference: true, modelAudit: true, uptimePct: 99.5, dataSovereignty: true, minimumPastPerformance: 45 },
    closeQuarter: 3,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'opp_industrial_capacity',
    sector: 'manufacturing',
    agencyId: 'agy_industry',
    programme: 'Strategic Components Capacity',
    description:
      'Domestic capacity for components the union currently imports from one supplier. Heavily weighted on domestic content and on whether the bidder can actually build the line.',
    baseValue: 1.1 * BN,
    contractForm: 'cost_plus',
    durationQuarters: 16,
    weights: { technical: 0.24, security: 0.08, pastPerformance: 0.18, priceRealism: 0.2, schedule: 0.14, domesticSupply: 0.13, responsibleAi: 0.03 },
    requirements: { clearanceLevel: 'level_i', domesticInference: false, modelAudit: false, uptimePct: 99, dataSovereignty: false, minimumPastPerformance: 30 },
    closeQuarter: 4,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'opp_grid_firming',
    sector: 'energy',
    agencyId: 'agy_energy',
    programme: 'Grid Firming and Datacentre Supply',
    description:
      'Firm capacity contracted against the industrial and datacentre load the region has already approved. Schedule matters more than price: the load arrives whether or not the power does.',
    baseValue: 1.6 * BN,
    contractForm: 'fixed_price',
    durationQuarters: 20,
    weights: { technical: 0.22, security: 0.1, pastPerformance: 0.2, priceRealism: 0.18, schedule: 0.22, domesticSupply: 0.05, responsibleAi: 0.03 },
    requirements: { clearanceLevel: 'none', domesticInference: false, modelAudit: false, uptimePct: 99.9, dataSovereignty: false, minimumPastPerformance: 35 },
    closeQuarter: 2,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'opp_transit_freight',
    sector: 'logistics',
    agencyId: 'agy_transit',
    programme: 'Corridor Freight Modernisation',
    description:
      'Automated cross-docking and routing across the port corridor, procured on cost per tonne moved and on how little disruption the transition causes.',
    baseValue: 640 * M,
    contractForm: 'fixed_price',
    durationQuarters: 12,
    weights: { technical: 0.22, security: 0.08, pastPerformance: 0.2, priceRealism: 0.28, schedule: 0.14, domesticSupply: 0.05, responsibleAi: 0.03 },
    requirements: { clearanceLevel: 'none', domesticInference: false, modelAudit: false, uptimePct: 99.5, dataSovereignty: false, minimumPastPerformance: 25 },
    closeQuarter: 3,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'opp_citizen_services',
    sector: 'consumer',
    agencyId: 'agy_digital',
    programme: 'Citizen Services Assistant',
    description:
      'An assisted-service layer over benefits, licensing and tax for a billion citizens. Scrutinised hard on cost and accessibility, lightly on capability.',
    baseValue: 520 * M,
    contractForm: 'fixed_price',
    durationQuarters: 12,
    weights: { technical: 0.22, security: 0.12, pastPerformance: 0.16, priceRealism: 0.3, schedule: 0.1, domesticSupply: 0.04, responsibleAi: 0.06 },
    requirements: { clearanceLevel: 'level_i', domesticInference: false, modelAudit: true, uptimePct: 99.9, dataSovereignty: true, minimumPastPerformance: 20 },
    closeQuarter: 4,
    visibility: 'public',
    allowsConsortium: true,
  },
];

/**
 * The six opening programmes, one per sector, with each ceiling scaled by the
 * appetite of the region its agency buys from. Pure and deterministic.
 */
export function buildV2Opportunities(): ProcurementOpportunity[] {
  return PROGRAMME_SEEDS.map((seed) => {
    const region = AGENCY_REGION[seed.agencyId];
    const appetite = region === undefined ? REGION_INDEX_BASELINE : regionMeta(region).procurementAppetite;
    return {
      id: seed.id,
      agencyId: seed.agencyId,
      programme: seed.programme,
      description: seed.description,
      maxValue: Math.round((seed.baseValue * appetite) / REGION_INDEX_BASELINE),
      contractForm: seed.contractForm,
      durationQuarters: seed.durationQuarters,
      evaluationWeights: { ...seed.weights },
      requirements: { ...seed.requirements },
      openQuarter: 0,
      closeQuarter: seed.closeQuarter,
      visibility: seed.visibility,
      invitedCompanyIds: [],
      allowsConsortium: seed.allowsConsortium,
      status: 'open',
    };
  });
}

/** Which sector each opening programme is aimed at, for the Government screen. */
export const W2_OPPORTUNITY_SECTORS: Readonly<Record<string, Sector>> = Object.fromEntries(
  PROGRAMME_SEEDS.map((seed) => [seed.id, seed.sector] as const),
);

/**
 * The office, as data.
 *
 * `buildOfficeModel` is the only place the scene reads engine state. It is a
 * pure function of `SessionState`, the player's own `Company` and the player's
 * own research programmes, and it produces the complete description of what to
 * draw: which zones exist, how many figures each holds, how many real heads one
 * figure stands for, how many racks the server room needs and which named
 * executives have a desk.
 *
 * Two rules it never breaks:
 *
 * 1. **Nothing is invented.** Every figure is read from committed state or
 *    derived by arithmetic documented right here. Headcount per zone is
 *    `EmployeeBase[role]`; accelerators are `ComputeHoldings`; held capacity is
 *    the engine's own `heldComputeUnits`. Where the picture has to scale — a
 *    crowd of four hundred into twelve desks — the scale factor is carried on
 *    the model so the interface can say so.
 * 2. **No private state leaks.** The office is the player's own company, read
 *    from `SessionState`. Named executives come from `session.characters`
 *    filtered to this company, which is the player's own leadership and already
 *    rendered on the Company screen.
 */

import type { Character, Company, CompanyTier, ResearchProject, SessionState, StaffRole } from '@frontier/contracts';
import { STAFF_ROLES } from '@frontier/contracts';
import { heldComputeUnits } from '@frontier/simulation';
import { allocate, crowd, seatId, type Crowd } from './seats';

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const OFFICE_ZONE_IDS = ['lobby', 'executive', 'server', 'engineering', 'research', 'sales', 'operations'] as const;
export type OfficeZoneId = (typeof OFFICE_ZONE_IDS)[number];

/** Where a zone sends you when it is activated. */
export type OfficeZoneTarget =
  | { readonly kind: 'route'; readonly href: string }
  | { readonly kind: 'drawer'; readonly drawer: OfficeDrawerId }
  | { readonly kind: 'character'; readonly characterId: string };

export type OfficeDrawerId = 'compute' | 'sites';

/** Morale, banded the way `Meter` bands it, so the office and the meter agree. */
export type MoraleBand = 'thriving' | 'steady' | 'strained' | 'unhappy';

export function moraleBand(morale: number): MoraleBand {
  if (morale >= 70) return 'thriving';
  if (morale >= 45) return 'steady';
  if (morale >= 25) return 'strained';
  return 'unhappy';
}

/** One word for how the floor feels. Used in badges and aria labels. */
export const MORALE_MOOD: Readonly<Record<MoraleBand, string>> = {
  thriving: 'Buzzing',
  steady: 'Steady',
  strained: 'Strained',
  unhappy: 'Unhappy',
};

export const MORALE_TONE: Readonly<Record<MoraleBand, 'gain' | 'info' | 'warn' | 'loss'>> = {
  thriving: 'gain',
  steady: 'info',
  strained: 'warn',
  unhappy: 'loss',
};

/* -------------------------------------------------------------------------- */
/*  Model                                                                      */
/* -------------------------------------------------------------------------- */

export interface OfficeSeat {
  /** Deterministic synthetic id — the seed for this figure's whole look. */
  readonly id: string;
  /** False for an empty desk standing in for an open role. */
  readonly filled: boolean;
}

export interface OfficeWorkZone {
  readonly id: Exclude<OfficeZoneId, 'lobby' | 'executive' | 'server'>;
  readonly role: StaffRole;
  readonly label: string;
  /** True headcount in this function. */
  readonly headcount: number;
  /** Drawn figures, and how many heads each stands for. */
  readonly crowd: Crowd;
  /** Desks drawn empty: this zone's allocated share of company-wide open roles. */
  readonly vacantDesks: number;
  readonly seats: readonly OfficeSeat[];
  readonly target: OfficeZoneTarget;
  /** A second line of context read straight off state. */
  readonly caption: string;
}

export interface OfficeExecutive {
  readonly characterId: string;
  readonly seatId: string;
  readonly name: string;
  readonly title: string;
  readonly isCeo: boolean;
  readonly isPlayer: boolean;
}

export interface OfficeServerRoom {
  readonly owned: number;
  readonly reserved: number;
  /** Held capacity less what is owned or reserved — the on-demand remainder. */
  readonly cloudUnits: number;
  /** The engine's own held-capacity figure. */
  readonly held: number;
  readonly utilisation: number;
  readonly trainingAllocation: number;
  /** Racks drawn, and the accelerators one rack stands for. */
  readonly racks: number;
  readonly acceleratorsPerRack: number;
  readonly expiryQuarter: number | null;
  readonly quartersToExpiry: number | null;
  /** True when a reservation is held and lapses within two quarters. */
  readonly expiryWarning: boolean;
}

export interface OfficeLobby {
  readonly companyName: string;
  readonly tier: CompanyTier;
  readonly headquartersCity: string;
  readonly sites: number;
  readonly seatCapacity: number;
  /** Company-wide open roles. The only vacancy figure the scene prints. */
  readonly openRoles: number;
  readonly isPublic: boolean;
  readonly ticker: string | null;
}

export interface OfficeModel {
  readonly companyId: string;
  readonly headcount: number;
  readonly morale: number;
  readonly band: MoraleBand;
  readonly attrition: number;
  readonly lobby: OfficeLobby;
  readonly zones: readonly OfficeWorkZone[];
  readonly executives: readonly OfficeExecutive[];
  /** Executive *headcount*, which is not the same as the named leadership. */
  readonly execHeadcount: number;
  readonly server: OfficeServerRoom;
  /** Active product lines — the crates stacked in the sales zone. */
  readonly activeProducts: number;
  /** Running research programmes — the whiteboards in the research zone. */
  readonly activeProgrammes: number;
}

/* -------------------------------------------------------------------------- */
/*  Zone definitions                                                           */
/* -------------------------------------------------------------------------- */

interface ZoneDefinition {
  readonly id: OfficeWorkZone['id'];
  readonly role: StaffRole;
  readonly label: string;
  readonly href: string;
  /** How many desks the drawn room holds before figures start to stand for many. */
  readonly capacity: number;
}

/** The four working rooms, in the order the floor plan lays them out. */
export const WORK_ZONES: readonly ZoneDefinition[] = [
  { id: 'engineering', role: 'engineers', label: 'Engineering', href: '/people', capacity: 18 },
  { id: 'research', role: 'researchers', label: 'Research', href: '/research', capacity: 12 },
  { id: 'sales', role: 'sales', label: 'Sales & marketing', href: '/products', capacity: 12 },
  { id: 'operations', role: 'ops', label: 'Operations', href: '/people', capacity: 16 },
];

/** Named executives with a desk on the floor. The badge carries the true count. */
export const EXECUTIVE_DESK_CAP = 5;

/* -------------------------------------------------------------------------- */
/*  Server room arithmetic                                                     */
/* -------------------------------------------------------------------------- */

/** Never draw more racks than this, however large the fleet. */
export const RACK_CAP = 10;
/** The smallest number of accelerators one drawn rack ever stands for. */
export const BASE_ACCELERATORS_PER_RACK = 256;

/**
 * Racks for a fleet of `accelerators`, and what one rack stands for.
 *
 * The per-rack figure steps up in whole multiples of the base so the room reads
 * as a room rather than a bar chart: a small fleet gets one rack per 256 cards,
 * a very large one gets a coarser rack and the same ten-rack silhouette.
 */
export function rackPlan(accelerators: number): { readonly racks: number; readonly acceleratorsPerRack: number } {
  const fleet = Math.max(0, Math.floor(accelerators));
  if (fleet === 0) return { racks: 0, acceleratorsPerRack: BASE_ACCELERATORS_PER_RACK };
  const steps = Math.max(1, Math.ceil(fleet / (RACK_CAP * BASE_ACCELERATORS_PER_RACK)));
  const acceleratorsPerRack = steps * BASE_ACCELERATORS_PER_RACK;
  return { racks: Math.min(RACK_CAP, Math.ceil(fleet / acceleratorsPerRack)), acceleratorsPerRack };
}

/* -------------------------------------------------------------------------- */
/*  Builder                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuildOfficeModelInput {
  readonly session: SessionState;
  readonly company: Company;
  /** The player's own programmes. Only the running count is used. */
  readonly projects: readonly ResearchProject[];
  /** Session characters. Filtered to this company's active leadership. */
  readonly characters: readonly Character[];
}

/** Compact count rendering: `12 400` rather than a locale-dependent string. */
export function countLabel(value: number): string {
  return String(Math.round(Math.max(0, value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function buildOfficeModel({ session, company, projects, characters }: BuildOfficeModelInput): OfficeModel {
  const employees = company.employees;
  const headcount = STAFF_ROLES.reduce((total, role) => total + employees[role], 0);

  const vacancies = allocate(
    employees.openRoles,
    WORK_ZONES.map((zone) => employees[zone.role]),
  );

  const activeProducts = company.products.filter((product) => product.isActive).length;
  const activeProgrammes = projects.filter((project) => project.status === 'active').length;

  const zones = WORK_ZONES.map((definition, index): OfficeWorkZone => {
    const zoneHeadcount = employees[definition.role];
    const shape = crowd(zoneHeadcount, definition.capacity);
    const allocated = vacancies[index] ?? 0;
    // Empty desks are drawn at the same scale as filled ones, and never crowd
    // the room out: at most a third of the drawn desks stand empty.
    const vacantDesks = Math.min(
      Math.max(0, Math.round(allocated / shape.perFigure)),
      Math.max(1, Math.floor(definition.capacity / 3)),
    );
    const seats: OfficeSeat[] = [];
    for (let seat = 0; seat < shape.figures; seat += 1) {
      seats.push({ id: seatId(company.id, definition.id, seat), filled: true });
    }
    for (let seat = 0; seat < vacantDesks; seat += 1) {
      seats.push({ id: seatId(company.id, `${definition.id}-open`, seat), filled: false });
    }
    return {
      id: definition.id,
      role: definition.role,
      label: definition.label,
      headcount: zoneHeadcount,
      crowd: shape,
      vacantDesks,
      seats,
      target: { kind: 'route', href: definition.href },
      caption: captionFor(definition.id, { activeProducts, activeProgrammes, sites: company.offices.length }),
    };
  });

  const leadership = characters
    .filter((character) => character.companyId === company.id && character.isActive)
    .slice()
    .sort((a, b) => {
      const ceo = Number(b.id === company.ceoCharacterId) - Number(a.id === company.ceoCharacterId);
      if (ceo !== 0) return ceo;
      const player = Number(b.isPlayer) - Number(a.isPlayer);
      if (player !== 0) return player;
      return a.id.localeCompare(b.id);
    });

  const executives = leadership.slice(0, EXECUTIVE_DESK_CAP).map(
    (character): OfficeExecutive => ({
      characterId: character.id,
      // Keyed on the character, not on a desk index: a promotion must not
      // redraw the face of everyone who shuffled along the row.
      seatId: `${company.id}/exec/${character.id}`,
      name: character.name,
      title: character.title,
      isCeo: character.id === company.ceoCharacterId,
      isPlayer: character.isPlayer,
    }),
  );

  const holdings = company.compute;
  const held = heldComputeUnits(session, company);
  const fleet = holdings.ownedAccelerators + holdings.reservedAccelerators;
  const plan = rackPlan(fleet);
  const quartersToExpiry = holdings.reservationExpiryQuarter === null ? null : holdings.reservationExpiryQuarter - session.quarter;

  return {
    companyId: company.id,
    headcount,
    morale: employees.morale,
    band: moraleBand(employees.morale),
    attrition: employees.attrition,
    lobby: {
      companyName: company.name,
      tier: company.tier,
      headquartersCity: company.headquartersCity,
      sites: company.offices.length,
      seatCapacity: company.offices.reduce((total, office) => total + office.headcountCapacity, 0),
      openRoles: employees.openRoles,
      isPublic: company.isPublic,
      ticker: company.ticker,
    },
    zones,
    executives,
    execHeadcount: employees.execs,
    server: {
      owned: holdings.ownedAccelerators,
      reserved: holdings.reservedAccelerators,
      cloudUnits: Math.max(0, held - fleet),
      held,
      utilisation: holdings.computeUtilisation,
      trainingAllocation: holdings.trainingAllocation,
      racks: plan.racks,
      acceleratorsPerRack: plan.acceleratorsPerRack,
      expiryQuarter: holdings.reservationExpiryQuarter,
      quartersToExpiry,
      expiryWarning: holdings.reservedAccelerators > 0 && quartersToExpiry !== null && quartersToExpiry <= 2,
    },
    activeProducts,
    activeProgrammes,
  };
}

function captionFor(
  id: OfficeWorkZone['id'],
  context: { readonly activeProducts: number; readonly activeProgrammes: number; readonly sites: number },
): string {
  switch (id) {
    case 'engineering':
      return 'Product and platform';
    case 'research':
      return context.activeProgrammes === 1 ? '1 programme running' : `${context.activeProgrammes} programmes running`;
    case 'sales':
      return context.activeProducts === 1 ? '1 live product' : `${context.activeProducts} live products`;
    default:
      return context.sites === 1 ? 'Infrastructure · 1 site' : `Infrastructure · ${context.sites} sites`;
  }
}

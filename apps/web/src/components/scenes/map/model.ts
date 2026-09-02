/**
 * The world map, as data.
 *
 * `buildWorldMapModel` is the only place the scene reads engine state, and it
 * is a pure function of the **player's projection** plus the session's public
 * register of agencies. Everything it returns is drawable: a placed building, a
 * marker at a coordinate, an overlay intensity, a reading.
 *
 * Two rules it never breaks.
 *
 * 1. **Public information only.** Rivals arrive as `PlayerView.visibleCompanies`
 *    — the redacted projection — and nothing here reaches past it. A rival's
 *    silhouette is sized from its *quoted* market capitalisation when it is
 *    listed, because a quote is public, and from its simulation tier when it is
 *    not, because a private company's valuation is not. Only the player's own
 *    tower is sized from a figure the player alone can see, and it is their own.
 *    Events are `PlayerView.activeEvents` filtered to `visibility === 'public'`:
 *    a sector-visible or private event may reach the player, but it does not
 *    belong on a map that reads as the public record.
 *
 * 2. **Nothing is invented and nothing is random.** Placement is a lookup from
 *    sector to district and then a walk down a fixed plot list in a stable
 *    order. Size is a documented function of a figure in state. Colour variation
 *    is `fnv1a64(entityId)`. Two renders of the same quarter are identical.
 */

import type {
  Agency,
  Company,
  CompanyTier,
  DominantNarrative,
  PlayerView,
  Quote,
  Sector,
  WorldEvent,
  WorldEventType,
  WorldState,
} from '@frontier/contracts';
import { SECTOR_META } from '@frontier/contracts';
import { fnv1a64, formatMultiple, formatPct } from '@frontier/shared';
import { sectorOf, type Tone } from '@/components/ui';
import {
  DISTRICTS,
  DISTRICT_BY_ID,
  DISTRICT_LANDMARKS,
  MARKER_OFFSETS,
  type BuildingGlyph,
  type DistrictId,
  type LandmarkSeed,
  type Plot,
} from './geography';

/* -------------------------------------------------------------------------- */
/*  Targets                                                                    */
/* -------------------------------------------------------------------------- */

/** What activating something on the map opens. */
export type MapTarget =
  | { readonly kind: 'company'; readonly companyId: string }
  | { readonly kind: 'agency'; readonly agencyId: string }
  | { readonly kind: 'district'; readonly districtId: DistrictId }
  | { readonly kind: 'event'; readonly eventId: string };

/* -------------------------------------------------------------------------- */
/*  Placed things                                                              */
/* -------------------------------------------------------------------------- */

export interface MapBuilding {
  /** Stable key: the entity id, which is also the drawing seed. */
  readonly key: string;
  readonly kind: 'company' | 'agency' | 'landmark';
  readonly glyph: BuildingGlyph;
  readonly label: string;
  /** Ticker, agency abbreviation or initials — what goes on the flag. */
  readonly badge: string;
  readonly caption: string;
  /**
   * What a head office's company does. Public in every jurisdiction the game
   * models, so it is on the map. `null` for a landmark or an agency, which are
   * places rather than businesses.
   */
  readonly sector: Sector | null;
  readonly districtId: DistrictId;
  /** Centre of the footprint. */
  readonly x: number;
  /** Ground line the building stands on. */
  readonly baseY: number;
  readonly width: number;
  readonly height: number;
  readonly isPlayer: boolean;
  readonly target: MapTarget;
  readonly ariaLabel: string;
}

export interface MapMarker {
  readonly eventId: string;
  readonly title: string;
  readonly districtId: DistrictId;
  readonly x: number;
  readonly y: number;
  readonly tone: Tone;
  readonly severity: number;
  readonly ariaLabel: string;
}

export interface NarrativeBanner {
  readonly narrative: DominantNarrative;
  readonly label: string;
  readonly line: string;
  readonly tone: Tone;
  readonly attention: number;
  readonly controversy: number;
  readonly institutionalTrust: number;
}

export interface MapOverlays {
  /** 0 = accelerators are abundant, 1 = nothing is available at any price. */
  readonly computeTightness: number;
  readonly computeBand: string;
  readonly computeTone: Tone;
  /** 0 = calm borders, 1 = blocs are actively cutting each other off. */
  readonly tension: number;
  readonly tensionBand: string;
  readonly tensionTone: Tone;
  readonly banner: NarrativeBanner;
}

export interface WorldMapModel {
  readonly buildings: readonly MapBuilding[];
  readonly markers: readonly MapMarker[];
  readonly overlays: MapOverlays;
  /** Companies that had no plot left in their district, named so the UI can say so. */
  readonly unplaced: readonly string[];
  /** Public events, in the order their markers were assigned. */
  readonly events: readonly WorldEvent[];
}

/* -------------------------------------------------------------------------- */
/*  Where a thing belongs                                                      */
/* -------------------------------------------------------------------------- */

/** Sector to district. A company stands where its business physically is. */
const DISTRICT_FOR_SECTOR: Readonly<Record<string, DistrictId>> = {
  semiconductors: 'datacentre',
  cloud_infrastructure: 'datacentre',
  frontier_models: 'campus',
  data_services: 'campus',
  enterprise_software: 'financial',
  consumer_ai: 'media',
  defence_tech: 'capitol',
  energy_infrastructure: 'port',
};

/** Fallback when a company carries a sector the map has never heard of. */
const DISTRICT_FOR_ARCHETYPE: Readonly<Record<string, DistrictId>> = {
  frontier_lab: 'campus',
  data: 'campus',
  chip_maker: 'datacentre',
  cloud: 'datacentre',
  infrastructure: 'datacentre',
  enterprise_ai: 'financial',
  consumer_ai: 'media',
  defence_ai: 'capitol',
};

export function districtForCompany(company: Partial<Company>): DistrictId {
  const bySector = company.sectorId === undefined ? undefined : DISTRICT_FOR_SECTOR[company.sectorId];
  if (bySector !== undefined) return bySector;
  const byArchetype = company.archetype === undefined ? undefined : DISTRICT_FOR_ARCHETYPE[company.archetype];
  return byArchetype ?? 'financial';
}

/**
 * Event type to district: the thematic location a happening belongs at.
 *
 * Compute shocks land in the Flats, rulemaking in the Federal Quarter, funding
 * weather at the Exchange, anything about the border on the Reach.
 */
const DISTRICT_FOR_EVENT: Readonly<Record<WorldEventType, DistrictId>> = {
  compute_supply_shock: 'datacentre',
  compute_demand_shock: 'datacentre',
  fab_disruption: 'datacentre',
  cyber_incident: 'datacentre',
  infrastructure_outage: 'datacentre',
  energy_price_shock: 'port',
  grid_constraint: 'port',
  supply_chain_disruption: 'port',
  trade_dispute: 'port',
  macro_shift: 'financial',
  credit_event: 'financial',
  capital_market_shift: 'financial',
  fund_collapse: 'financial',
  ipo_window_change: 'financial',
  consolidation_wave: 'financial',
  corporate_scandal: 'financial',
  regulatory_action: 'capitol',
  export_control: 'capitol',
  antitrust_investigation: 'capitol',
  copyright_ruling: 'capitol',
  privacy_enforcement: 'capitol',
  litigation: 'capitol',
  standards_change: 'capitol',
  immigration_change: 'capitol',
  procurement_programme: 'capitol',
  grant_programme: 'capitol',
  defence_mobilisation: 'capitol',
  model_breakthrough: 'campus',
  open_source_release: 'campus',
  benchmark_result: 'campus',
  research_disappointment: 'campus',
  safety_incident: 'campus',
  talent_shock: 'campus',
  labour_action: 'campus',
  data_licensing_shift: 'campus',
  geopolitical_escalation: 'frontier',
  sanctions_change: 'frontier',
  media_cycle: 'media',
  public_backlash: 'media',
  other: 'media',
};

export function districtForEvent(event: WorldEvent): DistrictId {
  return DISTRICT_FOR_EVENT[event.type] ?? 'media';
}

/* -------------------------------------------------------------------------- */
/*  Size                                                                       */
/* -------------------------------------------------------------------------- */

const MIN_TOWER_HEIGHT = 40;
const MAX_TOWER_HEIGHT = 88;

/** Silhouette height when there is no public valuation to scale from. */
const TIER_HEIGHT: Readonly<Record<CompanyTier, number>> = {
  major: 62,
  significant: 50,
  background: 42,
};

/**
 * How tall a head office stands.
 *
 * Market capitalisation spans five orders of magnitude across a session, so the
 * scale is logarithmic between $100M and $3T. Below the floor every company is
 * the same small tower; above the ceiling every company is the same tall one.
 * A `null` capitalisation means "no public figure exists", and the tier
 * baseline stands in — never a guess at the private number.
 */
export function towerHeight(marketCapUsd: number | null, tier: CompanyTier): number {
  if (marketCapUsd === null || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return TIER_HEIGHT[tier];
  const low = Math.log10(100_000_000);
  const high = Math.log10(3_000_000_000_000);
  const t = Math.min(1, Math.max(0, (Math.log10(marketCapUsd) - low) / (high - low)));
  return Math.round(MIN_TOWER_HEIGHT + t * (MAX_TOWER_HEIGHT - MIN_TOWER_HEIGHT));
}

/** Footprint width. Taller towers are slightly broader; nothing is a needle. */
export function towerWidth(height: number): number {
  return Math.round(34 + (height - MIN_TOWER_HEIGHT) * 0.16);
}

/** A stable index into a palette, derived from an entity id. Never random. */
export function pickIndex(id: string, salt: string, length: number): number {
  if (length <= 0) return 0;
  return Number.parseInt(fnv1a64(`${salt}:${id}`).slice(-8), 16) % length;
}

/** Two or three letters for a flag when a company has no ticker. */
export function initialsOfName(name: string): string {
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '??';
  if (words.length === 1) return (words[0] ?? '').slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => (word[0] ?? '').toUpperCase())
    .join('');
}

/* -------------------------------------------------------------------------- */
/*  Overlays                                                                   */
/* -------------------------------------------------------------------------- */

const NARRATIVE_LABEL: Readonly<Record<DominantNarrative, string>> = {
  ai_optimism: 'AI optimism',
  productivity_miracle: 'Productivity miracle',
  bubble_concern: 'Bubble concern',
  safety_alarm: 'Safety alarm',
  labour_disruption: 'Labour disruption',
  concentration_backlash: 'Concentration backlash',
  geopolitical_race: 'Geopolitical race',
  energy_backlash: 'Energy backlash',
  scandal_cycle: 'Scandal cycle',
  neutral: 'No dominant story',
};

const NARRATIVE_LINE: Readonly<Record<DominantNarrative, string>> = {
  ai_optimism: 'The press is writing the industry up. Launches read as vision.',
  productivity_miracle: 'Coverage is about output per worker, and it is flattering.',
  bubble_concern: 'Every raise is being priced against the last one, sceptically.',
  safety_alarm: 'Incidents lead. The same launch reads as reckless this quarter.',
  labour_disruption: 'The story is jobs, and the industry is the antagonist.',
  concentration_backlash: 'Scale itself is the accusation. Size draws scrutiny.',
  geopolitical_race: 'Coverage frames the industry as a contest between blocs.',
  energy_backlash: 'Datacentre power draw is the front page, not the footnote.',
  scandal_cycle: 'The newsroom is hunting. A leak becomes a story quickly.',
  neutral: 'No single frame dominates. Events are reported on their merits.',
};

const NARRATIVE_TONE: Readonly<Record<DominantNarrative, Tone>> = {
  ai_optimism: 'gain',
  productivity_miracle: 'gain',
  bubble_concern: 'warn',
  safety_alarm: 'loss',
  labour_disruption: 'warn',
  concentration_backlash: 'warn',
  geopolitical_race: 'info',
  energy_backlash: 'warn',
  scandal_cycle: 'loss',
  neutral: 'neutral',
};

/** Five-step band label for a 0..1 reading. */
function band(value: number, labels: readonly [string, string, string, string, string]): string {
  const index = Math.min(4, Math.max(0, Math.floor(value * 5)));
  return labels[index] ?? labels[0];
}

/**
 * How tight compute is, on one number.
 *
 * Accelerator supply is the binding constraint and carries most of the weight;
 * managed cloud capacity is the release valve and carries the rest. Both are
 * "relative to demand", so 1 minus the blend reads as scarcity.
 */
export function computeTightnessOf(world: WorldState): number {
  const blend = world.compute.acceleratorSupply * 0.62 + world.compute.cloudCapacity * 0.38;
  return Math.min(1, Math.max(0, 1 - blend));
}

/** The four geopolitical variables, averaged. One storm, four causes. */
export function tensionOf(world: WorldState): number {
  const geo = world.geopolitics;
  return Math.min(1, Math.max(0, (geo.tradeFriction + geo.conflictRisk + geo.sanctions + geo.techCompetition) / 4));
}

export function buildOverlays(world: WorldState): MapOverlays {
  const computeTightness = computeTightnessOf(world);
  const tension = tensionOf(world);
  const narrative = world.media.dominantNarrative;
  return {
    computeTightness,
    computeBand: band(computeTightness, ['Abundant', 'Comfortable', 'Balanced', 'Tight', 'Critical']),
    computeTone: computeTightness >= 0.7 ? 'loss' : computeTightness >= 0.45 ? 'warn' : 'gain',
    tension,
    tensionBand: band(tension, ['Calm', 'Watchful', 'Strained', 'Hostile', 'Rupture']),
    tensionTone: tension >= 0.7 ? 'loss' : tension >= 0.45 ? 'warn' : 'info',
    banner: {
      narrative,
      label: NARRATIVE_LABEL[narrative],
      line: NARRATIVE_LINE[narrative],
      tone: NARRATIVE_TONE[narrative],
      attention: world.media.attentionLevel,
      controversy: world.media.controversyIntensity,
      institutionalTrust: world.media.institutionalTrust,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  District readings                                                          */
/* -------------------------------------------------------------------------- */

export interface Reading {
  readonly label: string;
  readonly value: number;
  /** `unit` selects the formatter the drawer uses. */
  readonly unit: 'share' | 'index' | 'rate';
  readonly hint: string;
  /** 0..100 for a meter, or null when a meter would mislead. */
  readonly meter: number | null;
}

const share = (label: string, value: number, hint: string): Reading => ({
  label,
  value,
  unit: 'share',
  hint,
  meter: value * 100,
});
const index = (label: string, value: number, hint: string): Reading => ({ label, value, unit: 'index', hint, meter: null });
const rate = (label: string, value: number, hint: string): Reading => ({ label, value, unit: 'rate', hint, meter: null });

/** What a district's parcel says when it is tapped. Read straight off the world. */
export function districtReadings(world: WorldState, id: DistrictId): readonly Reading[] {
  switch (id) {
    case 'datacentre':
      return [
        share('Accelerator supply', world.compute.acceleratorSupply, 'Global supply relative to demand. Below 0.5 is a shortage.'),
        share('Cloud capacity', world.compute.cloudCapacity, 'Managed training and inference capacity relative to demand.'),
        index('Spot price', world.compute.spotPrice, 'One accelerator-hour, where 1.00 is the session baseline.'),
        index('Reserved price', world.compute.reservedPrice, 'Multi-quarter reserved capacity, same baseline.'),
        share('Fab capacity', world.compute.fabCapacity, 'Leading-edge fabrication and advanced packaging. Slow to add.'),
        share('Grid draw', world.compute.energyDemand, 'Share of grid capacity consumed by datacentres.'),
      ];
    case 'port':
      return [
        index('Electricity price', world.energy.electricityPrice, 'Industrial power index, 1.00 is baseline.'),
        share('Siting access', world.energy.datacentreAccess, 'Ease of securing siting, interconnection and permits.'),
        share('Clean generation', world.energy.renewableCapacity, 'Share of usable generation that is renewable or nuclear.'),
        share('Grid constraint', world.energy.gridConstraint, 'Severity of transmission bottlenecks. 1 means the grid binds.'),
        share('Trade friction', world.geopolitics.tradeFriction, 'Tariffs and barriers on the hardware that lands here.'),
      ];
    case 'financial':
      return [
        share('Risk appetite', world.capitalMarkets.riskAppetite, 'Willingness to fund unprofitable growth.'),
        share('IPO window', world.capitalMarkets.ipoWindow, 'Below 0.3 a listing usually fails or prices badly.'),
        share('Venture liquidity', world.capitalMarkets.ventureLiquidity, 'Availability of private growth capital.'),
        index('Sector multiples', world.capitalMarkets.sectorMultiples, '1.00 is the long-run average; 2.50 is a bubble.'),
        share('Debt availability', world.capitalMarkets.debtAvailability, 'Lender willingness to extend corporate credit.'),
        rate('Policy rate', world.macro.policyRate, 'Central bank rate. Drives debt cost and discount rates.'),
        rate('Credit spreads', world.macro.creditSpreads, 'Corporate spread over the policy rate.'),
      ];
    case 'capitol':
      return [
        share('Model rules', world.regulation.modelRules, 'Stringency of frontier training, evaluation and release rules.'),
        share('Antitrust', world.regulation.antitrust, 'Intensity of competition enforcement.'),
        share('Safety obligations', world.regulation.safetyObligations, 'Mandatory evaluation, audit and incident reporting.'),
        share('Export controls', world.regulation.exportControls, 'Controls on exporting models, weights and accelerators.'),
        share('Procurement budget', world.government.procurementBudget, 'Size of the public AI budget. Drives how many notices open.'),
        share('Defence urgency', world.government.defenceUrgency, 'Political urgency behind national-security programmes.'),
        share('Grant funding', world.government.grantFunding, 'Availability of non-dilutive research funding.'),
      ];
    case 'campus':
      return [
        share('Frontier capability', world.aiFrontier.frontierCapability, 'The best publicly demonstrated model in the world.'),
        share('Training efficiency', world.aiFrontier.trainingEfficiency, 'Capability bought per unit of compute.'),
        share('Open-weight gap', world.aiFrontier.openSourceGap, '0 means open weights have caught the closed frontier.'),
        index('Inference cost', world.aiFrontier.inferenceCost, 'Cost to serve frontier-quality inference, 1.00 baseline.'),
        share('Researcher supply', world.talent.researcherSupply, 'Availability of frontier research talent.'),
        share('Engineer supply', world.talent.engineerSupply, 'Availability of senior infrastructure engineering talent.'),
        share('Data availability', world.dataDomain.dataAvailability, 'High-quality training and evaluation corpora.'),
      ];
    case 'media':
      return [
        share('Attention', world.media.attentionLevel, 'Share of the news cycle the industry occupies.'),
        share('Controversy', world.media.controversyIntensity, 'Heat of the cycle. High values turn leaks into stories.'),
        share('Institutional trust', world.media.institutionalTrust, 'Low trust makes rumours travel further than corrections.'),
        share('Public AI trust', world.society.aiTrust, 'General trust in AI systems and the companies building them.'),
        share('Automation anxiety', world.society.automationAnxiety, 'Fear of displacement. Feeds regulation and hostile coverage.'),
        share('Consumer sentiment', world.society.consumerSentiment, 'Appetite to buy AI products.'),
      ];
    case 'frontier':
      return [
        share('Trade friction', world.geopolitics.tradeFriction, 'Tariffs, restrictions and non-tariff barriers.'),
        share('Conflict risk', world.geopolitics.conflictRisk, 'Probability weight of supply-disrupting conflict.'),
        share('Sanctions', world.geopolitics.sanctions, 'Breadth of regimes constraining who may buy and partner.'),
        share('Tech competition', world.geopolitics.techCompetition, 'Raises defence procurement and export controls together.'),
        share('Immigration access', world.talent.immigrationAccess, 'Ease of hiring across the border.'),
      ];
    default:
      return [];
  }
}

/**
 * One reading, rendered.
 *
 * Shares and rates go through `formatPct` like every other percentage in the
 * game. An index is not a percentage and not money — it is a multiple of the
 * session baseline — so it renders as `1.62×` at two decimals, which is how the
 * world state itself describes it.
 */
export function formatReading(reading: Reading): string {
  if (reading.unit === 'index') return formatMultiple(reading.value);
  return formatPct(reading.value);
}

/** `frontier_models` -> `Frontier models`. Enum keys are never shown raw. */
export function humaniseToken(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Builder                                                                    */
/* -------------------------------------------------------------------------- */

export interface WorldMapInput {
  readonly view: PlayerView;
  /** The session's public register of government buyers. */
  readonly agencies: readonly Agency[];
  /**
   * The player's own market capitalisation. Their own company, their own
   * figure — the only valuation on the map that is not read from a quote.
   */
  readonly playerMarketCap: number;
}

/** A company we can actually draw: identity is the minimum. */
interface PlacedCompany {
  readonly id: string;
  readonly name: string;
  readonly badge: string;
  readonly tier: CompanyTier;
  readonly isPublic: boolean;
  readonly capUsd: number | null;
  readonly districtId: DistrictId;
  readonly city: string;
  readonly sector: Sector;
  readonly isPlayer: boolean;
}

/** The last quoted capitalisation of an instrument, or null. Public by nature. */
function quotedCap(quotes: readonly Quote[], instrumentId: string | null): number | null {
  if (instrumentId === null) return null;
  let best: Quote | null = null;
  for (const quote of quotes) {
    if (quote.instrumentId !== instrumentId) continue;
    if (best === null || quote.quarter > best.quarter) best = quote;
  }
  if (best === null || best.marketCapUsd <= 0) return null;
  return best.marketCapUsd;
}

function companyAria(entry: PlacedCompany, districtName: string): string {
  const listing = entry.isPublic ? `listed as ${entry.badge}` : 'privately held';
  return `${entry.name}, ${SECTOR_META[entry.sector].label}, ${listing}, ${districtName}. Opens the company profile.`;
}

export function buildWorldMapModel({ view, agencies, playerMarketCap }: WorldMapInput): WorldMapModel {
  const quotes = view.quotes;
  const own = view.ownCompany;

  /* --- companies -------------------------------------------------------- */

  const rivals: PlacedCompany[] = [];
  for (const rival of view.visibleCompanies) {
    if (rival.id === undefined || rival.name === undefined) continue;
    if (rival.isActive === false) continue;
    const isPublic = rival.isPublic === true;
    rivals.push({
      id: rival.id,
      name: rival.name,
      badge: rival.ticker ?? initialsOfName(rival.name),
      tier: rival.tier ?? 'background',
      isPublic,
      // A quote is public. A private rival's anchor is not, so it stays null
      // and the tier baseline draws the silhouette instead.
      capUsd: isPublic ? quotedCap(quotes, rival.instrumentId ?? null) : null,
      districtId: districtForCompany(rival),
      city: rival.headquartersCity ?? 'Undisclosed',
      sector: sectorOf(rival),
      isPlayer: false,
    });
  }

  const player: PlacedCompany = {
    id: own.id,
    name: own.name,
    badge: own.ticker ?? initialsOfName(own.name),
    tier: own.tier,
    isPublic: own.isPublic,
    capUsd: playerMarketCap > 0 ? playerMarketCap : null,
    districtId: districtForCompany(own),
    city: own.headquartersCity,
    sector: sectorOf(own),
    isPlayer: true,
  };

  // Stable order: the player takes the first company plot in their district,
  // everyone else follows by id. Sorting by id rather than by size means a
  // quarter that changes the league table does not move the city around.
  const companies = [player, ...rivals.slice().sort((a, b) => a.id.localeCompare(b.id))];

  /* --- placement -------------------------------------------------------- */

  const buildings: MapBuilding[] = [];
  const unplaced: string[] = [];

  // Two passes, so a crowded district cannot silently drop a company off the
  // map. Everyone takes a plot in their own district first, in the stable
  // company order; whoever is left over takes the first free plot anywhere,
  // scanning districts in map order. Both passes are order-driven and use no
  // randomness, so the same quarter always builds the same city.
  const freePlots = new Map<DistrictId, Plot[]>(
    DISTRICTS.map((district) => [district.id, district.plots.filter((entry) => entry.use === 'company')] as const),
  );
  const taken = new Map<DistrictId, number>();
  /** Plot → whoever stands on it. Keyed by the plot object, which is a constant. */
  const plotOwner = new Map<Plot, PlacedCompany>();
  const overflow: PlacedCompany[] = [];

  function claim(districtId: DistrictId): Plot | null {
    const plots = freePlots.get(districtId);
    if (plots === undefined) return null;
    const index = taken.get(districtId) ?? 0;
    const at = plots[index];
    if (at === undefined) return null;
    taken.set(districtId, index + 1);
    return at;
  }

  for (const entry of companies) {
    const at = claim(entry.districtId);
    if (at === null) overflow.push(entry);
    else plotOwner.set(at, entry);
  }

  for (const entry of overflow) {
    let placed = false;
    for (const district of DISTRICTS) {
      const at = claim(district.id);
      if (at === null) continue;
      plotOwner.set(at, entry);
      placed = true;
      break;
    }
    if (!placed) unplaced.push(entry.name);
  }

  for (const district of DISTRICTS) {
    const landmarkPlots = district.plots.filter((entry) => entry.use === 'landmark');
    const companyPlots = district.plots.filter((entry) => entry.use === 'company');

    const landmarks: readonly LandmarkSeed[] =
      district.id === 'capitol'
        ? agencies.map((agency) => ({
            id: agency.id,
            name: agency.name,
            caption: agency.shortName,
            glyph: 'civic' as BuildingGlyph,
            width: 66,
            height: 48,
          }))
        : (DISTRICT_LANDMARKS[district.id] ?? []);

    landmarks.forEach((seed, slot) => {
      const at = landmarkPlots[slot];
      if (at === undefined) {
        unplaced.push(seed.name);
        return;
      }
      const isAgency = district.id === 'capitol';
      buildings.push({
        key: seed.id,
        kind: isAgency ? 'agency' : 'landmark',
        glyph: seed.glyph,
        label: seed.name,
        badge: isAgency ? seed.caption : '',
        caption: isAgency ? 'Government buyer' : seed.caption,
        sector: null,
        districtId: district.id,
        x: at.x,
        baseY: at.y,
        width: seed.width,
        height: seed.height,
        isPlayer: false,
        target: isAgency ? { kind: 'agency', agencyId: seed.id } : { kind: 'district', districtId: district.id },
        ariaLabel: isAgency
          ? `${seed.name}. Opens its open procurements.`
          : `${seed.name}, ${seed.caption}, ${district.name}. Opens the district reading.`,
      });
    });

    // Emitted in plot order — back row first — so the skyline layers correctly
    // however the two placement passes filled the district.
    for (const at of companyPlots) {
      const entry = plotOwner.get(at);
      if (entry === undefined) continue;
      const height = towerHeight(entry.capUsd, entry.tier);
      buildings.push({
        key: entry.id,
        kind: 'company',
        glyph: 'tower',
        label: entry.name,
        badge: entry.badge,
        caption: entry.city,
        sector: entry.sector,
        districtId: district.id,
        x: at.x,
        baseY: at.y,
        width: towerWidth(height),
        height,
        isPlayer: entry.isPlayer,
        target: { kind: 'company', companyId: entry.id },
        ariaLabel: companyAria(entry, district.name),
      });
    }
  }

  /* --- event markers ---------------------------------------------------- */

  const buildingByCompany = new Map(
    buildings.filter((entry) => entry.kind === 'company').map((entry) => [entry.key, entry] as const),
  );

  const publicEvents = view.activeEvents
    .filter((event) => event.visibility === 'public')
    .slice()
    .sort((a, b) => (b.severity !== a.severity ? b.severity - a.severity : a.id.localeCompare(b.id)));

  const used = new Map<DistrictId, number>();
  const markers: MapMarker[] = [];

  for (const event of publicEvents) {
    const districtId = districtForEvent(event);
    const district = DISTRICT_BY_ID.get(districtId);
    if (district === undefined) continue;

    // A happening that names exactly one company, and that company is on the
    // map, is drawn over its roof. Everything else stacks at its district.
    const named = event.affectedCompanyIds.length === 1 ? (event.affectedCompanyIds[0] ?? null) : null;
    const host = named === null ? undefined : buildingByCompany.get(named);

    let x: number;
    let y: number;
    if (host !== undefined) {
      x = host.x;
      y = host.baseY - host.height - 20;
    } else {
      const taken = used.get(districtId) ?? 0;
      used.set(districtId, taken + 1);
      const offset = MARKER_OFFSETS[taken % MARKER_OFFSETS.length] ?? { x: 0, y: 0 };
      x = district.markerAnchor.x + offset.x;
      y = district.markerAnchor.y + offset.y;
    }

    const tone: Tone = event.severity >= 0.6 ? 'loss' : event.severity >= 0.35 ? 'warn' : 'info';
    markers.push({
      eventId: event.id,
      title: event.title,
      districtId,
      x,
      y,
      tone,
      severity: event.severity,
      ariaLabel: `${event.title}, ${district.name}. Opens the event.`,
    });
  }

  return {
    buildings,
    markers,
    overlays: buildOverlays(view.world),
    unplaced,
    events: publicEvents,
  };
}

/**
 * The world, as fixed geography.
 *
 * Every coordinate in the World Map lives in this file, and every one of them
 * is a constant. There is no layout algorithm, no force simulation and no
 * randomness: a district is where it is because it is written down here, so two
 * renders — and two players — see the same coastline forever.
 *
 * The place is fictional on purpose. It is a stylised bay: one mainland carved
 * into six districts, one island across a strait (the Northern Reach, which is
 * where geopolitical weather lands), and open water on the eastern side. It is
 * not, and must never become, a map of anywhere real.
 *
 * ### How a district is drawn
 *
 * A district owns a **parcel** (a rounded rectangle of land) and an ordered
 * list of **plots**. Plots are listed back row first, so painting them in order
 * yields a correct skyline: a building on a back plot is drawn before, and
 * therefore behind, the buildings in front of it.
 *
 * Each plot declares what it is for. `landmark` plots take the district's fixed
 * civic and industrial sites (and, in the Federal Quarter, the session's
 * agencies); `company` plots take head offices. Nothing is ever placed on a
 * plot of the other kind, so a busy quarter cannot push the capitol into the
 * sea.
 */

/** The design canvas. Fixed, so a tap target is a tap target at every width. */
export const MAP_STAGE = { width: 1120, height: 560 } as const;

export const DISTRICT_IDS = ['campus', 'capitol', 'media', 'datacentre', 'financial', 'port', 'frontier'] as const;
export type DistrictId = (typeof DISTRICT_IDS)[number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Parcel {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What a plot may hold. A plot never changes its use. */
export type PlotUse = 'landmark' | 'company';

export interface Plot extends Point {
  readonly use: PlotUse;
}

/** The flat-vector silhouettes the map knows how to draw. */
export type BuildingGlyph =
  | 'tower'
  | 'civic'
  | 'lab'
  | 'archive'
  | 'exchange'
  | 'mast'
  | 'datacentre'
  | 'fab'
  | 'port'
  | 'grid'
  | 'border'
  | 'terminal';

/** A fixed site: scenery that is also a control into its district's reading. */
export interface LandmarkSeed {
  readonly id: string;
  readonly name: string;
  readonly caption: string;
  readonly glyph: BuildingGlyph;
  readonly width: number;
  readonly height: number;
}

export interface DistrictGeography {
  readonly id: DistrictId;
  /** The place, as it is named on the map. */
  readonly name: string;
  /** What the place is, in three or four words. */
  readonly label: string;
  /** One sentence for the drawer, saying what the district stands for. */
  readonly blurb: string;
  readonly parcel: Parcel;
  /** Back row first. Paint in order and the skyline layers correctly. */
  readonly plots: readonly Plot[];
  /** Where event markers for this district start stacking. */
  readonly markerAnchor: Point;
}

const plot = (x: number, y: number, use: PlotUse): Plot => ({ x, y, use });

/* -------------------------------------------------------------------------- */
/*  Land                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The mainland. A single soft blob with a generous margin around every parcel,
 * so no district ever overhangs the shore.
 */
export const MAINLAND_PATH =
  'M 26 196 C 26 130 74 84 146 76 C 300 60 480 74 640 66 C 740 61 812 108 820 196 ' +
  'C 828 288 826 386 818 452 C 810 520 748 552 664 552 C 470 552 268 550 154 540 ' +
  'C 66 532 24 480 22 402 C 20 330 22 262 26 196 Z';

/** The Northern Reach: a second landmass across the strait. */
export const ISLAND_PATH =
  'M 866 160 C 860 108 900 58 966 44 C 1036 30 1090 70 1096 130 ' +
  'C 1102 194 1086 254 1042 284 C 998 314 928 306 894 270 C 868 242 870 200 866 160 Z';

/** Arterial roads. Decorative, drawn between the parcels, never over them. */
export const ROAD_PATHS: readonly string[] = [
  'M 62 344 L 814 344',
  'M 336 128 L 336 534',
  'M 590 128 L 590 534',
];

/** The strait crossing. Dashed, because it is a ferry lane rather than a road. */
export const STRAIT_CROSSING_PATH = 'M 818 236 C 848 224 868 210 892 198';

/** The weather front that sits over the strait when tension runs hot. */
export const STORM_EDGE_PATH = 'M 838 52 C 856 150 850 262 828 366';

/** Small flat trees and parks, purely to break the grid up. */
export const GREEN_SPOTS: readonly Point[] = [
  { x: 74, y: 128 },
  { x: 358, y: 120 },
  { x: 546, y: 122 },
  { x: 748, y: 118 },
  { x: 70, y: 470 },
  { x: 470, y: 540 },
  { x: 700, y: 534 },
  { x: 800, y: 300 },
];

/* -------------------------------------------------------------------------- */
/*  Districts                                                                  */
/* -------------------------------------------------------------------------- */

export const DISTRICTS: readonly DistrictGeography[] = [
  {
    id: 'campus',
    name: 'Cascade Research Belt',
    label: 'Laboratories and archives',
    blurb:
      'Where capability is made and where the corpora live. The frontier reading, training efficiency, the open-weight gap and the supply of people who can move any of them.',
    parcel: { x: 96, y: 168, w: 224, h: 150 },
    plots: [
      plot(164, 254, 'landmark'),
      plot(252, 254, 'landmark'),
      plot(138, 296, 'company'),
      plot(208, 296, 'company'),
      plot(278, 296, 'company'),
      // The front row. Staggered between the back row so a full district reads
      // as a skyline rather than as a grid, and set on the parcel's kerb line,
      // which still clears the tallest tower's headroom.
      plot(173, 318, 'company'),
      plot(243, 318, 'company'),
    ],
    markerAnchor: { x: 286, y: 198 },
  },
  {
    id: 'capitol',
    name: 'Federal Quarter',
    label: 'Agencies and rulemaking',
    blurb:
      'Rulemaking on one side of the square, buying on the other. Everything here is public by construction: the statutes, the budgets and the notices of what the state intends to purchase.',
    parcel: { x: 352, y: 186, w: 224, h: 150 },
    plots: [
      plot(420, 272, 'landmark'),
      plot(508, 272, 'landmark'),
      plot(394, 314, 'landmark'),
      plot(464, 314, 'company'),
      plot(534, 314, 'company'),
      plot(429, 336, 'company'),
      plot(499, 336, 'company'),
    ],
    markerAnchor: { x: 542, y: 216 },
  },
  {
    id: 'media',
    name: 'Beacon Hill',
    label: 'The newsroom quarter',
    blurb:
      'One mast, one story at a time. The dominant narrative decides how the same launch reads — visionary on a good week, reckless on a bad one — and the public mood decides who believes it.',
    parcel: { x: 604, y: 158, w: 200, h: 160 },
    plots: [
      plot(664, 254, 'landmark'),
      plot(744, 254, 'company'),
      plot(642, 296, 'company'),
      plot(704, 296, 'company'),
      plot(766, 296, 'company'),
      plot(673, 318, 'company'),
      plot(735, 318, 'company'),
    ],
    markerAnchor: { x: 770, y: 188 },
  },
  {
    id: 'datacentre',
    name: 'Meridian Flats',
    label: 'Datacentres and fabs',
    blurb:
      'The compute domain, standing up in sheds. Accelerator supply, cloud capacity, the spot and reserved price of an accelerator-hour, and the leading-edge capacity that takes quarters to add.',
    parcel: { x: 96, y: 352, w: 224, h: 150 },
    plots: [
      plot(164, 438, 'landmark'),
      plot(252, 438, 'landmark'),
      plot(138, 480, 'company'),
      plot(208, 480, 'company'),
      plot(278, 480, 'company'),
      plot(173, 502, 'company'),
      plot(243, 502, 'company'),
    ],
    markerAnchor: { x: 286, y: 382 },
  },
  {
    id: 'financial',
    name: 'Harbourgate Exchange',
    label: 'Capital and listings',
    blurb:
      'Risk appetite, the listing window, private liquidity and what a dollar of revenue is worth this quarter. Nothing here is about what a company is; everything is about what it can raise.',
    parcel: { x: 352, y: 362, w: 224, h: 156 },
    plots: [
      plot(420, 454, 'landmark'),
      plot(508, 454, 'company'),
      plot(394, 496, 'company'),
      plot(464, 496, 'company'),
      plot(534, 496, 'company'),
      plot(429, 518, 'company'),
      plot(499, 518, 'company'),
    ],
    markerAnchor: { x: 542, y: 392 },
  },
  {
    id: 'port',
    name: 'Tidewater',
    label: 'Port, grid and generation',
    blurb:
      'Where the hardware lands and where the power comes from. Electricity price, siting access, clean generation and the interconnection queue that decides whether a new hall can be built at all.',
    parcel: { x: 604, y: 352, w: 194, h: 144 },
    plots: [
      plot(666, 432, 'landmark'),
      plot(740, 432, 'landmark'),
      plot(642, 474, 'company'),
      plot(702, 474, 'company'),
      plot(762, 474, 'company'),
      plot(672, 496, 'company'),
      plot(732, 496, 'company'),
    ],
    markerAnchor: { x: 764, y: 382 },
  },
  {
    id: 'frontier',
    name: 'Northern Reach',
    label: 'The border region',
    blurb:
      'The other side of the strait. Trade friction, sanctions, conflict risk and the strategic competition that raises export controls and defence budgets at the same time.',
    parcel: { x: 896, y: 96, w: 168, h: 150 },
    plots: [
      plot(952, 182, 'landmark'),
      plot(1008, 182, 'landmark'),
      plot(930, 224, 'company'),
      plot(980, 224, 'company'),
      plot(1030, 224, 'company'),
    ],
    markerAnchor: { x: 1030, y: 126 },
  },
];

export const DISTRICT_BY_ID: ReadonlyMap<DistrictId, DistrictGeography> = new Map(
  DISTRICTS.map((district) => [district.id, district] as const),
);

/* -------------------------------------------------------------------------- */
/*  Fixed sites                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The landmarks each district holds, in plot order.
 *
 * The Federal Quarter is the exception: its landmark plots are filled from
 * `session.agencies`, because the agencies are the civic buildings there.
 */
export const DISTRICT_LANDMARKS: Readonly<Record<DistrictId, readonly LandmarkSeed[]>> = {
  campus: [
    { id: 'site_cascade_institute', name: 'Cascade Institute', caption: 'Frontier research', glyph: 'lab', width: 64, height: 46 },
    { id: 'site_corpus_archive', name: 'Open Corpus Archive', caption: 'Training data', glyph: 'archive', width: 56, height: 50 },
  ],
  capitol: [],
  media: [{ id: 'site_beacon_mast', name: 'Beacon Hill Mast', caption: 'The news cycle', glyph: 'mast', width: 44, height: 74 }],
  datacentre: [
    { id: 'site_flats_hall', name: 'Meridian Flats Hall', caption: 'Accelerator capacity', glyph: 'datacentre', width: 74, height: 40 },
    { id: 'site_northpoint_fab', name: 'Northpoint Fab', caption: 'Leading-edge packaging', glyph: 'fab', width: 66, height: 52 },
  ],
  financial: [{ id: 'site_exchange', name: 'The Exchange', caption: 'Listings and liquidity', glyph: 'exchange', width: 72, height: 52 }],
  port: [
    { id: 'site_container_port', name: 'Tidewater Port', caption: 'Hardware imports', glyph: 'port', width: 76, height: 50 },
    { id: 'site_grid_substation', name: 'Tidewater Grid', caption: 'Generation and interconnection', glyph: 'grid', width: 66, height: 62 },
  ],
  frontier: [
    { id: 'site_border_post', name: 'Reach Border Post', caption: 'Customs and controls', glyph: 'border', width: 58, height: 40 },
    { id: 'site_strait_terminal', name: 'Strait Terminal', caption: 'Cross-border transit', glyph: 'terminal', width: 54, height: 44 },
  ],
};

/* -------------------------------------------------------------------------- */
/*  Marker stacking                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where the nth marker in a district sits, relative to the district anchor.
 *
 * Six fixed offsets, cycled. Two events in one district never land on the same
 * pixel, and the same two events land in the same two places next render.
 */
export const MARKER_OFFSETS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: -36, y: 0 },
  { x: 0, y: 34 },
  { x: -36, y: 34 },
  { x: -72, y: 0 },
  { x: -72, y: 34 },
];

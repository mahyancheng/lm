/**
 * The sheet registry: five tabs, and every drill-down addressed by `?sheet=`.
 *
 * The game used to be twenty-two routes behind a tab bar, a sub-tab strip and
 * a hamburger. It is now five scrolling pages of cards, and everything that
 * used to be a route is a sheet over the tab that owns it. A sheet is a URL —
 * `/company?sheet=financials` — so Back closes it, a deep link opens it, and
 * every old address still resolves.
 *
 * This module is pure: no React, no runtime import of the icon set or of the
 * action union (both are type-only), so a test may import it without pulling a
 * client component or the engine into the graph.
 */

import type { ActionType } from '@frontier/contracts';
import type { IconName } from '../components/ui/icons';

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/** The five pages. Everything else in the game is a sheet over one of them. */
export type TabId = 'home' | 'company' | 'market' | 'world' | 'play';

/** The route of a tab. The only paths the bottom bar and the rail ever link to. */
export function tabPath(tab: TabId): string {
  return `/${tab}`;
}

/* -------------------------------------------------------------------------- */
/*  Sheets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every drill-down, by id.
 *
 * The ids are the *subject*, not the old route: `exchange` rather than
 * `markets`, `deals` rather than `deal-room`, `resolution` rather than
 * `quarter-resolution`. `LEGACY_ROUTES` maps the old names onto these.
 */
export type SheetId =
  // Company
  | 'company'
  | 'group'
  | 'products'
  | 'people'
  | 'research'
  | 'government'
  | 'financials'
  // Market
  | 'exchange'
  | 'capital'
  | 'portfolio'
  | 'street'
  | 'deals'
  | 'boardroom'
  // World
  | 'news'
  | 'social'
  | 'network'
  | 'leaderboard'
  | 'sector'
  // Play
  | 'resolution'
  | 'chief-of-staff';

export interface SheetMeta {
  /** The tab this sheet opens over. A sheet on the wrong tab is redirected. */
  readonly tab: TabId;
  /** The sheet header. The moved screen bodies no longer carry a title of their own. */
  readonly title: string;
  /** One line, used by the desktop rail and by a tab's stub card. */
  readonly blurb: string;
  /** The mark the old screen was named by, kept so nothing has to be relearned. */
  readonly icon: IconName;
}

export const SHEETS: Readonly<Record<SheetId, SheetMeta>> = {
  /* --- Company ---------------------------------------------------------- */
  company: {
    tab: 'company',
    title: 'Company',
    blurb: 'Operating structure, subsidiaries, offices, reputation.',
    icon: 'building',
  },
  group: {
    tab: 'company',
    title: 'Group',
    blurb: 'Consolidated revenue, cash, debt and market value across every company you direct.',
    icon: 'boardTable',
  },
  products: {
    tab: 'company',
    title: 'Products',
    blurb: 'Who supplies each input, who buys the output, what each side pays.',
    icon: 'box',
  },
  people: {
    tab: 'company',
    title: 'People',
    blurb: 'Employees, executives, culture, compensation.',
    icon: 'people',
  },
  research: {
    tab: 'company',
    title: 'Research',
    // The world-3 subtitle the route header used to carry.
    blurb: 'What you hold, what is one programme away, and what it would let you sell.',
    icon: 'flask',
  },
  government: {
    tab: 'company',
    title: 'Government',
    blurb: 'Opportunities, bids, active contracts, compliance.',
    icon: 'capitol',
  },
  financials: {
    tab: 'company',
    title: 'Financials',
    blurb: 'P&L, balance sheet, cash flow, segment results.',
    icon: 'ledger',
  },

  /* --- Market ----------------------------------------------------------- */
  exchange: {
    tab: 'market',
    title: 'Markets',
    blurb: 'In-world exchange, ownership, reference tape.',
    icon: 'chart',
  },
  capital: {
    tab: 'market',
    title: 'Capital',
    blurb: 'Funding, debt, treasury, cap table, runway.',
    icon: 'coins',
  },
  portfolio: {
    tab: 'market',
    title: 'Portfolio',
    blurb: 'Subsidiaries, stakes, shorts and funds held outside the company.',
    icon: 'portfolio',
  },
  street: {
    tab: 'market',
    title: 'The Street',
    blurb: 'Funds, their dry powder, their offers and their short books.',
    icon: 'briefcase',
  },
  deals: {
    tab: 'market',
    title: 'Deal Room',
    blurb: 'M&A, licensing, partnerships, negotiations.',
    icon: 'handshake',
  },
  boardroom: {
    tab: 'market',
    title: 'Boardroom',
    blurb: 'Agenda, directors, votes, governance.',
    icon: 'boardTable',
  },

  /* --- World ------------------------------------------------------------ */
  news: {
    tab: 'world',
    title: 'News',
    blurb: 'The universal public record, and the living map.',
    icon: 'newspaper',
  },
  social: {
    tab: 'world',
    title: 'Social',
    blurb: 'Synthetic social networks, PR, marketing.',
    icon: 'chat',
  },
  network: {
    tab: 'world',
    title: 'Network',
    blurb: 'Investors, founders, officials, directors, journalists.',
    icon: 'network',
  },
  leaderboard: {
    tab: 'world',
    title: 'Leaderboard',
    blurb: 'Session rankings and the power network.',
    icon: 'trophy',
  },
  sector: {
    tab: 'world',
    title: 'Sector',
    blurb: 'The six-sector chain, goods prices, market share and freight tolls.',
    icon: 'globe',
  },

  /* --- Play ------------------------------------------------------------- */
  resolution: {
    tab: 'play',
    title: 'Quarter Resolution',
    blurb: 'Exactly what changed last quarter, and why.',
    icon: 'newspaper',
  },
  'chief-of-staff': {
    tab: 'play',
    title: 'Chief of Staff',
    blurb: 'Conversational control interface: interpret, propose, confirm.',
    icon: 'briefcase',
  },
};

const SHEET_IDS: readonly SheetId[] = Object.keys(SHEETS) as SheetId[];

/** Every sheet id, in registry order. */
export function allSheetIds(): readonly SheetId[] {
  return SHEET_IDS;
}

/** The sheets a tab owns, in registry order. */
export function sheetsOfTab(tab: TabId): readonly SheetId[] {
  return SHEET_IDS.filter((id) => SHEETS[id].tab === tab);
}

function isSheetId(value: string): value is SheetId {
  return Object.prototype.hasOwnProperty.call(SHEETS, value);
}

/* -------------------------------------------------------------------------- */
/*  Addresses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The well-known extra params a sheet reads.
 *
 * `hash` is not a query param: it becomes the fragment, which is how a sheet
 * is opened scrolled to one of its sections (`?sheet=people#headcount`).
 */
export interface SheetParams {
  readonly line?: string;
  readonly item?: string;
  readonly target?: string;
  readonly section?: string;
  readonly edition?: string;
  readonly hash?: string;
  readonly [key: string]: string | undefined;
}

/** `sheet` leads, then everything else in sorted order, so an href is stable. */
function queryOf(sheet: SheetId | null, params: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  if (sheet !== null) parts.push(`sheet=${encodeURIComponent(sheet)}`);
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

function fragmentOf(hash: string | undefined): string {
  if (hash === undefined || hash === '') return '';
  return hash.startsWith('#') ? hash : `#${hash}`;
}

/** `/company?sheet=financials`, or with params, `/company?sheet=people#headcount`. */
export function sheetHref(sheet: SheetId, params?: SheetParams): string {
  const rest: Record<string, string> = {};
  let hash: string | undefined;
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (key === 'hash') hash = value;
    else if (key !== 'sheet') rest[key] = value;
  }
  return `${tabPath(SHEETS[sheet].tab)}${queryOf(sheet, rest)}${fragmentOf(hash)}`;
}

/** The sheet a search string names, or null when it names nothing this app knows. */
export function sheetFrom(search: string | URLSearchParams | null | undefined): SheetId | null {
  if (search === null || search === undefined) return null;
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const value = params.get('sheet');
  if (value === null) return null;
  return isSheetId(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/*  The twenty-two old routes                                                  */
/* -------------------------------------------------------------------------- */

export interface LegacyRoute {
  readonly tab: TabId;
  /** null where the old screen became a tab rather than a sheet. */
  readonly sheet: SheetId | null;
}

/**
 * Every address the game used to have.
 *
 * Nothing is dropped: an old link, a bookmark and a saved screenshot all land
 * on the tab that owns the subject with the right sheet open. `[...legacy]`
 * redirects on arrival; `legacyHref` rewrites in-app links before they are
 * followed.
 */
export const LEGACY_ROUTES: Readonly<Record<string, LegacyRoute>> = {
  '/command-centre': { tab: 'home', sheet: null },
  '/company': { tab: 'company', sheet: 'company' },
  '/group': { tab: 'company', sheet: 'group' },
  '/products': { tab: 'company', sheet: 'products' },
  '/sector': { tab: 'world', sheet: 'sector' },
  '/people': { tab: 'company', sheet: 'people' },
  '/financials': { tab: 'company', sheet: 'financials' },
  '/research': { tab: 'company', sheet: 'research' },
  '/government': { tab: 'company', sheet: 'government' },
  '/deal-room': { tab: 'market', sheet: 'deals' },
  '/markets': { tab: 'market', sheet: 'exchange' },
  '/capital': { tab: 'market', sheet: 'capital' },
  '/portfolio': { tab: 'market', sheet: 'portfolio' },
  '/street': { tab: 'market', sheet: 'street' },
  '/boardroom': { tab: 'market', sheet: 'boardroom' },
  '/news': { tab: 'world', sheet: 'news' },
  '/social': { tab: 'world', sheet: 'social' },
  '/network': { tab: 'world', sheet: 'network' },
  '/leaderboard': { tab: 'world', sheet: 'leaderboard' },
  '/chief-of-staff': { tab: 'play', sheet: 'chief-of-staff' },
  '/end-quarter': { tab: 'play', sheet: null },
  '/quarter-resolution': { tab: 'play', sheet: 'resolution' },
};

/** `/markets/ABC?x=1` → `/markets`. Empty for the landing page. */
export function firstSegmentOf(pathname: string): string {
  const clean = pathname.split('?')[0]?.split('#')[0] ?? '';
  const segment = clean.split('/').filter((part) => part.length > 0)[0];
  return segment === undefined ? '' : `/${segment}`;
}

/** The old route this pathname belongs to, or null. */
export function legacyRouteOf(pathname: string): LegacyRoute | null {
  return LEGACY_ROUTES[firstSegmentOf(pathname)] ?? null;
}

/**
 * Rewrite one href.
 *
 * Query and fragment survive: `/news?section=world` becomes
 * `/world?sheet=news&section=world`, and `/people#headcount` becomes
 * `/company?sheet=people#headcount`. Anything that is not an old route — a
 * tab, an auth page, an external URL — is returned untouched, so this is safe
 * to wrap around every link in the app.
 *
 * An address that already names a sheet is already new, and is returned
 * untouched even where its first segment is also an old route. `/company` and
 * `/sector` are both a tab path and a legacy path, so without this guard
 * `legacyHref('/company?sheet=financials')` would rewrite a correct address
 * into `/company?sheet=company`.
 */
export function legacyHref(href: string): string {
  if (!href.startsWith('/')) return href;
  const hashAt = href.indexOf('#');
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const withoutHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const search = queryAt < 0 ? '' : withoutHash.slice(queryAt + 1);
  const pathname = queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt);

  if (sheetFrom(search) !== null) return href;

  const route = LEGACY_ROUTES[firstSegmentOf(pathname)];
  if (route === undefined) return href;

  const rest: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key !== 'sheet') rest[key] = value;
  }
  return `${tabPath(route.tab)}${queryOf(route.sheet, rest)}${hash}`;
}

/* -------------------------------------------------------------------------- */
/*  Where an action is done by hand                                            */
/* -------------------------------------------------------------------------- */

/**
 * The sheet a founder queues this instruction on themselves.
 *
 * `null` means there is no by-hand surface: the Chief of Staff is the only way
 * to ask for it. Those eleven are named on the Play tab rather than given
 * eleven new panels — see `CHIEF_ONLY_ACTIONS`.
 *
 * The `Record<ActionType, …>` is the point: adding an action type to the
 * contracts enum is a type error here until someone decides where it is done.
 */
export const SHEET_OF_ACTION: Readonly<Record<ActionType, SheetId | null>> = {
  set_research_budget: 'research',
  start_research_project: 'research',
  adjust_research_project: 'research',
  abandon_research_project: null,
  propose_innovation: 'research',
  publish_research: 'research',
  set_product_price: 'products',
  launch_product: 'products',
  set_data_policy: 'products',
  license_node: null,
  publish_licence_terms: null,
  sunset_product: 'products',
  // Marketing is a line's budget, set beside the line — not a social post.
  set_marketing_budget: 'products',
  marketing_campaign: null,
  hire: 'people',
  layoff: 'people',
  poach_executive: 'people',
  appoint_executive: 'people',
  reserve_compute: null,
  buy_cloud_capacity: null,
  buy_accelerators: 'company',
  invest_capacity: null,
  // Compute is allocated to programmes, and the programmes are on Research.
  allocate_compute: 'research',
  set_supply_terms: 'products',
  choose_supplier: 'products',
  fill_slot: 'products',
  set_target_market: 'products',
  raise_round: 'capital',
  issue_debt: 'capital',
  buyback: 'capital',
  issue_shares: null,
  ipo: null,
  set_dividend_policy: 'capital',
  // A freight toll is an economy decision, taken on the sector chain.
  set_logistics_toll: 'sector',
  buy_shares: 'exchange',
  sell_shares: 'exchange',
  acquire_company: 'deals',
  submit_board_proposal: 'boardroom',
  lobby_director: 'boardroom',
  bid_government: 'government',
  decline_opportunity: 'government',
  form_consortium: 'government',
  meet_regulator: 'government',
  social_post: 'social',
  give_guidance: null,
  respond_crisis: null,
  propose_deal: 'deals',
  accept_deal: 'deals',
  reject_deal: 'deals',
  request_introduction: 'network',
  // Group control has its own consolidated surface now.
  transfer_between_group: 'group',
  merge_subsidiary: 'group',
};

/**
 * The eleven instructions only the Chief of Staff can queue.
 *
 * Written out rather than derived, so the list is a decision a human made and
 * `sheetRegistry.test.ts` can hold it to the null entries above.
 */
export const CHIEF_ONLY_ACTIONS: readonly ActionType[] = [
  'marketing_campaign',
  'reserve_compute',
  'buy_cloud_capacity',
  'issue_shares',
  'ipo',
  'give_guidance',
  'respond_crisis',
  'invest_capacity',
  'abandon_research_project',
  'license_node',
  'publish_licence_terms',
];

/** Where this instruction is queued by hand, or null when nowhere. */
export function hrefOfAction(type: ActionType): string | null {
  const sheet = SHEET_OF_ACTION[type];
  return sheet === null ? null : sheetHref(sheet);
}

/**
 * What the Chief of Staff is asked from where the founder is standing.
 *
 * The dock opens over whatever is on screen, so the two prompts that are always
 * there — "explain these numbers" and "what should I do here?" — mean something
 * different over Capital than over People. The third and fourth are the
 * subject's own: the questions a founder looking at it actually has.
 *
 * **Context is a sheet id, or the tab when no sheet is open.** The game used to
 * be twenty-two routes and this table was keyed by pathname; it is now five tabs
 * with every drill-down addressed by `?sheet=`, so the key is the subject rather
 * than the address. An old pathname still resolves — `[...legacy]` takes a frame
 * to redirect off one, and the dock is mounted for that frame — through
 * `legacyRouteOf`, which is the same map the redirect uses.
 *
 * Pure and total: an unknown context falls back to the general pair rather than
 * offering nothing, because a drawer with no prompts on it is a blank box.
 */

import { SHEETS, firstSegmentOf, legacyRouteOf, type SheetId } from '@/lib/sheets';
import { TABS, tabFor } from '@/lib/nav';

/** One tappable prompt. `send` is what is actually put to the model. */
export interface QuickPrompt {
  /** What the button says. Short enough for a 390px row. */
  readonly label: string;
  /** The message sent, written as the founder would type it. */
  readonly send: string;
}

/** The two that are always offered, phrased so the model knows what is on screen. */
function universalFor(label: string): QuickPrompt[] {
  return [
    { label: 'Explain these numbers', send: `Explain the numbers on the ${label} screen. What is each one, and which of them should I be worried about?` },
    { label: 'What should I do here?', send: `What should I do on the ${label} screen this quarter? Only suggest things this company can actually do right now.` },
  ];
}

interface PromptSet {
  readonly label: string;
  readonly own: readonly QuickPrompt[];
}

/**
 * The subject's own questions, keyed by sheet id and by tab id.
 *
 * `company` is deliberately one entry serving both: the Company tab and the
 * Company sheet are the same subject, and two sets of words for it would drift.
 */
const BY_CONTEXT: Readonly<Record<string, PromptSet>> = {
  /* --- the five tabs ----------------------------------------------------- */
  home: {
    label: 'Home',
    own: [
      { label: 'How are we doing?', send: 'How are we doing this quarter? Give me the two figures that matter most and say why.' },
      { label: 'What needs deciding?', send: 'What needs deciding this quarter, and what happens if I do nothing?' },
    ],
  },
  market: {
    label: 'Market',
    own: [
      { label: 'Who is coming for us?', send: 'Who is coming for us — holders, short sellers, activists, open approaches — and what would their first move be?' },
      { label: 'Is the price fair?', send: 'Is our valuation fair against what the business is actually doing, and what would close the gap?' },
    ],
  },
  world: {
    label: 'World',
    own: [
      { label: 'What changed out there?', send: 'What changed in the world this quarter — the record, the press cycle, the economy — and which of it touches this company?' },
      { label: 'Where do we stand?', send: 'Where do I stand against the other founders right now, and what would move me up fastest?' },
    ],
  },
  play: {
    label: 'Play',
    own: [
      { label: 'Check my queue', send: 'Look at what I have queued this quarter. Is anything missing, contradictory, or unaffordable?' },
      { label: 'What have I forgotten?', send: 'What have I forgotten to do this quarter?' },
    ],
  },

  /* --- the sheets -------------------------------------------------------- */
  company: {
    label: 'Company',
    own: [
      { label: 'Is our compute right?', send: 'Is our compute holding right for what we are trying to do, and is anything about to lapse?' },
      { label: 'What is our posture?', send: 'What posture are we holding, and does it still match our position?' },
    ],
  },
  financials: {
    label: 'Financials',
    own: [
      { label: 'How much runway?', send: 'How much runway have we got, and what is the single biggest thing consuming it?' },
      { label: 'Where is margin going?', send: 'What has happened to our gross margin over the filed quarters, and what caused it?' },
    ],
  },
  products: {
    label: 'Products',
    own: [
      { label: 'Best and worst line', send: 'Which is our best product line and which is our worst, and what would you do about the worst one?' },
      { label: 'Should we reprice?', send: 'Should we reprice anything this quarter? Tell me the bounds on any change before you propose it.' },
      { label: 'What could we launch?', send: 'What product lines could we launch right now in our own industry, and what is each locked one waiting on?' },
      { label: 'Who builds on us?', send: 'Which of our published lines does anyone else build on, and what would cutting them off do to them?' },
    ],
  },
  people: {
    label: 'People',
    own: [
      { label: 'Can we afford to hire?', send: 'Can we afford to hire, and how many, at what band? Use the bounds, not an estimate.' },
      { label: 'Is morale a problem?', send: 'Is morale a problem, and what is it costing us in attrition?' },
    ],
  },
  capital: {
    label: 'Capital',
    own: [
      { label: 'Should we raise?', send: 'Should we raise this quarter? Say plainly whether we can, what it would need, and what it would cost in dilution.' },
      { label: 'Who is circling us?', send: 'Who is circling us — funds, activists, open approaches — and what do they want?' },
    ],
  },
  research: {
    label: 'Research',
    own: [
      { label: 'Is research paying?', send: 'Is our research spend paying for itself? What are the live programmes and how confident is the team?' },
      { label: 'What should we start?', send: 'What should we start next on the Frontier Map, given the researchers and compute we actually have?' },
    ],
  },
  exchange: {
    label: 'Markets',
    own: [
      { label: 'Why has the price moved?', send: 'Why has our share price moved, and does it reflect anything real about the business?' },
      { label: 'How do we compare?', send: 'How do we compare with the rivals we can see, on revenue and on standing?' },
    ],
  },
  boardroom: {
    label: 'Boardroom',
    own: [
      { label: 'What is before the board?', send: 'What is before the board, and how is it likely to go?' },
      { label: 'Is my control safe?', send: 'How much of the company do I hold, which thresholds have I crossed, and is my control at risk?' },
    ],
  },
  government: {
    label: 'Government',
    own: [
      { label: 'Should we bid?', send: 'Should we bid on anything open? Say plainly whether we are even eligible before you propose one.' },
      { label: 'How is our record?', send: 'How is our past-performance record, and what is it costing us in the bids we can enter?' },
    ],
  },
  deals: {
    label: 'Deal Room',
    own: [
      { label: 'Anything to answer?', send: 'Is there a deal awaiting an answer, and what would accepting it commit us to?' },
      { label: 'Who should we approach?', send: 'Who should we approach with a deal, and what would we be offering them?' },
    ],
  },
  news: {
    label: 'News',
    own: [
      { label: 'What matters to us?', send: 'Of everything in the public record, what actually matters to this company and why?' },
      { label: 'Do we need to respond?', send: 'Is there anything running publicly we need to respond to?' },
    ],
  },
  street: {
    label: 'The Street',
    own: [
      { label: 'Who owns us?', send: 'Who owns us, and how much dry powder do they still have?' },
      { label: 'Are we a target?', send: 'Are we a target for anybody on this screen, and what would the first move look like?' },
    ],
  },
  network: {
    label: 'Network',
    own: [
      { label: 'Who should I meet?', send: 'Who should I be trying to meet, and who could actually introduce me?' },
      { label: 'Who matters to us?', send: 'Which of the people I can reach matter most to this company right now?' },
    ],
  },
  social: {
    label: 'Social',
    own: [
      { label: 'Should I post?', send: 'Should I post anything this quarter, and what would it be about?' },
      { label: 'Is marketing right?', send: 'Is our marketing split right for where our revenue actually comes from?' },
    ],
  },
  resolution: {
    label: 'Quarter Resolution',
    own: [
      { label: 'What actually happened?', send: 'Walk me through what actually happened last quarter, worst news first, and cite the lines you are reading.' },
      { label: 'Why did that move?', send: 'Which single line in this report explains the biggest change to our position, and what caused it?' },
    ],
  },
  'chief-of-staff': {
    label: 'Chief of Staff',
    own: [
      { label: 'What would you do?', send: 'If you were running this company this quarter, what would you do, in order, and why?' },
      { label: 'What am I missing?', send: 'What am I missing about our position right now that I have not asked you about?' },
    ],
  },
};

/** The general set, for a subject with nothing of its own to ask. */
const GENERAL: readonly QuickPrompt[] = [
  { label: 'How are we doing?', send: 'How are we doing? Give me cash, runway and the one thing you would change.' },
  { label: 'What needs deciding?', send: 'What needs deciding this quarter?' },
];

/** Normalise a pathname to its first segment, the way the legacy map keys it. */
export function routeKeyOf(pathname: string): string {
  const segment = firstSegmentOf(pathname);
  return segment === '' ? '/' : segment;
}

/**
 * The subject a question is about: the open sheet, else the tab, else the old
 * route the address still names. Empty when it is none of those.
 */
export function contextKeyOf(pathname: string, sheet?: SheetId | null): string {
  if (sheet !== null && sheet !== undefined) return sheet;
  const legacy = legacyRouteOf(pathname);
  if (legacy !== null) return legacy.sheet ?? legacy.tab;
  return tabFor(pathname)?.id ?? '';
}

/** The name of a context, from its own set or from the registry. Null when unknown. */
function labelOfKey(key: string): string | null {
  const entry = BY_CONTEXT[key];
  if (entry !== undefined) return entry.label;
  if (Object.prototype.hasOwnProperty.call(SHEETS, key)) return SHEETS[key as SheetId].title;
  return TABS.find((tab) => tab.id === key)?.label ?? null;
}

/** What the dock calls the thing it is being asked about, e.g. "asking about Financials". */
export function screenLabelFor(pathname: string, sheet?: SheetId | null): string {
  return labelOfKey(contextKeyOf(pathname, sheet)) ?? 'this';
}

/**
 * The prompts to offer: the two universals first, then the subject's own. Four
 * is the most a phone drawer can show without scrolling before anything is
 * typed.
 */
export function quickPromptsFor(pathname: string, sheet?: SheetId | null): QuickPrompt[] {
  const key = contextKeyOf(pathname, sheet);
  const entry = BY_CONTEXT[key];
  if (entry === undefined) return [...universalFor(labelOfKey(key) ?? 'current'), ...GENERAL];
  return [...universalFor(entry.label), ...entry.own];
}

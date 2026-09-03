/**
 * What the Chief of Staff is asked from each screen.
 *
 * The drawer opens over whatever the founder is looking at, so the two prompts
 * that are always there — "explain this screen's numbers" and "what should I do
 * here?" — mean something different on Capital than they do on People. The
 * third and fourth are the screen's own: the questions a founder standing on
 * that screen actually has.
 *
 * Pure and total: an unknown route falls back to the general set rather than
 * offering nothing, because a drawer with no prompts on it is a blank box.
 */

/** One tappable prompt. `send` is what is actually put to the model. */
export interface QuickPrompt {
  /** What the button says. Short enough for a 390px row. */
  readonly label: string;
  /** The message sent, written as the founder would type it. */
  readonly send: string;
}

/** The two that are on every screen, phrased so the model knows which screen. */
function universalFor(label: string): QuickPrompt[] {
  return [
    { label: 'Explain these numbers', send: `Explain the numbers on the ${label} screen. What is each one, and which of them should I be worried about?` },
    { label: 'What should I do here?', send: `What should I do on the ${label} screen this quarter? Only suggest things this company can actually do right now.` },
  ];
}

/** Screen-specific questions, keyed by route. */
const BY_ROUTE: Readonly<Record<string, { readonly label: string; readonly own: readonly QuickPrompt[] }>> = {
  '/command-centre': {
    label: 'Command Centre',
    own: [
      { label: 'How are we doing?', send: 'How are we doing this quarter? Give me the two figures that matter most and say why.' },
      { label: 'What needs deciding?', send: 'What needs deciding this quarter, and what happens if I do nothing?' },
    ],
  },
  '/financials': {
    label: 'Financials',
    own: [
      { label: 'How much runway?', send: 'How much runway have we got, and what is the single biggest thing consuming it?' },
      { label: 'Where is margin going?', send: 'What has happened to our gross margin over the filed quarters, and what caused it?' },
    ],
  },
  '/products': {
    label: 'Products',
    own: [
      { label: 'Best and worst line', send: 'Which is our best product line and which is our worst, and what would you do about the worst one?' },
      { label: 'Should we reprice?', send: 'Should we reprice anything this quarter? Tell me the bounds on any change before you propose it.' },
    ],
  },
  '/people': {
    label: 'People',
    own: [
      { label: 'Can we afford to hire?', send: 'Can we afford to hire, and how many, at what band? Use the bounds, not an estimate.' },
      { label: 'Is morale a problem?', send: 'Is morale a problem, and what is it costing us in attrition?' },
    ],
  },
  '/capital': {
    label: 'Capital',
    own: [
      { label: 'Should we raise?', send: 'Should we raise this quarter? Say plainly whether we can, what it would need, and what it would cost in dilution.' },
      { label: 'Who is circling us?', send: 'Who is circling us — funds, activists, open approaches — and what do they want?' },
    ],
  },
  '/research': {
    label: 'Research',
    own: [
      { label: 'Is research paying?', send: 'Is our research spend paying for itself? What are the live programmes and how confident is the team?' },
      { label: 'What should we start?', send: 'What should we start next on the Frontier Map, given the researchers and compute we actually have?' },
    ],
  },
  '/markets': {
    label: 'Markets',
    own: [
      { label: 'Why has the price moved?', send: 'Why has our share price moved, and does it reflect anything real about the business?' },
      { label: 'How do we compare?', send: 'How do we compare with the rivals we can see, on revenue and on standing?' },
    ],
  },
  '/boardroom': {
    label: 'Boardroom',
    own: [
      { label: 'What is before the board?', send: 'What is before the board, and how is it likely to go?' },
      { label: 'Is my control safe?', send: 'How much of the company do I hold, which thresholds have I crossed, and is my control at risk?' },
    ],
  },
  '/government': {
    label: 'Government',
    own: [
      { label: 'Should we bid?', send: 'Should we bid on anything open? Say plainly whether we are even eligible before you propose one.' },
      { label: 'How is our record?', send: 'How is our past-performance record, and what is it costing us in the bids we can enter?' },
    ],
  },
  '/deal-room': {
    label: 'Deal Room',
    own: [
      { label: 'Anything to answer?', send: 'Is there a deal awaiting an answer, and what would accepting it commit us to?' },
      { label: 'Who should we approach?', send: 'Who should we approach with a deal, and what would we be offering them?' },
    ],
  },
  '/company': {
    label: 'Company',
    own: [
      { label: 'Is our compute right?', send: 'Is our compute holding right for what we are trying to do, and is anything about to lapse?' },
      { label: 'What is our posture?', send: 'What posture are we holding, and does it still match our position?' },
    ],
  },
  '/news': {
    label: 'News',
    own: [
      { label: 'What matters to us?', send: 'Of everything in the public record, what actually matters to this company and why?' },
      { label: 'Do we need to respond?', send: 'Is there anything running publicly we need to respond to?' },
    ],
  },
  '/street': {
    label: 'The Street',
    own: [
      { label: 'Who owns us?', send: 'Who owns us, and how much dry powder do they still have?' },
      { label: 'Are we a target?', send: 'Are we a target for anybody on this screen, and what would the first move look like?' },
    ],
  },
  '/end-quarter': {
    label: 'End Quarter',
    own: [
      { label: 'Check my queue', send: 'Look at what I have queued this quarter. Is anything missing, contradictory, or unaffordable?' },
      { label: 'What have I forgotten?', send: 'What have I forgotten to do this quarter?' },
    ],
  },
  '/network': {
    label: 'Network',
    own: [
      { label: 'Who should I meet?', send: 'Who should I be trying to meet, and who could actually introduce me?' },
      { label: 'Who matters to us?', send: 'Which of the people I can reach matter most to this company right now?' },
    ],
  },
  '/social': {
    label: 'Social',
    own: [
      { label: 'Should I post?', send: 'Should I post anything this quarter, and what would it be about?' },
      { label: 'Is marketing right?', send: 'Is our marketing split right for where our revenue actually comes from?' },
    ],
  },
};

/** The general set, for a screen with nothing of its own to ask. */
const GENERAL: readonly QuickPrompt[] = [
  { label: 'How are we doing?', send: 'How are we doing? Give me cash, runway and the one thing you would change.' },
  { label: 'What needs deciding?', send: 'What needs deciding this quarter?' },
];

/** The label a route is known by, for the prompt text and the drawer header. */
export function screenLabelFor(pathname: string): string {
  return BY_ROUTE[routeKeyOf(pathname)]?.label ?? 'this';
}

/** Normalise a pathname to the route key the table uses. */
export function routeKeyOf(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.length === 0) return '/';
  const first = trimmed.split('/')[1];
  return first === undefined ? '/' : `/${first}`;
}

/**
 * The prompts to offer on one screen: the two universals first, then that
 * screen's own. Four is the most a phone drawer can show without scrolling
 * before the founder has typed anything.
 */
export function quickPromptsFor(pathname: string): QuickPrompt[] {
  const entry = BY_ROUTE[routeKeyOf(pathname)];
  if (entry === undefined) return [...universalFor('current'), ...GENERAL];
  return [...universalFor(entry.label), ...entry.own];
}

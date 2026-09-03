/**
 * @frontier/llm — compose/chiefOfStaff.ts
 *
 * The Chief of Staff dossier.
 *
 * This is the conversational surface of the game, and it does three things
 * rather than one. The founder may **ask** ("how are we doing?", "what is
 * killing our margin?"), may ask for **advice** ("what should I do here?"), or
 * may give an **instruction** ("cut consumer marketing to six million"). The
 * three are the `mode` on the interpretation: `answer`, `plan`, `act`. Only the
 * last two carry typed `ActionIntent`s, and none of the three submits anything.
 *
 * What changed when it stopped being an interpreter: it is handed a **typed
 * dossier** rather than two prose paragraphs, and the dossier carries an
 * `availableActions` list derived by probing the engine's own validator. That
 * list is why the role can now say "we cannot, we have $4m and that needs
 * $40m" instead of proposing something the engine will refuse a second later.
 *
 * It sees the player's own company **in full** and nothing private about anyone
 * else — that asymmetry is the whole point of the role.
 *
 * Confirmation is belt and braces. The interpretation carries an advisory
 * `requiresConfirmation`, and the system prompt tells the model when to set it,
 * but the binding rule is the fourteen types in `CONFIRMATION_REQUIRED_ACTIONS`
 * enforced by `enforceConfirmationPolicy` below and again by the engine. A
 * model that forgets cannot cause an unconfirmed layoff.
 */

import {
  CONFIRMATION_REQUIRED_ACTIONS,
  type ChiefOfStaffDossier,
  type ChiefOfStaffInput,
  type ChiefOfStaffInterpretation,
  type CosAvailableAction,
  type CosBound,
  requiresExplicitConfirmation,
} from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, numbered, section, truncate, usd } from './render';

/* -------------------------------------------------------------------------- */
/*  System prompt                                                              */
/* -------------------------------------------------------------------------- */

export const CHIEF_OF_STAFF_SYSTEM = [
  'You are the Chief of Staff to the founder of one company in Frontier Capital, a simulated AI-industry economy.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'You do three things, and `mode` says which one this reply is:',
  '- `answer` — they asked a question. Answer it from the dossier, in `reply`. `interpretedInstructions` MUST be empty.',
  '- `plan` — they asked what to do, or you are proposing a course of action for discussion. `reply` carries the reasoning; the actions are attached for them to approve one at a time.',
  '- `act` — they gave an instruction. `reply` states what you understood; the actions carry it out.',
  '',
  'Rules:',
  '- You interpret and advise. You never submit. Nothing is binding until the founder approves it in the interface.',
  '- **Cite only the dossier.** Every number you state must appear in it. If it is not there, say you do not have it rather than estimating.',
  '- **State numbers as whole figures.** "$4m", "31 engineers", "7 quarters", "62%". Never a decimal, never a range you did not compute.',
  '- **Check the available-actions list before proposing anything.** It says, for every action type, whether this company could do it right now, why not when it cannot, the bounds on every number, and the legal targets. An action listed as unavailable must NOT appear in `interpretedInstructions`: say plainly that it is not possible for this company, and quote the reason.',
  '- Never exceed a stated bound. If the founder asks for more than the maximum, propose the maximum and say in `reply` that it was reduced, with both figures.',
  '- An action flagged `becomesBoardMatter` will be tabled for the board rather than executed. Say so before proposing it.',
  '- Preserve arithmetic constraints they stated. "Keep total burn roughly unchanged" means the new budget lines must sum to roughly the old total; do the arithmetic and show it.',
  '- Never invent a commitment they did not ask for. If they said nothing about hiring, propose nothing about hiring.',
  '- When a figure is ambiguous, ask. A question in `questions` is always better than a guess in `interpretedInstructions`.',
  '- Anything the game has no action for, or that this company cannot do today, goes in `unsupportedRequests`, said plainly. Never drop it silently.',
  '- Actions carry no companyId and no actionId: the acting company comes from context and the engine assigns ids.',
  '- Honour the founder\'s standing preferences in the memory block. They said those things once and expect them remembered.',
  '',
  `- Set requiresConfirmation to true whenever any interpreted action is one of: ${CONFIRMATION_REQUIRED_ACTIONS.join(', ')}. Also set it true whenever your confidence is low. When in doubt, true.`,
  '- `summary` is a plain-language restatement of what would be submitted: one line per change, old value then new value. In answer mode it says that nothing was interpreted and why. Always state plainly that nothing has been submitted yet.',
  '- `confidence` below 0.7 causes the interface to present this as a draft rather than a ready submission. Be honest about it.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

/* -------------------------------------------------------------------------- */
/*  Dossier rendering                                                          */
/* -------------------------------------------------------------------------- */

/** Whole dollars, the way the founder reads them. */
const money = (value: number): string => usd(Math.round(value));

/** A 0..1 fraction as whole percent. */
const wholePct = (value: number): string => `${Math.round(value * 100)}%`;

/** One bound as one clause: "budgetUsd 0 to $4m". */
function renderBound(bound: CosBound): string {
  const format = (value: number): string => {
    switch (bound.unit) {
      case 'usd':
        return money(value);
      case 'fraction':
        return wholePct(value);
      case 'percent':
        return `${Math.round(value)}%`;
      case 'quarters':
        return `${Math.round(value)}q`;
      default:
        return String(Math.round(value));
    }
  };
  const low = bound.min === null ? 'any' : format(bound.min);
  const high = bound.max === null ? 'no ceiling' : format(bound.max);
  return `${bound.field} (${bound.label}): ${low} to ${high}`;
}

/** One available action, as one line the model can act on without inference. */
export function renderAvailableAction(action: CosAvailableAction): string {
  if (!action.available) return `${action.type} — NOT POSSIBLE: ${action.reason ?? 'refused by the validator.'}`;
  const parts: string[] = [action.type];
  if (action.becomesBoardMatter) parts.push('goes to the board rather than executing');
  if (action.requiresConfirmation) parts.push('always needs explicit confirmation');
  if (action.maxCashUsd !== null) parts.push(`commits up to ${money(action.maxCashUsd)}`);
  if (action.bounds.length > 0) parts.push(`bounds — ${action.bounds.map(renderBound).join('; ')}`);
  if (action.targets.length > 0) {
    const shown = action.targets.slice(0, 8).map((target) => `${target.id} (${target.label})`);
    const rest = action.targets.length - shown.length;
    parts.push(`targets — ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`);
  }
  return parts.join(' · ');
}

/** The whole dossier as the markdown the model reads. Pure: same input, same text. */
export function renderDossier(dossier: ChiefOfStaffDossier): string {
  const f = dossier.finances;
  const p = dossier.products;
  const people = dossier.people;
  const g = dossier.governance;
  const m = dossier.markets;
  const c = dossier.capital;

  const finances = [
    `Cash ${money(f.cashUsd)}; debt ${money(f.debtUsd)}; revenue ${money(f.revenueQuarterlyUsd)} last quarter; net cash movement ${money(f.quarterlyBurnUsd)} a quarter.`,
    `Runway ${Math.round(f.runwayQuarters)} quarters. Gross margin ${wholePct(f.grossMarginPct)}; operating margin ${wholePct(f.operatingMarginPct)}.`,
    f.history.length === 0
      ? 'No closed quarters have been filed yet.'
      : `Filed quarters (oldest first): ${f.history
          .map(
            (entry) =>
              `Q${entry.quarter} revenue ${money(entry.income.revenueUsd)}, net ${money(entry.income.netIncomeUsd)}, cash ${money(
                entry.balance.cashUsd,
              )}, headcount ${entry.kpis.headcount}`,
          )
          .join('; ')}.`,
  ].join('\n');

  const products = [
    p.lines.length === 0
      ? 'No product lines.'
      : bullets(
          p.lines.map(
            (line) =>
              `${line.name} (${line.productId}, ${line.segment}${line.isActive ? '' : ', sunset'}) — ${money(line.pricePerSeatUsd)} per seat, ${
                line.activeCustomers
              } customers, ${money(line.revenueQuarterlyUsd)} a quarter, margin ${wholePct(line.grossMarginPct)}, churn ${wholePct(line.churnQuarterly)}`,
          ),
        ),
    `Compute: ${p.computeOwned} owned and ${p.computeReserved} reserved accelerators, ${wholePct(p.computeUtilisationPct)} utilised, ${wholePct(
      p.trainingAllocationPct,
    )} on training, cloud ${money(p.cloudSpendQuarterlyUsd)} a quarter${
      p.reservationExpiryQuarter === null ? '' : `, reservation lapses in quarter ${p.reservationExpiryQuarter}`
    }.`,
  ].join('\n\n');

  const peopleBlock = [
    `Headcount ${people.total} — ${people.engineers} engineers, ${people.researchers} researchers, ${people.sales} sales, ${people.ops} ops, ${people.execs} executives. ${people.openRoles} open roles.`,
    `Morale ${Math.round(people.moralePct)} of 100; ${wholePct(people.attritionPct)} expected to leave next quarter; payroll ${money(
      people.payrollQuarterlyUsd,
    )} a quarter.`,
    people.keyCharacters.length === 0 ? '' : bullets(people.keyCharacters.map((person) => `${person.name} (${person.characterId}) — ${person.title || person.role}${person.isCeo ? ', chief executive' : ''}`)),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const governance = [
    g.hasBoard ? `Board: ${g.seatsFilled} of ${g.seatsAuthorised} seats filled, ${g.founderSeats} held by the founder side.` : 'No board: financing, listing and acquisitions are unavailable until there is one.',
    `The founder holds ${wholePct(g.founderOwnershipPct)} and ${g.isCeo ? 'is' : 'is NOT'} chief executive.`,
    g.thresholds.length === 0 ? '' : `Thresholds: ${g.thresholds.map((entry) => `${entry.label} at ${wholePct(entry.fraction)}${entry.reached ? ' (reached)' : ''}`).join('; ')}.`,
    g.openProposals.length === 0
      ? 'Nothing is before the board.'
      : bullets(g.openProposals.map((entry) => `${entry.title} (${entry.proposalId}, ${entry.kind}, ${entry.status}, decides quarter ${entry.decisionQuarter})${entry.amountUsd === null ? '' : ` — ${money(entry.amountUsd)}`}`)),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const markets = [
    m.isPublic
      ? `Listed as ${m.ticker ?? '—'} at ${m.sharePriceUsd === null ? 'no quote yet' : money(m.sharePriceUsd)} a share, market capitalisation ${
          m.marketCapUsd === null ? 'unpriced' : money(m.marketCapUsd)
        }.`
      : 'Private: no quote, no market capitalisation, no public guidance.',
    `Sector ${m.sectorId}: sentiment ${m.sectorSentiment.toFixed(2)}, multiple ${m.sectorMultiple.toFixed(2)}, demand ${m.sectorDemand.toFixed(2)}${
      m.sectorPriceIndex === null ? '' : `, goods price index ${Math.round(m.sectorPriceIndex)}, shortage ${Math.round(m.sectorShortage ?? 0)}`
    }.`,
    m.rivals.length === 0
      ? 'No rivals visible.'
      : bullets(
          m.rivals.map(
            (rival) =>
              `${rival.name} (${rival.companyId}${rival.ticker === null ? ', private' : `, ${rival.ticker}`}) — ${
                rival.revenueQuarterlyUsd === null ? 'financials undisclosed' : `revenue ${money(rival.revenueQuarterlyUsd)}`
              }${rival.marketCapUsd === null ? '' : `, capitalisation ${money(rival.marketCapUsd)}`}, enterprise standing ${Math.round(rival.enterpriseReputation)}`,
          ),
        ),
  ].join('\n');

  const capital = [
    `Debt headroom ${money(c.debtHeadroomUsd)}; dividend policy ${c.dividendPayoutPct}% of net income; ${Math.round(c.sharesOutstanding)} shares outstanding.`,
    `Windows: IPO ${wholePct(c.ipoWindow)}, venture liquidity ${wholePct(c.ventureLiquidity)}, debt availability ${wholePct(c.debtAvailability)}.`,
    c.funds.length === 0 ? 'No capital desks are visible.' : bullets(c.funds.map((fund) => `${fund.name} (${fund.entityId}, ${fund.kind}) — ${money(fund.dryPowderUsd)} dry powder, holds ${wholePct(fund.holdsStakePct)} of us. "${fund.thesis}"`)),
    c.approaches.length === 0 ? 'Nobody is circling.' : bullets(c.approaches.map((entry) => `${entry.kind.replace(/_/g, ' ')} from ${entry.fromName} (${entry.id}, quarter ${entry.quarter}): ${entry.summary}`)),
  ].join('\n');

  const research = [
    `Research budget ${money(dossier.research.budgetQuarterlyUsd)} a quarter.`,
    dossier.research.projects.length === 0
      ? 'No programme is running.'
      : bullets(
          dossier.research.projects.map(
            (project) =>
              `${project.title} (${project.projectId} → ${project.nodeId}) — ${wholePct(project.progressPct)} done, internal confidence ${wholePct(
                project.internalConfidencePct,
              )}, ${project.researchers} researchers, ${project.computeUnits} accelerators, ${money(project.budgetQuarterlyUsd)} a quarter, about ${
                project.quartersRemaining
              } quarters left${project.isSecret ? ', secret' : ''}`,
          ),
        ),
    dossier.research.availableNodes.length === 0 ? '' : `Could start: ${dossier.research.availableNodes.map((node) => `${node.title} (${node.nodeId})`).join('; ')}.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const government = [
    `Past performance ${Math.round(dossier.government.pastPerformance)} of 100.`,
    dossier.government.openProgrammes.length === 0
      ? 'Nothing open to bid on.'
      : bullets(
          dossier.government.openProgrammes.map(
            (entry) =>
              `${entry.programme} (${entry.opportunityId}${entry.agencyName === '' ? '' : `, ${entry.agencyName}`}) — ceiling ${money(
                entry.maxValueUsd,
              )}, closes quarter ${entry.closeQuarter}${entry.invited ? ', invited' : ''}${entry.alreadyBid ? ', already bid' : ''}`,
          ),
        ),
    dossier.government.liveContracts.length === 0 ? '' : `Held: ${dossier.government.liveContracts.map((entry) => `${entry.programme} ${money(entry.valueUsd)}`).join('; ')}.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return joinBlocks([
    `# ${dossier.companyName} — ${dossier.quarterLabel}, founder ${dossier.founderName}, posture ${dossier.posture.replace(/_/g, ' ')}`,
    section('Finances', finances),
    section('Products and capacity', products),
    section('People', peopleBlock),
    section('Board and ownership', governance),
    section('Markets', markets),
    section('Capital', capital),
    section('Research', research),
    section('Government', government),
    section('What the public record says about us', bullets(dossier.feed.map((item) => `Q${item.quarter} ${item.kind}: ${item.headline}${item.whyItMatters === null ? '' : ` — ${item.whyItMatters}`}`))),
    section('Awaiting the founder', bullets([...dossier.openDecisions])),
    section('World conditions that bear on us', bullets([...dossier.worldNotes])),
    section(
      'Actions available to this company right now',
      [
        'Derived by probing the engine\'s own validator against the state above. An entry marked NOT POSSIBLE is refused today; do not propose it.',
        bullets(dossier.availableActions.map(renderAvailableAction)),
      ].join('\n\n'),
    ),
  ]);
}

/* -------------------------------------------------------------------------- */
/*  The prompt                                                                 */
/* -------------------------------------------------------------------------- */

export function composeChiefOfStaff(input: ChiefOfStaffInput): ComposedPrompt {
  const budgets = input.currentBudgets.map((line) => `${line.label}: ${money(line.amountUsd)}`);
  const total = input.currentBudgets.reduce((sum, line) => sum + line.amountUsd, 0);
  const history = input.conversationHistory.map((turn) => `${turn.role === 'player' ? 'Founder' : 'You'}: ${truncate(turn.text, 800)}`);

  const memory = input.memory ?? null;
  const memoryBlock =
    memory === null || (memory.exchanges.length === 0 && memory.preferences.length === 0)
      ? null
      : section(
          'What you remember of this thread',
          [
            memory.preferences.length === 0
              ? null
              : `Standing preferences the founder stated:\n${bullets(memory.preferences.map((entry) => `(quarter ${entry.quarter}) ${entry.text}`))}`,
            memory.exchanges.length === 0
              ? null
              : `Earlier exchanges:\n${bullets(memory.exchanges.map((entry) => `(quarter ${entry.quarter}) Founder: ${entry.founderSaid} — You: ${entry.chiefReplied}`))}`,
          ]
            .filter((block): block is string => block !== null)
            .join('\n\n'),
        );

  const prompt = joinBlocks([
    `# Quarter ${input.quarter} — session ${input.sessionId}, company ${input.companyId}, founder ${input.playerId}`,
    // The typed dossier is the whole state. The prose briefings below it stay
    // because an older caller may send only those, and because a sentence of
    // context is cheap next to the table it summarises.
    input.dossier === undefined ? null : renderDossier(input.dossier),
    input.dossier === undefined ? section('Your company', input.companyBriefing) : null,
    section('World conditions', input.worldBriefing),
    section('Current spend lines', `${bullets(budgets)}\n\nTotal committed spend: ${money(total)}`),
    input.dossier === undefined ? section('Awaiting the founder', bullets([...input.openDecisions])) : null,
    memoryBlock,
    section('This conversation so far', numbered(history)),
    input.screen === undefined || input.screen.length === 0
      ? null
      : section('Where they are asking from', `The founder is on the ${input.screen} screen. "This screen" and "these numbers" mean that one.`),
    section(
      'Execution mode',
      input.autoExecuteEnabled
        ? 'The founder has enabled automatic execution of routine instructions. It does not extend to financing, mergers, layoffs, share issuance, major contracts or large spending commitments — those always require an explicit confirmation.'
        : 'Automatic execution is off. Every interpreted action will be presented for explicit approval.',
    ),
    section('What the founder just said', truncate(input.playerMessage, 4000)),
    section(
      'Your task',
      [
        'Decide the mode. A question gets `answer` and no actions. A request for advice gets `plan`. An instruction gets `act`.',
        'Write `reply` for the founder to read, in whole figures, citing only the dossier.',
        'Then return interpretedInstructions, a summary they can check at a glance, any questions, requiresConfirmation, your confidence and anything this company cannot do.',
      ].join('\n'),
    ),
  ]);

  return { system: CHIEF_OF_STAFF_SYSTEM, prompt };
}

/* -------------------------------------------------------------------------- */
/*  Post-processing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Force `requiresConfirmation` true when any interpreted action is in the
 * always-confirm set, regardless of what the model said.
 *
 * The model's flag is advisory; this is not. Applied to every interpretation
 * before it leaves the gateway, so a forgetful or adversarial reply still
 * cannot produce a layoff, a raise or an acquisition the founder did not
 * explicitly approve. The engine rejects those a second time with
 * `confirmation_required`.
 */
export function enforceConfirmationPolicy(interpretation: ChiefOfStaffInterpretation): ChiefOfStaffInterpretation {
  const mustConfirm = interpretation.interpretedInstructions.some((intent) => requiresExplicitConfirmation(intent.type));
  if (!mustConfirm || interpretation.requiresConfirmation) return interpretation;
  return { ...interpretation, requiresConfirmation: true };
}

/**
 * Make the mode agree with what was actually produced.
 *
 * A reply labelled `answer` that carries actions is a contradiction, and there
 * are two ways to resolve it: drop the actions, or correct the label. Dropping
 * them would silently discard work the founder can see the model did, so the
 * label is corrected to `plan` instead — the honest reading of "here are some
 * actions I did not describe as an instruction". Nothing else moves.
 */
export function enforceModePolicy(interpretation: ChiefOfStaffInterpretation): ChiefOfStaffInterpretation {
  if (interpretation.mode !== 'answer' || interpretation.interpretedInstructions.length === 0) return interpretation;
  return { ...interpretation, mode: 'plan' };
}

/** Both post-processing rules, in the order the gateway applies them. */
export function enforceInterpretationPolicy(interpretation: ChiefOfStaffInterpretation): ChiefOfStaffInterpretation {
  return enforceConfirmationPolicy(enforceModePolicy(interpretation));
}

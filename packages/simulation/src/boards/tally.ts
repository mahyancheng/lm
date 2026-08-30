/**
 * @frontier/simulation — boards/tally.ts
 *
 * How a board actually votes.
 *
 * A director's stance is engine state throughout. Dialogue never writes a
 * support score; a conversation produces a `ConditionalCommitment` — a
 * structured, expiring, condition-bearing promise — and the engine checks it
 * against the real numbers on the tabled proposal with
 * `commitmentConditionsHold` from `@frontier/contracts`. Negotiation matters
 * because a character has committed to something a machine can verify, not
 * because the prose was persuasive.
 *
 * Each director's position is the sum of four terms:
 *
 * ```text
 * kind economics   what this class of matter does to the company, read through
 *                  their risk tolerance, growth preference and discipline
 * mandate          the constituency they believe they serve
 * loyalty          (1 - independence) x their relationship with the chief executive
 * commitment       an active promise whose conditions hold, weighted by strength
 * ```
 *
 * `tallyProposal` is pure with respect to the draft: it reads state and returns
 * a `BoardTally`. Nothing here mutates, emits or draws a random number.
 */

import type {
  Board,
  BoardProposal,
  BoardProposalKind,
  BoardTally,
  BoardVote,
  Company,
  Director,
  DirectorMandate,
  SessionState,
  StoredCommitment,
  VoteStance,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, commitmentConditionsHold } from '@frontier/contracts';
import { boardById, boardForCompany, centred, clamp, companyById, normalised, ratio, round, unit, usdLabel } from './util';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Beyond this, a director takes a side; inside it they abstain. */
export const SUPPORT_THRESHOLD = 0.12;

/** How strongly a non-independent director follows the chief executive. */
export const LOYALTY_WEIGHT = 0.7;

/** At or above this commitment strength the promise overrides preference outright. */
export const BINDING_COMMITMENT_STRENGTH = 0.8;

/* -------------------------------------------------------------------------- */
/*  Proposal economics                                                         */
/* -------------------------------------------------------------------------- */

export interface ProposalEconomics {
  readonly amountUsd: number | null;
  /** Headline amount against the cash it would consume. */
  readonly sizeStrain: number;
  /** Headline amount against one quarter of payroll, for compensation matters. */
  readonly compStrain: number;
  readonly dilution: number;
  readonly stockComponent: number;
  readonly runwayQuarters: number;
  /** 1 when the company is close to running out of money. */
  readonly survivalPressure: number;
  /** 1 when the company is performing badly enough to cost a chief executive their job. */
  readonly performancePressure: number;
  /** How contested the company's public work is. */
  readonly controversy: number;
  readonly regulatoryStringency: number;
  readonly ipoWindow: number;
  readonly antitrust: number;
}

export function proposalEconomics(draft: SessionState, proposal: BoardProposal, company: Company | null): ProposalEconomics {
  const world = draft.world;
  const metrics = company === null ? undefined : draft.companyMetrics.find((m) => m.companyId === company.id);
  const cash = company === null ? 1 : Math.max(1, company.financials.cash);
  const payroll = company === null ? 1 : Math.max(1, company.financials.payroll);
  const amountUsd = proposal.amountUsd;

  const burn = company === null ? 0 : Math.max(0, -company.financials.quarterlyBurn);
  const derivedRunway = burn <= 0 ? 40 : clamp(cash / burn, 0, 200);
  const runwayQuarters = metrics?.runwayQuarters ?? derivedRunway;

  const operatingMargin = metrics?.operatingMarginPct ?? (company === null ? 0 : ratio(company.financials.revenueQuarterly - company.financials.cogs - company.financials.payroll, Math.max(1, company.financials.revenueQuarterly), 0));
  const growth = metrics?.revenueGrowthYoY ?? 0;

  const controversyFromContracts = company === null
    ? 0
    : draft.governmentContracts
        .filter((c) => c.primeCompanyId === company.id && c.status === 'active')
        .reduce((worst, c) => Math.max(worst, c.publicControversyLevel), 0);

  return {
    amountUsd,
    sizeStrain: amountUsd === null ? 0 : clamp(amountUsd / cash, 0, 2),
    compStrain: amountUsd === null ? 0 : clamp(amountUsd / payroll, 0, 2),
    dilution: unit(proposal.dilutionPct ?? 0),
    stockComponent: unit(proposal.stockComponentPct ?? 0),
    runwayQuarters,
    survivalPressure: unit(1 - clamp(runwayQuarters, 0, 8) / 8),
    performancePressure: unit(0.5 * unit(-operatingMargin) + 0.3 * unit(-growth * 2) + 0.2 * unit(1 - clamp(runwayQuarters, 0, 12) / 12)),
    controversy: unit(0.5 * controversyFromContracts + 0.3 * world.media.controversyIntensity + 0.2 * world.society.automationAnxiety),
    regulatoryStringency: unit(0.5 * world.regulation.modelRules + 0.3 * world.regulation.safetyObligations + 0.2 * world.regulation.antitrust),
    ipoWindow: unit(world.capitalMarkets.ipoWindow),
    antitrust: unit(world.regulation.antitrust),
  };
}

/* -------------------------------------------------------------------------- */
/*  Commitment fields                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The numbers a commitment condition may test, read off the tabled proposal.
 *
 * A field the proposal does not carry is `null`, and `commitmentConditionsHold`
 * treats a missing value as a failure: a promise conditioned on a number nobody
 * supplied has not been met.
 */
export function proposalCommitmentValues(draft: SessionState, proposal: BoardProposal): Record<string, number | null> {
  const company = companyById(draft, proposal.companyId);
  const metrics = company === null ? undefined : draft.companyMetrics.find((m) => m.companyId === company.id);
  const amount = proposal.amountUsd;
  const stock = proposal.stockComponentPct;

  return {
    amountUsd: amount,
    purchasePriceUsd: proposal.kind === 'acquisition' || proposal.kind === 'divestiture' ? amount : null,
    ceoCompUsd: proposal.kind === 'ceo_comp' ? amount : null,
    capexUsd: proposal.kind === 'annual_plan' ? amount : null,
    contractValueUsd: proposal.kind === 'gov_contract' ? amount : null,
    stockComponentPct: stock,
    cashComponentPct: stock === null ? null : 1 - stock,
    dilutionPct: proposal.dilutionPct,
    floatPct: proposal.kind === 'ipo' ? proposal.dilutionPct : null,
    headcountReductionPct: proposal.kind === 'restructuring' ? proposal.dilutionPct : null,
    debtRatePct: null,
    safetyEvaluationQuarters: null,
    governmentRevenueSharePct: metrics?.governmentRevenueShare ?? null,
    runwayQuarters: metrics?.runwayQuarters ?? null,
  };
}

/** Commitments that are live for this proposal and this director. */
export function bindingCommitments(draft: SessionState, proposal: BoardProposal, characterId: string): StoredCommitment[] {
  const values = proposalCommitmentValues(draft, proposal);
  return draft.commitments.filter(
    (c) =>
      c.status === 'active' &&
      c.actorCharacterId === characterId &&
      c.proposalKind === proposal.kind &&
      c.expiresQuarter >= proposal.decisionQuarter &&
      (c.targetCompanyId === null || c.targetCompanyId === proposal.targetCompanyId || c.targetCompanyId === proposal.companyId) &&
      commitmentConditionsHold(c.conditions, values),
  );
}

/* -------------------------------------------------------------------------- */
/*  Director stance                                                            */
/* -------------------------------------------------------------------------- */

const MANDATE_BIAS: Record<DirectorMandate, Partial<Record<BoardProposalKind, number>>> = {
  founder_vision: { acquisition: 0.05, financing: 0.05, model_release: 0.1, restructuring: -0.1, ceo_dismissal: -0.35, ipo: -0.05 },
  investor_return: { ipo: 0.25, buyback: 0.15, acquisition: 0.05, ceo_comp: -0.1, ceo_dismissal: 0.15, divestiture: 0.1 },
  independent_oversight: { ceo_comp: -0.15, model_release: -0.05, gov_contract: -0.05, ceo_dismissal: 0.05, annual_plan: 0.05 },
  employee_voice: { restructuring: -0.3, ceo_comp: -0.25, ipo: -0.05, buyback: -0.1, csuite_appointment: 0.05 },
  public_interest: { model_release: -0.2, gov_contract: -0.15, ceo_comp: -0.15, acquisition: -0.1 },
  strategic_partner: { acquisition: 0.15, gov_contract: 0.1, financing: 0.05, divestiture: -0.05 },
  government_liaison: { gov_contract: 0.3, model_release: -0.1, ipo: -0.05, acquisition: -0.05 },
};

export interface DirectorAssessment {
  readonly characterId: string;
  /** Position on a -1..1 scale before the commitment override. */
  readonly preference: number;
  /** Position after any binding commitment. */
  readonly value: number;
  readonly stance: VoteStance;
  readonly recused: boolean;
  readonly honouredCommitmentId: string | null;
  readonly rationale: string;
}

function kindScore(kind: BoardProposalKind, director: Director, economics: ProposalEconomics): number {
  const risk = normalised(director.riskTolerance);
  const growth = centred(director.growthPreference);
  const discipline = normalised(director.financialDiscipline);
  const disciplineC = centred(director.financialDiscipline);
  const tech = centred(director.techKnowledge);
  const safety = normalised(director.safetyOrientation);
  const independence = centred(director.independence);
  const e = economics;

  switch (kind) {
    case 'annual_plan':
      return 0.25 + 0.35 * growth - 0.45 * e.sizeStrain * (0.5 + 0.5 * discipline) + 0.3 * e.survivalPressure * disciplineC;
    case 'financing':
      return 0.15 + 0.4 * growth + 0.9 * e.survivalPressure - 1.1 * e.dilution * (0.4 + 0.8 * discipline) - 0.35 * (1 - risk) * e.sizeStrain;
    case 'acquisition':
      return (
        0.1 + 0.45 * growth - 0.8 * e.sizeStrain * (0.3 + 0.9 * discipline) + 0.4 * e.stockComponent * discipline - 0.3 * (1 - risk) - 0.35 * e.antitrust
      );
    case 'divestiture':
      return 0.05 + 0.4 * disciplineC + 0.45 * e.survivalPressure - 0.3 * growth;
    case 'ceo_comp':
      return -0.15 - 0.9 * e.compStrain * (0.3 + 0.9 * discipline) + 0.25 * growth - 0.4 * e.controversy * safety;
    case 'csuite_appointment':
      return 0.3 + 0.3 * tech - 0.2 * e.compStrain;
    case 'buyback':
      return 0.05 + 0.5 * disciplineC - 0.4 * growth - 0.7 * e.sizeStrain * (1 - risk) - 0.6 * e.survivalPressure;
    case 'ipo':
      return 0.1 + 0.4 * growth + 0.8 * (e.ipoWindow - 0.5) - 0.3 * (1 - risk) + 0.2 * e.survivalPressure;
    case 'gov_contract':
      return 0.3 + 0.3 * growth - 0.8 * safety * e.controversy - 0.25 * e.sizeStrain;
    case 'model_release':
      return 0.25 + 0.4 * growth - 1.1 * safety * e.regulatoryStringency - 0.3 * safety * e.controversy + 0.15 * tech;
    case 'restructuring':
      return -0.1 + 1.2 * e.survivalPressure + 0.35 * disciplineC - 0.3 * growth;
    case 'ceo_dismissal':
      return -0.45 + 0.6 * independence + 1.3 * e.performancePressure;
    default:
      return 0;
  }
}

function rationaleFor(kind: BoardProposalKind, stance: VoteStance, director: Director, economics: ProposalEconomics, commitmentId: string | null): string {
  const mandate = director.mandate.replace(/_/g, ' ');
  if (commitmentId !== null) {
    return `I said I would ${stance === 'abstain' ? 'stand aside' : stance} on these terms, and I am doing it.`;
  }
  const detail = ((): string => {
    switch (kind) {
      case 'financing':
        return `dilution of ${Math.round(economics.dilution * 100)}% against ${Math.round(economics.runwayQuarters)} quarters of runway`;
      case 'acquisition':
        return `${economics.amountUsd === null ? 'the price' : usdLabel(economics.amountUsd)} with ${Math.round(economics.stockComponent * 100)}% in stock`;
      case 'ceo_comp':
        return `a package running at ${round(economics.compStrain, 2)}x one quarter of payroll`;
      case 'ceo_dismissal':
        return `performance pressure at ${Math.round(economics.performancePressure * 100)}%`;
      case 'gov_contract':
        return `public controversy at ${Math.round(economics.controversy * 100)}%`;
      case 'model_release':
        return `regulatory stringency at ${Math.round(economics.regulatoryStringency * 100)}%`;
      case 'restructuring':
        return `${Math.round(economics.runwayQuarters)} quarters of runway`;
      case 'ipo':
        return `a listing window at ${Math.round(economics.ipoWindow * 100)}%`;
      default:
        return `a commitment of ${economics.amountUsd === null ? 'no stated size' : usdLabel(economics.amountUsd)}`;
    }
  })();
  const verb = stance === 'support' ? 'I support this' : stance === 'oppose' ? 'I cannot support this' : 'I am abstaining';
  return `${verb}: on ${detail}, with a ${mandate} mandate.`.slice(0, 400);
}

/**
 * True when a director must stand aside on this matter. A chief executive does
 * not vote on their own removal or their own pay.
 */
export function isRecused(proposal: BoardProposal, director: Director, company: Company | null): boolean {
  if (company === null) return false;
  const ceo = company.ceoCharacterId;
  if (ceo === null || director.characterId !== ceo) return false;
  return proposal.kind === 'ceo_dismissal' || proposal.kind === 'ceo_comp';
}

/** One director's position on one proposal, with the reasoning kept. */
export function assessDirector(draft: SessionState, proposal: BoardProposal, director: Director): DirectorAssessment {
  const company = companyById(draft, proposal.companyId);
  const economics = proposalEconomics(draft, proposal, company);
  const recused = isRecused(proposal, director, company);

  const base = kindScore(proposal.kind, director, economics);
  const mandate = MANDATE_BIAS[director.mandate][proposal.kind] ?? 0;
  const loyaltySign = proposal.kind === 'ceo_dismissal' ? -1 : 1;
  const loyalty = loyaltySign * (1 - normalised(director.independence)) * LOYALTY_WEIGHT * (director.relationshipWithCeo / 100);
  const preference = clamp(base + mandate + loyalty, -1, 1);

  let value = preference;
  let honouredCommitmentId: string | null = null;

  const commitments = bindingCommitments(draft, proposal, director.characterId);
  const strongest = commitments.reduce<StoredCommitment | null>(
    (best, c) => (best === null || c.commitmentStrength > best.commitmentStrength ? c : best),
    null,
  );
  if (strongest !== null) {
    const target = strongest.stance === 'support' ? 1 : strongest.stance === 'oppose' ? -1 : 0;
    if (strongest.commitmentStrength >= BINDING_COMMITMENT_STRENGTH) {
      // Above 0.8 they honour it against their own preferences, so the promised
      // stance is what comes out of the room.
      value = target === 0 ? 0 : clamp(target * Math.max(Math.abs(preference), SUPPORT_THRESHOLD + 0.05), -1, 1);
    } else {
      // Below that it is a stated inclination that competes with what they think.
      value = clamp(preference * (1 - strongest.commitmentStrength) + target * strongest.commitmentStrength, -1, 1);
    }
  }

  const stance: VoteStance = value > SUPPORT_THRESHOLD ? 'support' : value < -SUPPORT_THRESHOLD ? 'oppose' : 'abstain';
  const honoured = strongest !== null && stance === strongest.stance;
  if (honoured && strongest !== null) honouredCommitmentId = strongest.id;

  return {
    characterId: director.characterId,
    preference: round(preference, 4),
    value: round(value, 4),
    stance,
    recused,
    honouredCommitmentId,
    rationale: rationaleFor(proposal.kind, stance, director, economics, honouredCommitmentId),
  };
}

/* -------------------------------------------------------------------------- */
/*  The tally                                                                  */
/* -------------------------------------------------------------------------- */

const EMPTY_TALLY = (proposalId: string): BoardTally => ({
  proposalId,
  support: 0,
  against: 0,
  abstain: 0,
  absent: 0,
  quorumMet: false,
  passes: false,
  perDirector: [],
});

/** The board a proposal belongs to, by id or by the company it governs. */
export function boardForProposal(draft: SessionState, proposal: BoardProposal): Board | null {
  return boardById(draft, proposal.boardId) ?? boardForCompany(draft, proposal.companyId);
}

/** The threshold this matter must clear under the board's rule set. */
export function thresholdFor(board: Board, proposal: BoardProposal): number {
  const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
  const supermajority = rule.supermajorityKinds.includes(proposal.kind);
  const ruleThreshold = supermajority ? rule.supermajorityThresholdFraction : rule.passThresholdFraction;
  return unit(Math.max(ruleThreshold, proposal.requiredThresholdFraction));
}

/**
 * Tally one proposal: every director's stance from traits, mandate,
 * relationship and any live commitment. Pure with respect to the draft.
 */
export function tallyProposal(draft: SessionState, proposalId: string): BoardTally {
  const proposal = draft.boardProposals.find((p) => p.id === proposalId);
  if (proposal === undefined) return EMPTY_TALLY(proposalId);
  const board = boardForProposal(draft, proposal);
  if (board === null) return EMPTY_TALLY(proposalId);

  const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
  const perDirector: BoardVote[] = [];
  let support = 0;
  let against = 0;
  let abstain = 0;
  let absent = 0;
  let chairStance: VoteStance | null = null;

  for (const director of board.directors) {
    const assessment = assessDirector(draft, proposal, director);
    const weight = clamp(director.votingWeight, 0, 5);
    const vote: BoardVote['vote'] = assessment.recused ? 'absent' : assessment.stance;

    if (vote === 'absent') absent += weight;
    else if (vote === 'support') support += weight;
    else if (vote === 'oppose') against += weight;
    else abstain += weight;

    if (director.isChair && vote !== 'absent') chairStance = assessment.stance;

    perDirector.push({
      proposalId,
      directorCharacterId: director.characterId,
      vote,
      quarter: proposal.decisionQuarter,
      weight,
      rationale: assessment.recused ? 'Recused: the matter concerns me personally.' : assessment.rationale,
      honouredCommitmentId: assessment.honouredCommitmentId,
    });
  }

  const totalWeight = board.directors.reduce((s, d) => s + clamp(d.votingWeight, 0, 5), 0);
  const present = support + against + abstain;
  const quorumMet = totalWeight <= 0 ? false : present / totalWeight >= rule.minPresentFraction;

  const threshold = thresholdFor(board, proposal);
  const cast = support + against;
  let passes = false;
  if (quorumMet && cast > 0) {
    const share = support / cast;
    passes = share >= threshold;
    if (!passes && Math.abs(support - against) < 1e-9 && rule.chairBreaksTies && chairStance === 'support') {
      passes = true;
    }
  }

  return {
    proposalId,
    support: round(support, 4),
    against: round(against, 4),
    abstain: round(abstain, 4),
    absent: round(absent, 4),
    quorumMet,
    passes,
    perDirector,
  };
}

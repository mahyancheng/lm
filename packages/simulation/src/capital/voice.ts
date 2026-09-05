/**
 * @frontier/simulation — capital/voice.ts
 *
 * What a partner says, and the hard line around it.
 *
 * **A model may write the partner's words and nothing else.** Not whether an
 * offer is made, to whom, at what price, in what size, on what premium, with how
 * many board seats, at what credibility, whether a campaign escalates, whether a
 * defence works, whether a vote passes, or the value of any number on any of
 * those. Every one of those is computed before this file is reached, and this
 * file only ever receives the finished figures.
 *
 * Two utterances a quarter, chosen by salience, and everything else rendered
 * from these templates — the same shape `renderNpcText` uses for social posts:
 * the character's traits pick a voice, the seeded stream picks a variant inside
 * it. The game reads correctly with the model switched off entirely, which is
 * the outage rule.
 */

import type { CapitalEntity, Character, SeededRng, SessionState } from '@frontier/contracts';

/** The three voices a partner can speak in, chosen from their own traits. */
export type PartnerVoice = 'plain' | 'clinical' | 'combative';

/** Which voice this partner speaks in. Derived from the person, never assigned. */
export function voiceOf(draft: SessionState, entity: CapitalEntity): PartnerVoice {
  const partnerId = entity.partnerCharacterIds[0];
  const partner: Character | undefined = partnerId === undefined ? undefined : draft.characters.find((candidate) => candidate.id === partnerId);
  if (partner === undefined) return 'plain';
  const aggressiveness = partner.stableTraits.aggressiveness;
  const technical = partner.stableTraits.technicalOrientation;
  if (aggressiveness >= 60 && aggressiveness >= technical) return 'combative';
  if (technical >= 60) return 'clinical';
  return 'plain';
}

/** The partner's display name, or the institution's when the seat is vacant. */
export function partnerNameOf(draft: SessionState, entity: CapitalEntity): string {
  const partnerId = entity.partnerCharacterIds[0];
  const partner = partnerId === undefined ? undefined : draft.characters.find((candidate) => candidate.id === partnerId);
  return partner?.name ?? entity.name;
}

interface RemarkFields {
  readonly entityName: string;
  readonly companyName: string;
  readonly figure: string;
}

const TERM_SHEET_LINES: Readonly<Record<PartnerVoice, readonly string[]>> = {
  plain: [
    '{entity} would like to lead this round. {figure}, and we would be good partners to {company}.',
    'We have watched {company} for a while. {figure}. We would like to be on the register.',
  ],
  clinical: [
    'On our numbers {company} supports {figure}. That is where {entity} is prepared to price it.',
    '{entity} marks {company} at {figure}. We do not expect to move far from it.',
  ],
  combative: [
    '{figure}, and {entity} will not be improving on it because it does not need to.',
    '{company} can take {figure} from us or it can take less from somebody slower.',
  ],
};

const APPROACH_LINES: Readonly<Record<PartnerVoice, readonly string[]>> = {
  plain: [
    '{entity} has approached the board of {company} at {figure}. We would rather do this with them than to them.',
    'We think {company} is worth more owned properly. {figure} is our opening position.',
  ],
  clinical: [
    '{company} trades below what its cash flows are worth. {figure} closes that gap and {entity} is funded for it.',
    'At {figure} the arithmetic works for {entity} and for every holder of {company}.',
  ],
  combative: [
    '{figure} is on the table for {company}. It will not be there indefinitely.',
    '{entity} has made its offer for {company} public because the board would not discuss it. {figure}.',
  ],
};

const CAMPAIGN_LINES: Readonly<Record<PartnerVoice, readonly string[]>> = {
  plain: [
    '{entity} has written to {company}. We own enough of it to expect an answer.',
    'We have asked the board of {company} for change, and we have asked politely once.',
  ],
  clinical: [
    '{entity} holds {figure} of {company} and the returns on that capital are not defensible.',
    'At {figure} of the register, {entity} is entitled to a hearing at {company}.',
  ],
  combative: [
    '{figure} of {company} belongs to {entity}, and we are done being patient with its board.',
    '{company} has had long enough. {entity} will take this to a vote.',
  ],
};

const REPORT_LINES: Readonly<Record<PartnerVoice, readonly string[]>> = {
  plain: [
    '{entity} is short {company} and is saying so publicly. {figure}.',
    'We have published our work on {company}. {figure}.',
  ],
  clinical: [
    '{entity} publishes on {company} today. {figure}. We are positioned accordingly.',
    'Our note on {company} sets out the case. {figure}.',
  ],
  combative: [
    '{company} is worth materially less than it is quoted at. {figure}. {entity} is short and intends to stay short.',
    'Read our note on {company} before the next set of numbers. {figure}.',
  ],
};

const TEMPLATES = {
  term_sheet: TERM_SHEET_LINES,
  approach: APPROACH_LINES,
  campaign: CAMPAIGN_LINES,
  short_report: REPORT_LINES,
} as const;

export type RemarkKind = keyof typeof TEMPLATES;

/**
 * Render one partner remark deterministically.
 *
 * The variant is drawn from the seeded stream, so the same session says the same
 * thing on every replay — which is the only kind of prose an engine is allowed
 * to author.
 */
export function renderPartnerRemark(draft: SessionState, entity: CapitalEntity, kind: RemarkKind, fields: RemarkFields, rng: SeededRng): string {
  const voice = voiceOf(draft, entity);
  const variants = TEMPLATES[kind][voice];
  const template = variants[rng.int(0, Math.max(0, variants.length - 1))] ?? variants[0] ?? '';
  return template
    .replace(/\{entity\}/g, fields.entityName)
    .replace(/\{company\}/g, fields.companyName)
    .replace(/\{figure\}/g, fields.figure)
    .slice(0, 300);
}

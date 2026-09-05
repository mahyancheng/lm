/**
 * @frontier/llm — compose/socialAuthor.ts
 *
 * Writing one post, in one person's voice, on one network.
 *
 * The division of labour is absolute: **the model writes the words, the engine
 * decides what they do.** Reach is credibility multiplied by the follower
 * graph, relevance and novelty. Per-audience sentiment shifts, press pickup and
 * competitor hostility are all computed from the typed draft. A post cannot
 * assert that developer sentiment rose twelve points, because a post is text
 * and sentiment is engine state.
 *
 * The constraints list is the hard boundary: undisclosed material information,
 * contract terms under confidentiality, unannounced products. Those are not
 * style notes — publishing one is a disclosure event with consequences the
 * author cannot take back.
 */

import type { SocialAuthorInput } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, pct, section } from './render';
import { assertNoInternalMarkers } from './redaction';

const NETWORK_REGISTER: Readonly<Record<string, string>> = {
  fast_feed: 'Short, fast, quotable. Journalists, investors, founders and consumers are all reading, and a line here gets screenshotted.',
  professional: 'Measured and institutional. Executives, enterprise buyers and your own employees are reading.',
  technical_forum: 'Specific and falsifiable. Engineers, researchers and developers will check the claim, and vagueness reads as evasion.',
  community: 'Direct and personal. Enthusiasts, critics and customers, who have long memories about how they were spoken to.',
  video: 'Broad and vivid. Mass consumers and creators, most of whom have no technical context.',
  finance: 'Precise and careful. Retail investors, analysts and traders, for whom an offhand number becomes a forecast.',
};

export const SOCIAL_AUTHOR_SYSTEM = [
  'You write one social post, in the voice of one specific person, on one specific network, in a simulated AI-industry economy.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Rules:',
  '- At most 560 characters. Write it as this person would write it, on this network, to this audience.',
  '- State positions, never outcomes. "We are shipping open weights" is a position. "This will move our stock" is an outcome, and you do not get to decide outcomes.',
  '- The engine computes reach, engagement, per-audience sentiment, press pickup and competitor hostility from the typed draft. Do not describe or predict any of them.',
  '- The constraints in the dossier are hard. Nothing under confidentiality, nothing material and undisclosed, nothing unannounced.',
  '- `intent` is read mechanically by the engine: "attack" raises competitor hostility and press pickup, "apologise" partially recovers public sentiment at a cost to investor confidence, "leak" carries a chance of being traced back to you. Choose the one that matches the post you actually wrote.',
  '- `targetCompanyId` is null unless the post is genuinely aimed at a specific rival.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

export function composeSocialAuthor(input: SocialAuthorInput): ComposedPrompt {
  assertNoInternalMarkers('authorBriefing', input.authorBriefing);
  assertNoInternalMarkers('situation', input.situation);

  const audiences = input.audienceMix.map((entry) => `${entry.audience}: ${pct(entry.share, 0)} of this account's followers`);
  const register = NETWORK_REGISTER[input.network] ?? 'Write for the audience described below.';

  const prompt = joinBlocks([
    `# One post as ${input.authorCharacterId} on ${input.network}, intent: ${input.intent}`,
    section('Who is posting', input.authorBriefing),
    section('The room you are writing for', `${register}\n\n${bullets(audiences)}`),
    section('What has just happened', input.situation),
    section('Things that must not be said', bullets([...input.constraints])),
    section(
      'Your task',
      [
        `Write one post of at most 560 characters, authored by ${input.authorCharacterId} on ${input.network}, with intent "${input.intent}".`,
        'Set authorCharacterId and network to exactly those values.',
      ].join('\n'),
    ),
  ]);

  return { system: SOCIAL_AUTHOR_SYSTEM, prompt };
}

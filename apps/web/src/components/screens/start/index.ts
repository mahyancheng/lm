/**
 * The start screen: how a company gets founded.
 *
 * ```tsx
 * import { SetupChat, AdvancedSetup } from '@/components/screens/start';
 * ```
 *
 * `SetupChat` is the conversation — chips or free text, both producing the same
 * `SetupProposal`. `AdvancedSetup` is the seed and the difficulty, folded away
 * because neither is a thing a founder says out loud.
 */

export { SetupChat } from './SetupChat';
export type { SetupChatProps } from './SetupChat';

export { AdvancedSetup, DIFFICULTY_BLURB } from './AdvancedSetup';
export type { AdvancedSetupProps } from './AdvancedSetup';

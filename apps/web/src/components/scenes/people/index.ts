/**
 * The people layer: everybody in this world has a face.
 *
 * ```tsx
 * import { Portrait, SpeechCard, moodFromRelationship } from '@/components/scenes/people';
 * ```
 *
 * `Portrait` is the deterministic flat-vector portrait generator — the whole
 * face falls out of `fnv1a64(characterId)` and the character's role. It is used
 * directly by the boardroom, the people web and the Chief of Staff, and
 * indirectly by every screen in the game through `PersonChip`.
 */

export { Portrait, PORTRAIT_PX } from './Portrait';
export type { PortraitProps, PortraitSize } from './Portrait';

export { SpeechCard } from './SpeechCard';
export type { SpeechCardProps } from './SpeechCard';

export {
  ACCENT_COUNT,
  CHIEF_OF_STAFF,
  GARMENT_VARIANT_COUNT,
  HAIR_COLOUR_COUNT,
  HAIR_STYLE_COUNT,
  PORTRAIT_ACCESSORIES,
  PORTRAIT_GARMENTS,
  SKIN_COUNT,
  garmentFill,
  garmentOfRole,
  moodFromRelationship,
  moodFromScore,
  pickIndex,
  portraitLook,
  portraitSignature,
} from './look';
export type { PortraitAccessory, PortraitGarment, PortraitLook, PortraitMood } from './look';

export { PEOPLE_STYLES, PEOPLE_STYLE_ID } from './styles';

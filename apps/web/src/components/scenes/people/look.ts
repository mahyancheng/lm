/**
 * What one person looks like.
 *
 * Every character in this world has a face, and the face is a *derivation*, not
 * a stored asset: skin tone, hair shape, hair colour, accessory and outfit all
 * fall out of `fnv1a64(characterId)` from `@frontier/shared`, salted per
 * feature so that two people who happen to share a hair colour do not therefore
 * share a jaw, a jacket and a pair of glasses.
 *
 * That gives three properties the interface depends on:
 *
 * - **Determinism.** The same id draws the same person forever — across a
 *   server render and the hydration after it, across two tabs, across two
 *   players' screens, across a reload three quarters later.
 * - **Diversity by construction.** The skin ramp is the full `--color-skin-1…5`
 *   ramp and the draw is uniform over it, so the cast is not accidentally
 *   monochrome. `portrait.test.ts` asserts the sixteen demo characters are
 *   pairwise distinct.
 * - **Role legibility.** The *outfit* is not random: it comes from
 *   `CharacterRole`, so a suit means a suit. You can tell an investor from a
 *   researcher across a boardroom table before you have read the name.
 *
 * Nothing here reads game state, and nothing here is a gameplay number. It
 * turns an id and a role into a drawing. No `Math.random`, no clock.
 */

import { fnv1a64 } from '@frontier/shared';

/* -------------------------------------------------------------------------- */
/*  Palettes: counts mirror the illustration ramps in globals.css              */
/* -------------------------------------------------------------------------- */

/** `--color-skin-1` … `--color-skin-5`, light to deep. */
export const SKIN_COUNT = 5;
/** `--color-hair-1` … `--color-hair-6`: near-black, brown, sandy, blond, auburn, grey. */
export const HAIR_COLOUR_COUNT = 6;
/** Eight flat hair silhouettes, drawn over the head circle. */
export const HAIR_STYLE_COUNT = 8;
/** `--color-pop-1` … `--color-pop-8`, the categorical accent set. */
export const ACCENT_COUNT = 8;
/** Colourways inside one garment, so a room of suits is not a uniform. */
export const GARMENT_VARIANT_COUNT = 3;

/** What somebody is wearing. Derived from their role, never from the hash. */
export type PortraitGarment = 'suit' | 'blazer' | 'lab' | 'hoodie' | 'uniform' | 'casual';

export const PORTRAIT_GARMENTS: readonly PortraitGarment[] = ['suit', 'blazer', 'lab', 'hoodie', 'uniform', 'casual'];

/** A small piece of personality on the face itself. */
export type PortraitAccessory = 'none' | 'glasses' | 'earrings' | 'cap';

export const PORTRAIT_ACCESSORIES: readonly PortraitAccessory[] = ['none', 'glasses', 'earrings', 'cap'];

/**
 * How somebody is feeling *towards the viewer*, in five bands.
 *
 * The caller supplies it — from a relationship edge, a morale score, a director's
 * stance — because the face must never invent a mood the state does not support.
 * With nothing supplied the expression is `content`: awake, pleasant, uncommitted.
 */
export type PortraitMood = 'delighted' | 'content' | 'neutral' | 'guarded' | 'hostile';

/* -------------------------------------------------------------------------- */
/*  Role → outfit                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The outfit for a `CharacterRole`.
 *
 * Typed against `string` rather than `CharacterRole` on purpose: `PersonLike`
 * (the structural type the chips take) carries `role?: string`, and an unknown
 * role must draw *somebody* rather than throw. Every known role is enumerated,
 * so adding one to the contract and forgetting it here shows up as a person in
 * plain clothes, not as a crash.
 */
export function garmentOfRole(role: string | undefined): PortraitGarment {
  switch (role) {
    case 'investor':
    case 'director':
      return 'suit';
    case 'executive':
      return 'blazer';
    case 'researcher':
      return 'lab';
    case 'founder_ceo':
      return 'hoodie';
    case 'regulator':
    case 'official':
      return 'uniform';
    case 'journalist':
      return 'casual';
    default:
      return 'casual';
  }
}

/* -------------------------------------------------------------------------- */
/*  The derivation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A stable index into a palette of `count`, derived from an id and a salt.
 *
 * Three things are load-bearing here, and each of them was measured rather than
 * assumed (`portrait.test.ts` keeps them measured):
 *
 * - **The salt brackets the id.** It is both prefix and suffix, so the part of
 *   the input that varies between two characters is never the *last* byte
 *   hashed. FNV-1a's final step is one xor and one multiply, so two ids
 *   differing only in their tail — `chr_x_1` and `chr_x_2`, or a synthetic seat
 *   id ending in an index — come out a fixed stride apart, and a fixed stride is
 *   invisible to `% 5`: a whole cast would share one skin tone.
 * - **All sixty-four bits are folded**, not just the low half, so structure left
 *   in either end is carried into the result.
 * - **One avalanche pass** (the standard xorshift-multiply finaliser) breaks the
 *   remaining stride before the modulo. Integer-exact through `Math.imul`, and
 *   pure: the same id and salt give the same index in any process, forever.
 */
export function pickIndex(id: string, salt: string, count: number): number {
  if (count <= 0) return 0;
  const hash = fnv1a64(`${salt}:${id}:${salt}`);
  const high = Number.parseInt(hash.slice(0, 8), 16);
  const low = Number.parseInt(hash.slice(8), 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return 0;
  let mixed = (high ^ low) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b) >>> 0;
  mixed = (mixed ^ (mixed >>> 16)) >>> 0;
  return mixed % count;
}

export interface PortraitLook {
  /** 1-based index into `--color-skin-N`. */
  readonly skin: number;
  /** Which of the eight flat hair silhouettes. */
  readonly hairStyle: number;
  /** 1-based index into `--color-hair-N`. */
  readonly hairColour: number;
  readonly accessory: PortraitAccessory;
  /** Role-coded, never hashed. */
  readonly garment: PortraitGarment;
  /** Which colourway inside that garment. */
  readonly garmentVariant: number;
  /** 1-based index into `--color-pop-N`: a tie, a lanyard, a badge. */
  readonly accent: number;
  /** Idle-bob period, so a crowd does not breathe in unison. */
  readonly bobDurationMs: number;
  /** Idle-bob phase offset. */
  readonly bobDelayMs: number;
  /** -1, 0 or 1: a fraction of a degree of head tilt. */
  readonly tilt: number;
}

/**
 * The complete look of one character. Pure: same id and role in, same face out.
 */
export function portraitLook(characterId: string, role?: string): PortraitLook {
  return {
    skin: pickIndex(characterId, 'skin', SKIN_COUNT) + 1,
    hairStyle: pickIndex(characterId, 'hairstyle', HAIR_STYLE_COUNT),
    hairColour: pickIndex(characterId, 'haircolour', HAIR_COLOUR_COUNT) + 1,
    accessory: PORTRAIT_ACCESSORIES[pickIndex(characterId, 'accessory', PORTRAIT_ACCESSORIES.length)] ?? 'none',
    garment: garmentOfRole(role),
    garmentVariant: pickIndex(characterId, 'garment', GARMENT_VARIANT_COUNT),
    accent: pickIndex(characterId, 'accent', ACCENT_COUNT) + 1,
    bobDurationMs: 2800 + pickIndex(characterId, 'bobdur', 1600),
    bobDelayMs: pickIndex(characterId, 'bobdelay', 2400),
    tilt: pickIndex(characterId, 'tilt', 3) - 1,
  };
}

/**
 * The garment colour, as a CSS custom property reference.
 *
 * A suit is a suit and a lab coat is a lab coat — those two have one colour and
 * carry their variation in the accent (a tie, a pen) instead. The looser
 * garments draw from the pastel set so a room of founders is not a uniform.
 * Every value here is a token: the palette belongs to `globals.css`.
 */
export function garmentFill(garment: PortraitGarment, variant: number): string {
  const index = ((variant % GARMENT_VARIANT_COUNT) + GARMENT_VARIANT_COUNT) % GARMENT_VARIANT_COUNT;
  switch (garment) {
    case 'suit':
    case 'uniform':
      return 'var(--color-cloth-suit)';
    case 'lab':
      return 'var(--color-cloth-lab)';
    case 'hoodie':
      return ['var(--color-cloth-hoodie)', 'var(--color-pop-5)', 'var(--color-pop-8)'][index] ?? 'var(--color-cloth-hoodie)';
    case 'blazer':
      return ['var(--color-pop-1)', 'var(--color-pop-5)', 'var(--color-pop-2)'][index] ?? 'var(--color-pop-1)';
    default:
      return ['var(--color-cloth-casual)', 'var(--color-pop-2)', 'var(--color-pop-6)'][index] ?? 'var(--color-cloth-casual)';
  }
}

/**
 * The look as one comparable string.
 *
 * Two characters with the same signature draw identically, which is exactly
 * what the uniqueness test checks across the demo cast. Two things are excluded
 * deliberately: motion, because two people may legitimately bob in phase, and
 * the raw garment variant, because a suit's variant is invisible — what is
 * compared is the colour that actually reaches the screen.
 */
export function portraitSignature(look: PortraitLook): string {
  return [
    look.skin,
    look.hairStyle,
    look.hairColour,
    look.accessory,
    look.garment,
    garmentFill(look.garment, look.garmentVariant),
    look.accent,
  ].join('/');
}

/* -------------------------------------------------------------------------- */
/*  Mood, from state the caller already has                                    */
/* -------------------------------------------------------------------------- */

/**
 * A mood from a 0–100 score: morale, support, a meter the screen already shows.
 *
 * The bands match `Meter`'s own (≥70 gain, ≥45 info, ≥25 warn) so a face and the
 * bar beside it never disagree about whether things are going well.
 */
export function moodFromScore(score: number | null | undefined): PortraitMood {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'content';
  if (score >= 78) return 'delighted';
  if (score >= 58) return 'content';
  if (score >= 38) return 'neutral';
  if (score >= 18) return 'guarded';
  return 'hostile';
}

/**
 * A mood from a -100…100 relationship, which is how the board stores standing
 * with the chief executive.
 */
export function moodFromRelationship(value: number | null | undefined): PortraitMood {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'content';
  return moodFromScore((value + 100) / 2);
}

/* -------------------------------------------------------------------------- */
/*  The Chief of Staff                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The player's Chief of Staff.
 *
 * A *presentation* persona, not engine state: the chief of staff is a seat in
 * the LLM gateway rather than a `Character` in the session, so nothing here is
 * read from or written to the world. It is given a fixed id so the face is
 * stable across sessions and a fixed role so the outfit is a blazer, and it is
 * labelled as model-authored wherever it speaks.
 */
export const CHIEF_OF_STAFF = {
  id: 'syn_chief_of_staff',
  name: 'Wren Adeyemi',
  title: 'Chief of Staff',
  role: 'executive',
} as const;

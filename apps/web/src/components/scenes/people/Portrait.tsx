'use client';

/**
 * One person's face.
 *
 * A round head, a flat hair shape laid over it, two dot eyes, a two-point
 * mouth, and a role-coded outfit on the shoulders below — the flat-vector
 * cartoon vocabulary of the art direction, drawn in a 40×40 box and scaled to
 * whichever of the four sizes the caller asks for.
 *
 * Everything a face may vary by comes from `portraitLook`, which derives it from
 * `fnv1a64(characterId)`. Nothing in this file reads a clock, a random number or
 * game state, so a character draws identically on the server, after hydration,
 * in another tab and next year.
 *
 * Two deliberate omissions:
 *
 * - **No `clipPath`, no gradient, no filter, no `<defs>`.** The bust is a shape
 *   that already fits inside the disc, so a portrait carries no document-scoped
 *   ids — forty of them on a page cannot collide, and a portrait may be safely
 *   inlined anywhere, including inside another SVG.
 * - **No hex.** Every fill is an illustration token from `globals.css`, aliased
 *   in `styles.ts`, so the palette owner can re-skin every person in the game.
 */

import type { CSSProperties } from 'react';
import { cx, type Tone } from '@/components/ui/tokens';
import { garmentFill, portraitLook, type PortraitLook, type PortraitMood } from './look';
import { PEOPLE_STYLES, PEOPLE_STYLE_ID } from './styles';

/* -------------------------------------------------------------------------- */
/*  Sizes                                                                      */
/* -------------------------------------------------------------------------- */

export type PortraitSize = 'sm' | 'md' | 'lg' | 'xl';

/** Rendered edge length in CSS pixels, per size. */
export const PORTRAIT_PX: Readonly<Record<PortraitSize, number>> = { sm: 24, md: 32, lg: 48, xl: 72 };

/* -------------------------------------------------------------------------- */
/*  Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

function skinVar(look: PortraitLook): string {
  return `var(--color-skin-${look.skin})`;
}

function hairVar(look: PortraitLook): string {
  return `var(--color-hair-${look.hairColour})`;
}

function accentVar(look: PortraitLook): string {
  return `var(--color-pop-${look.accent})`;
}

/** The ring around the disc. A tone when the caller has one, a hairline otherwise. */
const RING_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-hair-strong)',
  gain: 'var(--color-gain)',
  loss: 'var(--color-loss)',
  warn: 'var(--color-warn)',
  info: 'var(--color-info)',
  brand: 'var(--color-brand)',
};

/* -------------------------------------------------------------------------- */
/*  Hair                                                                       */
/* -------------------------------------------------------------------------- */

/** The hairline chord across the forehead, above the brows. */
const CAP = 'M10.12 11.8A10.9 10.9 0 0 1 29.88 11.8Z';

function Hair({ look }: { readonly look: PortraitLook }): React.JSX.Element {
  const fill = hairVar(look);
  switch (look.hairStyle) {
    case 1:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <rect x="9.1" y="10.8" width="2.7" height="7.2" rx="1.35" />
          <rect x="28.2" y="10.8" width="2.7" height="7.2" rx="1.35" />
        </g>
      );
    case 2:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <circle cx="13.4" cy="9.6" r="3" />
          <circle cx="20" cy="7.6" r="3.4" />
          <circle cx="26.6" cy="9.6" r="3" />
        </g>
      );
    case 3:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <circle cx="20" cy="6.4" r="3.1" />
        </g>
      );
    case 4:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <ellipse cx="10.4" cy="18.4" rx="2.9" ry="6.4" />
          <ellipse cx="29.6" cy="18.4" rx="2.9" ry="6.4" />
        </g>
      );
    case 5:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <path d="M10.4 12.6C13 7.4 22 6.2 27.6 9.6c-4.4-.6-8.6.8-11.4 3.6z" />
        </g>
      );
    case 6:
      return <path d="M11.4 13.2A9.9 9.9 0 0 1 28.6 13.2Z" fill={fill} />;
    case 7:
      return (
        <g fill={fill}>
          <path d={CAP} />
          <ellipse cx="31.2" cy="16.6" rx="2.4" ry="4.2" />
        </g>
      );
    default:
      return <path d={CAP} fill={fill} />;
  }
}

/* -------------------------------------------------------------------------- */
/*  Expression                                                                 */
/* -------------------------------------------------------------------------- */

/** The mouth: five shapes, one per mood band. A smile bulges downward in SVG. */
const MOUTH: Readonly<Record<PortraitMood, string>> = {
  delighted: 'M15.9 20.1q4.1 4.2 8.2 0',
  content: 'M16.8 20.6q3.2 2.6 6.4 0',
  neutral: 'M17.2 21.1h5.6',
  guarded: 'M17.2 21.7q2.8-1.2 5.6 0',
  hostile: 'M16.8 22.1q3.2-2.4 6.4 0',
};

/** Brow ends, as a vertical offset for the inner and the outer end of each brow. */
const BROW: Readonly<Record<PortraitMood, { readonly inner: number; readonly outer: number }>> = {
  delighted: { inner: 0.3, outer: -0.5 },
  content: { inner: 0, outer: -0.2 },
  neutral: { inner: 0, outer: 0 },
  guarded: { inner: -0.3, outer: 0.5 },
  hostile: { inner: -0.8, outer: 0.6 },
};

function Face({ look, mood }: { readonly look: PortraitLook; readonly mood: PortraitMood }): React.JSX.Element {
  const brow = BROW[mood];
  const line = 'var(--fc-line)';
  return (
    <g>
      {/* brows */}
      <path
        d={`M14.2 ${(12.9 + brow.outer).toFixed(2)}L18.2 ${(12.9 + brow.inner).toFixed(2)}`}
        stroke={line}
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={`M25.8 ${(12.9 + brow.outer).toFixed(2)}L21.8 ${(12.9 + brow.inner).toFixed(2)}`}
        stroke={line}
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />

      {/* eyes: open dots, or happy arcs when delighted */}
      {mood === 'delighted' ? (
        <g stroke={line} strokeWidth="1.2" strokeLinecap="round" fill="none">
          <path d="M14.9 16.9q1.5-1.8 3 0" />
          <path d="M22.1 16.9q1.5-1.8 3 0" />
        </g>
      ) : (
        <g fill={line}>
          <circle cx="16.4" cy="16.6" r="1.15" />
          <circle cx="23.6" cy="16.6" r="1.15" />
        </g>
      )}

      <path d={MOUTH[mood]} stroke={line} strokeWidth="1.1" strokeLinecap="round" fill="none" />

      {look.accessory === 'glasses' ? (
        <g stroke={line} strokeWidth="0.85" fill="none">
          <circle cx="16.4" cy="16.6" r="3.05" />
          <circle cx="23.6" cy="16.6" r="3.05" />
          <path d="M19.45 16.6h1.1" />
          <path d="M13.35 16.1l-2.6-.7" />
          <path d="M26.65 16.1l2.6-.7" />
        </g>
      ) : null}

      {look.accessory === 'earrings' ? (
        <g fill={accentVar(look)}>
          <circle cx="9.5" cy="19.5" r="1.05" />
          <circle cx="30.5" cy="19.5" r="1.05" />
        </g>
      ) : null}

      {look.accessory === 'cap' ? (
        <g fill={accentVar(look)}>
          <path d={CAP} />
          <rect x="7.8" y="11" width="13.4" height="2.2" rx="1.1" />
        </g>
      ) : null}
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Outfit                                                                     */
/* -------------------------------------------------------------------------- */

/** The bust: a shape that already sits inside the disc, so nothing is clipped. */
const BUST = 'M8.07 34.4C8.9 27.9 13.6 25.4 20 25.4s11.1 2.5 11.93 9A18.7 18.7 0 0 1 8.07 34.4Z';

function Outfit({ look }: { readonly look: PortraitLook }): React.JSX.Element {
  const cloth = garmentFill(look.garment, look.garmentVariant);
  const accent = accentVar(look);
  const shirt = 'var(--fc-shirt)';

  switch (look.garment) {
    case 'suit':
      return (
        <g>
          <path d={BUST} fill={cloth} />
          <path d="M20 25.6l-3.7 2.3 3.7 5.3 3.7-5.3z" fill={shirt} />
          <path d="M20 30.4l1.5 1.7-1.5 5.2-1.5-5.2z" fill={accent} />
        </g>
      );
    case 'blazer':
      return (
        <g>
          <path d={BUST} fill={cloth} />
          <path d="M20 25.6l-3.4 2.2 3.4 5 3.4-5z" fill={shirt} />
          <rect x="24.4" y="30" width="3.6" height="2.4" rx="0.8" fill={accent} />
        </g>
      );
    case 'lab':
      return (
        <g>
          <path d={BUST} fill={cloth} stroke="var(--color-hair-strong)" strokeWidth="0.7" />
          <path d="M20 25.6l-2.8 1.8 2.8 4 2.8-4z" fill={accent} />
          <path d="M16.6 26.6L19.4 30M23.4 26.6L20.6 30" stroke="var(--color-hair-strong)" strokeWidth="0.7" strokeLinecap="round" />
          <rect x="25.4" y="29.4" width="0.9" height="2.8" rx="0.45" fill={accent} />
        </g>
      );
    case 'hoodie':
      return (
        <g>
          <path d={BUST} fill={cloth} />
          <path d="M11.8 27.6q8.2-3.4 16.4 0l-.7 2.6q-7.5-3-15 0z" fill="var(--fc-shade)" />
          <path d="M18.5 29.8v3.6M21.5 29.8v3.6" stroke={accent} strokeWidth="0.85" strokeLinecap="round" />
        </g>
      );
    case 'uniform':
      return (
        <g>
          <path d={BUST} fill={cloth} />
          <path d="M20 25.6l-3.6 2.2 1.3 2.5 2.3-2.1 2.3 2.1 1.3-2.5z" fill={shirt} />
          <rect x="10.6" y="28.4" width="4" height="1.5" rx="0.75" fill={accent} />
          <rect x="25.4" y="28.4" width="4" height="1.5" rx="0.75" fill={accent} />
          <circle cx="24.6" cy="32.6" r="1.7" fill={accent} />
        </g>
      );
    default:
      return (
        <g>
          <path d={BUST} fill={cloth} />
          <path d="M15.8 26.2q4.2 3.4 8.4 0" stroke={shirt} strokeWidth="1.6" strokeLinecap="round" fill="none" />
          <path d="M17.6 26.8L19.2 32M22.4 26.8L20.8 32" stroke={accent} strokeWidth="0.8" strokeLinecap="round" fill="none" />
          <rect x="18.5" y="31.4" width="3" height="2.3" rx="0.7" fill={accent} />
        </g>
      );
  }
}

/* -------------------------------------------------------------------------- */
/*  The portrait                                                               */
/* -------------------------------------------------------------------------- */

export interface PortraitProps {
  /** The character's engine id. The whole face is derived from it. */
  readonly characterId: string;
  /** Used for the accessible label. Omit only when the portrait is decorative. */
  readonly name?: string;
  /** `CharacterRole`, which decides the outfit. */
  readonly role?: string;
  readonly size?: PortraitSize;
  /** Supplied by the caller from relationship, morale or stance. Defaults to `content`. */
  readonly mood?: PortraitMood;
  /** A coloured ring: a stance, an access state, a standing. */
  readonly ring?: Tone;
  /** The player's own seat gets a brand ring without the caller asking. */
  readonly isPlayer?: boolean;
  /** Idle bob. Off by default: a table of forty faces must not breathe at you. */
  readonly idle?: boolean;
  /** True when adjacent text already names the person, e.g. inside a chip. */
  readonly decorative?: boolean;
  readonly className?: string;
}

/**
 * A deterministic flat-vector portrait.
 *
 * ```tsx
 * <Portrait characterId={character.id} name={character.name} role={character.role} size="lg" />
 * ```
 */
export function Portrait({
  characterId,
  name,
  role,
  size = 'md',
  mood = 'content',
  ring,
  isPlayer = false,
  idle = false,
  decorative = false,
  className,
}: PortraitProps): React.JSX.Element {
  const look = portraitLook(characterId, role);
  const px = PORTRAIT_PX[size];
  const ringTone: Tone | undefined = ring ?? (isPlayer ? 'brand' : undefined);
  const ringVar = ringTone === undefined ? 'var(--fc-face-ring)' : RING_VAR[ringTone];
  const label = name === undefined ? 'Portrait' : `${name}, illustrated`;

  const motion = idle
    ? ({ '--fc-dur': `${look.bobDurationMs}ms`, '--fc-delay': `${look.bobDelayMs}ms` } as unknown as CSSProperties)
    : undefined;

  return (
    <>
      <style href={PEOPLE_STYLE_ID} precedence="default">
        {PEOPLE_STYLES}
      </style>
      <svg
        viewBox="0 0 40 40"
        width={px}
        height={px}
        className={cx('fc-face', className)}
        role={decorative ? 'presentation' : 'img'}
        aria-hidden={decorative ? true : undefined}
        aria-label={decorative ? undefined : label}
      >
        <circle
          cx="20"
          cy="20"
          r="19.2"
          fill={ringTone === undefined ? 'var(--fc-face-disc)' : `color-mix(in srgb, ${ringVar} 12%, var(--fc-face-disc))`}
          stroke={ringVar}
          strokeWidth={ringTone === undefined ? 1 : 1.6}
        />
        <g className={idle ? 'fc-face-bob' : undefined} style={motion}>
          <rect x="17.2" y="20.4" width="5.6" height="6" rx="2.4" fill={skinVar(look)} />
          <Outfit look={look} />
          <g transform={`translate(${(look.tilt * 0.5).toFixed(2)} 0)`}>
            <circle cx="9.5" cy="17.4" r="1.9" fill={skinVar(look)} />
            <circle cx="30.5" cy="17.4" r="1.9" fill={skinVar(look)} />
            <circle cx="20" cy="16.4" r="10.9" fill={skinVar(look)} />
            <Hair look={look} />
            <Face look={look} mood={mood} />
          </g>
        </g>
      </svg>
    </>
  );
}

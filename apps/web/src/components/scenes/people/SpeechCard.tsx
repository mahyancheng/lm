'use client';

/**
 * What somebody is saying, as a card with a tail pointing at their face.
 *
 * It is a *card*, not a chat bubble: the tail and the rounded corner are the
 * only concession to the conversational reading, and everything inside stays a
 * control surface. The Chief of Staff screen puts a whole interpretation — rows,
 * validator verdicts, a confirmation gate — inside one of these, which is the
 * point: the game speaks to you face to face without pretending that speech is
 * how anything gets done.
 *
 * `side="right"` is the player's own turn: brand wash, tail on the right. Below
 * 520px the tail is hidden by the stylesheet, because a card that has dropped
 * under the face it belongs to should not still be pointing sideways.
 */

import type { ReactNode } from 'react';
import { cx } from '@/components/ui/tokens';
import { PEOPLE_STYLES, PEOPLE_STYLE_ID } from './styles';

export interface SpeechCardProps {
  /** Who is speaking: `left` is the other person, `right` is the player. */
  readonly side?: 'left' | 'right';
  /** A small-caps attribution line above the body. */
  readonly speaker?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children: ReactNode;
}

export function SpeechCard({ side = 'left', speaker, className, bodyClassName, children }: SpeechCardProps): React.JSX.Element {
  return (
    <>
      <style href={PEOPLE_STYLE_ID} precedence="default">
        {PEOPLE_STYLES}
      </style>
      <div className={cx('fc-speech animate-pop-in min-w-0', className)} data-side={side}>
        {speaker === undefined ? null : (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-hair px-3.5 py-2">{speaker}</div>
        )}
        <div className={cx('px-3.5 py-3', bodyClassName)}>{children}</div>
      </div>
    </>
  );
}

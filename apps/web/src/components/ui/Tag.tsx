'use client';

import type { ReactNode } from 'react';
import { TONE_CHIP, cx, type Tone } from './tokens';

export interface TagProps {
  readonly children: ReactNode;
  readonly tone?: Tone;
  readonly size?: 'sm' | 'md';
  /** Render a leading dot instead of a filled chip; useful in dense tables. */
  readonly dot?: boolean;
  readonly title?: string;
  readonly className?: string;
}

/** A categorical label: status, sector, tier, epistemic state, visibility. */
export function Tag({ children, tone = 'neutral', size = 'sm', dot = false, title, className }: TagProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-[3px] border whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-px text-[10px] leading-[16px]' : 'px-2 py-0.5 text-[11px]',
        TONE_CHIP[tone],
        className,
      )}
    >
      {dot ? <span className="inline-block size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * Applied to every NPC-authored message, post and reply, without exception.
 * UI_SYSTEM §6: this label has no configuration and no opt-out.
 */
export function AiLabel({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <span
      title="Written by an AI-controlled character."
      className={cx(
        'inline-flex items-center rounded-[3px] border border-brand/30 bg-brand-wash px-1 py-px text-[9px] font-semibold tracking-[0.1em] text-brand uppercase',
        className,
      )}
    >
      AI
    </span>
  );
}

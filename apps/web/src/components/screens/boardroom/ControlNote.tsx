'use client';

/**
 * V4 — the control caption, on the matter being drafted.
 *
 * "The reward is visible before it can be claimed." Since Wave 3, 50% + 1 share
 * of a company's ordinary equity is decisive in its boardroom on every matter
 * but a dismissal of the chief executive, so the founder drafting a matter is
 * told, in one line, whether the room decides it or they do — and when they do
 * not, how far short they are.
 *
 * Both figures come off the committed `ControlStatus` row the projection
 * carries, and the exemption list is `CONTROL_EXEMPT_PROPOSAL_KINDS` itself, so
 * a change to either shows up here rather than in a stale sentence.
 */

import type { BoardProposalKind, ControlStatus } from '@frontier/contracts';
import { CONTROL_EXEMPT_PROPOSAL_KINDS } from '@frontier/contracts';
import { Icon, cx } from '@/components/ui';
import { controlCaption } from '../sector/model';

export interface ControlNoteProps {
  /** The player's own row on this company's register, or null when they hold none. */
  readonly row: ControlStatus | null;
  readonly kind: BoardProposalKind;
  readonly className?: string;
}

/** True when a controlling stake does not decide this kind of matter. */
export function isControlExempt(kind: BoardProposalKind): boolean {
  return (CONTROL_EXEMPT_PROPOSAL_KINDS as readonly string[]).includes(kind);
}

export function ControlNote({ row, kind, className }: ControlNoteProps): React.JSX.Element {
  const exempt = isControlExempt(kind);
  const decisive = !exempt && row !== null && row.hasControl;

  const text = exempt
    ? 'A controlling stake does not decide a dismissal of the chief executive. This one is the room’s, whatever the register says.'
    : controlCaption(row);

  return (
    <p
      className={cx(
        'flex items-start gap-1.5 rounded-card px-2 py-1.5 text-[11px] leading-snug font-semibold',
        decisive ? 'bg-brand-wash text-brand' : exempt ? 'bg-raised text-ink-dim' : 'bg-warn-wash text-warn',
        className,
      )}
    >
      <Icon name={decisive ? 'check' : 'stamp'} size={13} accent="current" className="mt-px shrink-0" />
      {text}
    </p>
  );
}

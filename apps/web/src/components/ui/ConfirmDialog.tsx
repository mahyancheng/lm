'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { ActionType } from '@frontier/contracts';
import { requiresExplicitConfirmation } from '@frontier/contracts';
import { Modal } from './Modal';
import { cx } from './tokens';

export interface ConfirmTerm {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Draw attention: the number a player is most likely to have misread. */
  readonly emphasis?: boolean;
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  /** Prose above the terms. One or two sentences, in the player's language. */
  readonly body?: ReactNode;
  /** The commitment, term by term. This is what the player is actually approving. */
  readonly terms?: readonly ConfirmTerm[];
  /**
   * The action type being confirmed. When it is one of the thirteen in
   * `CONFIRMATION_REQUIRED_ACTIONS` the dialog says so explicitly.
   */
  readonly actionType?: ActionType;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: 'brand' | 'loss' | 'warn';
  /** Require the player to type this word first. Reserve it for irreversible moves. */
  readonly requireTyped?: string | null;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The confirm gate.
 *
 * Wraps every control for an action in `CONFIRMATION_REQUIRED_ACTIONS`.
 * Financing, mergers, layoffs, share issuance, major contracts and large
 * spending commitments stay explicit: the engine rejects any of them carrying
 * `confirmedByHuman: false` with the code `confirmation_required`, and the
 * player's auto-execute preference is a convenience, never an authorisation.
 *
 * **This gate cannot be satisfied programmatically.** `onConfirm` fires from a
 * pointer or keyboard activation of the button and from nowhere else.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  terms,
  actionType,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'brand',
  requireTyped = null,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const gated = requireTyped !== null && typed.trim().toUpperCase() !== requireTyped.toUpperCase();
  const alwaysConfirms = actionType !== undefined && requiresExplicitConfirmation(actionType);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cx('btn', tone === 'loss' ? 'btn-danger' : 'btn-primary')}
            onClick={onConfirm}
            disabled={busy || gated}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {body !== undefined ? <p className="text-[12px] leading-relaxed text-ink-dim">{body}</p> : null}

      {terms !== undefined && terms.length > 0 ? (
        <dl className="mt-3 divide-y divide-hair rounded-[4px] border border-hair bg-base/50">
          {terms.map((term, index) => (
            <div key={index} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="label-caps-faint">{term.label}</dt>
              <dd className={cx('figure text-[12px]', term.emphasis === true ? 'text-warn' : 'text-ink')}>{term.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {alwaysConfirms ? (
        <p className="mt-3 rounded-[4px] border border-warn/25 bg-warn-wash px-3 py-2 text-[11px] text-warn">
          This action always requires an explicit human confirmation, regardless of your automation preference.
        </p>
      ) : null}

      {requireTyped !== null ? (
        <label className="mt-3 block">
          <span className="label-caps-faint">
            Type <span className="text-ink">{requireTyped}</span> to continue
          </span>
          <input
            className="field mt-1"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      <p className="mt-3 text-[10px] text-ink-faint">
        Nothing is submitted until you confirm, and confirming queues an intent — the engine still validates it.
      </p>
    </Modal>
  );
}

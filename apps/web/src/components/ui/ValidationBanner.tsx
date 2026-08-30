'use client';

import type { ActionValidationResult } from '@frontier/contracts';
import { Tag } from './Tag';
import { cx, type Tone } from './tokens';

export interface ValidationBannerProps {
  readonly result: ActionValidationResult | null;
  /** Show the reduced form a clamp produced. */
  readonly showClamped?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

/** Tone for a validation status: accepted is quiet, clamped warns, rejected is a loss. */
export function toneOfStatus(status: ActionValidationResult['status']): Tone {
  return status === 'accepted' ? 'gain' : status === 'clamped' ? 'warn' : 'loss';
}

/** Human wording for a validation status. */
export function labelOfStatus(status: ActionValidationResult['status']): string {
  return status === 'accepted' ? 'Accepted' : status === 'clamped' ? 'Clamped' : 'Rejected';
}

/**
 * Renders an `ActionValidationResult` honestly: accepted, clamped with the
 * reduced form shown, or rejected with the reason and its code.
 *
 * A board matter comes back **clamped** and transformed into a
 * `submit_board_proposal`. That is not a failure and must not read as one:
 * say "requires board approval", and show what will actually be tabled.
 */
export function ValidationBanner({ result, showClamped = true, compact = false, className }: ValidationBannerProps): React.JSX.Element | null {
  if (result === null) return null;

  const tone = toneOfStatus(result.status);
  const boardMatter = result.status === 'clamped' && result.clampedAction?.type === 'submit_board_proposal';

  return (
    <div
      className={cx(
        'rounded-[4px] border',
        tone === 'gain' ? 'border-gain/25 bg-gain-wash' : tone === 'warn' ? 'border-warn/25 bg-warn-wash' : 'border-loss/25 bg-loss-wash',
        compact ? 'px-2 py-1.5' : 'px-3 py-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={tone} dot>
          {boardMatter ? 'Requires board approval' : labelOfStatus(result.status)}
        </Tag>
        {result.codes.map((code) => (
          <span key={code} className="figure text-[10px] text-ink-faint">
            {code}
          </span>
        ))}
      </div>

      {result.reasons.length > 0 ? (
        <ul className={cx('mt-1.5 space-y-0.5 text-[11px]', tone === 'loss' ? 'text-loss' : 'text-ink-dim')}>
          {result.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {showClamped && result.clampedAction !== null ? (
        <p className="mt-1.5 text-[10px] text-ink-faint">
          Will run as: <span className="figure text-ink-dim">{result.clampedAction.type}</span>
          {boardMatter ? ' — the board votes before anything is executed.' : null}
        </p>
      ) : null}
    </div>
  );
}

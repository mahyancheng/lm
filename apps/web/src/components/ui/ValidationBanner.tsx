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

/**
 * Codes that arrive on an *accepted* action as advice rather than refusal.
 *
 * From world version 2 cash never rejects or clamps: an instruction that
 * overdraws the company is accepted whole and carries `insufficient_cash` as a
 * note saying where the balance lands. That is a warning, not an error, and it
 * must not read like one — a founder who is told "rejected" and then watches the
 * action run learns to ignore the banner.
 *
 * `partial_fill_expected` is the same shape for availability: the instruction
 * runs whole and the note says what the world is expected to give it —
 * `expectedFill`'s own words, already in `result.reasons` ("Asked for 40
 * roles; expect 6.") — never a clamp.
 */
export const ADVISORY_CODES: readonly ActionValidationResult['codes'][number][] = ['insufficient_cash', 'partial_fill_expected'];

/** Whether an accepted result's advisory is specifically an expected shortfall. */
export function hasExpectedShortfall(result: ActionValidationResult): boolean {
  return result.status === 'accepted' && result.codes.includes('partial_fill_expected');
}

/** Whether an accepted result carries an advisory note worth colouring. */
export function hasAdvisory(result: ActionValidationResult): boolean {
  return result.status === 'accepted' && result.codes.some((code) => ADVISORY_CODES.includes(code));
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

  const advisory = hasAdvisory(result);
  const expectedShortfall = hasExpectedShortfall(result);
  const tone = advisory ? 'warn' : toneOfStatus(result.status);
  const boardMatter = result.status === 'clamped' && result.clampedAction?.type === 'submit_board_proposal';

  return (
    <div
      className={cx(
        'animate-pop-in rounded-card border',
        tone === 'gain' ? 'border-gain/25 bg-gain-wash' : tone === 'warn' ? 'border-warn/25 bg-warn-wash' : 'border-loss/25 bg-loss-wash',
        compact ? 'px-2.5 py-2' : 'px-3.5 py-2.5',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={tone} dot>
          {boardMatter
            ? 'Requires board approval'
            : expectedShortfall
              ? 'Accepted — expect a partial fill'
              : advisory
                ? 'Accepted — watch the cash'
                : labelOfStatus(result.status)}
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

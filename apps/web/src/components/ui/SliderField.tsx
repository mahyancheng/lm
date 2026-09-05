'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { chipStops, snapToStep } from './sliderMath';
import { cx } from './tokens';

export interface SliderFieldProps {
  readonly label: ReactNode;
  /** Current value, in the exact units the intent payload will carry. */
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** Bounds and step must come from what the validator already enforces. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Renders the live figure — pass the shared formatter for the unit. */
  readonly format: (value: number) => string;
  /**
   * Quick-set 25/50/75/Max chips. Only where `max` is a real budget or cash
   * bound: "Max" of an arbitrary slider ceiling would read as an entitlement.
   */
  readonly chips?: boolean;
  /** Offer the numeric field for typing an exact figure. Default true. */
  readonly exact?: boolean;
  readonly disabled?: boolean;
  /** Required when `label` is not plain text. */
  readonly ariaLabel?: string;
  /**
   * The V5 slot: what this value would do, shown before it is committed.
   *
   * Rendered under the chips, and rendered **while a drag is in flight** from
   * the held value rather than the settled one — the point of the slot is that
   * the cost of a decision is a number before the thumb is released. Pass a
   * function to read the position the thumb is at; pass a node for a preview
   * that does not depend on it.
   */
  readonly preview?: ReactNode | ((value: number) => ReactNode);
  readonly className?: string;
}

/**
 * A bounded quantity, set by thumb.
 *
 * Every numeric action form uses this instead of a bare number input: the
 * range the slider offers is the range the validator would accept, the live
 * figure is rendered by the same shared formatters as every other label, and
 * the whole track is a 44px tap zone. The old numeric input survives behind
 * "Exact" — a slider cannot state $1,234,567, and a typed figure may exceed
 * the slider's ceiling because the validator, not this control, is the
 * authority on what clears.
 *
 * A drag moves the thumb locally and hands the parent one value, on release.
 * A range input fires on every pixel of travel, and the forms this control
 * sits in re-run the validator — and, on a government bid, five engine
 * analyses — for every value they are handed; a two-second drag committing at
 * pointer rate is the phone-killing version of the same screen. Chips and the
 * exact field are discrete and commit immediately.
 */
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
  chips = false,
  exact = true,
  disabled = false,
  ariaLabel,
  preview,
  className,
}: SliderFieldProps): React.JSX.Element {
  const id = useId();
  const [exactOpen, setExactOpen] = useState(false);
  // The exact field's text while it is being edited; null means "mirror value",
  // so a chip or slider move is reflected immediately without fighting typing.
  const [draft, setDraft] = useState<string | null>(null);
  // The thumb's own position while a drag is in flight; null means "mirror
  // value". Only this component re-renders until the drag ends.
  const [held, setHeld] = useState<number | null>(null);

  const settled = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const shown = held ?? settled;
  const fill = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  const stops = chips ? chipStops(min, max, step) : [];
  const name = ariaLabel ?? (typeof label === 'string' ? label : undefined);

  function set(next: number): void {
    setDraft(null);
    setHeld(null);
    onChange(next);
  }

  /** End of a drag: hand the parent the figure the thumb came to rest on. */
  function commit(): void {
    if (held === null) return;
    const next = held;
    setHeld(null);
    if (next !== value) onChange(next);
  }

  return (
    <div className={cx('min-w-0', className)}>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="label-caps-faint min-w-0 truncate">
          {label}
        </label>
        <output htmlFor={id} className="figure shrink-0 text-[15px] font-bold text-ink" aria-live="off">
          {format(shown)}
        </output>
      </div>

      <input
        id={id}
        type="range"
        className="fc-slider w-full"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={name}
        aria-valuetext={format(shown)}
        style={{ '--fc-fill': `${fill}%` } as React.CSSProperties}
        onChange={(event) => setHeld(snapToStep(Number(event.target.value), min, max, step))}
        // Every way a drag can end, including a pointer released off the track
        // and a keyboard arrow. `commit` is idempotent, so overlapping events
        // on a touch device settle the value once.
        onPointerUp={commit}
        onPointerCancel={commit}
        onLostPointerCapture={commit}
        onKeyUp={commit}
        onBlur={commit}
      />

      {stops.length > 0 || exact ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {stops.map((stop) => (
            <button
              key={stop.label}
              type="button"
              disabled={disabled}
              aria-label={name === undefined ? undefined : `${name}: ${stop.label}`}
              className={cx(
                'btn btn-sm tap-target press-pop sm:min-h-0',
                shown === stop.value && 'border-brand/40 bg-brand-wash text-brand',
              )}
              onClick={() => set(stop.value)}
            >
              {stop.label}
            </button>
          ))}
          {exact ? (
            <button
              type="button"
              disabled={disabled}
              aria-expanded={exactOpen}
              className={cx('btn btn-ghost btn-sm tap-target press-pop ml-auto sm:min-h-0', exactOpen && 'text-brand')}
              onClick={() => {
                setExactOpen((open) => !open);
                setDraft(null);
              }}
            >
              Exact…
            </button>
          ) : null}
        </div>
      ) : null}

      {exactOpen ? (
        <input
          type="number"
          inputMode="decimal"
          className="field tap-target mt-1.5 sm:min-h-0"
          aria-label={name === undefined ? 'Exact value' : `${name} — exact value`}
          min={min}
          step={step}
          disabled={disabled}
          value={draft ?? String(shown)}
          onChange={(event) => {
            setDraft(event.target.value);
            const parsed = Number.parseFloat(event.target.value);
            // Only the floor is imposed here: a typed figure above the slider's
            // ceiling is legal input, and the validator decides what it means.
            if (Number.isFinite(parsed)) onChange(Math.max(min, parsed));
          }}
          onBlur={() => setDraft(null)}
        />
      ) : null}

      {preview === undefined ? null : (
        <div className="mt-1.5">{typeof preview === 'function' ? preview(shown) : preview}</div>
      )}
    </div>
  );
}

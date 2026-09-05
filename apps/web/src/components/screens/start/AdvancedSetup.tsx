'use client';

/**
 * The two dials that are not a conversation: the seed and the difficulty.
 *
 * Neither belongs in the founding chat. Nobody says "a robotics startup in East
 * Asia on seed 424242" — the seed is a *reproducibility* control, and asking a
 * founder for one before they have named their company puts the least
 * interesting question first. So both live behind a fold that opens in one tap,
 * with their current values on the closed row so nothing is hidden, only quiet.
 *
 * The values themselves are owned by the page, because the page is what founds
 * the company with them.
 */

import { useState } from 'react';
import type { SessionDifficulty } from '@frontier/contracts';
import { SESSION_DIFFICULTIES } from '@frontier/contracts';
import { Icon, cx } from '@/components/ui';

/** What each difficulty actually does, in the world's own terms. */
export const DIFFICULTY_BLURB: Readonly<Record<SessionDifficulty, string>> = {
  sandbox: 'A quiet world. Two events a quarter at most, and rivals that rarely reach for your throat.',
  standard: 'The intended game. Three events a quarter, rivals that plan, and a market that reprices you honestly.',
  hard: 'A loud world. Four events a quarter and rivals that take the opening you leave them.',
  brutal: 'Five events a quarter, the full impact budget, and no allowance for a slow start.',
};

export interface AdvancedSetupProps {
  readonly seedText: string;
  readonly onSeedText: (value: string) => void;
  readonly difficulty: SessionDifficulty;
  readonly onDifficulty: (value: SessionDifficulty) => void;
  readonly disabled: boolean;
}

export function AdvancedSetup({ seedText, onSeedText, difficulty, onDifficulty, disabled }: AdvancedSetupProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="press-pop tap-target flex w-full items-center gap-2 rounded-chip px-1 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} accent="brand" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-ink">Advanced</span>
          <span className="block truncate text-[10.5px] text-ink-faint">
            Seed <span className="figure">{seedText}</span> · {difficulty} world
          </span>
        </span>
      </button>

      {open ? (
        <div className="animate-rise mt-2.5 grid gap-4 sm:grid-cols-[170px_1fr]">
          <label className="block">
            <span className="label-caps-faint">Seed</span>
            <input
              className="field mt-1 min-h-11 sm:min-h-0"
              value={seedText}
              onChange={(event) => onSeedText(event.target.value.replace(/[^\d-]/g, ''))}
              inputMode="numeric"
              aria-label="Session seed"
              disabled={disabled}
            />
            <span className="mt-1.5 block text-[10.5px] text-ink-faint">
              The same seed and the same decisions always produce the same world.
            </span>
          </label>

          <fieldset className="min-w-0">
            <legend className="label-caps-faint">Difficulty</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {SESSION_DIFFICULTIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={difficulty === option}
                  disabled={disabled}
                  onClick={() => onDifficulty(option)}
                  className={cx(
                    'btn tap-target press-pop capitalize',
                    difficulty === option ? 'icon-knockout-wash border-brand bg-brand-wash text-brand' : '',
                  )}
                >
                  {difficulty === option ? <Icon name="check" size={15} accent="inherit" /> : null}
                  {option}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-dim">{DIFFICULTY_BLURB[difficulty]}</p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

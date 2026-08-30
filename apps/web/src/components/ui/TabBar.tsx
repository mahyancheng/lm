'use client';

import type { ReactNode } from 'react';
import { cx } from './tokens';

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  /** A count or badge shown after the label. */
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
}

export interface TabBarProps {
  readonly tabs: readonly TabItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** `underline` sits under a page header; `segmented` sits inside a panel header. */
  readonly variant?: 'underline' | 'segmented';
  readonly className?: string;
  readonly ariaLabel?: string;
}

/** Horizontal tabs. Scrolls rather than wraps, so a six-network tab row survives a phone. */
export function TabBar({ tabs, value, onChange, variant = 'underline', className, ariaLabel }: TabBarProps): React.JSX.Element {
  if (variant === 'segmented') {
    return (
      <div role="tablist" aria-label={ariaLabel} className={cx('no-scrollbar flex gap-0.5 overflow-x-auto rounded-[4px] bg-base p-0.5', className)}>
        {tabs.map((tab) => {
          const active = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={tab.disabled}
              onClick={() => onChange(tab.id)}
              className={cx(
                'flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors',
                active ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink-dim',
                tab.disabled === true ? 'cursor-not-allowed opacity-40' : '',
              )}
            >
              {tab.label}
              {tab.badge !== undefined ? <span className="figure text-[10px] text-ink-faint">{tab.badge}</span> : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('no-scrollbar flex gap-4 overflow-x-auto border-b border-hair', className)}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cx(
              '-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[12px] whitespace-nowrap transition-colors',
              active ? 'border-brand text-ink' : 'border-transparent text-ink-faint hover:text-ink-dim',
              tab.disabled === true ? 'cursor-not-allowed opacity-40' : '',
            )}
          >
            {tab.label}
            {tab.badge !== undefined ? <span className="figure text-[10px] text-ink-faint">{tab.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

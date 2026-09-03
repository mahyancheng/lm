'use client';

/**
 * One holding, one card.
 *
 * A holdings table wants eight columns — name, stake, cost, value, gain,
 * dividends, control, actions — and eight columns is not a phone surface. Each
 * position is a card instead: the name and what it is on the left, the value as
 * the one bare number on the right, cost and gain under it, and the instructions
 * the row can take along the bottom.
 *
 * Nothing here computes an economic figure. Every number arrives on the row the
 * engine's projection built; this file chooses which of them to draw.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatMoney } from '@frontier/shared';
import type { PortfolioAction } from '@frontier/simulation';
import { Icon, IconChip, RegionBadge, SectorBadge, TONE_TEXT, Tag, cx, type IconName, type Tone } from '@/components/ui';
import { ACTION_LABEL, actionHref, gainPct, gainTone, pctLabel } from './rows';

export interface PositionCardProps {
  readonly name: string;
  /** The one word under the name: what this position is. */
  readonly kindLabel: string;
  readonly icon: IconName;
  readonly iconTone?: Tone;
  /** The one bare number, top right. */
  readonly valueUsd: number;
  readonly valueLabel?: string;
  readonly costUsd: number;
  /** Dividends banked on this position, or null where the concept does not apply. */
  readonly dividendsUsd?: number | null;
  /** Chips under the header: sector, region, disclosure, control. */
  readonly chips?: ReactNode;
  /** One line explaining what the value means. */
  readonly line: string;
  /** A second line, e.g. a lock-up warning. Tinted when `warn` is set. */
  readonly footnote?: string | null;
  readonly footnoteTone?: Tone;
  /** The company or entity this row points at, for the actions that need a target. */
  readonly targetCompanyId: string | null;
  readonly actions?: readonly PortfolioAction[];
  /** Opens the ticket for the actions carried out on this screen. */
  readonly onAct?: (action: PortfolioAction) => void;
  /** Where tapping the card itself goes: the target's own screen. */
  readonly href?: string | null;
}

export function PositionCard({
  name,
  kindLabel,
  icon,
  iconTone = 'brand',
  valueUsd,
  valueLabel = 'Value',
  costUsd,
  dividendsUsd = null,
  chips,
  line,
  footnote = null,
  footnoteTone = 'warn',
  targetCompanyId,
  actions = [],
  onAct,
  href = null,
}: PositionCardProps): React.JSX.Element {
  const gain = gainPct(costUsd, valueUsd);

  return (
    <article className="panel-surface min-w-0 px-3 py-3">
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconChip name={icon} tone={iconTone} />
          <div className="min-w-0">
            {href === null ? (
              <p className="truncate text-[13.5px] font-semibold text-ink">{name}</p>
            ) : (
              <Link href={href} className="block truncate text-[13.5px] font-semibold text-ink hover:text-brand">
                {name}
              </Link>
            )}
            <p className="truncate text-[10.5px] text-ink-faint">{kindLabel}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="figure text-[17px] leading-none font-semibold text-ink">{formatMoney(valueUsd)}</span>
          <span className="label-caps-faint">{valueLabel}</span>
        </div>
      </header>

      {chips === undefined ? null : <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div>}

      {/* Cost and gain sit together: a value without what it cost is not a
          position, it is a number. */}
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <dt className="label-caps-faint">Cost</dt>
          <dd className="figure truncate text-[13px] text-ink-dim">{formatMoney(costUsd)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="label-caps-faint">Gain</dt>
          <dd className={cx('figure truncate text-[13px] font-semibold', gain === null ? 'text-ink-faint' : TONE_TEXT[gainTone(gain)])}>
            {pctLabel(gain)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="label-caps-faint">Dividends</dt>
          <dd className="figure truncate text-[13px] text-ink-dim">{dividendsUsd === null ? '—' : formatMoney(dividendsUsd)}</dd>
        </div>
      </dl>

      <p className="mt-2 text-[12px] leading-snug text-ink-dim">{line}</p>
      {footnote === null ? null : (
        <p className={cx('mt-1.5 text-[12px] leading-snug', footnoteTone === 'warn' ? 'text-warn' : 'text-ink-faint')}>{footnote}</p>
      )}

      {actions.length === 0 ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {actions.map((action) => {
            const to = targetCompanyId === null ? null : actionHref(action, targetCompanyId);
            if (to !== null) {
              return (
                <Link key={action} href={to} className="btn btn-ghost btn-sm tap-target gap-1.5 sm:min-h-0">
                  <Icon name="chevronRight" size={13} accent="current" />
                  {ACTION_LABEL[action]}
                </Link>
              );
            }
            return (
              <button
                key={action}
                type="button"
                className="btn btn-sm tap-target sm:min-h-0"
                onClick={() => onAct?.(action)}
                disabled={onAct === undefined}
              >
                {ACTION_LABEL[action]}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

/** The two badges every company row carries, in the order the rest of the app draws them. */
export function CompanyChips({ sector, region }: { readonly sector: Parameters<typeof SectorBadge>[0]['sector']; readonly region: Parameters<typeof RegionBadge>[0]['region'] }): React.JSX.Element {
  return (
    <>
      <SectorBadge sector={sector} />
      <RegionBadge region={region} />
    </>
  );
}

/** A small labelled chip, for the facts that are not sector or region. */
export function FactTag({ tone = 'neutral', children }: { readonly tone?: Tone; readonly children: ReactNode }): React.JSX.Element {
  return (
    <Tag tone={tone} dot>
      {children}
    </Tag>
  );
}

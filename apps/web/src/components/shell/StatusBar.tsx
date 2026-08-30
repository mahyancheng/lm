'use client';

import Link from 'next/link';
import { useState } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  useConnection,
  useFounderNetWorth,
  useLlm,
  useMarketCap,
  usePlayerCompany,
  usePlayerView,
  useSession,
} from '@/lib/game';
import { cx } from '@/components/ui';
import { SettingsDrawer } from './SettingsDrawer';

interface ReadingProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'neutral' | 'gain' | 'loss' | 'warn' | 'brand';
  readonly href?: string;
  readonly title?: string;
  /** Hide below the `xl` breakpoint, where the bar runs out of room. */
  readonly secondary?: boolean;
}

function Reading({ label, value, tone = 'neutral', href, title, secondary = false }: ReadingProps): React.JSX.Element {
  const body = (
    <>
      <span className="label-caps-faint block leading-none">{label}</span>
      <span className={cx('figure block text-[12px] leading-tight', tone === 'neutral' ? 'text-ink' : `tone-${tone}`)}>{value}</span>
    </>
  );
  const classes = cx('min-w-0 px-3 py-1', secondary ? 'hidden xl:block' : 'hidden sm:block');
  return href === undefined ? (
    <div className={classes} title={title}>
      {body}
    </div>
  ) : (
    <Link href={href} className={cx(classes, 'rounded-chip transition-colors hover:bg-raised')} title={title}>
      {body}
    </Link>
  );
}

export interface StatusBarProps {
  /** Opens the mobile navigation sheet. Rendered only below `lg`. */
  readonly onOpenNav: () => void;
  readonly navOpen: boolean;
}

/**
 * The permanent header: where you are in session time, and the five figures a
 * founder checks before doing anything else.
 *
 * Every value comes from committed state through the store. Nothing here is
 * computed by the interface.
 */
export function StatusBar({ onOpenNav, navOpen }: StatusBarProps): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();
  const view = usePlayerView();
  const marketCap = useMarketCap();
  const netWorth = useFounderNetWorth();
  const connection = useConnection();
  const llm = useLlm();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const alerts = view.alerts.length;
  const cash = company.financials.cash;

  return (
    <>
    <header
      className="sticky top-0 z-20 flex items-center gap-1 border-b border-hair bg-panel/92 backdrop-blur"
      style={{ height: 'var(--statusbar-height)' }}
    >
      <button
        type="button"
        onClick={onOpenNav}
        className="btn btn-ghost tap-target ml-1 lg:hidden"
        aria-expanded={navOpen}
        aria-label="Screens"
      >
        <span className="text-[15px] leading-none">{navOpen ? '✕' : '☰'}</span>
      </button>

      <Link href="/command-centre" className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-chip px-3 py-1 hover:bg-raised">
        <span className="figure flex size-7 shrink-0 items-center justify-center rounded-chip bg-brand-strong text-[10px] font-bold text-white shadow-card">
          FC
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] leading-tight font-bold text-ink">{company.name}</span>
          <span className="label-caps-faint block leading-none">Frontier Capital</span>
        </span>
      </Link>

      <div className="figure shrink-0 border-l border-hair px-3 text-[12px] font-semibold text-ink">
        <span className="label-caps-faint block leading-none">Quarter</span>
        {quarterLabel(session.startYear, session.quarter)}
      </div>

      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        <Reading label="Cash" value={formatMoney(cash)} tone={cash < 0 ? 'loss' : 'neutral'} href="/financials" />
        <Reading label="Market cap" value={formatMoney(marketCap)} href="/markets" title="Last quote when listed; the fundamental anchor when private." />
        <Reading label="Net worth" value={formatMoney(netWorth)} href="/leaderboard" secondary />
        <Reading label="Connection" value={String(connection)} tone="brand" href="/network" secondary />
      </div>

      <Link
        href="/command-centre"
        className={cx(
          'press-pop mr-1 flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1.5 text-[11px] font-semibold',
          alerts > 0 ? 'border-warn/30 bg-warn-wash text-warn' : 'border-hair bg-panel text-ink-faint',
        )}
        title={alerts > 0 ? view.alerts.join('\n') : 'No alerts this quarter.'}
      >
        <span className="figure font-semibold">{alerts}</span>
        <span className="hidden sm:inline">alerts</span>
      </Link>

      <span
        className="mr-1 hidden items-center gap-1.5 rounded-pill border border-hair bg-panel px-2.5 py-1.5 text-[10px] font-semibold text-ink-dim md:flex"
        title={
          llm.available
            ? `Live model: ${llm.transportKind}${llm.model === null ? '' : ` (${llm.model})`}. Rivals and world events are model-directed this quarter.`
            : 'No model configured. Every role uses its deterministic fallback; the game plays in full.'
        }
      >
        <span className={cx('inline-block size-1.5 rounded-full', llm.available ? 'bg-gain pulse-dot' : 'bg-ink-faint')} />
        {llm.available ? 'Live' : 'Offline'}
      </span>

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="btn btn-ghost tap-target mr-1.5 shrink-0"
        aria-label="Session settings and save"
        aria-expanded={settingsOpen}
        title="Session settings, the live-model switch and the save file"
      >
        <span className="text-[13px] leading-none">⚙</span>
      </button>
    </header>

    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  useActiveCompany,
  useConnection,
  useFounderNetWorth,
  useLlm,
  useMarketCap,
  usePlayerView,
  useSession,
} from '@/lib/game';
import { Icon, cx } from '@/components/ui';
import { CompanySwitcher } from './CompanySwitcher';
import { SettingsDrawer } from './SettingsDrawer';
import { type SettingsSection, onOpenSettings } from './settingsBus';

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
 * The permanent header: where you are in session time, and the figures a
 * founder checks before doing anything else.
 *
 * On a phone the bar is deliberately six things and no more — who you are, the
 * quarter, the cash, the alerts, whether a model is live, and the way into
 * settings — because a row of small text links in a 56px bar is unusable with
 * a thumb. The rest of the readouts appear from `sm` up, where there is room
 * for them.
 *
 * Every value comes from committed state through the store. Nothing here is
 * computed by the interface.
 */
export function StatusBar({ onOpenNav, navOpen }: StatusBarProps): React.JSX.Element {
  const session = useSession();
  // Follows the switcher: the bar's "Cash" and "Market cap" readings answer
  // for whichever company its name and sector are currently showing, not
  // always the founding one. `netWorth` stays personal — the founder's own
  // wealth across everything they hold, not one company's balance sheet.
  const company = useActiveCompany();
  const view = usePlayerView();
  const marketCap = useMarketCap(company.id);
  const netWorth = useFounderNetWorth();
  const connection = useConnection();
  const llm = useLlm();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsSection | null>(null);

  /** Anything anywhere that explains offline mode can open this sheet at the credential. */
  useEffect(
    () =>
      onOpenSettings((section) => {
        setSettingsFocus(section);
        setSettingsOpen(true);
      }),
    [],
  );

  const alerts = view.alerts.length;
  const cash = company.financials.cash;
  const quarter = quarterLabel(session.startYear, session.quarter);

  return (
    <>
      <header
        className="sticky top-0 z-20 flex items-center gap-0.5 border-b border-hair bg-panel/92 px-0.5 backdrop-blur sm:gap-1 sm:px-1"
        style={{ height: 'var(--statusbar-height)' }}
      >
        <button
          type="button"
          onClick={onOpenNav}
          className="btn btn-ghost tap-target shrink-0 px-0 lg:hidden"
          aria-expanded={navOpen}
          aria-label="All screens"
        >
          <Icon name={navOpen ? 'close' : 'menu'} size={18} accent="current" />
        </button>

        {/* The identity, and STAGE 5's switcher: it is the one shrinkable thing
            in the bar — everything else is a fixed-width control, so the
            company name truncates rather than pushing the settings button off
            the right edge — which is exactly what used to widen the document
            by 14px at 390. `CompanySwitcher` renders the plain link this
            always was for a seat that controls only its founding company, and
            a tap target that opens the switcher sheet otherwise. */}
        <CompanySwitcher />

        {/* Phone: quarter over cash, one compact block instead of a link row. */}
        <div className="ml-auto shrink-0 border-l border-hair px-2 text-right sm:hidden">
          <span className="figure block text-[10px] leading-none font-semibold text-ink-faint">{quarter}</span>
          <span className={cx('figure block text-[12px] leading-tight font-semibold', cash < 0 ? 'tone-loss' : 'text-ink')}>
            {formatMoney(cash)}
          </span>
        </div>

        <div className="figure hidden shrink-0 border-l border-hair px-3 text-[12px] font-semibold text-ink sm:block">
          <span className="label-caps-faint block leading-none">Quarter</span>
          {quarter}
        </div>

        <div className="hidden min-w-0 flex-1 items-center overflow-hidden sm:flex">
          <Reading label="Cash" value={formatMoney(cash)} tone={cash < 0 ? 'loss' : 'neutral'} href="/financials" />
          <Reading
            label="Market cap"
            value={formatMoney(marketCap)}
            href="/markets"
            title="Last quote when listed; the fundamental anchor when private."
          />
          <Reading label="Net worth" value={formatMoney(netWorth)} href="/leaderboard" secondary />
          <Reading label="Connection" value={String(connection)} tone="brand" href="/network" secondary />
        </div>

        <Link
          href="/command-centre"
          className={cx(
            'press-pop tap-target relative flex shrink-0 items-center justify-center gap-1.5 rounded-chip px-0 text-[11px] font-semibold sm:px-2',
            alerts > 0 ? 'text-warn' : 'text-ink-faint hover:bg-raised',
          )}
          aria-label={alerts === 1 ? '1 alert' : `${alerts} alerts`}
          title={alerts > 0 ? view.alerts.join('\n') : 'No alerts this quarter.'}
        >
          <Icon name="bell" size={17} accent="inherit" className="icon-knockout-panel" />
          {alerts > 0 ? (
            <span className="figure absolute top-1.5 right-1 rounded-pill bg-warn px-1 text-[9px] leading-[14px] font-bold text-white sm:static">
              {alerts}
            </span>
          ) : null}
        </Link>

        {/* Not a readout: "Offline" is the one status in this bar the player can
            actually do something about, so it is the button that opens Settings
            at the paste field rather than a chip that states a fact and stops. */}
        <button
          type="button"
          onClick={() => {
            setSettingsFocus('ai');
            setSettingsOpen(true);
          }}
          className={cx(
            'press-pop tap-target flex shrink-0 items-center justify-center gap-1.5 rounded-chip px-0 text-[10px] font-semibold hover:bg-raised md:px-2',
            llm.available ? 'text-gain' : 'text-ink-faint',
          )}
          aria-label={llm.available ? 'Live model configured — open settings' : 'No model configured — open settings'}
          title={
            llm.available
              ? `Live model: ${llm.transportKind}${llm.model === null ? '' : ` (${llm.model})`}. Rivals and world events are model-directed this quarter. Open Settings to test or change the credential.`
              : 'No model configured. Every role uses its deterministic fallback and the game plays in full — click to paste a Claude token.'
          }
        >
          {/* Live is a filled dot and offline is a hollow ring: the state is a
              shape as well as a colour. */}
          <Icon
            name="live"
            size={15}
            accent={llm.available ? 'current' : 'inherit'}
            className={cx('icon-knockout-panel', llm.available ? 'pulse-dot' : undefined)}
          />
          <span className="hidden md:inline">{llm.available ? 'Live' : 'Offline'}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSettingsFocus(null);
            setSettingsOpen(true);
          }}
          className="btn btn-ghost tap-target icon-knockout-panel shrink-0 px-0"
          aria-label="Session settings and save"
          aria-expanded={settingsOpen}
          title="Session settings, the live-model switch and the save file"
        >
          <Icon name="settings" size={17} accent="inherit" />
        </button>
      </header>

      <SettingsDrawer
        open={settingsOpen}
        focus={settingsFocus}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsFocus(null);
        }}
      />
    </>
  );
}

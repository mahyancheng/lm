'use client';

/**
 * V8 — antitrust exposure as one number with its drivers named and signed.
 *
 * `62 / 100` in a three-band colour, and under it the six contributions the
 * engine recorded: what carried over, your share of your own sector, the
 * accord, the acquisitions inside the window, the toll you charge and the
 * quarters you have priced below cost. Nothing is inferred — `CompanyExposure`
 * carries the drivers already, in a fixed order, with the number behind each.
 *
 * Exposure is `company`-visibility on purpose (rule 9): this card renders your
 * own compliance risk, and a rival's exact score is not in the projection to
 * render even if this component asked for it.
 */

import type { CompanyExposure } from '@frontier/contracts';
import { ANTITRUST_BANDS } from '@frontier/contracts';
import { formatDelta } from '@frontier/shared';
import { EmptyState, Icon, Panel, ProgressBar, Tag, cx } from '@/components/ui';
import { BAND_BLURB, BAND_TONE, renderedDrivers } from '../sector/model';

export interface ExposureCardProps {
  readonly exposure: CompanyExposure | null;
  readonly className?: string;
}

export function ExposureCard({ exposure, className }: ExposureCardProps): React.JSX.Element {
  const drivers = renderedDrivers(exposure);
  const tone = exposure === null ? 'neutral' : BAND_TONE[exposure.band];
  const move = exposure === null ? 0 : exposure.after - exposure.before;

  return (
    <Panel
      className={className}
      iconName="stamp"
      iconTone={tone}
      title="Antitrust exposure"
      subtitle="Concentration buys price power and buys you enemies. This is the second half of that trade."
      actions={exposure === null ? undefined : <Tag tone={tone} dot>{exposure.band}</Tag>}
    >
      {exposure === null ? (
        <EmptyState
          compact
          icon="stamp"
          title="No exposure recorded"
          message="Exposure is recomputed every quarter once a session runs more than one sector. Nothing you have done yet is concentration a regulator would notice."
        />
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-1.5">
              <span className={cx('figure text-[34px] leading-none font-bold', `tone-${tone}`)}>{exposure.after}</span>
              <span className="figure text-[15px] text-ink-faint">/ 100</span>
            </div>
            {move === 0 ? null : (
              <span className={cx('figure text-[12px]', move > 0 ? 'tone-loss' : 'tone-gain')}>
                {formatDelta(move, 'number')} this quarter
              </span>
            )}
          </div>

          {/* The two band edges are drawn on the bar, so "how close am I to
              watched" is a distance rather than a fact you have to remember. */}
          <div className="mt-2.5">
            <div className="relative">
              <ProgressBar value={exposure.after} max={100} tone={tone} height={10} />
              {[ANTITRUST_BANDS.watched, ANTITRUST_BANDS.exposed].map((edge) => (
                <span
                  key={edge}
                  aria-hidden="true"
                  className="absolute top-0 h-[10px] w-px bg-ink-faint/60"
                  style={{ left: `${edge}%` }}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
              <span>0 calm</span>
              <span>{ANTITRUST_BANDS.watched} watched</span>
              <span>{ANTITRUST_BANDS.exposed} exposed</span>
            </div>
          </div>

          <p className={cx('mt-2 text-[11.5px] leading-snug font-semibold', `tone-${tone}`)}>{BAND_BLURB[exposure.band]}</p>

          <ul className="mt-3 flex flex-col">
            {drivers.map((driver) => (
              <li key={driver.key} className="flex items-center gap-2 border-b border-hair py-1.5 last:border-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">{driver.label}</span>
                  <span className="block truncate text-[10px] text-ink-faint">{driver.detail}</span>
                </span>
                <span className={cx('figure shrink-0 text-[13px] tabular-nums', `tone-${driver.tone}`)}>{driver.pointsLabel}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-faint">
            <Icon name="warning" size={12} accent="current" className="mt-px shrink-0" />
            A tenth of the score falls away every quarter you do nothing, so this is a dial rather than a ratchet. An
            investigation clears thirty points and costs a fine and a suspended accord.
          </p>
        </>
      )}
    </Panel>
  );
}

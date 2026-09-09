'use client';

/**
 * The price accord, as a form.
 *
 * Plutocracy's cartel: two to six companies in one sector holding the price
 * together, paid a bonus that scales with their combined share of that sector
 * and floored at five per cent whatever the share. This is the one deal
 * obligation whose whole point is a number, so the number is under the control
 * (V5) and the antitrust it buys is on the term (V8).
 *
 * Both figures are the engine's own: `cartelBonusPct` is the function
 * `resolveFinancials` reads the bonus through, and the exposure points come out
 * of `antitrustExposure` rather than from a weight this file remembers. The
 * combined share is the sum of committed member revenues over the sector's
 * committed supply — the same two engine figures the ladder divides.
 *
 * A member whose revenue is not on the public record contributes to the accord
 * in the engine and cannot be counted here, so the preview says "at least"
 * rather than pretending to a total it does not have.
 */

import type { DealObligation, Sector } from '@frontier/contracts';
import {
  ANTITRUST_EXPOSURE_WEIGHTS,
  CARTEL_BONUS_FLOOR_PCT,
  SECTOR_META,
  antitrustExposure,
  cartelBonusPct,
} from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { Icon, NowAfter, SliderField, Tag, cx } from '@/components/ui';
import { exposureCostLabel, type LadderRow } from '../sector/model';

/** What the accord form needs to know about the world it is being drafted in. */
export interface AccordContext {
  /** Sectors a company in this session actually stands in. */
  readonly sectors: readonly Sector[];
  /** Ladder rows per sector: name, disclosed share and whether it is you. */
  readonly ladderFor: (sector: Sector) => readonly LadderRow[];
  /** The sector's committed annual supply, for the share denominator. */
  readonly supplyFor: (sector: Sector) => number;
}

/** Whole exposure points membership of an accord is worth, from the engine's weights. */
export function accordExposurePoints(): number {
  const { contributions } = antitrustExposure({
    exposure: 0,
    sectorShare: 0,
    inAccord: true,
    recentAcquisitions: 0,
    tollChargedPct: 0,
    predatoryQuarters: 0,
  });
  return contributions.find((entry) => entry.key === 'accord')?.points ?? ANTITRUST_EXPOSURE_WEIGHTS.accord;
}

export interface AccordFieldsProps {
  readonly obligation: Extract<DealObligation, { kind: 'price_accord' }>;
  readonly onChange: (next: DealObligation) => void;
  readonly context: AccordContext;
}

export function AccordFields({ obligation, onChange, context }: AccordFieldsProps): React.JSX.Element {
  const sectors = context.sectors.length > 0 ? context.sectors : ([obligation.sector] as readonly Sector[]);
  const candidates = context.ladderFor(obligation.sector).filter((row) => !row.isUndisclosed);
  const chosen = new Set(obligation.memberCompanyIds);

  // Disclosed share only. An undisclosed member counts in the engine and is
  // stated as such rather than estimated here.
  let disclosedShare = 0;
  let undisclosedMembers = 0;
  for (const row of candidates) {
    if (!chosen.has(row.key)) continue;
    if (row.share === null) undisclosedMembers += 1;
    else disclosedShare += row.share;
  }

  const bonus = cartelBonusPct(disclosedShare);
  const points = accordExposurePoints();
  const badge = exposureCostLabel(points);
  const tooFew = obligation.memberCompanyIds.length < 2;

  function toggle(companyId: string): void {
    const next = chosen.has(companyId)
      ? obligation.memberCompanyIds.filter((id) => id !== companyId)
      : [...obligation.memberCompanyIds, companyId].slice(0, 6);
    onChange({ ...obligation, memberCompanyIds: next });
  }

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <label className="block">
        <span className="label-caps-faint">Sector</span>
        <select
          className="field tap-target mt-1 sm:min-h-0"
          value={obligation.sector}
          onChange={(event) => onChange({ ...obligation, sector: event.target.value as Sector, memberCompanyIds: [] })}
        >
          {sectors.map((sector) => (
            <option key={sector} value={sector}>
              {SECTOR_META[sector].label}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span className="label-caps-faint">Members — two to six, all in {SECTOR_META[obligation.sector].label}</span>
        {candidates.length === 0 ? (
          <p className="mt-1 text-[11px] text-ink-faint">Nobody in this session operates in that sector.</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {candidates.map((row) => {
              const on = chosen.has(row.key);
              return (
                <button
                  key={row.key}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && obligation.memberCompanyIds.length >= 6}
                  className={cx(
                    'tap-target inline-flex items-center gap-1.5 rounded-pill border px-3 text-[12px] font-semibold sm:min-h-0 sm:py-1',
                    on ? 'border-warn/45 bg-warn-wash text-warn' : 'border-hair bg-panel text-ink-dim hover:bg-raised',
                  )}
                  onClick={() => toggle(row.key)}
                >
                  {on ? <Icon name="check" size={12} accent="current" /> : null}
                  {row.label}
                  <span className="figure text-[10px] opacity-70">{row.share === null ? '—' : formatPct(row.share)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <SliderField
        label="Quarters in force"
        value={obligation.quarters}
        onChange={(next) => onChange({ ...obligation, quarters: Math.round(next) })}
        min={1}
        max={20}
        step={1}
        format={(value) => `${Math.round(value)} quarter${Math.round(value) === 1 ? '' : 's'}`}
        exact={false}
        preview={
          <NowAfter
            nowLabel="Alone"
            afterLabel="In accord"
            rows={[
              { key: 'bonus', label: 'Bonus on the repriced part of revenue', now: '0%', after: `+${bonus}%`, tone: 'gain' },
              { key: 'share', label: 'Combined share of the sector', now: '—', after: `${undisclosedMembers > 0 ? 'at least ' : ''}${formatPct(disclosedShare)}`, tone: 'neutral' },
              { key: 'exposure', label: 'Antitrust exposure, every member', now: '+0', after: `+${points}`, tone: 'loss' },
            ]}
            note={`The floor is ${CARTEL_BONUS_FLOOR_PCT}% at any share, and the bonus can never push the chain uplift past a quarter of revenue. Sector supply ${formatMoney(context.supplyFor(obligation.sector))} a year.`}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {badge === null ? null : <Tag tone="loss" dot>{badge}</Tag>}
        {tooFew ? <Tag tone="warn">needs at least two members</Tag> : null}
        {undisclosedMembers > 0 ? <Tag tone="neutral">{undisclosedMembers} member(s) do not file</Tag> : null}
      </div>
    </div>
  );
}

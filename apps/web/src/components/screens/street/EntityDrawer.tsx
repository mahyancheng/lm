'use client';

/**
 * One institution, opened.
 *
 * The card says what they can still do to you; this says what they have
 * actually done. Portfolio, short book, track record, the partner with a link
 * into Network, and every ledger row the entity produced this quarter — because
 * §6.2 says every derived number is a tap target that ends at the row it came
 * from, and this is where that trail ends.
 *
 * Redaction, never repair: the projection already dropped every position below
 * the disclosure threshold that is not in one of the reader's own companies, so
 * a short book with nothing in it means nothing is disclosed, not that nothing
 * exists — and the panel says so in those words rather than inventing a total.
 */

import Link from 'next/link';
import type { SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  Drawer,
  EmptyState,
  Icon,
  KeyValueGrid,
  ProgressBar,
  SectionHeading,
  Tag,
  cx,
} from '@/components/ui';
import { humanise } from '@/components/screens/reporting/util';
import {
  CAPITAL_KIND_BLURB,
  CAPITAL_KIND_LABEL,
  LP_BAND_LABEL,
  LP_BAND_TONE,
  STANCE_LABEL,
  STANCE_TONE,
  forcedSellerLine,
  multipleLabel,
  multipleTone,
  shortInterestBadge,
  shortInterestLine,
  type StreetCardRow,
} from './model';

export interface EntityDrawerProps {
  readonly card: StreetCardRow | null;
  readonly onClose: () => void;
  readonly startYear: number;
  readonly quarter: number;
  readonly companyNameOf: (companyId: string) => string;
  readonly partnerName: string | null;
  /** Committed rows this entity produced, oldest first. */
  readonly ledgerRows: readonly SimEvent[];
}

export function EntityDrawer({
  card,
  onClose,
  startYear,
  quarter,
  companyNameOf,
  partnerName,
  ledgerRows,
}: EntityDrawerProps): React.JSX.Element | null {
  if (card === null) return null;
  const { row } = card;
  const bandTone = LP_BAND_TONE[row.lpBand];

  return (
    <Drawer
      open
      onClose={onClose}
      title={row.name}
      subtitle={`${CAPITAL_KIND_LABEL[row.kind]} · ${quarterLabel(startYear, quarter)}`}
      width={520}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={STANCE_TONE[card.stance]} dot>
            {STANCE_LABEL[card.stance]}
          </Tag>
          <Tag tone={bandTone}>{LP_BAND_LABEL[row.lpBand]}</Tag>
        </div>

        <p className="text-[13px] leading-relaxed text-ink-dim sm:text-[12px]">{row.thesis}</p>
        <p className="text-[11px] leading-relaxed text-ink-faint">{CAPITAL_KIND_BLURB[row.kind]}</p>

        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Committed capital', value: formatMoney(row.aumUsd) },
            { label: 'Dry powder', value: `${formatMoney(row.dryPowderUsd)} · ${row.dryPowderPct}%` },
            { label: 'Deployed, at cost', value: formatMoney(row.deployedUsd) },
            { label: 'Marked value', value: formatMoney(row.navUsd) },
            { label: 'Returned to LPs', value: formatMoney(row.realisedProceedsUsd) },
            { label: 'DPI', value: `${row.dpiPct}%`, hint: 'Distributions over paid-in. What LPs actually count.' },
            { label: 'Track record', value: `${row.trackRecord}` },
            { label: 'Positions', value: `${row.positionCount}` },
          ]}
        />

        <div>
          <SectionHeading rule>The clock</SectionHeading>
          <ProgressBar className="mt-2" value={row.lpPressure} max={100} tone={bandTone} label="LP pressure" valueLabel={`${row.lpPressure} / 100`} />
          <p className={cx('mt-1.5 text-[11.5px]', `tone-${bandTone}`)}>{forcedSellerLine(row)}</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
            Nothing random creates a forced seller. A fund’s term does: pressure rises with age and falls with every dollar
            returned, so an old fund with nothing distributed sells whatever the price.
          </p>
        </div>

        <div>
          <SectionHeading rule>Portfolio</SectionHeading>
          {card.portfolio.length === 0 ? (
            <EmptyState
              compact
              className="mt-2"
              icon="building"
              title="Nothing disclosed"
              message="A position below the disclosure threshold is absent from this list rather than summarised. They may hold names you cannot see."
            />
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {card.portfolio.map((position) => (
                <li key={`${position.entityId}_${position.companyId}_${position.securityId}`} className="raised-surface px-2.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[12.5px] text-ink">{companyNameOf(position.companyId)}</span>
                    <span className="figure shrink-0 text-[12px] font-semibold text-ink">{position.stakePct}%</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-[10.5px] text-ink-faint">
                      since {quarterLabel(startYear, position.sinceQuarter)} · cost {formatMoney(position.costBasisUsd)}
                    </span>
                    <span className={cx('figure text-[11px] font-semibold', `tone-${multipleTone(position)}`)}>
                      {multipleLabel(position)} of cost
                    </span>
                  </div>
                  {position.isDisclosed ? null : (
                    <p className="mt-1 text-[10px] text-ink-faint">Undisclosed — visible to you only because it is your own register.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <SectionHeading rule>Short book</SectionHeading>
          {card.shorts.length === 0 ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Nothing disclosed. A short below the disclosure threshold is absent from the record rather than summarised,
              which is exactly what makes one worth building quietly.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {card.shorts.map((short) => {
                const badge = shortInterestBadge(short);
                return (
                  <li key={short.instrumentId} className="raised-surface px-2.5 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[12.5px] text-ink">{companyNameOf(short.companyId)}</span>
                      <Tag tone={badge.tone}>{badge.label}</Tag>
                    </div>
                    <p className="mt-1 figure text-[11px] text-ink-dim">{shortInterestLine(short)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {row.partnerCharacterId === null ? null : (
          <div>
            <SectionHeading rule>The partner</SectionHeading>
            <Link
              href="/network"
              className="btn tap-target mt-2 w-full justify-between gap-2 sm:w-auto"
            >
              <span className="flex items-center gap-1.5">
                <Icon name="people" size={15} accent="current" />
                {partnerName ?? row.partnerCharacterId}
              </span>
              <Icon name="chevronRight" size={14} accent="current" />
            </Link>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
              An ordinary character with an ordinary relationship. What they say is theirs; every number on this screen is
              the engine’s.
            </p>
          </div>
        )}

        <div>
          <SectionHeading rule>This quarter, in the ledger</SectionHeading>
          {ledgerRows.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              No committed rows for this institution in the quarter this tab is holding.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {ledgerRows.map((event) => (
                <li key={event.eventId} className="flex items-baseline justify-between gap-2 border-b border-hair pb-1 last:border-b-0">
                  <span className="min-w-0 truncate text-[11.5px] text-ink-dim">{humanise(event.type)}</span>
                  <span className="figure shrink-0 text-[10px] text-ink-faint">
                    {quarterLabel(startYear, event.quarter)} · #{event.sequence}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {row.causeEventId === null ? null : (
            <p className="mt-1.5 figure text-[10px] text-ink-faint">Marked by {row.causeEventId}</p>
          )}
        </div>
      </div>
    </Drawer>
  );
}

'use client';

/**
 * Countering a term sheet: two sliders, and the band shown before you commit.
 *
 * The band is engine-computed — `COUNTER_BAND_PCT` on the price and one seat
 * either way — so there is no reason to hide it. A counter inside the band is
 * marked as such on the sheet itself; one outside is still allowed to be sent,
 * because refusing to let a founder ask is not the same as the fund saying no.
 *
 * Mechanically a counter is an ordinary `propose_deal` back to the partner
 * carrying the same term sheet with the two fields a player may move. There is
 * no second offer pipeline: the deal path already proposes, accepts, rejects,
 * expires and audits.
 */

import { useState } from 'react';
import type { ActionValidationResult, DealProposal } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { NowAfter, SliderField, Tag, cx, roundStep } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { counterBand, counterInsideBand, counteredTermSheet, type TermSheet } from './model';

export interface CounterSheetProps {
  readonly sheet: TermSheet;
  readonly deal: DealProposal;
  readonly partnerName: string;
  readonly quarter: number;
  readonly startYear: number;
  readonly onDone: (result: ActionValidationResult) => void;
  readonly onCancel: () => void;
}

export function CounterSheet({
  sheet,
  deal,
  partnerName,
  quarter,
  startYear,
  onDone,
  onCancel,
}: CounterSheetProps): React.JSX.Element {
  const band = counterBand(sheet);
  const [preMoneyUsd, setPreMoneyUsd] = useState(sheet.preMoneyUsd);
  const [boardSeats, setBoardSeats] = useState(sheet.boardSeats);

  const inside = counterInsideBand(sheet, preMoneyUsd, boardSeats);
  const countered = counteredTermSheet(sheet, preMoneyUsd, boardSeats);
  const { queueAction } = useGameActions();

  function send(): void {
    const outcome = queueAction(
      {
        type: 'propose_deal',
        proposal: {
          counterpartyId: deal.proposerId,
          counterpartyKind: deal.proposerKind,
          gives: [],
          gets: [countered],
          confidentiality: 'private',
          expiresQuarter: quarter + 2,
          binding: true,
          intentStatements: [],
          summary: `Counter to ${partnerName}: ${formatMoney(countered.amountUsd)} at ${formatMoney(countered.preMoneyUsd)} pre-money for ${countered.dilutionPct}%, ${countered.boardSeats} board seat${countered.boardSeats === 1 ? '' : 's'}.`,
        },
      },
      { confirmed: true },
    );
    onDone(outcome.validation);
  }

  return (
    <div className="raised-surface px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-caps-faint">Counter the terms</span>
        <Tag tone={inside ? 'gain' : 'warn'} dot>
          {inside ? 'Inside their band' : 'Outside their band'}
        </Tag>
      </div>

      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
        {partnerName}’s own score computed a band of {formatMoney(band.minUsd)}–{formatMoney(band.maxUsd)} on the price and{' '}
        {band.minSeats}–{band.maxSeats} on the seat. The engine computed it; the partner supplies only the words.
      </p>

      <SliderField
        className="mt-3"
        label="Pre-money"
        value={preMoneyUsd}
        onChange={setPreMoneyUsd}
        min={band.minUsd}
        max={band.maxUsd}
        step={roundStep(band.maxUsd - band.minUsd)}
        format={formatMoney}
        ariaLabel="Counter pre-money valuation"
      />

      <SliderField
        className="mt-3"
        label="Board seats for the investor"
        value={boardSeats}
        onChange={setBoardSeats}
        min={band.minSeats}
        max={band.maxSeats}
        step={1}
        format={(value) => `${Math.round(value)} seat${Math.round(value) === 1 ? '' : 's'}`}
        ariaLabel="Counter board seats"
      />

      <NowAfter
        className="mt-3"
        nowLabel="Offered"
        afterLabel="Countered"
        rows={[
          { key: 'price', label: 'Pre-money', now: formatMoney(sheet.preMoneyUsd), after: formatMoney(countered.preMoneyUsd) },
          {
            key: 'dilution',
            label: 'You give up',
            now: `${sheet.dilutionPct}%`,
            after: `${countered.dilutionPct}%`,
            tone: countered.dilutionPct < sheet.dilutionPct ? 'gain' : countered.dilutionPct > sheet.dilutionPct ? 'loss' : undefined,
          },
          {
            key: 'seats',
            label: 'Their seats',
            now: `${sheet.boardSeats}`,
            after: `${countered.boardSeats}`,
            tone: countered.boardSeats < sheet.boardSeats ? 'gain' : countered.boardSeats > sheet.boardSeats ? 'loss' : undefined,
          },
        ]}
        note={`Goes back as a fresh proposal, answerable from ${quarterLabel(startYear, quarter + 1)}. The cheque itself is not negotiable here.`}
      />

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-sm tap-target" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={cx('btn btn-sm btn-primary tap-target')} onClick={send}>
          Queue the counter
        </button>
      </div>
    </div>
  );
}

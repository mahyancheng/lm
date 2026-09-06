'use client';

/**
 * Offers — capital offered to you, and approaches made for you.
 *
 * Absent when the inbox is empty: a heading over nothing is worse than no
 * heading. When it is not empty it is the loudest thing on Home after the
 * queue, because an offer lapses. The top three are stated in full; every row
 * and the header open The Street, where the whole list and the defences are.
 *
 * The one-quarter delay before an offer can be answered is the engine's
 * (`offerInbox`), and each row says which quarter it becomes answerable in
 * rather than hiding the wait.
 */

import Link from 'next/link';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { Icon, Panel, Tag } from '@/components/ui';
import { sheetHref } from '@/lib/sheets';
import { answerableCount, buyoutOf, termSheetOf, type OfferCardRow } from '../street/model';

/** Offers stated in full. The rest are counted. */
export const OFFERS_SHOWN = 3;

export interface OffersCardProps {
  readonly offers: readonly OfferCardRow[];
  /** For `quarterLabel`: the year the session opened in. */
  readonly startYear: number;
}

/** What this offer is, in one line. */
function textOf(offer: OfferCardRow): string {
  const sheet = offer.deal === null ? null : termSheetOf(offer.deal);
  if (sheet !== null) {
    return `${formatMoney(sheet.amountUsd)} at ${formatMoney(sheet.preMoneyUsd)} pre-money for ${sheet.dilutionPct}%`;
  }
  const buyout = offer.deal === null ? null : buyoutOf(offer.deal);
  if (buyout !== null) return `An approach at ${formatMoney(buyout.offerValueUsd)}, ${buyout.premiumPct}% over the mark`;
  return 'An activist campaign is open against you';
}

export function OffersCard({ offers, startYear }: OffersCardProps): React.JSX.Element | null {
  if (offers.length === 0) return null;

  const toAnswer = answerableCount(offers);
  const shown = offers.slice(0, OFFERS_SHOWN);
  const hidden = offers.length - shown.length;

  return (
    <Panel
      title="Offers"
      iconName="briefcase"
      iconTone={toAnswer > 0 ? 'warn' : 'neutral'}
      subtitle="An offer made this quarter is answerable next."
      actions={<Tag tone={toAnswer > 0 ? 'warn' : 'neutral'}>{toAnswer === 1 ? '1 to answer' : `${toAnswer} to answer`}</Tag>}
    >
      <ul className="flex flex-col gap-1.5">
        {shown.map((offer) => (
          <li key={offer.id}>
            <Link
              href={sheetHref('street')}
              className="raised-surface press-pop tap-target flex flex-wrap items-center justify-between gap-2 px-3 py-2 transition-colors hover:border-hair-strong"
            >
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink">{textOf(offer)}</span>
              <Tag tone={offer.isAnswerable ? 'warn' : 'neutral'} dot>
                {offer.isAnswerable ? 'answer now' : `from ${quarterLabel(startYear, offer.answerableFromQuarter)}`}
              </Tag>
            </Link>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Link
          href={sheetHref('street')}
          className="tap-target mt-2 flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-dim"
        >
          {hidden} more on The Street
          <Icon name="chevronRight" size={12} accent="current" />
        </Link>
      ) : null}
    </Panel>
  );
}

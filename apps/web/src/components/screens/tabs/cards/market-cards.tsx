'use client';

/**
 * The Market tab's cards: your stock, your money and everyone aiming at it.
 *
 * Seven cards. Four of them are merges the old shape could not make: the
 * valuation figures Markets and Capital both drew are one card; the holders,
 * the short book, the campaigns and the offers count — which used to live on
 * three screens — are one "against you" card; the trade ticket has one
 * component with two mounts; and the acquisition desk exists in exactly one
 * place, the Deal Room, so a position links to it rather than carrying a
 * second copy of the same form.
 *
 * Pure by construction: every figure arrives as a prop, derived by `MarketTab`
 * from the same functions the sheets read.
 */

import type { ReactNode } from 'react';
import { formatCount, formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import { EmptyState, KeyValueGrid, Meter, Tag } from '@/components/ui';
import type { ShortBadge } from '@/components/screens/street';
import { sheetHref } from '@/lib/sheets';
import { DrillRow, TabCard } from './shell';

/* -------------------------------------------------------------------------- */
/*  Your stock                                                                 */
/* -------------------------------------------------------------------------- */

export interface StockCardProps {
  readonly companyName: string;
  readonly marketCapUsd: number;
  /** Null when the company is private: there is no last close to print. */
  readonly lastPriceUsd: number | null;
  readonly lastReturn: number | null;
  /** The founder's own economic stake, from the cap-table rows. */
  readonly ownStakePct: number;
  readonly issuedShares: number;
  /** The instrument, when listed. It is also the sheet param the card opens with. */
  readonly instrumentId: string | null;
  readonly history: readonly number[];
}

/** A compact reading of the actual closes, kept deliberately free of axes or invented targets. */
export function QuoteHistory({ history }: { readonly history: readonly number[] }): React.JSX.Element | null {
  if (history.length < 2) return null;
  const low = Math.min(...history);
  const spread = Math.max(1, Math.max(...history) - low);
  const rising = (history[history.length - 1] ?? 0) >= (history[0] ?? 0);
  return (
    <div className="mt-3 border-t border-hair pt-3" aria-label={`${history.length} quarterly closes on the record`}>
      <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-ink-faint">
        <span>Quarterly closes</span>
        <span>{history.length} on record</span>
      </div>
      <div className="flex h-10 items-end gap-1" aria-hidden="true">
        {history.map((price, index) => (
          <span
            key={`${index}-${price}`}
            className={rising ? 'min-w-1 flex-1 rounded-sm bg-gain/70' : 'min-w-1 flex-1 rounded-sm bg-loss/70'}
            style={{ height: `${18 + ((price - low) / spread) * 82}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function StockCard({
  companyName,
  marketCapUsd,
  lastPriceUsd,
  lastReturn,
  ownStakePct,
  issuedShares,
  instrumentId,
  history,
}: StockCardProps): React.JSX.Element {
  const listed = instrumentId !== null;
  return (
    <TabCard
      // Listed: straight to this instrument's own drawer, where the ticket is.
      // Private: there is no instrument to open, so the card opens Capital,
      // which is where a private company's valuation actually comes from.
      sheet={listed ? 'exchange' : 'capital'}
      title={`${companyName} · your stock`}
      params={instrumentId === null ? undefined : { item: instrumentId }}
      iconTone="brand"
      subtitle={listed ? 'Last close on the in-world exchange.' : 'Private — marked to the fundamental anchor.'}
      badges={<Tag tone={listed ? 'info' : 'neutral'}>{listed ? 'listed' : 'private'}</Tag>}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Market cap', value: formatMoney(marketCapUsd) },
          {
            label: 'Last quote',
            value: lastPriceUsd === null ? '—' : formatMoney(lastPriceUsd, 'full'),
            tone: lastReturn === null ? undefined : lastReturn < 0 ? 'loss' : 'gain',
            hint: lastReturn === null ? 'No close — the company is not on the exchange' : `${formatPct(lastReturn)} on the quarter`,
          },
          { label: 'Your stake', value: formatPct(ownStakePct), hint: 'Economic, from the register' },
          { label: 'Issued shares', value: formatCount(issuedShares) },
        ]}
      />
      <QuoteHistory history={history} />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Cash and funding                                                           */
/* -------------------------------------------------------------------------- */

export interface FundingCardProps {
  readonly cashUsd: number;
  /** `quarterlyBurn`: positive is cash generated, negative is cash consumed. */
  readonly cashMovementUsd: number;
  readonly runwayQuarters: number | null;
  readonly debtUsd: number;
  readonly interestUsd: number;
  /** `world.capitalMarkets.ipoWindow`, 0..1 — how open the listing window is. */
  readonly listingWindow: number;
}

export function FundingCard({ cashUsd, cashMovementUsd, runwayQuarters, debtUsd, interestUsd, listingWindow }: FundingCardProps): React.JSX.Element {
  const burn = Math.max(0, -cashMovementUsd);
  return (
    <TabCard sheet="capital" title="Cash and funding" subtitle="What you hold, what it is going out at, and what the market would fund.">
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Cash', value: formatMoney(cashUsd), tone: cashUsd <= 0 ? 'loss' : undefined },
          {
            label: 'Burn',
            value: burn === 0 ? formatMoney(cashMovementUsd) : formatMoney(burn),
            tone: burn === 0 ? 'gain' : 'loss',
            hint: burn === 0 ? 'Cash generative' : 'Net cash consumed each quarter',
          },
          {
            label: 'Runway',
            value: runwayQuarters === null ? '∞' : formatQuarterCount(runwayQuarters),
            tone: runwayQuarters === null ? 'gain' : runwayQuarters < 3 ? 'loss' : runwayQuarters < 6 ? 'warn' : undefined,
          },
          { label: 'Debt', value: formatMoney(debtUsd), hint: `Interest ${formatMoney(interestUsd)} this quarter` },
        ]}
      />
      <Meter className="mt-3" value={listingWindow * 100} label="Listing window" />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Your register / against you                                                */
/* -------------------------------------------------------------------------- */

export interface HolderRow {
  readonly entityId: string;
  readonly name: string;
  readonly stakePct: number;
}

export interface RegisterCardProps {
  /** Disclosed holders, largest first — `registerModel` caps the list at three. */
  readonly holders: readonly HolderRow[];
  /** The reader's own economic stake, so the register reads as a fight. */
  readonly ownStakePct: number;
  /** The short book on your own instrument, with the engine's own badge. */
  readonly shortInterestPct: number | null;
  readonly shortBadge: ShortBadge | null;
  readonly liveCampaigns: number;
  readonly dryPowderAimedAtYouUsd: number;
  /** `answerableCount(offers)` — offers you may answer this quarter. */
  readonly answerable: number;
  readonly offers: number;
}

export function RegisterCard({
  holders,
  ownStakePct,
  shortInterestPct,
  shortBadge,
  liveCampaigns,
  dryPowderAimedAtYouUsd,
  answerable,
  offers,
}: RegisterCardProps): React.JSX.Element {
  const underAttack = answerable > 0 || liveCampaigns > 0 || dryPowderAimedAtYouUsd > 0;
  return (
    <TabCard
      sheet="street"
      title="Your register"
      iconTone={underAttack ? 'warn' : 'neutral'}
      subtitle="Who owns you, who is short of you, and who is coming for you."
      badges={
        <>
          {answerable > 0 ? <Tag tone="warn" dot>{`${answerable} to answer`}</Tag> : null}
          {shortBadge === null ? null : (
            <Tag tone={shortBadge.tone} dot={shortBadge.risk !== 'fired'}>
              {shortBadge.label}
            </Tag>
          )}
        </>
      }
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Your stake', value: formatPct(ownStakePct) },
          {
            label: 'Short interest',
            value: shortInterestPct === null ? '—' : `${shortInterestPct}%`,
            tone: shortBadge === null || shortBadge.risk === 'none' ? undefined : shortBadge.tone,
            hint: shortInterestPct === null ? 'No disclosed short book in your name' : 'Of the float',
          },
          {
            label: 'Live campaigns',
            value: formatCount(liveCampaigns),
            tone: liveCampaigns > 0 ? 'loss' : undefined,
            hint: liveCampaigns > 0 ? 'Open against you now' : 'Nobody is running one',
          },
          {
            label: 'Dry powder aimed at you',
            value: formatMoney(dryPowderAimedAtYouUsd),
            tone: dryPowderAimedAtYouUsd > 0 ? 'loss' : undefined,
            hint: 'Held by the institutions currently hostile or adversarial',
          },
          {
            label: 'Offers on the table',
            value: formatCount(offers),
            tone: answerable > 0 ? 'warn' : undefined,
            hint: offers === answerable ? 'Every one answerable now' : `${offers - answerable} answerable next quarter`,
            wide: true,
          },
        ]}
      />

      {holders.length === 0 ? (
        <EmptyState
          className="mt-3"
          compact
          icon="vault"
          title="No disclosed institutional holder"
          message="Below the disclosure threshold a holder is absent from the record — which is what makes a quiet accumulation possible."
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {holders.map((holder) => (
            <li key={holder.entityId}>
              <DrillRow href={sheetHref('street', { entity: holder.entityId })} name={holder.name} detail="disclosed holder" figure={`${holder.stakePct}%`} />
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  The tape                                                                   */
/* -------------------------------------------------------------------------- */

export interface TapeCardProps {
  /** `TapeStrip`, supplied by the tab so this card stays hook-free. */
  readonly strip: ReactNode;
  /** One line of sector aggregates: how many names, and what they are worth. */
  readonly sectorLine: string;
}

export function TapeCard({ strip, sectorLine }: TapeCardProps): React.JSX.Element {
  return (
    <TabCard sheet="exchange" title="The tape" subtitle={sectorLine} flush>
      {strip}
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Portfolio                                                                  */
/* -------------------------------------------------------------------------- */

export interface PortfolioCardProps {
  readonly netWorthUsd: number;
  readonly heldValueUsd: number;
  readonly stakes: number;
  readonly subsidiaries: number;
  readonly funds: number;
  readonly line: string;
}

export function PortfolioCard({ netWorthUsd, heldValueUsd, stakes, subsidiaries, funds, line }: PortfolioCardProps): React.JSX.Element {
  return (
    <TabCard sheet="portfolio" subtitle={line}>
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Your net worth', value: formatMoney(netWorthUsd), hint: 'Personal cash and holdings, as the board measures it' },
          { label: 'Shares held', value: formatMoney(heldValueUsd), hint: `${stakes} position${stakes === 1 ? '' : 's'} outside the company` },
          { label: 'Subsidiaries', value: formatCount(subsidiaries) },
          { label: 'Funds', value: formatCount(funds) },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Deals                                                                      */
/* -------------------------------------------------------------------------- */

export interface DealsCardProps {
  /** Proposed to you and awaiting your answer. */
  readonly toAnswer: number;
  /** Proposed by you and awaiting theirs. */
  readonly outstanding: number;
  /** Accepted and binding. */
  readonly live: number;
  /** Proposed and past their expiry quarter. */
  readonly lapsing: number;
}

export function DealsCard({ toAnswer, outstanding, live, lapsing }: DealsCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="deals"
      title="Deals"
      iconTone={toAnswer > 0 ? 'warn' : 'neutral'}
      subtitle="Every structured instrument: obligations, licences, accords and acquisitions."
      badges={toAnswer > 0 ? <Tag tone="warn" dot>{`${toAnswer} to answer`}</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'To answer', value: formatCount(toAnswer), tone: toAnswer > 0 ? 'warn' : undefined },
          { label: 'Outstanding', value: formatCount(outstanding), hint: 'Sent, awaiting their answer' },
          { label: 'Live', value: formatCount(live), tone: live > 0 ? 'gain' : undefined, hint: 'Accepted and binding' },
          { label: 'Lapsing', value: formatCount(lapsing), tone: lapsing > 0 ? 'loss' : undefined, hint: 'Unanswered past the expiry quarter' },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Boardroom                                                                  */
/* -------------------------------------------------------------------------- */

export interface BoardCardProps {
  /** Null when the company has no board — a founder's brief, precious freedom. */
  readonly seatsFilled: number | null;
  readonly seatsAuthorised: number;
  readonly mood: number;
  readonly passThreshold: number;
  readonly mattersTabled: number;
}

export function BoardCard({ seatsFilled, seatsAuthorised, mood, passThreshold, mattersTabled }: BoardCardProps): React.JSX.Element {
  if (seatsFilled === null) {
    return (
      <TabCard sheet="boardroom" subtitle="Nobody to answer to yet.">
        <EmptyState
          compact
          icon="boardTable"
          title="No board"
          message="A company too small to have a board needs no approval for anything. A board arrives with the first investor seat."
        />
      </TabCard>
    );
  }
  return (
    <TabCard
      sheet="boardroom"
      subtitle="Who sits, how they feel, and what it takes to carry a vote."
      badges={mattersTabled > 0 ? <Tag tone="info" dot>{`${mattersTabled} tabled`}</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Seats filled', value: `${seatsFilled} / ${seatsAuthorised}` },
          {
            label: 'Board mood',
            value: formatScore(mood),
            tone: mood >= 40 ? 'gain' : mood >= 0 ? 'warn' : 'loss',
            hint: 'How the room feels about the chief executive, −100 to 100',
          },
          { label: 'Pass threshold', value: formatPct(passThreshold) },
          { label: 'Matters tabled', value: formatCount(mattersTabled) },
        ]}
      />
    </TabCard>
  );
}

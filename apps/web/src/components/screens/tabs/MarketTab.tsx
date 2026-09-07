'use client';

/**
 * Market — your stock, your money, and everyone aiming at it, on one page.
 *
 * Seven cards in the order the plan sets: your stock, cash and funding, your
 * register, the tape, the portfolio, deals, the boardroom. Four screens used to
 * answer one subject between them; this page states the answer and each card
 * opens the one sheet that acts on it.
 *
 * The four merges this stage lands:
 *
 * 1. Markets' and Capital's valuation figures are one **stock** card, which
 *    opens that instrument's own drawer when the company is listed.
 * 2. Holders, the short book, live campaigns and the offers count are one
 *    **register** card — "who is attacking me" answered without a tap.
 * 3. `TradeTicket` stays one component with two mounts: the instrument drawer
 *    and the position drawer. Nothing here draws a third.
 * 4. `AcquisitionDesk` is mounted in exactly one place, the Deal Room. A
 *    position links to `?sheet=deals&target=` rather than carrying a copy.
 *
 * The company-scoped cards read `useActiveCompany`, which is what Markets,
 * Capital and the Boardroom read. The register and the portfolio read
 * `usePlayerCompany`, because The Street and the Portfolio screen do: those two
 * are about the founding company's own register and the founder's own wealth.
 */

import { useMemo } from 'react';
import { DEFAULT_QUORUM_RULE } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { portfolioOf } from '@frontier/simulation';
import { TapeStrip } from '@/components/screens/command-centre/TapeStrip';
import { registerRows, sectorRollups } from '@/components/screens/reporting/register';
import { capTableRows, issuedSharesOf } from '@/components/screens/reporting/util';
import { totalsLine } from '@/components/screens/portfolio/rows';
import {
  useActiveCompany,
  useCompanyMetrics,
  useFounderNetWorth,
  useMarketCap,
  usePlayerCharacter,
  usePlayerCompany,
  usePlayerView,
  useQuotes,
  useSession,
} from '@/lib/game';
import {
  BoardCard,
  DealsCard,
  FundingCard,
  PortfolioCard,
  RegisterCard,
  StockCard,
  TapeCard,
} from './cards/market-cards';
import { registerFigures } from './cards/registerModel';

export function MarketTab(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = useActiveCompany();
  const owner = usePlayerCompany();
  const founder = usePlayerCharacter();
  const metrics = useCompanyMetrics(company.id);
  const marketCapUsd = useMarketCap(company.id);
  // With no instrument id `useQuotes()` returns the whole tape, so a private
  // company is given an empty series rather than everyone else's prices.
  const tape = useQuotes(company.instrumentId ?? undefined);

  /* --- your stock ---------------------------------------------------------- */

  const quotes = company.instrumentId === null ? [] : tape;
  const lastQuote = quotes[quotes.length - 1] ?? null;

  const ownTable = useMemo(() => session.capTables.find((entry) => entry.companyId === company.id) ?? null, [session.capTables, company.id]);
  const ownStakePct = useMemo(() => {
    if (ownTable === null) return 0;
    return capTableRows(session, ownTable)
      .filter((row) => row.holderId === founder.id || row.holderId === view.playerId)
      .reduce((total, row) => total + row.economicPct, 0);
  }, [session, ownTable, founder.id, view.playerId]);

  /* --- who is aiming at you ------------------------------------------------ */

  const register = useMemo(
    () => registerFigures({ session, view, companyId: owner.id, founderId: founder.id }),
    [session, view, owner.id, founder.id],
  );

  /* --- the tape ------------------------------------------------------------ */

  const rollups = useMemo(() => sectorRollups(registerRows(session, view)), [session, view]);
  const sectorLine = useMemo(() => {
    if (rollups.length === 0) return 'Quarterly closes on the in-world exchange.';
    const listed = rollups.reduce((total, row) => total + row.listed, 0);
    const value = rollups.reduce((total, row) => total + row.marketCapUsd, 0);
    return `${rollups.length} sector${rollups.length === 1 ? '' : 's'} · ${listed} listed · ${formatMoney(value)} of quoted value.`;
  }, [rollups]);

  /* --- the portfolio ------------------------------------------------------- */

  const portfolio = useMemo(() => portfolioOf(session, owner.id), [session, owner.id]);
  const netWorthUsd = useFounderNetWorth();

  /* --- deals --------------------------------------------------------------- */

  // The Deal Room's own four filters, so the card and the sheet count the same
  // deals: proposed to me, proposed by me, accepted and binding, and past due.
  const deals = view.deals;
  const toAnswer = deals.filter((deal) => deal.counterpartyId === company.id && deal.status === 'proposed').length;
  const outstanding = deals.filter((deal) => deal.proposerId === company.id && deal.status === 'proposed').length;
  const live = deals.filter((deal) => deal.status === 'accepted' && deal.binding).length;
  const lapsing = deals.filter((deal) => deal.status === 'proposed' && deal.expiresQuarter <= session.quarter).length;

  /* --- the board ----------------------------------------------------------- */

  const board = view.board;
  const rule = board?.quorumRule ?? DEFAULT_QUORUM_RULE;
  const mood =
    board === null || board.directors.length === 0
      ? 0
      : board.directors.reduce((total, seat) => total + seat.relationshipWithCeo, 0) / board.directors.length;
  const mattersTabled = view.boardProposals.filter((proposal) => proposal.status === 'tabled' || proposal.status === 'draft').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[1.35fr_0.85fr]">
        <StockCard
          companyName={company.name}
          marketCapUsd={marketCapUsd}
          lastPriceUsd={lastQuote?.price ?? null}
          lastReturn={lastQuote?.return ?? null}
          ownStakePct={ownStakePct}
          issuedShares={ownTable === null ? 0 : issuedSharesOf(ownTable)}
          instrumentId={company.instrumentId}
          history={quotes.map((quote) => quote.price)}
        />

        <FundingCard
          cashUsd={company.financials.cash}
          cashMovementUsd={company.financials.quarterlyBurn}
          runwayQuarters={metrics?.runwayQuarters ?? null}
          debtUsd={company.financials.debt}
          interestUsd={company.financials.interestExpense}
          listingWindow={view.world.capitalMarkets.ipoWindow}
        />
      </div>

      <RegisterCard
        holders={register.holders}
        ownStakePct={register.ownStakePct}
        shortInterestPct={register.shortInterestPct}
        shortBadge={register.shortBadge}
        liveCampaigns={register.liveCampaigns}
        dryPowderAimedAtYouUsd={register.dryPowderAimedAtYouUsd}
        answerable={register.answerable}
        offers={register.offers}
      />

      <div className="grid gap-4 xl:grid-cols-[1.35fr_0.85fr]">
        <TapeCard strip={<TapeStrip session={session} view={view} />} sectorLine={sectorLine} />

        <PortfolioCard
          netWorthUsd={netWorthUsd}
          heldValueUsd={portfolio.totals.stakesValueUsd}
          stakes={portfolio.stakes.length}
          subsidiaries={portfolio.subsidiaries.length}
          funds={portfolio.funds.length}
          line={totalsLine(portfolio)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DealsCard toAnswer={toAnswer} outstanding={outstanding} live={live} lapsing={lapsing} />

        <BoardCard
          seatsFilled={board === null ? null : board.directors.length}
          seatsAuthorised={board?.seatsAuthorised ?? 0}
          mood={mood}
          passThreshold={rule.passThresholdFraction}
          mattersTabled={mattersTabled}
        />
      </div>
    </div>
  );
}

'use client';

/**
 * The ticket for one position.
 *
 * Two instructions are carried out here rather than sending the founder to
 * another screen, because both are about *this row* and both already have a
 * ticket: `TradeTicket` from Markets buys and sells, and `AcquisitionDesk` from
 * the Deal Room bids for the whole company. Reusing them is the point — a third
 * copy of the share-count arithmetic is exactly the kind of second computation
 * this stage exists to remove — and both already carry their own validator
 * pre-check and Now/After preview.
 *
 * A deal and a board matter are not tickets, they are forms with their own
 * screens, and the card links there instead.
 */

import { useMemo } from 'react';
import type { PlayerView, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import type { PortfolioAction, PortfolioStakeRow, PortfolioSubsidiaryRow } from '@frontier/simulation';
import { Drawer, EmptyState, KeyValueGrid } from '@/components/ui';
import { AcquisitionDesk } from '@/components/screens/deal-room/AcquisitionDesk';
import { TradeTicket } from '@/components/screens/markets/TradeTicket';
import { formatCount, issuedSharesOf } from '@/components/screens/reporting/util';
import { ownershipLabel } from './rows';

/** The row a ticket is open on: either kind carries everything the ticket needs. */
export type PositionTarget = PortfolioStakeRow | PortfolioSubsidiaryRow;

export interface PositionDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: SessionState;
  readonly view: PlayerView;
  /** The player's own company: the acquirer, and the holder of every row here. */
  readonly ownCompanyId: string;
  readonly row: PositionTarget | null;
  readonly action: PortfolioAction | null;
  readonly hasBoard: boolean;
}

export function PositionDrawer({
  open,
  onClose,
  session,
  view,
  ownCompanyId,
  row,
  action,
  hasBoard,
}: PositionDrawerProps): React.JSX.Element | null {
  const company = session.companies.find((entry) => entry.id === ownCompanyId) ?? null;
  const target = row === null ? null : (session.companies.find((entry) => entry.id === row.companyId) ?? null);

  const register = useMemo(() => {
    if (row === null) return null;
    const table = session.capTables.find((entry) => entry.companyId === row.companyId) ?? null;
    if (table === null) return null;
    const issued = issuedSharesOf(table);
    const held = table.holdings
      .filter((holding) => holding.holderId === ownCompanyId)
      .reduce((sum, holding) => sum + holding.shares, 0);
    const float = table.holdings
      .filter((holding) => holding.holderKind === 'public_float')
      .reduce((sum, holding) => sum + holding.shares, 0);
    const securityId = table.holdings.find((holding) => holding.holderId === ownCompanyId)?.securityId ?? target?.primarySecurityId ?? null;
    return { issued, held, float, securityId };
  }, [session.capTables, row, ownCompanyId, target]);

  if (row === null || action === null || company === null) return null;

  const lastPrice = row.kind === 'stake' && row.shares > 0 ? row.valueUsd / row.shares : 0;
  const trading = action === 'buy_shares' || action === 'sell_shares';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={row.name}
      subtitle={
        trading
          ? 'Buy or sell on the exchange. The validator checks every change as you type; the engine checks again when the quarter resolves.'
          : 'An offer for the whole company. With a board in place it is tabled as an acquisition matter rather than executed.'
      }
    >
      <div className="flex flex-col gap-4">
        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Your position', value: formatCount(row.shares) },
            { label: 'Stake', value: ownershipLabel(row.kind === 'stake' ? row.ownershipPct : row.controlPct) },
            { label: 'Cost', value: formatMoney(row.costUsd) },
            { label: 'Value', value: formatMoney(row.valueUsd) },
          ]}
        />

        {trading ? (
          register === null || register.securityId === null ? (
            <EmptyState
              compact
              icon="coins"
              title="Nothing to trade here"
              message="This company has no security on the register, so shares in it cannot change hands."
            />
          ) : (
            <TradeTicket
              securityId={register.securityId}
              companyName={row.name}
              symbol={target?.ticker ?? null}
              lastPrice={lastPrice}
              heldShares={register.held}
              issuedShares={register.issued}
              floatShares={register.float}
            />
          )
        ) : (
          <AcquisitionDesk
            targets={
              target === null
                ? []
                : [
                    {
                      id: target.id,
                      name: target.name,
                      marketCapUsd: row.kind === 'stake' && row.ownershipPct > 0 ? Math.round(row.valueUsd / row.ownershipPct) : row.valueUsd,
                      isPublic: target.isPublic,
                      sector: target.sector,
                    },
                  ]
            }
            preselectedId={row.companyId}
            company={company}
            hasBoard={hasBoard}
          />
        )}

        {row.kind === 'stake' && row.thresholdLabel !== null ? (
          <p className="text-[12px] leading-snug text-ink-faint">
            This position has crossed the {row.thresholdLabel.replace(/_/g, ' ')} threshold at {formatPct(row.ownershipPct)}. Crossing the
            next one changes what the target's board can refuse you.
          </p>
        ) : null}

        {view.ownCompany.id === row.companyId ? (
          <p className="text-[12px] leading-snug text-warn">A company cannot trade in its own shares from this screen.</p>
        ) : null}
      </div>
    </Drawer>
  );
}

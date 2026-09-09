'use client';

/**
 * The ticket for one position.
 *
 * Buying and selling happen here, against the row you are looking at:
 * `TradeTicket` is Markets' own ticket, reused rather than recopied, and it
 * carries its own validator pre-check and Now/After preview.
 *
 * **Bidding for the whole company does not.** `AcquisitionDesk` used to be
 * mounted here as well as in the Deal Room, which meant two live copies of one
 * form — two preselections, two consideration splits, two places to fix a bug.
 * There is now exactly one desk, in the Deal Room, and this drawer links to it
 * with the target already named: `?sheet=deals&target=<companyId>`. A deal and
 * a board matter were already links for the same reason.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import type { PlayerView, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import type { PortfolioAction, PortfolioStakeRow, PortfolioSubsidiaryRow } from '@frontier/simulation';
import { Drawer, EmptyState, Icon, KeyValueGrid } from '@/components/ui';
import { TradeTicket } from '@/components/screens/markets/TradeTicket';
import { formatCount, issuedSharesOf } from '@/components/screens/reporting/util';
import { sheetHref } from '@/lib/sheets';
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
          <div className="flex flex-col gap-2.5">
            <KeyValueGrid
              columns={2}
              items={[
                {
                  label: 'Whole company',
                  value: formatMoney(
                    row.kind === 'stake' && row.ownershipPct > 0 ? Math.round(row.valueUsd / row.ownershipPct) : row.valueUsd,
                  ),
                  hint: target === null ? 'Not on the register' : target.isPublic ? 'Quoted capitalisation' : 'Fundamental anchor — private',
                },
                {
                  label: 'Board approval',
                  value: hasBoard ? 'Required' : 'Not required',
                  mono: false,
                  hint: hasBoard
                    ? 'The validator tables it as an acquisition matter rather than executing it'
                    : `${company.name} has no board, so the offer goes straight out`,
                },
              ]}
            />
            {/* The one acquisition desk lives in the Deal Room; this names the
                target on the way in rather than carrying a second copy of it. */}
            <Link href={sheetHref('deals', { target: row.companyId })} className="btn btn-primary tap-target justify-center gap-1.5">
              <Icon name="handshake" size={16} accent="current" />
              Bid for {row.name} in the Deal Room
            </Link>
          </div>
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

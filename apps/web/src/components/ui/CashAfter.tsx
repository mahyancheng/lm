'use client';

/**
 * The cash half of every Now/After preview, and the one line that says what a
 * negative landing costs.
 *
 * From world version 2 nothing is refused for want of cash: the validator takes
 * the commitment and notes where the balance ends up. That makes the preview the
 * only place a founder learns they are about to overdraw — so it is a shared
 * component rather than a row each screen assembles for itself, and the line
 * under it is `solvencyLine` from the engine, not a sentence written here.
 *
 * Nothing on this page computes an economic number: the cash on hand comes from
 * the company, the commitment comes from the screen's own preview function, and
 * the clock comes from `negativeCashQuarters` reading the filed statements.
 */

import type { ReactNode } from 'react';
import type { Company } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { negativeCashQuarters, solvencyLine } from '@frontier/simulation';
import { NowAfter, type NowAfterRow } from './NowAfter';

export interface CashAfterProps {
  readonly company: Company;
  /** Cash this decision commits. Positive is money out; negative is money in. */
  readonly spendUsd: number;
  /** Rows shown above the cash row, already formatted by the caller. */
  readonly rows?: readonly NowAfterRow[];
  /** Label for the cash row. */
  readonly label?: string;
  /** Shown under the rows when the balance stays at or above zero. */
  readonly note?: ReactNode;
  readonly nowLabel?: string;
  readonly afterLabel?: string;
  readonly className?: string;
}

/** Where the balance lands, and the solvency clock if that is below zero. */
export function cashAfterOf(company: Company, spendUsd: number): { readonly afterUsd: number; readonly quarters: number; readonly line: string | null } {
  const afterUsd = company.financials.cash - spendUsd;
  const quarters = negativeCashQuarters(company);
  return { afterUsd, quarters, line: solvencyLine(quarters, afterUsd) };
}

export function CashAfter({
  company,
  spendUsd,
  rows = [],
  label = 'Cash',
  note,
  nowLabel,
  afterLabel,
  className,
}: CashAfterProps): React.JSX.Element {
  const { afterUsd, line } = cashAfterOf(company, spendUsd);
  return (
    <NowAfter
      className={className}
      nowLabel={nowLabel}
      afterLabel={afterLabel}
      rows={[
        ...rows,
        {
          key: 'cash',
          label,
          now: formatMoney(company.financials.cash),
          after: formatMoney(afterUsd),
          tone: afterUsd < 0 ? 'loss' : undefined,
        },
      ]}
      note={line ?? note}
    />
  );
}

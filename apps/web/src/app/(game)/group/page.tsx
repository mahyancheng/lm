'use client';

/**
 * Group — STAGE 5's consolidated view.
 *
 * `groupStatementOf` folds every controlled company's own filed statement into
 * one — no elimination beyond the one real one (a subsidiary's cost basis on
 * the parent's balance sheet), because intra-group cash and compute moves book
 * as real transactions on both sides. `consolidatedEnterpriseValueOf` adds the
 * one number that is not on any statement: what the market would pay for the
 * whole group.
 *
 * A card per company switches the active company (`setActiveCompany`) and
 * sends the founder to the Company screen to work it directly. The two
 * intra-group actions below — moving cash or compute, and fully absorbing a
 * subsidiary — are the only things this screen submits.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionIntent, Company } from '@frontier/contracts';
import { formatCount, formatMoney } from '@frontier/shared';
import { SOLVENCY_NEGATIVE_QUARTERS, consolidatedEnterpriseValueOf, groupStatementOf, groupStatementsSupported, recentFinancialQuarters } from '@frontier/simulation';
import {
  CashAfter,
  ConfirmDialog,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  SectorBadge,
  StatCard,
  Tag,
  ValidationBanner,
} from '@/components/ui';
import { ownershipLabel } from '@/components/screens/portfolio/rows';
import { PLAYER_ID, controlledCompanyRows, useGameActions, useSession } from '@/lib/game';

export default function GroupPage(): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const { queueAction, validateIntent, setActiveCompany } = useGameActions();

  const rows = controlledCompanyRows(session, PLAYER_ID);
  const founding = rows.find((row) => row.isFounding)?.company ?? null;
  const supported = groupStatementsSupported(session);

  const statement = useMemo(() => groupStatementOf(session, PLAYER_ID), [session]);
  const enterpriseValueUsd = useMemo(() => (founding === null ? 0 : consolidatedEnterpriseValueOf(session, founding)), [session, founding]);
  const totalHeadcount = rows.reduce((sum, row) => sum + row.headcount, 0);

  /* --- transfer form --------------------------------------------------- */
  const [fromId, setFromId] = useState<string | null>(founding?.id ?? null);
  const [toId, setToId] = useState<string | null>(null);
  const [amountUsd, setAmountUsd] = useState(100_000);
  const [pendingTransfer, setPendingTransfer] = useState<ActionIntent | null>(null);

  const fromCompany = rows.find((row) => row.company.id === fromId)?.company ?? null;
  const toCompany = rows.find((row) => row.company.id === toId)?.company ?? null;
  const transferIntent: ActionIntent | null =
    fromCompany === null || toCompany === null || amountUsd <= 0
      ? null
      : { type: 'transfer_between_group', fromCompanyId: fromCompany.id, toCompanyId: toCompany.id, cashUsd: amountUsd, acceleratorUnits: null };
  const transferPreview = transferIntent === null ? null : validateIntent(transferIntent, fromCompany?.id);

  /* --- merge ------------------------------------------------------------ */
  const [pendingMerge, setPendingMerge] = useState<{ subsidiary: Company; parentId: string } | null>(null);

  if (!supported || rows.length <= 1) {
    return (
      <>
        <PageHeader title="Group" subtitle="Consolidated across every company you direct." />
        <EmptyState
          icon="boardTable"
          title="Nothing to consolidate yet"
          message="Group accounts appear once you control more than your founding company — buy a majority stake, or complete an acquisition that keeps the target alive as a subsidiary rather than absorbing it outright."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Group"
        eyebrow={statement.quarter === null ? 'Not yet filed' : `Filed through Q${statement.quarter}`}
        subtitle={`${rows.length} companies you direct, consolidated. Ordinary sales between them are real, priced transactions and stay in the numbers — only the intra-group stake is eliminated.`}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <StatCard label="Consolidated revenue" iconName="ledger" value={formatMoney(statement.income.revenueUsd)} hint="Last filed quarter, summed" />
        <StatCard
          label="Consolidated net income"
          iconName="coins"
          value={formatMoney(statement.income.netIncomeUsd)}
          tone={statement.income.netIncomeUsd < 0 ? 'loss' : 'gain'}
        />
        <StatCard label="Consolidated cash" iconName="vault" value={formatMoney(statement.balance.cashUsd)} />
        <StatCard label="Consolidated debt" iconName="ledger" value={formatMoney(statement.balance.debtUsd)} />
        <StatCard label="Headcount" iconName="people" value={formatCount(totalHeadcount)} />
        <StatCard label="Market value" iconName="chart" value={formatMoney(enterpriseValueUsd)} hint="Consolidated enterprise value" />
      </div>

      {statement.minorityInterestUsd > 0 ? (
        <p className="text-[11px] text-ink-faint">
          {formatMoney(statement.minorityInterestUsd)} of consolidated equity belongs to holders outside the group — a subsidiary you
          direct but do not wholly own.
        </p>
      ) : null}

      <Panel title="Companies" subtitle="Founding company first. Tap one to direct it." iconName="building" iconTone="brand">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => {
            const filed = recentFinancialQuarters(row.company, 1)[0] ?? null;
            return (
              <button
                key={row.company.id}
                type="button"
                onClick={() => {
                  setActiveCompany(row.company.id);
                  router.push('/company');
                }}
                className="press-pop tap-target flex flex-col gap-2 rounded-panel border border-hair bg-panel px-3.5 py-3 text-left hover:bg-raised"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-bold text-ink">{row.company.name}</span>
                  {row.isFounding ? <Tag tone="brand">Founding</Tag> : <Tag tone="neutral">{ownershipLabel(row.controlPct)} control</Tag>}
                </div>
                <SectorBadge sector={row.company.sector} size="sm" />
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-dim">
                  <span>Cash {formatMoney(row.company.financials.cash)}</span>
                  <span>Staff {formatCount(row.headcount)}</span>
                  <span>Revenue {formatMoney(filed?.income.revenueUsd ?? row.company.financials.revenueQuarterly)}</span>
                  <span className={row.negativeCashQuarters > 0 ? 'text-warn' : undefined}>
                    {row.negativeCashQuarters > 0 ? `${row.negativeCashQuarters}/${SOLVENCY_NEGATIVE_QUARTERS} negative` : 'Solvent'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Move cash or compute between companies"
        subtitle="Shared resources are never pooled automatically — this is how you actually move them."
        iconName="coins"
        iconTone="brand"
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink-dim">
              From
              <select
                className="field tap-target sm:min-h-0"
                value={fromId ?? ''}
                onChange={(event) => setFromId(event.target.value || null)}
              >
                {rows.map((row) => (
                  <option key={row.company.id} value={row.company.id}>
                    {row.company.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink-dim">
              To
              <select className="field tap-target sm:min-h-0" value={toId ?? ''} onChange={(event) => setToId(event.target.value || null)}>
                <option value="">Choose a company</option>
                {rows
                  .filter((row) => row.company.id !== fromId)
                  .map((row) => (
                    <option key={row.company.id} value={row.company.id}>
                      {row.company.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink-dim">
            Cash to move
            <input
              type="number"
              className="field tap-target sm:min-h-0"
              min={0}
              step={10_000}
              value={amountUsd}
              onChange={(event) => setAmountUsd(Math.max(0, Number(event.target.value) || 0))}
            />
          </label>

          {fromCompany !== null && toCompany !== null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <CashAfter company={fromCompany} spendUsd={amountUsd} label="Cash — sending" />
              <CashAfter company={toCompany} spendUsd={-amountUsd} label="Cash — receiving" />
            </div>
          ) : null}

          {transferPreview !== null ? <ValidationBanner result={transferPreview} compact /> : null}

          <button
            type="button"
            className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto sm:self-start sm:min-h-0"
            disabled={transferIntent === null}
            onClick={() => setPendingTransfer(transferIntent)}
          >
            <Icon name="coins" size={16} accent="current" />
            Move the cash
          </button>
        </div>
      </Panel>

      {rows.some((row) => !row.isFounding && row.company.parentCompanyId !== null) ? (
        <Panel
          title="Absorb a subsidiary"
          subtitle="Fully merges it into its parent: irreversible, and the subsidiary stops filing on its own."
          iconName="handshake"
          iconTone="warn"
        >
          <div className="flex flex-col gap-2">
            {rows
              .filter((row) => !row.isFounding && row.company.parentCompanyId !== null)
              .map((row) => {
                const parent = rows.find((candidate) => candidate.company.id === row.company.parentCompanyId)?.company ?? null;
                return (
                  <div key={row.company.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-hair px-3 py-2">
                    <span className="min-w-0 truncate text-[12.5px] text-ink">
                      {row.company.name} <span className="text-ink-faint">— subsidiary of {parent?.name ?? 'a company you direct'}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm tap-target sm:min-h-0"
                      disabled={parent === null}
                      onClick={() => (parent === null ? undefined : setPendingMerge({ subsidiary: row.company, parentId: parent.id }))}
                    >
                      Absorb
                    </button>
                  </div>
                );
              })}
          </div>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={pendingTransfer !== null}
        title={`Move ${formatMoney(amountUsd)} between companies`}
        actionType="transfer_between_group"
        tone="brand"
        body="This moves cash from one company you direct to another. It is a real transfer on both companies' books, not a pooled treasury."
        terms={[
          { label: 'From', value: fromCompany?.name ?? '—' },
          { label: 'To', value: toCompany?.name ?? '—' },
          { label: 'Amount', value: formatMoney(amountUsd), emphasis: true },
        ]}
        confirmLabel="Move the cash"
        onCancel={() => setPendingTransfer(null)}
        onConfirm={() => {
          if (pendingTransfer !== null && fromCompany !== null) {
            queueAction(pendingTransfer, { confirmed: true, companyId: fromCompany.id });
          }
          setPendingTransfer(null);
        }}
      />

      <ConfirmDialog
        open={pendingMerge !== null}
        title={pendingMerge === null ? 'Absorb subsidiary' : `Absorb ${pendingMerge.subsidiary.name}`}
        actionType="merge_subsidiary"
        tone="warn"
        requireTyped={pendingMerge?.subsidiary.name ?? null}
        body="Irreversible. Its cash, staff, products and balance sheet merge into the parent and it is extinguished — it stops filing its own accounts and stops being a company you can direct or switch to separately, exactly like an old-style acquisition."
        terms={pendingMerge === null ? [] : [{ label: 'Subsidiary', value: pendingMerge.subsidiary.name, emphasis: true }, { label: 'Reversible', value: 'No' }]}
        confirmLabel="Absorb permanently"
        onCancel={() => setPendingMerge(null)}
        onConfirm={() => {
          if (pendingMerge !== null) {
            queueAction(
              { type: 'merge_subsidiary', subsidiaryCompanyId: pendingMerge.subsidiary.id },
              { confirmed: true, companyId: pendingMerge.parentId },
            );
          }
          setPendingMerge(null);
        }}
      />
    </>
  );
}

'use client';

/**
 * The M&A ticket.
 *
 * An offer is an attempt, not a purchase. With a board in place the validator
 * clamps `acquire_company` into the `submit_board_proposal` that has to precede
 * it — which is not a failure and must not read as one. `ValidationBanner`
 * already says "Requires board approval" and shows the matter that will be
 * tabled; the desk shows the consideration split that the directors will argue
 * about, because the stock component is usually where the vote is won.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ActionIntent, ActionValidationResult } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { ConfirmDialog, KeyValueGrid, Tag, ValidationBanner } from '@/components/ui';
import { useGameActions } from '@/lib/game';

export interface AcquisitionTarget {
  readonly id: string;
  readonly name: string;
  /** Market capitalisation from state: last quote when listed, anchor when private. */
  readonly marketCapUsd: number;
  readonly isPublic: boolean;
}

export interface AcquisitionDeskProps {
  readonly targets: readonly AcquisitionTarget[];
  /** Set by the distress radar when the player picks a company off it. */
  readonly preselectedId: string | null;
  readonly availableCashUsd: number;
  readonly hasBoard: boolean;
}

export function AcquisitionDesk({ targets, preselectedId, availableCashUsd, hasBoard }: AcquisitionDeskProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();

  const [targetId, setTargetId] = useState(preselectedId ?? targets[0]?.id ?? '');
  const [offer, setOffer] = useState(0);
  const [cashPct, setCashPct] = useState(0.4);
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState(false);

  const target = useMemo(() => targets.find((entry) => entry.id === targetId) ?? null, [targets, targetId]);

  // Following the radar's selection is the whole point of the hand-off; the
  // offer resets to the target's own market capitalisation so the first number
  // on screen is a real one rather than a blank field.
  useEffect(() => {
    if (preselectedId === null) return;
    setTargetId(preselectedId);
    setQueued(false);
    setResult(null);
  }, [preselectedId]);

  useEffect(() => {
    const found = targets.find((entry) => entry.id === targetId) ?? null;
    setOffer(found === null ? 0 : Math.round(found.marketCapUsd));
  }, [targetId, targets]);

  const stockPct = 1 - cashPct;
  const cashNeeded = offer * cashPct;
  const premium = target === null || target.marketCapUsd <= 0 ? null : offer / target.marketCapUsd - 1;

  const intent: ActionIntent | null =
    target === null || offer <= 0
      ? null
      : { type: 'acquire_company', targetCompanyId: target.id, offerValueUsd: offer, cashPct, stockPct };

  function check(): void {
    if (intent === null) return;
    setResult(validateIntent(intent));
  }

  return (
    <div className="flex flex-col gap-3">
      {targets.length === 0 ? (
        <p className="text-[11px] text-ink-faint">No company in this session is available to bid for.</p>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block">
              <span className="label-caps-faint">Target</span>
              <select
                className="field mt-1"
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setResult(null);
                  setQueued(false);
                }}
              >
                {targets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label-caps-faint">Offer value (USD)</span>
              <input
                type="number"
                className="field mt-1"
                min={0}
                step={1_000_000}
                value={String(offer)}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  setOffer(Number.isFinite(parsed) ? parsed : 0);
                  setResult(null);
                  setQueued(false);
                }}
              />
            </label>
          </div>

          <label className="block">
            <span className="label-caps-faint">
              Consideration · {formatPct(cashPct, 0)} cash / {formatPct(stockPct, 0)} stock
            </span>
            <input
              type="range"
              className="mt-2 w-full accent-[color:var(--color-brand)]"
              min={0}
              max={100}
              step={5}
              value={Math.round(cashPct * 100)}
              onChange={(event) => {
                setCashPct(Number(event.target.value) / 100);
                setResult(null);
                setQueued(false);
              }}
            />
          </label>

          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Market capitalisation', value: target === null ? '—' : formatMoney(target.marketCapUsd) },
              { label: 'Premium offered', value: premium === null ? '—' : formatPct(premium), tone: premium !== null && premium > 0.6 ? 'warn' : undefined },
              { label: 'Cash component', value: formatMoney(cashNeeded), tone: cashNeeded > availableCashUsd ? 'loss' : undefined },
              { label: 'Uncommitted cash', value: formatMoney(availableCashUsd) },
            ]}
          />

          {hasBoard ? (
            <p className="rounded-[4px] border border-warn/25 bg-warn-wash px-3 py-2 text-[11px] text-warn">
              Your company has a board, so this will be tabled as an acquisition matter rather than executed. Directors negotiate hardest
              over the stock component — that is what the slider above is really setting.
            </p>
          ) : (
            <p className="rounded-[4px] border border-hair bg-raised px-3 py-2 text-[11px] text-ink-dim">
              No board sits over this company yet, so an offer executes on its own terms. That freedom ends at the first priced round.
            </p>
          )}

          <ValidationBanner result={result} />

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-sm" onClick={check} disabled={intent === null}>
              Check with the validator
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={intent === null || queued} onClick={() => setPending(intent)}>
              {queued ? 'Queued' : 'Make the offer'}
            </button>
            {cashNeeded > availableCashUsd ? (
              <Tag tone="loss" dot>
                Cash component exceeds uncommitted cash
              </Tag>
            ) : null}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={`Offer for ${target?.name ?? 'the target'}`}
        actionType="acquire_company"
        tone="warn"
        body="An acquisition hands you the target's technology, its staff and its problems. It may attract antitrust attention, and with a board in place it is the board's decision, not yours."
        terms={[
          { label: 'Offer value', value: formatMoney(offer), emphasis: true },
          { label: 'Cash', value: `${formatPct(cashPct, 0)} · ${formatMoney(cashNeeded)}` },
          { label: 'Stock', value: formatPct(stockPct, 0) },
          { label: 'Premium', value: premium === null ? '—' : formatPct(premium) },
        ]}
        confirmLabel="Queue the offer"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) {
            const outcome = queueAction(pending, { confirmed: true });
            setResult(outcome.validation);
            setQueued(true);
          }
          setPending(null);
        }}
      />
    </div>
  );
}

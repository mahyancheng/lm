'use client';

/**
 * Marketing allocation.
 *
 * The panel opens on the plan that will actually run this quarter, computed by
 * the engine's own `marketingPlan` against the queue as it stands. Until a
 * `set_marketing_budget` is queued that plan is the archetype policy — a share
 * of last quarter's revenue, bent by posture, split across the segments the
 * company sells into. Stating an allocation replaces it outright, and segments
 * left at zero are set to zero: the action documents that, so the panel says it.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Company, ProductSegment, SubmittedAction } from '@frontier/contracts';
import { PRODUCT_SEGMENTS } from '@frontier/contracts';
import { marketingPlan } from '@frontier/simulation';
import { formatMoney } from '@frontier/shared';
import { BarChart, Icon, Panel, SliderField, Tag, ValidationBanner, roundStep } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { SEGMENT_LABEL } from './labels';

export interface MarketingPanelProps {
  readonly company: Company;
  readonly queued: readonly SubmittedAction[];
}

type Draft = Record<ProductSegment, string>;

const EMPTY_DRAFT: Draft = { consumer: '', enterprise: '', developer_api: '', government: '' };

export function MarketingPanel({ company, queued }: MarketingPanelProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  const plan = useMemo(() => marketingPlan(company, queued), [company, queued]);
  const cashBound = Math.max(company.financials.cash, 100_000);

  const allocations = useMemo(
    () =>
      PRODUCT_SEGMENTS.map((segment) => {
        const parsed = Number.parseFloat(draft[segment]);
        return { segment, budgetUsd: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 };
      }),
    [draft],
  );

  const total = allocations.reduce((sum, allocation) => sum + allocation.budgetUsd, 0);
  const touched = PRODUCT_SEGMENTS.some((segment) => draft[segment].trim().length > 0);

  const preview = useMemo(
    () => (touched ? validateIntent({ type: 'set_marketing_budget', allocations }) : null),
    [touched, allocations, validateIntent],
  );

  function apply(): void {
    if (!touched) return;
    const entry = queueAction({ type: 'set_marketing_budget', allocations });
    setResult(entry.validation);
  }

  function prefillFromPlan(): void {
    const next: Draft = { ...EMPTY_DRAFT };
    for (const segment of PRODUCT_SEGMENTS) {
      const value = plan.bySegment[segment] ?? 0;
      next[segment] = value > 0 ? String(Math.round(value)) : '';
    }
    setDraft(next);
    setResult(null);
  }

  const planData = PRODUCT_SEGMENTS.map((segment) => ({
    label: SEGMENT_LABEL[segment],
    value: plan.bySegment[segment] ?? 0,
    tone: 'info' as const,
  })).filter((datum) => datum.value > 0);

  return (
    <Panel
      title="Marketing"
      iconName="chat"
      iconTone={plan.stated ? 'brand' : 'neutral'}
      subtitle={`${formatMoney(plan.recurringUsd)} recurring${plan.oneOffUsd > 0 ? ` · ${formatMoney(plan.oneOffUsd)} one-off` : ''} this quarter`}
      actions={
        plan.stated ? (
          <Tag tone="brand" dot>
            Stated by an action
          </Tag>
        ) : (
          <Tag tone="neutral" dot>
            Archetype policy
          </Tag>
        )
      }
    >
      {planData.length === 0 ? (
        <p className="text-[12px] text-ink-faint">No marketing spend is planned for this quarter.</p>
      ) : (
        <BarChart data={planData} formatValue={(value) => formatMoney(value)} />
      )}

      <div className="mt-4 border-t border-hair pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label-caps">Reallocate</span>
          <button type="button" className="btn btn-ghost tap-target gap-1.5 px-2" onClick={prefillFromPlan}>
            <Icon name="import" size={15} accent="current" />
            Start from the current plan
          </button>
        </div>

        {/* One slider per segment, all bounded by the same uncommitted cash
            the validator scales the total against. A segment slid to zero is
            an explicit zero, exactly as a typed 0 was. */}
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {PRODUCT_SEGMENTS.map((segment) => (
            <SliderField
              key={segment}
              label={SEGMENT_LABEL[segment]}
              value={Number.parseFloat(draft[segment]) || 0}
              onChange={(next) => setDraft((current) => ({ ...current, [segment]: String(next) }))}
              min={0}
              max={cashBound}
              step={roundStep(cashBound)}
              format={formatMoney}
              chips
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0 flex-1 text-[12px] text-ink-dim">
            Total <span className="figure text-ink">{formatMoney(total)}</span>
            <span className="text-ink-faint"> · unlisted segments are set to zero</span>
          </div>
          <button type="button" className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" disabled={!touched} onClick={apply}>
            <Icon name="check" size={16} accent="current" />
            Queue allocation
          </button>
        </div>

        {result === null && preview !== null ? (
          <div className="mt-2.5">
            <ValidationBanner result={preview} compact />
          </div>
        ) : null}
        {result === null ? null : (
          <div className="mt-2.5">
            <ValidationBanner result={result} />
          </div>
        )}
      </div>
    </Panel>
  );
}

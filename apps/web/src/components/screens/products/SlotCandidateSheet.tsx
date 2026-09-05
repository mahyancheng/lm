'use client';

/**
 * One slot, opened: every node that could go in it, and every way to get each.
 *
 * Shared by the launch flow and the line drawer, and hosted *inside* whichever
 * of them is open rather than stacked over it as a second dialog. On a phone
 * the host is already a bottom sheet, and a sheet over a sheet is two focus
 * traps fighting over one Tab key; this panel replaces the host's body and
 * hands it back with the back button, which is the same gesture with none of
 * the fighting.
 *
 * Everything priced here is the engine's `slotOptions`: the candidate's market
 * price, each route's unit price and quality, the producer count, whether the
 * node is blocked. Nothing is disabled. Making a thing you could make is the
 * roll-up's default, and declining it is a decision the fill records; the
 * sheet offers both and says what each costs.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { InputRoute, NodeSlotOptions, SlotCandidate } from '@frontier/simulation';
import { NODE_ROLE_LABELS, NODE_TIER_LABELS, type NodeTier } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { Icon, Tag } from '@/components/ui';
import { EMPTY_CHOICE, bestRouteOf, canLeaveEmpty, choiceOfRoute, type SlotChoice } from './nodeLaunch';

export interface SlotCandidateSheetProps {
  readonly slot: NodeSlotOptions;
  /** The company composing the line; its own id on a route means MAKE. */
  readonly companyId: string;
  /** The choice standing on the slot right now, as the host holds it. */
  readonly choice: SlotChoice | undefined;
  readonly onChoose: (choice: SlotChoice) => void;
  readonly onBack: () => void;
  /** Rendered under the routes: the validator's answer to the last choice, when the host has one. */
  readonly banner?: ReactNode;
}

/** The route a freshly picked node opens on: make when the company runs a line on it, else the open market — the roll-up's own order. */
export function openingRouteOf(candidate: SlotCandidate): InputRoute | null {
  return candidate.routes.find((route) => route.kind === 'make') ?? candidate.routes.find((route) => route.kind === 'market') ?? null;
}

export function SlotCandidateSheet({ slot, companyId, choice, onChoose, onBack, banner }: SlotCandidateSheetProps): React.JSX.Element {
  const chosenNodeId = choice === undefined ? (slot.fill?.nodeId ?? null) : choice.nodeId;
  const [picked, setPicked] = useState<string | null>(chosenNodeId ?? slot.candidates[0]?.nodeId ?? null);

  useEffect(() => {
    setPicked(chosenNodeId ?? slot.candidates[0]?.nodeId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.slotId, chosenNodeId]);

  function pickNode(candidate: SlotCandidate): void {
    setPicked(candidate.nodeId);
    if (choice !== undefined && choice.nodeId === candidate.nodeId) return;
    const opening = openingRouteOf(candidate);
    onChoose(opening === null ? { nodeId: candidate.nodeId, supplierCompanyId: null, supplierProductId: null } : choiceOfRoute(candidate.nodeId, opening));
  }

  const isEmpty = choice !== undefined && choice.nodeId === null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-ghost min-h-11 gap-1 px-2" onClick={onBack}>
          <Icon name="back" size={14} accent="current" />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">
            {slot.label}
            {slot.required ? <span className="ml-1 font-bold text-loss">*</span> : null}
          </div>
          <div className="truncate text-[10.5px] text-ink-faint">
            {NODE_ROLE_LABELS[slot.role]} · {slot.qtyPerUnit} {slot.unitLabel} per unit · {slot.required ? 'required' : 'optional'}
            {slot.kind === 'delivery' ? ' · what it ships on' : ''}
          </div>
        </div>
      </div>

      <ul className="space-y-1.5">
        {slot.candidates.map((candidate) => {
          const best = bestRouteOf(candidate);
          const isPicked = picked === candidate.nodeId;
          const inSlot = !isEmpty && chosenNodeId === candidate.nodeId;
          return (
            <li key={candidate.nodeId}>
              <button
                type="button"
                onClick={() => pickNode(candidate)}
                className={`flex min-h-11 w-full items-center gap-2 rounded-card border px-3 py-2 text-left ${
                  inSlot ? 'border-brand bg-brand-wash' : isPicked ? 'border-ink-faint bg-surface' : 'border-hairline bg-surface'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-ink">{candidate.label}</span>
                    <Tag size="sm">{NODE_TIER_LABELS[candidate.tier as NodeTier] ?? `Tier ${candidate.tier}`}</Tag>
                  </div>
                  <div className="truncate text-[10.5px] text-ink-faint">
                    {formatMoney(candidate.marketPriceUsd, 'full')} on the market
                    {best === null ? '' : ` · best ${formatMoney(best.unitPriceUsd, 'full')} at ${formatPct(best.qualityScore)} quality`}
                    {' · '}
                    {candidate.blocked ? 'nobody makes it' : candidate.producerCount === 0 ? 'no live line' : `${candidate.producerCount} maker${candidate.producerCount === 1 ? '' : 's'}`}
                  </div>
                </div>
                {inSlot ? <Icon name="check" size={14} accent="brand" /> : null}
                {candidate.blocked ? <Tag tone="loss">Blocked</Tag> : null}
              </button>

              {isPicked ? (
                <div className="mt-1.5 ml-3 space-y-1.5 border-l-2 border-hairline pl-3">
                  {candidate.selfSuppliedPct > 0 ? (
                    <p className="text-[11px] leading-snug text-brand">Your own data pool covers {candidate.selfSuppliedPct}% of this, free.</p>
                  ) : null}
                  {candidate.blocked ? (
                    <p className="text-[11px] leading-snug font-semibold text-loss">Nobody in the world owns this node, so it cannot be had at any price.</p>
                  ) : null}
                  {candidate.routes.map((route) => {
                    const selected = inSlot && isRouteChosen(route, choice, slot, companyId);
                    return (
                      <button
                        key={`${route.kind}:${route.supplierProductId ?? 'market'}`}
                        type="button"
                        onClick={() => onChoose(choiceOfRoute(candidate.nodeId, route))}
                        className={`flex min-h-11 w-full items-center gap-2 rounded-card border px-2.5 py-1.5 text-left ${
                          selected ? 'border-brand bg-brand-wash' : 'border-hairline bg-surface'
                        }`}
                      >
                        <Icon
                          name={route.kind === 'make' ? 'building' : route.kind === 'buy' ? 'handshake' : 'globe'}
                          size={15}
                          accent={route.kind === 'market' ? 'neutral' : 'brand'}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] text-ink">{route.label}</span>
                          <span className="block truncate text-[10px] text-ink-faint">{routeCaption(route)}</span>
                        </span>
                        <span className="figure shrink-0 text-[12px] text-ink">{formatMoney(route.unitPriceUsd, 'full')}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canLeaveEmpty(slot) ? (
        <button
          type="button"
          onClick={() => onChoose(EMPTY_CHOICE)}
          className={`flex min-h-11 w-full items-center gap-2 rounded-card border px-3 text-left text-[12px] ${
            isEmpty ? 'border-brand bg-brand-wash text-brand' : 'border-hairline text-ink-dim'
          }`}
        >
          <Icon name="close" size={13} accent="current" />
          Leave empty — the line ships without it
        </button>
      ) : null}

      {banner}
    </div>
  );
}

/** Whether a route is the one the standing choice names. Market matches a null supplier; make and buy match on the line. */
function isRouteChosen(route: InputRoute, choice: SlotChoice | undefined, slot: NodeSlotOptions, companyId: string): boolean {
  if (choice === undefined) {
    const fill = slot.fill;
    if (fill === null) return false;
    if (route.kind === 'market') return fill.route === 'market' || fill.route === 'blocked';
    return route.supplierProductId === fill.supplierProductId && (route.kind !== 'make' || fill.supplierCompanyId === companyId);
  }
  if (route.kind === 'market') return choice.supplierCompanyId === null;
  return route.supplierCompanyId === choice.supplierCompanyId && route.supplierProductId === choice.supplierProductId;
}

/**
 * The second line on a route: what it costs in words, and the quality that
 * rides along. A seller's quote is its published ask at that seller's own
 * energy price and load, held inside the market's band, so when the two
 * differ the caption says what was asked and why the quote is not that.
 */
export function routeCaption(route: InputRoute): string {
  if (route.kind === 'make') return `your own unit cost, no internal margin · quality ${formatPct(route.qualityScore)}`;
  if (route.kind === 'market') return `spot, ${route.premiumPct}% over the market · quality ${formatPct(route.qualityScore)}`;
  const against = route.premiumPct === 0 ? 'at the market' : `${route.premiumPct > 0 ? '+' : ''}${route.premiumPct}% against the market`;
  const asked = quoteDiffers(route) ? ` · asks ${formatMoney(route.askUsd, 'full')}, quoted at their energy price and load` : '';
  return `quality ${formatPct(route.qualityScore)} · ${against}${asked}`;
}

/** True when a seller's quote is not its ask: more than half a percent apart. */
export function quoteDiffers(route: InputRoute): boolean {
  if (route.kind !== 'buy' || route.askUsd <= 0) return false;
  return Math.abs(route.unitPriceUsd - route.askUsd) / route.askUsd > 0.005;
}

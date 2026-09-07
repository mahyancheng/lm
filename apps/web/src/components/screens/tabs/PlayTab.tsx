'use client';

/**
 * Play — the desk. The page *is* End Quarter.
 *
 * There is no sheet to open to submit a quarter, which is the whole point: the
 * tab bar's fifth tab is the desk, so ending a quarter is **Play → Resolve →
 * type the word**, three taps from anywhere in the game. The status bar's
 * quarter block is an equal first tap.
 *
 * Seven cards, in the order the plan sets:
 *
 * 1. The quarter — what is about to close, and where cash lands if it does.
 * 2. Before you submit — only the notes that stop or endanger the quarter.
 * 3. The seal — the same gate as before: `ConfirmDialog`, the typed word, and a
 *    blocked action still refusing the whole submission.
 * 4. Queued instructions — grouped by the phase that will consume each, with
 *    confirm and remove on the row. The seal links straight to this detail when
 *    a founder needs to clear a hold.
 * 5. Ask the Chief of Staff — four questions, and the eleven instructions no
 *    other surface in the game can queue.
 * 6. Last quarter — the report's own figures, opening the full report.
 * 7. How this quarter resolves — the model line, and the pipeline folded away.
 *
 * The one behavioural change from the screen this replaces: a committed quarter
 * `replace`s onto `/play?sheet=resolution` rather than pushing `/quarter-resolution`.
 * The report is a sheet over this tab, and replacing rather than pushing means
 * the desk of the quarter that has just closed is not left in the history for
 * Back to return to — a desk whose queue is empty and whose quarter has moved on.
 */

import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RESOLUTION_PHASES, quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { SOLVENCY_NEGATIVE_QUARTERS } from '@frontier/simulation';
import { ConfirmDialog, cashAfterOf } from '@/components/ui';
import { cashEffectOf } from '@/components/screens/end-quarter/intents';
import { groupQueueByCompany } from '@/components/screens/end-quarter/companyGrouping';
import { lineCount } from '@/components/screens/quarter-resolution/sections';
import { quickPromptsFor } from '@/components/screens/chief-of-staff/quickPrompts';
import {
  PLAYER_ID,
  useGameActions,
  useLlm,
  useOutcome,
  usePlayerCompany,
  usePlayerView,
  useQueuedActions,
  useResolving,
  useSession,
  useSettings,
} from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import { BeforeYouSubmitCard, LastQuarterCard, PipelineCard, QuarterCard, SealBar, SealCard } from './cards/play-cards';
import { QueueCard, groupQueueByPhase } from './cards/play-queue';
import { ChiefCard } from './cards/play-chief';

export function PlayTab(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const company = usePlayerCompany();
  const view = usePlayerView();
  const queue = useQueuedActions();
  const llm = useLlm();
  const settings = useSettings();
  const outcome = useOutcome();
  const { resolving, status } = useResolving();
  const { confirmAction, unqueueAction, clearQueue, endQuarter } = useGameActions();

  const [arming, setArming] = useState(false);

  const blocked = queue.filter((entry) => entry.blocked);
  const rejected = queue.filter((entry) => entry.validation.status === 'rejected');

  /* --- cash ---------------------------------------------------------------
     The validator's own affordability model, over the reduced form of each
     instruction: a clamped action costs what it will actually run at, and a
     rejected one costs nothing because it never runs. */

  const cash = useMemo(() => {
    let outflow = 0;
    let inflow = 0;
    for (const entry of queue) {
      if (entry.validation.status === 'rejected') continue;
      const effect = cashEffectOf(session, entry.validation.clampedAction ?? entry.action.intent);
      outflow += effect.outflowUsd;
      inflow += effect.inflowUsd;
    }
    return { outflow, inflow };
  }, [queue, session]);

  const available = company.financials.cash;
  const solvency = cashAfterOf(company, cash.outflow - cash.inflow);

  /* --- the queue, by phase ------------------------------------------------- */

  const groups = useMemo(() => groupQueueByPhase(queue), [queue]);

  // The same queue folded by the company each instruction belongs to. A group of
  // more than one is what turns the single cash projection into one row each.
  const companyGroups = useMemo(() => groupQueueByCompany(session, queue, PLAYER_ID), [session, queue]);
  // Queue labels may name a subsidiary or another company.  The player seat can
  // always name its own company; every other label comes from the public view.
  const companyNameOf = useMemo(() => {
    const names = new Map([[company.id, company.name], ...view.visibleCompanies.map((entry) => [entry.id, entry.name] as const)]);
    return (companyId: string): string => names.get(companyId) ?? companyId;
  }, [company.id, company.name, view.visibleCompanies]);

  /* --- last quarter -------------------------------------------------------- */

  const summary = useMemo(() => {
    if (outcome === null) return null;
    const failed = outcome.invariants.filter((check) => !check.passed).length;
    return {
      quarter: quarterLabel(session.startYear, outcome.report.quarter),
      headline: outcome.report.headline,
      lines: lineCount(outcome.report),
      ledgerRows: outcome.events.length,
      phasesRun: outcome.report.phases.length,
      invariantsPassed: outcome.invariants.length - failed,
      invariantsFailed: failed,
      committed: outcome.committed,
    };
  }, [outcome, session.startYear]);

  const live = llm.available && settings.useLiveModel;
  const modelLine = live
    ? `The World Director and the major rivals' strategists run on ${llm.model ?? llm.transportKind}. Their output is a proposal: the engine bounds-checks every modifier and validates every NPC action with the same rules as yours.`
    : llm.available
      ? 'A model is configured but you have turned it off for this session. World events fire on their deterministic templates and rivals run their archetype defaults.'
      : 'No model is configured. World events fire on their deterministic templates and rivals run their archetype defaults — the game plays in full either way.';

  const quarter = quarterLabel(session.startYear, session.quarter);
  const canSubmit = blocked.length === 0 && !resolving;

  /**
   * The arming state and the navigation are settled on every path.
   *
   * `endQuarter` resolves to false when the engine threw on both attempts: the
   * quarter is still open, there is no report to read, and the founder stays
   * here with the notice and their queue rather than being sent to an empty
   * screen. On success the report opens as a sheet over this tab. The address is
   * replaced rather than pushed: the desk it replaces belongs to a quarter that
   * no longer exists. The report's own exit is the button in its body.
   */
  async function resolve(): Promise<void> {
    setArming(false);
    let resolved = false;
    try {
      resolved = await endQuarter();
    } finally {
      if (resolved) router.replace(sheetHref('resolution'));
    }
  }

  return (
    <>
      <QuarterCard
        quarter={quarter}
        lastResolved={summary === null ? null : summary.quarter}
        queued={queue.length}
        blocked={blocked.length}
        resolving={resolving}
        company={company}
        netSpendUsd={cash.outflow - cash.inflow}
      />

      <BeforeYouSubmitCard
        blocked={blocked.length}
        rejected={rejected.length}
        outflowUsd={cash.outflow}
        availableUsd={available}
        afterUsd={solvency.afterUsd}
        solvencyLine={solvency.line}
      />

      <SealCard
        quarter={quarter}
        nextQuarter={quarterLabel(session.startYear, session.quarter + 1)}
        canSubmit={canSubmit}
        resolving={resolving}
        status={status}
        queued={queue.length}
        blocked={blocked.length}
        outflowUsd={cash.outflow}
        availableUsd={available}
        onArm={() => setArming(true)}
      />

      <div id="queued-instructions" className="scroll-mt-4">
        <QueueCard
          groups={groups}
          queued={queue.length}
          startYear={session.startYear}
          resolving={resolving}
          companyGroups={companyGroups}
          companyNameOf={companyNameOf}
          onConfirm={confirmAction}
          onRemove={unqueueAction}
          onClear={clearQueue}
        />
      </div>

      <ChiefCard prompts={quickPromptsFor(pathname, null)} />

      <LastQuarterCard summary={summary} />

      <PipelineCard modelLine={modelLine} timings={outcome?.phaseTimings ?? []} live={live} />

      <SealBar
        quarter={quarter}
        canSubmit={canSubmit}
        resolving={resolving}
        queued={queue.length}
        blocked={blocked.length}
        onArm={() => setArming(true)}
      />

      <ConfirmDialog
        open={arming}
        title="Resolve the quarter"
        body={`This submits every queued instruction, runs all ${RESOLUTION_PHASES.length} phases and commits the ledger. It cannot be taken back: a quarter resolves once.`}
        terms={[
          { label: 'Quarter', value: quarter },
          { label: 'Instructions', value: String(queue.length) },
          { label: 'Cash committed', value: formatMoney(cash.outflow), emphasis: cash.outflow > available },
          { label: 'Cash sought', value: formatMoney(cash.inflow) },
          { label: 'Cash at the close', value: formatMoney(solvency.afterUsd), emphasis: solvency.afterUsd < 0 },
          {
            label: 'Solvency',
            value: solvency.line === null ? 'Above zero' : `${solvency.quarters + 1} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero`,
            emphasis: solvency.afterUsd < 0,
          },
          { label: 'World and rivals', value: live ? 'Model-directed' : 'Deterministic' },
        ]}
        requireTyped="RESOLVE"
        confirmLabel="Resolve"
        busy={resolving}
        onCancel={() => setArming(false)}
        onConfirm={() => void resolve()}
      />
    </>
  );
}

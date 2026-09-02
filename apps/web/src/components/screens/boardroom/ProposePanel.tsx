'use client';

/**
 * Table a matter.
 *
 * The panel runs a whip count as the matter is drafted, so the founder walks
 * into the room knowing who is with them and why. The rationale beside each
 * director is the engine's own — traits, mandate, the relationship with the
 * chief executive, and any live commitment whose conditions the draft satisfies.
 *
 * `submit_board_proposal` is one of the thirteen: nothing is queued until a
 * human has passed through `ConfirmDialog`.
 */

import { useMemo, useState } from 'react';
import type { ActionValidationResult, Board, BoardProposalKind, Character, PlayerView, SessionState } from '@frontier/contracts';
import { BOARD_PROPOSAL_KINDS } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import {
  ConfirmDialog,
  Panel,
  PersonChip,
  ProgressBar,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  openCeiling,
  roundStep,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { PROPOSAL_KIND_BLURB, PROPOSAL_KIND_LABEL } from './labels';
import { hypotheticalProposal, whipCount } from './whip';

export interface ProposePanelProps {
  readonly session: SessionState;
  readonly board: Board;
  readonly founder: Character;
  readonly view: PlayerView;
  readonly directorsById: ReadonlyMap<string, Character>;
}

const STANCE_TONE = { support: 'gain', oppose: 'loss', abstain: 'neutral' } as const;

export function ProposePanel({ session, board, founder, view, directorsById }: ProposePanelProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();
  const [kind, setKind] = useState<BoardProposalKind>('annual_plan');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [amount, setAmount] = useState(0);
  const [priced, setPriced] = useState(false);
  const [targetCompanyId, setTargetCompanyId] = useState('');
  const [stockPct, setStockPct] = useState(0.3);
  const [useStock, setUseStock] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionValidationResult | null>(null);

  // A matter can carry no price at all, and that is not the same as a price of
  // zero — so the amount stays behind its own switch rather than becoming a
  // slider that always states something.
  const amountUsd = priced && Number.isFinite(amount) ? Math.max(0, amount) : null;

  // What the company is marked at is the scale directors argue inside; a matter
  // worth more than the whole company is typed through "Exact".
  const anchorUsd = session.valuationAnchors.find((entry) => entry.companyId === board.companyId)?.anchorValueUsd ?? 0;
  const amountMax = openCeiling(10_000_000, anchorUsd, view.ownCompany.financials.cash, amountUsd ?? 0);

  const draft = useMemo(
    () => ({
      kind,
      title,
      summary,
      amountUsd,
      targetCompanyId: targetCompanyId.length === 0 ? null : targetCompanyId,
      stockComponentPct: useStock ? stockPct : null,
    }),
    [kind, title, summary, amountUsd, targetCompanyId, useStock, stockPct],
  );

  const count = useMemo(
    () => whipCount(session, board, hypotheticalProposal(session, board, founder.id, draft)),
    [session, board, founder.id, draft],
  );

  const valid = title.trim().length >= 3 && summary.trim().length >= 10;

  const intent = valid
    ? ({
        type: 'submit_board_proposal' as const,
        kind,
        title: title.trim().slice(0, 140),
        summary: summary.trim().slice(0, 1200),
        amountUsd,
        targetCompanyId: draft.targetCompanyId,
        stockComponentPct: draft.stockComponentPct,
      })
    : null;

  const preview = intent === null ? null : validateIntent(intent);

  function confirm(): void {
    if (intent === null) return;
    const entry = queueAction(intent, { confirmed: true });
    setResult(entry.validation);
    setConfirming(false);
  }

  const cast = count.support + count.against;

  return (
    <>
      <Panel iconName="stamp" title="Table a matter" subtitle="Drafted here, voted in the board-resolution phase">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint mb-1 block">Kind</span>
            <select className="field tap-target sm:min-h-0" value={kind} onChange={(event) => setKind(event.target.value as BoardProposalKind)}>
              {BOARD_PROPOSAL_KINDS.map((option) => (
                <option key={option} value={option}>
                  {PROPOSAL_KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <div>
            <label className="tap-target flex cursor-pointer items-center gap-2.5 sm:min-h-0">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-[color:var(--color-brand-strong)] sm:size-4"
                checked={priced}
                onChange={(event) => setPriced(event.target.checked)}
              />
              <span className="label-caps-faint">Headline amount</span>
            </label>
            {priced ? (
              <SliderField
                className="mt-1.5"
                label="Amount"
                value={amountUsd ?? 0}
                onChange={setAmount}
                min={0}
                max={amountMax}
                step={roundStep(amountMax)}
                format={formatMoney}
                chips
              />
            ) : (
              <p className="mt-1.5 text-[10px] text-ink-faint">The matter carries no price. Directors vote on the case, not a number.</p>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint sm:text-[10px]">{PROPOSAL_KIND_BLURB[kind]}</p>

        <label className="mt-2.5 block">
          <span className="label-caps-faint mb-1 block">Agenda line</span>
          <input className="field tap-target sm:min-h-0" maxLength={140} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Authorise a Series A financing" />
        </label>

        <label className="mt-2.5 block">
          <span className="label-caps-faint mb-1 block">The case</span>
          <textarea
            className="field tap-target sm:min-h-0"
            rows={3}
            maxLength={1200}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Include the numbers directors will actually argue about."
          />
        </label>

        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint mb-1 block">Target company</span>
            <select className="field tap-target sm:min-h-0" value={targetCompanyId} onChange={(event) => setTargetCompanyId(event.target.value)}>
              <option value="">None</option>
              {view.visibleCompanies.map((rival) => (
                <option key={rival.id} value={rival.id}>
                  {rival.name ?? rival.id}
                </option>
              ))}
            </select>
          </label>
          <div>
            {/* The whole row is the target: a label activates its own input,
                so the finger gets 44px even though the box stays a box. */}
            <label className="tap-target flex cursor-pointer items-center gap-2.5 sm:min-h-0">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-[color:var(--color-brand-strong)] sm:size-4"
                checked={useStock}
                onChange={(event) => setUseStock(event.target.checked)}
              />
              <span className="label-caps-faint">Stock component</span>
            </label>
            {useStock ? (
              <SliderField
                className="mt-1.5"
                label="In stock"
                value={stockPct}
                onChange={setStockPct}
                min={0}
                max={1}
                step={0.05}
                format={formatPct}
                exact={false}
              />
            ) : (
              <p className="mt-1.5 text-[10px] text-ink-faint">Directors negotiate hard over this on an acquisition.</p>
            )}
          </div>
        </div>

        <div className="mt-4 border-t border-hair pt-3">
          <SectionHeading
            actions={
              <Tag tone={count.carries ? 'gain' : 'loss'} dot>
                {count.quorumMet ? (count.carries ? 'Carries as drafted' : 'Falls as drafted') : 'No quorum'}
              </Tag>
            }
          >
            Projected whip count
          </SectionHeading>

          <div className="mt-2">
            <ProgressBar
              label={`Support against a ${formatPct(count.threshold)} threshold`}
              value={cast === 0 ? 0 : count.support / cast}
              tone={count.carries ? 'gain' : 'loss'}
              ghostValue={count.threshold}
              valueLabel={`${count.support} for · ${count.against} against · ${count.abstain} abstaining`}
            />
          </div>

          <div className="mt-2.5 space-y-1.5">
            {count.lines.map((line) => {
              const director = directorsById.get(line.characterId);
              return (
                <div key={line.characterId} className="raised-surface px-2.5 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {director === undefined ? (
                      <span className="text-[11px] text-ink">{line.characterId}</span>
                    ) : (
                      <PersonChip character={director} size="sm" subtitle={director.title} className="max-w-[60%]" />
                    )}
                    <div className="flex items-center gap-1.5">
                      {line.honouredCommitmentId === null ? null : <Tag tone="info">commitment</Tag>}
                      <Tag tone={line.recused ? 'neutral' : STANCE_TONE[line.stance]} dot>
                        {line.recused ? 'recused' : line.stance}
                      </Tag>
                    </div>
                  </div>
                  <p className="mt-1 text-[10px] text-ink-faint">{line.rationale}</p>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            A projection from state, not a promise. The vote is taken in the board-resolution phase against the numbers as they stand then.
          </p>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="btn btn-primary btn-sm tap-target w-full sm:w-auto sm:min-h-0"
            disabled={intent === null}
            onClick={() => setConfirming(true)}
          >
            Review and table
          </button>
        </div>

        {result === null && preview !== null ? (
          <div className="mt-2">
            <ValidationBanner result={preview} compact />
          </div>
        ) : null}
        {result === null ? null : (
          <div className="mt-2">
            <ValidationBanner result={result} />
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={confirming && intent !== null}
        title="Table a board matter"
        actionType="submit_board_proposal"
        body="Tabling puts the matter to a vote this quarter. Directors remember what they were asked to approve, and what happened afterwards."
        terms={[
          { label: 'Kind', value: PROPOSAL_KIND_LABEL[kind] },
          { label: 'Agenda line', value: title.trim() || '—' },
          { label: 'Amount', value: amountUsd === null ? 'no price' : formatMoney(amountUsd), emphasis: amountUsd !== null },
          { label: 'Threshold', value: formatPct(count.threshold) },
          { label: 'Projected', value: count.quorumMet ? (count.carries ? 'carries' : 'falls') : 'no quorum', emphasis: !count.carries },
        ]}
        confirmLabel="Table the matter"
        onCancel={() => setConfirming(false)}
        onConfirm={confirm}
      />
    </>
  );
}

'use client';

/**
 * The deal builder.
 *
 * Free text never writes state. A deal is a set of typed obligations on each
 * side, and the whole point of the subsystem is visible in the form: what you
 * *contract* goes in `gives` and `gets` and is mechanically enforced; what you
 * merely *say* goes in intent statements, is recorded, is visible to both
 * parties and is never enforced. "But they promised me in chat" is not an
 * argument this game accepts.
 *
 * `propose_deal` is one of the thirteen, so nothing leaves here without a human
 * clicking through `ConfirmDialog`.
 */

import { useMemo, useState } from 'react';
import type {
  ActionIntent,
  ActionValidationResult,
  BoardProposalKind,
  DealConfidentiality,
  DealObligation,
  DealPartyKind,
  VoteStance,
} from '@frontier/contracts';
import { BOARD_PROPOSAL_KINDS, DEAL_OBLIGATION_KINDS, VOTE_STANCES, quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { ConfirmDialog, SectionHeading, Tag, ValidationBanner, cx } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import {
  OBLIGATION_HINTS,
  OBLIGATION_LABELS,
  blankObligation,
  cashInObligations,
  describeObligation,
  type ObligationKind,
} from './obligations';

export interface NamedOption {
  readonly id: string;
  readonly label: string;
}

export interface CounterpartyOption extends NamedOption {
  readonly kind: DealPartyKind;
}

export interface DealBuilderProps {
  readonly counterparties: readonly CounterpartyOption[];
  readonly securities: readonly NamedOption[];
  readonly opportunities: readonly NamedOption[];
  readonly techNodes: readonly NamedOption[];
  readonly products: readonly NamedOption[];
  readonly quarter: number;
  readonly startYear: number;
  /** Uncommitted cash, so a cash obligation can be read against it. */
  readonly availableCashUsd: number;
}

type Side = 'gives' | 'gets';

export function DealBuilder({
  counterparties,
  securities,
  opportunities,
  techNodes,
  products,
  quarter,
  startYear,
  availableCashUsd,
}: DealBuilderProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();

  const first = counterparties[0];
  const [counterpartyId, setCounterpartyId] = useState(first?.id ?? '');
  const [gives, setGives] = useState<DealObligation[]>([]);
  const [gets, setGets] = useState<DealObligation[]>([]);
  const [binding, setBinding] = useState(true);
  const [confidentiality, setConfidentiality] = useState<DealConfidentiality>('private');
  const [expires, setExpires] = useState(quarter + 2);
  const [summary, setSummary] = useState('');
  const [statements, setStatements] = useState('');
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [pending, setPending] = useState<ActionIntent | null>(null);
  const [queued, setQueued] = useState(false);

  const counterparty = counterparties.find((option) => option.id === counterpartyId) ?? null;
  const intentStatements = statements
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4);

  const ready = counterparty !== null && summary.trim().length >= 10 && gives.length + gets.length > 0;

  const intent: ActionIntent | null = useMemo(() => {
    if (counterparty === null) return null;
    return {
      type: 'propose_deal',
      proposal: {
        counterpartyId: counterparty.id,
        counterpartyKind: counterparty.kind,
        gives,
        gets,
        confidentiality,
        expiresQuarter: expires,
        binding,
        intentStatements,
        summary: summary.trim(),
      },
    };
    // `intentStatements` is derived from `statements` each render; listing the
    // source keeps the memo honest without re-deriving on every keystroke.
  }, [counterparty, gives, gets, confidentiality, expires, binding, summary, statements]); // eslint-disable-line react-hooks/exhaustive-deps

  function check(): void {
    if (intent === null || !ready) return;
    setResult(validateIntent(intent));
  }

  const cashOut = cashInObligations(gives);

  return (
    <div className="flex flex-col gap-3.5">
      {/* --- parties and terms -------------------------------------------- */}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="label-caps-faint">Counterparty</span>
          <select
            className="field mt-1"
            value={counterpartyId}
            onChange={(event) => {
              setCounterpartyId(event.target.value);
              setResult(null);
              setQueued(false);
            }}
          >
            {counterparties.map((option) => (
              <option key={`${option.kind}:${option.id}`} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label-caps-faint">Offer lapses after</span>
          <select
            className="field mt-1"
            value={expires}
            onChange={(event) => {
              setExpires(Number(event.target.value));
              setResult(null);
            }}
          >
            {[0, 1, 2, 3, 4, 6, 8].map((offset) => (
              <option key={offset} value={quarter + offset}>
                {quarterLabel(startYear, quarter + offset)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={cx('btn btn-sm', binding ? 'btn-primary' : '')}
          onClick={() => {
            setBinding((value) => !value);
            setResult(null);
          }}
        >
          {binding ? 'Binding' : 'Non-binding'}
        </button>
        <button
          type="button"
          className={cx('btn btn-sm', confidentiality === 'public' ? 'btn-primary' : '')}
          onClick={() => {
            setConfidentiality((value) => (value === 'private' ? 'public' : 'private'));
            setResult(null);
          }}
        >
          {confidentiality === 'public' ? 'Announced publicly' : 'Confidential'}
        </button>
        <span className="text-[10px] leading-relaxed text-ink-faint">
          {binding
            ? 'Obligations are enforced every quarter; failing to deliver is a breach with permanent consequences.'
            : 'Nothing is enforced. The whole agreement is a recorded statement of intent.'}
        </span>
      </div>

      {/* --- obligations --------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ObligationColumn
          side="gives"
          title="You give"
          obligations={gives}
          onChange={(next) => {
            setGives(next);
            setResult(null);
          }}
          securities={securities}
          opportunities={opportunities}
          techNodes={techNodes}
          products={products}
          quarter={quarter}
        />
        <ObligationColumn
          side="gets"
          title="You get"
          obligations={gets}
          onChange={(next) => {
            setGets(next);
            setResult(null);
          }}
          securities={securities}
          opportunities={opportunities}
          techNodes={techNodes}
          products={products}
          quarter={quarter}
        />
      </div>

      {/* --- prose --------------------------------------------------------- */}
      <label className="block">
        <span className="label-caps-faint">Summary the counterparty reads first</span>
        <textarea
          className="field mt-1"
          rows={2}
          maxLength={600}
          value={summary}
          placeholder="Two quarters of reserved capacity against a licence to your retrieval stack, with a cash top-up on signature."
          onChange={(event) => {
            setSummary(event.target.value);
            setResult(null);
            setQueued(false);
          }}
        />
        <span className="mt-1 block text-[10px] text-ink-faint">At least 10 characters. {summary.trim().length} / 600</span>
      </label>

      <label className="block">
        <span className="label-caps-faint">Statements of intent — recorded, never enforced</span>
        <textarea
          className="field mt-1"
          rows={2}
          value={statements}
          placeholder={'One per line.\nWe intend to support your listing next year.'}
          onChange={(event) => {
            setStatements(event.target.value);
            setResult(null);
          }}
        />
        <span className="mt-1 block text-[10px] text-ink-faint">
          {intentStatements.length} of 4 recorded. These are visible to both parties and the engine will never enforce them.
        </span>
      </label>

      {cashOut > 0 ? (
        <p
          className={cx(
            'rounded-card border px-3.5 py-2.5 text-[11px]',
            cashOut > availableCashUsd ? 'border-loss/25 bg-loss-wash text-loss' : 'border-hair bg-raised text-ink-dim',
          )}
        >
          You are committing {formatMoney(cashOut)} of cash against {formatMoney(availableCashUsd)} on hand — payable in the capital phase
          after acceptance, not now.
        </p>
      ) : null}

      <ValidationBanner result={result} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={check} disabled={!ready}>
          Check with the validator
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!ready || queued || intent === null}
          onClick={() => setPending(intent)}
        >
          {queued ? 'Queued' : 'Propose the deal'}
        </button>
        {!ready ? <span className="text-[10px] text-ink-faint">A counterparty, a summary and at least one obligation.</span> : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Send this offer"
        actionType="propose_deal"
        body="Nothing binds until the counterparty accepts. If they do, and the deal is binding, its obligations begin executing next quarter and a failure to deliver is a breach."
        terms={[
          { label: 'To', value: counterparty?.label ?? '—' },
          { label: 'You give', value: gives.map(describeObligation).join(' · ') || 'nothing' },
          { label: 'You get', value: gets.map(describeObligation).join(' · ') || 'nothing', emphasis: true },
          { label: 'Binding', value: binding ? 'Yes' : 'No — statement of intent' },
          { label: 'Lapses', value: quarterLabel(startYear, expires) },
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

/* -------------------------------------------------------------------------- */
/*  One side of the deal                                                       */
/* -------------------------------------------------------------------------- */

interface ColumnProps {
  readonly side: Side;
  readonly title: string;
  readonly obligations: readonly DealObligation[];
  readonly onChange: (next: DealObligation[]) => void;
  readonly securities: readonly NamedOption[];
  readonly opportunities: readonly NamedOption[];
  readonly techNodes: readonly NamedOption[];
  readonly products: readonly NamedOption[];
  readonly quarter: number;
}

function ObligationColumn({
  side,
  title,
  obligations,
  onChange,
  securities,
  opportunities,
  techNodes,
  products,
  quarter,
}: ColumnProps): React.JSX.Element {
  const [adding, setAdding] = useState<ObligationKind>('cash_payment');

  function replace(index: number, next: DealObligation): void {
    onChange(obligations.map((entry, position) => (position === index ? next : entry)));
  }

  return (
    <div>
      <SectionHeading rule>{title}</SectionHeading>

      {obligations.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">Nothing on this side yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {obligations.map((obligation, index) => (
            <li key={`${side}-${index}-${obligation.kind}`} className="raised-surface px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <Tag tone="info">{OBLIGATION_LABELS[obligation.kind]}</Tag>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="Remove obligation"
                  onClick={() => onChange(obligations.filter((_, position) => position !== index))}
                >
                  ✕
                </button>
              </div>
              <ObligationFields
                obligation={obligation}
                onChange={(next) => replace(index, next)}
                securities={securities}
                opportunities={opportunities}
                techNodes={techNodes}
                products={products}
              />
              <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">{OBLIGATION_HINTS[obligation.kind]}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <select className="field h-6 w-auto py-0 text-[11px]" value={adding} onChange={(event) => setAdding(event.target.value as ObligationKind)}>
          {DEAL_OBLIGATION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {OBLIGATION_LABELS[kind]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-sm"
          disabled={obligations.length >= 6}
          onClick={() => onChange([...obligations, blankObligation(adding, quarter)])}
        >
          Add
        </button>
        {obligations.length >= 6 ? <span className="text-[10px] text-ink-faint">Six a side is the limit.</span> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Typed fields per kind                                                      */
/* -------------------------------------------------------------------------- */

interface FieldProps {
  readonly obligation: DealObligation;
  readonly onChange: (next: DealObligation) => void;
  readonly securities: readonly NamedOption[];
  readonly opportunities: readonly NamedOption[];
  readonly techNodes: readonly NamedOption[];
  readonly products: readonly NamedOption[];
}

function ObligationFields({ obligation, onChange, securities, opportunities, techNodes, products }: FieldProps): React.JSX.Element {
  switch (obligation.kind) {
    case 'compute_supply':
      return (
        <Row>
          <NumberField
            label="Units a quarter"
            value={obligation.units}
            min={0}
            onChange={(units) => onChange({ ...obligation, units })}
          />
          <NumberField
            label="Quarters"
            value={obligation.quarters}
            min={1}
            max={20}
            onChange={(quarters) => onChange({ ...obligation, quarters })}
          />
        </Row>
      );

    case 'cash_payment':
      return (
        <Row>
          <NumberField label="Amount (USD)" value={obligation.amount} min={0} step={100_000} onChange={(amount) => onChange({ ...obligation, amount })} />
        </Row>
      );

    case 'investment':
      return (
        <Row>
          <NumberField label="Amount (USD)" value={obligation.amount} min={0} step={100_000} onChange={(amount) => onChange({ ...obligation, amount })} />
          <SelectField
            label="Security received"
            value={obligation.securityId}
            options={securities}
            onChange={(securityId) => onChange({ ...obligation, securityId })}
          />
        </Row>
      );

    case 'equity_transfer':
      return (
        <Row>
          <SelectField
            label="Security"
            value={obligation.securityId}
            options={securities}
            onChange={(securityId) => onChange({ ...obligation, securityId })}
          />
          <NumberField label="Shares" value={obligation.shares} min={0} onChange={(shares) => onChange({ ...obligation, shares })} />
        </Row>
      );

    case 'tech_license':
      return (
        <Row>
          <SelectField
            label="Frontier node"
            value={obligation.techNodeId ?? ''}
            options={techNodes}
            allowEmpty="None"
            onChange={(techNodeId) => onChange({ ...obligation, techNodeId: techNodeId === '' ? null : techNodeId })}
          />
          <SelectField
            label="Product"
            value={obligation.productId ?? ''}
            options={products}
            allowEmpty="None"
            onChange={(productId) => onChange({ ...obligation, productId: productId === '' ? null : productId })}
          />
          <NumberField label="Quarters" value={obligation.quarters} min={1} max={20} onChange={(quarters) => onChange({ ...obligation, quarters })} />
        </Row>
      );

    case 'board_vote_pledge':
      return (
        <Row>
          <SelectField
            label="Matter"
            value={obligation.proposalKind}
            options={BOARD_PROPOSAL_KINDS.map((kind) => ({ id: kind, label: kind.replace(/_/g, ' ') }))}
            onChange={(kind) => onChange({ ...obligation, proposalKind: kind as BoardProposalKind })}
          />
          <SelectField
            label="Stance"
            value={obligation.stance}
            options={VOTE_STANCES.map((stance) => ({ id: stance, label: stance }))}
            onChange={(stance) => onChange({ ...obligation, stance: stance as VoteStance })}
          />
          <NumberField label="Quarters" value={obligation.quarters} min={1} max={12} onChange={(quarters) => onChange({ ...obligation, quarters })} />
        </Row>
      );

    case 'public_endorsement':
      return (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <label className="block">
            <span className="label-caps-faint">What will be said</span>
            <input
              className="field mt-1"
              maxLength={400}
              value={obligation.statement}
              onChange={(event) => onChange({ ...obligation, statement: event.target.value })}
            />
          </label>
          <NumberField label="Quarters maintained" value={obligation.quarters} min={1} max={8} onChange={(quarters) => onChange({ ...obligation, quarters })} />
        </div>
      );

    case 'consortium_membership':
      return (
        <Row>
          <SelectField
            label="Opportunity"
            value={obligation.opportunityId}
            options={opportunities}
            onChange={(opportunityId) => onChange({ ...obligation, opportunityId })}
          />
        </Row>
      );

    default:
      return <p className="mt-1.5 text-[11px] text-ink-faint">No fields.</p>;
  }
}

function Row({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">{children}</div>;
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="label-caps-faint">{label}</span>
      <input
        type="number"
        className="field mt-1"
        value={String(value)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  allowEmpty,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly NamedOption[];
  readonly allowEmpty?: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="label-caps-faint">{label}</span>
      <select className="field mt-1" value={value} onChange={(event) => onChange(event.target.value)}>
        {allowEmpty === undefined ? <option value="">Choose…</option> : <option value="">{allowEmpty}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

'use client';

/**
 * The ledger rows behind a figure.
 *
 * Every economic mutation in the game creates a `SimEvent`, and every derived
 * number on a reporting screen can open the rows that produced it. This is the
 * component that shows them: the actor, the target and the payload exactly as
 * committed, with the sequence numbers that place them in the ledger.
 *
 * The row's machine name (`event.type`) is deliberately absent, here as in the
 * Quarter Resolution drawer: the drawer's own title says what the player asked
 * about and the payload carries the detail, so an enum spelt out in words adds
 * a second, worse name for the same row.
 */

import type { SimEvent } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { Drawer, EmptyState, Icon, Tag, type Tone } from '@/components/ui';

const VISIBILITY_TONE: Readonly<Record<string, Tone>> = {
  public: 'info',
  sector: 'brand',
  company: 'warn',
  private: 'loss',
};

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e4) / 1e4);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface LedgerDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly events: readonly SimEvent[];
  /** Copy shown when the selection matched no committed rows. */
  readonly emptyMessage?: string;
  /** Name an actor or a target for the reader; without one the row prints the id as committed. */
  readonly resolveName?: LedgerNameResolver;
}

export function LedgerDrawer({ open, onClose, title, subtitle, events, emptyMessage, resolveName }: LedgerDrawerProps): React.JSX.Element {
  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle} width={520}>
      {events.length === 0 ? (
        <EmptyState
          glyph="LGR"
          compact
          title="No ledger rows in this tab"
          message={
            emptyMessage ??
            'The ledger for a quarter is held from the moment it resolves. Resolve a quarter and this figure will open its committed rows.'
          }
        />
      ) : (
        <LedgerRowList events={events} resolveName={resolveName} />
      )}
    </Drawer>
  );
}

/**
 * Name a ledger id for a reader, or null when nobody can.
 *
 * A company, a character, a record item, a fund, an agency, a tech node — the
 * caller knows its world and answers; the list only asks. Given one, the list
 * prints names where the ledger holds ids, and drops a value it cannot name
 * rather than printing the id.
 */
export type LedgerNameResolver = (id: string) => string | null;

export interface LedgerRowListProps {
  readonly events: readonly SimEvent[];
  readonly className?: string;
  /**
   * Compact: one line of who and whom, one line of the figures, no hashes and
   * no visibility tag. For a newspaper's "Sources" list, where the row is a
   * citation; the full row is a tap away through `onOpen`.
   */
  readonly compact?: boolean;
  readonly resolveName?: LedgerNameResolver;
  /** Open one row in full. Renders each compact row as a button. */
  readonly onOpen?: (event: SimEvent) => void;
}

/**
 * The rows themselves, as a list.
 *
 * The drawer above wraps this in a sheet; the newspaper's full-article view
 * prints the same list under a "Sources" rule, in its compact form. One
 * rendering of a committed row, wherever it is cited.
 */
export function LedgerRowList({ events, className, compact = false, resolveName, onOpen }: LedgerRowListProps): React.JSX.Element {
  if (compact) {
    return (
      <ul className={className ?? 'flex flex-col'}>
        {events.map((event) => {
          const summary = compactSummary(event, resolveName);
          const figures = compactFigures(event, resolveName);
          const inner = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug text-ink" data-testid="source-summary">
                  {summary}
                </span>
                {figures.length === 0 ? null : (
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint" data-testid="source-figures">
                    {figures.join(' · ')}
                  </span>
                )}
              </span>
              <span className="figure shrink-0 pt-0.5 text-[10px] text-ink-faint">Q{event.quarter + 1}</span>
              {onOpen === undefined ? null : <Icon name="chevronRight" size={14} accent="current" />}
            </>
          );
          return (
            <li key={event.eventId} className="np-rule" data-testid="source-row">
              {onOpen === undefined ? (
                <div className="flex w-full items-start gap-2 py-2 text-left">{inner}</div>
              ) : (
                <button type="button" onClick={() => onOpen(event)} className="tap-target flex w-full items-start gap-2 py-2 text-left" aria-label={`Open ledger row ${event.sequence}`}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className={className ?? 'flex flex-col gap-2'}>
      {events.map((event) => (
        <li key={event.eventId} className="raised-surface px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Tag tone={VISIBILITY_TONE[event.visibility] ?? 'neutral'} dot>
              {event.visibility}
            </Tag>
            <span className="figure text-[10px] text-ink-faint">#{event.sequence}</span>
          </div>

          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-ink-faint">
            <span>
              Quarter <span className="figure text-ink-dim">{event.quarter}</span>
            </span>
            {event.actorId !== null ? (
              <span>
                Actor <span className="figure text-ink-dim">{resolveName?.(event.actorId) ?? event.actorId}</span>
              </span>
            ) : null}
            {event.targetId !== null ? (
              <span>
                Target <span className="figure text-ink-dim">{resolveName?.(event.targetId) ?? event.targetId}</span>
              </span>
            ) : null}
          </div>

          {Object.keys(event.payload).length > 0 ? (
            <dl className="mt-2 grid grid-cols-[minmax(0,40%)_minmax(0,60%)] gap-x-3 gap-y-1 border-t border-hair pt-2">
              {Object.entries(event.payload).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="truncate text-[10px] text-ink-faint">{key}</dt>
                  <dd className="figure truncate text-[10px] text-ink-dim" title={renderValue(value)}>
                    {renderValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          <p className="mt-2 truncate text-[9px] text-ink-faint" title={`${event.stateHashBefore} → ${event.stateHashAfter}`}>
            {event.stateHashBefore.slice(0, 10)} → {event.stateHashAfter.slice(0, 10)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  The compact reading                                                        */
/* -------------------------------------------------------------------------- */

/** An engine id: a three-letter prefix, an underscore, a slug. Never printed in the compact form. */
const ID_PATTERN = /^[a-z]{3}_[a-z0-9_]+$/;

/** A machine token: lower-case words joined by underscores. Spelt out in the compact form. */
const TOKEN_PATTERN = /^[a-z]+(_[a-z0-9]+)+$/;

/** Payload keys that carry money, people or a share, so the figure reads in units. */
const MONEY_KEY = /usd$|revenue|cash|debt|income|capital|value|cap$|cheque|price|cost|loss/i;
const PEOPLE_KEY = /reach|headcount|followers/i;
const SHARE_KEY = /credib|margin|confidence|conviction|factor|share|pct|ratio|severity|prominence|sentiment/i;

/**
 * "Rumour spread · Bill Hargrove about Harbourline Freight": what the row
 * records, then who and whom, with every id named or dropped.
 */
export function compactSummary(event: SimEvent, resolveName?: LedgerNameResolver): string {
  const name = (id: string | null): string | null => (id === null ? null : (resolveName?.(id) ?? (ID_PATTERN.test(id) ? null : id)));
  const kind = event.payload['kind'];
  const what = typeof kind === 'string' ? humaniseToken(kind) : null;
  const actor = name(event.actorId);
  const target = name(event.targetId);
  const who = actor !== null && target !== null && actor !== target ? `${actor} · ${target}` : (actor ?? target);
  if (what !== null && who !== null) return `${what} · ${who}`;
  return what ?? who ?? `Ledger row ${event.sequence}`;
}

/**
 * The figures a row carries, in units, ids named, tokens spelt out, nothing
 * raw — and no value twice: a story row holds its id and its headline, and the
 * id names the same headline, so the second is dropped.
 */
export function compactFigures(event: SimEvent, resolveName?: LedgerNameResolver): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, text: string): void => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push(`${label} ${text}`);
  };
  const push = (key: string, value: unknown): void => {
    if (key === 'kind') return;
    const label = humaniseKey(key);
    if (typeof value === 'number') {
      add(label, figureFor(key, value));
      return;
    }
    if (typeof value === 'boolean') {
      add(label, value ? 'yes' : 'no');
      return;
    }
    if (typeof value === 'string') {
      const named = resolveName?.(value) ?? null;
      if (named !== null) add(label, named);
      else if (ID_PATTERN.test(value)) return;
      else add(label, TOKEN_PATTERN.test(value) ? humaniseToken(value).toLowerCase() : value);
      return;
    }
    if (Array.isArray(value)) {
      const names = value.map((entry) => (typeof entry === 'string' ? (resolveName?.(entry) ?? (ID_PATTERN.test(entry) ? null : entry)) : String(entry))).filter((entry): entry is string => entry !== null);
      if (names.length > 0) add(label, names.join(', '));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [innerKey, inner] of Object.entries(value as Record<string, unknown>)) push(innerKey, inner);
    }
  };
  for (const [key, value] of Object.entries(event.payload)) push(key, value);
  return out;
}

function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\busd\b/g, '')
    .replace(/\bpct\b/g, '')
    // "source post ids" → "source posts"; "disclosure id" → "disclosure".
    .replace(/ ids\b/g, 's')
    .replace(/\bid\b/g, '')
    .trim();
  return spaced.length === 0 ? key : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function humaniseToken(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? value : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function figureFor(key: string, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (MONEY_KEY.test(key) && Math.abs(value) >= 1000) return formatMoney(value);
  if (SHARE_KEY.test(key) && Math.abs(value) <= 1) return formatPct(value);
  if (PEOPLE_KEY.test(key)) return value >= 1_000_000 ? `${Math.round(value / 1_000_000)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(Math.round(value));
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

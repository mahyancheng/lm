'use client';

/**
 * The shape every card on a tab takes.
 *
 * A tab is one scrolling page of cards. A card states its figures **on the
 * page** — so the answer is read without a tap — and opens exactly one sheet.
 * That is the whole contract, and it lives here rather than being retyped
 * thirteen times: the header carries the sheet's own mark and title from
 * `SHEETS`, and the control on the right is the one link into it.
 *
 * `TabCard` is a thin arrangement of `Panel`, not a second panel primitive.
 * `DrillRow` is the one row shape a card uses when it lists three of something
 * — a line, a role band, a holder — each row a 44-point target that deep-links
 * into the sheet with the thing already selected.
 *
 * Every component in this folder is pure: figures in as props, markup out, no
 * hooks and no store. That is what lets the tab tests render them.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, Panel, type Tone } from '@/components/ui';
import { SHEETS, sheetHref, type SheetId, type SheetParams } from '@/lib/sheets';

export interface TabCardProps {
  /** The one sheet this card opens. Its mark and title come from the registry. */
  readonly sheet: SheetId;
  /** Extra params on the header link, e.g. the instrument a stock card opens. */
  readonly params?: SheetParams;
  /** Override the registry title where the card names the subject differently. */
  readonly title?: string;
  readonly subtitle?: ReactNode;
  readonly iconTone?: Tone;
  /** Tags shown left of the Open control — a count, a warning. */
  readonly badges?: ReactNode;
  readonly flush?: boolean;
  readonly children?: ReactNode;
}

export function TabCard({
  sheet,
  params,
  title,
  subtitle,
  iconTone = 'neutral',
  badges,
  flush = false,
  children,
}: TabCardProps): React.JSX.Element {
  const meta = SHEETS[sheet];
  const name = title ?? meta.title;
  return (
    <Panel
      title={name}
      subtitle={subtitle}
      iconName={meta.icon}
      iconTone={iconTone}
      flush={flush}
      actions={
        <>
          {badges}
          <Link href={sheetHref(sheet, params)} className="btn btn-ghost tap-target gap-1 px-2" aria-label={`Open ${name}`}>
            Open
            <Icon name="chevronRight" size={14} accent="current" />
          </Link>
        </>
      }
    >
      {children}
    </Panel>
  );
}

export interface DrillRowProps {
  /** Always a sheet address from `sheetHref` — never a raw legacy path. */
  readonly href: string;
  readonly name: string;
  readonly detail?: ReactNode;
  /** The figure that decides whether to tap: a price, a count, a stake. */
  readonly figure?: ReactNode;
  readonly figureHint?: ReactNode;
  readonly tone?: Tone;
}

/** One tappable line inside a card. 44 points tall by `tap-target`, wherever it renders. */
export function DrillRow({ href, name, detail, figure, figureHint, tone }: DrillRowProps): React.JSX.Element {
  return (
    <Link
      href={href}
      className="raised-surface press-pop tap-target flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:border-hair-strong"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{name}</span>
        {detail === undefined ? null : <span className="block truncate text-[10.5px] text-ink-faint">{detail}</span>}
      </span>
      {figure === undefined ? null : (
        <span className="flex shrink-0 flex-col items-end">
          <span className={tone === undefined ? 'figure text-[12.5px] text-ink' : `figure text-[12.5px] tone-${tone}`}>{figure}</span>
          {figureHint === undefined ? null : <span className="figure text-[10.5px] text-ink-faint">{figureHint}</span>}
        </span>
      )}
      <span className="shrink-0 text-ink-faint">
        <Icon name="chevronRight" size={14} accent="current" />
      </span>
    </Link>
  );
}

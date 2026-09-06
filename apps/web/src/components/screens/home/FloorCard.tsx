'use client';

/**
 * The floor — who you are, where you are, and what quarter it is.
 *
 * The first card on Home and the answer to "whose company is this": the name,
 * the archetype in words, the sector and the city, with the open quarter beside
 * them and the office drawn underneath. Every part of it opens the Company
 * sheet, so the card is one destination however a thumb lands on it.
 *
 * The office scene reads the store, so it arrives as a slot rather than being
 * mounted here: that keeps this card a pure function of its props and lets a
 * test render it without a provider.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Company } from '@frontier/contracts';
import { Icon, IconChip, Tag, sectorLabel, sectorOf } from '@/components/ui';
import { sheetHref } from '@/lib/sheets';
import { archetypeLabel } from '../reporting/util';

export interface FloorCardProps {
  readonly company: Company;
  /** The open quarter, already formatted by `quarterLabel`. */
  readonly quarter: string;
  /** `OfficeSceneCompact`, or nothing where there is no store to read. */
  readonly scene?: ReactNode;
}

export function FloorCard({ company, quarter, scene }: FloorCardProps): React.JSX.Element {
  return (
    <section className="panel-surface animate-pop-in flex min-w-0 flex-col overflow-hidden">
      <Link
        href={sheetHref('company')}
        className="press-pop tap-target flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-raised"
      >
        <IconChip name="building" tone="brand" />
        <span className="min-w-0 flex-1">
          {/* The company's own name and what it is: wrapped, never cut. This is
              the identity card, and at 360 the second line lost its last word. */}
          <span className="line-clamp-2 block text-[14px] leading-tight font-semibold text-ink">{company.name}</span>
          <span className="line-clamp-2 block text-[11.5px] leading-snug text-ink-faint">
            {archetypeLabel(company.archetype)} · {sectorLabel(sectorOf(company))} · {company.headquartersCity}
          </span>
        </span>
        <Tag tone="neutral">{quarter}</Tag>
        <span className="shrink-0 text-ink-faint">
          <Icon name="chevronRight" size={14} accent="current" />
        </span>
      </Link>
      {scene === undefined ? null : <div className="px-3 pt-0.5 pb-3">{scene}</div>}
    </section>
  );
}

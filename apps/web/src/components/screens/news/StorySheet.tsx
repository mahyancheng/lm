'use client';

/**
 * A story in full, as a bottom sheet.
 *
 * The same kicker, the whole headline, the byline, the whole body in a
 * readable serif — one column, or two when the measurer says both would be
 * wide enough and carry six lines — then what the item follows from, the
 * committed ledger rows behind it as "Sources" (named, not as ids; a tap opens
 * the row in the ledger drawer every report screen uses), and where else on the
 * app it leads: the subject company, the speaker's company when it differs, the
 * person, the sector. Nothing here is written by a model; the sources are the
 * rows.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import type { PublicRecordItem, Sector, SimEvent } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import { Drawer, EmptyState, Icon, cx, sectorLabel } from '@/components/ui';
import { LedgerRowList, type LedgerNameResolver } from '@/components/screens/reporting/LedgerDrawer';
import { humanise } from '@/components/screens/reporting/util';
import { setPendingNetworkCharacter, setPendingSectorFocus } from '@/lib/game';
import { columnsFor, type Measurer } from '@/lib/text/measure';
import { FittedHeadline, SHEET_SIZES } from './Headline';
import { followsId } from './layout';
import { PAPER_NAME } from './Masthead';
import { Byline, ForYou, Kicker, SectionRule, type NewsContext } from './pieces';
import { useElementWidth } from './useTypeMeasure';

/** The body face in the sheet: sixteen over one and a half, as a paper's body copy on a phone. */
const SHEET_BODY = { weight: 400, sizePx: 16, leading: 1.5 } as const;
/** The sheet's content width before it is measured: the phone less the drawer's padding. */
const SHEET_WIDTH_FALLBACK = 350;
const COLUMN_GAP_PX = 16;

export interface StorySheetProps {
  readonly item: PublicRecordItem | null;
  readonly onClose: () => void;
  readonly context: NewsContext;
  /** Committed rows by id, for the Sources list. */
  readonly ledgerById: ReadonlyMap<string, SimEvent>;
  readonly measurer: Measurer | null;
  readonly serif: string;
  /** Open the item this one follows from. */
  readonly onFollow: (id: string) => void;
  readonly companySectors: ReadonlyMap<string, Sector>;
  /** Events with a pin on the map. */
  readonly mappedEventIds: ReadonlySet<string>;
  readonly onShowOnMap: (eventId: string) => void;
  /** Name an id the ledger holds, for the Sources rows. */
  readonly resolveName: LedgerNameResolver;
  /** Open one ledger row in full. */
  readonly onOpenRow: (row: SimEvent) => void;
  /** Whether the ledger the store holds is this edition's. False for an earlier edition, which cites nothing. */
  readonly ledgerIsCurrent: boolean;
}

export function StorySheet({
  item,
  onClose,
  context,
  ledgerById,
  measurer,
  serif,
  onFollow,
  companySectors,
  mappedEventIds,
  onShowOnMap,
  resolveName,
  onOpenRow,
  ledgerIsCurrent,
}: StorySheetProps): React.JSX.Element {
  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      side="bottom"
      title={PAPER_NAME}
      subtitle={item === null ? undefined : `${quarterLabel(context.startYear, item.quarter)} · ${item.kicker.word}`}
    >
      {item === null ? null : (
        <Article
          item={item}
          context={context}
          ledgerById={ledgerById}
          measurer={measurer}
          serif={serif}
          onFollow={onFollow}
          companySectors={companySectors}
          mappedEventIds={mappedEventIds}
          onShowOnMap={onShowOnMap}
          resolveName={resolveName}
          onOpenRow={onOpenRow}
          ledgerIsCurrent={ledgerIsCurrent}
        />
      )}
    </Drawer>
  );
}

function Article({
  item,
  context,
  ledgerById,
  measurer,
  serif,
  onFollow,
  companySectors,
  mappedEventIds,
  onShowOnMap,
  resolveName,
  onOpenRow,
  ledgerIsCurrent,
}: Omit<StorySheetProps, 'item' | 'onClose'> & { readonly item: PublicRecordItem }): React.JSX.Element {
  const [ref, widthPx] = useElementWidth<HTMLDivElement>(SHEET_WIDTH_FALLBACK);
  const paragraphs = useMemo(() => item.body.split(/\n{2,}|\r?\n(?=\S)/).map((part) => part.trim()).filter((part) => part.length > 0), [item.body]);
  const columns = columnsFor(item.body, { family: serif, ...SHEET_BODY }, widthPx, COLUMN_GAP_PX, measurer);

  const rows = useMemo(() => {
    const out: SimEvent[] = [];
    for (const id of item.ledgerEventIds) {
      const row = ledgerById.get(id);
      if (row !== undefined) out.push(row);
    }
    return out.sort((a, b) => a.sequence - b.sequence);
  }, [item.ledgerEventIds, ledgerById]);

  const parentId = followsId(item);
  const parentHeadline = parentId === null ? null : context.headlineOf(parentId);
  const mapEventId =
    item.kind === 'event' && mappedEventIds.has(item.id)
      ? item.id
      : item.links.sourceEventId !== null && mappedEventIds.has(item.links.sourceEventId)
        ? item.links.sourceEventId
        : null;

  // Where else this leads. The subject company first, then the speaker's when
  // it is another — a rival's rumour about you leads to both. A company the
  // reader directs opens Company; any other company opens the sector screen
  // focused on its sector, which is where the app shows a rival. A person opens
  // their card on Network.
  const companyIds = [...new Set([...item.companyIds, ...(item.who.companyId === null ? [] : [item.who.companyId])])];
  const person = item.who.characterId === null ? null : (context.characters.get(item.who.characterId) ?? null);
  const sector = item.kicker.sector;

  return (
    <div ref={ref} className="flex flex-col gap-3" data-testid="story-sheet">
      <Kicker item={item} context={context} />
      <FittedHeadline as="h3" text={item.headline} sizes={SHEET_SIZES} maxLines={4} widthPx={widthPx} measurer={measurer} serif={serif} leading={1.1} />
      {item.deck === null ? null : <p className="np-deck text-[15px] leading-[1.35]">{item.deck}</p>}
      <Byline item={item} context={context} size="md" />
      <ForYou text={item.whyItMatters} />

      <dl className="np-kicker flex flex-wrap gap-x-4 gap-y-1 text-ink-faint">
        {item.reach === null ? null : (
          <div className="flex gap-1.5">
            <dt>Read by</dt>
            <dd className="figure text-ink-dim">{peopleShort(item.reach)}</dd>
          </div>
        )}
        <div className="flex gap-1.5">
          <dt>Attention</dt>
          <dd className="figure text-ink-dim">{formatPct(item.weight)}</dd>
        </div>
        {item.heard === null ? null : (
          <div className="flex gap-1.5" data-testid="heard">
            <dt>Heard as</dt>
            <dd className="text-ink-dim">
              {humanise(item.heard.kind).toLowerCase()} · <span className="figure">{formatPct(item.heard.credibility)}</span> believed
            </dd>
          </div>
        )}
        {item.pressPickup === true ? (
          <div className="flex gap-1.5 text-info">
            <Icon name="newspaper" size={12} accent="current" />
            <dd>Picked up by the press</dd>
          </div>
        ) : null}
      </dl>

      {paragraphs.length === 0 ? null : (
        <div className={cx('np-rule pt-3', columns === 2 && 'np-columns-2')} data-columns={columns} data-testid="story-body">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className={cx('np-body', index > 0 && 'mt-3')} style={{ fontSize: SHEET_BODY.sizePx, lineHeight: SHEET_BODY.leading }}>
              {paragraph}
            </p>
          ))}
        </div>
      )}

      {parentId === null ? null : (
        <button type="button" onClick={() => onFollow(parentId)} className="np-rule tap-target flex w-full items-start gap-2 py-2.5 text-left">
          <span className="np-kicker shrink-0 pt-0.5">Follows</span>
          <span className="np-deck min-w-0 flex-1 text-[14px] text-ink">{parentHeadline ?? 'An earlier item on the record'}</span>
          <Icon name="chevronRight" size={14} accent="current" />
        </button>
      )}

      <section aria-label="Sources" data-testid="sources">
        <SectionRule right={rows.length === 0 ? undefined : `${rows.length} row${rows.length === 1 ? '' : 's'}`}>Sources</SectionRule>
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon="ledger"
            title={ledgerIsCurrent ? 'No ledger row names this item' : 'Only the latest edition cites its rows'}
            message={
              ledgerIsCurrent
                ? 'Every economic mutation is a ledger row, and this item produced none of its own this quarter.'
                : 'The ledger is held for the quarter that most recently resolved. This item is from an earlier edition, whose rows are no longer held.'
            }
          />
        ) : (
          <LedgerRowList events={rows} compact resolveName={resolveName} onOpen={onOpenRow} className="mt-1 flex flex-col" />
        )}
      </section>

      <section aria-label="Also on" data-testid="also-on">
        <SectionRule>Also on</SectionRule>
        <ul className="flex flex-col">
          {companyIds.map((companyId) => {
            const companyName = context.companyNames.get(companyId) ?? (companyId === item.companyIds[0] ? item.kicker.company : null);
            if (companyName === null) return null;
            const companySector = companySectors.get(companyId) ?? (companyId === item.companyIds[0] ? item.kicker.sector : null);
            return (
              <li key={companyId} className="np-rule">
                {companyId === context.playerCompanyId ? (
                  <Link href="/company" className="tap-target flex items-center gap-2 py-2 text-[13px] font-semibold text-ink">
                    <Icon name="building" size={15} />
                    {companyName}
                    <span className="np-kicker ml-auto">Company</span>
                  </Link>
                ) : (
                  <Link
                    href="/sector"
                    onClick={() => {
                      if (companySector !== null) setPendingSectorFocus(companySector);
                    }}
                    className="tap-target flex items-center gap-2 py-2 text-[13px] font-semibold text-ink"
                  >
                    <Icon name="building" size={15} />
                    {companyName}
                    <span className="np-kicker ml-auto">Sector</span>
                  </Link>
                )}
              </li>
            );
          })}
          {person === null ? null : (
            <li className="np-rule">
              <Link
                href="/network"
                onClick={() => setPendingNetworkCharacter(person.id)}
                className="tap-target flex items-center gap-2 py-2 text-[13px] font-semibold text-ink"
              >
                <Icon name="network" size={15} />
                {person.name}
                <span className="np-kicker ml-auto">Network</span>
              </Link>
            </li>
          )}
          {sector === null || !context.multiSector ? null : (
            <li className="np-rule">
              <Link href="/sector" onClick={() => setPendingSectorFocus(sector)} className="tap-target flex items-center gap-2 py-2 text-[13px] font-semibold text-ink">
                <Icon name="globe" size={15} />
                {sectorLabel(sector)}
                <span className="np-kicker ml-auto">Sector</span>
              </Link>
            </li>
          )}
          {mapEventId === null ? null : (
            <li className="np-rule">
              <button type="button" onClick={() => onShowOnMap(mapEventId)} className="tap-target flex w-full items-center gap-2 py-2 text-left text-[13px] font-semibold text-ink">
                <Icon name="globe" size={15} />
                Show on the map
                <span className="np-kicker ml-auto">World</span>
              </button>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

/** "4M", "18k", "740" — the same whole-unit reading the projection's decks use. */
function peopleShort(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

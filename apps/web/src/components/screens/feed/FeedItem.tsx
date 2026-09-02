'use client';

/**
 * One thing that became public, as one card.
 *
 * A world event, a press story, a filing, a post and a reply are five tables in
 * the engine and one card here, because to a reader they are one kind of thing.
 * The card never says which table it came from beyond a mark and a word, and it
 * never partitions by author: the player's own line sits in the stream with a
 * "you" chip and nothing else.
 *
 * What the card is allowed to show is exactly what `PublicRecordItem` carries.
 * Reach and attention are engine output; `whyItMatters` is a whole-number
 * consequence the engine computed from the ledger; the ledger button opens the
 * committed rows themselves. Nothing on this card is derived from a model, and
 * every NPC-authored line keeps the AI label without exception (UI_SYSTEM §6).
 */

import { useState } from 'react';
import type { PublicRecordItem, PublicRecordKind, Sector } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import {
  AiLabel,
  Icon,
  IconChip,
  PersonChip,
  SectorBadge,
  Tag,
  cx,
  type IconName,
  type PersonLike,
  type Tone,
} from '@/components/ui';
import { countLabel, networkLabel } from '@/components/screens/social/audiences';
import { humanise } from '@/components/screens/reporting/util';
import { feedSectorsOf, isFundVoice, isOwnItem } from './filters';

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                      */
/* -------------------------------------------------------------------------- */

const KIND_LABEL: Readonly<Record<PublicRecordKind, string>> = {
  event: 'World event',
  story: 'Press',
  disclosure: 'Filing',
  post: 'Post',
  reply: 'Reply',
};

/** The mark for each kind: a shock, a story, a filing, a voice, an answer. */
const KIND_ICON: Readonly<Record<PublicRecordKind, IconName>> = {
  event: 'warning',
  story: 'newspaper',
  disclosure: 'stamp',
  post: 'chat',
  reply: 'chat',
};

const KIND_TONE: Readonly<Record<PublicRecordKind, Tone>> = {
  event: 'warn',
  story: 'info',
  disclosure: 'neutral',
  post: 'brand',
  reply: 'brand',
};

/** Sentiment as a tone. The thresholds match the ones the press screens used. */
export function toneOfSentiment(value: number): Tone {
  if (value <= -0.3) return 'loss';
  if (value >= 0.3) return 'gain';
  return 'neutral';
}

/** No roster: the set every card falls back to, allocated once. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Past this many characters the body is worth collapsing rather than printing. */
const COLLAPSE_ABOVE = 190;

/* -------------------------------------------------------------------------- */
/*  Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What every card on a feed shares.
 *
 * Passed once by `Feed` rather than threaded through each card as a dozen
 * props: the maps are built once per screen from the same state the projection
 * came from.
 */
export interface FeedContext {
  readonly startYear: number;
  /** Characters by id, for the byline portrait. Missing ids fall back to the name. */
  readonly characters: ReadonlyMap<string, PersonLike>;
  readonly companyNames: ReadonlyMap<string, string>;
  readonly companySectors: ReadonlyMap<string, Sector>;
  /**
   * Draw sector and company chips at all.
   *
   * False in a world-version-1 session, where every company is in the one
   * sector and a badge on every card is six identical stickers.
   */
  readonly multiSector: boolean;
  readonly playerCharacterId: string;
  readonly playerCompanyId: string;
  /** Headlines by item id, so a causal parent reads as a sentence. */
  readonly headlines: ReadonlyMap<string, string>;
  /** Events that have a pin on the map. Only these offer "show on map". */
  readonly mappedEventIds: ReadonlySet<string>;
  /**
   * Partner characters of the capital entities on the roster.
   *
   * A fund speaks through its partner, so this is how a card knows a short
   * report or an activist letter came from an institution rather than from a
   * person — and draws the institution's mark instead of the filing stamp.
   * Empty in a world with no institutional layer, which is the whole gate.
   */
  readonly fundPartnerIds?: ReadonlySet<string>;
  /** Institution names, keyed by their partner's character id. */
  readonly fundNameByPartnerId?: ReadonlyMap<string, string>;
  readonly onShowOnMap?: (eventId: string) => void;
  /** Open the committed ledger rows behind an item. */
  readonly onOpenLedger?: (item: PublicRecordItem) => void;
}

export interface FeedItemProps {
  readonly item: PublicRecordItem;
  readonly context: FeedContext;
  /** A reply, drawn indented under the post it answers. */
  readonly indented?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  The card                                                                   */
/* -------------------------------------------------------------------------- */

export function FeedItem({ item, context, indented = false }: FeedItemProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const character = item.who.characterId === null ? null : (context.characters.get(item.who.characterId) ?? null);
  const fromFund = isFundVoice(item, context.fundPartnerIds ?? EMPTY_IDS);
  const fundName =
    item.who.characterId === null ? null : (context.fundNameByPartnerId?.get(item.who.characterId) ?? null);
  const own = isOwnItem(item, context.playerCharacterId, context.playerCompanyId);
  const companyName = item.who.companyId === null ? null : (context.companyNames.get(item.who.companyId) ?? null);
  const kindTone = KIND_TONE[item.kind];
  const sentimentTone = toneOfSentiment(item.tone);
  const collapsible = item.body.length > COLLAPSE_ABOVE;
  const parentHeadline = item.links.causalParentId === null ? null : (context.headlines.get(item.links.causalParentId) ?? null);
  const mapEventId =
    item.kind === 'event' && context.mappedEventIds.has(item.id)
      ? item.id
      : item.links.sourceEventId !== null && context.mappedEventIds.has(item.links.sourceEventId)
        ? item.links.sourceEventId
        : null;

  const sectors = context.multiSector ? feedSectorsOf(item, context.companySectors) : [];
  const named = context.multiSector ? item.companyIds : [];

  return (
    <article
      className={cx(
        'panel-surface overflow-hidden px-3 py-3',
        // A reply is the same card, one step in and hung off a rule, so a thread
        // reads as one conversation without becoming a second component.
        indented && 'ml-3 border-l-2 border-l-brand/30 sm:ml-6',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {character === null ? (
            <div className="flex min-w-0 items-center gap-2">
              <IconChip name={fromFund ? 'briefcase' : KIND_ICON[item.kind]} tone={fromFund ? 'brand' : kindTone} />
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-semibold text-ink">{item.who.name}</p>
                <p className="truncate text-[10px] text-ink-faint">{companyName ?? KIND_LABEL[item.kind]}</p>
              </div>
            </div>
          ) : (
            <PersonChip
              character={character}
              size="sm"
              subtitle={companyName ?? undefined}
              right={item.who.isAi ? <AiLabel /> : null}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="figure text-[10px] text-ink-faint">{quarterLabel(context.startYear, item.quarter)}</span>
          {own ? <Tag tone="brand">you</Tag> : null}
          {character === null && item.who.isAi ? <AiLabel /> : null}
        </div>
      </header>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Tag tone={kindTone}>
          <Icon name={fromFund ? 'briefcase' : KIND_ICON[item.kind]} size={12} accent="current" />
          {KIND_LABEL[item.kind]}
        </Tag>
        {!fromFund ? null : (
          <Tag tone="brand">
            <Icon name="briefcase" size={11} accent="current" />
            {fundName ?? 'An institution'}
          </Tag>
        )}
        {item.network === null ? null : <Tag tone="neutral">{networkLabel(item.network)}</Tag>}
        {item.intent === null ? null : <Tag tone="neutral">{humanise(item.intent)}</Tag>}
        {item.tone === 0 ? null : (
          <Tag tone={sentimentTone} dot>
            {item.tone < 0 ? 'hostile' : 'favourable'}
          </Tag>
        )}
      </div>

      <p className={cx('mt-2 text-[14px] leading-snug font-semibold', `tone-${sentimentTone}`)}>{item.headline}</p>

      {item.body.length === 0 ? null : collapsible ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 block w-full text-left"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className={cx('block text-[13px] leading-relaxed text-ink-dim', expanded ? '' : 'line-clamp-3')}>{item.body}</span>
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            {expanded ? 'Less' : 'More'}
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} accent="current" />
          </span>
        </button>
      ) : (
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">{item.body}</p>
      )}

      {item.whyItMatters === null ? null : (
        <p className="mt-2 flex items-start gap-1.5 rounded-card bg-brand-wash px-2 py-1.5 text-[11.5px] leading-snug font-semibold text-brand">
          <Icon name="gauge" size={13} accent="current" />
          {item.whyItMatters}
        </p>
      )}

      {parentHeadline === null ? null : (
        <p className="mt-1.5 border-l-2 border-hair-strong pl-2 text-[11px] text-ink-faint">
          Follows: <span className="text-ink-dim">{parentHeadline}</span>
        </p>
      )}

      {sectors.length > 0 || named.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sectors.map((sector) => (
            <SectorBadge key={sector} sector={sector} />
          ))}
          {named.map((companyId) => (
            <Tag key={companyId} tone={companyId === context.playerCompanyId ? 'brand' : 'neutral'}>
              <Icon name="building" size={11} accent="current" />
              {context.companyNames.get(companyId) ?? companyId}
            </Tag>
          ))}
        </div>
      ) : null}

      {item.reach === null ? null : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <Figure label="Reach" value={countLabel(Math.round(item.reach))} />
          <Figure label="Attention" value={formatPct(item.weight)} />
        </div>
      )}

      {mapEventId === null && item.ledgerEventIds.length === 0 ? null : (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {mapEventId === null || context.onShowOnMap === undefined ? null : (
            <button type="button" className="btn tap-target" onClick={() => context.onShowOnMap?.(mapEventId)}>
              <Icon name="globe" size={15} />
              Show on map
            </button>
          )}
          {item.ledgerEventIds.length === 0 || context.onOpenLedger === undefined ? null : (
            <button type="button" className="btn tap-target" onClick={() => context.onOpenLedger?.(item)}>
              <Icon name="ledger" size={15} />
              Why <span className="figure text-[10px] opacity-70">{item.ledgerEventIds.length}</span>
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div>
      <span className="label-caps-faint mr-1.5">{label}</span>
      <span className="figure text-[12px] text-ink">{value}</span>
    </div>
  );
}

'use client';

/**
 * The World tab's cards: what is happening outside this company.
 *
 * The paper comes first, and it comes first for the reason Coffee Inc 2's
 * reviewers complained about: news buried two screens deep is news nobody
 * reads. The lead headline of the newest edition is *printed on the tab*, three
 * briefs under it, and the five section chips open the paper already turned to
 * that section.
 *
 * Then the things a founder asks about the world in the order they ask: what is
 * being said (Social), who they know (People), where they stand (Standing),
 * what their own sector costs (The economy) and — folded away, because it is
 * ten readings and none of them is urgent — the world's own dials.
 *
 * Pure by construction: every figure arrives as a prop, derived by `WorldTab`
 * from the same functions the sheets read. The one piece of state in the file is
 * the readings fold, which is interface, not data.
 */

import Link from 'next/link';
import { useState } from 'react';
import type { DominantNarrative, PublicRecordItem, WorldState } from '@frontier/contracts';
import { formatCount, formatMoney, formatPct, formatScore } from '@frontier/shared';
import { EmptyState, Icon, KeyValueGrid, Panel, PersonChip, Tag, type PersonLike } from '@/components/ui';
import { WorldStrip } from '@/components/screens/command-centre/WorldStrip';
import { PAPER_NAME } from '@/components/screens/news/Masthead';
import { NEWS_SECTIONS, SECTION_LABEL, type NewsSection } from '@/components/screens/news/layout';
import { bandLabel, narrativeLabel } from '@/components/screens/reporting/util';
import { countLabel } from '@/components/screens/social/audiences';
import { RING_LABEL, RING_ORDER, RING_TONE, type Ring } from '@/components/screens/network/rings';
import { sheetHref } from '@/lib/sheets';
import { TabCard } from './shell';

/* -------------------------------------------------------------------------- */
/*  The paper                                                                  */
/* -------------------------------------------------------------------------- */

/** Briefs printed under the lead. Three is what fits above the next card on a 390px phone. */
export const BRIEFS_SHOWN = 3;

export interface PaperCardProps {
  /** `The Frontier Ledger · Q3 2027 · Edition 4`, or the same line saying no edition has printed. */
  readonly masthead: string;
  /** The heaviest item of the newest edition — the projection's own order, never re-sorted. */
  readonly lead: PublicRecordItem | null;
  readonly briefs: readonly PublicRecordItem[];
  readonly narrative: DominantNarrative;
  readonly controversy: number;
}

const CONTROVERSY_BANDS: readonly [string, string, string, string, string] = ['Quiet', 'Simmering', 'Active', 'Hot', 'Incendiary'];

export function PaperCard({ masthead, lead, briefs, narrative, controversy }: PaperCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="news"
      title={PAPER_NAME}
      iconTone="brand"
      subtitle={masthead}
      badges={<Tag tone="info">{narrativeLabel(narrative)}</Tag>}
    >
      {lead === null ? (
        <EmptyState
          compact
          icon="newspaper"
          title="No edition has gone to press"
          message="End a quarter and the first edition prints: every event, story, filing and post the world made public."
        />
      ) : (
        <>
          <Link href={sheetHref('news')} className="block tap-target py-1">
            <span className="np-kicker block">{lead.who.name}</span>
            <span className="np-headline mt-0.5 block text-[19px] leading-[1.12]">{lead.headline}</span>
            {lead.deck === null ? null : <span className="np-deck mt-1 block text-[12.5px] leading-snug">{lead.deck}</span>}
          </Link>

          {briefs.length === 0 ? null : (
            <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-hair pt-2.5">
              {briefs.slice(0, BRIEFS_SHOWN).map((item) => (
                <li key={item.id}>
                  <Link
                    href={sheetHref('news')}
                    className="tap-target flex items-center gap-2 rounded-chip px-1 transition-colors hover:bg-raised"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{item.headline}</span>
                    <span className="figure shrink-0 text-[10px] text-ink-faint">{item.who.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* The five sections, each opening the paper already turned to it. */}
      <div className="scroll-x no-scrollbar -mx-1 mt-3 border-t border-hair px-1 pt-2.5">
        <div className="flex w-max items-center gap-1.5">
          {NEWS_SECTIONS.map((section: NewsSection) => (
            <Link
              key={section}
              href={sheetHref('news', section === 'front' ? undefined : { section })}
              className="tap-target inline-flex shrink-0 items-center rounded-pill border border-hair bg-panel px-3 text-[11.5px] font-semibold text-ink-dim hover:border-hair-strong hover:text-ink"
            >
              {SECTION_LABEL[section]}
            </Link>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-[10.5px] text-ink-faint">Controversy · {bandLabel(controversy, CONTROVERSY_BANDS)}</p>
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Social                                                                     */
/* -------------------------------------------------------------------------- */

export interface TrendingPost {
  readonly id: string;
  readonly headline: string;
  readonly author: string;
  readonly reach: number;
  readonly isAi: boolean;
}

export interface SocialCardProps {
  readonly narrative: DominantNarrative;
  readonly attention: number;
  readonly controversy: number;
  /** The three loudest posts of the record, by measured reach. */
  readonly trending: readonly TrendingPost[];
  /** What you last said, and when — null when you have never posted. */
  readonly lastPost: { readonly text: string; readonly quarterLabel: string } | null;
  readonly followers: number;
}

export function SocialCard({ narrative, attention, controversy, trending, lastPost, followers }: SocialCardProps): React.JSX.Element {
  return (
    <TabCard sheet="social" subtitle="The press cycle, the loudest posts, and what you last said." iconTone="neutral">
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Press cycle', value: narrativeLabel(narrative), wide: true, hint: 'The frame every story is written into this quarter' },
          { label: 'Attention', value: formatPct(attention) },
          { label: 'Controversy', value: formatPct(controversy), tone: controversy >= 0.6 ? 'warn' : undefined },
        ]}
      />

      {trending.length === 0 ? null : (
        <ol className="mt-3 flex flex-col gap-1.5 border-t border-hair pt-2.5">
          {trending.map((post, index) => (
            <li key={post.id} className="flex items-baseline gap-2">
              <span className="figure w-4 shrink-0 text-[11px] text-ink-faint">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{post.headline}</span>
              <span className="figure shrink-0 text-[10px] text-ink-faint">{countLabel(post.reach)}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 border-t border-hair pt-2.5">
        <div className="label-caps-faint">Your last post</div>
        {lastPost === null ? (
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
            You have never posted. {countLabel(followers)} people follow your accounts and would see it if you did.
          </p>
        ) : (
          <>
            <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-ink-dim">{lastPost.text}</p>
            <p className="mt-0.5 text-[10.5px] text-ink-faint">
              {lastPost.quarterLabel} · {countLabel(followers)} following
            </p>
          </>
        )}
      </div>
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

export interface PeopleCardProps {
  /** The founder's own connection level: the number the whole social layer turns on. */
  readonly connection: number;
  /** How many people sit in each ring — reachable, one introduction away, out of reach. */
  readonly reach: Readonly<Record<Ring, number>>;
  /** The three most connected people you can reach right now. */
  readonly people: readonly PersonLike[];
}

export function PeopleCard({ connection, reach, people }: PeopleCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="network"
      title="People"
      subtitle="How far away everybody is, and who you can open a channel with this quarter."
      badges={<Tag tone="neutral">{`connection ${formatScore(connection)}`}</Tag>}
    >
      <KeyValueGrid
        columns={3}
        items={RING_ORDER.map((ring) => ({
          label: RING_LABEL[ring],
          value: formatCount(reach[ring]),
          tone: ring === 'inner' && reach[ring] > 0 ? ('gain' as const) : ring === 'outer' && reach[ring] > 0 ? ('warn' as const) : undefined,
        }))}
      />
      {people.length === 0 ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Nobody is in reach yet. Connection level is recomputed every quarter from ten inputs; the sheet names all ten.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {people.map((person) => (
            <li key={person.id}>
              <Link href={sheetHref('network')} className="block rounded-chip transition-colors hover:bg-raised">
                <PersonChip
                  character={person}
                  size="sm"
                  className="tap-target"
                  right={<Icon name="chevronRight" size={14} accent="current" />}
                  ring={RING_TONE.inner}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Standing                                                                   */
/* -------------------------------------------------------------------------- */

export interface StandingRow {
  /** Null before the first resolution: the boards are computed by the engine, never asserted here. */
  readonly value: number | null;
  readonly rank: number | null;
}

export interface StandingCardProps {
  readonly founderIndex: StandingRow;
  readonly companyValue: StandingRow;
  readonly wealth: StandingRow;
  readonly network: StandingRow;
}

/** `#3` when ranked, an honest dash before the first quarter has resolved. */
function rankHint(row: StandingRow): string {
  return row.rank === null ? 'Computed at the first resolution' : `Rank #${row.rank}`;
}

export function StandingCard({ founderIndex, companyValue, wealth, network }: StandingCardProps): React.JSX.Element {
  return (
    <TabCard
      sheet="leaderboard"
      title="Standing"
      iconTone="brand"
      subtitle="Where you place among the founders, on the four boards that decide it."
      badges={founderIndex.rank === null ? null : <Tag tone="info">{`#${founderIndex.rank} overall`}</Tag>}
    >
      <KeyValueGrid
        columns={2}
        items={[
          {
            label: 'Founder Index',
            value: founderIndex.value === null ? '—' : formatScore(founderIndex.value * 100),
            hint: rankHint(founderIndex),
          },
          { label: 'Company value', value: companyValue.value === null ? '—' : formatMoney(companyValue.value), hint: rankHint(companyValue) },
          { label: 'Your wealth', value: wealth.value === null ? '—' : formatMoney(wealth.value), hint: rankHint(wealth) },
          { label: 'Network', value: network.value === null ? '—' : formatScore(network.value), hint: rankHint(network) },
        ]}
      />
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  The economy                                                                */
/* -------------------------------------------------------------------------- */

export interface EconomyCardProps {
  readonly sectorLabel: string;
  /** The committed sector row, or null in a world that never priced its sectors. */
  readonly priceIndex: number | null;
  readonly shortage: number | null;
  readonly supplyUsd: number | null;
  /** The freight toll in this company's own region, and who is charging it. */
  readonly tollPct: number | null;
  readonly tollCaption: string | null;
  readonly regionLabel: string;
}

export function EconomyCard({
  sectorLabel,
  priceIndex,
  shortage,
  supplyUsd,
  tollPct,
  tollCaption,
  regionLabel,
}: EconomyCardProps): React.JSX.Element {
  if (priceIndex === null) {
    return (
      <TabCard sheet="sector" title="The economy" subtitle="The six-sector chain and what each link costs.">
        <EmptyState
          compact
          icon="globe"
          title="This session runs a single sector"
          message="Sector goods prices, the freight toll and the shortage counter belong to the multi-sector world. A session founded before it ran one industry and one price."
        />
      </TabCard>
    );
  }
  return (
    <TabCard
      sheet="sector"
      title="The economy"
      subtitle={`${sectorLabel} · what your own link of the chain costs.`}
      iconTone={shortage !== null && shortage > 0 ? 'warn' : 'neutral'}
      badges={shortage !== null && shortage > 0 ? <Tag tone="warn" dot>{`short -${shortage}%`}</Tag> : null}
    >
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Your sector price', value: formatCount(priceIndex), hint: '100 is the anchor you learn once', tone: priceIndex > 100 ? 'warn' : priceIndex < 100 ? 'info' : undefined },
          { label: 'Shortage', value: shortage === null ? '—' : `${shortage}%`, tone: shortage !== null && shortage > 0 ? 'loss' : undefined },
          { label: 'Sector supply', value: supplyUsd === null ? '—' : formatMoney(supplyUsd), hint: 'Annualised revenue of everyone in it' },
          { label: `Freight toll · ${regionLabel}`, value: tollPct === null ? '—' : `${tollPct}%`, tone: tollPct !== null && tollPct > 0 ? 'loss' : undefined },
        ]}
      />
      {tollCaption === null ? null : <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">{tollCaption}</p>}
    </TabCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  The world's own dials                                                      */
/* -------------------------------------------------------------------------- */

export interface WorldReadingsCardProps {
  readonly world: WorldState;
  /** The world before the last resolution, or null before the first one. */
  readonly previous: WorldState | null;
}

/**
 * Ten readings, folded away.
 *
 * They belong on World and nowhere else, and they are never the reason a
 * founder opened the tab — so the card states the one line that summarises them
 * and keeps the rest behind a 44-point control.
 */
export function WorldReadingsCard({ world, previous }: WorldReadingsCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="World readings"
      iconName="globe"
      subtitle="Rates, risk appetite, compute, regulation, the press."
      actions={
        <button type="button" className="btn btn-ghost tap-target gap-1 px-2" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide' : 'Show'}
          <Icon name="chevronDown" size={14} accent="current" className={open ? 'rotate-180' : undefined} />
        </button>
      }
    >
      {open ? (
        <WorldStrip world={world} previous={previous} />
      ) : (
        <p className="text-[11.5px] leading-relaxed text-ink-dim">
          Policy rate {formatPct(world.macro.policyRate)} · compute {formatPct(world.compute.acceleratorSupply)} of demand · listing window{' '}
          {formatPct(world.capitalMarkets.ipoWindow)}. Ten readings in full, and what each has done since the last resolution.
        </p>
      )}
    </Panel>
  );
}

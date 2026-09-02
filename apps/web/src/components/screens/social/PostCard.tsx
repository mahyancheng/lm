'use client';

/**
 * One published post, with what it actually did.
 *
 * Every number on this card is engine output from `EngagementResult`. The text
 * is the only part a model wrote, and every NPC-authored post carries the AI
 * label without exception (UI_SYSTEM §6).
 */

import type { Character, Sector, SocialAccount, SocialPost } from '@frontier/contracts';
import { formatMultiple, formatPct } from '@frontier/shared';
import { AiLabel, DeltaBadge, PersonChip, SectorBadge, Tag } from '@/components/ui';
import { audienceLabel, countLabel } from './audiences';

export interface PostCardProps {
  readonly post: SocialPost;
  readonly author: Character | null;
  readonly account: SocialAccount | null;
  /** Display name of the company the post is aimed at, when it names one. */
  readonly targetName: string | null;
  /**
   * The sector of the company the post names. With twenty-five companies a
   * name alone stops being enough context — "aimed at Qanat" reads very
   * differently once it says Energy beside it. Null in a single-sector world
   * and for a post that names nobody.
   */
  readonly targetSector?: Sector | null;
  readonly quarterLabelText: string;
}

export function PostCard({ post, author, account, targetName, targetSector = null, quarterLabelText }: PostCardProps): React.JSX.Element {
  const engagement = post.engagement;

  return (
    <article className="border-b border-hair px-3.5 py-3 last:border-b-0">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {author === null ? (
            <div className="text-[12px] font-medium text-ink">{account?.handle ?? 'Corporate account'}</div>
          ) : (
            <PersonChip
              character={author}
              size="sm"
              subtitle={account === null ? author.title : `${account.handle} · ${countLabel(account.followers)} followers`}
              right={post.isAiGenerated ? <AiLabel /> : null}
            />
          )}
        </div>
        <span className="figure shrink-0 text-[10px] text-ink-faint">{quarterLabelText}</span>
      </header>

      <p className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{post.text}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Tag tone="neutral">{post.intent}</Tag>
        {targetName === null ? null : <Tag tone="warn">aimed at {targetName}</Tag>}
        {targetSector === null ? null : <SectorBadge sector={targetSector} />}
        {engagement !== null && engagement.pressPickup ? <Tag tone="info">Press pickup</Tag> : null}
        {engagement !== null && engagement.viralityFactor > 4 ? <Tag tone="warn">Escaped its audience</Tag> : null}
      </div>

      {engagement === null ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          Queued. Reach and every consequence are computed in the social phase when the quarter resolves.
        </p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
            <Figure label="Reach" value={countLabel(engagement.reach)} />
            <Figure label="Engagement" value={formatPct(engagement.engagementScore)} />
            <Figure label="Virality" value={formatMultiple(engagement.viralityFactor)} />
            {engagement.competitorHostilityDelta === 0 ? null : (
              <div>
                <span className="label-caps-faint mr-1.5">Hostility</span>
                <DeltaBadge value={engagement.competitorHostilityDelta} format="number" invert bare />
              </div>
            )}
          </div>

          {engagement.sentimentShifts.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              {engagement.sentimentShifts.map((shift) => (
                <span
                  key={shift.audience}
                  className="inline-flex items-center gap-1 rounded-pill border border-hair bg-raised px-2 py-px text-[10px] text-ink-dim"
                >
                  {audienceLabel(shift.audience)}
                  <DeltaBadge value={shift.delta} format="number" bare arrow={false} />
                </span>
              ))}
            </div>
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

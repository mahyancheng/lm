'use client';

/**
 * The executive drawer — what a desk on the executive row opens.
 *
 * One person's context: the post they hold, the traits that decide every call
 * they make, and the standing they carry into a room. All of it is the player's
 * *own* leadership, read from `session.characters` filtered to this company, so
 * nothing here crosses the information boundary. A rival's executive is never
 * opened from this scene — the office draws only your floor.
 *
 * The conversation itself lives on Network; this drawer is the card, not the
 * chat.
 */

import Link from 'next/link';
import type { Character } from '@frontier/contracts';
import { formatMoney, formatScore } from '@frontier/shared';
import { Drawer, KeyValueGrid, Meter, PersonChip, SectionHeading, Tag } from '@/components/ui';

/** The five stable traits, in the order every surface shows them. */
const TRAITS = [
  { key: 'riskTolerance', label: 'Risk tolerance', blurb: 'Appetite for variance. High values take leveraged bets.' },
  { key: 'technicalOrientation', label: 'Technical judgement', blurb: 'High values weigh a claim on its merits, not its author.' },
  { key: 'financialConservatism', label: 'Financial conservatism', blurb: 'Attention to cash, dilution and downside.' },
  { key: 'aggressiveness', label: 'Aggressiveness', blurb: 'Willingness to attack, poach, litigate and escalate.' },
  { key: 'statusSensitivity', label: 'Status sensitivity', blurb: 'How long being embarrassed in public is remembered.' },
] as const;

export interface ExecutiveDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly character: Character | null;
  readonly isCeo: boolean;
}

export function ExecutiveDrawer({ open, onClose, character, isCeo }: ExecutiveDrawerProps): React.JSX.Element {
  return (
    <Drawer
      open={open && character !== null}
      onClose={onClose}
      title={character?.name ?? ''}
      subtitle={character?.title}
      footer={
        <Link className="btn btn-sm btn-primary" href="/network">
          Open in Network
        </Link>
      }
    >
      {character === null ? null : (
        <div className="flex flex-col gap-4">
          <PersonChip
            character={character}
            subtitle={character.title}
            right={
              isCeo ? (
                <Tag tone="brand" size="sm">
                  CEO
                </Tag>
              ) : character.isPlayer ? (
                <Tag tone="info" size="sm">
                  You
                </Tag>
              ) : undefined
            }
          />

          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Connection', value: formatScore(character.connectionLevel), hint: 'Institutional and social power, 0–100' },
              { label: 'Board seats', value: character.boardSeatCount },
              { label: 'Personal wealth', value: formatMoney(character.personalWealthUsd) },
              { label: 'Public following', value: formatScore(character.publicFollowing) },
            ]}
          />

          <div>
            <SectionHeading rule>Stable traits</SectionHeading>
            <div className="mt-2 space-y-3">
              {TRAITS.map((trait) => (
                <div key={trait.key}>
                  <Meter value={character.stableTraits[trait.key]} label={trait.label} />
                  <p className="mt-1 text-[10px] text-ink-faint">{trait.blurb}</p>
                </div>
              ))}
            </div>
          </div>

          {character.beliefs.length === 0 ? null : (
            <div>
              <SectionHeading rule>What they currently believe</SectionHeading>
              <div className="mt-2 space-y-1.5">
                {character.beliefs.slice(0, 6).map((belief) => (
                  <div key={belief.topic} className="raised-surface flex items-center justify-between gap-3 px-2.5 py-1.5">
                    <span className="min-w-0 truncate text-[11px] text-ink-dim">{belief.topic.replace(/_/g, ' ')}</span>
                    <Tag size="sm" tone={belief.level === 'high' ? 'brand' : belief.level === 'medium' ? 'info' : 'neutral'}>
                      {belief.level}
                    </Tag>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

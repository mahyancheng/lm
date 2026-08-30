'use client';

/**
 * Composing a post.
 *
 * The contract, from `social.ts`: **an LLM writes the post, the engine decides
 * what it does.** So this modal does three things in order — choose the room,
 * see who is in it, then write — and the model is optional at every step. With
 * no transport configured the player's own words are published verbatim, which
 * is the honest fallback: asking a model to invent a founder's voice is worse
 * than the founder's own sentence.
 *
 * The audience preview is composition and direction only. Reach depends on a
 * seeded draw inside the social phase, so no reach figure is shown before the
 * quarter resolves.
 */

import { useMemo, useState } from 'react';
import type {
  ActionValidationResult,
  Audience,
  Character,
  Company,
  NetworkArchetype,
  PostIntent,
  SocialAccount,
} from '@frontier/contracts';
import { NETWORK_ARCHETYPES, POST_INTENTS } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import { BarChart, Modal, SectionHeading, Tag, ValidationBanner, cx, type BarDatum } from '@/components/ui';
import { useGameActions } from '@/lib/game';
import { audienceLabel, intentProfile, networkFit, networkLabel, networkProfile, predictedAudiences } from './audiences';
import { requestSocialDraft } from './authorClient';

const MAX_POST_CHARS = 560;

export interface ComposeModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly founder: Character;
  readonly company: Company;
  readonly accounts: readonly SocialAccount[];
  /** Rivals the player may name, from the redacted projection. */
  readonly rivals: readonly Partial<Company>[];
  readonly sessionId: string;
  readonly quarter: number;
  readonly llmAvailable: boolean;
  /** Pre-select a network, e.g. the tab the player was reading. */
  readonly initialNetwork: NetworkArchetype;
}

type DraftSource = 'player' | 'author';

export function ComposeModal({
  open,
  onClose,
  founder,
  company,
  accounts,
  rivals,
  sessionId,
  quarter,
  llmAvailable,
  initialNetwork,
}: ComposeModalProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();

  const [network, setNetwork] = useState<NetworkArchetype>(initialNetwork);
  const [intent, setIntent] = useState<PostIntent>('announce');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState<DraftSource>('player');
  const [drafting, setDrafting] = useState(false);
  const [authorNote, setAuthorNote] = useState<string | null>(null);
  const [result, setResult] = useState<ActionValidationResult | null>(null);
  const [queued, setQueued] = useState(false);

  const accountFor = useMemo(() => {
    const map = new Map<NetworkArchetype, SocialAccount>();
    for (const account of accounts) {
      if (!account.isActive) continue;
      const owned = account.ownerCharacterId === founder.id || account.ownerCompanyId === company.id;
      if (!owned) continue;
      if (!map.has(account.network)) map.set(account.network, account);
    }
    return map;
  }, [accounts, founder.id, company.id]);

  const account = accountFor.get(network) ?? null;
  const rows = useMemo(() => predictedAudiences(account, network, intent), [account, network, intent]);
  const fit = networkFit(network, intent);
  const profile = intentProfile(intent);
  const platform = networkProfile(network);

  const trimmed = text.trim();
  const ready = trimmed.length > 0 && trimmed.length <= MAX_POST_CHARS;

  function buildIntent() {
    return {
      type: 'social_post' as const,
      draft: {
        authorCharacterId: founder.id,
        network,
        text: trimmed,
        intent,
        targetCompanyId: target === '' ? null : target,
      },
    };
  }

  function check(): void {
    if (!ready) return;
    setResult(validateIntent(buildIntent()));
  }

  async function draftWithAuthor(): Promise<void> {
    if (trimmed.length === 0) return;
    setDrafting(true);
    setAuthorNote(null);
    const shares = rows.filter((row) => row.share > 0).map((row) => ({ audience: row.audience as string, share: row.share }));
    const draft = await requestSocialDraft(
      {
        authorCharacterId: founder.id,
        authorBriefing: `${founder.name}, ${founder.title}. Connection level ${Math.round(founder.connectionLevel)}; ${Math.round(
          founder.publicFollowing,
        )} followers across networks. Runs ${company.name}, a ${company.archetype.replace(/_/g, ' ')} in ${company.sectorId.replace(/_/g, ' ')}.`,
        network,
        intent,
        situation: trimmed,
        audienceMix: shares,
        constraints: [
          'Do not state or imply any figure that has not been publicly disclosed.',
          'Do not announce an unreleased product or an unsigned contract.',
          'Do not predict a market outcome; state a position.',
        ],
      },
      { sessionId, quarter },
    );
    setDrafting(false);
    if (draft === null) {
      setAuthorNote('No draft came back. Your own words will be posted exactly as written.');
      return;
    }
    setText(draft.text);
    setSource('author');
    setAuthorNote('Drafted by the social author. Edit it freely — nothing is queued until you say so.');
    setResult(null);
  }

  function publish(): void {
    if (!ready) return;
    const outcome = queueAction(buildIntent());
    setResult(outcome.validation);
    setQueued(true);
  }

  function close(): void {
    setResult(null);
    setQueued(false);
    setAuthorNote(null);
    setSource('player');
    setText('');
    setTarget('');
    onClose();
  }

  const shareData: readonly BarDatum[] = rows
    .filter((row) => row.share > 0)
    .map((row) => ({
      label: audienceLabel(row.audience),
      value: row.share,
      tone: row.effect > 0 ? 'gain' : row.effect < 0 ? 'loss' : 'brand',
      caption: row.effect === 0 ? 'no sentiment effect' : `${row.effect > 0 ? '+' : ''}${row.effect} points at reference reach`,
    }));

  return (
    <Modal
      open={open}
      onClose={close}
      title="Compose a post"
      subtitle="You choose the room, the intent and the words. The engine computes everything that follows."
      width="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {queued ? 'Done' : 'Cancel'}
          </button>
          <button type="button" className="btn" onClick={check} disabled={!ready}>
            Check
          </button>
          <button type="button" className="btn btn-primary" onClick={publish} disabled={!ready || queued}>
            {queued ? 'Queued' : 'Queue the post'}
          </button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        {/* --- the post ------------------------------------------------------ */}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label-caps-faint">Network</span>
              <select
                className="field mt-1"
                value={network}
                onChange={(event) => {
                  setNetwork(event.target.value as NetworkArchetype);
                  setResult(null);
                  setQueued(false);
                }}
              >
                {NETWORK_ARCHETYPES.map((option) => (
                  <option key={option} value={option}>
                    {networkLabel(option)}
                    {accountFor.has(option) ? '' : ' — no account'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label-caps-faint">Intent</span>
              <select
                className="field mt-1"
                value={intent}
                onChange={(event) => {
                  setIntent(event.target.value as PostIntent);
                  setResult(null);
                  setQueued(false);
                }}
              >
                {POST_INTENTS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="label-caps-faint">Aimed at</span>
            <select
              className="field mt-1"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setResult(null);
                setQueued(false);
              }}
            >
              <option value="">No specific rival</option>
              {rivals.map((rival) =>
                rival.id === undefined ? null : (
                  <option key={rival.id} value={rival.id}>
                    {rival.name ?? rival.id}
                  </option>
                ),
              )}
            </select>
          </label>

          <label className="block">
            <span className="label-caps-faint">The post</span>
            <textarea
              className="field mt-1"
              rows={6}
              maxLength={MAX_POST_CHARS}
              value={text}
              placeholder="Say something you would stand behind in a deposition."
              onChange={(event) => {
                setText(event.target.value);
                setSource('player');
                setResult(null);
                setQueued(false);
              }}
            />
            <span className="mt-1 flex items-center justify-between text-[10px] text-ink-faint">
              <span>
                {source === 'author' ? 'Drafted by the social author, edited by you' : 'Your own words'} · posted as{' '}
                {account?.handle ?? 'no account on this network'}
              </span>
              <span className="figure">
                {trimmed.length} / {MAX_POST_CHARS}
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-sm" onClick={() => void draftWithAuthor()} disabled={drafting || trimmed.length === 0}>
              {drafting ? 'Drafting…' : 'Draft with the social author'}
            </button>
            {!llmAvailable ? (
              <span className="text-[10px] text-ink-faint">
                No model configured — this will return nothing and your text is published unchanged.
              </span>
            ) : null}
          </div>

          {authorNote === null ? null : (
            <p className="rounded-[4px] border border-hair bg-raised px-3 py-2 text-[11px] text-ink-dim">{authorNote}</p>
          )}

          <ValidationBanner result={result} />
        </div>

        {/* --- who hears it -------------------------------------------------- */}
        <div className="flex flex-col gap-3">
          <SectionHeading rule>Who will hear this</SectionHeading>
          {shareData.length === 0 ? (
            <p className="text-[11px] text-ink-faint">This network reaches nobody for this account.</p>
          ) : (
            <BarChart data={shareData} formatValue={(value) => formatPct(value, 0)} max={1} />
          )}

          <div className="raised-surface px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag tone={fit >= 0.8 ? 'gain' : fit >= 0.5 ? 'info' : 'warn'}>fit {formatPct(fit, 0)}</Tag>
              <Tag tone={profile.virality >= 1.4 ? 'warn' : 'neutral'}>virality {profile.virality.toFixed(2)}x</Tag>
              <Tag tone={profile.pressBias >= 0.35 ? 'warn' : 'neutral'}>press bias {formatPct(profile.pressBias, 0)}</Tag>
              {profile.hostility > 0 ? <Tag tone="loss">hostility +{profile.hostility}</Tag> : null}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              {networkLabel(network)} resharing multiplier {platform.virality.toFixed(2)}x, press affinity {formatPct(platform.pressAffinity, 0)}.
              Attention is not approval: an attack travels furthest and costs the most with the audiences that matter.
            </p>
          </div>

          <div className="raised-surface px-3 py-2.5">
            <div className="label-caps-faint mb-1.5">Sentiment direction at reference reach</div>
            <ul className="flex flex-col gap-1">
              {rows
                .filter((row) => row.effect !== 0)
                .map((row) => (
                  <li key={row.audience} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-ink-dim">{audienceLabel(row.audience)}</span>
                    <span className={cx('figure', row.effect > 0 ? 'tone-gain' : 'tone-loss')}>
                      {row.effect > 0 ? '+' : ''}
                      {row.effect}
                    </span>
                  </li>
                ))}
              {rows.every((row) => row.effect === 0) ? <li className="text-[11px] text-ink-faint">This intent moves nobody by itself.</li> : null}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              Points, not percentages, and scaled by the reach the engine actually computes. No reach figure is shown here because it is
              drawn inside the social phase.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Exported for the page's audience legend, so both use one vocabulary. */
export function audienceOrder(): readonly Audience[] {
  return ['developers', 'enterprise', 'consumers', 'investors', 'regulators', 'media', 'talent'];
}

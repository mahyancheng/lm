'use client';

/**
 * The Chief of Staff, on every screen.
 *
 * The role used to live on one screen, which meant the founder had to leave
 * whatever they were looking at to ask about it — and then explain which screen
 * they had been on. The dock fixes both: a floating button within thumb reach
 * above the tab bar, and a drawer carrying the same thread, the same
 * interpretation cards and the same approval rules as the dedicated screen.
 *
 * Two things make it a *contextual* assistant rather than a chat window that
 * follows you around:
 *
 * - the quick prompts are the current screen's own ("explain these numbers",
 *   "should we raise?"), and
 * - the route the founder asked from is sent with the message, so "this screen"
 *   resolves to something.
 *
 * **Nothing here shortens the path to a binding action.** Approving is still
 * per-row on the interpretation card, the fourteen still take their own
 * explicit confirmation, and the engine validates every one of them again on
 * submission. Being reachable from everywhere is a change to how a founder
 * asks, not to what a model may do.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { formatMoney } from '@frontier/shared';
import { AiLabel, Drawer, Icon, Tag, cx, type Tone } from '@/components/ui';
import { CHIEF_OF_STAFF, Portrait, SpeechCard } from '@/components/scenes/people';
import { Exchange } from '@/components/screens/chief-of-staff/Exchange';
import { quickPromptsFor, screenLabelFor } from '@/components/screens/chief-of-staff/quickPrompts';
import { sourcingLabel } from '@/components/screens/chief-of-staff/findings';
import { useChiefOfStaff } from '@/components/screens/chief-of-staff/useChiefOfStaff';
import { llmHealth, type LlmHealth } from '@/lib/llm/client';
import { describeLlmStatus, type LlmStatusKind } from '@/lib/llm/status';
import { openSettings } from './settingsBus';
import { useActiveCompany, useLlm, usePlayerCharacter, useQueuedActions, useResolving, useSession } from '@/lib/game';

/** The dedicated screen owns the thread already; the dock would be a second copy of it. */
const OWN_SCREEN = '/chief-of-staff';

/** How often the drawer re-polls health while it is open, to keep the queue estimate honest while a quarter resolves. */
const LIVE_HEALTH_POLL_MS = 4_000;

const STATUS_TONE: Readonly<Record<LlmStatusKind, Tone>> = {
  ready: 'gain',
  no_credential: 'neutral',
  offline_demo: 'neutral',
  busy: 'warn',
  timeout: 'loss',
  network_error: 'loss',
  aborted: 'neutral',
};

export function ChiefOfStaffDock(): React.JSX.Element | null {
  const pathname = usePathname();
  const session = useSession();
  const company = useActiveCompany();
  const founder = usePlayerCharacter();
  const llm = useLlm();
  const queue = useQueuedActions();
  const { resolving } = useResolving();
  const thread = useChiefOfStaff();

  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [liveHealth, setLiveHealth] = useState<LlmHealth>(llm);
  const bottom = useRef<HTMLDivElement | null>(null);

  const prompts = useMemo(() => quickPromptsFor(pathname), [pathname]);
  const screenLabel = screenLabelFor(pathname);

  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open, thread.entries.length, thread.sending]);

  // Refresh independently of the store's own one-shot health check while the
  // drawer is open, so "3 calls ahead" is still true a minute into a quarter's
  // resolution rather than a snapshot from whenever the tab first loaded.
  useEffect(() => {
    setLiveHealth(llm);
  }, [llm]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = (): void => {
      void llmHealth().then((health) => {
        if (!cancelled) setLiveHealth(health);
      });
    };
    poll();
    const id = setInterval(poll, LIVE_HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open]);

  // The most recent exchange's own failure, while nothing new is in flight —
  // "the model just timed out on you" outranks a generic queue estimate, but
  // only until the founder asks again, at which point `sending` takes over.
  const latestEntry = thread.entries[thread.entries.length - 1];
  const lastFailure = thread.sending ? undefined : latestEntry?.failureReason;
  const status = describeLlmStatus({ health: liveHealth, lastFailure });

  // Its own screen has the full-height thread; a second one over the top of it
  // would be the same conversation twice. Resolving owns the whole viewport.
  if (pathname.startsWith(OWN_SCREEN) || resolving) return null;

  async function ask(text: string): Promise<void> {
    setMessage('');
    await thread.send(text, pathname);
  }

  return (
    <>
      {/* --- the button --------------------------------------------------
          Bottom-left on a phone: the action-queue tray owns the right corner
          whenever anything is queued, and two floating controls a thumb needs
          must not overlap. Lifted clear of the tab bar and its safe-area
          inset, so it sits in the reach zone rather than under the home bar. */}
      {open ? null : (
        <button
          type="button"
          className="press-pop fixed left-3 z-30 flex items-center gap-2 rounded-pill border border-hair bg-panel px-3 py-2 shadow-float lg:left-4 lg:bottom-4"
          style={{ bottom: 'calc(var(--bottombar-height) + env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
          onClick={() => setOpen(true)}
          aria-label={`Ask the Chief of Staff about ${screenLabel}`}
        >
          <Portrait
            characterId={CHIEF_OF_STAFF.id}
            role={CHIEF_OF_STAFF.role}
            size="sm"
            idle
            decorative
            {...(llm.available ? { ring: 'brand' as const } : {})}
          />
          <span className="text-[12px] font-semibold text-ink">Ask</span>
          {thread.entries.length > 0 ? <span className="figure text-[11px] text-ink-faint">{thread.entries.length}</span> : null}
        </button>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Chief of Staff"
        subtitle={`Speaking for ${company.name} · asking about ${screenLabel} · nothing here executes`}
        width={460}
      >
        <div className="flex min-h-0 flex-col gap-3">
          {/* --- what it is reading, in one line --------------------------- */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone="neutral">{formatMoney(company.financials.cash)} cash</Tag>
            <Tag tone={company.financials.quarterlyBurn < 0 ? 'loss' : 'gain'}>
              {formatMoney(company.financials.quarterlyBurn)} a quarter
            </Tag>
            {queue.length > 0 ? <Tag tone="brand" dot>{`${queue.length} queued`}</Tag> : null}
            {status.kind === 'ready' ? (
              <Tag tone="gain" dot>{`Live · ${liveHealth.model ?? liveHealth.transportKind}`}</Tag>
            ) : status.kind === 'no_credential' || status.kind === 'offline_demo' ? (
              <button type="button" className="press-pop tap-target flex items-center rounded-pill" onClick={() => openSettings('ai')} title={status.action ?? undefined}>
                <Tag tone={STATUS_TONE[status.kind]} dot>
                  {status.sentence}
                </Tag>
              </button>
            ) : (
              <Tag tone={STATUS_TONE[status.kind]} dot title={status.action ?? undefined}>
                {status.sentence}
              </Tag>
            )}
          </div>
          {status.action !== null && status.kind !== 'ready' && status.kind !== 'no_credential' && status.kind !== 'offline_demo' ? (
            <p className="-mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">{status.action}</p>
          ) : null}

          {/* --- the thread ------------------------------------------------ */}
          <div className="flex min-h-[30dvh] flex-col gap-3">
            {thread.entries.length === 0 ? (
              <div className="flex items-start gap-2">
                <Portrait characterId={CHIEF_OF_STAFF.id} name={CHIEF_OF_STAFF.name} role={CHIEF_OF_STAFF.role} size="md" idle mood="content" ring="brand" className="mt-1" />
                <SpeechCard
                  className="min-w-0 flex-1"
                  bodyClassName="px-3 py-2.5"
                  speaker={
                    <>
                      <span className="text-[12px] font-semibold text-ink">{CHIEF_OF_STAFF.name}</span>
                      <AiLabel />
                    </>
                  }
                >
                  <p className="text-[12.5px] leading-relaxed text-ink-dim">
                    Ask me anything about {screenLabel}. I read your company in full, including what the engine would and would not let you do
                    right now — so if something is not possible I will say so rather than propose it.
                  </p>
                </SpeechCard>
              </div>
            ) : (
              thread.entries
                .slice(-6)
                .map((entry) => <Exchange key={entry.id} entry={entry} founder={founder} startYear={session.startYear} dense />)
            )}

            {thread.sending ? (
              <div className="flex items-center gap-1.5 px-1">
                <span className="animate-pulse-soft size-1.5 rounded-pill bg-brand" />
                <span className="animate-pulse-soft stagger-2 size-1.5 rounded-pill bg-brand" />
                <span className="animate-pulse-soft stagger-4 size-1.5 rounded-pill bg-brand" />
                <span className="ml-1 text-[11px] text-ink-faint">
                  {thread.sourcing !== null
                    ? `Sourcing… (${sourcingLabel(thread.sourcing)})`
                    : thread.cancellable
                      ? `Asking the model · thinking ${thread.elapsedSeconds}s`
                      : 'Reading it against your briefing…'}
                </span>
                {thread.cancellable ? (
                  <button
                    type="button"
                    className="press-pop tap-target ml-auto flex items-center gap-1 rounded-pill border border-hair bg-panel px-2 py-0.5 text-[10.5px] font-semibold text-ink-dim hover:border-hair-strong hover:text-ink"
                    onClick={() => thread.cancel()}
                  >
                    <Icon name="close" size={12} accent="inherit" />
                    Cancel
                  </button>
                ) : null}
              </div>
            ) : null}

            <div ref={bottom} />
          </div>

          {/* --- the screen's own questions -------------------------------- */}
          <ul className="flex flex-col gap-1.5">
            {prompts.map((prompt) => (
              <li key={prompt.label}>
                <button
                  type="button"
                  className={cx(
                    'icon-knockout-panel flex min-h-11 w-full items-center gap-2 rounded-chip border border-hair bg-panel px-3 py-2 text-left text-[12px] leading-snug text-ink-dim press-pop',
                    'hover:border-hair-strong hover:text-ink',
                  )}
                  disabled={thread.sending}
                  onClick={() => void ask(prompt.send)}
                >
                  <Icon name="chat" size={16} accent="inherit" className="text-ink-faint" />
                  <span className="min-w-0 flex-1">{prompt.label}</span>
                </button>
              </li>
            ))}
          </ul>

          {/* --- the composer ---------------------------------------------- */}
          <div className="flex items-end gap-2">
            <textarea
              className="field min-w-0 flex-1"
              rows={2}
              maxLength={1200}
              value={message}
              placeholder={`Ask about ${screenLabel}, or tell me what to change.`}
              disabled={thread.sending}
              aria-label="Your question"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void ask(message);
              }}
            />
            <button
              type="button"
              className="btn btn-primary tap-target press-pop shrink-0"
              disabled={thread.sending || message.trim().length === 0}
              onClick={() => void ask(message)}
            >
              <Icon name="chevronRight" size={16} accent="current" />
              Ask
            </button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-ink-faint">
            Interpreted by a model, validated by the engine, approved by you. No binding action is submitted from this drawer.
          </p>
        </div>
      </Drawer>
    </>
  );
}

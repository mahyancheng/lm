'use client';

/**
 * Chief of Staff — the conversational control surface.
 *
 * It is a terminal, not a chatbot. The player types freely because typing is
 * faster than finding a control; what comes back is a *diff* — typed
 * `ActionIntent`s with the validator's verdict already attached — and the
 * mandatory line "No binding action has been submitted yet." sits above the
 * controls that queue them.
 *
 * **No free text ever executes.** The three steps are interpret → propose →
 * confirm, in that order, and the fourteen always take an explicit human
 * confirmation regardless of what the model set `requiresConfirmation` to. With
 * no model configured the panel says so and echoes the instruction back as a
 * question, because asking beats guessing and inventing a decision on a
 * founder's behalf is the one thing this screen must never do.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { quarterLabel } from '@frontier/contracts';
import { formatCount, formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import { AiLabel, Drawer, Icon, KeyValueGrid, PageHeader, Panel, SectionHeading, Tag, type IconName } from '@/components/ui';
import { CHIEF_OF_STAFF, Portrait, SpeechCard } from '@/components/scenes/people';
import { ROUTE_OF_ACTION } from '@/components/screens/chief-of-staff/InterpretationCard';
import { Exchange } from '@/components/screens/chief-of-staff/Exchange';
import { sourcingLabel } from '@/components/screens/chief-of-staff/findings';
import { useChiefOfStaff } from '@/components/screens/chief-of-staff/useChiefOfStaff';
import { openSettings } from '@/components/shell/settingsBus';
import {
  buildChiefOfStaffDossier,
  currentBudgets,
  openDecisions,
  useGame,
  useLlm,
  usePlayerCharacter,
  usePlayerCompany,
  useQueuedActions,
  useResolving,
  useSession,
  useSettings,
} from '@/lib/game';

/** Instructions that exercise different parts of the action union. */
const EXAMPLES: readonly string[] = [
  'Move half of consumer marketing into enterprise sales and keep total spend flat.',
  'Hire six researchers at top of market and set the research budget to match.',
  'Reserve four thousand accelerators for four quarters if we can get them under three thousand a unit.',
  'Ask Eleanor Vance to introduce me to Nadia Okafor about sovereign capital.',
];

const MANUAL_TICKETS: readonly { readonly href: string; readonly label: string; readonly icon: IconName; readonly blurb: string }[] = [
  { href: '/capital', label: 'Capital', icon: 'coins', blurb: 'Raise, borrow, buy back, list' },
  { href: '/people', label: 'People', icon: 'people', blurb: 'Hire, cut, poach, appoint' },
  { href: '/research', label: 'Research', icon: 'flask', blurb: 'Budgets, programmes, publication' },
  { href: '/products', label: 'Products', icon: 'box', blurb: 'Price, launch, retire' },
  { href: '/government', label: 'Government', icon: 'capitol', blurb: 'Bid, decline, form a consortium' },
  { href: '/deal-room', label: 'Deal Room', icon: 'handshake', blurb: 'Propose, accept, acquire' },
];

export default function ChiefOfStaffPage(): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const llm = useLlm();
  const settings = useSettings();
  const queue = useQueuedActions();
  const { resolving } = useResolving();

  const { lastOutcome } = useGame();
  const thread = useChiefOfStaff();
  const { entries, sending } = thread;
  const [message, setMessage] = useState('');
  // Phone only: everything the seat is reading, in a bottom sheet. From `lg`
  // the same content is the right rail and the button that opens it is gone.
  const [briefingOpen, setBriefingOpen] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, sending]);

  const budgets = useMemo(() => currentBudgets(company), [company]);
  const decisions = useMemo(() => openDecisions(session, company), [session, company]);

  // Exactly what the model is handed, built by the same function the request
  // uses. Showing it is the point: a founder who cannot see what their chief of
  // staff knows cannot tell a gap in its knowledge from a gap in its judgement.
  const dossier = useMemo(() => buildChiefOfStaffDossier(session, lastOutcome?.events ?? []), [session, lastOutcome]);
  const openActions = useMemo(() => dossier.availableActions.filter((entry) => entry.available), [dossier]);
  const blockedActions = useMemo(() => dossier.availableActions.filter((entry) => !entry.available), [dossier]);

  // The floating action-queue tray owns the bottom-right corner of a phone
  // whenever something is queued. The composer lifts above it rather than
  // sitting under it — two things a thumb needs must not overlap.
  const trayLifted = queue.length > 0 && !resolving;

  async function send(): Promise<void> {
    const text = message.trim();
    if (text.length === 0 || sending) return;
    setMessage('');
    await thread.send(text);
  }

  /** Who is talking, on every card the Chief of Staff owns. Model-authored, so labelled. */
  const chiefSpeaker = (
    <>
      <span className="text-[12px] font-semibold text-ink">{CHIEF_OF_STAFF.name}</span>
      <span className="text-[10px] text-ink-faint">{CHIEF_OF_STAFF.title}</span>
      <AiLabel />
    </>
  );

  /**
   * What the seat is reading, and what it has produced.
   *
   * One definition, two placements: the right rail from `lg`, and a bottom
   * sheet under it. It is rendered once at a time — `Drawer` returns null while
   * closed — so nothing is duplicated in the document.
   */
  const briefing = (
    <>
      <Panel title="What it sees" subtitle="Your own company in full, and nothing private about anyone else" iconName="briefcase" iconTone="brand">
        <KeyValueGrid
          columns={1}
          items={[
            { label: 'Cash', value: formatMoney(company.financials.cash) },
            { label: 'Quarterly revenue', value: formatMoney(company.financials.revenueQuarterly) },
            { label: 'Net cash movement', value: formatMoney(company.financials.quarterlyBurn), tone: company.financials.quarterlyBurn < 0 ? 'loss' : 'gain' },
            { label: 'Posture', value: company.posture.replace(/_/g, ' '), mono: false },
            { label: 'Auto-execute routine', value: settings.autoExecuteRoutine ? 'On' : 'Off', mono: false },
          ]}
        />
        <SectionHeading className="mt-3" rule>
          Budget lines
        </SectionHeading>
        <ul className="mt-1.5 flex flex-col gap-1">
          {budgets.map((line) => (
            <li key={line.label} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="text-ink-dim">{line.label}</span>
              <span className="figure text-ink">{formatMoney(line.amountUsd)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
          These are the lines that make “keep total spend roughly unchanged” an arithmetic instruction rather than a wish.
        </p>
      </Panel>

      {/* --- what it can actually do --------------------------------------
          The list the model is given, verbatim. It is produced by probing the
          engine's own validator, so an action shown here as unavailable is one
          the engine would refuse today — not a guess, and not a policy written
          alongside the rules that could drift from them. */}
      <Panel
        title="What it can do for you"
        subtitle="Probed from the engine's validator, this quarter, for this company"
        iconName="ledger"
        iconTone="brand"
      >
        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Open to us', value: formatCount(openActions.length) },
            { label: 'Not possible', value: formatCount(blockedActions.length) },
            { label: 'Runway', value: formatQuarterCount(dossier.finances.runwayQuarters) },
            { label: 'Gross margin', value: formatPct(dossier.finances.grossMarginPct) },
          ]}
        />
        <SectionHeading className="mt-3" rule>
          Not possible right now
        </SectionHeading>
        {blockedActions.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-ink-faint">Every action in the game is open to this company this quarter.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {blockedActions.slice(0, 6).map((action) => (
              <li key={action.type} className="text-[11.5px] leading-relaxed">
                <span className="font-semibold text-ink">{action.type.replace(/_/g, ' ')}</span>
                <span className="block text-ink-faint">{action.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
          It is told these reasons in your own words, so &ldquo;can we buy them?&rdquo; gets an answer rather than a proposal the engine would
          refuse a second later.
        </p>
      </Panel>

      <Panel title="Open decisions" subtitle="Everything waiting on you this quarter" iconName="bell" iconTone={decisions.length === 0 ? 'neutral' : 'warn'}>
        {decisions.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Nothing is waiting on you. The quarter is yours to shape.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-ink-dim">
            {decisions.map((decision, index) => (
              <li key={index}>{decision}</li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Do it by hand" subtitle="The click path and the conversation produce the same objects" iconName="desk" iconTone="info">
        <ul className="flex flex-col gap-0.5">
          {MANUAL_TICKETS.map((ticket) => (
            <li key={ticket.href}>
              <Link
                href={ticket.href}
                className="icon-knockout-panel flex min-h-11 items-center gap-2.5 rounded-chip px-1.5 py-1 text-ink hover:bg-raised hover:text-brand"
                onClick={() => setBriefingOpen(false)}
              >
                <Icon name={ticket.icon} size={17} accent="inherit" className="text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold">{ticket.label}</span>
                  <span className="block truncate text-[10.5px] text-ink-faint">{ticket.blurb}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
          Either path can finish what the other started. Every row on an interpretation links to the screen that owns it, at{' '}
          <span className="figure">{ROUTE_OF_ACTION.raise_round}</span> and the rest.
        </p>
      </Panel>

      <Panel title="Queued this quarter" subtitle="What End Quarter will be asked to lock" iconName="stamp" iconTone={queue.length === 0 ? 'neutral' : 'brand'}>
        {queue.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Nothing queued yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {queue.map((item) => (
              <li key={item.action.actionId} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-ink-dim">{item.action.intent.type.replace(/_/g, ' ')}</span>
                <Tag tone={item.blocked ? 'warn' : item.validation.status === 'rejected' ? 'loss' : 'gain'} dot>
                  {item.blocked ? 'needs you' : item.validation.status}
                </Tag>
              </li>
            ))}
          </ul>
        )}
        <Link href="/end-quarter" className="btn tap-target mt-2.5 w-full" onClick={() => setBriefingOpen(false)}>
          <Icon name="stamp" size={16} />
          Review and submit
        </Link>
      </Panel>
    </>
  );

  return (
    <>
      <PageHeader
        title="Chief of Staff"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Say what you want in your own words. What comes back is a proposal with the validator's answer already on it — nothing here executes."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {llm.available ? (
              <Tag tone="gain" dot>{`Live · ${llm.model ?? llm.transportKind}`}</Tag>
            ) : (
              // Offline is a state the player can leave, so this says how.
              <button
                type="button"
                className="press-pop tap-target flex items-center rounded-pill px-1"
                onClick={() => openSettings('ai')}
                title="Connect a Claude token in Settings"
              >
                <Tag tone="neutral" dot>
                  Deterministic fallback
                </Tag>
              </button>
            )}
            {/* The briefing is the right rail on a desk and a sheet on a phone. */}
            <button type="button" className="btn tap-target press-pop lg:hidden" onClick={() => setBriefingOpen(true)}>
              <Icon name="briefcase" size={16} />
              Briefing
              {queue.length > 0 ? <span className="figure text-brand">{queue.length}</span> : null}
            </button>
            <button type="button" className="btn tap-target" disabled={entries.length === 0} onClick={() => thread.clear()}>
              <Icon name="close" size={15} />
              <span className="hidden sm:inline">Clear conversation</span>
              <span className="sm:hidden">Clear</span>
            </button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- the conversation ---------------------------------------------- */}
        {/* On a phone the transcript IS the screen: it fills the viewport, the
            composer is pinned under it, and the briefing is one tap away. */}
        <div className="flex min-h-[46dvh] min-w-0 flex-col gap-4 lg:col-span-2">
          {entries.length === 0 ? (
            <div className="flex items-start gap-2.5">
              <Portrait
                characterId={CHIEF_OF_STAFF.id}
                name={CHIEF_OF_STAFF.name}
                role={CHIEF_OF_STAFF.role}
                size="lg"
                idle
                mood="content"
                ring="brand"
                className="mt-1"
              />
              <SpeechCard className="min-w-0 flex-1" bodyClassName="px-3 py-3" speaker={chiefSpeaker}>
                <p className="text-[13px] leading-relaxed text-ink-dim">
                  Tell me what you want in your own words. I read it against your company briefing, the world briefing, your current budget
                  lines and every decision open this quarter, and hand it back as typed actions with the validator&rsquo;s answer already on
                  them. You approve them one at a time — <span className="font-semibold text-ink">I never submit anything myself</span>.
                </p>
                {/* Full-width rows, not chips: a phone cannot fit four
                    sentence-length labels side by side, and each is a target. */}
                <ul className="mt-3 flex flex-col gap-1.5">
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        className="icon-knockout-panel flex min-h-11 w-full items-center gap-2 rounded-chip border border-hair bg-panel px-3 py-2 text-left text-[12px] leading-snug text-ink-dim press-pop hover:border-hair-strong hover:text-ink"
                        onClick={() => setMessage(example)}
                      >
                        <Icon name="chat" size={16} accent="inherit" className="text-ink-faint" />
                        <span className="min-w-0 flex-1">{example}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </SpeechCard>
            </div>
          ) : (
            entries.map((entry) => <Exchange key={entry.id} entry={entry} founder={founder} startYear={session.startYear} />)
          )}

          {/* The wait is a person reading, not a spinner. */}
          {sending ? (
            <div className="flex items-start gap-2.5">
              <Portrait
                characterId={CHIEF_OF_STAFF.id}
                name={CHIEF_OF_STAFF.name}
                role={CHIEF_OF_STAFF.role}
                size="lg"
                idle
                mood="neutral"
                ring="brand"
                className="mt-1"
              />
              <SpeechCard className="min-w-0 flex-1" bodyClassName="px-3 py-2.5" speaker={chiefSpeaker}>
                <div className="flex items-center gap-1.5">
                  <span className="animate-pulse-soft size-1.5 rounded-pill bg-brand" />
                  <span className="animate-pulse-soft stagger-2 size-1.5 rounded-pill bg-brand" />
                  <span className="animate-pulse-soft stagger-4 size-1.5 rounded-pill bg-brand" />
                  <span className="ml-1 text-[11px] text-ink-faint">
                    {thread.sourcing === null
                      ? 'Reading it against your briefing and the world…'
                      : `Sourcing… (${sourcingLabel(thread.sourcing)})`}
                  </span>
                </div>
              </SpeechCard>
            </div>
          ) : null}

          {/* The reveal target keeps clear of the pinned composer. */}
          <div ref={bottom} className="scroll-mb-[168px] lg:scroll-mb-0" />

          {/* --- the composer ------------------------------------------------
              Pinned above the phone's tab bar and lifted clear of the floating
              action queue while that is on screen. The offset adds the home
              indicator's inset to the bar's own height, so the composer clears
              both. From `lg` it is an ordinary card at the foot of the column. */}
          <div
            className="sticky z-10 -mx-3 mt-auto border-t border-hair bg-base/95 px-3 pt-2.5 pb-3 backdrop-blur sm:-mx-5 sm:px-5 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:pb-0 lg:backdrop-blur-none"
            style={{ bottom: 'calc(var(--bottombar-height) + env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="panel-surface p-3 shadow-float lg:p-4 lg:shadow-card">
              <div className="flex items-start gap-2.5">
                {/* The wrapper carries the visibility: the people stylesheet
                    sets `display` on the portrait itself and would win. */}
                <span className="mt-1 hidden shrink-0 sm:block">
                  <Portrait characterId={founder.id} name={founder.name} role={founder.role} size="md" isPlayer />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-end gap-2">
                    <textarea
                      className="field min-w-0 flex-1"
                      rows={2}
                      maxLength={1200}
                      value={message}
                      placeholder="Cut consumer marketing to six million and move the rest into enterprise sales."
                      disabled={sending}
                      aria-label="Your instruction"
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary tap-target press-pop shrink-0"
                      disabled={sending || message.trim().length === 0}
                      onClick={() => void send()}
                    >
                      <Icon name="chevronRight" size={16} accent="current" />
                      {sending ? 'Reading…' : 'Interpret'}
                    </button>
                  </div>
                  {llm.available ? (
                    <p className="mt-2 text-[10.5px] text-ink-faint">Interpreted by a model, validated by the engine, approved by you.</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-faint">
                        No model configured: the instruction is echoed back as a question and nothing is translated.
                      </span>
                      <button type="button" className="btn btn-sm tap-target shrink-0" onClick={() => openSettings('ai')}>
                        <Icon name="settings" size={15} />
                        Connect Claude
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* The floating action queue sits in this corner while anything is
                queued. The bar grows under the composer rather than moving it,
                so the tray floats over the bar's own surface and never over a
                control. */}
            {trayLifted ? <div className="h-14 lg:hidden" aria-hidden="true" /> : null}
          </div>

          {/* The scroll region pads its foot by more than the composer's own
              offset, so without this the composer would come to rest a little
              above the tab bar at the end of the conversation. Twenty pixels
              plus the column's own gap is exactly that difference. */}
          <div className="h-5 lg:hidden" aria-hidden="true" />
        </div>

        {/* --- what it is reading -------------------------------------------- */}
        <div className="hidden flex-col gap-4 lg:flex">{briefing}</div>
      </div>

      <Drawer
        open={briefingOpen}
        onClose={() => setBriefingOpen(false)}
        title="Briefing"
        subtitle="What the Chief of Staff is reading, and what you have queued"
        width={460}
      >
        <div className="flex flex-col gap-4">{briefing}</div>
      </Drawer>
    </>
  );
}

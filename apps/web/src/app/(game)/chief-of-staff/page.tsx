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
 * confirm, in that order, and the thirteen always take an explicit human
 * confirmation regardless of what the model set `requiresConfirmation` to. With
 * no model configured the panel says so and echoes the instruction back as a
 * question, because asking beats guessing and inventing a decision on a
 * founder's behalf is the one thing this screen must never do.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { EmptyState, KeyValueGrid, PageHeader, Panel, SectionHeading, Tag } from '@/components/ui';
import { InterpretationCard, ROUTE_OF_ACTION } from '@/components/screens/chief-of-staff/InterpretationCard';
import {
  appendTranscript,
  clearTranscript,
  echoFallback,
  historyOf,
  readTranscript,
  type TranscriptEntry,
} from '@/components/screens/chief-of-staff/transcript';
import { requestChiefOfStaff } from '@/lib/llm/client';
import {
  PLAYER_ID,
  buildChiefOfStaffInput,
  currentBudgets,
  openDecisions,
  useLlm,
  usePlayerCompany,
  useQueuedActions,
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

const MANUAL_TICKETS: readonly { readonly href: string; readonly label: string; readonly blurb: string }[] = [
  { href: '/capital', label: 'Capital', blurb: 'Raise, borrow, buy back, list' },
  { href: '/people', label: 'People', blurb: 'Hire, cut, poach, appoint' },
  { href: '/research', label: 'Research', blurb: 'Budgets, programmes, publication' },
  { href: '/products', label: 'Products', blurb: 'Price, launch, retire' },
  { href: '/government', label: 'Government', blurb: 'Bid, decline, form a consortium' },
  { href: '/deal-room', label: 'Deal Room', blurb: 'Propose, accept, acquire' },
];

export default function ChiefOfStaffPage(): React.JSX.Element {
  const session = useSession();
  const company = usePlayerCompany();
  const llm = useLlm();
  const settings = useSettings();
  const queue = useQueuedActions();

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  // The transcript lives in the tab, not in game state: hydrate after mount so
  // the server render and the first client render agree.
  useEffect(() => {
    setEntries(readTranscript(session.sessionId));
  }, [session.sessionId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length]);

  const budgets = useMemo(() => currentBudgets(company), [company]);
  const decisions = useMemo(() => openDecisions(session, company), [session, company]);

  async function send(): Promise<void> {
    const text = message.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setMessage('');

    const history = historyOf(entries);
    const input = buildChiefOfStaffInput(session, text, history);
    let interpretation = null;
    try {
      // The key names the seat, not just the session: one shared key would
      // resume one Claude thread for every player in the session, and this
      // prompt carries the player's whole private company briefing.
      interpretation = await requestChiefOfStaff(input, {
        sessionId: session.sessionId,
        playerId: PLAYER_ID,
        conversationId: 'main',
      });
    } catch {
      interpretation = null;
    }

    const entry: TranscriptEntry = {
      id: `${session.sessionId}:q${session.quarter}:${entries.length}`,
      quarter: session.quarter,
      message: text,
      interpretation: interpretation ?? echoFallback(text),
      fallback: interpretation === null,
    };
    setEntries(appendTranscript(session.sessionId, entry));
    setSending(false);
  }

  return (
    <>
      <PageHeader
        title="Chief of Staff"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Say what you want in your own words. What comes back is a proposal with the validator's answer already on it — nothing here executes."
        actions={
          <div className="flex items-center gap-2">
            <Tag tone={llm.available ? 'gain' : 'neutral'} dot>
              {llm.available ? `Live · ${llm.model ?? llm.transportKind}` : 'Deterministic fallback'}
            </Tag>
            <button
              type="button"
              className="btn btn-sm"
              disabled={entries.length === 0}
              onClick={() => setEntries(clearTranscript(session.sessionId))}
            >
              Clear conversation
            </button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- the conversation ---------------------------------------------- */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {entries.length === 0 ? (
            <Panel>
              <EmptyState
                glyph="CS"
                title="Nothing interpreted yet"
                message="Type an instruction below. It is read against your company briefing, the world briefing, your current budget lines and every decision open this quarter — and it comes back as typed actions you approve one at a time."
              />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" className="btn btn-sm" onClick={() => setMessage(example)}>
                    {example.length > 52 ? `${example.slice(0, 51)}…` : example}
                  </button>
                ))}
              </div>
            </Panel>
          ) : (
            entries.map((entry) => <InterpretationCard key={entry.id} entry={entry} startYear={session.startYear} />)
          )}

          <div ref={bottom} />

          <Panel title="Instruction" subtitle="Interpreted, then proposed, then confirmed. Never executed from the text itself.">
            <textarea
              className="field"
              rows={3}
              maxLength={1200}
              value={message}
              placeholder="Cut consumer marketing to six million and move the rest into enterprise sales."
              disabled={sending}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
              }}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-ink-faint">
                {llm.available
                  ? 'Interpreted by a model, validated by the engine, approved by you.'
                  : 'No model configured: the instruction is echoed back as a question and nothing is translated.'}
              </span>
              <button type="button" className="btn btn-primary btn-sm" disabled={sending || message.trim().length === 0} onClick={() => void send()}>
                {sending ? 'Interpreting…' : 'Interpret'}
              </button>
            </div>
          </Panel>
        </div>

        {/* --- what it is reading -------------------------------------------- */}
        <div className="flex flex-col gap-4">
          <Panel title="What it sees" subtitle="Your own company in full, and nothing private about anyone else">
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
                <li key={line.label} className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="text-ink-dim">{line.label}</span>
                  <span className="figure text-ink">{formatMoney(line.amountUsd)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              These are the lines that make “keep total spend roughly unchanged” an arithmetic instruction rather than a wish.
            </p>
          </Panel>

          <Panel title="Open decisions" subtitle="Everything waiting on you this quarter">
            {decisions.length === 0 ? (
              <p className="text-[11px] text-ink-faint">Nothing is waiting on you. The quarter is yours to shape.</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-4 text-[11px] text-ink-dim">
                {decisions.map((decision, index) => (
                  <li key={index}>{decision}</li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Do it by hand" subtitle="The click path and the conversation produce the same objects">
            <ul className="flex flex-col gap-1.5">
              {MANUAL_TICKETS.map((ticket) => (
                <li key={ticket.href}>
                  <Link href={ticket.href} className="flex items-baseline justify-between gap-3 rounded-[4px] px-1.5 py-1 hover:bg-raised">
                    <span className="text-[12px] text-ink">{ticket.label}</span>
                    <span className="text-[10px] text-ink-faint">{ticket.blurb}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              Either path can finish what the other started. Every row on an interpretation links to the screen that owns it, at{' '}
              <span className="figure">{ROUTE_OF_ACTION.raise_round}</span> and the rest.
            </p>
          </Panel>

          <Panel title="Queued this quarter" subtitle="What End Quarter will be asked to lock">
            {queue.length === 0 ? (
              <p className="text-[11px] text-ink-faint">Nothing queued yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {queue.map((item) => (
                  <li key={item.action.actionId} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-ink-dim">{item.action.intent.type.replace(/_/g, ' ')}</span>
                    <Tag tone={item.blocked ? 'warn' : item.validation.status === 'rejected' ? 'loss' : 'gain'} dot>
                      {item.blocked ? 'needs you' : item.validation.status}
                    </Tag>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/end-quarter" className="btn btn-sm mt-2.5 w-full">
              Review and submit
            </Link>
          </Panel>
        </div>
      </div>
    </>
  );
}

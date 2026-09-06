'use client';

/**
 * Ask the Chief of Staff — the shortcut, stated as a card.
 *
 * Two things live here, and the second is the reason the card exists.
 *
 * The first is four questions a founder standing at the desk actually has, each
 * opening the dock with the question already put.
 *
 * The second is the eleven instructions that have **no by-hand surface at all**.
 * Eleven of the fifty-two action types are reachable only through the Chief of
 * Staff; the game used to leave that fact undiscoverable, so a founder who
 * wanted to take the company public had nowhere to press. They are named here,
 * in plain English, and a tap fills the dock's composer with the sentence that
 * asks for it — unsent, so the words can be changed before a model reads them.
 *
 * Nothing here shortens the path to a binding action. The dock still interprets,
 * the card still shows the validator's verdict per row, the fourteen still take
 * their own explicit confirmation, and the engine validates every one of them
 * again on submission.
 */

import Link from 'next/link';
import type { ActionType } from '@frontier/contracts';
import { CHIEF_ONLY_ACTIONS, sheetHref } from '@/lib/sheets';
import { Icon, Panel } from '@/components/ui';
import { askChief, composeToChief } from '@/components/screens/chief-of-staff/composerBus';
import type { QuickPrompt } from '@/components/screens/chief-of-staff/quickPrompts';

/**
 * What each of the eleven is called, and the sentence that asks for it.
 *
 * Written out rather than derived from the action id: `titleise('ipo')` is
 * "Ipo", and a founder should never be shown a machine name. `satisfies` keeps
 * every key an `ActionType`, and `playTab.test.tsx` holds the set to
 * `CHIEF_ONLY_ACTIONS` — so an action that gains a by-hand surface, or loses
 * one, is a failing test rather than a stale list.
 */
export const CHIEF_ONLY_COPY = {
  marketing_campaign: { label: 'Run a marketing campaign', ask: 'Run a marketing campaign for us this quarter. Tell me first what it would cost and who it would reach.' },
  reserve_compute: { label: 'Reserve compute ahead of the quarter', ask: 'Reserve compute for us ahead of this quarter. How many accelerators can the market actually free, and at what price?' },
  buy_cloud_capacity: { label: 'Buy cloud capacity', ask: 'Buy cloud capacity for us this quarter. Say what term and what it commits us to before you propose it.' },
  invest_capacity: { label: 'Invest in production capacity', ask: 'Invest in our production capacity. What would it cost, and how long before it is serving anything?' },
  issue_shares: { label: 'Issue new shares', ask: 'Issue new shares. Tell me the dilution before you propose an amount.' },
  ipo: { label: 'Take the company public', ask: 'Take the company public. Say plainly whether the listing window is open enough for it to work.' },
  give_guidance: { label: 'Give the market guidance', ask: 'Give the market guidance this quarter. What would you say, and what does missing it cost us?' },
  respond_crisis: { label: 'Respond to a crisis', ask: 'Respond publicly to what is running against us. What is the least damaging thing we can say that is also true?' },
  abandon_research_project: { label: 'Close a research programme', ask: 'Close one of our research programmes. Which one is worth the least, and what do we lose by stopping it?' },
  license_node: { label: 'License technology from somebody else', ask: 'License a technology we do not hold from whoever owns it. What is available, and what would they charge?' },
  publish_licence_terms: { label: 'Publish licence terms for our own technology', ask: 'Publish licence terms for something we own, so others can build on it and pay us for it.' },
} as const satisfies Readonly<Partial<Record<ActionType, { readonly label: string; readonly ask: string }>>>;

/** The eleven, in registry order, with their words. */
export function chiefOnlyRows(): readonly { readonly type: ActionType; readonly label: string; readonly ask: string }[] {
  return CHIEF_ONLY_ACTIONS.flatMap((type) => {
    const copy = (CHIEF_ONLY_COPY as Readonly<Record<string, { readonly label: string; readonly ask: string }>>)[type];
    return copy === undefined ? [] : [{ type, label: copy.label, ask: copy.ask }];
  });
}

export interface ChiefCardProps {
  /** The four questions the Play context offers, from `quickPromptsFor`. */
  readonly prompts: readonly QuickPrompt[];
}

export function ChiefCard({ prompts }: ChiefCardProps): React.JSX.Element {
  const rows = chiefOnlyRows();
  return (
    <Panel
      title="Ask the Chief of Staff"
      iconName="briefcase"
      iconTone="brand"
      subtitle="Interpreted by a model, validated by the engine, approved by you."
      actions={
        <Link href={sheetHref('chief-of-staff')} className="btn btn-ghost tap-target gap-1 px-2">
          Open the full thread
          <Icon name="chevronRight" size={14} accent="current" />
        </Link>
      }
    >
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {prompts.map((prompt) => (
          <li key={prompt.label}>
            <button
              type="button"
              onClick={() => askChief(prompt.send)}
              className="icon-knockout-panel flex min-h-11 w-full items-center gap-2 rounded-chip border border-hair bg-panel px-3 py-2 text-left text-[12px] leading-snug text-ink-dim press-pop hover:border-hair-strong hover:text-ink"
            >
              <Icon name="chat" size={16} accent="inherit" className="text-ink-faint" />
              <span className="min-w-0 flex-1">{prompt.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-hair pt-3">
        <div className="label-caps">Things only the Chief of Staff can do</div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {rows.length} instructions have no control of their own anywhere in the game. Tap one and it goes into the composer, where you can
          change the words before anything is put to a model.
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {rows.map((row) => (
            <li key={row.type}>
              <button
                type="button"
                onClick={() => composeToChief(row.ask)}
                className="raised-surface press-pop tap-target flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:border-hair-strong"
              >
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{row.label}</span>
                <Icon name="chevronRight" size={13} accent="current" className="shrink-0 text-ink-faint" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

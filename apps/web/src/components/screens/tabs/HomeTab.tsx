'use client';

/**
 * Home — my company at a glance.
 *
 * One scrolling page of cards, read straight down in the order a returning
 * founder checks things: whose company this is and what quarter it is; the six
 * figures that decide whether anything else matters; what is asking for an
 * answer; what has been offered for the company; the goals; the tape.
 *
 * Every card states its figures on the page — the answer is read without a tap
 * — and opens exactly one sheet over this tab. Nothing here is a menu: the
 * world readings live on World, the quarter clock on Play, and the tab bar is
 * the only "go to" this game has.
 */

import { useMemo } from 'react';
import { quarterLabel } from '@frontier/contracts';
import Link from 'next/link';
import { Icon, Panel } from '@/components/ui';
import {
  useCompanyMetrics,
  useMarketCap,
  useOutcome,
  usePlayerCompany,
  usePlayerView,
  useQueuedActions,
  useQuotes,
  useSession,
} from '@/lib/game';
import { sheetHref } from '@/lib/sheets';
import { OfficeSceneCompact } from '@/components/scenes/office';
import { TapeStrip } from '@/components/screens/command-centre/TapeStrip';
import { buildFeed } from '@/components/screens/command-centre/feed';
import { offerInbox } from '@/components/screens/street/model';
import { FiguresGrid } from '@/components/screens/home/FiguresGrid';
import { FloorCard } from '@/components/screens/home/FloorCard';
import { NeedsDeciding } from '@/components/screens/home/NeedsDeciding';
import { ObjectivesCard } from '@/components/screens/home/ObjectivesCard';
import { OffersCard } from '@/components/screens/home/OffersCard';

/** Listed names beside your own on Home. The full tape is one tap away. */
const TAPE_LIMIT = 3;

export function HomeTab(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const metrics = useCompanyMetrics();
  const marketCap = useMarketCap();
  const queued = useQueuedActions();
  const lastOutcome = useOutcome();
  // With no instrument id `useQuotes()` returns the whole tape, so a private
  // company is given an empty series rather than everyone else's prices.
  const tape = useQuotes(company.instrumentId ?? undefined);
  const ownQuotes = company.instrumentId === null ? [] : tape;

  const unconfirmed = queued.filter((entry) => entry.blocked).length;
  const feed = useMemo(() => buildFeed(session, view, lastOutcome, unconfirmed), [session, view, lastOutcome, unconfirmed]);

  // Capital offered to this company, and approaches made for it — the same
  // committed deals and campaigns The Street reads.
  const offers = useMemo(
    () =>
      offerInbox({
        deals: view.deals,
        campaigns: session.activistCampaigns ?? [],
        companyIds: new Set([company.id]),
        quarter: session.quarter,
      }),
    [view.deals, session.activistCampaigns, session.quarter, company.id],
  );

  return (
    <>
      <FloorCard
        company={company}
        quarter={quarterLabel(session.startYear, session.quarter)}
        scene={<OfficeSceneCompact href={sheetHref('company')} />}
      />

      <FiguresGrid company={company} metrics={metrics} marketCap={marketCap} quotes={ownQuotes} />

      <NeedsDeciding items={feed} queued={queued.length} unconfirmed={unconfirmed} />

      <OffersCard offers={offers} startYear={session.startYear} />

      <ObjectivesCard objectives={view.objectives} />

      <Panel
        title="Tape"
        iconName="chart"
        subtitle="Your company and the largest listed names."
        actions={
          <Link href={sheetHref('exchange')} className="btn btn-ghost tap-target gap-1.5 px-2">
            <Icon name="chart" size={15} accent="current" />
            Open markets
          </Link>
        }
        flush
      >
        <TapeStrip session={session} view={view} limit={TAPE_LIMIT} />
      </Panel>
    </>
  );
}

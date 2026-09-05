'use client';

/**
 * The Street — the institutions, and what they are doing to you.
 *
 * Eleven cards, scrolling. Not a holdings table with a column per fund: that is
 * eleven columns, and eleven columns is not a phone surface. Each card is one
 * institution — its size, its remaining dry powder, its thesis, its clock, and
 * where it stands toward you — and tapping it opens the whole book.
 *
 * Above the roster sits the inbox, because an offer is a decision and a roster
 * is a briefing. Every offer arrived as an ordinary `DealProposal` written by a
 * capital desk, so accept, counter and decline are the deal actions that already
 * exist; and every one of them is answerable only in the quarter *after* it was
 * made, which the card says in those words.
 *
 * A world-version-1 session has no institutional layer at all — no entities, no
 * shorts, no campaigns — and this screen says exactly that rather than drawing
 * eleven empty cards.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CONTROL_DECISIVE_PCT, makeId, quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  SectionHeading,
  StatCard,
  Tag,
} from '@/components/ui';
import { useGame, usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import {
  DefencePanel,
  EntityDrawer,
  OfferCard,
  StreetCard,
  answerableCount,
  buyoutOf,
  defenceOptions,
  entityLedgerRows,
  offerInbox,
  streetCards,
  type StanceContext,
} from '@/components/screens/street';
import { capTableRows, companyNameOf, issuedSharesOf } from '@/components/screens/reporting/util';

export default function StreetPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const { lastOutcome } = useGame();
  const [openId, setOpenId] = useState<string | null>(null);

  const report = view.economyReport;
  const entities = report?.capitalEntities ?? [];

  /* --- identity lookups --------------------------------------------------- */

  const entityNameOf = useMemo(() => {
    const names = new Map(entities.map((row) => [row.entityId, row.name] as const));
    return (entityId: string): string => names.get(entityId) ?? entityId;
  }, [entities]);

  const entityById = useMemo(() => new Map(entities.map((row) => [row.entityId, row] as const)), [entities]);

  const partnerNameOf = useMemo(() => {
    const names = new Map(session.characters.map((character) => [character.id, character.name] as const));
    return (characterId: string | null): string | null => (characterId === null ? null : (names.get(characterId) ?? null));
  }, [session.characters]);

  /* --- the register, as this screen needs it ------------------------------ */

  const ownTable = useMemo(() => session.capTables.find((table) => table.companyId === company.id) ?? null, [session.capTables, company.id]);

  /** Whole-percentage stakes in the player's own company, by holder id. */
  const ownRegister = useMemo(() => {
    if (ownTable === null) return new Map<string, number>();
    const issued = issuedSharesOf(ownTable);
    const out = new Map<string, number>();
    if (issued === 0) return out;
    for (const row of capTableRows(session, ownTable)) {
      out.set(row.holderId, Math.round(row.economicPct * 100));
    }
    return out;
  }, [session, ownTable]);

  const ownStakePct = (ownRegister.get(founder.id) ?? 0) + (ownRegister.get(view.playerId) ?? 0);

  /* --- the stance context, built once and handed to every card ------------- */

  const campaigns = useMemo(() => session.activistCampaigns ?? [], [session.activistCampaigns]);
  const ownCompanyIds = useMemo(() => new Set([company.id]), [company.id]);

  const liveApproaches = useMemo(
    () =>
      view.deals
        .filter((deal) => deal.status === 'proposed' || deal.status === 'accepted')
        .map((deal) => ({ deal, offer: buyoutOf(deal) }))
        .filter((entry): entry is { deal: (typeof view.deals)[number]; offer: NonNullable<ReturnType<typeof buyoutOf>> } => entry.offer !== null)
        .filter((entry) => ownCompanyIds.has(entry.offer.targetCompanyId)),
    [view.deals, ownCompanyIds],
  );

  const stanceContext: StanceContext = useMemo(() => {
    const trust = new Map<string, number>();
    const hostility = new Map<string, number>();
    for (const edge of session.relationships) {
      if (edge.toId !== founder.id) continue;
      trust.set(edge.fromId, edge.trust);
      hostility.set(edge.fromId, edge.hostility);
    }
    const shortIds = new Set<string>();
    for (const row of report?.shortInterest ?? []) {
      if (!ownCompanyIds.has(row.companyId)) continue;
      for (const id of row.disclosedEntityIds) shortIds.add(id);
    }
    return {
      ownCompanyIds,
      trustByPartnerId: trust,
      hostilityByPartnerId: hostility,
      approachEntityIds: new Set(liveApproaches.map((entry) => entry.offer.entityId)),
      campaignEntityIds: new Set(
        campaigns.filter((campaign) => campaign.outcome === null && ownCompanyIds.has(campaign.targetCompanyId)).map((campaign) => campaign.entityId),
      ),
      proxyFightEntityIds: new Set(
        campaigns
          .filter((campaign) => campaign.outcome === null && campaign.stage === 'proxy_fight' && ownCompanyIds.has(campaign.targetCompanyId))
          .map((campaign) => campaign.entityId),
      ),
      shortEntityIds: shortIds,
    };
  }, [session.relationships, founder.id, report, ownCompanyIds, liveApproaches, campaigns]);

  const cards = useMemo(() => streetCards(report, stanceContext), [report, stanceContext]);
  const selected = openId === null ? null : (cards.find((card) => card.row.entityId === openId) ?? null);

  const ledgerRows = useMemo(
    () => (openId === null || lastOutcome === null ? [] : entityLedgerRows(lastOutcome.events, openId)),
    [openId, lastOutcome],
  );

  /* --- the inbox ----------------------------------------------------------- */

  const offers = useMemo(
    () => offerInbox({ deals: view.deals, campaigns, companyIds: ownCompanyIds, quarter: session.quarter }),
    [view.deals, campaigns, ownCompanyIds, session.quarter],
  );
  const needAnswer = answerableCount(offers);

  /** Institutions with the size to counter-bid, largest dry powder first. */
  const rescuers = useMemo(
    () =>
      entities
        .filter((row) => row.kind === 'pe' || row.kind === 'sovereign')
        .slice()
        .sort((a, b) => (b.dryPowderUsd !== a.dryPowderUsd ? b.dryPowderUsd - a.dryPowderUsd : a.entityId.localeCompare(b.entityId))),
    [entities],
  );

  const dryPowderAimedAtYou = cards
    .filter((card) => card.stance === 'hostile' || card.stance === 'adversary')
    .reduce((total, card) => total + card.row.dryPowderUsd, 0);

  if (entities.length === 0) {
    return (
      <>
        <PageHeader
          title="The Street"
          eyebrow={quarterLabel(session.startYear, session.quarter)}
          subtitle="Venture, buyout, hedge and sovereign capital as actors rather than scenery."
        />
        <EmptyState
          icon="vault"
          title="This world has no institutional layer"
          message="Funds in this session are blocs on a register that vote and sell blocks — they have no cash, no clock and no agency. The Street exists in the multi-sector world, where eleven institutions allocate capital every quarter."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="The Street"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${entities.length} institutions`}
        subtitle="What they are worth, what they can still spend, and where each of them stands toward you."
        actions={
          <Link href="/leaderboard" className="btn btn-ghost tap-target gap-1.5 px-2">
            <Icon name="trophy" size={15} accent="current" />
            The fund boards
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard
          iconName="bell"
          iconTone={needAnswer > 0 ? 'warn' : 'neutral'}
          label="Awaiting your answer"
          value={`${needAnswer}`}
          tone={needAnswer > 0 ? 'warn' : undefined}
          hint={offers.length === needAnswer ? 'Every offer on the table' : `${offers.length - needAnswer} answerable next quarter`}
        />
        <StatCard
          iconName="vault"
          label="Dry powder aimed at you"
          value={formatMoney(dryPowderAimedAtYou)}
          tone={dryPowderAimedAtYou > 0 ? 'loss' : undefined}
          hint="Held by the institutions currently hostile or adversarial"
        />
        <StatCard
          iconName="building"
          label="On your register"
          value={`${cards.filter((card) => card.ownPositions.length > 0).length}`}
          hint="Institutions holding a disclosed stake in you"
        />
        <StatCard
          iconName="chart"
          label="Short in you"
          value={`${stanceContext.shortEntityIds.size}`}
          tone={stanceContext.shortEntityIds.size > 0 ? 'warn' : undefined}
          hint="Disclosed short books only. Below the threshold nobody is named."
        />
      </div>

      {/* --- the inbox -------------------------------------------------------
          Above the roster, because an offer needs an answer and a roster is a
          briefing. Absent entirely when nothing is on the table. */}
      {offers.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <SectionHeading rule>
            Offers · {needAnswer === 0 ? 'none answerable this quarter' : `${needAnswer} awaiting an answer`}
          </SectionHeading>
          {offers.map((offer) => {
            const entity = entityById.get(offer.entityId) ?? null;
            const partner = partnerNameOf(entity?.partnerCharacterId ?? null) ?? (entity?.name ?? offer.entityId);
            const approach = offer.deal === null ? null : buyoutOf(offer.deal);
            const rescuer = rescuers.find((row) => row.entityId !== offer.entityId) ?? null;
            return (
              <OfferCard
                key={offer.id}
                offer={offer}
                startYear={session.startYear}
                quarter={session.quarter}
                entityName={entity?.name ?? offer.entityId}
                entityKindIcon={entity?.kind ?? null}
                partnerName={partner}
                companyName={companyNameOf(view, offer.companyId)}
                termSheetContext={{
                  ownStakePct,
                  cashUsd: company.financials.cash,
                  boardSeats: view.board?.directors.length ?? 0,
                  partnerName: partner,
                }}
                buyoutContext={{
                  ownStakePct,
                  raiderStakePct: ownRegister.get(offer.entityId) ?? 0,
                  controlPct: Math.round(CONTROL_DECISIVE_PCT * 100),
                }}
                defences={
                  approach === null ? undefined : (
                    <DefencePanel
                      options={defenceOptions({
                        approachIsPublic: approach.stage !== 'private_approach' || offer.deal?.confidentiality === 'public',
                        hasBoard: view.board !== null,
                        boardIsStaggered: view.board?.staggered === true,
                        pillAlreadyRaised: session.deals.some((deal) => deal.id === makeId('pill', company.id, offer.entityId)),
                        rescuerCount: rescuers.filter((row) => row.entityId !== offer.entityId).length,
                      })}
                      offer={approach}
                      raiderName={entity?.name ?? offer.entityId}
                      companyName={company.name}
                      ownStakePct={ownStakePct}
                      rescuer={
                        rescuer === null
                          ? null
                          : { entityId: rescuer.entityId, partnerCharacterId: rescuer.partnerCharacterId, name: rescuer.name }
                      }
                      quarter={session.quarter}
                    />
                  )
                }
              />
            );
          })}
        </section>
      )}

      {/* --- the roster ------------------------------------------------------ */}
      <Panel
        iconName="vault"
        iconTone="brand"
        title="The institutions"
        subtitle="Roster order, held across quarters so a card never jumps the queue. Tap one for its portfolio, its short book and its ledger."
        flush
        actions={<Tag tone="neutral">{cards.length} on the street</Tag>}
      >
        <div className="grid gap-2.5 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <StreetCard key={card.row.entityId} card={card} onOpen={setOpenId} />
          ))}
        </div>
      </Panel>

      <EntityDrawer
        card={selected}
        onClose={() => setOpenId(null)}
        startYear={session.startYear}
        quarter={session.quarter}
        companyNameOf={(companyId) => companyNameOf(view, companyId)}
        partnerName={partnerNameOf(selected?.row.partnerCharacterId ?? null)}
        ledgerRows={ledgerRows}
      />
    </>
  );
}

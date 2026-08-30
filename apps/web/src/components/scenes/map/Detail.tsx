'use client';

/**
 * What opens when something on the map is tapped.
 *
 * One drawer, four subjects: a company's **public** profile, an agency's open
 * procurements, a district's world-state reading, and a world event's card.
 *
 * The information boundary is the whole design of this file. A rival is read
 * from `PlayerView.visibleCompanies`, which is the redacted projection: name,
 * ticker, sector, tier, listing status, headquarters and the five public
 * reputations, plus filed financial statements only when the company is listed
 * and therefore actually files them. There is no branch here that reaches into
 * `SessionState.companies`, and there is nothing to add later — a private
 * rival's operating detail is absent from the projection, not hidden by this
 * component.
 */

import Link from 'next/link';
import type { Company, ProcurementOpportunity } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import { Drawer, EmptyState, KeyValueGrid, Meter, Tag, cx, type Tone } from '@/components/ui';
import { usePlayerView, useSession } from '@/lib/game';
import { DISTRICT_BY_ID, type DistrictId } from './geography';
import {
  districtReadings,
  formatReading,
  humaniseToken,
  type MapTarget,
  type WorldMapModel,
} from './model';

export interface MapDetailProps {
  readonly target: MapTarget | null;
  readonly model: WorldMapModel;
  readonly onClose: () => void;
  /** Move the drawer to another subject without closing it. */
  readonly onSelect: (target: MapTarget) => void;
}

/* -------------------------------------------------------------------------- */

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-3">
      <p className="label-caps">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ReadingList({ items }: { readonly items: readonly { label: string; value: string; hint: string; meter: number | null }[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] font-medium text-ink">{item.label}</span>
            <span className="figure text-[12px] text-ink">{item.value}</span>
          </div>
          {item.meter === null ? null : <Meter className="mt-1" value={item.meter} />}
          <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">{item.hint}</p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Company                                                                    */
/* -------------------------------------------------------------------------- */

const REPUTATION_AUDIENCES: readonly (readonly [keyof Company['reputation'], string])[] = [
  ['public', 'Public'],
  ['developer', 'Developers'],
  ['enterprise', 'Enterprise'],
  ['government', 'Government'],
  ['investor', 'Investors'],
];

function CompanyBody({ companyId }: { readonly companyId: string }): React.JSX.Element {
  const view = usePlayerView();
  const own = view.ownCompany;
  const isOwn = companyId === own.id;
  const company: Partial<Company> | null = isOwn
    ? own
    : (view.visibleCompanies.find((entry) => entry.id === companyId) ?? null);

  if (company === null) {
    return <EmptyState compact title="Not on the register" message="This company is not in the projection the player can see." />;
  }

  const instrumentId = company.instrumentId ?? null;
  const quotes = instrumentId === null ? [] : view.quotes.filter((quote) => quote.instrumentId === instrumentId);
  const last = quotes.length === 0 ? null : quotes.reduce((best, quote) => (quote.quarter > best.quarter ? quote : best));
  const listed = company.isPublic === true;
  const financials = company.financials ?? null;
  const reputation = company.reputation ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={isOwn ? 'brand' : 'neutral'} dot>
          {isOwn ? 'Your company' : 'Rival'}
        </Tag>
        <Tag tone={listed ? 'info' : 'neutral'}>{listed ? `Listed · ${company.ticker ?? '—'}` : 'Privately held'}</Tag>
        {company.tier === undefined ? null : <Tag>{humaniseToken(company.tier)}</Tag>}
      </div>

      <KeyValueGrid
        className="mt-3"
        columns={2}
        items={[
          { label: 'Sector', value: humaniseToken(company.sectorId ?? 'unknown'), mono: false },
          { label: 'Archetype', value: humaniseToken(company.archetype ?? 'unknown'), mono: false },
          { label: 'Headquarters', value: company.headquartersCity ?? 'Undisclosed', mono: false },
          {
            label: 'Founded',
            value: company.foundedQuarter === undefined ? '—' : quarterLabel(view.startYear, company.foundedQuarter),
          },
        ]}
      />

      {last === null ? (
        <p className="mt-3 rounded-card border border-hair bg-raised px-3 py-2 text-[11px] leading-relaxed text-ink-dim">
          Unlisted. There is no quote, and a private company&rsquo;s valuation is not public information — the silhouette on the
          map is sized from its simulation tier instead.
        </p>
      ) : (
        <Row label="Last quote">
          <KeyValueGrid
            columns={3}
            items={[
              { label: 'Price', value: formatMoney(last.price) },
              { label: 'Return', value: formatPct(last.return), tone: last.return >= 0 ? 'gain' : 'loss' },
              { label: 'Market cap', value: formatMoney(last.marketCapUsd) },
            ]}
          />
        </Row>
      )}

      {reputation === null ? null : (
        <Row label="Reputation">
          <ul className="flex flex-col gap-2">
            {REPUTATION_AUDIENCES.map(([key, label]) => (
              <li key={key}>
                <Meter label={label} value={reputation[key]} showValue />
              </li>
            ))}
          </ul>
        </Row>
      )}

      {financials === null ? null : (
        <Row label={listed ? 'Filed this quarter' : 'Your figures'}>
          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Revenue', value: formatMoney(financials.revenueQuarterly) },
              { label: 'Cash', value: formatMoney(financials.cash) },
              { label: 'Debt', value: formatMoney(financials.debt) },
              { label: 'Backlog', value: formatMoney(financials.backlogUsd) },
              {
                label: 'Quarterly burn',
                value: formatMoney(financials.quarterlyBurn),
                tone: financials.quarterlyBurn >= 0 ? 'gain' : 'loss',
              },
              { label: 'R&D', value: formatMoney(financials.rdSpend) },
            ]}
          />
        </Row>
      )}

      {company.governmentPastPerformance === undefined ? null : (
        <Row label="Past performance">
          <Meter value={company.governmentPastPerformance} showValue />
          <p className="mt-1 text-[10px] text-ink-faint">
            The formal procurement record. It is an evaluation weight on every public competition.
          </p>
        </Row>
      )}

      <p className="mt-4 border-t border-hair pt-2.5 text-[10px] leading-relaxed text-ink-faint">
        Everything above is public: what a listed company files, what the tape quotes and what the five audiences say. Headcount,
        compute, capability scores and product economics are not on this card because they are not public.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Agency                                                                     */
/* -------------------------------------------------------------------------- */

function OpportunityRow({ opportunity, startYear, quarter }: { readonly opportunity: ProcurementOpportunity; readonly startYear: number; readonly quarter: number }): React.JSX.Element {
  const remaining = opportunity.closeQuarter - quarter;
  const tone: Tone = remaining <= 0 ? 'loss' : remaining <= 1 ? 'warn' : 'neutral';
  return (
    <li className="raised-surface px-3 py-2">
      <p className="text-[12px] font-medium text-ink">{opportunity.programme}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Tag tone="info">{formatMoney(opportunity.maxValue)} ceiling</Tag>
        <Tag tone={tone}>Closes {quarterLabel(startYear, opportunity.closeQuarter)}</Tag>
        <Tag>{humaniseToken(opportunity.contractForm)}</Tag>
        <Tag>{formatQuarterCount(opportunity.durationQuarters)}</Tag>
      </div>
    </li>
  );
}

function AgencyBody({ agencyId }: { readonly agencyId: string }): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const agency = session.agencies.find((entry) => entry.id === agencyId) ?? null;

  if (agency === null) {
    return <EmptyState compact title="No such agency" message="This civic building has no buyer behind it in the current session." />;
  }

  const open = view.opportunities
    .filter((entry) => entry.agencyId === agency.id && entry.status === 'open')
    .slice()
    .sort((a, b) => a.closeQuarter - b.closeQuarter || a.id.localeCompare(b.id));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="info" dot>
          {humaniseToken(agency.jurisdiction)}
        </Tag>
        {agency.clearanceAuthority ? <Tag tone="warn">Sponsors clearances</Tag> : null}
      </div>

      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-dim">{agency.mission}</p>

      <KeyValueGrid
        className="mt-3"
        columns={2}
        items={[
          { label: 'Quarterly budget', value: formatMoney(agency.budgetQuarterlyUsd) },
          { label: 'Open notices', value: String(open.length) },
        ]}
      />

      <Row label="Standing priorities">
        <div className="flex flex-wrap gap-1.5">
          {agency.priorities.map((priority) => (
            <Tag key={priority}>{humaniseToken(priority)}</Tag>
          ))}
        </div>
      </Row>

      <Row label="Open procurements">
        {open.length === 0 ? (
          <EmptyState
            compact
            title="Nothing open here this quarter"
            message="Notices open as the procurement budget allows. The Government screen carries the full register, including anything you were invited to."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {open.map((opportunity) => (
              <OpportunityRow key={opportunity.id} opportunity={opportunity} startYear={view.startYear} quarter={view.quarter} />
            ))}
          </ul>
        )}
      </Row>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  District                                                                   */
/* -------------------------------------------------------------------------- */

function DistrictBody({
  districtId,
  model,
  onSelect,
}: {
  readonly districtId: DistrictId;
  readonly model: WorldMapModel;
  readonly onSelect: (target: MapTarget) => void;
}): React.JSX.Element {
  const view = usePlayerView();
  const district = DISTRICT_BY_ID.get(districtId);
  if (district === undefined) return <EmptyState compact title="Off the map" />;

  const readings = districtReadings(view.world, districtId).map((reading) => ({
    label: reading.label,
    value: formatReading(reading),
    hint: reading.hint,
    meter: reading.meter,
  }));
  const here = model.markers.filter((marker) => marker.districtId === districtId);
  const residents = model.buildings.filter((entry) => entry.districtId === districtId && entry.kind === 'company');

  return (
    <div>
      <p className="text-[12px] leading-relaxed text-ink-dim">{district.blurb}</p>

      <Row label="World state">
        <ReadingList items={readings} />
      </Row>

      {residents.length === 0 ? null : (
        <Row label="Head offices here">
          <div className="flex flex-wrap gap-1.5">
            {residents.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={cx('btn btn-sm', entry.isPlayer && 'btn-primary')}
                onClick={() => onSelect(entry.target)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </Row>
      )}

      {here.length === 0 ? null : (
        <Row label="Active here">
          <ul className="flex flex-col gap-1.5">
            {here.map((marker) => (
              <li key={marker.eventId}>
                <button
                  type="button"
                  className="w-full rounded-card border border-hair px-3 py-2 text-left hover-lift press-pop"
                  onClick={() => onSelect({ kind: 'event', eventId: marker.eventId })}
                >
                  <span className={cx('text-[12px] font-medium', `tone-${marker.tone}`)}>{marker.title}</span>
                  <span className="figure ml-2 text-[10px] text-ink-faint">severity {formatScore(marker.severity * 100)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Event                                                                      */
/* -------------------------------------------------------------------------- */

function EventBody({ eventId, model, onSelect }: { readonly eventId: string; readonly model: WorldMapModel; readonly onSelect: (target: MapTarget) => void }): React.JSX.Element {
  const view = usePlayerView();
  const event = model.events.find((entry) => entry.id === eventId) ?? null;
  if (event === null) {
    return <EmptyState compact title="No longer active" message="This event has fallen out of the active window." />;
  }
  const parent = event.causalParentId === null ? null : (model.events.find((entry) => entry.id === event.causalParentId) ?? null);
  const tone: Tone = event.severity >= 0.6 ? 'loss' : event.severity >= 0.35 ? 'warn' : 'info';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={tone} dot>
          {humaniseToken(event.type)}
        </Tag>
        <Tag>{quarterLabel(view.startYear, event.quarter)}</Tag>
        <Tag>{formatQuarterCount(event.durationQuarters)} active</Tag>
        <Tag tone="neutral">Public</Tag>
      </div>

      <p className="mt-3 text-[13px] font-semibold leading-snug text-ink">{event.title}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">{event.description}</p>

      <Row label="Severity">
        <Meter value={event.severity * 100} showValue />
        <p className="mt-1 text-[10px] text-ink-faint">
          0.1 is a footnote, 0.5 reshapes a quarter, 0.9 reshapes the session.
        </p>
      </Row>

      {event.affectedSectorIds.length === 0 && event.affectedCompanyIds.length === 0 ? null : (
        <Row label="Named in the event">
          <div className="flex flex-wrap gap-1.5">
            {event.affectedSectorIds.map((sector) => (
              <Tag key={sector}>{humaniseToken(sector)}</Tag>
            ))}
            {event.affectedCompanyIds.map((companyId) => {
              const building = model.buildings.find((entry) => entry.key === companyId);
              if (building === undefined) return <Tag key={companyId}>{companyId}</Tag>;
              return (
                <button key={companyId} type="button" className="btn btn-sm" onClick={() => onSelect(building.target)}>
                  {building.label}
                </button>
              );
            })}
          </div>
        </Row>
      )}

      {parent === null ? null : (
        <Row label="Follows from">
          <button
            type="button"
            className="w-full rounded-card border border-hair px-3 py-2 text-left hover-lift press-pop"
            onClick={() => onSelect({ kind: 'event', eventId: parent.id })}
          >
            <span className="text-[12px] font-medium text-ink">{parent.title}</span>
            <span className="ml-2 text-[10px] text-ink-faint">{quarterLabel(view.startYear, parent.quarter)}</span>
          </button>
        </Row>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The drawer                                                                 */
/* -------------------------------------------------------------------------- */

function titleOf(target: MapTarget, model: WorldMapModel, fallback: string): { readonly title: string; readonly subtitle: string } {
  switch (target.kind) {
    case 'company': {
      const building = model.buildings.find((entry) => entry.key === target.companyId);
      return { title: building?.label ?? fallback, subtitle: 'Public profile' };
    }
    case 'agency': {
      const building = model.buildings.find((entry) => entry.key === target.agencyId);
      return { title: building?.label ?? fallback, subtitle: 'Open procurements' };
    }
    case 'district': {
      const district = DISTRICT_BY_ID.get(target.districtId);
      return { title: district?.name ?? fallback, subtitle: district?.label ?? '' };
    }
    default: {
      const event = model.events.find((entry) => entry.id === target.eventId);
      return { title: event?.title ?? fallback, subtitle: 'Active world event' };
    }
  }
}

export function MapDetail({ target, model, onClose, onSelect }: MapDetailProps): React.JSX.Element | null {
  if (target === null) return null;
  const { title, subtitle } = titleOf(target, model, 'Detail');

  return (
    <Drawer
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        target.kind === 'agency' ? (
          <Link className="btn btn-primary" href="/government">
            Open the Government screen
          </Link>
        ) : target.kind === 'company' ? (
          <Link className="btn" href="/markets">
            Open the market tape
          </Link>
        ) : null
      }
    >
      {target.kind === 'company' ? <CompanyBody companyId={target.companyId} /> : null}
      {target.kind === 'agency' ? <AgencyBody agencyId={target.agencyId} /> : null}
      {target.kind === 'district' ? <DistrictBody districtId={target.districtId} model={model} onSelect={onSelect} /> : null}
      {target.kind === 'event' ? <EventBody eventId={target.eventId} model={model} onSelect={onSelect} /> : null}
    </Drawer>
  );
}

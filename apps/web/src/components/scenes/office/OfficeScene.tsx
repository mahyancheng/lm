'use client';

/**
 * The HQ office.
 *
 * The company as a *place*: seven rooms on one floor plan, each drawn from
 * committed state and each a control. Engineering is as big as `engineers` is;
 * the server room holds as many racks as the fleet needs; the faces are the
 * same faces they were last quarter because every one of them is
 * `fnv1a64(seatId)`; the mouths turn down when morale does.
 *
 * What the scene is allowed to do:
 *
 * - read the player's **own** company through the documented store hooks;
 * - scale a crowd it cannot draw one-for-one, and say so on the badge;
 * - send the player to the screen that actually operates the room.
 *
 * What it never does: invent a figure, animate anything that is not a
 * transform or an opacity, or run a loop in JavaScript. The only numbers it
 * prints are the ones in state.
 *
 * The stage is a fixed 1040 x 560 design canvas inside a `.scene-frame`. On a
 * phone the frame scrolls horizontally and the page body does not — panning the
 * office is the intended gesture, and every zone stays a full-size tap target
 * rather than being scaled down under 44px.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { formatPct, formatScore } from '@frontier/shared';
import { TONE_CHIP, cx, type Tone } from '@/components/ui';
import { usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { DESK_CELL, Desk, EXEC_CELL, RACK_CELL, Rack, Worker } from './Figures';
import {
  AnonymousExecutiveDesk,
  BoardShelf,
  CrateShelf,
  ExecutiveBackdrop,
  ExecutiveDesk,
  Floor,
  LobbyRoom,
  MoraleWash,
  ROLE_FIGURE,
  ServerRoom,
  WorkRoom,
} from './Rooms';
import {
  MORALE_MOOD,
  MORALE_TONE,
  buildOfficeModel,
  countLabel,
  type OfficeDrawerId,
  type OfficeModel,
  type OfficeWorkZone,
  type OfficeZoneId,
} from './model';
import { allocate, seatLook } from './seats';
import { OFFICE_STYLES, OFFICE_STYLE_ID } from './styles';

/* -------------------------------------------------------------------------- */
/*  Stage geometry                                                             */
/* -------------------------------------------------------------------------- */

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The design canvas. Fixed, so a tap target is a tap target at every width. */
export const STAGE = { width: 1040, height: 560 } as const;

/**
 * Padding, label and caption inside a zone card; the SVG gets what is left.
 * `7px` top padding + a 14px label + a 13px caption + the gaps + `6px` clear at
 * the bottom, which is where 46 comes from.
 */
const ZONE_PAD_X = 9;
const ZONE_CHROME_Y = 46;

const RECT = {
  lobby: { x: 0, y: 0, w: 272, h: 168 },
  executive: { x: 284, y: 0, w: 444, h: 168 },
  server: { x: 740, y: 0, w: 300, h: 168 },
  engineering: { x: 0, y: 180, w: 356, h: 232 },
  research: { x: 368, y: 180, w: 328, h: 232 },
  sales: { x: 708, y: 180, w: 332, h: 232 },
  operations: { x: 0, y: 424, w: 1040, h: 136 },
} as const satisfies Record<OfficeZoneId, Rect>;

function innerOf(rect: Rect): { readonly width: number; readonly height: number } {
  return { width: rect.w - ZONE_PAD_X * 2, height: rect.h - ZONE_CHROME_Y };
}

/* -------------------------------------------------------------------------- */
/*  Zone chrome                                                                */
/* -------------------------------------------------------------------------- */

function ZoneBadge({ tone = 'neutral', children }: { readonly tone?: Tone; readonly children: ReactNode }): React.JSX.Element {
  return (
    <span className={cx('figure shrink-0 rounded-chip border px-1.5 py-[1px] text-[10px] leading-[14px]', TONE_CHIP[tone])}>
      {children}
    </span>
  );
}

interface ZoneFrameProps {
  readonly rect: Rect;
  readonly label: string;
  readonly caption: ReactNode;
  readonly badge?: ReactNode;
  readonly ariaLabel: string;
  readonly empty?: boolean;
  /** A route to push, when the zone drills into another screen. */
  readonly href?: string;
  /** A handler, when the zone opens a drawer on the host screen. */
  readonly onActivate?: () => void;
  /** Rendered without an interactive wrapper — the room holds its own buttons. */
  readonly asGroup?: boolean;
  readonly staggerIndex?: number;
  readonly children: ReactNode;
}

/**
 * One room: the card, the label, the badge, and the hit area.
 *
 * A zone is a link when it drills into a screen and a button when it opens a
 * drawer, so the browser keeps its own affordances (middle-click, focus order,
 * the status bar) instead of a `role="button"` reimplementation. The executive
 * row is the one exception: it renders `asGroup` because each desk inside it is
 * its own control, and buttons do not nest.
 */
function ZoneFrame({
  rect,
  label,
  caption,
  badge,
  ariaLabel,
  empty = false,
  href,
  onActivate,
  asGroup = false,
  staggerIndex = 0,
  children,
}: ZoneFrameProps): React.JSX.Element {
  const inner = innerOf(rect);
  const style: React.CSSProperties = {
    position: 'absolute',
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    animationDelay: `${staggerIndex * 45}ms`,
  };

  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="label-caps truncate">{label}</span>
        {badge}
      </span>
      <span className="block truncate text-[10px] leading-[13px] text-ink-faint">{caption}</span>
      <svg
        width={inner.width}
        height={inner.height}
        viewBox={`0 0 ${inner.width} ${inner.height}`}
        role="presentation"
        focusable="false"
        aria-hidden="true"
        className="mt-0.5 block"
      >
        {children}
      </svg>
    </>
  );

  const className = 'fc-office-zone animate-pop-in';

  if (asGroup) {
    return (
      <div className={className} style={style} data-empty={empty} data-static="true" role="group" aria-label={ariaLabel}>
        {body}
      </div>
    );
  }
  if (href !== undefined) {
    return (
      <Link href={href} className={className} style={style} data-empty={empty} aria-label={ariaLabel}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={className} style={style} data-empty={empty} onClick={onActivate} aria-label={ariaLabel}>
      {body}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  The scene                                                                  */
/* -------------------------------------------------------------------------- */

export interface OfficeSceneProps {
  /** Opens a drawer on the host screen. Without it those zones become links. */
  readonly onOpenDrawer?: (drawer: OfficeDrawerId) => void;
  /** Opens one executive's context on the host screen. */
  readonly onOpenCharacter?: (characterId: string) => void;
  /** Where drawer zones point when the host screen has no drawers. */
  readonly fallbackHref?: string;
  readonly className?: string;
}

/** The scene's stylesheet. React dedupes it across every mount on the page. */
function OfficeStyles(): React.JSX.Element {
  return (
    <style href={OFFICE_STYLE_ID} precedence="default">
      {OFFICE_STYLES}
    </style>
  );
}

/** The model, read from the store. One hook set, shared by both scenes. */
function useOfficeModel(): OfficeModel {
  const session = useSession();
  const company = usePlayerCompany();
  const view = usePlayerView();
  return useMemo(
    () => buildOfficeModel({ session, company, projects: view.ownResearchProjects, characters: session.characters }),
    [session, company, view.ownResearchProjects],
  );
}

/** The badge a working room carries: the true headcount, and the drawn scale. */
function zoneBadge(zone: OfficeWorkZone): React.JSX.Element {
  return (
    <ZoneBadge tone={zone.headcount === 0 ? 'neutral' : 'brand'}>
      {countLabel(zone.headcount)}
      {zone.crowd.perFigure > 1 ? <span className="text-ink-faint"> · 1:{zone.crowd.perFigure}</span> : null}
    </ZoneBadge>
  );
}

/** Screen names for the aria label. A screen reader should not read a URL. */
const DESTINATION: Readonly<Record<string, string>> = {
  '/people': 'the People screen',
  '/research': 'the Research screen',
  '/products': 'the Products screen',
  '/company': 'the Company screen',
};

function zoneAria(zone: OfficeWorkZone, perFigureNote: string): string {
  const where = zone.target.kind === 'route' ? (DESTINATION[zone.target.href] ?? 'the drill-down') : 'the drill-down';
  const vacancies = zone.vacantDesks === 0 ? '' : `, ${zone.vacantDesks} desk${zone.vacantDesks === 1 ? '' : 's'} standing empty`;
  return `${zone.label}: ${zone.headcount} people${perFigureNote}${vacancies}. Opens ${where}.`;
}

export function OfficeScene({ onOpenDrawer, onOpenCharacter, fallbackHref = '/company', className }: OfficeSceneProps): React.JSX.Element {
  const model = useOfficeModel();

  const byId = new Map(model.zones.map((zone) => [zone.id, zone] as const));
  const engineering = byId.get('engineering');
  const research = byId.get('research');
  const sales = byId.get('sales');
  const operations = byId.get('operations');

  const lobbyRect: Rect = RECT.lobby;
  const execRect: Rect = RECT.executive;
  const serverRect: Rect = RECT.server;
  const lobbyInner = innerOf(lobbyRect);
  const execInner = innerOf(execRect);
  const serverInner = innerOf(serverRect);

  const serverDrawer = onOpenDrawer === undefined ? undefined : () => onOpenDrawer('compute');
  const sitesDrawer = onOpenDrawer === undefined ? undefined : () => onOpenDrawer('sites');

  const workRooms: readonly (OfficeWorkZone | undefined)[] = [engineering, research, sales, operations];

  return (
    <div className={cx('scene-frame bg-base', className)}>
      <OfficeStyles />
      <div className="scroll-x">
        <div className="fc-office relative" style={{ width: STAGE.width, height: STAGE.height }}>
          {/* --- lobby ---------------------------------------------------- */}
          <ZoneFrame
            rect={lobbyRect}
            label={model.lobby.companyName}
            caption={`${model.lobby.tier} tier · ${model.lobby.headquartersCity} · ${model.lobby.sites} site${model.lobby.sites === 1 ? '' : 's'}`}
            // The mood on the wall: the floor is tinted and the mouths are drawn
            // from the same morale figure, but a colour is not a reading — the
            // badge says the number out loud.
            badge={
              <ZoneBadge tone={MORALE_TONE[model.band]}>
                {MORALE_MOOD[model.band]} {formatScore(model.morale)}
              </ZoneBadge>
            }
            ariaLabel={`Lobby. ${model.lobby.companyName}, ${model.lobby.tier} tier, headquartered in ${model.lobby.headquartersCity}. Morale ${formatScore(model.morale)}, ${MORALE_MOOD[model.band].toLowerCase()}. Opens the sites drill-down.`}
            href={sitesDrawer === undefined ? fallbackHref : undefined}
            onActivate={sitesDrawer}
            staggerIndex={0}
          >
            <Floor width={lobbyInner.width} height={lobbyInner.height} />
            <MoraleWash width={lobbyInner.width} height={lobbyInner.height} band={model.band} />
            <LobbyRoom
              companyId={model.companyId}
              band={model.band}
              width={lobbyInner.width}
              height={lobbyInner.height}
              sector={model.sector}
            />
          </ZoneFrame>

          {/* --- executive row -------------------------------------------- */}
          <ZoneFrame
            rect={execRect}
            label="Executive row"
            caption={`${model.execHeadcount} on the leadership payroll`}
            badge={<ZoneBadge tone="brand">{model.executives.length} named</ZoneBadge>}
            ariaLabel="Executive row"
            asGroup
            empty={model.executives.length === 0}
            staggerIndex={1}
          >
            <Floor width={execInner.width} height={execInner.height} />
            <MoraleWash width={execInner.width} height={execInner.height} band={model.band} />
            <ExecutiveBackdrop width={execInner.width} />
          </ZoneFrame>
          <div
            className="pointer-events-none absolute flex items-end gap-1"
            style={{
              left: execRect.x + ZONE_PAD_X,
              top: execRect.y + ZONE_CHROME_Y - 6,
              width: execInner.width,
              height: execInner.height,
            }}
          >
            {model.executives.map((executive) => {
              const label = `${executive.name}, ${executive.title}`;
              const content = (
                <>
                  <svg
                    width={EXEC_CELL.width}
                    height={EXEC_CELL.height}
                    viewBox={`0 0 ${EXEC_CELL.width} ${EXEC_CELL.height}`}
                    role="presentation"
                    focusable="false"
                    aria-hidden="true"
                    className="block"
                  >
                    <ExecutiveDesk executive={executive} band={model.band} />
                  </svg>
                  <span className="mt-0.5 block w-full truncate text-center text-[10px] font-semibold leading-[12px] text-ink">
                    {executive.name}
                  </span>
                  <span className="block w-full truncate text-center text-[9px] leading-[11px] text-ink-faint">
                    {executive.isCeo ? 'Chief executive' : executive.title}
                  </span>
                </>
              );
              const classes =
                'fc-office-desk pointer-events-auto flex flex-col items-center rounded-chip border border-transparent px-0.5 pb-1 pt-0';
              return onOpenCharacter === undefined ? (
                <Link key={executive.characterId} href="/network" className={classes} style={{ width: EXEC_CELL.width }} aria-label={label}>
                  {content}
                </Link>
              ) : (
                <button
                  key={executive.characterId}
                  type="button"
                  className={classes}
                  style={{ width: EXEC_CELL.width }}
                  onClick={() => onOpenCharacter(executive.characterId)}
                  aria-label={label}
                >
                  {content}
                </button>
              );
            })}
            {Array.from({ length: model.unnamedExecDesks }, (_, index) => (
              <svg
                key={`unnamed-${index}`}
                width={EXEC_CELL.width}
                height={EXEC_CELL.height}
                viewBox={`0 0 ${EXEC_CELL.width} ${EXEC_CELL.height}`}
                role="presentation"
                focusable="false"
                aria-hidden="true"
                className="mb-[26px] block shrink-0"
              >
                <AnonymousExecutiveDesk seatId={`${model.companyId}/exec-open/${index}`} band={model.band} />
              </svg>
            ))}
            {model.executives.length === 0 && model.unnamedExecDesks === 0 ? (
              <span className="pointer-events-none px-2 pb-3 text-[11px] text-ink-faint">
                Nobody holds a post here yet.
              </span>
            ) : null}
          </div>

          {/* --- server room ---------------------------------------------- */}
          <ZoneFrame
            rect={serverRect}
            label="Server room"
            caption={
              model.server.racks + model.server.cloudRacks === 0
                ? 'No capacity held'
                : `1 rack ≈ ${countLabel(model.server.acceleratorsPerRack)} · ${formatPct(model.server.utilisation)} utilised`
            }
            badge={
              <ZoneBadge tone={model.server.expiryWarning ? 'warn' : 'info'}>
                {countLabel(model.server.held)}
                {model.server.cloudRacks > 0 ? <span className="text-ink-faint"> · {countLabel(model.server.cloudUnits)} rented</span> : null}
              </ZoneBadge>
            }
            ariaLabel={`Server room. ${countLabel(model.server.owned)} owned and ${countLabel(model.server.reserved)} reserved accelerators, ${countLabel(model.server.cloudUnits)} rented on demand, running at ${formatPct(model.server.utilisation)} utilisation. Opens the compute drill-down.`}
            empty={model.server.racks + model.server.cloudRacks === 0}
            href={serverDrawer === undefined ? fallbackHref : undefined}
            onActivate={serverDrawer}
            staggerIndex={2}
          >
            <Floor width={serverInner.width} height={serverInner.height} />
            <g transform={`translate(0 ${Math.max(0, (serverInner.height - RACK_CELL.height) / 2 + 6)})`}>
              <ServerRoom server={model.server} width={serverInner.width} height={RACK_CELL.height} />
            </g>
          </ZoneFrame>

          {/* --- working rooms -------------------------------------------- */}
          {workRooms.map((zone, index) => {
            if (zone === undefined) return null;
            const rect: Rect = RECT[zone.id];
            const inner = innerOf(rect);
            // The back-wall strip only takes space when there is something on
            // it: no running programmes, no whiteboards, no reserved band.
            const shelf =
              zone.id === 'research' && model.activeProgrammes > 0
                ? 32
                : zone.id === 'sales' && model.activeProducts > 0
                  ? 28
                  : 0;
            const note = zone.crowd.perFigure > 1 ? `, drawn one figure per ${zone.crowd.perFigure}` : '';
            return (
              <ZoneFrame
                key={zone.id}
                rect={rect}
                label={zone.label}
                caption={zone.caption}
                badge={zoneBadge(zone)}
                ariaLabel={zoneAria(zone, note)}
                empty={zone.headcount === 0}
                href={zone.target.kind === 'route' ? zone.target.href : fallbackHref}
                staggerIndex={3 + index}
              >
                <Floor width={inner.width} height={inner.height} />
                <MoraleWash width={inner.width} height={inner.height} band={model.band} />
                <WorkRoom zone={zone} band={model.band} width={inner.width} height={inner.height} shelfHeight={shelf}>
                  {zone.id === 'research' ? <BoardShelf count={model.activeProgrammes} width={inner.width} /> : null}
                  {zone.id === 'sales' ? <CrateShelf count={model.activeProducts} width={inner.width} /> : null}
                </WorkRoom>
              </ZoneFrame>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The compact scene                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The compact stage. Sized to fit two columns of the Command Centre's stat grid
 * on a desktop without scrolling, and to pan inside its own frame below that.
 */
const COMPACT = { width: 496, height: 112 } as const;
/** Figures the compact scene draws, split across the four functions. */
const COMPACT_FIGURES = 5;
const COMPACT_RACKS = 3;

export interface OfficeSceneCompactProps {
  readonly href?: string;
  readonly className?: string;
}

/**
 * The office at a glance, for the Command Centre hero.
 *
 * One room rather than seven: the six drawn figures are split across the four
 * functions in proportion to real headcount, the faces are the same faces the
 * full scene draws (the seat ids are shared), the mouths carry the same morale
 * band, and the racks glow at the same utilisation. It is the same state,
 * smaller.
 */
export function OfficeSceneCompact({ href = '/company', className }: OfficeSceneCompactProps): React.JSX.Element {
  const model = useOfficeModel();

  const figures = useMemo(() => {
    const split = allocate(
      COMPACT_FIGURES,
      model.zones.map((zone) => zone.headcount),
    );
    const out: { readonly seatId: string; readonly zoneId: OfficeWorkZone['id'] }[] = [];
    model.zones.forEach((zone, index) => {
      // Reuse the full scene's own seats, so the same six faces appear in both
      // places. Never more than the room actually drew: a one-person function
      // gets one figure, not a row of clones.
      const filled = zone.seats.filter((seat) => seat.filled);
      const take = Math.min(split[index] ?? 0, filled.length);
      for (let seat = 0; seat < take; seat += 1) {
        const entry = filled[seat];
        if (entry === undefined) continue;
        out.push({ seatId: entry.id, zoneId: zone.id });
      }
    });
    return out;
  }, [model.zones]);

  const litBays = Math.max(0, Math.min(6, Math.round(model.server.utilisation * 6)));
  const rackTone =
    model.server.utilisation >= 0.9 ? 'var(--color-warn)' : model.server.utilisation >= 0.35 ? 'var(--color-gain)' : 'var(--color-info)';
  const ownedRacks = Math.min(COMPACT_RACKS, model.server.racks);
  const racks = Math.min(COMPACT_RACKS, model.server.racks + model.server.cloudRacks);
  const mood = MORALE_MOOD[model.band];

  return (
    <div className={cx('flex min-w-0 flex-col gap-2', className)}>
      <OfficeStyles />
      <Link
        href={href}
        className="scene-frame fc-office block bg-base hover-lift"
        aria-label={`The ${model.lobby.companyName} office: ${model.headcount} people, morale ${formatScore(model.morale)} (${mood.toLowerCase()}), ${countLabel(model.server.held)} accelerator-equivalents held. Opens the Company screen.`}
      >
        <div className="scroll-x">
          <svg
            width={COMPACT.width}
            height={COMPACT.height}
            viewBox={`0 0 ${COMPACT.width} ${COMPACT.height}`}
            role="presentation"
            focusable="false"
            aria-hidden="true"
            className="block"
          >
            <Floor width={COMPACT.width} height={COMPACT.height} />
            <MoraleWash width={COMPACT.width} height={COMPACT.height} band={model.band} />

            {/* frontage */}
            <rect x="8" y="22" width="64" height="26" rx="4" fill="var(--fc-glass)" opacity="0.85" />
            <path d="M8 35h64" stroke="var(--color-panel)" strokeWidth="1.6" opacity="0.8" />
            <g transform="translate(16 70)">
              <Worker look={seatLook(`${model.companyId}/lobby/0`)} role="ops" band={model.band} />
            </g>

            {/* the floor */}
            {figures.map((figure, index) => (
              <g key={`${figure.seatId}:${index}`} transform={`translate(${88 + index * DESK_CELL.width} 44)`}>
                <g transform={`translate(${(DESK_CELL.width - 24) / 2} 6)`}>
                  <Worker look={seatLook(figure.seatId)} role={ROLE_FIGURE[figure.zoneId]} band={model.band} atKeyboard />
                </g>
                <Desk />
              </g>
            ))}

            {/* the racks */}
            {Array.from({ length: racks }, (_, index) => (
              <g key={index} transform={`translate(${COMPACT.width - 12 - (racks - index) * RACK_CELL.width} 30)`}>
                <Rack lit={litBays} tone={rackTone} delayMs={index * 160} rented={index >= ownedRacks} />
              </g>
            ))}
          </svg>
        </div>
      </Link>

      <div className="flex flex-wrap items-center gap-1.5">
        <ZoneBadge tone="brand">{countLabel(model.headcount)} people</ZoneBadge>
        <ZoneBadge tone={MORALE_TONE[model.band]}>
          {mood} · {formatScore(model.morale)}
        </ZoneBadge>
        <ZoneBadge tone={model.server.expiryWarning ? 'warn' : 'info'}>{countLabel(model.server.held)} accel.</ZoneBadge>
        {model.lobby.openRoles > 0 ? <ZoneBadge tone="warn">{model.lobby.openRoles} open</ZoneBadge> : null}
      </div>
    </div>
  );
}

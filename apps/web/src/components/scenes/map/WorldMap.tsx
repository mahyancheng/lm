'use client';

/**
 * The world map.
 *
 * The economy as a *place*: one bay, seven districts, a head office for every
 * company the player can see, civic buildings for the agencies, sheds for the
 * compute domain and a port for the energy that feeds it. The world state is
 * painted over the top of it — compute scarcity as heat on the Flats,
 * geopolitical tension as weather over the strait, the dominant narrative as a
 * banner — and every active public event plants a pulsing pin where it belongs.
 *
 * What the scene is allowed to do:
 *
 * - read the **player's projection** and the session's public register of
 *   agencies through the documented store hooks;
 * - place, size and colour everything from that data, deterministically;
 * - open a drawer, or send the player to the screen that operates the subject.
 *
 * What it never does: invent a figure, leak a private one, animate anything
 * that is not a transform or an opacity, or run a loop in JavaScript.
 *
 * The stage is a fixed 1120 x 560 design canvas inside a `.scene-frame`. The
 * frame scrolls in both axes and the page body does not — panning the map is
 * the intended gesture. Zoom is three fixed stops; at the default stop every
 * tap target clears 44 css px, and zooming out is a deliberate overview.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatPct } from '@frontier/shared';
import { TONE_CHIP, TONE_FILL, cx, type Tone } from '@/components/ui';
import { marketCapOf, usePlayerView, useSession } from '@/lib/game';
import { Citizen, EventPin, SiteArt, Tree, type CitizenRole } from './Buildings';
import { MapDetail } from './Detail';
import {
  DISTRICTS,
  DISTRICT_BY_ID,
  GREEN_SPOTS,
  ISLAND_PATH,
  MAINLAND_PATH,
  MAP_STAGE,
  ROAD_PATHS,
  STORM_EDGE_PATH,
  STRAIT_CROSSING_PATH,
} from './geography';
import { buildWorldMapModel, type MapBuilding, type MapTarget, type WorldMapModel } from './model';
import { MAP_STYLES, MAP_STYLE_ID } from './styles';

/* -------------------------------------------------------------------------- */
/*  Chrome                                                                     */
/* -------------------------------------------------------------------------- */

/** The scene's stylesheet. React dedupes it across every mount on the page. */
function MapStyles(): React.JSX.Element {
  return (
    <style href={MAP_STYLE_ID} precedence="default">
      {MAP_STYLES}
    </style>
  );
}

/** Three fixed zoom stops. The middle one is the design scale. */
const ZOOM_STOPS = [0.7, 1, 1.35] as const;
const DEFAULT_ZOOM = 1;

/** Street life: fixed pitches on the arterial roads. Seeded, never random. */
const STREET_LIFE: readonly { readonly x: number; readonly y: number; readonly role: CitizenRole }[] = [
  { x: 250, y: 344, role: 'engineer' },
  { x: 470, y: 344, role: 'investor' },
  { x: 700, y: 344, role: 'citizen' },
  { x: 336, y: 222, role: 'researcher' },
  { x: 336, y: 470, role: 'engineer' },
  { x: 590, y: 468, role: 'investor' },
];

/** The weather that gathers over the strait when the borders harden. */
const STORM_CLOUDS: readonly { readonly x: number; readonly y: number; readonly scale: number }[] = [
  { x: 872, y: 74, scale: 1 },
  { x: 946, y: 46, scale: 0.78 },
  { x: 858, y: 196, scale: 0.86 },
];

function isActivation(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/* -------------------------------------------------------------------------- */
/*  Interactive wrappers                                                       */
/* -------------------------------------------------------------------------- */

interface HitProps {
  readonly label: string;
  readonly onActivate: () => void;
  readonly children: React.ReactNode;
}

/** A drawn thing that is also a control: pointer, keyboard and a drawn ring. */
function Hit({ label, onActivate, children }: HitProps): React.JSX.Element {
  return (
    <g
      className="fc-map-target"
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (!isActivation(event.key)) return;
        event.preventDefault();
        onActivate();
      }}
    >
      {children}
    </g>
  );
}

/** One placed building, wrapped in its hit box and its focus ring. */
function Site({
  building,
  selected,
  onActivate,
}: {
  readonly building: MapBuilding;
  readonly selected: boolean;
  readonly onActivate: () => void;
}): React.JSX.Element {
  // The box is the silhouette plus the flag above it, never under 46 units —
  // which is 46 css px at the default zoom, clearing the 44px touch floor.
  const width = Math.max(46, building.width + 16);
  const height = Math.max(46, building.height + 26);
  const left = building.x - width / 2;
  const top = building.baseY + 5 - height;
  return (
    <Hit label={building.ariaLabel} onActivate={onActivate}>
      <rect x={left} y={top} width={width} height={height} rx={10} fill="none" pointerEvents="all" />
      <SiteArt building={building} />
      <rect
        className="fc-map-ring"
        x={left}
        y={top}
        width={width}
        height={height}
        rx={10}
        fill="none"
        stroke="var(--color-brand-strong)"
        strokeWidth={2}
        style={selected ? { opacity: 1 } : undefined}
      />
      {building.isPlayer ? (
        <text className="fc-map-name" x={building.x} y={building.baseY + 15} textAnchor="middle" fontSize={9.5} fill="var(--color-brand)">
          Your HQ
        </text>
      ) : null}
    </Hit>
  );
}

/* -------------------------------------------------------------------------- */
/*  The scene                                                                  */
/* -------------------------------------------------------------------------- */

export interface WorldMapProps {
  /**
   * An event to centre on and light up. The host screen sets this from a
   * "show on map" control; the map clears it through `onFocusHandled`. The pin
   * is highlighted, not opened: the reader asked to see it on the map, and has
   * just closed a card about it — a second card over the map would cover the
   * pin they came for. A tap on the pin opens the detail as always.
   */
  readonly focusEventId?: string | null;
  readonly onFocusHandled?: () => void;
  /**
   * Classes for the frame. The frame carries no border of its own, so mount it
   * in a flush `Panel` (which supplies the card) or add `border border-hair
   * shadow-card` here to stand it up on its own.
   */
  readonly className?: string;
}

export function WorldMap({ focusEventId = null, onFocusHandled, className }: WorldMapProps): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();

  const playerMarketCap = marketCapOf(session, view.ownCompany.id);
  const model: WorldMapModel = useMemo(
    () => buildWorldMapModel({ view, agencies: session.agencies, playerMarketCap }),
    [view, session.agencies, playerMarketCap],
  );

  const [target, setTarget] = useState<MapTarget | null>(null);
  /** The event a host screen asked to see: its pin is lit until the reader taps anything. */
  const [focused, setFocused] = useState<string | null>(null);
  const [zoomStop, setZoomStop] = useState<number>(DEFAULT_ZOOM);
  const scroller = useRef<HTMLDivElement | null>(null);
  const centred = useRef(false);

  const zoom = ZOOM_STOPS[zoomStop] ?? 1;

  const centreOn = useCallback(
    (x: number, y: number, smooth: boolean) => {
      const element = scroller.current;
      if (element === null) return;
      const scale = ZOOM_STOPS[zoomStop] ?? 1;
      element.scrollTo({
        left: Math.max(0, x * scale - element.clientWidth / 2),
        top: Math.max(0, y * scale - element.clientHeight / 2),
        behavior: smooth ? 'smooth' : 'auto',
      });
    },
    [zoomStop],
  );

  // First paint opens on the player's own head office rather than the corner
  // of the ocean. It runs once: after that the player owns the viewport.
  const playerSite = model.buildings.find((entry) => entry.isPlayer) ?? null;
  useEffect(() => {
    if (centred.current || playerSite === null) return;
    centred.current = true;
    centreOn(playerSite.x, playerSite.baseY - 40, false);
  }, [playerSite, centreOn]);

  useEffect(() => {
    if (focusEventId === null) return;
    const marker = model.markers.find((entry) => entry.eventId === focusEventId);
    if (marker !== undefined) {
      setFocused(focusEventId);
      centreOn(marker.x, marker.y, true);
    }
    onFocusHandled?.();
  }, [focusEventId, model.markers, centreOn, onFocusHandled]);

  // Any tap on the map is the reader taking over: the lit pin goes back to normal.
  const select = useCallback((next: MapTarget | null) => {
    setFocused(null);
    setTarget(next);
  }, []);

  const overlays = model.overlays;
  const heat = DISTRICT_BY_ID.get('datacentre');
  const reach = DISTRICT_BY_ID.get('frontier');
  const selectedKey =
    target === null ? null : target.kind === 'company' ? target.companyId : target.kind === 'agency' ? target.agencyId : null;

  const summary = `Stylised world map. ${model.buildings.length} sites across ${DISTRICTS.length} districts, ${model.markers.length} active public events. Compute supply ${overlays.computeBand.toLowerCase()}, borders ${overlays.tensionBand.toLowerCase()}.`;

  return (
    <div className={cx('scene-frame relative bg-panel', className)}>
      <MapStyles />

      <div ref={scroller} className="fc-map h-[360px] w-full overflow-auto overscroll-contain sm:h-[460px]">
        <svg
          role="group"
          aria-label={summary}
          width={MAP_STAGE.width * zoom}
          height={MAP_STAGE.height * zoom}
          viewBox={`0 0 ${MAP_STAGE.width} ${MAP_STAGE.height}`}
          style={{ display: 'block' }}
        >
          {/* --- terrain ------------------------------------------------- */}
          <g aria-hidden="true" pointerEvents="none">
            <rect x={0} y={0} width={MAP_STAGE.width} height={MAP_STAGE.height} fill="var(--fc-map-sea)" />
            {[
              'M 862 400 q 14 -6 28 0 t 28 0',
              'M 930 448 q 14 -6 28 0 t 28 0',
              'M 880 500 q 14 -6 28 0 t 28 0',
              'M 1000 356 q 14 -6 28 0 t 28 0',
            ].map((wave) => (
              <path key={wave} d={wave} fill="none" stroke="var(--fc-map-sea-deep)" strokeWidth={2.4} strokeLinecap="round" />
            ))}

            <path d={MAINLAND_PATH} fill="var(--fc-map-land)" stroke="var(--fc-map-shore)" strokeWidth={3} />
            <path d={ISLAND_PATH} fill="var(--fc-map-land)" stroke="var(--fc-map-shore)" strokeWidth={3} />

            {ROAD_PATHS.map((road) => (
              <path key={road} d={road} fill="none" stroke="var(--fc-map-road)" strokeWidth={7} strokeLinecap="round" />
            ))}
            <path
              d={STRAIT_CROSSING_PATH}
              fill="none"
              stroke="var(--fc-map-road)"
              strokeWidth={3}
              strokeDasharray="7 7"
              strokeLinecap="round"
            />

            {GREEN_SPOTS.map((spot) => (
              <Tree key={`${spot.x}-${spot.y}`} x={spot.x} y={spot.y} seed={`tree:${spot.x}:${spot.y}`} />
            ))}
          </g>

          {/* --- district parcels ---------------------------------------- */}
          {DISTRICTS.map((district) => (
            <g key={district.id}>
              <rect
                x={district.parcel.x}
                y={district.parcel.y}
                width={district.parcel.w}
                height={district.parcel.h}
                rx={14}
                fill="var(--fc-map-parcel)"
                stroke="var(--fc-map-parcel-edge)"
                strokeWidth={1.5}
                opacity={0.9}
                pointerEvents="none"
              />
              <rect
                className="fc-map-parcel-hit"
                role="button"
                tabIndex={0}
                aria-label={`${district.name}: ${district.label}. Opens the world-state reading for this district.`}
                x={district.parcel.x}
                y={district.parcel.y}
                width={district.parcel.w}
                height={district.parcel.h}
                rx={14}
                fill="none"
                stroke="var(--color-brand-strong)"
                strokeWidth={2}
                pointerEvents="all"
                onClick={() => select({ kind: 'district', districtId: district.id })}
                onKeyDown={(event) => {
                  if (!isActivation(event.key)) return;
                  event.preventDefault();
                  select({ kind: 'district', districtId: district.id });
                }}
              />
            </g>
          ))}

          {/* --- overlays: world state painted over the ground ------------ */}
          <g aria-hidden="true" pointerEvents="none">
            {heat === undefined ? null : (
              <>
                <rect
                  x={heat.parcel.x}
                  y={heat.parcel.y}
                  width={heat.parcel.w}
                  height={heat.parcel.h}
                  rx={14}
                  fill="var(--fc-map-heat)"
                  opacity={0.05 + overlays.computeTightness * 0.3}
                />
                {overlays.computeTightness < 0.35
                  ? null
                  : [0, 1, 2].map((wisp) => (
                      <path
                        key={wisp}
                        className="fc-map-drift"
                        style={{ ['--fc-delay' as string]: `${wisp * 700}ms`, ['--fc-dur' as string]: '7s' }}
                        d={`M ${heat.parcel.x + 40 + wisp * 60} ${heat.parcel.y - 6} q 10 -10 0 -20 t 0 -18`}
                        fill="none"
                        stroke="var(--fc-map-heat)"
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        opacity={0.2 + overlays.computeTightness * 0.5}
                      />
                    ))}
              </>
            )}

            {reach === undefined ? null : (
              <rect
                x={reach.parcel.x - 10}
                y={reach.parcel.y - 10}
                width={reach.parcel.w + 20}
                height={reach.parcel.h + 20}
                rx={18}
                fill="var(--fc-map-storm)"
                opacity={0.03 + overlays.tension * 0.14}
              />
            )}
            <path
              d={STORM_EDGE_PATH}
              fill="none"
              stroke="var(--fc-map-storm)"
              strokeWidth={3}
              strokeDasharray="11 9"
              strokeLinecap="round"
              opacity={0.12 + overlays.tension * 0.55}
            />
            {STORM_CLOUDS.map((cloud, index) => (
              <g
                key={`${cloud.x}-${cloud.y}`}
                className="fc-map-drift"
                style={{ ['--fc-delay' as string]: `${index * 1100}ms`, ['--fc-dur' as string]: `${8 + index}s` }}
                opacity={0.1 + overlays.tension * 0.5}
              >
                <ellipse cx={cloud.x} cy={cloud.y} rx={22 * cloud.scale} ry={10 * cloud.scale} fill="var(--fc-map-storm)" />
                <ellipse cx={cloud.x - 14 * cloud.scale} cy={cloud.y + 3} rx={13 * cloud.scale} ry={8 * cloud.scale} fill="var(--fc-map-storm)" />
                <ellipse cx={cloud.x + 15 * cloud.scale} cy={cloud.y + 2} rx={14 * cloud.scale} ry={8 * cloud.scale} fill="var(--fc-map-storm)" />
                {overlays.tension < 0.5
                  ? null
                  : [0, 1, 2].map((drop) => (
                      <path
                        key={drop}
                        d={`M ${cloud.x - 12 + drop * 12} ${cloud.y + 12} l -4 10`}
                        stroke="var(--fc-map-storm)"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                      />
                    ))}
              </g>
            ))}
          </g>

          {/* --- the built world ----------------------------------------- */}
          {model.buildings.map((building) => (
            <Site
              key={building.key}
              building={building}
              selected={selectedKey === building.key}
              onActivate={() => select(building.target)}
            />
          ))}

          {/* --- street life --------------------------------------------- */}
          <g aria-hidden="true" pointerEvents="none">
            {STREET_LIFE.map((person, index) => (
              <Citizen
                key={`${person.x}-${person.y}`}
                x={person.x}
                baseY={person.y}
                seed={`citizen:${index}`}
                role={person.role}
                delayMs={index * 340}
              />
            ))}
          </g>

          {/* --- place names --------------------------------------------
              Drawn after the skyline, the way a place name is on any map:
              a tower tall enough to reach the top of its parcel passes
              behind its label rather than over it. */}
          <g aria-hidden="true" pointerEvents="none">
            {DISTRICTS.map((district) => {
              const width = Math.max(district.name.length * 6.4, district.label.length * 5.1) + 20;
              return (
                <g key={district.id}>
                  <rect
                    x={district.parcel.x + 6}
                    y={district.parcel.y + 6}
                    width={width}
                    height={34}
                    rx={9}
                    fill="var(--fc-map-parcel)"
                    stroke="var(--fc-map-parcel-edge)"
                    strokeWidth={1}
                  />
                  <text className="fc-map-name" x={district.parcel.x + 16} y={district.parcel.y + 21} fontSize={11.5} fill="var(--color-ink)">
                    {district.name}
                  </text>
                  <text
                    className="fc-map-name"
                    x={district.parcel.x + 16}
                    y={district.parcel.y + 34}
                    fontSize={9.5}
                    fontWeight={600}
                    fill="var(--color-ink-faint)"
                  >
                    {district.label}
                  </text>
                </g>
              );
            })}
          </g>

          {/* --- active public events ------------------------------------ */}
          {model.markers.map((marker, index) => (
            <Hit
              key={marker.eventId}
              label={marker.ariaLabel}
              onActivate={() => select({ kind: 'event', eventId: marker.eventId })}
            >
              <circle cx={marker.x} cy={marker.y} r={23} fill="none" pointerEvents="all" />
              <circle
                className="fc-map-ring"
                cx={marker.x}
                cy={marker.y}
                r={23}
                fill="none"
                stroke="var(--color-brand-strong)"
                strokeWidth={2}
                style={(target !== null && target.kind === 'event' && target.eventId === marker.eventId) || focused === marker.eventId ? { opacity: 1 } : undefined}
              />
              <EventPin
                x={marker.x}
                y={marker.y}
                tone={marker.tone}
                delayMs={index * 320}
                selected={(target !== null && target.kind === 'event' && target.eventId === marker.eventId) || focused === marker.eventId}
              />
            </Hit>
          ))}
        </svg>
      </div>

      {/* --- the headline banner ---------------------------------------- */}
      <button
        type="button"
        className="panel-surface animate-pop-in hover-lift press-pop absolute left-3 top-3 max-w-[min(320px,calc(100%-1.5rem))] rounded-card px-3 py-2 text-left"
        onClick={() => select({ kind: 'district', districtId: 'media' })}
      >
        <span className="label-caps">The story this quarter</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={cx('inline-block size-2 rounded-full', TONE_FILL[overlays.banner.tone])} />
          <span className="text-[13px] font-bold text-ink">{overlays.banner.label}</span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-ink-dim">{overlays.banner.line}</span>
        <span className="mt-1.5 flex flex-wrap gap-1">
          <span className={cx('figure rounded-pill border px-1.5 text-[10px] leading-[15px]', TONE_CHIP.info)}>
            attention {formatPct(overlays.banner.attention)}
          </span>
          <span
            className={cx(
              'figure rounded-pill border px-1.5 text-[10px] leading-[15px]',
              TONE_CHIP[overlays.banner.controversy >= 0.6 ? 'warn' : 'neutral'],
            )}
          >
            controversy {formatPct(overlays.banner.controversy)}
          </span>
        </span>
      </button>

      {/* --- the overlay legend ----------------------------------------- */}
      <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-7.5rem)] flex-wrap gap-1.5">
        <LegendChip
          tone={overlays.computeTone}
          label="Compute"
          value={overlays.computeBand}
          onClick={() => select({ kind: 'district', districtId: 'datacentre' })}
        />
        <LegendChip
          tone={overlays.tensionTone}
          label="Borders"
          value={overlays.tensionBand}
          onClick={() => select({ kind: 'district', districtId: 'frontier' })}
        />
        {model.markers.length === 0 ? null : (
          <span className={cx('inline-flex items-center rounded-pill border px-2 py-px text-[10px] font-semibold', TONE_CHIP.neutral)}>
            {model.markers.length} live event{model.markers.length === 1 ? '' : 's'}
          </span>
        )}
        {model.unplaced.length === 0 ? null : (
          <span
            className={cx('inline-flex items-center rounded-pill border px-2 py-px text-[10px] font-semibold', TONE_CHIP.neutral)}
            title={model.unplaced.join(', ')}
          >
            +{model.unplaced.length} off map
          </span>
        )}
      </div>

      {/* --- zoom -------------------------------------------------------- */}
      <div className="absolute bottom-3 right-3 flex gap-1.5">
        <button
          type="button"
          className="btn tap-target w-11 justify-center"
          aria-label="Zoom out"
          disabled={zoomStop === 0}
          onClick={() => setZoomStop((stop) => Math.max(0, stop - 1))}
        >
          <span aria-hidden="true">&minus;</span>
        </button>
        <button
          type="button"
          className="btn tap-target w-11 justify-center"
          aria-label="Zoom in"
          disabled={zoomStop === ZOOM_STOPS.length - 1}
          onClick={() => setZoomStop((stop) => Math.min(ZOOM_STOPS.length - 1, stop + 1))}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      <MapDetail target={target} model={model} onClose={() => select(null)} onSelect={select} />
    </div>
  );
}

function LegendChip({
  tone,
  label,
  value,
  onClick,
}: {
  readonly tone: Tone;
  readonly label: string;
  readonly value: string;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'press-pop inline-flex items-center gap-1 rounded-pill border px-2 py-px text-[10px] font-semibold max-sm:min-h-11 max-sm:px-3',
        TONE_CHIP[tone],
      )}
    >
      <span className="inline-block size-1.5 rounded-full bg-current" />
      {label}: {value}
    </button>
  );
}

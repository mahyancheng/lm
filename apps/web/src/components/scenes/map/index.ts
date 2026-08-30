/**
 * The world map scene.
 *
 * ```tsx
 * import { WorldMap } from '@/components/scenes/map';
 * ```
 *
 * `WorldMap` is the whole surface: the drawn world, the world-state overlays,
 * the event markers and the detail drawer they open. It reads the player's
 * projection through the documented store hooks and takes no data props — the
 * only props it accepts steer it from the host screen ("show this event on the
 * map") and style its frame.
 */

export { WorldMap } from './WorldMap';
export type { WorldMapProps } from './WorldMap';

export { MapDetail } from './Detail';
export type { MapDetailProps } from './Detail';

export {
  DISTRICTS,
  DISTRICT_BY_ID,
  DISTRICT_IDS,
  DISTRICT_LANDMARKS,
  MAP_STAGE,
  MARKER_OFFSETS,
} from './geography';
export type { BuildingGlyph, DistrictGeography, DistrictId, LandmarkSeed, Parcel, Plot, Point } from './geography';

export {
  buildOverlays,
  buildWorldMapModel,
  computeTightnessOf,
  districtForCompany,
  districtForEvent,
  districtReadings,
  formatReading,
  humaniseToken,
  initialsOfName,
  pickIndex,
  tensionOf,
  towerHeight,
  towerWidth,
} from './model';
export type { MapBuilding, MapMarker, MapOverlays, MapTarget, NarrativeBanner, Reading, WorldMapModel } from './model';

export { MAP_STYLES, MAP_STYLE_ID } from './styles';

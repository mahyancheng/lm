/**
 * The HQ office scene.
 *
 * ```tsx
 * import { OfficeScene, OfficeSceneCompact } from '@/components/scenes/office';
 * ```
 *
 * `OfficeScene` is the full floor plan for the Company screen; it takes
 * optional handlers so the host screen can answer the zones that drill into a
 * drawer rather than a route. `OfficeSceneCompact` is the Command Centre hero:
 * the same state, one room, no drawers.
 */

export { OfficeScene, OfficeSceneCompact, STAGE } from './OfficeScene';
export type { OfficeSceneCompactProps, OfficeSceneProps } from './OfficeScene';

export {
  EXECUTIVE_DESK_CAP,
  MORALE_MOOD,
  MORALE_TONE,
  OFFICE_ZONE_IDS,
  RACK_CAP,
  WORK_ZONES,
  buildOfficeModel,
  countLabel,
  moraleBand,
  rackPlan,
} from './model';
export type {
  MoraleBand,
  OfficeDrawerId,
  OfficeExecutive,
  OfficeLobby,
  OfficeModel,
  OfficeSeat,
  OfficeServerRoom,
  OfficeWorkZone,
  OfficeZoneId,
  OfficeZoneTarget,
} from './model';

export { allocate, crowd, seatId, seatLook } from './seats';
export type { Crowd, SeatLook } from './seats';

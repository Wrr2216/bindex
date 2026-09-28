/**
 * The tracking core's public surface. Features that build on it (BLE, GPS,
 * placement, operations insights) import from here; docs/tracking-core.md
 * describes the model and the contract.
 */
export { recordSightings, type RecordOptions, type RecordResult } from "./ingest";
export { resolveCode, resolveCodes, type ResolvedAsset, type ResolveSource } from "./resolve";
export { requireDevice, presentedToken, type RequireDeviceOptions } from "./auth";
export {
  channelOf,
  createDevice,
  deleteDevice,
  findDeviceByToken,
  getDevice,
  getDeviceRow,
  listDevices,
  revokeDeviceToken,
  rotateDeviceToken,
  updateDevice,
  updateDeviceStatus,
  type DeviceInput,
  type DeviceView,
} from "./devices";
export {
  getFeed,
  getItemPositions,
  listItemSightings,
  listPresent,
  type FeedPage,
  type PositionView,
  type SightingPage,
  type SightingView,
} from "./queries";
export { pruneSightings, startSightingsPrune } from "./prune";
export { inferDirection, splitPasses, PortalTracker, DEFAULT_PORTAL_WINDOW_MS } from "./direction";
export { normalizeCode } from "./normalize";
export { zoneFor, type ZoneDecision } from "./zones";
export {
  DEFAULT_TECH,
  REPORTING_KINDS,
  RFID_KINDS,
  readSettings,
  type NormalizedRead,
  type PortalSettings,
  type PortalSide,
  type SightingDirection,
  type SightingTech,
  type TrackingDevice,
  type TrackingDeviceKind,
  type TrackingDeviceSettings,
} from "./types";

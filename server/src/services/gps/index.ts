/**
 * GPS trackers, maps and geofences: the public surface. docs/gps.md describes
 * the model, the protocols and the events.
 */
import { wireShipmentHooks } from "./shipments";

// Delivery ends a shipment's tracker links; registered once, on first import.
wireShipmentHooks();

export * from "./geo";
export {
  compileFence,
  containment,
  distanceToFenceM,
  normalizeGeometry,
  signedDistanceM,
  stepFence,
  zoneFromFences,
  GeometryError,
  OUTSIDE,
  type CompiledFence,
  type Containment,
  type FenceState,
  type FenceTransition,
} from "./fence";
export { screenFix, impliedSpeedMps, EMPTY_FILTER, REANCHOR_AFTER, type FilterState, type FixPoint } from "./filter";
export { averageSpeedMps, estimateArrival, pushRecent } from "./route";
export { mapTileSources } from "./tiles";
export {
  parseOsmAnd,
  parseTraccarClientJson,
  parseTraccarForward,
  parseGpsBatch,
  parseGpsTime,
  firstDeviceKey,
  toMps,
  SPEED_UNITS,
  type GpsFix,
  type GpsPayload,
  type GpsReport,
  type SpeedUnit,
} from "./protocols";
export { readTrackerSettings, type TrackerSettings } from "./settings";
export {
  activeFences,
  createGeofence,
  deleteGeofence,
  fenceForLocation,
  getGeofence,
  invalidateFences,
  listGeofences,
  updateGeofence,
  type GeofenceInput,
  type GeofenceView,
} from "./geofences";
export { ingestTrackerReports, planBatch, trackerForKey, type GpsIngestResult } from "./ingest";
export {
  createLink,
  endLink,
  getTracker,
  getTrackerDevice,
  listLinks,
  listTrackers,
  setTrackerStatus,
  updateTrackerSettings,
  type Actor,
  type LinkInput,
  type LinkView,
  type TrackerView,
} from "./trackers";
export { dismissPrompt, readShipmentGps, type ShipmentGps } from "./shipments";
export {
  itemTrail,
  listGeofenceEvents,
  openShipments,
  shipmentMap,
  trackerTrail,
  type GeofenceEventView,
  type ShipmentMap,
  type Trail,
  type TrailPoint,
} from "./queries";
export { startGpsPrune, pruneGeofenceEvents } from "./prune";
export { clearGpsTables, exportGpsTables, restoreGpsTables, GPS_TABLES } from "./backup";

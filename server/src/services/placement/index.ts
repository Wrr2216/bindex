/**
 * Placement guidance: the public surface. docs/placement.md describes the
 * rules and the extension points; import from here, not the files behind it.
 */
import "./model";

export { MISPLACED, VIA } from "./model";
export { buildTree, relation, within, floorOf, isFloorName, pathNames, type Tree, type Relation } from "./tree";
export { floorColor, floorNumber, FLOOR_PALETTE, type FloorColors } from "./colors";
export { belongsIn, planReaderReads, planSweep, decideCard, type PlacementLine } from "./match";
export { proposeDestinations, type Proposal } from "./propose";
export { tally, tallyBy, afterDeliveryReason, type Tally } from "./progress";
export { registerHandlingNotes, handlingKey, type HandlingNotesProvider } from "./handling";
export { loadTree, forgetTree, type LineView, type Place } from "./data";
export { listPlacementJobs, jobProgress, setFloorColors, type JobProgress } from "./jobs";
export { lookup, placeLines, markMissing, roomStatus, sweep, type Card, type RoomStatus, type SweepResult, type Who } from "./scan";
export { getRoomMap, setRoomMap, proposals, applyProposals } from "./destinations";
export { kioskFeed, type KioskPage } from "./kiosk";
export { listObservations } from "./observations";
export {
  applyReads,
  bleAvailable,
  processNewSightings,
  readersStatus,
  setReaderPlacement,
  startPlacementReaders,
} from "./readers";
export { exportPlacementTables, restorePlacementTables, PLACEMENT_TABLES } from "./backup";

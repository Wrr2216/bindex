/** Shapes returned by /api/consumables. Quantities are plain numbers, money is cents. */

export type StockReason = "receive" | "issue" | "return" | "transfer" | "consume" | "adjust" | "count";

export interface LevelView {
  itemId: string;
  locationId: string;
  locationName: string;
  qty: number;
  low: boolean;
}

export interface CatalogRow {
  itemId: string;
  name: string;
  assetCode: string;
  valueCents: number | null;
  imageUrl: string | null;
  unit: string;
  reorderPoint: number | null;
  reorderQty: number | null;
  supplier: string | null;
  onHand: number;
  outstanding: number;
  low: boolean;
  levels: LevelView[];
}

export interface HolderBalance {
  holderId: string;
  holderName: string;
  itemId: string;
  itemName: string;
  unit: string;
  balance: number;
  valueCents: number | null;
}

export interface Movement {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  reason: StockReason;
  qty: number;
  fromLocationId: string | null;
  fromLocationName: string | null;
  toLocationId: string | null;
  toLocationName: string | null;
  holderId: string | null;
  holderName: string | null;
  holderDelta: number;
  jobRef: string | null;
  note: string | null;
  unitCostCents: number | null;
  expectedQty: number | null;
  countedQty: number | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ConsumableDetail extends CatalogRow {
  holders: HolderBalance[];
  movements: Movement[];
}

export interface ConsumableSettings {
  unit?: string | null;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  supplier?: string | null;
}

export interface DescribedCode {
  code: string;
  kind: "item" | "location" | "unknown";
  itemId: string | null;
  unitId: string | null;
  locationId: string | null;
  name: string | null;
  assetCode: string | null;
  unitLabel: string | null;
  consumable: boolean;
  outTo: { holderId: string | null; holderName: string } | null;
}

export interface LookupResult {
  match: DescribedCode | null;
  consumable: CatalogRow | null;
}

export interface MovementPayload {
  reason: StockReason;
  itemId: string;
  qty?: number | null;
  delta?: number | null;
  countedQty?: number | null;
  locationId?: string | null;
  toLocationId?: string | null;
  holderId?: string | null;
  jobRef?: string | null;
  note?: string | null;
}

export interface MovementResult {
  movement: Omit<Movement, "itemName" | "unit" | "fromLocationName" | "toLocationName" | "createdByName">;
  levels: { locationId: string; qty: number }[];
}

export interface CountResult {
  locationId: string;
  locationName: string;
  lines: {
    itemId: string;
    itemName: string;
    unit: string;
    expectedQty: number;
    countedQty: number;
    variance: number;
  }[];
}

export interface LocationStock {
  locationId: string;
  locationName: string;
  items: {
    itemId: string;
    name: string;
    assetCode: string;
    unit: string;
    qty: number;
    reorderPoint: number | null;
    low: boolean;
  }[];
}

export interface LowStockRow {
  itemId: string;
  itemName: string;
  unit: string;
  locationId: string | null;
  locationName: string | null;
  qty: number;
  reorderPoint: number;
  reorderQty: number | null;
  supplier: string | null;
}

export interface HolderSummary {
  id: string;
  name: string;
  kind: string | null;
  equipmentOut: number;
  overdue: number;
  suppliesOut: number;
}

export interface EquipmentRow {
  assignmentId: string;
  itemId: string;
  name: string;
  assetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  kitId: string | null;
  jobRef: string | null;
  checkedOutAt: string;
  checkedInAt: string | null;
  expectedReturnAt: string | null;
  overdue: boolean;
}

export interface HolderDetail {
  holder: { id: string; name: string; kind: string | null };
  since: string;
  supplies: HolderBalance[];
  movements: Movement[];
  equipment: {
    since: string;
    wentOut: EquipmentRow[];
    cameBack: EquipmentRow[];
    stillOut: EquipmentRow[];
  };
}

export interface KitLine {
  id: string;
  itemId: string;
  name: string;
  assetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  serial: string | null;
  status: "out" | "returned" | "unknown";
  checkedOutAt: string | null;
  checkedInAt: string | null;
}

export interface KitSummary {
  id: string;
  holderId: string | null;
  holderName: string;
  expectedReturnAt: string | null;
  jobRef: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  total: number;
  outCount: number;
  returnedCount: number;
  overdue: boolean;
}

export interface KitDetail extends KitSummary {
  lines: KitLine[];
  missing: KitLine[];
}

export interface KitFailure {
  itemId: string;
  unitId: string | null;
  name: string | null;
  error: string;
}

export interface OverdueLine extends KitLine {
  kitId: string;
  holderId: string | null;
  holderName: string;
  expectedReturnAt: string | null;
}

export interface KitLineInput {
  itemId: string;
  unitId?: string | null;
}

export interface ReturnResult {
  returned: {
    itemId: string;
    unitId: string | null;
    name: string;
    fromHolderId: string | null;
    fromHolderName: string;
    wrongHolder: boolean;
  }[];
  notOut: { itemId: string; unitId: string | null; name: string | null }[];
  stillOut: EquipmentRow[];
}

export interface UsageTotals {
  issued: number;
  returned: number;
  consumed: number;
  used: number;
  costCents: number;
}

export interface UsageReport {
  from: string;
  to: string;
  byHolder: (UsageTotals & {
    holderId: string | null;
    holderName: string;
    itemId: string;
    itemName: string;
    unit: string;
  })[];
  holderTotals: { holderId: string | null; holderName: string; costCents: number; lines: number }[];
  byItem: (UsageTotals & {
    itemId: string;
    itemName: string;
    unit: string;
    unitCostCents: number | null;
    received: number;
    shrinkage: number;
  })[];
  totalCostCents: number;
}

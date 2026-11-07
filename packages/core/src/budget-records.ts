import type {
  BudgetAdjustment,
  BudgetAudit,
  BudgetCostReview,
  BudgetReservation,
} from "./budget";

export type BudgetRecordCollection =
  | "adjustments"
  | "reservations"
  | "audit"
  | "costReviews";
export type BudgetRecord =
  | BudgetAdjustment
  | BudgetReservation
  | BudgetAudit
  | BudgetCostReview;
/** Complete all-period admin ledger, newest appended record first. Cursor binds the exact collection. */
export interface BudgetRecordPage {
  collection: BudgetRecordCollection;
  items: BudgetRecord[];
  total: number;
  offset: number;
  pageSize: 50;
  snapshotHash: string;
  nextCursor: string | null;
}

import type { Building } from "./index";
export type Quantity = number | null;
export const quantityProduct = (...values: Quantity[]): Quantity =>
  values.some((v) => v === null)
    ? null
    : (values as number[]).reduce((s, v) => s * v, 1);
export const quantitySum = (...values: Quantity[]): Quantity =>
  values.some((v) => v === null)
    ? null
    : (values as number[]).reduce((s, v) => s + v, 0);
export const quantityDifference = (
  left: Quantity,
  right: Quantity,
): Quantity => (left === null || right === null ? null : left - right);
export const quantityRatio = (
  numerator: Quantity,
  denominator: Quantity,
): Quantity =>
  numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
export interface QuantityCoverage {
  value: Quantity;
  knownSubtotal: Quantity;
  missingBuildingIds: string[];
}
export function aggregateBuildingQuantity(
  buildings: readonly Building[],
  select: (building: Building) => Quantity,
): QuantityCoverage {
  let subtotal = 0,
    known = 0;
  const missingBuildingIds: string[] = [];
  for (const b of buildings) {
    const value = select(b);
    if (value === null) {
      missingBuildingIds.push(b.id);
      continue;
    }
    if (!Number.isFinite(value))
      throw new Error(
        "A building quantity must be finite or explicitly unknown.",
      );
    subtotal += value;
    known++;
  }
  return {
    value: missingBuildingIds.length ? null : subtotal,
    knownSubtotal: known || !buildings.length ? subtotal : null,
    missingBuildingIds,
  };
}

import type { Command, Scenario } from "./index";
const reserved = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);
export function isSafeFeatureIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value) &&
    !reserved.has(value)
  );
}
export function assertFeatureIdentifier(
  value: unknown,
): asserts value is string {
  if (!isSafeFeatureIdentifier(value))
    throw new Error(
      "Feature identifiers must be ordinary IDs, not reserved object-property names.",
    );
}
export function assertFeatureEditRecords(
  scenario: Pick<Scenario, "buildingEdits" | "roadEdits" | "parcelEdits">,
): void {
  for (const edits of [
    scenario.buildingEdits,
    scenario.roadEdits,
    scenario.parcelEdits,
  ]) {
    if (!edits) continue;
    const proto = Object.getPrototypeOf(edits);
    if (proto !== Object.prototype && proto !== null)
      throw new Error("Feature edit records must not have a custom prototype.");
    for (const [id, value] of Object.entries(edits)) {
      assertFeatureIdentifier(id);
      if (value && value.id !== id)
        throw new Error("Feature edit key must match its identifier.");
    }
  }
}
export function assertCommandFeatureIdentifiers(command: Command): void {
  if (command.type === "building.upsert")
    assertFeatureIdentifier(command.building.id);
  if (command.type === "road.upsert") assertFeatureIdentifier(command.road.id);
  if (command.type === "parcel.upsert")
    assertFeatureIdentifier(command.parcel.id);
  if (
    command.type === "building.remove" ||
    command.type === "road.remove" ||
    command.type === "parcel.remove"
  )
    assertFeatureIdentifier(command.id);
  if (command.type === "buildings.import")
    command.buildings.forEach((b) => assertFeatureIdentifier(b.id));
  if (command.type === "parcels.import" || command.type === "parcels.replace")
    command.parcels.forEach((p) => assertFeatureIdentifier(p.id));
  if (command.type === "parcels.replace")
    command.removeIds.forEach(assertFeatureIdentifier);
}

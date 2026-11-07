import { isDeepStrictEqual } from "node:util";
import {
  canonicalJSON,
  type Place,
  type Project,
  type Scenario,
  type VehicleAvailability,
} from "@urban/core";
import { ApiError } from "./errors.js";
import {
  readPlaceVehicleReference,
  VehicleReferenceError,
} from "./data/acs-vehicles.js";

export function projectVehicleReferences(
  project: Project,
): VehicleAvailability[] {
  return [
    ...[
      ...project.scenarios,
      ...project.history.flatMap((e) => [e.before, e.after]),
      ...project.undone.flatMap((e) => [e.before, e.after]),
    ].flatMap((s) =>
      s.activity?.vehicleReference ? [s.activity.vehicleReference] : [],
    ),
    ...[...project.history, ...project.undone].flatMap((e) =>
      e.command.type === "scenario.activity" &&
      e.command.activity?.vehicleReference
        ? [e.command.activity.vehicleReference]
        : [],
    ),
  ];
}
function evidence(reference: VehicleAvailability) {
  // Retrieval timestamps may differ across an exported source capture, while the complete
  // official source hash, values, uncertainty, scope and attribution must still agree.
  const copy = structuredClone(reference);
  copy.retrievedAt = "";
  if (copy.sourceFile) copy.sourceFile.retrievedAt = "";
  return copy;
}
export async function validateVehicleReferences(
  references: readonly VehicleAvailability[],
  place: Place,
  trusted: readonly VehicleAvailability[] = [],
  filename?: string,
) {
  const known = new Set(
    [
      ...trusted,
      ...(place.vehicleAvailability ? [place.vehicleAvailability] : []),
    ].map((r) => canonicalJSON(evidence(r))),
  );
  const pending = [
    ...new Map(
      references.map((r) => [canonicalJSON(evidence(r)), r]),
    ).entries(),
  ].filter(([key]) => !known.has(key));
  if (!pending.length) return;
  let official: VehicleAvailability;
  try {
    official = await readPlaceVehicleReference(place, filename);
  } catch (error) {
    if (!(error instanceof VehicleReferenceError)) throw error;
    throw new ApiError(
      422,
      "VEHICLE_REFERENCE_UNVERIFIED",
      "This new Census vehicle reference cannot be verified against the prepared source. Keep an already captured reference, prepare its matching source supplement, or enter a clearly labeled local reference.",
    );
  }
  for (const [, reference] of pending)
    if (!isDeepStrictEqual(evidence(reference), evidence(official)))
      throw new ApiError(
        422,
        "VEHICLE_REFERENCE_MISMATCH",
        "The adopted vehicle reference does not match the prepared official values, uncertainty, scope and source. Reload the reference before saving.",
      );
}
export const scenarioVehicleReferences = (scenario: Scenario) =>
  scenario.activity?.vehicleReference
    ? [scenario.activity.vehicleReference]
    : [];

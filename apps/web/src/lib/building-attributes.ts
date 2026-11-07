import { USER_BUILDING_SOURCE, type Building } from "@urban/core";

const quantities = [
  "height",
  "floors",
  "units",
  "jobs",
  "parkingSpaces",
] as const;

/** Attribute edits are explicit assumptions. Geometry-only edits never fill
 * missing quantities or overwrite their captured provenance. */
export function withBuildingAttributeEdits(
  building: Building,
  patch: Partial<Building>,
): Building {
  const fields = { ...building.attributeProvenance?.fields };
  let touched = false;
  for (const field of quantities) {
    if (!Object.hasOwn(patch, field)) continue;
    touched = true;
    const value = patch[field];
    fields[field] = {
      status:
        value === null
          ? "missing"
          : patch.program && (field === "units" || field === "jobs")
            ? "derived"
            : "assumed",
      sourceId: USER_BUILDING_SOURCE.id,
      method:
        value === null
          ? "Explicitly left unknown in the building editor."
          : patch.program && (field === "units" || field === "jobs")
            ? "Sum of the explicitly reviewed program components."
            : "User-entered planning assumption, reviewed before Apply.",
    };
  }
  return {
    ...building,
    ...patch,
    ...(touched || Object.hasOwn(patch, "use")
      ? {
          attributeProvenance: {
            ...building.attributeProvenance,
            version: 1 as const,
            fields,
            ...(Object.hasOwn(patch, "use")
              ? {
                  use: {
                    status: patch.program
                      ? ("derived" as const)
                      : ("assumed" as const),
                    sourceId: USER_BUILDING_SOURCE.id,
                    method: patch.program
                      ? "Land use derived from the reviewed program components."
                      : "User-reviewed building use.",
                  },
                }
              : {}),
          },
        }
      : {}),
    attributeSourceId: USER_BUILDING_SOURCE.id,
    estimated: true,
  } as Building;
}

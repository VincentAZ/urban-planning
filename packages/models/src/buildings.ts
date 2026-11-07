import {
  applyBuildingGeometry,
  assertBuildingProgram,
  buildingAreaSqm,
  buildingGeometry,
  buildingAnchor,
  buildingProgramWarnings,
  buildingProgramUse,
  buildingTypologyLabels,
  buildingTypologyUse,
  ILLUSTRATIVE_BUILDING_SOURCE,
  USER_BUILDING_SOURCE,
  type Assumptions,
  type Building,
  type BuildingTypology,
  type BuildingProgramComponent,
  type Position,
} from "@urban/core";
import { buildingPreset, defaultAssumptions } from "./helpers";
/** Explicitly adopts the legacy interpretation; no new observed facts are introduced. */
export function adoptBuildingProgram(
  building: Building,
  assumptions: Assumptions = defaultAssumptions(),
): Building {
  if (building.program) return structuredClone(building);
  const b = structuredClone(building);
  if (b.floors === null || b.units === null || b.jobs === null)
    throw new Error(
      "Review unknown floors, homes and jobs before adopting an explicit program; missing quantities cannot become zero.",
    );
  const area = buildingAreaSqm(b),
    floor = ["park", "vacant"].includes(b.use) ? 0 : area * b.floors;
  const components: BuildingProgramComponent[] = [];
  if (b.use === "mixed-use") {
    if (floor < area)
      throw new Error(
        "Legacy mixed-use has less than one floor; explicitly allocate its program before adoption.",
      );
    const retail = Math.min(area, floor);
    components.push({
      id: "residential",
      name: "Legacy residential allocation",
      use: "multifamily",
      residentialSubtype: "apartment",
      grossFloorAreaSqm: floor - retail,
      units: b.units,
      jobs: 0,
      tripRate: {
        value: assumptions.tripRates["mixed-use"],
        basis: "occupied-dwelling",
        sourceId: USER_BUILDING_SOURCE.id,
      },
      sourceId: ILLUSTRATIVE_BUILDING_SOURCE.id,
    });
    components.push({
      id: "retail",
      name: "Legacy assumed retail floor",
      use: "retail",
      grossFloorAreaSqm: retail,
      units: 0,
      jobs: b.jobs,
      sourceId: ILLUSTRATIVE_BUILDING_SOURCE.id,
    });
  } else if (!["park", "vacant"].includes(b.use)) {
    const residential = ["residential", "multifamily"].includes(b.use);
    // A legacy nonresidential feature may contain entered homes. Preserve them in
    // a separate zero-area residential row instead of deleting the entered count.
    if (!residential && b.units > 0)
      components.push({
        id: "retained-homes",
        name: "Retained homes; allocate floor area",
        use: "multifamily",
        grossFloorAreaSqm: 0,
        units: b.units,
        jobs: 0,
        residentialSubtype: "apartment",
        sourceId: USER_BUILDING_SOURCE.id,
      });
    components.push({
      id: "primary",
      use: b.use as BuildingProgramComponent["use"],
      grossFloorAreaSqm: floor,
      units: residential ? b.units : 0,
      jobs: b.jobs,
      ...(residential
        ? {
            residentialSubtype:
              b.typology === "townhome"
                ? ("townhome" as const)
                : b.use === "residential"
                  ? ("single-family" as const)
                  : ("apartment" as const),
          }
        : {}),
      sourceId: USER_BUILDING_SOURCE.id,
    });
  }
  const result: Building = {
    ...b,
    program: {
      version: 1,
      grossFloorAreaSqm: floor,
      commonAreaSqm: 0,
      components,
    },
    programSourceId: USER_BUILDING_SOURCE.id,
    estimated: true,
  };
  result.use = buildingProgramUse(result.program!, result.use);
  assertBuildingProgram(result);
  return result;
}
export function typedBuildingPreset(
  typology: BuildingTypology,
  center: Position,
): import("@urban/core").KnownBuilding {
  const use = buildingTypologyUse[typology];
  let b: Building = buildingPreset(use, center);
  if (typology === "townhome")
    b = { ...b, units: 6, floors: 3, height: 10.2, parkingSpaces: 9 };
  if (typology === "hospital")
    b = { ...b, floors: 6, height: 24, jobs: 450, parkingSpaces: 300 };
  b = applyBuildingGeometry(b, buildingGeometry(b));
  b = adoptBuildingProgram({
    ...b,
    typology,
    name: `New ${buildingTypologyLabels[typology].toLowerCase()}`,
  });
  b.sourceId = USER_BUILDING_SOURCE.id;
  b.programSourceId = ILLUSTRATIVE_BUILDING_SOURCE.id;
  b.attributeSourceId = ILLUSTRATIVE_BUILDING_SOURCE.id;
  for (const c of b.program!.components) {
    if (typology === "mixed-use")
      c.name = c.use === "multifamily" ? "Apartment space" : "Retail space";
    c.sourceId = ILLUSTRATIVE_BUILDING_SOURCE.id;
    if (c.tripRate) c.tripRate.sourceId = ILLUSTRATIVE_BUILDING_SOURCE.id;
    if (c.parkingRate) c.parkingRate.sourceId = ILLUSTRATIVE_BUILDING_SOURCE.id;
    if (typology === "hospital") c.beds = 120;
  }
  return b as import("@urban/core").KnownBuilding;
}
export function previewBuildingConversion(
  building: Building,
  typology: BuildingTypology,
  mode: "preserve-program" | "typed-defaults",
  assumptions?: Assumptions,
): { building: Building; warnings: string[] } {
  if (mode === "preserve-program") {
    const next = { ...adoptBuildingProgram(building, assumptions), typology };
    return {
      building: next,
      warnings: [
        ...buildingProgramWarnings(next),
        "Entered program uses and quantities are retained. Changing the library typology alone does not convert that program or alter its homes/jobs.",
      ],
    };
  }
  const defaults = typedBuildingPreset(typology, buildingAnchor(building));
  const { footprint: _footprint, geometry: _geometry, ...retained } = building;
  const next = applyBuildingGeometry(
    {
      ...retained,
      ...defaults,
      id: building.id,
      name: building.name,
      sourceId: building.sourceId,
      attributeSourceId: ILLUSTRATIVE_BUILDING_SOURCE.id,
      ...(building.attributeProvenance
        ? {
            attributeProvenance: {
              version: 1 as const,
              fields: Object.fromEntries(
                ["height", "floors", "units", "jobs", "parkingSpaces"].map(
                  (field) => [
                    field,
                    {
                      status: "assumed" as const,
                      sourceId: ILLUSTRATIVE_BUILDING_SOURCE.id,
                      method: "Explicitly reviewed typed-default conversion",
                    },
                  ],
                ),
              ),
              use: {
                status: "assumed" as const,
                sourceId: ILLUSTRATIVE_BUILDING_SOURCE.id,
                method: "Explicitly reviewed typed-default conversion",
              },
            },
          }
        : {}),
      ...(building.sourceFeatureId
        ? { sourceFeatureId: building.sourceFeatureId }
        : {}),
    },
    buildingGeometry(building),
  );
  // Geometry is retained, so changing program defaults does not relabel its source.
  if (building.geometrySourceId)
    next.geometrySourceId = building.geometrySourceId;
  else delete next.geometrySourceId;
  if (next.floors === null)
    throw new Error("Typed defaults require a known floor count.");
  const target = buildingAreaSqm(next) * next.floors,
    old = next.program!.grossFloorAreaSqm;
  next.program = {
    ...next.program!,
    grossFloorAreaSqm: target,
    commonAreaSqm: 0,
    components: next.program!.components.map((c) => ({
      ...c,
      grossFloorAreaSqm: old ? (c.grossFloorAreaSqm * target) / old : 0,
    })),
  };
  assertBuildingProgram(next);
  return {
    building: next,
    warnings: [
      ...buildingProgramWarnings(next),
      "Typed defaults replace floors, height, homes, jobs, parking supply, and the component program. Footprint and identity are retained; defaults are illustrative, not observed or locally calibrated.",
    ],
  };
}

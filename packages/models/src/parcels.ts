import { aggregateBuildingQuantity } from "@urban/core";
import {
  area,
  difference,
  featureCollection,
  intersect,
  polygon,
  union,
} from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  geometryDifferenceAreaSqm,
  geometryIntersectionAreaSqm,
  buildingGeometry,
  buildingProgramTotals,
  materializeBuildings,
  materializeParcels,
  parcelAreaSqm,
  studyAreaBounds,
  type Building,
  type Parcel,
  type Place,
  type Scenario,
  type StudyAreaGeometry,
} from "@urban/core";

export interface ParcelDevelopment {
  quantityCoverage: {
    floorArea: import("@urban/core").QuantityCoverage;
    units: import("@urban/core").QuantityCoverage;
    jobs: import("@urban/core").QuantityCoverage;
  };
  containedBuildingIds: string[];
  straddlingBuildingIds: string[];
  declaredLinkMismatchIds: string[];
  buildingCount: number;
  grossFloorAreaSqm: number | null;
  footprintUnionSqm: number | null;
  far: number | null;
  lotCoveragePercent: number | null;
  units: number | null;
  jobs: number | null;
  status: "ready" | "incomplete";
  caveats: string[];
}
export interface ParcelContext {
  parcel: Parcel;
  areaSqm: number;
  baseline: ParcelDevelopment;
  proposal: ParcelDevelopment;
  warnings: string[];
}
type Shape = Feature<Polygon | MultiPolygon>;
type IndexedBuilding = {
  building: Building;
  bounds: [number, number, number, number];
};
const index = new WeakMap<Building[], IndexedBuilding[]>();
const feature = (geometry: StudyAreaGeometry): Shape => ({
  type: "Feature",
  properties: {},
  geometry,
});
function indexedBuildings(buildings: Building[]) {
  const cached = index.get(buildings);
  if (cached) return cached;
  const result = buildings
    .filter((b) => b.use !== "park" && b.use !== "vacant")
    .map((building) => ({
      building,
      bounds: studyAreaBounds(buildingGeometry(building)),
    }))
    .sort((a, b) => a.bounds[0] - b.bounds[0]);
  index.set(buildings, result);
  return result;
}
/** Whole-footprint associations only. A straddler is disclosed, never allocated by centroid or area share. */
export function parcelDevelopment(
  geometry: StudyAreaGeometry,
  buildings: Building[],
  parcelIds: readonly string[] = [],
): ParcelDevelopment {
  const footprintParts: Shape[] = [],
    contained: Building[] = [],
    straddlers: string[] = [],
    mismatches: string[] = [];
  const bounds = studyAreaBounds(geometry),
    target = feature(geometry),
    landArea = parcelAreaSqm(geometry),
    knownIds = new Set(parcelIds);
  let failed = 0;
  // Reported IDs must be checked even when the spatial index excludes their footprint.
  const reportedMatches = buildings
    .filter((b) => b.parcelId && knownIds.has(b.parcelId))
    .map((b) => b.id);
  for (const { building, bounds: b } of indexedBuildings(buildings)) {
    if (b[0] > bounds[2]) break;
    if (b[2] < bounds[0] || b[1] > bounds[3] || b[3] < bounds[1]) {
      if (building.parcelId && knownIds.has(building.parcelId))
        mismatches.push(building.id);
      continue;
    }
    try {
      const footprint = feature(buildingGeometry(building)),
        overlap = intersect(featureCollection([footprint, target]));
      const overlapArea = geometryIntersectionAreaSqm(
        buildingGeometry(building),
        geometry,
      );
      if (overlapArea <= 1e-6) {
        if (building.parcelId && knownIds.has(building.parcelId))
          mismatches.push(building.id);
        continue;
      }
      footprintParts.push(overlap!);
      const outside = difference(featureCollection([footprint, target]));
      if (
        outside &&
        geometryDifferenceAreaSqm(buildingGeometry(building), geometry) >
          Math.max(0.001, area(footprint) * 1e-9)
      )
        straddlers.push(building.id);
      else contained.push(building);
      if (
        knownIds.size &&
        building.parcelId &&
        !knownIds.has(building.parcelId)
      )
        mismatches.push(building.id);
    } catch {
      failed++;
    }
  }
  const matchedIds = new Set([...contained.map((b) => b.id), ...straddlers]);
  for (const id of reportedMatches)
    if (!matchedIds.has(id)) mismatches.push(id);
  let coverage: number | null = 0;
  try {
    coverage =
      footprintParts.length === 0
        ? 0
        : footprintParts.length === 1
          ? area(footprintParts[0])
          : area(union(featureCollection(footprintParts))!);
  } catch {
    failed++;
    coverage = null;
  }
  if (failed) coverage = null;
  const unresolved = straddlers.length > 0 || failed > 0;
  const quantityCoverage = {
    floorArea: aggregateBuildingQuantity(
      contained,
      (b) => buildingProgramTotals(b).grossFloorAreaSqm,
    ),
    units: aggregateBuildingQuantity(
      contained,
      (b) => buildingProgramTotals(b).units,
    ),
    jobs: aggregateBuildingQuantity(
      contained,
      (b) => buildingProgramTotals(b).jobs,
    ),
  };
  if (unresolved)
    for (const row of Object.values(quantityCoverage)) {
      row.value = null;
      row.missingBuildingIds = [
        ...new Set([...row.missingBuildingIds, ...straddlers]),
      ];
    }
  const floor = unresolved
    ? null
    : aggregateBuildingQuantity(
        contained,
        (b) => buildingProgramTotals(b).grossFloorAreaSqm,
      ).value;
  const inferred = contained.some((b) => b.estimated),
    caveats: string[] = [];
  if (straddlers.length)
    caveats.push(
      `${straddlers.length} building footprint${straddlers.length === 1 ? " crosses" : "s cross"} the boundary. Floor area, units, and jobs are unavailable until whole-building assignment can be resolved; no proportional allocation is assumed.`,
    );
  if (mismatches.length)
    caveats.push(
      "Reported parcel IDs disagree with geometric matches or refer to replaced parcels. Original identifiers are retained; these matches do not establish legal assignments.",
    );
  if (failed)
    caveats.push(
      "Some building geometry could not be evaluated; coverage and building-program totals are incomplete.",
    );
  if (Object.values(quantityCoverage).some((q) => q.missingBuildingIds.length))
    caveats.push(
      "Some matched building quantities are unknown. Geometry coverage remains independent; complete floor-area, home, and job counts require the missing attributes.",
    );
  if (inferred)
    caveats.push(
      "Floor counts, footprint areas, units, or jobs include inferred building attributes; geometric matching does not verify them.",
    );
  caveats.push(
    "Counts describe mapped structural features only; missing source features do not establish that land is vacant.",
  );
  caveats.push(
    "Building coverage uses the union of intersecting structural footprints, including the portion of straddling footprints. It excludes roads, paved parking, and landscaping; overlapping footprints are counted once.",
  );
  return {
    containedBuildingIds: contained.map((b) => b.id),
    straddlingBuildingIds: straddlers,
    declaredLinkMismatchIds: [...new Set(mismatches)],
    buildingCount: contained.length,
    grossFloorAreaSqm: floor,
    footprintUnionSqm: coverage,
    far: floor === null ? null : floor / landArea,
    lotCoveragePercent:
      coverage === null ? null : Math.min(100, (coverage / landArea) * 100),
    units: unresolved
      ? null
      : aggregateBuildingQuantity(
          contained,
          (b) => buildingProgramTotals(b).units,
        ).value,
    jobs: unresolved
      ? null
      : aggregateBuildingQuantity(
          contained,
          (b) => buildingProgramTotals(b).jobs,
        ).value,
    quantityCoverage,
    status:
      unresolved ||
      inferred ||
      mismatches.length ||
      floor === null ||
      contained.some((b) => b.units === null || b.jobs === null)
        ? "incomplete"
        : "ready",
    caveats,
  };
}
export function calculateParcelContext(
  place: Place,
  scenario: Scenario,
  parcelId: string,
): ParcelContext {
  const parcel = materializeParcels(place, scenario).find(
    (p) => p.id === parcelId,
  );
  if (!parcel)
    throw new Error("The selected parcel no longer exists in this scenario.");
  return {
    parcel,
    areaSqm: parcelAreaSqm(parcel),
    baseline: parcelDevelopment(
      parcel.geometry,
      place.buildings,
      parcel.kind === "parcel" ? [parcel.id] : [],
    ),
    proposal: parcelDevelopment(
      parcel.geometry,
      materializeBuildings(place, scenario),
      parcel.kind === "parcel" ? [parcel.id] : [],
    ),
    warnings: [
      "Both columns describe development within this same selected boundary. Baseline buildings on a proposed site do not establish that a recorded baseline parcel exists.",
      "User-drawn or imported planning boundaries are not a cadastral survey, ownership determination, subdivision approval, or zoning compliance finding.",
      ...(parcel.kind === "block"
        ? [
            "Block context is informational. Blocks are excluded from parcel FAR and lot-coverage scorecard denominators.",
          ]
        : []),
      ...(parcel.geometry.type === "MultiPolygon"
        ? [
            "This boundary contains separate components; assembly does not establish physical access or contiguity.",
          ]
        : []),
    ],
  };
}
/** Aggregate only parcel-kind land. Blocks may overlap it without inflating the denominator. */
export function parcelSetDevelopment(
  parcels: Parcel[],
  buildings: Building[],
): { areaSqm: number; development: ParcelDevelopment } | null {
  const lots = parcels.filter((p) => p.kind === "parcel");
  if (!lots.length) return null;
  const geometry =
    lots.length === 1
      ? lots[0].geometry
      : union(featureCollection(lots.map((p) => feature(p.geometry))))
          ?.geometry;
  if (!geometry) return null;
  return {
    areaSqm: parcelAreaSqm(geometry as StudyAreaGeometry),
    development: parcelDevelopment(
      geometry as StudyAreaGeometry,
      buildings,
      lots.map((p) => p.id),
    ),
  };
}

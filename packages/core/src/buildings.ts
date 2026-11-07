import { assertBuildingAttributeProvenance } from "./import-metadata";
import { quantityProduct } from "./quantities";
import { area } from "@turf/turf";
import type {
  Building,
  Command,
  LandUse,
  Place,
  Position,
  Project,
  Scenario,
  Source,
} from "./index";
import { materializeBuildings } from "./index";
import { assertFeatureIdentifier } from "./identifiers";
import {
  validateParcelGeometry,
  projectWithParcelVersion,
  materializeParcels,
  geometryDifferenceAreaSqm,
  geometryIntersectionAreaSqm,
} from "./parcels";
import {
  studyAreaAnchor,
  studyAreaBounds,
  type StudyAreaGeometry,
  type StudyAreaInput,
} from "./study-area";
export type BuildingTypology =
  | "house"
  | "townhome"
  | "apartments"
  | "retail"
  | "office"
  | "industrial"
  | "warehouse"
  | "school"
  | "hospital"
  | "healthcare"
  | "civic"
  | "mixed-use"
  | "park"
  | "parking"
  | "vacant";
export type BuildingComponentUse = Exclude<
  LandUse,
  "mixed-use" | "park" | "vacant"
>;
export type ResidentialSubtype = "single-family" | "townhome" | "apartment";
export type BuildingRateBasis =
  | "dwelling"
  | "occupied-dwelling"
  | "1000-sqft"
  | "job"
  | "bed";
export interface BuildingRate {
  value: number;
  basis: BuildingRateBasis;
  sourceId: string;
}
export interface BuildingProgramComponent {
  id: string;
  name?: string;
  use: BuildingComponentUse;
  grossFloorAreaSqm: number;
  units: number;
  jobs: number;
  beds?: number;
  residentialSubtype?: ResidentialSubtype;
  tripRate?: BuildingRate;
  parkingRate?: BuildingRate;
  sourceId?: string;
}
export interface BuildingProgram {
  version: 1;
  grossFloorAreaSqm: number;
  commonAreaSqm: number;
  components: BuildingProgramComponent[];
}
export const buildingTypologyLabels: Record<BuildingTypology, string> = {
  house: "House",
  townhome: "Townhomes",
  apartments: "Apartments",
  retail: "Retail",
  office: "Office",
  industrial: "Industrial",
  warehouse: "Warehouse / logistics",
  school: "School",
  hospital: "Hospital",
  healthcare: "Healthcare",
  civic: "Civic",
  "mixed-use": "Mixed-use",
  park: "Park",
  parking: "Parking garage",
  vacant: "Vacant land",
};
export const buildingTypologyUse: Record<BuildingTypology, LandUse> = {
  house: "residential",
  townhome: "residential",
  apartments: "multifamily",
  retail: "retail",
  office: "office",
  industrial: "industrial",
  warehouse: "warehouse",
  school: "school",
  hospital: "healthcare",
  healthcare: "healthcare",
  civic: "civic",
  "mixed-use": "mixed-use",
  park: "park",
  parking: "parking",
  vacant: "vacant",
};
export const MAX_AUTHORED_BUILDING_RING_POINTS = 500;
export const MAX_BUILDING_VERTICES = 5000;
export const MAX_BUILDING_PROGRAM_COMPONENTS = 64;
export const BUILDING_EARTH_RADIUS_METERS = 6371008.8;
export const USER_BUILDING_SOURCE: Source = {
  id: "user-building-proposal",
  name: "User building proposal",
  url: "",
  vintage: "Scenario edit",
  license: "User-authored proposal",
  kind: "user-supplied",
  description:
    "User-authored building geometry and entered development program; not observed occupancy, a surveyed building, zoning approval, or a calibrated traffic forecast.",
};
export const ILLUSTRATIVE_BUILDING_SOURCE: Source = {
  id: "illustrative-building-defaults",
  name: "Illustrative building library defaults",
  url: "",
  vintage: "Building library v1",
  license: "Application planning assumptions",
  kind: "inferred",
  description:
    "Editable illustrative building programs, massing, trip and parking assumptions. Not local observations, licensed ITE rates, medical capacity forecasts, or verified development entitlements.",
};
export function buildingGeometry(b: Building): StudyAreaGeometry {
  return b.geometry ?? { type: "Polygon", coordinates: [b.footprint!] };
}
export function buildingGeometryAreaSqm(b: Building): number {
  return area({
    type: "Feature",
    properties: {},
    geometry: buildingGeometry(b),
  });
}
/** New geometry area is derived. Legacy entered area is retained to preserve captured calculations. */
export function buildingAreaSqm(b: Building): number {
  return b.geometry ? buildingGeometryAreaSqm(b) : b.areaSqm;
}
export function buildingAnchor(b: Building): Position {
  return studyAreaAnchor(buildingGeometry(b));
}
export function validateBuildingGeometry(
  geometry: StudyAreaGeometry,
  studyArea?: StudyAreaInput,
) {
  const result = validateParcelGeometry(geometry, studyArea);
  return {
    ...result,
    error:
      result.error
        ?.replaceAll("parcel", "building footprint")
        .replaceAll("Parcel", "Building footprint") ?? null,
  };
}
export interface BuildingGeometryTransform {
  translateMeters?: [number, number];
  rotationDegrees?: number;
  scale?: number;
  anchor?: Position;
}
/** Clockwise rotation in the anchor's local equirectangular plane; never round source coordinates. */
export function transformBuildingGeometry(
  geometry: StudyAreaGeometry,
  transform: BuildingGeometryTransform,
): StudyAreaGeometry {
  const anchor = transform.anchor ?? studyAreaAnchor(geometry),
    scale = transform.scale ?? 1,
    angle = ((transform.rotationDegrees ?? 0) * Math.PI) / 180,
    translation = transform.translateMeters ?? [0, 0];
  if (
    ![...anchor, scale, angle, ...translation].every(Number.isFinite) ||
    scale <= 0 ||
    Math.abs(anchor[0]) > 180 ||
    Math.abs(anchor[1]) >= 89.999
  )
    throw new Error(
      "Use a finite positive scale and a valid nonpolar transform anchor.",
    );
  if (
    scale === 1 &&
    angle === 0 &&
    translation[0] === 0 &&
    translation[1] === 0
  )
    return structuredClone(geometry);
  const m = (BUILDING_EARTH_RADIUS_METERS * Math.PI) / 180,
    xm = m * Math.cos((anchor[1] * Math.PI) / 180);
  const point = (p: Position): Position => {
    const x = (p[0] - anchor[0]) * xm * scale,
      y = (p[1] - anchor[1]) * m * scale;
    return [
      anchor[0] +
        (x * Math.cos(angle) + y * Math.sin(angle) + translation[0]) / xm,
      anchor[1] +
        (-x * Math.sin(angle) + y * Math.cos(angle) + translation[1]) / m,
    ];
  };
  const result: StudyAreaGeometry =
    geometry.type === "Polygon"
      ? {
          type: "Polygon",
          coordinates: geometry.coordinates.map((r) => r.map(point)),
        }
      : {
          type: "MultiPolygon",
          coordinates: geometry.coordinates.map((p) =>
            p.map((r) => r.map(point)),
          ),
        };
  const valid = validateBuildingGeometry(result);
  if (!valid.valid) throw new Error(valid.error!);
  return result;
}
/** Broad map classification follows explicit component uses; common area is not a separate use. */
export function buildingProgramUse(
  program: BuildingProgram,
  fallback: LandUse,
): LandUse {
  const uses = [...new Set(program.components.map((c) => c.use))];
  return uses.length > 1 ? "mixed-use" : (uses[0] ?? fallback);
}
export function buildingProgramTotals(b: Building) {
  if (b.program) {
    const c = b.program.components;
    return {
      explicit: true as const,
      grossFloorAreaSqm: b.program.grossFloorAreaSqm,
      commonAreaSqm: b.program.commonAreaSqm,
      units: c.reduce((s, x) => s + x.units, 0),
      jobs: c.reduce((s, x) => s + x.jobs, 0),
      retailFloorAreaSqm: c
        .filter((x) => x.use === "retail")
        .reduce((s, x) => s + x.grossFloorAreaSqm, 0),
      nonresidentialFloorAreaSqm: c
        .filter(
          (x) => !["residential", "multifamily", "parking"].includes(x.use),
        )
        .reduce((s, x) => s + x.grossFloorAreaSqm, 0),
      components: c,
    };
  }
  const floor = ["park", "vacant"].includes(b.use)
    ? 0
    : quantityProduct(buildingAreaSqm(b), b.floors);
  const commercial = [
    "park",
    "vacant",
    "parking",
    "residential",
    "multifamily",
  ].includes(b.use)
    ? 0
    : b.use === "mixed-use"
      ? b.floors === null
        ? null
        : buildingAreaSqm(b)
      : floor;
  return {
    explicit: false as const,
    grossFloorAreaSqm: floor,
    commonAreaSqm: 0,
    units: b.units,
    jobs: b.jobs,
    retailFloorAreaSqm: ["retail", "mixed-use"].includes(b.use)
      ? commercial
      : 0,
    nonresidentialFloorAreaSqm: commercial,
    components: [] as BuildingProgramComponent[],
  };
}
export function assertBuildingProgram(b: Building): void {
  assertBuildingAttributeProvenance(b);
  for (const field of [
    "areaSqm",
    "height",
    "floors",
    "units",
    "jobs",
    "parkingSpaces",
  ] as const)
    if (b[field] !== null && (!Number.isFinite(b[field]) || b[field] < 0))
      throw new Error(`Building ${field} must be finite and nonnegative.`);
  if (
    b.areaSqm > 1e9 ||
    (b.height !== null && b.height > 1500) ||
    (b.floors !== null && b.floors > 250) ||
    (b.units !== null && b.units > 1e7) ||
    (b.jobs !== null && b.jobs > 1e8) ||
    (b.parkingSpaces !== null && b.parkingSpaces > 1e8)
  )
    throw new Error("Building quantities exceed the supported bounds.");
  if (
    (b.units !== null && !Number.isInteger(b.units)) ||
    (b.floors !== null && !Number.isInteger(b.floors))
  )
    throw new Error("Building homes and floor count must be integers.");
  if ((b.footprint === undefined) === (b.geometry === undefined))
    throw new Error("Use exactly one building geometry representation.");
  if (b.geometry) {
    const sqm = buildingGeometryAreaSqm(b);
    if (
      !Number.isFinite(sqm) ||
      Math.abs(b.areaSqm - sqm) > Math.max(1e-6, sqm * 1e-9)
    )
      throw new Error("Building area must match its complete geometry.");
  }
  if (!b.program) return;
  const p = b.program,
    nonnegative = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (
    p.version !== 1 ||
    !nonnegative(p.grossFloorAreaSqm) ||
    p.grossFloorAreaSqm > 1e10 ||
    !nonnegative(p.commonAreaSqm) ||
    !Array.isArray(p.components) ||
    p.components.length > MAX_BUILDING_PROGRAM_COMPONENTS
  )
    throw new Error("Building program totals and components are invalid.");
  const uses = new Set([
      "residential",
      "multifamily",
      "retail",
      "office",
      "industrial",
      "warehouse",
      "school",
      "healthcare",
      "civic",
      "parking",
    ]),
    seen = new Set<string>();
  for (const c of p.components) {
    assertFeatureIdentifier(c.id);
    if (seen.has(c.id))
      throw new Error("Building program component IDs must be unique.");
    seen.add(c.id);
    if (
      !uses.has(c.use) ||
      !nonnegative(c.grossFloorAreaSqm) ||
      c.grossFloorAreaSqm > 1e10 ||
      c.units > 1e7 ||
      c.jobs > 1e8 ||
      (c.beds !== undefined && c.beds > 1e7) ||
      !nonnegative(c.units) ||
      !Number.isInteger(c.units) ||
      !nonnegative(c.jobs) ||
      (c.beds !== undefined &&
        (!nonnegative(c.beds) || !Number.isInteger(c.beds)))
    )
      throw new Error(
        "Program components require finite nonnegative floor area, homes, jobs, and beds.",
      );
    if (
      c.residentialSubtype &&
      !["single-family", "townhome", "apartment"].includes(c.residentialSubtype)
    )
      throw new Error("Use a supported residential subtype.");
    if (c.units > 0 && !["residential", "multifamily"].includes(c.use))
      throw new Error("Homes must belong to a residential program component.");
    if (c.residentialSubtype && !["residential", "multifamily"].includes(c.use))
      throw new Error("Residential subtype requires a residential component.");
    for (const rate of [c.tripRate, c.parkingRate])
      if (rate) {
        if (
          !nonnegative(rate.value) ||
          rate.value > 10000 ||
          ![
            "dwelling",
            "occupied-dwelling",
            "1000-sqft",
            "job",
            "bed",
          ].includes(rate.basis) ||
          !rate.sourceId
        )
          throw new Error(
            "Program rates require a nonnegative value, denominator, and source.",
          );
        if (rate.basis === "bed" && c.beds === undefined)
          throw new Error(
            "A per-bed rate requires an explicit bed count; missing is not zero.",
          );
      }
  }
  if (p.components.length && b.use !== buildingProgramUse(p, b.use))
    throw new Error(
      "Building land use must match its explicit component uses (mixed-use for multiple uses).",
    );
  const totals = buildingProgramTotals(b),
    sum =
      p.components.reduce((s, c) => s + c.grossFloorAreaSqm, 0) +
      p.commonAreaSqm;
  if (
    Math.abs(sum - p.grossFloorAreaSqm) >
    Math.max(1e-6, p.grossFloorAreaSqm * 1e-9)
  )
    throw new Error(
      "Component floor areas plus common area must equal declared gross floor area.",
    );
  if (
    b.units === null ||
    b.jobs === null ||
    totals.units !== b.units ||
    totals.jobs === null ||
    Math.abs(totals.jobs - b.jobs) > 1e-8
  )
    throw new Error(
      "Building homes and jobs must match its authoritative program components.",
    );
  if (
    ["park", "vacant"].includes(b.use) &&
    (p.grossFloorAreaSqm !== 0 ||
      p.commonAreaSqm !== 0 ||
      p.components.length !== 0 ||
      b.units !== 0 ||
      b.jobs !== 0)
  )
    throw new Error(
      "Parks and vacant land cannot contain a structural building program.",
    );
}
export function buildingProgramWarnings(b: Building): string[] {
  const warnings: string[] = [];
  for (const field of [
    "height",
    "floors",
    "units",
    "jobs",
    "parkingSpaces",
  ] as const)
    if (b[field] === null)
      warnings.push(`${field} is unknown; missing quantities are not zero.`);
  if (!b.program) {
    if (b.use === "mixed-use")
      warnings.push(
        "Legacy mixed-use assumes one full footprint floor of retail; adopt and review an explicit program to specify the actual mix.",
      );
    return warnings;
  }
  const nominal = quantityProduct(buildingAreaSqm(b), b.floors);
  if (
    nominal !== null &&
    Math.abs(nominal - b.program.grossFloorAreaSqm) >
      Math.max(1, nominal * 0.01)
  )
    warnings.push(
      "Declared program floor area differs from footprint × floors. Calculations use the explicit program; the map shows uniform-height massing, not floor-by-floor design.",
    );
  if (b.geometry?.type === "MultiPolygon")
    warnings.push(
      "All footprint components use the same displayed height; this is schematic massing, not a surveyed model of different building wings.",
    );
  if (b.typology === "hospital")
    warnings.push(
      "Hospital defaults do not establish patient demand, licensed beds, emergency response coverage, or verified medical-service capacity.",
    );
  if (
    b.program.components.some(
      (c) => c.grossFloorAreaSqm === 0 && (c.units > 0 || c.jobs > 0),
    )
  )
    warnings.push(
      "A component has homes or jobs but no allocated floor area. Review the entered program; quantities are not inferred from geometry.",
    );
  if (b.program.commonAreaSqm > 0)
    warnings.push(
      "Common floor area contributes to total floor area and default assessed value, but receives no independent trip or parking demand.",
    );
  return warnings;
}
export function applyBuildingGeometry(
  b: Building,
  geometry: StudyAreaGeometry,
): Building {
  const check = validateBuildingGeometry(geometry);
  if (!check.valid) throw new Error(check.error!);
  const { footprint: _legacy, geometry: _old, ...rest } = b;
  return {
    ...rest,
    geometry: structuredClone(geometry),
    areaSqm: check.areaSqm,
    geometrySourceId: USER_BUILDING_SOURCE.id,
    estimated: true,
  };
}
export function validateBuildingEdit(b: Building, place: Place) {
  try {
    assertFeatureIdentifier(b.id);
    assertBuildingProgram(b);
    const original = place.buildings.find((x) => x.id === b.id),
      same =
        original &&
        JSON.stringify(buildingGeometry(original)) ===
          JSON.stringify(buildingGeometry(b));
    const geometry = buildingGeometry(b);
    const checked = same
      ? { valid: true, error: null, areaSqm: buildingGeometryAreaSqm(b) }
      : validateBuildingGeometry(geometry, place);
    if (!checked.valid) return checked;
    if (
      b.geometry &&
      Math.abs(b.areaSqm - checked.areaSqm) >
        Math.max(1e-6, checked.areaSqm * 1e-9)
    )
      throw new Error(
        "Building area must match its complete geometry, including holes and components.",
      );
    return checked;
  } catch (error) {
    return { valid: false, error: (error as Error).message, areaSqm: 0 };
  }
}
export function validateBuildingCommand(
  place: Place,
  scenario: Scenario,
  command: Command,
): void {
  if (command.type === "building.remove") {
    assertFeatureIdentifier(command.id);
    if (
      !(Object.hasOwn(scenario.buildingEdits, command.id)
        ? scenario.buildingEdits[command.id]
        : place.buildings.find((b) => b.id === command.id))
    )
      throw new Error("The building to remove no longer exists.");
    return;
  }
  const values =
    command.type === "building.upsert"
      ? [command.building]
      : command.type === "buildings.import"
        ? command.buildings
        : [];
  if (command.type === "buildings.import") {
    if (new Set(values.map((b) => b.id)).size !== values.length)
      throw new Error("Imported building identifiers must be unique.");
    const current = new Map(
      materializeBuildings(place, scenario).map((b) => [b.id, b]),
    );
    for (const b of values) {
      if (command.mode === "append" && current.has(b.id))
        throw new Error("Appended buildings must use new identifiers.");
      if (command.mode === "match" && !current.has(b.id))
        throw new Error("Matched buildings must already exist.");
    }
  }
  for (const b of values) {
    const result = validateBuildingEdit(b, place);
    if (!result.valid) throw new Error(result.error!);
  }
}
export function hasExtendedBuilding(b: Building): boolean {
  return (
    b.geometry !== undefined ||
    b.program !== undefined ||
    b.typology !== undefined ||
    b.geometrySourceId !== undefined ||
    b.programSourceId !== undefined ||
    b.sourceFeatureId !== undefined
  );
}
export function projectWithBuildingVersion(
  project: Project,
  place?: Place,
): Project {
  const withParcels = projectWithParcelVersion(project, place),
    states = [
      ...project.scenarios,
      ...project.history.flatMap((x) => [x.before, x.after]),
      ...project.undone.flatMap((x) => [x.before, x.after]),
    ];
  const extended =
    (place?.buildings ?? []).some(hasExtendedBuilding) ||
    states.some((s) =>
      Object.values(s.buildingEdits).some((b) => b && hasExtendedBuilding(b)),
    ) ||
    [...project.history, ...project.undone].some((e) =>
      e.command.type === "building.upsert"
        ? hasExtendedBuilding(e.command.building)
        : e.command.type === "buildings.import" &&
          e.command.buildings.some(hasExtendedBuilding),
    );
  return project.schemaVersion >= 3 || !extended
    ? withParcels
    : { ...withParcels, schemaVersion: 3 };
}

type SpatialRow = {
  building: Building;
  bounds: [number, number, number, number];
};
const spatialCache = new WeakMap<
  Scenario,
  { place: Place; rows: SpatialRow[] }
>();
export function buildingSpatialWarnings(
  building: Building,
  place: Place,
  scenario: Scenario,
): string[] {
  let cached = spatialCache.get(scenario);
  if (!cached || cached.place !== place) {
    const byId = new Map(place.buildings.map((b) => [b.id, b]));
    for (const [id, b] of Object.entries(scenario.buildingEdits)) {
      if (b === null) byId.delete(id);
      else byId.set(id, b);
    }
    cached = {
      place,
      rows: [...byId.values()]
        .filter((b) => !["park", "vacant"].includes(b.use))
        .map((b) => ({
          building: b,
          bounds: studyAreaBounds(buildingGeometry(b)),
        }))
        .sort((a, b) => a.bounds[0] - b.bounds[0]),
    };
    spatialCache.set(scenario, cached);
  }
  if (["park", "vacant"].includes(building.use)) return [];
  const geometry = buildingGeometry(building),
    bounds = studyAreaBounds(geometry),
    warnings: string[] = [],
    overlaps = (b: readonly number[]) =>
      b[0] < bounds[2] &&
      b[2] > bounds[0] &&
      b[1] < bounds[3] &&
      b[3] > bounds[1];
  let checked = 0,
    overlapCount = 0;
  for (const row of cached.rows) {
    if (row.bounds[0] > bounds[2]) break;
    if (row.building.id === building.id || !overlaps(row.bounds)) continue;
    if (++checked > 1000) {
      warnings.push(
        "Overlap inspection reached its 1,000-candidate budget; some nearby buildings remain unchecked.",
      );
      break;
    }
    if (
      geometryIntersectionAreaSqm(geometry, buildingGeometry(row.building)) >
      Math.max(0.001, buildingGeometryAreaSqm(building) * 1e-9)
    )
      overlapCount++;
  }
  if (overlapCount)
    warnings.push(
      `${overlapCount} other structural building footprint${overlapCount === 1 ? " overlaps" : "s overlap"} this feature. Programs are counted for each feature; parcel coverage unions footprints once. Review duplicate or intentionally overlapping source parts.`,
    );
  let straddles = 0;
  checked = 0;
  for (const parcel of materializeParcels(place, scenario)) {
    if (parcel.kind !== "parcel" || !overlaps(studyAreaBounds(parcel.geometry)))
      continue;
    if (++checked > 1000) {
      warnings.push(
        "Parcel matching reached its 1,000-candidate budget; some boundaries remain unchecked.",
      );
      break;
    }
    if (
      geometryIntersectionAreaSqm(geometry, parcel.geometry) > 0.001 &&
      geometryDifferenceAreaSqm(geometry, parcel.geometry) >
        Math.max(0.001, buildingGeometryAreaSqm(building) * 1e-9)
    )
      straddles++;
  }
  if (straddles)
    warnings.push(
      "This footprint straddles a parcel boundary. Individual-lot FAR, homes, and jobs remain unresolved; no proportional building program is allocated.",
    );
  return warnings;
}

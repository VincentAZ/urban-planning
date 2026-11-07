import {
  area,
  buffer,
  difference,
  featureCollection,
  intersect,
  lineString,
  point,
  union,
} from "@turf/turf";
import type {
  Feature,
  Polygon as GeoPolygon,
  MultiPolygon as GeoMultiPolygon,
} from "geojson";
import type { Position } from "./index";
import {
  geometryDifferenceAreaSqm,
  geometryIntersectionAreaSqm,
  validateParcelGeometry,
} from "./parcels";
import {
  studyAreaFeature,
  type StudyAreaGeometry,
  type StudyAreaInput,
} from "./study-area";

export const MAX_ACTIVITY_NEIGHBORHOODS = 100;
export const MAX_ACTIVITY_RING_POINTS = 500;
export const MAX_ACTIVITY_VERTICES = 5000;
export const MAX_ACTIVITY_TOTAL_VERTICES = 50000;
export const MAX_BRUSH_STROKE_POINTS = 500;
export const MIN_BRUSH_RADIUS_METERS = 5;
export const MAX_BRUSH_RADIUS_METERS = 1000;
type Shape = Feature<GeoPolygon | GeoMultiPolygon>;
const shape = (geometry: StudyAreaGeometry): Shape => ({
  type: "Feature",
  properties: {},
  geometry,
});
const size = (value: Shape | null) => (value ? area(value) : 0);
const parts = (geometry: StudyAreaGeometry) =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const vertices = (geometry: StudyAreaGeometry) =>
  parts(geometry).reduce(
    (sum, rings) => sum + rings.reduce((n, ring) => n + ring.length, 0),
    0,
  );
const join = (values: Shape[]): Shape | null =>
  values.length === 0
    ? null
    : values.length === 1
      ? values[0]
      : union(featureCollection(values));
const subtract = (a: Shape | null, b: Shape | null): Shape | null =>
  !a ? null : !b ? a : difference(featureCollection([a, b]));

/** The same precise polygon validation used by authored parcels, with neighborhood terminology. */
export function validateActivityGeometry(
  geometry: StudyAreaGeometry,
  studyArea?: StudyAreaInput,
) {
  const result = validateParcelGeometry(geometry, studyArea);
  return {
    ...result,
    error:
      result.error
        ?.replaceAll("parcel", "neighborhood")
        .replaceAll("Parcel", "Neighborhood") ?? null,
  };
}
/** Applied neighborhoods form a disjoint partition. Boundary touching is permitted, shared land is not. */
export function validateActivityNeighborhoods(
  neighborhoods: readonly { geometry: StudyAreaGeometry }[],
  place?: StudyAreaInput,
): void {
  if (neighborhoods.length > MAX_ACTIVITY_NEIGHBORHOODS)
    throw new Error(`Use at most ${MAX_ACTIVITY_NEIGHBORHOODS} neighborhoods.`);
  let total = 0;
  for (const neighborhood of neighborhoods) {
    const checked = validateActivityGeometry(neighborhood.geometry, place);
    if (!checked.valid) throw new Error(checked.error!);
    total += vertices(neighborhood.geometry);
    if (total > MAX_ACTIVITY_TOTAL_VERTICES)
      throw new Error(
        `Neighborhood boundaries may contain at most ${MAX_ACTIVITY_TOTAL_VERTICES} total vertices. No geometry was simplified.`,
      );
  }
  for (let i = 0; i < neighborhoods.length; i++)
    for (let j = i + 1; j < neighborhoods.length; j++) {
      if (
        geometryIntersectionAreaSqm(
          neighborhoods[i].geometry,
          neighborhoods[j].geometry,
        ) > 1e-6
      )
        throw new Error(
          "Neighborhoods cannot overlap. Adjust the boundaries so each location belongs to at most one neighborhood.",
        );
    }
}
export interface NeighborhoodBrushStroke {
  operation: "add" | "erase";
  path: Position[];
  radiusMeters: number;
}
export interface NeighborhoodBrushInput {
  geometry: StudyAreaGeometry | null;
  studyArea: StudyAreaInput;
  otherGeometries: StudyAreaGeometry[];
  stroke: NeighborhoodBrushStroke;
}
export interface NeighborhoodBrushResult {
  geometry: StudyAreaGeometry | null;
  changed: boolean;
  excludedGeometry: StudyAreaGeometry | null;
  excludedAreaSqm: number;
  excludedStudyGeometry: StudyAreaGeometry | null;
  excludedStudyAreaSqm: number;
  excludedNeighborhoodGeometry: StudyAreaGeometry | null;
  excludedNeighborhoodAreaSqm: number;
}
/** One completed stroke becomes one candidate vector boundary. Never mutates/simplifies source geometry. */
export function applyNeighborhoodBrush(
  input: NeighborhoodBrushInput,
): NeighborhoodBrushResult {
  const { geometry, studyArea, otherGeometries, stroke } = input;
  if (!["add", "erase"].includes(stroke.operation))
    throw new Error("Choose an add or erase brush.");
  if (
    !Number.isFinite(stroke.radiusMeters) ||
    stroke.radiusMeters < MIN_BRUSH_RADIUS_METERS ||
    stroke.radiusMeters > MAX_BRUSH_RADIUS_METERS
  )
    throw new Error(
      `Brush radius must be ${MIN_BRUSH_RADIUS_METERS}–${MAX_BRUSH_RADIUS_METERS} meters.`,
    );
  if (
    !Array.isArray(stroke.path) ||
    !stroke.path.length ||
    stroke.path.length > MAX_BRUSH_STROKE_POINTS
  )
    throw new Error(
      `Use 1–${MAX_BRUSH_STROKE_POINTS} points per stroke. Shorten the stroke; no points were discarded.`,
    );
  if (
    !stroke.path.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every(Number.isFinite) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 85,
    )
  )
    throw new Error(
      "Brush coordinates must be finite longitude and latitude within the map.",
    );
  validateActivityNeighborhoods(
    otherGeometries.map((geometry) => ({ geometry })),
    studyArea,
  );
  if (geometry) {
    const valid = validateActivityGeometry(geometry, studyArea);
    if (!valid.valid) throw new Error(valid.error!);
  }
  const study = studyAreaFeature(studyArea);
  if (vertices(study.geometry as StudyAreaGeometry) > 100000)
    throw new Error(
      "This study boundary exceeds the supported brush complexity. Use a smaller study area.",
    );
  const path = stroke.path.filter(
    (p, index) =>
      index === 0 ||
      p[0] !== stroke.path[index - 1][0] ||
      p[1] !== stroke.path[index - 1][1],
  );
  const brushed = buffer(
    path.length === 1 ? point(path[0]) : lineString(path),
    stroke.radiusMeters,
    { units: "meters", steps: 8 },
  );
  if (!brushed)
    throw new Error("The brush stroke could not be converted into a boundary.");
  const within = intersect(featureCollection([brushed, study]));
  const excludedStudy = subtract(brushed, within);
  const occupied = join(otherGeometries.map(shape));
  const excludedNeighborhood =
    stroke.operation === "add" && within && occupied
      ? intersect(featureCollection([within, occupied]))
      : null;
  const allowed =
    stroke.operation === "add" ? subtract(within, occupied) : within;
  const original = geometry ? shape(geometry) : null;
  const result =
    stroke.operation === "erase"
      ? subtract(original, allowed)
      : join([original, allowed].filter((item): item is Shape => !!item));
  const next = result?.geometry as StudyAreaGeometry | undefined;
  if (next)
    validateActivityNeighborhoods(
      [
        ...otherGeometries.map((geometry) => ({ geometry })),
        { geometry: next },
      ],
      studyArea,
    );
  const excluded = join(
    [excludedStudy, excludedNeighborhood].filter(
      (item): item is Shape => !!item,
    ),
  );
  const changed =
    !!next !== !!geometry ||
    !!(
      next &&
      geometry &&
      (geometryDifferenceAreaSqm(next, geometry) > 1e-6 ||
        geometryDifferenceAreaSqm(geometry, next) > 1e-6)
    );
  return {
    geometry: changed ? (next ?? null) : geometry,
    changed,
    excludedGeometry: (excluded?.geometry as StudyAreaGeometry) ?? null,
    excludedAreaSqm: size(excluded),
    excludedStudyGeometry:
      (excludedStudy?.geometry as StudyAreaGeometry) ?? null,
    excludedStudyAreaSqm: size(excludedStudy),
    excludedNeighborhoodGeometry:
      (excludedNeighborhood?.geometry as StudyAreaGeometry) ?? null,
    excludedNeighborhoodAreaSqm: size(excludedNeighborhood),
  };
}

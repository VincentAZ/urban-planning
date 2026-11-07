import type { Place, Position, Road, Source } from "./index";
import { lineWithinStudyArea, type StudyAreaInput } from "./study-area";

export const MAX_AUTHORED_ROAD_POINTS = 500;
export const USER_ROAD_SOURCE: Source = {
  id: "user-road-proposal",
  name: "User street proposal",
  url: "",
  vintage: "Scenario edit",
  license: "User-authored proposal",
  kind: "user-supplied",
  description:
    "Street geometry and settings entered for this proposal. Starter lane and speed values are editable planning assumptions, not a survey, observed traffic count, or engineering design. Crossing drawn lines does not establish a connected or grade-separated routing network.",
};
export interface RoadPathValidation {
  valid: boolean;
  error: string | null;
  lengthMeters: number;
}
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
function distance(a: Position, b: Position) {
  const radians = Math.PI / 180;
  const latitude = (b[1] - a[1]) * radians,
    longitude = (b[0] - a[0]) * radians;
  const chord =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(a[1] * radians) *
      Math.cos(b[1] * radians) *
      Math.sin(longitude / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, chord))));
}
function orientation(a: Position, b: Position, c: Position) {
  const left = (b[0] - a[0]) * (c[1] - a[1]),
    right = (b[1] - a[1]) * (c[0] - a[0]);
  const cross = left - right,
    tolerance =
      Number.EPSILON * 32 * (Math.abs(left) + Math.abs(right) + 1e-30);
  return Math.abs(cross) <= tolerance ? 0 : Math.sign(cross);
}
function overlaps(a: Position, b: Position, c: Position, d: Position) {
  return (
    Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
      Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
      Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
  );
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  if (!overlaps(a, b, c, d)) return false;
  return (
    orientation(a, b, c) * orientation(a, b, d) <= 0 &&
    orientation(c, d, a) * orientation(c, d, b) <= 0
  );
}
function reverses(a: Position, shared: Position, b: Position) {
  return (
    orientation(a, shared, b) === 0 &&
    (shared[0] - a[0]) * (b[0] - shared[0]) +
      (shared[1] - a[1]) * (b[1] - shared[1]) <
      0
  );
}

/** Validate an authored centerline, not source-map topology. Other roads may cross it;
 * network connectivity, intersection controls, and bridges require separate modeling. */
export function validateRoadPath(
  points: readonly Position[],
  studyArea?: StudyAreaInput,
): RoadPathValidation {
  const fail = (error: string, lengthMeters = 0): RoadPathValidation => ({
    valid: false,
    error,
    lengthMeters,
  });
  if (!Array.isArray(points) || points.length < 2)
    return fail("Add at least two street points.");
  if (points.length > MAX_AUTHORED_ROAD_POINTS)
    return fail(
      `Use at most ${MAX_AUTHORED_ROAD_POINTS} points in an authored street path.`,
    );
  if (
    !points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every(Number.isFinite) &&
        p[0] >= -180 &&
        p[0] <= 180 &&
        p[1] >= -90 &&
        p[1] <= 90,
    )
  )
    return fail(
      "Street points must contain valid longitude and latitude coordinates.",
    );
  let lengthMeters = 0;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length < 0.05)
      return fail(
        "Separate consecutive street points by at least 5 centimeters; duplicate points do not form a street segment.",
        lengthMeters,
      );
    lengthMeters += length;
    if (i > 1 && reverses(points[i - 2], points[i - 1], points[i]))
      return fail(
        "A street path cannot double back over the same segment.",
        lengthMeters,
      );
  }
  if (lengthMeters < 1)
    return fail("Draw a street path at least 1 meter long.", lengthMeters);
  const closed = same(points[0], points.at(-1)!);
  if (closed && reverses(points.at(-2)!, points[0], points[1]))
    return fail(
      "A street loop cannot double back over its closing segment.",
      lengthMeters,
    );
  for (let i = 1; i < points.length; i++)
    for (let j = i + 2; j < points.length; j++) {
      if (closed && i === 1 && j === points.length - 1) continue;
      if (intersects(points[i - 1], points[i], points[j - 1], points[j]))
        return fail(
          "A street path cannot cross or overlap itself. Draw complex or grade-separated alignments as separate paths.",
          lengthMeters,
        );
    }
  if (studyArea && !lineWithinStudyArea(points as Position[], studyArea))
    return fail(
      "Keep the entire street path inside the study area, including between points and around excluded areas.",
      lengthMeters,
    );
  return { valid: true, error: null, lengthMeters };
}

/** Existing source centerlines can contain complex topology. Do not retroactively
 * reject them when only their settings change; apply strict rules to authored geometry. */
export function validateRoadEdit(road: Road, place: Place): RoadPathValidation {
  const original = place.roads.find((candidate) => candidate.id === road.id);
  const unchanged =
    original &&
    original.coordinates.length === road.coordinates.length &&
    original.coordinates.every((point, index) =>
      same(point, road.coordinates[index]),
    );
  if (!unchanged) return validateRoadPath(road.coordinates, place);
  const lengthMeters = road.coordinates
    .slice(1)
    .reduce(
      (sum, point, index) => sum + distance(road.coordinates[index], point),
      0,
    );
  return { valid: true, error: null, lengthMeters };
}

export function roadPreset(
  coordinates: readonly Position[],
  name = "Proposed street",
): Road {
  const validation = validateRoadPath(coordinates);
  if (!validation.valid) throw new Error(validation.error!);
  return {
    id: `road-${globalThis.crypto.randomUUID()}`,
    name: name.trim() || "Proposed street",
    coordinates: coordinates.map((point) => [...point]),
    lanes: 2,
    speedMph: 25,
    oneWay: false,
    kind: "residential",
    sourceId: USER_ROAD_SOURCE.id,
    geometrySourceId: USER_ROAD_SOURCE.id,
    attributeSourceId: USER_ROAD_SOURCE.id,
    estimated: true,
  };
}

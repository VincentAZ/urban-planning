import {
  area,
  booleanValid,
  difference,
  featureCollection,
  intersect,
  kinks,
  polygon,
} from "@turf/turf";
import type {
  Feature,
  Polygon as GeoPolygon,
  MultiPolygon as GeoMultiPolygon,
} from "geojson";
import type { Place, Polygon, Position } from "./index";

export type StudyAreaGeometry =
  | { type: "Polygon"; coordinates: Polygon[] }
  | { type: "MultiPolygon"; coordinates: Polygon[][] };
export type StudyAreaInput =
  StudyAreaGeometry | Pick<Place, "boundary" | "studyArea">;
export type StudyAreaBounds = [number, number, number, number];
type Segment = {
  a: Position;
  b: Position;
  bounds: StudyAreaBounds;
  polygon: number;
};
type Tree = {
  bounds: StudyAreaBounds;
  left?: Tree;
  right?: Tree;
  segments?: Segment[];
};
type Prepared = {
  geometry: StudyAreaGeometry;
  polygons: Polygon[][];
  bounds: StudyAreaBounds;
  tree: Tree;
  segments: Segment[];
};
// Geometry is immutable source data. Cache derived indexes outside the captured object/hash.
const cache = new WeakMap<object, Prepared>();
const EPS = 1e-10;
const overlaps = (a: StudyAreaBounds, b: StudyAreaBounds) =>
  a[0] <= b[2] + EPS &&
  a[2] + EPS >= b[0] &&
  a[1] <= b[3] + EPS &&
  a[3] + EPS >= b[1];
const boundsOf = (points: Position[]): StudyAreaBounds =>
  points.reduce<StudyAreaBounds>(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
function buildTree(segments: Segment[]): Tree {
  const bounds = segments.reduce<StudyAreaBounds>(
    (b, s) => [
      Math.min(b[0], s.bounds[0]),
      Math.min(b[1], s.bounds[1]),
      Math.max(b[2], s.bounds[2]),
      Math.max(b[3], s.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  if (segments.length <= 16) return { bounds, segments };
  const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
  segments.sort(
    (a, b) =>
      a.bounds[axis] +
      a.bounds[axis + 2] -
      (b.bounds[axis] + b.bounds[axis + 2]),
  );
  const mid = segments.length >> 1;
  return {
    bounds,
    left: buildTree(segments.slice(0, mid)),
    right: buildTree(segments.slice(mid)),
  };
}
function query(
  tree: Tree,
  bounds: StudyAreaBounds,
  result: Segment[] = [],
): Segment[] {
  if (!overlaps(tree.bounds, bounds)) return result;
  if (tree.segments)
    for (const segment of tree.segments) {
      if (overlaps(segment.bounds, bounds)) result.push(segment);
    }
  else {
    query(tree.left!, bounds, result);
    query(tree.right!, bounds, result);
  }
  return result;
}
export function studyAreaGeometry(input: StudyAreaInput): StudyAreaGeometry {
  return "type" in input
    ? input
    : (input.studyArea ?? { type: "Polygon", coordinates: [input.boundary] });
}
function prepared(input: StudyAreaInput): Prepared {
  const key = "type" in input ? input : (input.studyArea ?? input.boundary);
  const prior = cache.get(key);
  if (prior) return prior;
  const geometry = studyAreaGeometry(input),
    polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
  const segments: Segment[] = [];
  polygons.forEach((rings, index) =>
    rings.forEach((ring) => {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1],
          b = ring[i];
        if (a[0] !== b[0] || a[1] !== b[1])
          segments.push({ a, b, bounds: boundsOf([a, b]), polygon: index });
      }
    }),
  );
  const tree = buildTree([...segments]);
  const result = { geometry, polygons, bounds: tree.bounds, tree, segments };
  cache.set(key, result);
  return result;
}
export function studyAreaFeature(
  input: StudyAreaInput,
): Feature<GeoPolygon | GeoMultiPolygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: studyAreaGeometry(input),
  };
}
export function studyAreaPolygons(input: StudyAreaInput): Polygon[][] {
  return prepared(input).polygons;
}
export function studyAreaBounds(input: StudyAreaInput): StudyAreaBounds {
  return [...prepared(input).bounds];
}

/** Same spherical ring formula used by legacy models, preserving their numeric results. */
function ringArea(ring: Polygon): number {
  const radians = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    let delta = (b[0] - a[0]) * radians;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    sum += delta * (2 + Math.sin(a[1] * radians) + Math.sin(b[1] * radians));
  }
  return Math.abs((sum * 6371008.8 ** 2) / 2);
}
export function studyAreaSqm(input: StudyAreaInput): number {
  return studyAreaPolygons(input).reduce(
    (sum, rings) =>
      sum +
      ringArea(rings[0]) -
      rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0),
    0,
  );
}
function onSegment(point: Position, { a, b }: Segment): boolean {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length;
  if (t < -EPS || t > 1 + EPS) return false;
  return (
    Math.hypot(
      point[0] - a[0] - Math.max(0, Math.min(1, t)) * dx,
      point[1] - a[1] - Math.max(0, Math.min(1, t)) * dy,
    ) <= EPS
  );
}
/** Even/odd rings per polygon, union across islands. All boundary edges are covered. */
export function pointInStudyArea(
  point: Position,
  input: StudyAreaInput,
): boolean {
  if (!point.every(Number.isFinite)) return false;
  const data = prepared(input),
    [x, y] = point;
  if (!overlaps(data.bounds, [x, y, x, y])) return false;
  const crossing = new Set<number>();
  for (const edge of query(data.tree, [
    x - EPS,
    y - EPS,
    data.bounds[2] + EPS,
    y + EPS,
  ])) {
    if (onSegment(point, edge)) return true;
    const { a, b } = edge;
    if (
      a[1] > y !== b[1] > y &&
      x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    ) {
      if (crossing.has(edge.polygon)) crossing.delete(edge.polygon);
      else crossing.add(edge.polygon);
    }
  }
  return crossing.size > 0;
}
function segmentIntervals(
  a: Position,
  b: Position,
  input: StudyAreaInput,
): [number, number][] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  if (length === 0) return [];
  const parameters = [0, 1];
  for (const edge of query(prepared(input).tree, boundsOf([a, b]))) {
    const ex = edge.b[0] - edge.a[0],
      ey = edge.b[1] - edge.a[1],
      qx = edge.a[0] - a[0],
      qy = edge.a[1] - a[1];
    const denominator = dx * ey - dy * ex,
      tolerance =
        Number.EPSILON * 32 * (Math.abs(dx * ey) + Math.abs(dy * ex) + 1e-30);
    if (Math.abs(denominator) > tolerance) {
      const t = (qx * ey - qy * ex) / denominator,
        u = (qx * dy - qy * dx) / denominator;
      if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
        parameters.push(Math.max(0, Math.min(1, t)));
    } else if (
      onSegment(edge.a, { a, b, bounds: boundsOf([a, b]), polygon: 0 }) ||
      Math.abs(qx * dy - qy * dx) <= EPS * Math.sqrt(length)
    ) {
      for (const endpoint of [edge.a, edge.b]) {
        const t =
          ((endpoint[0] - a[0]) * dx + (endpoint[1] - a[1]) * dy) / length;
        if (t >= 0 && t <= 1) parameters.push(t);
      }
    }
  }
  const sorted = parameters
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-12),
    inside: [number, number][] = [];
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1],
      hi = sorted[i],
      mid = (lo + hi) / 2;
    if (pointInStudyArea([a[0] + dx * mid, a[1] + dy * mid], input)) {
      const last = inside.at(-1);
      if (last && Math.abs(last[1] - lo) * Math.sqrt(length) <= EPS)
        last[1] = hi;
      else inside.push([lo, hi]);
    }
  }
  return inside;
}
export function lineWithinStudyArea(
  points: Position[],
  input: StudyAreaInput,
): boolean {
  if (points.length < 2 || !points.every((p) => pointInStudyArea(p, input)))
    return false;
  let hasLength = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    hasLength = true;
    const intervals = segmentIntervals(a, b, input);
    // Re-intersecting a computed endpoint can produce t=1−ulp even when its
    // coordinate is unchanged. Use the same coordinate tolerance as boundary coverage.
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (
      intervals.length !== 1 ||
      intervals[0][0] * length > EPS ||
      (1 - intervals[0][1]) * length > EPS
    )
      return false;
  }
  return hasLength;
}
/** Split at every ring intersection. Midpoints classify each open interval, never a whole road. */
export function clipLineToStudyArea(
  points: Position[],
  input: StudyAreaInput,
): Position[][] {
  const paths: Position[][] = [];
  let current: Position[] = [];
  const finish = () => {
    if (current.length > 1) paths.push(current);
    current = [];
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) {
      finish();
      continue;
    }
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const intervals = segmentIntervals(a, b, input);
    if (!intervals.length) {
      finish();
      continue;
    }
    for (const [lo, hi] of intervals) {
      const at = (t: number): Position =>
        t === 0
          ? [...a]
          : t === 1
            ? [...b]
            : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const start = at(lo),
        end = at(hi),
        last = current.at(-1);
      if (!last || Math.hypot(last[0] - start[0], last[1] - start[1]) > EPS) {
        finish();
        current = [start];
      }
      current.push(end);
      if (hi < 1) finish();
    }
  }
  finish();
  return paths;
}
export function buildingWithinStudyArea(
  footprint: Polygon,
  input: StudyAreaInput,
): boolean {
  if (
    footprint.length < 4 ||
    !footprint.every((p) => p.every(Number.isFinite)) ||
    footprint[0][0] !== footprint.at(-1)![0] ||
    footprint[0][1] !== footprint.at(-1)![1]
  )
    return false;
  const building = polygon([footprint]);
  if (
    area(building) <= 0 ||
    !booleanValid(building) ||
    kinks(building).features.length ||
    !pointInStudyArea(footprint[0], input)
  )
    return false;
  const data = prepared(input),
    bounds = boundsOf(footprint);
  // If no study edge touches this footprint's box, a connected ring lies wholly in one face.
  if (!query(data.tree, bounds).length) return true;
  const nearby = data.polygons.filter((rings) =>
    overlaps(boundsOf(rings[0]), bounds),
  );
  if (!nearby.length) return false;
  try {
    return (
      difference(
        featureCollection<GeoPolygon | GeoMultiPolygon>([
          building,
          {
            type: "Feature",
            properties: {},
            geometry: { type: "MultiPolygon", coordinates: nearby },
          },
        ]),
      ) === null
    );
  } catch {
    return false;
  }
}
/** A true interior anchor, not a centroid that may land in a hole or between islands. */
export function studyAreaAnchor(input: StudyAreaInput): Position {
  const polygonArea = (rings: Polygon[]) =>
    ringArea(rings[0]) -
    rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
  const data = prepared(input),
    largest = [...data.polygons].sort(
      (a, b) => polygonArea(b) - polygonArea(a),
    )[0];
  if (!largest) throw new Error("The study area has no polygons.");
  const shape: StudyAreaGeometry = { type: "Polygon", coordinates: largest },
    bounds = studyAreaBounds(shape);
  const latitudes = [...new Set(largest.flat().map((p) => p[1]))].sort(
    (a, b) => a - b,
  );
  const mid = (bounds[1] + bounds[3]) / 2;
  const candidates = [
    mid,
    ...latitudes.slice(1).map((y, i) => (y + latitudes[i]) / 2),
  ].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  for (const y of candidates) {
    const parts = clipLineToStudyArea(
      [
        [bounds[0] - 1, y],
        [bounds[2] + 1, y],
      ],
      shape,
    );
    const best = parts.sort(
      (a, b) => b.at(-1)![0] - b[0][0] - (a.at(-1)![0] - a[0][0]),
    )[0];
    if (best && best.at(-1)![0] > best[0][0]) {
      const candidate: Position = [(best[0][0] + best.at(-1)![0]) / 2, y];
      if (
        !query(prepared(shape).tree, [
          candidate[0] - EPS,
          y - EPS,
          candidate[0] + EPS,
          y + EPS,
        ]).some((edge) => onSegment(candidate, edge))
      )
        return candidate;
    }
  }
  throw new Error("The study area has no usable interior.");
}
export function isValidStudyArea(input: StudyAreaInput): boolean {
  try {
    const feature = studyAreaFeature(input);
    if (
      area(feature) <= 0 ||
      !booleanValid(feature) ||
      kinks(feature).features.length
    )
      return false;
    const polygons = studyAreaPolygons(input).map((rings) => ({
      rings,
      feature: polygon(rings),
      bounds: boundsOf(rings[0]),
    }));
    for (let p = 0; p < polygons.length; p++) {
      const item = polygons[p],
        outer = polygon([item.rings[0]]),
        holes = item.rings.slice(1).map((ring) => ({
          feature: polygon([ring]),
          bounds: boundsOf(ring),
        }));
      for (let h = 0; h < holes.length; h++) {
        if (
          area(holes[h].feature) <= 0 ||
          difference(featureCollection([holes[h].feature, outer])) !== null
        )
          return false;
        for (let previous = 0; previous < h; previous++)
          if (
            overlaps(holes[h].bounds, holes[previous].bounds) &&
            intersect(
              featureCollection([holes[h].feature, holes[previous].feature]),
            ) !== null
          )
            return false;
      }
      for (let previous = 0; previous < p; previous++)
        if (
          overlaps(item.bounds, polygons[previous].bounds) &&
          intersect(
            featureCollection([item.feature, polygons[previous].feature]),
          ) !== null
        )
          return false;
    }
    return true;
  } catch {
    return false;
  }
}

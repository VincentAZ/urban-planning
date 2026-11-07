import type { StudyAreaGeometry } from "@urban/core";

type Point = [number, number];
type Bounds = [number, number, number, number];
type Decimal = { coefficient: bigint; exponent: number };
type ExactPoint = [Decimal, Decimal];
interface Edge {
  a: Point;
  b: Point;
  exactA: ExactPoint;
  exactB: ExactPoint;
  bounds: Bounds;
  polygon: number;
}
interface Node {
  bounds: Bounds;
  edges?: Edge[];
  left?: Node;
  right?: Node;
}
export interface PreparedFloodShape {
  readonly bounds: Bounds;
  readonly tree: Node;
  readonly starts: Point[];
}
export type FloodStrictRelation = "inside" | "outside" | "boundary";

const overlaps = (a: Bounds, b: Bounds) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const pointBounds = (a: Point, b: Point): Bounds => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
];
function boundsOf(edges: Edge[]): Bounds {
  return edges.reduce<Bounds>(
    (bounds, edge) => [
      Math.min(bounds[0], edge.bounds[0]),
      Math.min(bounds[1], edge.bounds[1]),
      Math.max(bounds[2], edge.bounds[2]),
      Math.max(bounds[3], edge.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}
function index(edges: Edge[]): Node {
  const bounds = boundsOf(edges);
  if (edges.length <= 16) return { bounds, edges };
  const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
  edges.sort(
    (a, b) =>
      a.bounds[axis] + a.bounds[axis + 2] - b.bounds[axis] - b.bounds[axis + 2],
  );
  const middle = edges.length >> 1;
  return {
    bounds,
    left: index(edges.slice(0, middle)),
    right: index(edges.slice(middle)),
  };
}
function query(node: Node, bounds: Bounds, result: Edge[] = []): Edge[] {
  if (!overlaps(node.bounds, bounds)) return result;
  if (node.edges)
    for (const edge of node.edges) {
      if (overlaps(edge.bounds, bounds)) result.push(edge);
    }
  else {
    query(node.left!, bounds, result);
    query(node.right!, bounds, result);
  }
  return result;
}

/** Polyclip interprets each retained Number through its canonical decimal text. */
function decimal(value: number): Decimal {
  if (!Number.isFinite(value)) throw new Error("Nonfinite flood coordinate.");
  const [mantissa, power = "0"] = value.toString().toLowerCase().split("e");
  const decimals = mantissa.includes(".")
    ? mantissa.length - mantissa.indexOf(".") - 1
    : 0;
  return {
    coefficient: BigInt(mantissa.replace(".", "")),
    exponent: Number(power) - decimals,
  };
}
const exactPoint = (point: Point): ExactPoint => [
  decimal(point[0]),
  decimal(point[1]),
];
function orientation(a: ExactPoint, b: ExactPoint, p: ExactPoint): bigint {
  const exponent = Math.min(
    ...[...a, ...b, ...p].map((value) => value.exponent),
  );
  const integer = (value: Decimal) =>
    value.coefficient * 10n ** BigInt(value.exponent - exponent);
  const ax = integer(a[0]),
    ay = integer(a[1]);
  return (
    (integer(b[0]) - ax) * (integer(p[1]) - ay) -
    (integer(b[1]) - ay) * (integer(p[0]) - ax)
  );
}

/** Requires validated polygon topology; derived coordinates are privately copied. */
export function prepareFloodShape(
  geometry: StudyAreaGeometry,
): PreparedFloodShape {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const edges: Edge[] = [],
    starts: Point[] = [];
  polygons.forEach((rings, polygon) => {
    starts.push([...rings[0][0]]);
    for (const ring of rings) {
      const points = ring.map((point) => [...point] as Point);
      const exact = points.map(exactPoint);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        edges.push({
          a,
          b,
          exactA: exact[i - 1],
          exactB: exact[i],
          bounds: pointBounds(a, b),
          polygon,
        });
      }
    }
  });
  const tree = index(edges);
  return { bounds: tree.bounds, tree, starts };
}

/** Exact even/odd rings within each polygon; union across disjoint components. */
function pointRelation(point: Point, prepared: PreparedFloodShape): -1 | 0 | 1 {
  const [x, y] = point;
  if (!overlaps(prepared.bounds, [x, y, x, y])) return -1;
  const exact = exactPoint(point),
    inside = new Set<number>();
  for (const edge of query(prepared.tree, [x, y, prepared.bounds[2], y])) {
    const side = orientation(edge.exactA, edge.exactB, exact);
    if (side === 0n && overlaps(edge.bounds, [x, y, x, y])) return 0;
    if (edge.a[1] > y === edge.b[1] > y) continue;
    if (
      (edge.b[1] > edge.a[1] && side > 0n) ||
      (edge.b[1] < edge.a[1] && side < 0n)
    ) {
      if (inside.has(edge.polygon)) inside.delete(edge.polygon);
      else inside.add(edge.polygon);
    }
  }
  return inside.size ? 1 : -1;
}

/**
 * A conservative shortcut for strictly separated boundaries, never a tolerance.
 * If even segment bounding boxes overlap, the ordinary overlay must decide.
 * Exact canonical-decimal predicates then exclude enclosed holes/islands and
 * classify each footprint component. No source coordinate is moved or rounded.
 */
export function strictFloodRelation(
  footprint: StudyAreaGeometry,
  prepared: PreparedFloodShape | null,
): FloodStrictRelation {
  if (!prepared) return "outside";
  const polygons =
    footprint.type === "Polygon"
      ? [footprint.coordinates]
      : footprint.coordinates;
  const segments = polygons.flatMap((rings) =>
    rings.flatMap((ring) =>
      ring.slice(1).map((point, i) => pointBounds(ring[i], point)),
    ),
  );
  const bounds = segments.reduce<Bounds>(
    (result, segment) => [
      Math.min(result[0], segment[0]),
      Math.min(result[1], segment[1]),
      Math.max(result[2], segment[2]),
      Math.max(result[3], segment[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  if (!overlaps(bounds, prepared.bounds)) return "outside";
  const candidates = query(prepared.tree, bounds);
  if (
    segments.some((segment) =>
      candidates.some((edge) => overlaps(segment, edge.bounds)),
    )
  )
    return "boundary";
  if (candidates.length) {
    const inner = prepareFloodShape(footprint);
    if (candidates.some((edge) => pointRelation(edge.a, inner) !== -1))
      return "boundary";
  }
  const states = polygons.map((rings) => pointRelation(rings[0][0], prepared));
  if (states.every((state) => state === 1)) return "inside";
  if (states.every((state) => state === -1)) return "outside";
  return "boundary";
}

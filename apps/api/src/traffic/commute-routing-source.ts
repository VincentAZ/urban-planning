/** Exact retained OSM centerline evidence for a native junction's shorter turning-lane representation. */
import { SaxesParser } from "saxes";
import type { Position, TrafficNetwork } from "@urban/core";
import {
  commuteBytesHash,
  commuteMeters,
  type CommuteRegionalRoute,
} from "./commute-routing-valhalla.js";
import type { CommuteNativeIndex } from "./commute-routing.js";
/** Two six-decimal coordinate quantizations, bounded in geographic meters; never a general map-matching radius. */
export const COMMUTE_SOURCE_QUANTIZATION_METERS = 0.16;
interface WayGeometry {
  nodeIds: string[];
  points: Position[];
  along: number[];
  total: number;
}
export interface CommuteSourceGeometry {
  sha256: string;
  bytes: number;
  nodes: Map<string, Position>;
  ways: Map<string, string[]>;
  cache: Map<string, WayGeometry>;
}
export interface CommuteJunctionSourceProof {
  method: "exact-original-osm-junction";
  sourceFileSha256: string;
  junctionNodeId: string;
  junctionPosition: Position;
  sourceWayRuns: {
    wayId: string;
    direction: "forward" | "backward";
    startMeters: number;
    endMeters: number;
    junctionMeters: number;
  }[];
  maximumSourceResidualMeters: number;
  quantizationBoundMeters: number;
  /** Version 3 only: an exactly zero-length side at a retained regional edge boundary. */
  boundarySides?: {
    side: "incoming" | "outgoing";
    regionalEdgeId: string;
    wayId: string;
    direction: "forward" | "backward";
    regionalBoundaryMeters: number;
    sourceStartMeters: number;
    sourceEndMeters: number;
    sourceJunctionMeters: number;
    maximumSourceResidualMeters: number;
  }[];
}
const fail = (message: string): never => {
  throw new Error(message);
};
export function bindCommuteSourceGeometry(
  index: CommuteNativeIndex,
  bytes: Buffer,
): CommuteNativeIndex {
  const sha256 = commuteBytesHash(bytes);
  if (
    bytes.length > 100 * 1024 ** 2 ||
    !index.network.manifest.sourceFiles.some(
      (f) =>
        f.sha256 === sha256 &&
        f.bytes === bytes.length &&
        f.url === `urn:urban:traffic:osm-extract:${sha256}`,
    )
  )
    fail("OSM source geometry is not the exact retained native extraction.");
  const nodes = new Map<string, Position>(),
    ways = new Map<string, string[]>(),
    parser = new SaxesParser({ xmlns: false }),
    path: string[] = [];
  let active: string | null = null,
    elements = 0;
  parser.on("doctype", () =>
    fail("OSM geometry document types are forbidden."),
  );
  parser.on("error", () => fail("Retained OSM geometry is malformed."));
  parser.on("opentag", (tag) => {
    if (++elements > 2000000 || path.length > 16)
      fail("OSM geometry exceeds structural limits.");
    const a = tag.attributes as Record<string, string>;
    if (tag.name === "node" && path.length === 1) {
      if (!/^\d+$/.test(a.id) || nodes.has(a.id) || nodes.size >= 500000)
        fail("OSM node identity/bound is invalid.");
      const p: Position = [Number(a.lon), Number(a.lat)];
      if (
        !p.every(Number.isFinite) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90
      )
        fail("OSM node coordinates are invalid.");
      nodes.set(a.id, p);
    }
    if (tag.name === "way" && path.length === 1) {
      if (!/^\d+$/.test(a.id) || ways.has(a.id) || ways.size >= 20000)
        fail("OSM way identity/bound is invalid.");
      active = a.id;
      ways.set(active, []);
    }
    if (tag.name === "nd" && path.length === 2 && active) {
      if (!/^\d+$/.test(a.ref) || ways.get(active)!.length >= 50000)
        fail("OSM way references exceed bounds.");
      ways.get(active)!.push(a.ref);
    }
    path.push(tag.name);
  });
  parser.on("closetag", () => {
    if (path.pop() === "way") active = null;
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < bytes.length; i += 65536)
    parser.write(
      decoder.decode(bytes.subarray(i, i + 65536), { stream: true }),
    );
  parser.write(decoder.decode()).close();
  return {
    ...index,
    sourceGeometry: {
      sha256,
      bytes: bytes.length,
      nodes,
      ways,
      cache: new Map(),
    },
  };
}
function geometry(
  source: CommuteSourceGeometry,
  id: string,
): WayGeometry | null {
  const cached = source.cache.get(id);
  if (cached) return cached;
  const nodeIds = source.ways.get(id);
  if (!nodeIds || nodeIds.length < 2) return null;
  const points = nodeIds.map((id) => source.nodes.get(id));
  if (points.some((p) => !p)) return null;
  const along = [0];
  for (let i = 1; i < points.length; i++)
    along.push(along.at(-1)! + commuteMeters(points[i - 1]!, points[i]!));
  const result = {
    nodeIds,
    points: points as Position[],
    along,
    total: along.at(-1)!,
  };
  source.cache.set(id, result);
  return result;
}
function segment(p: Position, a: Position, b: Position) {
  const cos = Math.cos((p[1] * Math.PI) / 180),
    dx = (b[0] - a[0]) * cos,
    dy = b[1] - a[1],
    den = dx * dx + dy * dy,
    t = den
      ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) / den),
        )
      : 0,
    point: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, point, distance: commuteMeters(p, point) };
}
function projection(p: Position, g: WayGeometry) {
  const matches: { along: number; distance: number }[] = [];
  for (let i = 1; i < g.points.length; i++) {
    const m = segment(p, g.points[i - 1], g.points[i]);
    if (m.distance <= COMMUTE_SOURCE_QUANTIZATION_METERS)
      matches.push({
        along: g.along[i - 1] + (g.along[i] - g.along[i - 1]) * m.t,
        distance: m.distance,
      });
  }
  if (!matches.length) return null;
  const best = matches.reduce((a, b) => (a.distance <= b.distance ? a : b));
  if (
    matches.some(
      (m) =>
        Math.abs(m.along - best.along) > 2 * COMMUTE_SOURCE_QUANTIZATION_METERS,
    )
  )
    return null;
  return best;
}
function along(shape: Position[]) {
  const values = [0];
  for (let i = 1; i < shape.length; i++)
    values.push(values.at(-1)! + commuteMeters(shape[i - 1], shape[i]));
  return values;
}
function interpolate(
  shape: Position[],
  measure: number[],
  value: number,
): Position {
  for (let i = 1; i < shape.length; i++)
    if (value <= measure[i] || i === shape.length - 1) {
      const span = measure[i] - measure[i - 1],
        t = span ? (value - measure[i - 1]) / span : 0;
      return [
        shape[i - 1][0] + (shape[i][0] - shape[i - 1][0]) * t,
        shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * t,
      ];
    }
  return shape[0];
}
function clip(
  shape: Position[],
  measure: number[],
  start: number,
  end: number,
): Position[] {
  return [
    interpolate(shape, measure, start),
    ...shape.filter(
      (_, i) => measure[i] > start + 1e-7 && measure[i] < end - 1e-7,
    ),
    interpolate(shape, measure, end),
  ].filter((p, i, all) => i === 0 || commuteMeters(all[i - 1], p) > 0.001);
}
function sourceSubpath(g: WayGeometry, start: number, end: number): Position[] {
  const forward = end >= start,
    low = Math.min(start, end),
    high = Math.max(start, end),
    points = clip(g.points, g.along, low, high);
  return forward ? points : points.reverse();
}
/** Every regional segment must cover the same ordered source subpath, not merely have endpoints near a source way. */
function followsSource(
  points: Position[],
  g: WayGeometry,
): { start: number; end: number; direction: 1 | -1; residual: number } | null {
  const projected = points.map((p) => projection(p, g));
  if (projected.some((p) => !p)) return null;
  const start = projected[0]!.along,
    end = projected.at(-1)!.along;
  if (Math.abs(end - start) < 0.01) return null;
  const direction = end > start ? 1 : -1;
  let residual = 0;
  for (let i = 0; i < projected.length; i++) {
    residual = Math.max(residual, projected[i]!.distance);
    if (i === 0) continue;
    const a = projected[i - 1]!.along,
      b = projected[i]!.along;
    if ((b - a) * direction < -COMMUTE_SOURCE_QUANTIZATION_METERS) return null;
    let progress = 0;
    for (const p of sourceSubpath(g, a, b)) {
      const m = segment(p, points[i - 1], points[i]);
      if (
        m.distance > COMMUTE_SOURCE_QUANTIZATION_METERS ||
        m.t < progress - 1e-6
      )
        return null;
      progress = m.t;
      residual = Math.max(residual, m.distance);
    }
  }
  return { start, end, direction, residual };
}
function simple(points: Position[]): boolean {
  const eps = COMMUTE_SOURCE_QUANTIZATION_METERS;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 2; j < points.length; j++)
      if (commuteMeters(points[i], points[j]) <= eps) return false;
  const cross = (a: Position, b: Position, c: Position) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 1; i < points.length; i++)
    for (let j = i + 2; j < points.length; j++) {
      const a = points[i - 1],
        b = points[i],
        c = points[j - 1],
        d = points[j];
      if (
        cross(a, b, c) * cross(a, b, d) < 0 &&
        cross(c, d, a) * cross(c, d, b) < 0
      )
        return false;
    }
  return true;
}
export function proveCommuteSourceJunction(
  a: { edgeId: string; end: number },
  b: { edgeId: string; start: number },
  connection: TrafficNetwork["connections"][number],
  route: CommuteRegionalRoute,
  index: CommuteNativeIndex,
  options: { allowBoundarySides?: boolean } = {},
): CommuteJunctionSourceProof | null {
  const source = index.sourceGeometry,
    from = index.edges.get(a.edgeId),
    to = index.edges.get(b.edgeId);
  if (
    !source ||
    !from ||
    !to ||
    connection.fromEdge !== a.edgeId ||
    connection.toEdge !== b.edgeId ||
    from.to !== to.from ||
    !/^\d+$/.test(from.to) ||
    b.start <= a.end
  )
    return null;
  const nodeId = from.to,
    node = source.nodes.get(nodeId),
    nativeNode = index.nodePositions.get(nodeId);
  if (
    !node ||
    !nativeNode ||
    commuteMeters(node, nativeNode) > COMMUTE_SOURCE_QUANTIZATION_METERS
  )
    return null;
  const measures = along(route.shape),
    points = clip(route.shape, measures, a.end, b.start);
  if (points.length < 2 || !simple(points)) return null;
  const runs: {
    wayId: string;
    start: number;
    end: number;
    firstEdge: number;
    lastEdge: number;
  }[] = [];
  for (const [edgeIndex, e] of route.edges.entries()) {
    const start = Math.max(a.end, measures[e.beginShapeIndex]),
      end = Math.min(b.start, measures[e.endShapeIndex]);
    if (end - start <= 0.001) continue;
    const last = runs.at(-1);
    if (last?.wayId === e.wayId && Math.abs(last.end - start) < 0.01) {
      last.end = end;
      last.lastEdge = edgeIndex;
    } else
      runs.push({
        wayId: e.wayId,
        start,
        end,
        firstEdge: edgeIndex,
        lastEdge: edgeIndex,
      });
  }
  if (
    runs.some((run, i) => i > 0 && Math.abs(run.start - runs[i - 1].end) > 0.01)
  )
    return null;
  if (
    !runs.length ||
    runs.length > 2 ||
    Math.abs(runs[0].start - a.end) > 0.01 ||
    Math.abs(runs.at(-1)!.end - b.start) > 0.01
  )
    return null;
  const missingIncoming = !(index.edgeWays.get(a.edgeId) ?? []).includes(
      runs[0].wayId,
    ),
    missingOutgoing = !(index.edgeWays.get(b.edgeId) ?? []).includes(
      runs.at(-1)!.wayId,
    );
  const boundarySides: NonNullable<
    CommuteJunctionSourceProof["boundarySides"]
  > = [];
  if (missingIncoming || missingOutgoing) {
    // Coordinate precision does not authorize dropping even a short positive interval.
    // The cut must equal the actual adjacent regional edge boundary up to arithmetic roundoff.
    if (
      !options.allowBoundarySides ||
      runs.length !== 1 ||
      missingIncoming === missingOutgoing
    )
      return null;
    const side = missingIncoming ? "incoming" : "outgoing",
      run = runs[0],
      adjacent =
        route.edges[missingIncoming ? run.firstEdge - 1 : run.lastEdge + 1],
      positive = route.edges[missingIncoming ? run.firstEdge : run.lastEdge],
      boundaryIndex = missingIncoming
        ? positive.beginShapeIndex
        : positive.endShapeIndex,
      cut = missingIncoming ? a.end : b.start,
      epsilon = Math.max(1e-7, 64 * Number.EPSILON * measures.at(-1)!);
    if (
      !adjacent ||
      !(
        index.edgeWays.get(missingIncoming ? a.edgeId : b.edgeId) ?? []
      ).includes(adjacent.wayId) ||
      (missingIncoming ? adjacent.endShapeIndex : adjacent.beginShapeIndex) !==
        boundaryIndex ||
      Math.abs(cut - measures[boundaryIndex]) > epsilon ||
      commuteMeters(route.shape[boundaryIndex], node) >
        COMMUTE_SOURCE_QUANTIZATION_METERS ||
      adjacent.endShapeIndex <= adjacent.beginShapeIndex
    )
      return null;
    const g = geometry(source, adjacent.wayId),
      span = route.shape.slice(
        adjacent.beginShapeIndex,
        adjacent.endShapeIndex + 1,
      );
    if (
      !g ||
      g.nodeIds.filter((id) => id === nodeId).length !== 1 ||
      !simple(span)
    )
      return null;
    const match = followsSource(span, g),
      junction = g.along[g.nodeIds.indexOf(nodeId)];
    if (
      !match ||
      match.direction !== (adjacent.forward ? 1 : -1) ||
      Math.abs((missingIncoming ? match.end : match.start) - junction) >
        COMMUTE_SOURCE_QUANTIZATION_METERS
    )
      return null;
    const low = Math.min(match.start, match.end),
      high = Math.max(match.start, match.end),
      ids = g.nodeIds.filter(
        (_, i) =>
          g.along[i] >= low - COMMUTE_SOURCE_QUANTIZATION_METERS &&
          g.along[i] <= high + COMMUTE_SOURCE_QUANTIZATION_METERS,
      );
    if (new Set(ids).size !== ids.length) return null;
    boundarySides.push({
      side,
      regionalEdgeId: adjacent.id,
      wayId: adjacent.wayId,
      direction: match.direction === 1 ? "forward" : "backward",
      regionalBoundaryMeters: measures[boundaryIndex],
      sourceStartMeters: match.start,
      sourceEndMeters: match.end,
      sourceJunctionMeters: junction,
      maximumSourceResidualMeters: match.residual,
    });
  }
  const sourceWayRuns: CommuteJunctionSourceProof["sourceWayRuns"] = [];
  let residual = Math.max(
    0,
    ...boundarySides.map((side) => side.maximumSourceResidualMeters),
  );
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i],
      g = geometry(source, run.wayId);
    if (!g || g.nodeIds.filter((id) => id === nodeId).length !== 1) return null;
    const match = followsSource(
      clip(route.shape, measures, run.start, run.end),
      g,
    );
    if (!match) return null;
    const junction = g.along[g.nodeIds.indexOf(nodeId)],
      low = Math.min(match.start, match.end),
      high = Math.max(match.start, match.end),
      q = COMMUTE_SOURCE_QUANTIZATION_METERS;
    if (runs.length === 1) {
      if (junction < low - q || junction > high + q) return null;
      if (
        (missingIncoming && Math.abs(match.start - junction) > q) ||
        (missingOutgoing && Math.abs(match.end - junction) > q)
      )
        return null;
    } else if (
      i === 0
        ? Math.abs(match.end - junction) > q
        : Math.abs(match.start - junction) > q
    )
      return null;
    // No repeated original node along the traversed source subpath (including loops hidden by collinearity).
    const ids = g.nodeIds.filter(
      (_, j) => g.along[j] >= low - q && g.along[j] <= high + q,
    );
    if (new Set(ids).size !== ids.length) return null;
    residual = Math.max(residual, match.residual);
    sourceWayRuns.push({
      wayId: run.wayId,
      direction: match.direction === 1 ? "forward" : "backward",
      startMeters: match.start,
      endMeters: match.end,
      junctionMeters: junction,
    });
  }
  return {
    method: "exact-original-osm-junction",
    sourceFileSha256: source.sha256,
    junctionNodeId: nodeId,
    junctionPosition: node,
    sourceWayRuns,
    maximumSourceResidualMeters: residual,
    quantizationBoundMeters: COMMUTE_SOURCE_QUANTIZATION_METERS,
    ...(boundarySides.length ? { boundarySides } : {}),
  };
}

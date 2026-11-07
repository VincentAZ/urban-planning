import {
  proveCommuteSourceJunction,
  type CommuteJunctionSourceProof,
  type CommuteSourceGeometry,
} from "./commute-routing-source.js";
import { SaxesParser } from "saxes";
import {
  canonicalJSON,
  type TrafficNetwork,
  type TrafficLane,
  type Position,
  type TrafficCommuteRouteAttachment,
} from "@urban/core";
import {
  commuteHash,
  commuteBytesHash,
  commuteMeters,
  type CommuteRegionalRoute,
} from "./commute-routing-valhalla.js";

export const COMMUTE_MATCH_POLICY = Object.freeze({
  version: 2,
  centerlineJunctionProof:
    "exact retained source ways and original OSM junction; polyline6 quantization only",
  maximumResidualMeters: 25,
  sampleSpacingMeters: 20,
  maximumJunctionGapMeters: 75,
  endpointLane:
    "lowest-index passenger lane with a retained directed connection",
  position: "geometric lane fraction multiplied by retained native lane length",
  time: "retained regional edge elapsed boundaries; linear interpolation within an edge",
  maximumCandidates: 2000,
});
const COMMUTE_MATCH_POLICY_V3 = Object.freeze({
  ...COMMUTE_MATCH_POLICY,
  version: 3,
  zeroSideJunctionProof:
    "exact adjacent regional edge boundary and unique original OSM junction; no positive interval omitted",
});
export function trafficCommuteMatchPolicy(version: 2 | 3) {
  if (version !== 2 && version !== 3)
    throw new Error("Unsupported commute correspondence policy version.");
  return version === 3 ? COMMUTE_MATCH_POLICY_V3 : COMMUTE_MATCH_POLICY;
}
export interface CommuteNativeIndex {
  network: TrafficNetwork;
  sourceGeometry: CommuteSourceGeometry | null;
  nodePositions: Map<string, Position>;
  networkHash: string;
  inventoryHash: string;
  indexHash: string;
  sourcePbfHashes: string[];
  bounds: TrafficNetwork["manifest"]["bounds"];
  xmlProjection: { parameters: string; netOffset: Position } | null;
  rawInternalShapes: Map<string, Position[]>;
  internalShapes: Map<string, Position[]>;
  connectionViaLanes: Map<string, string[]>;
  projectionHash: string | null;
  projectionOutput: string | null;
  projectionReceipt: {
    binarySha256: string;
    args: string[];
    networkXmlHash: string;
    inputSha256: string;
    outputSha256: string;
  } | null;
  edgeWays: Map<string, string[]>;
  ways: Map<string, string[]>;
  edges: Map<string, TrafficNetwork["edges"][number]>;
  connections: Map<string, TrafficNetwork["connections"]>;
}
function invalid(message: string): never {
  throw new Error(message);
}
function passengerAllowed(a: Record<string, string>): boolean {
  return (
    (!Object.hasOwn(a, "allow") ||
      a.allow.split(/\s+/).some((c) => c === "passenger" || c === "all")) &&
    !a.disallow?.split(/\s+/).some((c) => c === "passenger" || c === "all")
  );
}
/** Authoritative original-way IDs come from exact retained lane origId, including joined ways. */
export function buildCommuteNativeIndex(
  network: TrafficNetwork,
  xml: Buffer,
): CommuteNativeIndex {
  if (
    xml.length > 64 * 1024 ** 2 ||
    commuteBytesHash(xml) !== network.manifest.networkFileSha256
  )
    invalid("Native XML size/hash does not match the retained network.");
  const raw = new Map<
    string,
    {
      from: string;
      to: string;
      lanes: Map<
        string,
        { index: number; length: number; ways: string[]; passenger: boolean }
      >;
    }
  >();
  const rawConnections: Record<string, string>[] = [];
  const lanePermissions = new Map<string, boolean>(),
    rawInternalShapes = new Map<string, Position[]>();
  let xmlProjection: CommuteNativeIndex["xmlProjection"] = null,
    internalEdge = false;
  const parser = new SaxesParser({ xmlns: false }),
    path: string[] = [];
  let edge: string | undefined,
    lane: string | undefined,
    elements = 0;
  parser.on("doctype", () =>
    invalid("Native XML document types are forbidden."),
  );
  parser.on("error", () => invalid("Native XML is malformed."));
  parser.on("opentag", (t) => {
    if (++elements > 2000000 || path.length > 64)
      invalid("Native XML exceeds structural limits.");
    const a = t.attributes as Record<string, string>;
    if (t.name === "location" && path.length === 1) {
      const offset = a.netOffset.split(",").map(Number);
      if (offset.length !== 2 || !offset.every(Number.isFinite))
        invalid("Native projection offset is invalid.");
      xmlProjection = {
        parameters: a.projParameter,
        netOffset: offset as Position,
      };
    }
    if (t.name === "edge" && path.length === 1) {
      internalEdge = a.function === "internal";
      edge = a.function === "internal" ? undefined : a.id;
      lane = undefined;
      if (edge) {
        if (raw.has(edge)) invalid("Duplicate native edge.");
        raw.set(edge, { from: a.from, to: a.to, lanes: new Map() });
      }
    }
    if (t.name === "lane" && path.length === 2) {
      if (lanePermissions.has(a.id)) invalid("Duplicate native lane identity.");
      lanePermissions.set(a.id, passengerAllowed(a));
      if (internalEdge) {
        const shape = (a.shape ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((pair) => pair.split(",").slice(0, 2).map(Number));
        if (
          shape.length &&
          shape.some((p) => p.length !== 2 || !p.every(Number.isFinite))
        )
          invalid("Native internal lane shape is invalid.");
        rawInternalShapes.set(a.id, shape as Position[]);
      }
    }
    if (t.name === "lane" && path.length === 2 && edge) {
      lane = a.id;
      const row = raw.get(edge)!;
      if (row.lanes.has(lane)) invalid("Duplicate native lane.");
      row.lanes.set(lane, {
        index: Number(a.index),
        length: Number(a.length),
        ways: [],
        passenger: passengerAllowed(a),
      });
    }
    if (
      t.name === "param" &&
      path.length === 3 &&
      edge &&
      lane &&
      a.key === "origId"
    ) {
      const ids = a.value.split(/\s+/).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id)))
        invalid("Native original way identity is malformed.");
      raw
        .get(edge)!
        .lanes.get(lane)!
        .ways.push(...ids);
    }
    if (t.name === "connection" && path.length === 1) rawConnections.push(a);
    path.push(t.name);
  });
  parser.on("closetag", () => {
    const name = path.pop();
    if (name === "lane") lane = undefined;
    if (name === "edge") edge = undefined;
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let n = 0; n < xml.length; n += 65536)
    parser.write(decoder.decode(xml.subarray(n, n + 65536), { stream: true }));
  parser.write(decoder.decode()).close();
  const ways = new Map<string, string[]>(),
    edges = new Map(network.edges.map((e) => [e.id, e]));
  if (raw.size !== edges.size)
    invalid("Native XML and inventory edge sets disagree.");
  const bindings = [];
  for (const e of network.edges) {
    const r = raw.get(e.id);
    if (
      !r ||
      r.from !== e.from ||
      r.to !== e.to ||
      r.lanes.size !== e.lanes.length
    )
      invalid("Native topology differs from inventory.");
    const ids = new Set<string>();
    for (const l of e.lanes) {
      const native = r.lanes.get(l.id);
      if (
        !native ||
        native.index !== l.index ||
        native.length !== l.lengthMeters ||
        native.passenger !== l.allowedClasses.includes("passenger") ||
        !native.ways.length
      )
        invalid(
          "Native lane identity/length/source ways differ or are absent.",
        );
      for (const id of native.ways) ids.add(id);
    }
    bindings.push({ edgeId: e.id, ways: [...ids].sort() });
    for (const id of ids) {
      const list = ways.get(id) ?? [];
      list.push(e.id);
      ways.set(id, list);
    }
  }
  const rawByMovement = new Map(
    rawConnections.map((c) => [
      canonicalJSON([
        c.from,
        c.to,
        c.from + "_" + c.fromLane,
        c.to + "_" + c.toLane,
        c.via?.split(/\s+/).filter(Boolean) ?? [],
      ]),
      c,
    ]),
  );
  const internalByLane = new Map<string, Record<string, string>[]>();
  for (const c of rawConnections) {
    const key = c.from + "_" + c.fromLane + "\0" + c.to + "_" + c.toLane;
    const rows = internalByLane.get(key) ?? [];
    rows.push(c);
    internalByLane.set(key, rows);
  }
  const connectionViaLanes = new Map<string, string[]>();
  const movementAllowed = (c: Record<string, string>) => {
    const target = c.to + "_" + c.toLane,
      seen = new Set<string>(),
      pending = [c];
    while (pending.length) {
      const current = pending.pop()!;
      if (!passengerAllowed(current)) return false;
      for (const via of current.via?.split(/\s+/).filter(Boolean) ?? []) {
        if (seen.has(via) || lanePermissions.get(via) !== true) return false;
        seen.add(via);
        const next = internalByLane.get(via + "\0" + target);
        if (next?.length !== 1) return false;
        pending.push(next[0]);
      }
    }
    connectionViaLanes.set(
      canonicalJSON([
        c.from,
        c.to,
        c.from + "_" + c.fromLane,
        c.to + "_" + c.toLane,
        c.via?.split(/\s+/).filter(Boolean) ?? [],
      ]),
      [...seen],
    );
    return true;
  };
  const nativeMovements = new Set(
    rawConnections
      .filter((c) => edges.has(c.from) && edges.has(c.to))
      .map((c) =>
        canonicalJSON([
          c.from,
          c.to,
          c.from + "_" + c.fromLane,
          c.to + "_" + c.toLane,
          c.via?.split(/\s+/).filter(Boolean) ?? [],
        ]),
      ),
  );
  if (nativeMovements.size !== network.connections.length)
    invalid("Native XML and inventory movement sets disagree.");
  const connections = new Map<string, TrafficNetwork["connections"]>();
  for (const c of network.connections) {
    if (
      !nativeMovements.delete(
        canonicalJSON([
          c.fromEdge,
          c.toEdge,
          c.fromLane,
          c.toLane,
          c.viaLaneIds,
        ]),
      )
    )
      invalid("Native lane movement differs from retained XML.");
    const rawMovement = rawByMovement.get(
      canonicalJSON([c.fromEdge, c.toEdge, c.fromLane, c.toLane, c.viaLaneIds]),
    )!;
    if (!movementAllowed(rawMovement)) continue;
    connectionViaLanes.set(
      c.id,
      connectionViaLanes.get(
        canonicalJSON([
          c.fromEdge,
          c.toEdge,
          c.fromLane,
          c.toLane,
          c.viaLaneIds,
        ]),
      )!,
    );
    const k = c.fromEdge + "\0" + c.toEdge;
    const rows = connections.get(k) ?? [];
    rows.push(c);
    connections.set(k, rows);
  }
  const bounds = [
    ...network.manifest.bounds,
  ] as TrafficNetwork["manifest"]["bounds"];
  for (const e of network.edges)
    for (const l of e.lanes)
      for (const p of l.shape) {
        bounds[0] = Math.min(bounds[0], p[0]);
        bounds[1] = Math.min(bounds[1], p[1]);
        bounds[2] = Math.max(bounds[2], p[0]);
        bounds[3] = Math.max(bounds[3], p[1]);
      }
  return {
    network,
    sourceGeometry: null,
    nodePositions: new Map(network.nodes.map((n) => [n.id, n.position])),
    bounds,
    xmlProjection,
    rawInternalShapes,
    internalShapes: new Map(),
    projectionHash: null,
    projectionOutput: null,
    projectionReceipt: null,
    connectionViaLanes,
    edgeWays: new Map(bindings.map((b) => [b.edgeId, b.ways])),
    networkHash: network.manifest.networkFileSha256,
    inventoryHash: commuteHash(network),
    indexHash: commuteHash(bindings),
    sourcePbfHashes: network.manifest.sourceFiles
      .filter((f) => f.url.endsWith(".osm.pbf"))
      .map((f) => f.sha256),
    ways,
    edges,
    connections,
  };
}
interface Projection {
  distance: number;
  fraction: number;
  position: Position;
  segment: number;
  along: number;
}
let measurementCache = new WeakMap<
  Position[],
  { parts: number[]; sum: number[]; total: number }
>();
function lengths(shape: Position[]) {
  const cached = measurementCache.get(shape);
  if (cached) return cached;
  const parts = shape.slice(1).map((p, i) => commuteMeters(shape[i], p)),
    sum = [0];
  for (const p of parts) sum.push(sum.at(-1)! + p);
  const result = { parts, sum, total: sum.at(-1)! };
  measurementCache.set(shape, result);
  return result;
}
function project(
  p: Position,
  shape: Position[],
  allowed?: Set<number>,
): Projection {
  const len = lengths(shape);
  let best: Projection = {
    distance: Infinity,
    fraction: 0,
    position: shape[0],
    segment: 0,
    along: 0,
  };
  for (const i of allowed ?? len.parts.keys()) {
    const a = shape[i],
      b = shape[i + 1],
      cos = Math.cos((p[1] * Math.PI) / 180),
      x = (b[0] - a[0]) * cos,
      y = b[1] - a[1],
      px = (p[0] - a[0]) * cos,
      py = p[1] - a[1],
      den = x * x + y * y,
      t = den ? Math.max(0, Math.min(1, (px * x + py * y) / den)) : 0;
    const at: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      d = commuteMeters(p, at);
    if (d < best.distance)
      best = {
        distance: d,
        fraction: t,
        position: at,
        segment: i,
        along: len.sum[i] + len.parts[i] * t,
      };
  }
  return best;
}
function at(shape: Position[], value: number): Position {
  const l = lengths(shape);
  for (let i = 0; i < l.parts.length; i++)
    if (value <= l.sum[i + 1] || i === l.parts.length - 1) {
      const t = l.parts[i] ? (value - l.sum[i]) / l.parts[i] : 0;
      return [
        shape[i][0] + (shape[i + 1][0] - shape[i][0]) * t,
        shape[i][1] + (shape[i + 1][1] - shape[i][1]) * t,
      ];
    }
  return shape[0];
}
interface Candidate {
  edgeId: string;
  laneId: string;
  start: number;
  end: number;
  laneStart: number;
  laneEnd: number;
  residual: number;
}
function candidate(
  lane: TrafficLane,
  edgeId: string,
  route: CommuteRegionalRoute,
  segments: Set<number>,
): Candidate | null {
  const shape = route.shape,
    rl = lengths(shape),
    ll = lengths(lane.shape),
    t = COMMUTE_MATCH_POLICY.maximumResidualMeters;
  const first = project(lane.shape[0], shape, segments),
    last = project(lane.shape.at(-1)!, shape, segments),
    home = project(shape[0], lane.shape),
    work = project(shape.at(-1)!, lane.shape);
  let start = first.along,
    end = last.along,
    ls = 0,
    le = ll.total,
    residual = Math.max(first.distance, last.distance);
  if (
    segments.has(0) &&
    home.distance <= t &&
    home.along > 0 &&
    home.along < ll.total
  ) {
    start = 0;
    ls = home.along;
    residual = last.distance;
  }
  if (
    segments.has(shape.length - 2) &&
    work.distance <= t &&
    work.along > 0 &&
    work.along <= ll.total
  ) {
    end = rl.total;
    le = work.along;
    residual = start === 0 ? 0 : first.distance;
  }
  if (residual > t || le - ls < 0.01) return null;
  if (lane.lengthMeters <= 1 && Math.abs(end - start) <= 1)
    return {
      edgeId,
      laneId: lane.id,
      start: Math.min(start, end),
      end: Math.max(start, end),
      laneStart: 0,
      laneEnd: lane.lengthMeters,
      residual,
    };
  if (end - start < 0.1) return null;
  let previous = start;
  for (
    let d = ls;
    d <= le;
    d = Math.min(le, d + COMMUTE_MATCH_POLICY.sampleSpacingMeters)
  ) {
    const p = project(at(lane.shape, d), shape, segments);
    if (
      p.distance > t ||
      p.along < previous - 1 ||
      p.along < start - 1 ||
      p.along > end + 1
    )
      return null;
    residual = Math.max(residual, p.distance);
    previous = p.along;
    if (d === le) break;
  }
  // Both directions of the geometric check prevent accepting a shortcut across a curved route.
  for (
    let d = start;
    d <= end;
    d = Math.min(end, d + COMMUTE_MATCH_POLICY.sampleSpacingMeters)
  ) {
    const p = project(at(shape, d), lane.shape);
    if (p.distance > t || p.along < ls - 1 || p.along > le + 1) return null;
    residual = Math.max(residual, p.distance);
    if (d === end) break;
  }
  return {
    edgeId,
    laneId: lane.id,
    start,
    end,
    laneStart: (ls / ll.total) * lane.lengthMeters,
    laneEnd: (le / ll.total) * lane.lengthMeters,
    residual,
  };
}
function elapsed(route: CommuteRegionalRoute, distance: number): number {
  const len = lengths(route.shape);
  if (distance <= 0) return 0;
  if (distance >= len.total) return route.seconds;
  const e = route.edges.find(
    (e) =>
      len.sum[e.endShapeIndex] >= distance &&
      len.sum[e.endShapeIndex] > len.sum[e.beginShapeIndex],
  );
  if (!e) invalid("Route lacks a timed edge for its local cut.");
  const start = len.sum[e.beginShapeIndex],
    span = len.sum[e.endShapeIndex] - start;
  return (
    e.startSeconds +
    ((e.endSeconds - e.startSeconds) * (distance - start)) / span
  );
}
interface EndpointEvidence {
  laneId: string;
  positionMeters: number;
  regionalCutPoint: Position;
  lanePoint: Position;
  residualMeters: number;
  reference: "SUMO vehicle front position";
}
function endpointEvidence(
  route: CommuteRegionalRoute,
  index: CommuteNativeIndex,
  c: Candidate,
  end: boolean,
): EndpointEvidence {
  const lane = index.edges.get(c.edgeId)!.lanes.find((l) => l.id === c.laneId)!,
    positionMeters = end ? c.laneEnd : c.laneStart,
    regionalCutPoint = at(route.shape, end ? c.end : c.start),
    lanePoint = at(
      lane.shape,
      (positionMeters / lane.lengthMeters) * lengths(lane.shape).total,
    );
  return {
    laneId: lane.id,
    positionMeters,
    regionalCutPoint,
    lanePoint,
    residualMeters: commuteMeters(regionalCutPoint, lanePoint),
    reference: "SUMO vehicle front position",
  };
}
interface MovementEvidence {
  centerlineProof: CommuteJunctionSourceProof | null;
  connectionId: string;
  fromLane: string;
  toLane: string;
  viaLaneIds: string[];
  regionalStartMeters: number;
  regionalEndMeters: number;
  regionalLengthMeters: number;
  nativeLengthMeters: number;
  maximumResidualMeters: number;
}
export function commuteMovementProof(
  a: Candidate,
  b: Candidate,
  c: TrafficNetwork["connections"][number],
  route: CommuteRegionalRoute,
  index: CommuteNativeIndex,
  options: { policyVersion?: 2 | 3 } = {},
): MovementEvidence | null {
  const from = index.edges
      .get(a.edgeId)!
      .lanes.find((l) => l.id === c.fromLane)!,
    to = index.edges.get(b.edgeId)!.lanes.find((l) => l.id === c.toLane)!,
    via = index.connectionViaLanes.get(c.id) ?? [];
  if (via.some((id) => (index.internalShapes.get(id)?.length ?? 0) < 2))
    return null;
  const shape = [
      from.shape.at(-1)!,
      ...via.flatMap((id) => index.internalShapes.get(id)!),
      to.shape[0],
    ],
    nativeLength = lengths(shape).total,
    gap = Math.max(0, b.start - a.end);
  // Native offsets/junction clipping can shorten centerline representation slightly. Never replace a regional detour by an arbitrary connector.
  const needsCenterlineProof =
      gap > nativeLength + Math.max(5, nativeLength * 0.1),
    centerlineProof = needsCenterlineProof
      ? proveCommuteSourceJunction(a, b, c, route, index, {
          allowBoundarySides: options.policyVersion === 3,
        })
      : null;
  if (needsCenterlineProof && !centerlineProof) return null;
  let previous = 0,
    residual = 0;
  for (
    let d = a.end;
    d <= Math.max(a.end, b.start);
    d = Math.min(Math.max(a.end, b.start), d + 2)
  ) {
    const p = project(at(route.shape, d), shape);
    if (p.distance > 25 || p.along < previous - 1) return null;
    previous = p.along;
    residual = Math.max(residual, p.distance);
    if (d >= b.start) break;
  }
  return {
    centerlineProof,
    connectionId: c.id,
    fromLane: c.fromLane,
    toLane: c.toLane,
    viaLaneIds: via,
    regionalStartMeters: a.end,
    regionalEndMeters: b.start,
    regionalLengthMeters: gap,
    nativeLengthMeters: nativeLength,
    maximumResidualMeters: residual,
  };
}
export interface CommuteCorrespondenceEvidence {
  version: 1;
  policy: ReturnType<typeof trafficCommuteMatchPolicy>;
  regionalRouteHash: string;
  nativeXmlHash: string;
  nativeInventoryHash: string;
  nativeOriginalWaysHash: string;
  nativeProjectionHash: string | null;
  originalSourceGeometryHash: string | null;
  candidates: Candidate[];
  selected: Candidate[];
  reason: string | null;
  movements: MovementEvidence[];
  endpoints: null | { departure: EndpointEvidence; arrival: EndpointEvidence };
  bindingHash: string;
}
/** Conservative bbox exclusion: only a route with no segment touching the complete native extent can be called outside-local. */
function intersectsBounds(
  shape: Position[],
  bounds: TrafficNetwork["manifest"]["bounds"],
): boolean {
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1],
      b = shape[i];
    let lo = 0,
      hi = 1;
    for (let axis = 0; axis < 2; axis++) {
      const d = b[axis] - a[axis];
      if (d === 0) {
        if (a[axis] < bounds[axis] || a[axis] > bounds[axis + 2]) {
          lo = 2;
          break;
        }
      } else {
        const p = (bounds[axis] - a[axis]) / d,
          q = (bounds[axis + 2] - a[axis]) / d;
        lo = Math.max(lo, Math.min(p, q));
        hi = Math.min(hi, Math.max(p, q));
      }
    }
    if (lo <= hi) return true;
  }
  return false;
}
export function matchCommuteRoute(
  flowId: string,
  route: CommuteRegionalRoute,
  index: CommuteNativeIndex,
  options: { policyVersion?: 2 | 3 } = {},
): {
  attachment: TrafficCommuteRouteAttachment;
  evidence: CommuteCorrespondenceEvidence;
} {
  measurementCache = new WeakMap();
  const policy = trafficCommuteMatchPolicy(options.policyVersion ?? 2);
  if (!index.sourcePbfHashes.includes(route.sourcePbfHash))
    invalid(
      "Regional and local networks do not share the exact retained source PBF.",
    );
  const routeHash = commuteHash(route),
    waySegments = new Map<string, Set<number>>();
  for (const e of route.edges) {
    const set = waySegments.get(e.wayId) ?? new Set();
    for (let n = e.beginShapeIndex; n < e.endShapeIndex; n++) set.add(n);
    waySegments.set(e.wayId, set);
  }
  const relevant = new Map<string, Set<number>>();
  for (const [way, segments] of waySegments)
    for (const id of index.ways.get(way) ?? []) {
      const set = relevant.get(id) ?? new Set();
      for (const n of segments) set.add(n);
      relevant.set(id, set);
    }
  const candidates: Candidate[] = [];
  for (const [id, segments] of relevant) {
    for (const lane of index.edges
      .get(id)!
      .lanes.filter((l) => l.allowedClasses.includes("passenger"))) {
      const c = candidate(lane, id, route, segments);
      if (c) candidates.push(c);
    }
  }
  if (candidates.length > COMMUTE_MATCH_POLICY.maximumCandidates)
    invalid(
      "Local correspondence exceeds processing bounds; nothing was truncated.",
    );
  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = grouped.get(c.edgeId) ?? [];
    list.push(c);
    grouped.set(c.edgeId, list);
  }
  const representatives = [...grouped.values()]
    .map(
      (cs) =>
        cs.sort(
          (a, b) =>
            index.edges.get(a.edgeId)!.lanes.find((l) => l.id === a.laneId)!
              .index -
            index.edges.get(b.edgeId)!.lanes.find((l) => l.id === b.laneId)!
              .index,
        )[0],
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const movementCache = new Map<string, MovementEvidence | null>();
  const movement = (a: Candidate, b: Candidate) => {
    const key = a.edgeId + "\0" + b.edgeId;
    if (movementCache.has(key)) return movementCache.get(key)!;
    let proof: MovementEvidence | null = null;
    for (const c of index.connections.get(key) ?? []) {
      const from = grouped.get(a.edgeId)!.find((l) => l.laneId === c.fromLane),
        to = grouped.get(b.edgeId)!.find((l) => l.laneId === c.toLane);
      if (from && to) {
        proof = commuteMovementProof(from, to, c, route, index, options);
        if (proof) break;
      }
    }
    movementCache.set(key, proof);
    return proof;
  };
  const sourceCovered = (chain: Candidate[]) => {
    const allowed = new Set(
        chain.flatMap((c) => index.edgeWays.get(c.edgeId) ?? []),
      ),
      len = lengths(route.shape),
      start = chain[0].start,
      end = chain.at(-1)!.end;
    return route.edges.every(
      (e) =>
        len.sum[e.endShapeIndex] <= start + 0.01 ||
        len.sum[e.beginShapeIndex] >= end - 0.01 ||
        len.sum[e.endShapeIndex] - len.sum[e.beginShapeIndex] < 0.01 ||
        allowed.has(e.wayId),
    );
  };
  let selected: Candidate[] = [],
    reason: string | null = null,
    status: TrafficCommuteRouteAttachment["status"] = "routed";
  if (!representatives.length) {
    const outside = !intersectsBounds(route.shape, index.bounds);
    status = outside ? "no-local-intersection" : "unmatched-local-network";
    reason = outside
      ? "No regional route segment intersects the bounding extent containing every retained native lane."
      : "The regional route enters the native extent but lacks a source-bound permitted directed correspondence.";
  } else {
    const start = Math.min(...representatives.map((c) => c.start)),
      end = Math.max(...representatives.map((c) => c.end)),
      solutions: Candidate[][] = [];
    let explored = 0;
    const visit = (chain: Candidate[]) => {
      if (++explored > 100000)
        invalid(
          "Local correspondence search exceeds its bounded state budget.",
        );
      if (solutions.length > 1) return;
      const last = chain.at(-1)!;
      if (last.end >= end - 1) {
        if (sourceCovered(chain)) solutions.push(chain);
        return;
      }
      for (const next of representatives) {
        if (
          chain.some((c) => c.edgeId === next.edgeId) ||
          next.start < last.end - 25 ||
          next.end < last.end - 25 ||
          next.start - last.end > COMMUTE_MATCH_POLICY.maximumJunctionGapMeters
        )
          continue;
        if (!movement(last, next)) continue;
        visit([...chain, next]);
      }
    };
    for (const first of representatives.filter((c) => c.start <= start + 1))
      visit([first]);
    if (solutions.length !== 1) {
      status = "unmatched-local-network";
      reason = solutions.length
        ? "More than one directed local edge chain matches the captured regional path."
        : "Captured source/geometry candidates do not form one complete connected local chain.";
      const sorted = representatives,
        b = index.bounds;
      const outside = (p: Position) =>
        p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3];
      if (
        sorted.some((c, i) => {
          if (i === 0) return false;
          const end = Math.max(...sorted.slice(0, i).map((p) => p.end));
          return (
            c.start - end > COMMUTE_MATCH_POLICY.maximumJunctionGapMeters &&
            outside(at(route.shape, (c.start + end) / 2))
          );
        })
      ) {
        status = "reentry-unsupported";
        reason =
          "The route leaves the native graph bounding extent between local episodes; no vehicles were duplicated or teleported.";
      }
    } else selected = solutions[0];
  }
  let local: TrafficCommuteRouteAttachment["local"] = null;
  let endpoints: CommuteCorrespondenceEvidence["endpoints"] = null;
  if (selected.length) {
    const b = index.bounds,
      inside = (p: Position) =>
        p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];
    const total = lengths(route.shape).total;
    if (
      (selected[0].start > 1 && inside(route.shape[0])) ||
      (total - selected.at(-1)!.end > 1 && inside(route.shape.at(-1)!))
    ) {
      status = "unmatched-local-network";
      reason =
        "An internal endpoint is not represented by a permitted native lane; no internal access leg was discarded as a boundary trip.";
      selected = [];
    }
  }
  if (selected.length) {
    const first = selected[0],
      last = selected.at(-1)!,
      firstChoices = grouped.get(first.edgeId)!,
      lastChoices = grouped.get(last.edgeId)!;
    let departure: Candidate | undefined, arrival: Candidate | undefined;
    if (selected.length === 1) {
      departure = arrival = firstChoices.find(
        (c) =>
          c.laneEnd > c.laneStart &&
          c.laneStart <
            index.edges.get(c.edgeId)!.lanes.find((l) => l.id === c.laneId)!
              .lengthMeters,
      );
    } else {
      const firstMovement = movement(first, selected[1]),
        lastMovement = movement(selected.at(-2)!, last);
      departure = firstChoices.find(
        (c) => c.laneId === firstMovement?.fromLane,
      );
      arrival = lastChoices.find((c) => c.laneId === lastMovement?.toLane);
    }
    if (!departure || !arrival)
      invalid("No source-bound permitted endpoint lane pair.");
    const b = index.bounds,
      inside = (p: Position) =>
        p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];
    if (
      (departure.start > 1 && inside(route.shape[0])) ||
      (lengths(route.shape).total - arrival.end > 1 &&
        inside(route.shape.at(-1)!))
    )
      invalid("Chosen endpoint lane would omit an internal access leg.");
    endpoints = {
      departure: endpointEvidence(route, index, departure, false),
      arrival: endpointEvidence(route, index, arrival, true),
    };
    const prefixSeconds = elapsed(route, departure.start),
      suffixSeconds = route.seconds - elapsed(route, arrival.end),
      classification =
        prefixSeconds === 0
          ? suffixSeconds === 0
            ? "internal"
            : "outbound"
          : suffixSeconds === 0
            ? "inbound"
            : "through";
    local = {
      edges: selected.map((c) => c.edgeId),
      prefixSeconds,
      suffixSeconds,
      classification,
      bindingHash: "",
      departLaneId: departure.laneId,
      departPositionMeters: departure.laneStart,
      arrivalLaneId: arrival.laneId,
      arrivalPositionMeters: arrival.laneEnd,
    };
    selected = [...selected];
    selected[0] = departure;
    selected[selected.length - 1] = arrival;
  }
  const body = {
    version: 1 as const,
    policy,
    regionalRouteHash: routeHash,
    nativeXmlHash: index.networkHash,
    nativeInventoryHash: index.inventoryHash,
    nativeOriginalWaysHash: index.indexHash,
    nativeProjectionHash: index.projectionHash,
    originalSourceGeometryHash: index.sourceGeometry?.sha256 ?? null,
    candidates,
    selected,
    reason,
    movements: selected.slice(1).map((c, i) => movement(selected[i], c)!),
    endpoints,
  };
  const bindingHash = commuteHash(body);
  if (local) local.bindingHash = bindingHash;
  return {
    attachment: {
      flowId,
      status,
      regionalRouteHash: routeHash,
      regionalSeconds: route.seconds,
      local,
      notes: [
        ...(reason ? [reason] : []),
        "Native lane choice is an explicit modeled rule, not an observed travel lane.",
        "Correspondence uses shared original ways, directed geometry and retained native connections; no nearest-port substitution.",
        ...(local
          ? [
              "Partial-edge cut time is interpolated between captured regional edge elapsed times; junction delays remain in those elapsed boundaries.",
            ]
          : []),
      ],
    },
    evidence: { ...body, bindingHash },
  };
}

/** Reconstruct the local attachment from hash-bound retained proof; no routing, native process or rematching. */
export function projectRetainedCommuteAttachment<
  T extends Pick<
    CommuteCorrespondenceEvidence,
    "regionalRouteHash" | "selected" | "endpoints" | "reason" | "bindingHash"
  >,
>(
  _flowId: string,
  regional: CommuteRegionalRoute,
  evidence: T,
): NonNullable<TrafficCommuteRouteAttachment["local"]> {
  const { bindingHash, ...body } = evidence;
  if (
    commuteHash(body) !== bindingHash ||
    commuteHash(regional) !== evidence.regionalRouteHash ||
    evidence.reason !== null ||
    !Array.isArray(evidence.selected) ||
    !evidence.selected.length ||
    !Number.isFinite(regional.seconds) ||
    regional.seconds <= 0
  )
    invalid(
      "Retained commute correspondence is absent or differs from its bound regional proof.",
    );
  measurementCache = new WeakMap();
  const selected = evidence.selected,
    total = lengths(regional.shape).total;
  if (
    new Set(selected.map((c) => c.edgeId)).size !== selected.length ||
    selected.some(
      (c) =>
        !c.edgeId ||
        !c.laneId ||
        ![c.start, c.end, c.laneStart, c.laneEnd, c.residual].every(
          Number.isFinite,
        ) ||
        c.start < 0 ||
        c.end < c.start ||
        c.end > total + 1e-6 ||
        c.laneStart < 0 ||
        c.laneEnd <= c.laneStart,
    )
  )
    invalid("Retained selected lane cuts are invalid.");
  const first = selected[0],
    last = selected.at(-1)!,
    endpoints = evidence.endpoints;
  if (
    !endpoints ||
    endpoints.departure.laneId !== first.laneId ||
    endpoints.arrival.laneId !== last.laneId ||
    endpoints.departure.positionMeters !== first.laneStart ||
    endpoints.arrival.positionMeters !== last.laneEnd ||
    canonicalJSON(endpoints.departure.regionalCutPoint) !==
      canonicalJSON(at(regional.shape, first.start)) ||
    canonicalJSON(endpoints.arrival.regionalCutPoint) !==
      canonicalJSON(at(regional.shape, last.end))
  )
    invalid("Retained endpoint evidence disagrees with selected native cuts.");
  const prefixSeconds = elapsed(regional, first.start),
    suffixSeconds = regional.seconds - elapsed(regional, last.end);
  if (
    prefixSeconds < 0 ||
    suffixSeconds < 0 ||
    prefixSeconds + suffixSeconds >= regional.seconds
  )
    invalid("Retained commute time decomposition is invalid.");
  return {
    edges: selected.map((c) => c.edgeId),
    prefixSeconds,
    suffixSeconds,
    classification:
      prefixSeconds === 0
        ? suffixSeconds === 0
          ? "internal"
          : "outbound"
        : suffixSeconds === 0
          ? "inbound"
          : "through",
    bindingHash,
    departLaneId: first.laneId,
    departPositionMeters: first.laneStart,
    arrivalLaneId: last.laneId,
    arrivalPositionMeters: last.laneEnd,
  };
}

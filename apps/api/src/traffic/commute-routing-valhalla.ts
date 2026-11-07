import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, type Position } from "@urban/core";
import { routingCostingProfile } from "../routing/valhalla.js";

export const COMMUTE_ROUTE_LIMITS = Object.freeze({
  responseBytes: 16 * 1024 ** 2,
  requestMilliseconds: 30000,
  shapePoints: 16000,
  edges: 20000,
  routeMeters: 200000,
  snapMeters: 250,
});
export const commuteHash = (v: unknown) =>
  createHash("sha256").update(canonicalJSON(v)).digest("hex");
export const commuteBytesHash = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
export interface RegionalRouteEdge {
  id: string;
  wayId: string;
  forward: boolean;
  beginShapeIndex: number;
  endShapeIndex: number;
  startSeconds: number;
  endSeconds: number;
  sourcePercentAlong: number | null;
  targetPercentAlong: number | null;
}
export interface CommuteRegionalRoute {
  version: 1;
  request: { home: Position; work: Position };
  graphHash: string;
  settingsHash: string;
  sourcePbfHash: string;
  shape: Position[];
  segmentSeconds: number[];
  edges: RegionalRouteEdge[];
  seconds: number;
  homeSnapMeters: number;
  workSnapMeters: number;
  rawRouteHash: string;
  rawTraceHash: string;
  notes: string[];
}
export interface CapturedRegionalRoute {
  route: CommuteRegionalRoute;
  routeHash: string;
  rawRoute: Buffer;
  rawTrace: Buffer;
}
export class CommuteRoutingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommuteRoutingError";
  }
}
const fail = (message: string): never => {
  throw new CommuteRoutingError("INVALID_ROUTE_EVIDENCE", message);
};
const num = z.number().finite();
const routeSchema = z.object({
  trip: z.object({
    status: z.literal(0),
    summary: z.object({ time: num.nonnegative(), length: num.nonnegative() }),
    legs: z.array(z.object({ shape: z.string().min(1) })).length(1),
  }),
  warnings: z.array(z.unknown()).optional(),
});
const traceSchema = z.object({
  shape: z.string().min(1),
  edges: z
    .array(
      z.object({
        id: z.union([
          z.number().int().nonnegative().safe(),
          z.string().regex(/^\d+$/),
        ]),
        way_id: z.union([
          z.number().int().positive().safe(),
          z.string().regex(/^\d+$/),
        ]),
        forward: z.boolean(),
        begin_shape_index: num.int().nonnegative(),
        end_shape_index: num.int().nonnegative(),
        source_percent_along: num.min(0).max(1).optional(),
        target_percent_along: num.min(0).max(1).optional(),
        end_node: z.object({ elapsed_time: num.nonnegative() }),
      }),
    )
    .min(1)
    .max(COMMUTE_ROUTE_LIMITS.edges),
  shape_attributes: z.object({
    time: z.array(num.nonnegative()).max(COMMUTE_ROUTE_LIMITS.shapePoints),
  }),
  warnings: z.array(z.unknown()).optional(),
  alternate_paths: z.array(z.unknown()).optional(),
});
/** Valhalla's six-decimal polyline, bounded and safe-integer checked. */
export function decodeCommutePolyline(encoded: string): Position[] {
  const coordinates: Position[] = [];
  let offset = 0,
    lat = 0,
    lon = 0;
  const part = () => {
    let value = 0,
      shift = 0;
    while (true) {
      if (offset >= encoded.length || shift > 30)
        fail("Malformed encoded route shape.");
      const b = encoded.charCodeAt(offset++) - 63;
      if (b < 0 || b > 63) fail("Malformed encoded route shape.");
      value += (b & 31) * 2 ** shift;
      shift += 5;
      if (b < 32) break;
    }
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  while (offset < encoded.length) {
    lat += part();
    lon += part();
    if (Math.abs(lat) > 90e6 || Math.abs(lon) > 180e6)
      fail("Route coordinates outside longitude/latitude bounds.");
    coordinates.push([lon / 1e6, lat / 1e6]);
    if (coordinates.length > COMMUTE_ROUTE_LIMITS.shapePoints)
      fail("Route exceeds retained point bound; no points were truncated.");
  }
  if (coordinates.length < 2) fail("Route shape is empty.");
  return coordinates;
}
export function commuteMeters(a: Position, b: Position): number {
  const rad = Math.PI / 180,
    r = 6371008.8,
    dlat = (b[1] - a[1]) * rad,
    dlon = (b[0] - a[0]) * rad;
  return (
    2 *
    r *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dlat / 2) ** 2 +
            Math.cos(a[1] * rad) *
              Math.cos(b[1] * rad) *
              Math.sin(dlon / 2) ** 2,
        ),
      ),
    )
  );
}
/** No guessed edge times. Exact trace elapsed times and per-segment times are both retained. */
export function normalizeCommuteRoute(input: {
  home: Position;
  work: Position;
  graphHash: string;
  settingsHash: string;
  sourcePbfHash: string;
  rawRoute: Buffer;
  rawTrace: Buffer;
}): CapturedRegionalRoute {
  const raw = routeSchema.parse(JSON.parse(input.rawRoute.toString("utf8"))),
    trace = traceSchema.parse(JSON.parse(input.rawTrace.toString("utf8")));
  if (
    raw.warnings?.length ||
    trace.warnings?.length ||
    trace.alternate_paths?.length
  )
    fail("Route/trace warnings or alternative matches require review.");
  if (raw.trip.summary.length * 1000 > COMMUTE_ROUTE_LIMITS.routeMeters)
    fail("Route exceeds the declared 200 km profile; it was not shortened.");
  const shape = decodeCommutePolyline(trace.shape),
    original = decodeCommutePolyline(raw.trip.legs[0].shape);
  if (canonicalJSON(shape) !== canonicalJSON(original))
    fail("Exact edge_walk changed the captured route geometry.");
  if (trace.shape_attributes.time.length !== shape.length - 1)
    fail("Trace must retain one elapsed time per route shape segment.");
  let previous = 0,
    index = 0;
  const edges = trace.edges.map((e) => {
    if (
      e.begin_shape_index !== index ||
      e.end_shape_index < index ||
      e.end_shape_index >= shape.length ||
      e.end_node.elapsed_time < previous
    )
      fail("Trace edges are disconnected, unordered or have decreasing time.");
    const result: RegionalRouteEdge = {
      id: String(e.id),
      wayId: String(e.way_id),
      forward: e.forward,
      beginShapeIndex: e.begin_shape_index,
      endShapeIndex: e.end_shape_index,
      startSeconds: previous,
      endSeconds: e.end_node.elapsed_time,
      sourcePercentAlong: e.source_percent_along ?? null,
      targetPercentAlong: e.target_percent_along ?? null,
    };
    index = e.end_shape_index;
    previous = e.end_node.elapsed_time;
    return result;
  });
  if (
    index !== shape.length - 1 ||
    Math.abs(previous - raw.trip.summary.time) > 1.1
  )
    fail("Route and exact trace total time/extent disagree.");
  const homeSnapMeters = commuteMeters(input.home, shape[0]),
    workSnapMeters = commuteMeters(input.work, shape.at(-1)!);
  if (homeSnapMeters > 250 || workSnapMeters > 250)
    throw new CommuteRoutingError(
      "UNSNAPPABLE",
      "A Census internal point is more than 250 m from its chosen route attachment.",
    );
  const route: CommuteRegionalRoute = {
    version: 1,
    request: { home: input.home, work: input.work },
    graphHash: input.graphHash,
    settingsHash: input.settingsHash,
    sourcePbfHash: input.sourcePbfHash,
    shape,
    segmentSeconds: trace.shape_attributes.time,
    edges,
    seconds: previous,
    homeSnapMeters,
    workSnapMeters,
    rawRouteHash: commuteBytesHash(input.rawRoute),
    rawTraceHash: commuteBytesHash(input.rawTrace),
    notes: [
      "Census block internal points are modeled endpoints, not observed home/work entrances.",
      "Static captured-network travel time; no observed congestion or route-choice validation.",
      "Travel in the point-to-network gaps is excluded; both actual snap distances are retained.",
    ],
  };
  return {
    route,
    routeHash: commuteHash(route),
    rawRoute: input.rawRoute,
    rawTrace: input.rawTrace,
  };
}
export class CommuteValhallaRouter {
  private base: URL;
  constructor(
    baseUrl: string,
    private identity: {
      graphHash: string;
      settingsHash: string;
      sourcePbfHash: string;
    },
    private fetcher: typeof fetch = fetch,
    private retain?: (
      action: "route" | "trace_attributes",
      bytes: Buffer,
      status: number,
    ) => Promise<void>,
  ) {
    this.base = new URL(baseUrl);
    if (
      this.base.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(this.base.hostname) ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== "/" ||
      this.base.search ||
      this.base.hash
    )
      throw new Error(
        "Commute routing requires a fixed loopback-only HTTP service.",
      );
  }
  private async request(
    action: "route" | "trace_attributes",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const response = await this.fetcher(new URL(action, this.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(COMMUTE_ROUTE_LIMITS.requestMilliseconds),
        ...(signal ? [signal] : []),
      ]),
    });
    if (
      Number(response.headers.get("content-length") ?? 0) >
      COMMUTE_ROUTE_LIMITS.responseBytes
    ) {
      await response.body?.cancel();
      fail("Routing response exceeds byte bound.");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new CommuteRoutingError(
        "INVALID_ROUTE_EVIDENCE",
        "Routing response has no body.",
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > COMMUTE_ROUTE_LIMITS.responseBytes) {
          await reader.cancel();
          fail("Routing response exceeds byte bound.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    await this.retain?.(action, bytes, response.status);
    if (!response.ok) {
      let code = "ROUTING_FAILED";
      try {
        const error = JSON.parse(bytes.toString());
        if (error.error_code === 442) code = "UNREACHABLE";
        if (error.error_code === 171) code = "UNSNAPPABLE";
      } catch {
        /* retain generic error */
      }
      throw new CommuteRoutingError(
        code,
        `Regional ${action} failed (${response.status}); no route was substituted.`,
      );
    }
    return bytes;
  }
  async route(
    home: Position,
    work: Position,
    signal?: AbortSignal,
  ): Promise<CapturedRegionalRoute> {
    for (const p of [home, work])
      if (
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90
      )
        fail("Invalid source endpoint.");
    const costing = routingCostingProfile("car");
    const locations = [home, work].map((p) => ({
      lon: p[0],
      lat: p[1],
      radius: 0,
      search_cutoff: 249,
      minimum_reachability: 1,
      search_filter: { exclude_ferry: true },
    }));
    const rawRoute = await this.request(
      "route",
      {
        locations,
        ...costing,
        units: "kilometers",
        shape_format: "polyline6",
        alternates: 0,
      },
      signal,
    );
    const parsed = routeSchema.parse(JSON.parse(rawRoute.toString()));
    const rawTrace = await this.request(
      "trace_attributes",
      {
        encoded_polyline: parsed.trip.legs[0].shape,
        shape_match: "edge_walk",
        ...costing,
        units: "kilometers",
        filters: {
          action: "include",
          attributes: [
            "edge.id",
            "edge.way_id",
            "edge.forward",
            "edge.begin_shape_index",
            "edge.end_shape_index",
            "edge.source_percent_along",
            "edge.target_percent_along",
            "node.elapsed_time",
            "shape",
            "shape_attributes.time",
          ],
        },
      },
      signal,
    );
    return normalizeCommuteRoute({
      home,
      work,
      ...this.identity,
      rawRoute,
      rawTrace,
    });
  }
}

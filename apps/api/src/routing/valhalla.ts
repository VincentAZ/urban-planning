import { distance, point } from "@turf/turf";
import { z } from "zod";
import { workforceTravelTimeLowerBound } from "@urban/core";
import {
  assertRoutingCoverage,
  pointCovered,
  positionSchema,
  routingHash,
  routingManifestSchema,
} from "./manifest.js";
import {
  RoutingError,
  type RoutingIsochroneResult,
  type RoutingDirection,
  type RoutingMatrixRequest,
  type RoutingOutboundMatrixRequest,
  type RoutingMatrixResult,
  type RoutingMode,
  type RoutingPosition,
  type RoutingRegionManifest,
  type RoutingRow,
} from "./types.js";

export const ROUTING_LIMITS = Object.freeze({
  origins: 200_000,
  routedOrigins: 60_000,
  chunk: 250,
  walkingChunk: 25,
  responseBytes: 8_000_000,
  requestMilliseconds: 30_000,
  runMilliseconds: 600_000,
  isochroneVertices: 100_000,
  maximumTerminalEdgeMeters: 50_000,
});
const requestSchema = z
  .object({
    site: positionSchema,
    origins: z
      .array(
        z.object({ id: z.string().min(1).max(160), position: positionSchema }),
      )
      .min(1)
      .max(ROUTING_LIMITS.origins),
    mode: z.enum(["car", "walk"]),
  })
  .superRefine((v, c) => {
    if (new Set(v.origins.map((p) => p.id)).size !== v.origins.length)
      c.addIssue({ code: "custom", message: "Duplicate origin IDs" });
  });
const commonNotes = [
  "Static modeled time; no observed congestion, transit schedule, or proposed scenario street changes.",
  "Travel between a supplied point and its road snap is excluded. Maximum permitted snap: 250 m.",
  "Null routes are distinct from failed requests and points without a nearby usable edge.",
];
function directionNotes(direction: RoutingDirection) {
  return [
    direction === "inbound"
      ? "Inbound travel from origin points to the site on the captured regional network."
      : "Outbound travel from the site to destination points on the captured regional network.",
    ...commonNotes,
  ];
}
const finite = z.number().finite();
const coordinateEcho = z.object({
  input_lon: finite,
  input_lat: finite,
  edges: z
    .array(
      z.object({
        correlated_lon: finite,
        correlated_lat: finite,
        edge: z.object({
          geo_attributes: z.object({
            length: finite.int().positive().max(16_777_215),
          }),
        }),
      }),
    )
    .nullable()
    .optional(),
  warnings: z.array(z.unknown()).optional(),
});
const matrixCell = z.object({
  from_index: z.number().int().nonnegative(),
  to_index: z.number().int().nonnegative(),
  time: finite.min(0).max(604800).nullable(),
  distance: finite.min(0).max(20000).nullable(),
  begin_lon: finite.optional(),
  begin_lat: finite.optional(),
  end_lon: finite.optional(),
  end_lat: finite.optional(),
});
const matrixResponse = z.object({
  algorithm: z.literal("timedistancematrix"),
  units: z.literal("kilometers"),
  sources_to_targets: z.union([
    z.array(matrixCell),
    z.array(z.array(matrixCell)),
  ]),
  sources: z.array(z.object({ lon: finite, lat: finite })).optional(),
  targets: z.array(z.object({ lon: finite, lat: finite })).optional(),
  warnings: z.array(z.unknown()).optional(),
});
function invalid(message: string): never {
  throw new RoutingError("ROUTING_INVALID_RESPONSE", message, 502);
}
function abort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new RoutingError("ROUTING_CANCELLED", "Routing was cancelled.", 499);
}
export function routingCostingProfile(
  mode: RoutingMode,
  walkingDistanceMeters = 7500,
) {
  return mode === "car"
    ? {
        costing: "auto",
        costing_options: {
          auto: {
            top_speed: 140,
            speed_types: ["freeflow", "constrained"],
            shortest: false,
          },
        },
      }
    : {
        costing: "pedestrian",
        costing_options: {
          pedestrian: {
            walking_speed: 5.1,
            max_distance: walkingDistanceMeters,
            shortest: false,
            exclude_ferries: true,
          },
        },
      };
}
// Reserve1m for native coordinate serialization while enforcing250m externally.
function location(p: RoutingPosition) {
  return {
    lon: p[0],
    lat: p[1],
    radius: 0,
    search_cutoff: 249,
    minimum_reachability: 1,
    search_filter: { exclude_ferry: true },
  };
}
function meters(a: RoutingPosition, b: RoutingPosition) {
  return distance(point(a), point(b), { units: "meters" });
}
export function routingProfileHash(
  manifest: RoutingRegionManifest,
  mode: RoutingMode,
  direction: RoutingDirection = "inbound",
): string {
  const profile = {
    carTopSpeedKph: manifest.profile.carTopSpeedKph,
    walkingSpeedKph: manifest.profile.walkingSpeedKph,
    walkingBoundKph: manifest.profile.walkingBoundKph,
    excludeWalkingFerries: manifest.profile.excludeWalkingFerries,
  };
  return routingHash({
    configHash: manifest.config.sha256,
    profile,
    costing: routingCostingProfile(mode),
    expansionMaxDistanceMeters: mode === "walk" ? 7500 : 105000,
    terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
    maximumTerminalEdgeMeters: ROUTING_LIMITS.maximumTerminalEdgeMeters,
    walkingDistancePolicy: "base-expansion-plus-terminal-edge-padding",
    matrixAlgorithm: "timedistancematrix",
    matching: {
      radius: 0,
      searchCutoffMeters: 249,
      minimumReachability: 1,
      excludeFerryEndpoints: true,
    },
    thresholdsMinutes: [15, 30, 45],
    direction,
  });
}
export function routingMatrixInputHash(
  manifest: RoutingRegionManifest,
  request: Pick<RoutingMatrixRequest, "site" | "origins" | "mode">,
): string {
  return routingHash({
    manifestId: manifest.id,
    graphHash: manifest.graph.sha256,
    profileHash: routingProfileHash(manifest, request.mode),
    site: [...request.site],
    mode: request.mode,
    origins: request.origins.map((o) => ({
      id: o.id,
      position: [...o.position],
    })),
  });
}
export function routingOutboundMatrixInputHash(
  manifest: RoutingRegionManifest,
  request: Pick<RoutingOutboundMatrixRequest, "site" | "destinations" | "mode">,
): string {
  return routingHash({
    manifestId: manifest.id,
    graphHash: manifest.graph.sha256,
    profileHash: routingProfileHash(manifest, request.mode, "outbound"),
    direction: "outbound",
    site: [...request.site],
    mode: request.mode,
    destinations: request.destinations.map((destination) => ({
      id: destination.id,
      position: [...destination.position],
    })),
  });
}
export function routingIsochroneInputHash(
  manifest: RoutingRegionManifest,
  request: { site: RoutingPosition; mode: RoutingMode },
  direction: RoutingDirection = "inbound",
): string {
  return routingHash({
    manifestId: manifest.id,
    graphHash: manifest.graph.sha256,
    profileHash: routingProfileHash(manifest, request.mode, direction),
    site: [...request.site],
    mode: request.mode,
    minutes: [15, 30, 45],
    reverse: direction === "inbound",
    denoise: 0,
    generalize: 0,
  });
}
/** Conservative proof only, never a substitute for a route inside the bound. */
export function routingTravelTimeLowerBound(
  origin: RoutingPosition,
  site: RoutingPosition,
  mode: RoutingMode,
): number {
  return workforceTravelTimeLowerBound(origin, site, {
    method: "conservative-great-circle",
    maximumSpeedKph: mode === "car" ? 140 : 10,
    snapAllowanceMeters: 500,
  });
}
export function outsideRoutingThreshold(
  origin: RoutingPosition,
  site: RoutingPosition,
  mode: RoutingMode,
): boolean {
  return routingTravelTimeLowerBound(origin, site, mode) > 45 * 60;
}

export class ValhallaRouter {
  readonly manifest: RoutingRegionManifest;
  private baseUrl: URL;
  private fetcher: typeof fetch;
  private busy = false;
  constructor(options: {
    baseUrl: string;
    manifest: RoutingRegionManifest;
    fetcher?: typeof fetch;
  }) {
    this.manifest = routingManifestSchema.parse(options.manifest);
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const v of Object.values(value)) freeze(v);
        Object.freeze(value);
      }
    };
    freeze(this.manifest);
    this.baseUrl = new URL(options.baseUrl);
    if (
      this.baseUrl.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(this.baseUrl.hostname) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.pathname !== "/" ||
      this.baseUrl.search ||
      this.baseUrl.hash
    )
      throw new RoutingError(
        "ROUTING_CONFIGURATION",
        "Routing must use a fixed loopback HTTP endpoint.",
        503,
      );
    this.fetcher = options.fetcher ?? fetch;
  }
  private async request(
    action: "locate" | "sources_to_targets" | "isochrone",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    abort(signal);
    const timeout = AbortSignal.timeout(ROUTING_LIMITS.requestMilliseconds);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(new URL(action, this.baseUrl), {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!response.ok)
        throw new RoutingError(
          "ROUTING_ENGINE_FAILURE",
          `The regional routing engine rejected the request (HTTP ${response.status}).`,
          502,
        );
      if (
        Number(response.headers.get("content-length")) >
        ROUTING_LIMITS.responseBytes
      )
        invalid("Routing response exceeds its size limit.");
      const reader = response.body?.getReader();
      if (!reader) invalid("Routing response is empty.");
      const buffers: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > ROUTING_LIMITS.responseBytes)
            invalid("Routing response exceeds its size limit.");
          buffers.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      try {
        return JSON.parse(Buffer.concat(buffers).toString("utf8"));
      } catch {
        invalid("Routing returned invalid JSON.");
      }
    } catch (error) {
      if (signal?.aborted)
        throw new RoutingError(
          "ROUTING_CANCELLED",
          "Routing was cancelled.",
          499,
        );
      if (timeout.aborted)
        throw new RoutingError(
          "ROUTING_TIMEOUT",
          "The regional routing request exceeded its time limit.",
          504,
        );
      if (error instanceof RoutingError) throw error;
      throw new RoutingError(
        "ROUTING_UNAVAILABLE",
        "The local regional routing engine is unavailable.",
        503,
      );
    }
  }
  private async locate(
    positions: RoutingPosition[],
    mode: RoutingMode,
    signal?: AbortSignal,
  ) {
    const raw = await this.request(
      "locate",
      {
        ...routingCostingProfile(mode),
        locations: positions.map(location),
        verbose: true,
      },
      signal,
    );
    const parsed = z.array(coordinateEcho).safeParse(raw);
    if (!parsed.success || parsed.data.length !== positions.length)
      invalid("Routing location results do not match the submitted points.");
    return parsed.data.map((row, i) => {
      if (row.warnings?.length)
        invalid("The routing engine altered a location request.");
      if (meters(positions[i], [row.input_lon, row.input_lat]) > 2)
        invalid("Routing location order or coordinates changed.");
      const edges = (row.edges ?? []).filter(
        (e) =>
          meters(positions[i], [e.correlated_lon, e.correlated_lat]) <=
          this.manifest.coverage.maximumSnapMeters + 0.1,
      );
      const distances = edges.map((e) =>
        meters(positions[i], [e.correlated_lon, e.correlated_lat]),
      );
      const nearest = distances.length ? Math.min(...distances) : null;
      return nearest !== null &&
        nearest <= this.manifest.coverage.maximumSnapMeters + 0.1
        ? {
            snapMeters: nearest,
            maximumEdgeMeters: Math.max(
              ...edges.map((e) => e.edge.geo_attributes.length),
            ),
          }
        : null;
    });
  }
  async inboundMatrix(
    input: RoutingMatrixRequest,
  ): Promise<RoutingMatrixResult> {
    return this.matrix(input, "inbound");
  }
  async outboundMatrix(
    input: RoutingOutboundMatrixRequest,
  ): Promise<RoutingMatrixResult<"outbound">> {
    return this.matrix({ ...input, origins: input.destinations }, "outbound");
  }
  private async matrix<D extends RoutingDirection>(
    input: RoutingMatrixRequest,
    direction: D,
  ): Promise<RoutingMatrixResult<D>> {
    abort(input.signal);
    const checked = requestSchema.safeParse(input);
    if (!checked.success)
      throw new RoutingError(
        "ROUTING_INVALID_REQUEST",
        "Supply unique bounded origin IDs, valid coordinates, and car or walk mode.",
      );
    const request = checked.data;
    const coverage = assertRoutingCoverage(
      request.site,
      this.manifest,
      request.mode,
    );
    if (
      request.origins.filter(
        (o) => !outsideRoutingThreshold(o.position, request.site, request.mode),
      ).length > ROUTING_LIMITS.routedOrigins
    )
      throw new RoutingError(
        "ROUTING_COMPLEXITY",
        "More than 60,000 origins require native routing. This bounded worker rejects the whole run rather than truncating it.",
        413,
      );
    if (this.busy)
      throw new RoutingError(
        "ROUTING_BUSY",
        "The regional routing worker is already processing a run.",
        503,
      );
    this.busy = true;
    const runTimeout = AbortSignal.timeout(ROUTING_LIMITS.runMilliseconds);
    const signal = input.signal
      ? AbortSignal.any([input.signal, runTimeout])
      : runTimeout;
    try {
      const siteSnap = (
        await this.locate([request.site], request.mode, signal)
      )[0];
      if (siteSnap === null)
        throw new RoutingError(
          "ROUTING_SITE_UNSNAPPABLE",
          "The site has no usable network edge within 250 m. Select a nearby access point.",
        );
      const rows: RoutingRow[] = [];
      const search: RoutingMatrixResult["search"] = {
        algorithm: "timedistancematrix",
        baseExpansionMeters: request.mode === "walk" ? 7500 : 105000,
        terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
        batches: [],
      };
      const chunkSize =
        request.mode === "walk"
          ? ROUTING_LIMITS.walkingChunk
          : ROUTING_LIMITS.chunk;
      for (
        let offset = 0;
        offset < request.origins.length;
        offset += chunkSize
      ) {
        abort(signal);
        const chunk = request.origins.slice(offset, offset + chunkSize);
        const covered = chunk.filter(
          (o) =>
            !outsideRoutingThreshold(o.position, request.site, request.mode) &&
            pointCovered(o.position, this.manifest),
        );
        const snaps = covered.length
          ? await this.locate(
              covered.map((o) => o.position),
              request.mode,
              signal,
            )
          : [];
        const snapById = new Map(covered.map((o, i) => [o.id, snaps[i]]));
        const routable = covered.filter((o) => snapById.get(o.id) !== null);
        const byId = new Map<string, RoutingRow>();
        for (const origin of chunk) {
          if (
            outsideRoutingThreshold(origin.position, request.site, request.mode)
          )
            byId.set(origin.id, {
              id: origin.id,
              status: "outside-threshold",
              seconds: null,
              distanceMeters: null,
              snapMeters: null,
              lowerBoundSeconds: routingTravelTimeLowerBound(
                origin.position,
                request.site,
                request.mode,
              ),
            });
          else if (!snapById.has(origin.id))
            byId.set(origin.id, {
              id: origin.id,
              status: "outside-coverage",
              seconds: null,
              distanceMeters: null,
              snapMeters: null,
            });
          else if (snapById.get(origin.id) === null)
            byId.set(origin.id, {
              id: origin.id,
              status: "unsnappable",
              seconds: null,
              distanceMeters: null,
              snapMeters: null,
            });
        }
        if (routable.length) {
          const maximumCorrelatedEdgeMeters = Math.max(
            siteSnap.maximumEdgeMeters,
            ...routable.map((o) => snapById.get(o.id)!.maximumEdgeMeters),
          );
          if (
            maximumCorrelatedEdgeMeters >
            ROUTING_LIMITS.maximumTerminalEdgeMeters
          )
            throw new RoutingError(
              "ROUTING_COMPLEXITY",
              "A correlated edge exceeds this worker's terminal-edge padding limit. The run is rejected rather than treated as unreachable.",
              413,
            );
          const expansionMaxDistanceMeters =
            search.baseExpansionMeters + maximumCorrelatedEdgeMeters;
          search.batches.push({
            firstInputIndex: offset,
            inputCount: chunk.length,
            routedCount: routable.length,
            maximumCorrelatedEdgeMeters,
            expansionMaxDistanceMeters,
          });
          const raw = await this.request(
            "sources_to_targets",
            {
              ...routingCostingProfile(
                request.mode,
                expansionMaxDistanceMeters,
              ),
              expansion_max_distance: expansionMaxDistanceMeters,
              sources:
                direction === "inbound"
                  ? routable.map((o) => location(o.position))
                  : [location(request.site)],
              targets:
                direction === "inbound"
                  ? [location(request.site)]
                  : routable.map((o) => location(o.position)),
              units: "kilometers",
              verbose: true,
            },
            signal,
          );
          const parsed = matrixResponse.safeParse(raw);
          if (!parsed.success)
            invalid("The routing matrix has an invalid shape or value.");
          if (parsed.data.warnings?.length)
            invalid("The routing engine altered the matrix request.");
          const cells = parsed.data.sources_to_targets.flat();
          if (cells.length !== routable.length)
            invalid("The routing matrix is incomplete.");
          if (
            (parsed.data.sources &&
              parsed.data.sources.length !==
                (direction === "inbound" ? routable.length : 1)) ||
            (parsed.data.targets &&
              parsed.data.targets.length !==
                (direction === "inbound" ? 1 : routable.length))
          )
            invalid("Routing matrix coordinate identities are incomplete.");
          const seen = new Set<number>();
          for (const cell of cells) {
            const endpointIndex =
              direction === "inbound" ? cell.from_index : cell.to_index;
            const siteIndex =
              direction === "inbound" ? cell.to_index : cell.from_index;
            if (
              siteIndex !== 0 ||
              endpointIndex >= routable.length ||
              seen.has(endpointIndex)
            )
              invalid(
                "The routing matrix has missing or duplicate point identities.",
              );
            seen.add(endpointIndex);
            if ((cell.time === null) !== (cell.distance === null))
              invalid("The routing matrix has inconsistent missing values.");
            const origin = routable[endpointIndex];
            if (
              cell.time !== null &&
              cell.time + 1 <
                routingTravelTimeLowerBound(
                  origin.position,
                  request.site,
                  request.mode,
                )
            )
              invalid(
                "The native travel time violates the conservative speed bound.",
              );
            let snapMeters: number | null = null;
            const sourceEcho =
              direction === "inbound"
                ? parsed.data.sources?.[endpointIndex]
                : parsed.data.targets?.[endpointIndex];
            const targetEcho =
              direction === "inbound"
                ? parsed.data.targets?.[0]
                : parsed.data.sources?.[0];
            if (sourceEcho) {
              snapMeters = meters(origin.position, [
                sourceEcho.lon,
                sourceEcho.lat,
              ]);
              if (snapMeters > 250.1)
                invalid("A routing result exceeded the maximum endpoint snap.");
            }
            if (
              targetEcho &&
              meters(request.site, [targetEcho.lon, targetEcho.lat]) > 250.1
            )
              invalid("A routing result exceeded the maximum site snap.");
            const endpointLon =
              direction === "inbound" ? cell.begin_lon : cell.end_lon;
            const endpointLat =
              direction === "inbound" ? cell.begin_lat : cell.end_lat;
            const siteLon =
              direction === "inbound" ? cell.end_lon : cell.begin_lon;
            const siteLat =
              direction === "inbound" ? cell.end_lat : cell.begin_lat;
            if (endpointLon !== undefined && endpointLat !== undefined) {
              snapMeters = meters(origin.position, [endpointLon, endpointLat]);
              if (snapMeters > 250.1)
                invalid("A routing result exceeded the maximum endpoint snap.");
            }
            if (
              siteLon !== undefined &&
              siteLat !== undefined &&
              meters(request.site, [siteLon, siteLat]) > 250.1
            )
              invalid("A routing result exceeded the maximum site snap.");
            byId.set(origin.id, {
              id: origin.id,
              status: cell.time === null ? "unreachable" : "reachable",
              seconds: cell.time,
              distanceMeters:
                cell.distance === null ? null : cell.distance * 1000,
              snapMeters,
            });
          }
        }
        rows.push(...chunk.map((o) => byId.get(o.id)!));
      }
      return {
        manifestId: this.manifest.id,
        inputHash:
          direction === "inbound"
            ? routingMatrixInputHash(this.manifest, request)
            : routingOutboundMatrixInputHash(this.manifest, {
                site: request.site,
                mode: request.mode,
                destinations: request.origins,
              }),
        mode: request.mode,
        direction,
        siteSnapMeters: siteSnap.snapMeters,
        rows,
        coverage,
        search,
        notes: [
          ...directionNotes(direction),
          ...this.manifest.limitations,
          "Each bounded matrix search adds the maximum correlated terminal-edge length before cutoff; exact batch padding and search bounds are retained in search diagnostics.",
          "Outside-threshold means (99% of straight-line distance minus both 250 m snaps) / enforced maximum mode speed exceeds 45 minutes; it does not assert that no route exists.",
          `${direction === "inbound" ? "Origin" : "Destination"} snap distance is null when the engine does not return the matrix's actual correlated coordinates; the strict 250 m request cutoff still applies.`,
        ],
      };
    } catch (error) {
      if (runTimeout.aborted && !input.signal?.aborted)
        throw new RoutingError(
          "ROUTING_TIMEOUT",
          "The complete routing run exceeded its time limit.",
          504,
        );
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async inboundIsochrone(input: {
    site: RoutingPosition;
    mode: RoutingMode;
    signal?: AbortSignal;
  }): Promise<RoutingIsochroneResult> {
    return this.isochrone(input, "inbound");
  }
  async outboundIsochrone(input: {
    site: RoutingPosition;
    mode: RoutingMode;
    signal?: AbortSignal;
  }): Promise<RoutingIsochroneResult<"outbound">> {
    return this.isochrone(input, "outbound");
  }
  private async isochrone<D extends RoutingDirection>(
    input: {
      site: RoutingPosition;
      mode: RoutingMode;
      signal?: AbortSignal;
    },
    direction: D,
  ): Promise<RoutingIsochroneResult<D>> {
    const checked = z
      .object({ site: positionSchema, mode: z.enum(["car", "walk"]) })
      .safeParse(input);
    if (!checked.success)
      throw new RoutingError(
        "ROUTING_INVALID_REQUEST",
        "Invalid isochrone site or mode.",
      );
    const request = checked.data;
    assertRoutingCoverage(request.site, this.manifest, request.mode);
    const raw = await this.request(
      "isochrone",
      {
        ...routingCostingProfile(request.mode),
        locations: [location(request.site)],
        contours: [15, 30, 45].map((time) => ({ time })),
        polygons: true,
        reverse: direction === "inbound",
        denoise: 0,
        generalize: 0,
        show_locations: false,
      },
      input.signal,
    );
    const ring = z.array(positionSchema).min(4);
    const schema = z.object({
      type: z.literal("FeatureCollection"),
      features: z
        .array(
          z.object({
            type: z.literal("Feature"),
            properties: z
              .object({
                contour: z.number(),
                metric: z.literal("time").optional(),
              })
              .passthrough(),
            geometry: z.discriminatedUnion("type", [
              z.object({
                type: z.literal("Polygon"),
                coordinates: z.array(ring),
              }),
              z.object({
                type: z.literal("MultiPolygon"),
                coordinates: z.array(z.array(ring)),
              }),
            ]),
          }),
        )
        .min(1)
        .max(1000),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      invalid("The inbound isochrone returned invalid geometry.");
    if (
      new Set(parsed.data.features.map((f) => f.properties.contour)).size !==
        3 ||
      parsed.data.features.some(
        (f) => ![15, 30, 45].includes(f.properties.contour),
      )
    )
      invalid("The inbound isochrone is missing a requested contour.");
    let count = 0;
    for (const feature of parsed.data.features)
      for (const polygon of feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates)
        for (const r of polygon) {
          count += r.length;
          if (r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1])
            invalid("The inbound isochrone contains an unclosed ring.");
        }
    if (count > ROUTING_LIMITS.isochroneVertices)
      invalid("The inbound isochrone exceeds its geometry limit.");
    return {
      manifestId: this.manifest.id,
      inputHash: routingIsochroneInputHash(this.manifest, request, direction),
      site: [...request.site],
      mode: request.mode,
      direction,
      minutes: [15, 30, 45],
      geometry: parsed.data,
      notes: [
        ...directionNotes(direction),
        direction === "inbound"
          ? "Reverse expansion shows travel to the site. Interpolated contour polygons are visual aids; cohort totals use individual matrix travel times."
          : "Forward expansion shows travel from the site. Interpolated contour polygons are visual aids; job totals use individual matrix travel times.",
      ],
    };
  }
}

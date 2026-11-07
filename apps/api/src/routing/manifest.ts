import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  booleanPointInPolygon,
  lineString,
  point,
  pointToLineDistance,
} from "@turf/turf";
import { z } from "zod";
import type {
  RoutingMode,
  RoutingPosition,
  RoutingRegionManifest,
} from "./types.js";
import { RoutingError } from "./types.js";

export const VALHALLA_IMAGE =
  "ghcr.io/valhalla/valhalla@sha256:18cb42988e03c70dc4bc4ca095a259ec4db5e5df928be65956fc1c64c280b47a";
export const positionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-85).max(85),
]);
const ring = z
  .array(positionSchema)
  .min(4)
  .max(20000)
  .refine(
    (r) => r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1],
    "Unclosed coverage ring",
  );
const geometry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("Polygon"),
    coordinates: z.array(ring).min(1).max(128),
  }),
  z.object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(ring).min(1).max(128)).min(1).max(128),
  }),
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const routingManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^az-[a-f0-9]{16}$/),
  engine: z.object({
    name: z.literal("valhalla"),
    version: z.literal("3.9.1"),
    image: z.literal(VALHALLA_IMAGE),
    imageDigest: z.literal(VALHALLA_IMAGE.split("@")[1]),
  }),
  sources: z
    .array(
      z.object({
        url: z.url(),
        sha256: hash,
        bytes: z.number().int().positive(),
        retrievedAt: z.iso.datetime(),
        lastModified: z.string().optional(),
      }),
    )
    .min(2)
    .max(8),
  graph: z.object({
    sha256: hash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 ** 3),
    files: z.number().int().positive().max(20000),
  }),
  config: z.object({ sha256: hash }),
  profile: z.object({
    carTopSpeedKph: z.literal(140),
    walkingSpeedKph: z.literal(5.1),
    walkingBoundKph: z.literal(10),
    excludeWalkingFerries: z.literal(true),
  }),
  coverage: z.object({
    geometry,
    maximumMinutes: z.literal(45),
    maximumSpeedKph: z.literal(252),
    maximumSnapMeters: z.literal(250),
    safetyMarginMeters: z.literal(1000),
  }),
  build: z.object({
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    wallSeconds: z.number().nonnegative(),
    peakMemoryBytes: z.number().nonnegative(),
    cpuLimit: z.number().positive(),
    memoryLimitBytes: z.number().positive(),
    diskLimitBytes: z.number().positive(),
  }),
  limitations: z.array(z.string().max(2000)).max(30),
  credits: z.array(z.string().max(2000)).max(30),
});
export async function loadRoutingManifest(
  path: string,
): Promise<RoutingRegionManifest> {
  try {
    if ((await stat(path)).size > 2_000_000) throw new Error("size");
    const raw = await readFile(path);
    if (raw.byteLength > 2_000_000) throw new Error("size");
    const parsed = routingManifestSchema.parse(
      JSON.parse(raw.toString("utf8")),
    );
    const configPath = join(dirname(path), "valhalla.json");
    if ((await stat(configPath)).size > 2_000_000)
      throw new Error("config size");
    const config = await readFile(configPath);
    if (
      config.length > 2_000_000 ||
      createHash("sha256").update(config).digest("hex") !== parsed.config.sha256
    )
      throw new Error("config checksum");
    const settings = JSON.parse(config.toString("utf8"));
    if (
      settings.service_limits?.allow_hard_exclusions !== true ||
      settings.loki?.service_defaults?.search_cutoff !== 250 ||
      settings.thor?.source_to_target_algorithm !== "timedistancematrix" ||
      settings.thor?.clear_reserved_memory !== true ||
      settings.mjolnir?.use_lru_mem_cache !== true ||
      settings.mjolnir?.lru_mem_cache_hard_control !== true ||
      settings.mjolnir?.global_synchronized_cache !== true ||
      settings.mjolnir?.max_cache_size !== 256 * 1024 ** 2 ||
      settings.mjolnir?.tile_url
    )
      throw new Error("unsafe configuration");
    await verifyRoutingGraph(path, parsed);
    return parsed;
  } catch {
    throw new RoutingError(
      "ROUTING_MANIFEST_INVALID",
      "The routing manifest or captured configuration is invalid or changed.",
      503,
    );
  }
}
/** Startup/operator integrity check. Cache the returned manifest; never hash the graph per HTTP request. */
export async function verifyRoutingGraph(
  manifestPath: string,
  manifest: RoutingRegionManifest,
): Promise<void> {
  const directory = resolve(dirname(manifestPath));
  const inventoryPath = join(directory, "graph-files.json");
  if ((await stat(inventoryPath)).size > 10_000_000)
    throw new Error("Graph inventory exceeds limit");
  const raw = await readFile(inventoryPath);
  if (raw.length > 10_000_000) throw new Error("Graph inventory exceeds limit");
  const files = z
    .array(
      z.object({
        path: z
          .string()
          .regex(/^(?:tiles\/[0-9/]+\.gph|admins\.sqlite|tiles\.tar)$/),
        sha256: hash,
        bytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(20_000)
    .parse(JSON.parse(raw.toString("utf8")));
  if (
    new Set(files.map((f) => f.path)).size !== files.length ||
    files.length !== manifest.graph.files ||
    files.reduce((n, f) => n + f.bytes, 0) !== manifest.graph.bytes
  )
    throw new Error("Graph inventory disagrees with manifest");
  // The preparation CLI hashes the canonical sorted-key inventory, including each file hash.
  const canonical = files.map((f) => ({
    bytes: f.bytes,
    path: f.path,
    sha256: f.sha256,
  }));
  if (routingHash(canonical) !== manifest.graph.sha256)
    throw new Error("Graph inventory checksum changed");
  for (const file of files) {
    const path = resolve(directory, file.path);
    if (!path.startsWith(directory + sep))
      throw new Error("Invalid graph path");
    if ((await stat(path)).size !== file.bytes)
      throw new Error("Graph file size changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > file.bytes)
        throw new Error("Graph file exceeded declared size");
      hash.update(chunk);
    }
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
      throw new Error("Graph file checksum changed");
  }
}
export function routingHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function pointCovered(
  position: RoutingPosition,
  manifest: RoutingRegionManifest,
): boolean {
  return booleanPointInPolygon(point(position), manifest.coverage.geometry, {
    ignoreBoundary: true,
  });
}
/** Car elapsed time caps edge speed at140. Walk excludes ferries and uses5.1km/h;
 * minimum native grade factor0.88 permits <6km/h (bounded conservatively at10).
 * Add both allowed snaps and an extra conservative1km boundary margin. */
export function assertRoutingCoverage(
  site: RoutingPosition,
  manifest: RoutingRegionManifest,
  mode: RoutingMode = "car",
) {
  if (!pointCovered(site, manifest))
    throw new RoutingError(
      "ROUTING_OUTSIDE_COVERAGE",
      "The site is outside this captured regional network.",
    );
  const rings =
    manifest.coverage.geometry.type === "Polygon"
      ? manifest.coverage.geometry.coordinates
      : manifest.coverage.geometry.coordinates.flat();
  const boundaryDistanceMeters =
    Math.min(
      ...rings.map((r) =>
        pointToLineDistance(point(site), lineString(r), {
          units: "meters",
          method: "geodesic",
        }),
      ),
    ) * 0.99;
  const maximumSpeed =
    mode === "car"
      ? manifest.profile.carTopSpeedKph
      : manifest.profile.walkingBoundKph;
  const requiredRadiusMeters =
    (maximumSpeed * 1000 * manifest.coverage.maximumMinutes) / 60 +
    2 * manifest.coverage.maximumSnapMeters +
    manifest.coverage.safetyMarginMeters;
  if (boundaryDistanceMeters < requiredRadiusMeters)
    throw new RoutingError(
      "ROUTING_COVERAGE_INCOMPLETE",
      "This site's possible 45-minute catchment reaches the extract boundary. A larger captured network is required.",
    );
  return {
    status: "complete" as const,
    boundaryDistanceMeters,
    requiredRadiusMeters,
  };
}

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { bbox } from "@turf/turf";
import {
  assertWorkforceCohortPack,
  workforceContentHash,
  type WorkforceCohortPack,
  type WorkforceRequest,
  type WorkforceScenario,
  type Source,
} from "@urban/core";
import {
  createWorkforceScenario,
  WORKFORCE_METHOD_VERSION,
} from "@urban/models";
import {
  loadRoutingManifest,
  routingProfileHash,
  assertRoutingCoverage,
  outsideRoutingThreshold,
  ROUTING_LIMITS,
  ValhallaRouter,
} from "./routing/index.js";
import { verifyPreparedWorkforceBoundary } from "./data/workforce-boundary.js";
import {
  runCapturedWorkforce,
  workforceCohortCoverage,
  type CapturedWorkforceResult,
} from "./workforce-runner.js";
import type {
  WorkforceSourceIdentity,
  WorkforceCapabilities,
} from "./workforce-jobs-types.js";
import { ApiError } from "./errors.js";

export interface WorkforceExecutor {
  describe(): Promise<NonNullable<WorkforceCapabilities["region"]>>;
  preflight(request: WorkforceRequest): Promise<WorkforceSourceIdentity>;
  execute(options: {
    request: WorkforceRequest;
    binding: WorkforceScenario["binding"];
    receipt: WorkforceScenario["receipt"];
    signal: AbortSignal;
    progress: (
      stage: "validating" | "routing" | "aggregating" | "contours",
    ) => void;
  }): Promise<{
    artifact: CapturedWorkforceResult;
    workforce: WorkforceScenario;
  }>;
}
export interface NativeWorkforceConfiguration {
  packPath: string;
  boundaryPath: string;
  manifestPath: string;
  baseUrl: string;
}
/** Only trusted operator paths are accepted. Source preparation never runs in a visitor request. */
export class NativeWorkforceExecutor implements WorkforceExecutor {
  private loaded?: Promise<
    Awaited<ReturnType<NativeWorkforceExecutor["load"]>>
  >;
  constructor(private configuration: NativeWorkforceConfiguration) {}
  private async load() {
    const { packPath, boundaryPath, manifestPath, baseUrl } =
      this.configuration;
    if ((await stat(packPath)).size > 250_000_000)
      throw new Error("Cohort pack exceeds its read limit.");
    const raw = await readFile(packPath);
    if (raw.length > 250_000_000)
      throw new Error("Cohort pack exceeds its read limit.");
    const pack = JSON.parse(raw.toString("utf8")) as WorkforceCohortPack;
    assertWorkforceCohortPack(pack);
    const packHash = await workforceContentHash(pack);
    if (basename(packPath) !== `${packHash}.json`)
      throw new Error("The cohort pack content hash changed.");
    const boundary = await verifyPreparedWorkforceBoundary(boundaryPath);
    const manifest = await loadRoutingManifest(manifestPath);
    return {
      pack,
      packHash,
      boundary,
      boundaryHash: await workforceContentHash(boundary),
      manifest,
      router: new ValhallaRouter({ manifest, baseUrl }),
    };
  }
  private async sources() {
    this.loaded ??= this.load();
    try {
      return await this.loaded;
    } catch {
      throw new ApiError(
        503,
        "WORKFORCE_SOURCES_UNAVAILABLE",
        "The operator-configured regional source pack, boundary, or routing graph could not be verified. No source download or route was started.",
      );
    }
  }
  async describe() {
    const { pack, boundary } = await this.sources();
    return {
      id: pack.id,
      name: pack.region.label,
      extent: bbox(boundary.geometry) as [number, number, number, number],
    };
  }
  async preflight(request: WorkforceRequest): Promise<WorkforceSourceIdentity> {
    const { pack, packHash, boundary, boundaryHash, manifest } =
      await this.sources();
    workforceCohortCoverage(pack, boundary, request, manifest);
    assertRoutingCoverage(request.site, manifest, request.mode);
    const origins = pack.origins.filter((origin) => origin.weight > 0);
    if (
      origins.length > ROUTING_LIMITS.origins ||
      origins.filter(
        (origin) =>
          !outsideRoutingThreshold(origin.position, request.site, request.mode),
      ).length > ROUTING_LIMITS.routedOrigins
    )
      throw new ApiError(
        413,
        "ROUTING_COMPLEXITY",
        "This complete regional request exceeds the bounded worker's origin allowance. No origin was dropped and no routing request was dispatched.",
      );
    return {
      cohortPackHash: packHash,
      boundaryHash,
      manifestId: manifest.id,
      graphHash: manifest.graph.sha256,
      profileHash: routingProfileHash(manifest, request.mode),
      methodVersion: WORKFORCE_METHOD_VERSION,
    };
  }
  async execute(options: Parameters<WorkforceExecutor["execute"]>[0]) {
    const { pack, boundary, manifest, router } = await this.sources();
    const artifact = await runCapturedWorkforce({
      pack,
      boundary,
      router,
      request: options.request,
      signal: options.signal,
      onProgress: options.progress,
    });
    const id = `workforce-network-${manifest.id}`;
    const source: Source = {
      id,
      name: "Captured OpenStreetMap routing network",
      url: "https://www.openstreetmap.org/copyright",
      vintage: manifest.sources[0].retrievedAt,
      license: "ODbL 1.0; OpenStreetMap contributors",
      kind: "observed",
      description: `Valhalla ${manifest.engine.version}; static captured network, not observed congestion or scenario-authored roads. ${manifest.credits.join(" ")}`,
    };
    const workforce = await createWorkforceScenario({
      binding: options.binding,
      receipt: options.receipt,
      pack,
      artifact,
      extraSources: [source],
      extraFiles: manifest.sources.map((s) => ({
        sourceId: id,
        url: s.url,
        sha256: s.sha256,
        bytes: s.bytes,
        retrievedAt: s.retrievedAt,
      })),
    });
    return { artifact, workforce };
  }
}

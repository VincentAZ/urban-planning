import { verifyPreparedAccessibilityDestinationPack } from "./data/accessibility.js";
import { bbox } from "@turf/turf";
import {
  ACCESSIBILITY_METHOD_VERSION,
  accessibilityContentHash,
  type AccessibilityRequest,
  type AccessibilityModeEvidence,
  type Source,
} from "@urban/core";
import { createAccessibilityModeEvidence } from "@urban/models";
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
  runCapturedAccessibility,
  accessibilityDestinationCoverage,
  type CapturedAccessibilityResult,
} from "./accessibility-runner.js";
import type {
  AccessibilitySourceIdentity,
  AccessibilityCapabilities,
} from "./accessibility-jobs-types.js";
import { ApiError } from "./errors.js";

export interface AccessibilityExecutor {
  describe(): Promise<NonNullable<AccessibilityCapabilities["region"]>>;
  sourceMetadata?(): Promise<
    Pick<AccessibilityCapabilities, "source" | "sourceIdentities">
  >;
  preflight(
    request: AccessibilityRequest,
  ): Promise<AccessibilitySourceIdentity>;
  execute(options: {
    request: AccessibilityRequest;
    binding: AccessibilityModeEvidence["binding"];
    receipt: AccessibilityModeEvidence["receipt"];
    signal: AbortSignal;
    progress: (
      stage: "validating" | "routing" | "aggregating" | "contours",
    ) => void;
  }): Promise<{
    artifact: CapturedAccessibilityResult;
    accessibility: AccessibilityModeEvidence;
  }>;
}
export interface NativeAccessibilityConfiguration {
  packPath: string;
  boundaryPath: string;
  manifestPath: string;
  baseUrl: string;
}
/** Only trusted operator paths are accepted. Source preparation never runs in a visitor request. */
export class NativeAccessibilityExecutor implements AccessibilityExecutor {
  private loaded?: Promise<
    Awaited<ReturnType<NativeAccessibilityExecutor["load"]>>
  >;
  constructor(private configuration: NativeAccessibilityConfiguration) {}
  private async load() {
    const { packPath, boundaryPath, manifestPath, baseUrl } =
      this.configuration;
    const pack = await verifyPreparedAccessibilityDestinationPack(packPath);
    const packHash = await accessibilityContentHash(pack);
    const boundary = await verifyPreparedWorkforceBoundary(boundaryPath);
    const manifest = await loadRoutingManifest(manifestPath);
    return {
      pack,
      packHash,
      boundary,
      boundaryHash: await accessibilityContentHash(boundary),
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
        "ACCESSIBILITY_SOURCES_UNAVAILABLE",
        "The operator-configured regional source pack, boundary, or routing graph could not be verified. No source download or route was started.",
      );
    }
  }
  async sourceMetadata(): Promise<
    Pick<AccessibilityCapabilities, "source" | "sourceIdentities">
  > {
    const { pack, packHash, boundaryHash, manifest } = await this.sources();
    const identity = (mode: "car" | "walk"): AccessibilitySourceIdentity => ({
      jobsPackHash: packHash,
      boundaryHash,
      manifestId: manifest.id,
      graphHash: manifest.graph.sha256,
      profileHash: routingProfileHash(manifest, mode, "outbound"),
      methodVersion: ACCESSIBILITY_METHOD_VERSION,
    });
    return {
      source: {
        jobsPackHash: packHash,
        vintage: pack.lodes.year,
        jobType: pack.lodes.jobType,
        unit: "primary jobs",
        workplaceBlocks: pack.destinations.length,
        primaryJobs: pack.destinations.reduce((n, d) => n + d.cells.C000, 0),
      },
      sourceIdentities: { car: identity("car"), walk: identity("walk") },
    };
  }
  async describe() {
    const { pack, boundary } = await this.sources();
    return {
      id: pack.id,
      name: pack.region.label,
      extent: bbox(boundary.geometry) as [number, number, number, number],
    };
  }
  async preflight(
    request: AccessibilityRequest,
  ): Promise<AccessibilitySourceIdentity> {
    const { pack, packHash, boundary, boundaryHash, manifest } =
      await this.sources();
    accessibilityDestinationCoverage(pack, boundary, request, manifest);
    assertRoutingCoverage(request.site, manifest, request.mode);
    const origins = pack.destinations.filter((origin) => origin.cells.C000 > 0);
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
        "This complete regional request exceeds the bounded worker's destination allowance. No destination was dropped and no routing request was dispatched.",
      );
    return {
      jobsPackHash: packHash,
      boundaryHash,
      manifestId: manifest.id,
      graphHash: manifest.graph.sha256,
      profileHash: routingProfileHash(manifest, request.mode, "outbound"),
      methodVersion: ACCESSIBILITY_METHOD_VERSION,
    };
  }
  async execute(options: Parameters<AccessibilityExecutor["execute"]>[0]) {
    const { pack, boundary, manifest, router } = await this.sources();
    const artifact = await runCapturedAccessibility({
      pack,
      boundary,
      router,
      request: options.request,
      signal: options.signal,
      onProgress: options.progress,
    });
    const id = `accessibility-network-${manifest.id}`;
    const source: Source = {
      id,
      name: "Captured OpenStreetMap routing network",
      url: "https://www.openstreetmap.org/copyright",
      vintage: manifest.sources[0].retrievedAt,
      license: "ODbL 1.0; OpenStreetMap contributors",
      kind: "observed",
      description: `Valhalla ${manifest.engine.version}; static captured network, not observed congestion or scenario-authored roads. ${manifest.credits.join(" ")}`,
    };
    const accessibility = await createAccessibilityModeEvidence({
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
    return { artifact, accessibility };
  }
}

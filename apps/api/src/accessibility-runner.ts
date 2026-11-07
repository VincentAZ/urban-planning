import { bbox } from "@turf/turf";
import {
  assertAccessibilityDestinationPack,
  accessibilityContentHash,
  accessibilityRoutingInputHash,
  accessibilityRequestSchema,
  type AccessibilityDestinationPack,
  type AccessibilityRequest,
  type AccessibilityRoutingRun,
  type AccessibilityRouteRow,
} from "@urban/core";
import { resolveAccessibility } from "@urban/models";
import {
  assertRoutingCoverage,
  routingOutboundMatrixInputHash,
  routingIsochroneInputHash,
  routingProfileHash,
  type ValhallaRouter,
  type RoutingMatrixResult,
  type RoutingRegionManifest,
} from "./routing";
import {
  assertWorkforceRegionBoundary,
  type WorkforceRegionBoundary,
} from "./data/workforce-boundary";

export type { CapturedAccessibilityResult } from "@urban/core";
import type { CapturedAccessibilityResult } from "@urban/core";
type AccessibilityRouter = Pick<
  ValhallaRouter,
  "manifest" | "outboundMatrix" | "outboundIsochrone"
>;

/** A complete source county list and its own boundary are required independently of the road extract. */
export function accessibilityDestinationCoverage(
  pack: AccessibilityDestinationPack,
  boundary: WorkforceRegionBoundary,
  request: AccessibilityRequest,
  manifest: RoutingRegionManifest,
) {
  assertWorkforceRegionBoundary(boundary);
  const counties = [...pack.region.countyGeoids].sort();
  if (
    !pack.region.complete ||
    counties.join("|") !== [...boundary.countyGeoids].sort().join("|") ||
    pack.destinations.some((unit) => !unit.id.startsWith(boundary.stateFips))
  )
    throw new Error(
      "This run requires the complete state workplace inventory matching its captured Census boundary.",
    );
  const coverage = assertRoutingCoverage(
    request.site,
    {
      ...manifest,
      coverage: { ...manifest.coverage, geometry: boundary.geometry },
    },
    request.mode,
  );
  return {
    status: "complete" as const,
    notes: [
      `The captured Census ${boundary.vintage} state boundary and complete ${counties.length}-county workplace inventory contain the potential 45-minute catchment.`,
      `Conservative boundary distance ${coverage.boundaryDistanceMeters.toFixed(1)} m exceeds the required ${coverage.requiredRadiusMeters.toFixed(1)} m radius, including both allowed snaps and the safety margin.`,
      "This verifies source-region coverage only. Unsnappable workplace points and source/routing uncertainty remain separate result limitations.",
    ],
  };
}

/** Operator/worker entry point. No network download, billing call or project mutation. */
export async function runCapturedAccessibility(options: {
  pack: AccessibilityDestinationPack;
  boundary: WorkforceRegionBoundary;
  router: AccessibilityRouter;
  request: AccessibilityRequest;
  signal?: AbortSignal;
  onProgress?: (
    stage: "validating" | "routing" | "aggregating" | "contours",
  ) => void;
}): Promise<CapturedAccessibilityResult> {
  const pack = structuredClone(options.pack),
    boundary = structuredClone(options.boundary);
  const request = accessibilityRequestSchema.parse(options.request);
  const manifest = structuredClone(options.router.manifest);
  const checkCancelled = () => options.signal?.throwIfAborted();
  checkCancelled();
  options.onProgress?.("validating");
  assertAccessibilityDestinationPack(pack);
  const sourceCoverage = accessibilityDestinationCoverage(
    pack,
    boundary,
    request,
    manifest,
  );
  // Check graph coverage independently, before admitting any native work.
  assertRoutingCoverage(request.site, manifest, request.mode);
  const jobsPackHash = await accessibilityContentHash(pack);
  const sourceCoverageWithHash = {
    ...sourceCoverage,
    boundaryHash: await accessibilityContentHash(boundary),
  };
  checkCancelled();
  options.onProgress?.("routing");
  // Zero-job source rows retain an explicit ledger entry without a native call.
  const destinations = pack.destinations
    .filter((origin) => origin.cells.C000 > 0)
    .map(({ id, position }) => ({ id, position }));
  if (!destinations.length)
    throw new Error(
      "This workplace pack has no positive-job destinations; no routing run was started.",
    );
  const matrix: RoutingMatrixResult<"outbound"> =
    await options.router.outboundMatrix({
      site: request.site,
      destinations,
      mode: request.mode,
      signal: options.signal,
    });
  checkCancelled();
  const providerRows = new Map(matrix.rows.map((row) => [row.id, row]));
  if (
    matrix.manifestId !== manifest.id ||
    matrix.inputHash !==
      routingOutboundMatrixInputHash(manifest, {
        site: request.site,
        destinations,
        mode: request.mode,
      }) ||
    matrix.mode !== request.mode ||
    matrix.direction !== "outbound" ||
    providerRows.size !== destinations.length ||
    matrix.rows.length !== destinations.length ||
    destinations.some((origin) => !providerRows.has(origin.id))
  )
    throw new Error(
      "The routing result does not match the complete captured destination request.",
    );
  const rows: AccessibilityRouteRow[] = pack.destinations.map((origin) =>
    origin.cells.C000 > 0
      ? providerRows.get(origin.id)!
      : {
          id: origin.id,
          status: "zero-jobs",
          seconds: null,
          distanceMeters: null,
          snapMeters: null,
        },
  );
  const network: AccessibilityRoutingRun["network"] = {
    id: manifest.id,
    engine: manifest.engine.name,
    engineVersion: manifest.engine.version,
    graphHash: manifest.graph.sha256,
    profileHash: routingProfileHash(manifest, request.mode, "outbound"),
    sourceHashes: manifest.sources.map((source) => source.sha256),
    extent: bbox(manifest.coverage.geometry) as [
      number,
      number,
      number,
      number,
    ],
    coverage: matrix.coverage.status,
    costing: "static",
    notes: [...matrix.notes, ...manifest.credits],
    exclusionProof: {
      method: "conservative-great-circle",
      maximumSpeedKph:
        request.mode === "car"
          ? manifest.profile.carTopSpeedKph
          : manifest.profile.walkingBoundKph,
      snapAllowanceMeters: 2 * manifest.coverage.maximumSnapMeters,
    },
  };
  const run: AccessibilityRoutingRun = {
    version: 1,
    jobsPackHash,
    request,
    network,
    sourceCoverage: sourceCoverageWithHash,
    inputHash: await accessibilityRoutingInputHash(
      jobsPackHash,
      request,
      network,
      sourceCoverageWithHash,
    ),
    createdAt: new Date().toISOString(),
    rows,
  };
  checkCancelled();
  options.onProgress?.("aggregating");
  const result = await resolveAccessibility(pack, run);
  checkCancelled();
  options.onProgress?.("contours");
  const contour = await options.router.outboundIsochrone({
    site: request.site,
    mode: request.mode,
    signal: options.signal,
  });
  checkCancelled();
  if (
    contour.manifestId !== manifest.id ||
    contour.inputHash !==
      routingIsochroneInputHash(manifest, request, "outbound") ||
    contour.mode !== request.mode ||
    contour.direction !== "outbound"
  )
    throw new Error("The contour does not match the captured routing run.");
  return {
    version: 1,
    run,
    result,
    contour,
    provider: {
      inputHash: matrix.inputHash,
      manifestId: matrix.manifestId,
      siteSnapMeters: matrix.siteSnapMeters,
      search: matrix.search,
    },
  };
}

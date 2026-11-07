import { bbox } from "@turf/turf";
import {
  assertWorkforceCohortPack,
  workforceContentHash,
  workforceRoutingInputHash,
  workforceRequestSchema,
  type WorkforceCohortPack,
  type WorkforceRequest,
  type WorkforceRoutingRun,
  type WorkforceRouteRow,
} from "@urban/core";
import { resolveWorkforce, type WorkforceResolution } from "@urban/models";
import {
  assertRoutingCoverage,
  routingMatrixInputHash,
  routingIsochroneInputHash,
  routingProfileHash,
  type ValhallaRouter,
  type RoutingIsochroneResult,
  type RoutingMatrixResult,
  type RoutingRegionManifest,
} from "./routing";
import {
  assertWorkforceRegionBoundary,
  type WorkforceRegionBoundary,
} from "./data/workforce-boundary";

export interface CapturedWorkforceResult {
  version: 1;
  run: WorkforceRoutingRun;
  result: WorkforceResolution;
  contour: RoutingIsochroneResult;
  provider: {
    inputHash: string;
    manifestId: string;
    siteSnapMeters: number;
    search: RoutingMatrixResult["search"];
  };
  metrics: {
    elapsedMilliseconds: number;
    routedInputOrigins: number;
    zeroWeightOrigins: number;
  };
}
type WorkforceRouter = Pick<
  ValhallaRouter,
  "manifest" | "inboundMatrix" | "inboundIsochrone"
>;

/** A complete source county list and its own boundary are required independently of the road extract. */
export function workforceCohortCoverage(
  pack: WorkforceCohortPack,
  boundary: WorkforceRegionBoundary,
  request: WorkforceRequest,
  manifest: RoutingRegionManifest,
) {
  assertWorkforceRegionBoundary(boundary);
  const counties = [...pack.region.countyGeoids].sort();
  if (
    !pack.region.complete ||
    counties.join("|") !== [...boundary.countyGeoids].sort().join("|") ||
    pack.units.some((unit) => !unit.geoid.startsWith(boundary.stateFips))
  )
    throw new Error(
      "This run requires the complete state cohort inventory matching its captured Census boundary.",
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
      `The captured Census ${boundary.vintage} state boundary and complete ${counties.length}-county cohort inventory contain the potential 45-minute catchment.`,
      `Conservative boundary distance ${coverage.boundaryDistanceMeters.toFixed(1)} m exceeds the required ${coverage.requiredRadiusMeters.toFixed(1)} m radius, including both allowed snaps and the safety margin.`,
      "This verifies source-region coverage only. Missing allocation, unsnappable origins and Census sampling uncertainty remain separate result limitations.",
    ],
  };
}

/** Operator/worker entry point. No network download, billing call or project mutation. */
export async function runCapturedWorkforce(options: {
  pack: WorkforceCohortPack;
  boundary: WorkforceRegionBoundary;
  router: WorkforceRouter;
  request: WorkforceRequest;
  signal?: AbortSignal;
  onProgress?: (
    stage: "validating" | "routing" | "aggregating" | "contours",
  ) => void;
}): Promise<CapturedWorkforceResult> {
  const started = performance.now();
  const pack = structuredClone(options.pack),
    boundary = structuredClone(options.boundary);
  const request = workforceRequestSchema.parse(options.request);
  const manifest = structuredClone(options.router.manifest);
  const checkCancelled = () => options.signal?.throwIfAborted();
  checkCancelled();
  options.onProgress?.("validating");
  assertWorkforceCohortPack(pack);
  const sourceCoverage = workforceCohortCoverage(
    pack,
    boundary,
    request,
    manifest,
  );
  // Check graph coverage independently, before admitting any native work.
  assertRoutingCoverage(request.site, manifest, request.mode);
  const cohortPackHash = await workforceContentHash(pack);
  const cohortCoverage = {
    ...sourceCoverage,
    boundaryHash: await workforceContentHash(boundary),
  };
  checkCancelled();
  options.onProgress?.("routing");
  // Zero allocation weights do not need a routing call. They retain explicit
  // unavailable rows; neither their geography nor original zero counts is dropped.
  const origins = pack.origins
    .filter((origin) => origin.weight > 0)
    .map(({ id, position }) => ({ id, position }));
  if (!origins.length)
    throw new Error(
      "This cohort pack has no usable allocation origins; no routing run was started.",
    );
  const matrix: RoutingMatrixResult = await options.router.inboundMatrix({
    site: request.site,
    origins,
    mode: request.mode,
    signal: options.signal,
  });
  checkCancelled();
  const providerRows = new Map(matrix.rows.map((row) => [row.id, row]));
  if (
    matrix.manifestId !== manifest.id ||
    matrix.inputHash !==
      routingMatrixInputHash(manifest, {
        site: request.site,
        origins,
        mode: request.mode,
      }) ||
    matrix.mode !== request.mode ||
    matrix.direction !== "inbound" ||
    providerRows.size !== origins.length ||
    matrix.rows.length !== origins.length ||
    origins.some((origin) => !providerRows.has(origin.id))
  )
    throw new Error(
      "The routing result does not match the complete captured origin request.",
    );
  const rows: WorkforceRouteRow[] = pack.origins.map((origin) =>
    origin.weight > 0
      ? providerRows.get(origin.id)!
      : {
          id: origin.id,
          status: "unavailable",
          seconds: null,
          distanceMeters: null,
          snapMeters: null,
        },
  );
  const network: WorkforceRoutingRun["network"] = {
    id: manifest.id,
    engine: manifest.engine.name,
    engineVersion: manifest.engine.version,
    graphHash: manifest.graph.sha256,
    profileHash: routingProfileHash(manifest, request.mode),
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
  const run: WorkforceRoutingRun = {
    version: 1,
    cohortPackHash,
    request,
    network,
    cohortCoverage,
    inputHash: await workforceRoutingInputHash(
      cohortPackHash,
      request,
      network,
      cohortCoverage,
    ),
    createdAt: new Date().toISOString(),
    rows,
  };
  checkCancelled();
  options.onProgress?.("aggregating");
  const result = await resolveWorkforce(pack, run);
  checkCancelled();
  options.onProgress?.("contours");
  const contour = await options.router.inboundIsochrone({
    site: request.site,
    mode: request.mode,
    signal: options.signal,
  });
  checkCancelled();
  if (
    contour.manifestId !== manifest.id ||
    contour.inputHash !== routingIsochroneInputHash(manifest, request) ||
    contour.mode !== request.mode ||
    contour.direction !== "inbound"
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
    metrics: {
      elapsedMilliseconds: performance.now() - started,
      routedInputOrigins: origins.length,
      zeroWeightOrigins: pack.origins.length - origins.length,
    },
  };
}

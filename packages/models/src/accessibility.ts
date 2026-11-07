import {
  ACCESSIBILITY_METHOD_VERSION,
  ACCESSIBILITY_EARNINGS,
  ACCESSIBILITY_INDUSTRIES,
  ACCESSIBILITY_ROUTE_STATUSES,
  accessibilityContentHash,
  accessibilityTravelTimeLowerBound,
  verifyAccessibilityRun,
  accessibilityResolutionSchema,
  verifyAccessibilityModeEvidence,
  type AccessibilityDestinationPack,
  type AccessibilityRoutingRun,
  type AccessibilityResolution,
  type AccessibilityCount,
  type AccessibilityCoverage,
  type AccessibilityModeEvidence,
  type CapturedAccessibilityResult,
  type AccessibilityContour,
  type AccessibilitySourceFile,
  type Source,
} from "@urban/core";

/** Every retained workplace appears exactly once. No population weights, area allocation, or origin sampling. */
export async function resolveAccessibility(
  source: AccessibilityDestinationPack,
  input: AccessibilityRoutingRun,
): Promise<AccessibilityResolution> {
  const pack = structuredClone(source),
    run = structuredClone(input);
  await verifyAccessibilityRun(pack, run);
  const routes = new Map(run.rows.map((r) => [r.id, r]));
  const coverage: AccessibilityCoverage = {
    regionDataComplete: pack.region.complete,
    network: run.network.coverage,
    destinations: structuredClone(run.sourceCoverage),
    destinationCount: pack.destinations.length,
    zeroJobDestinationCount: pack.destinations.filter((d) => d.cells.C000 === 0)
      .length,
    sourceJobs: pack.destinations.reduce((n, d) => n + d.cells.C000, 0),
    routeStatusCounts: Object.fromEntries(
      ACCESSIBILITY_ROUTE_STATUSES.map((s) => [
        s,
        run.rows.filter((r) => r.status === s).length,
      ]),
    ) as AccessibilityCoverage["routeStatusCounts"],
  };
  const complete =
    coverage.regionDataComplete &&
    coverage.network === "complete" &&
    coverage.destinations.status === "complete";
  // Bounds concern the representative block point, not every workplace entrance in a large block.
  const bounds = new Map(
    pack.destinations.map((d) => [
      d.id,
      accessibilityTravelTimeLowerBound(
        d.position,
        run.request.site,
        run.network,
      ),
    ]),
  );
  function count(cell: string, seconds: number): AccessibilityCount {
    let knownSubtotal = 0,
      knownRows = 0,
      unresolvedJobs = 0,
      unresolvedDestinationCount = 0;
    for (const d of pack.destinations) {
      const jobs = d.cells[cell],
        r = routes.get(d.id)!,
        lower = bounds.get(d.id);
      if (jobs === 0) {
        knownRows++;
        continue;
      }
      if (r.status === "reachable") {
        knownRows++;
        if (r.seconds! <= seconds) knownSubtotal += jobs;
      } else if (lower !== null && lower !== undefined && lower > seconds)
        knownRows++;
      else {
        unresolvedJobs += jobs;
        unresolvedDestinationCount++;
      }
    }
    const subtotal = knownRows ? knownSubtotal : null;
    const isComplete = complete && unresolvedJobs === 0;
    return {
      estimate: isComplete ? knownSubtotal : null,
      knownSubtotal: subtotal,
      status: isComplete
        ? "complete"
        : subtotal === null
          ? "unavailable"
          : "partial",
      unresolvedDestinationCount,
      unresolvedJobs,
      upperBound: complete ? knownSubtotal + unresolvedJobs : null,
    };
  }
  const result: AccessibilityResolution = {
    methodVersion: ACCESSIBILITY_METHOD_VERSION,
    jobsPackHash: run.jobsPackHash,
    routingRunHash: await accessibilityContentHash(run),
    inputHash: run.inputHash,
    capturedAt: run.createdAt,
    request: run.request,
    network: run.network,
    coverage,
    thresholds: ([15, 30, 45] as const).map((minutes) => ({
      minutes,
      total: count("C000", minutes * 60),
      earnings: ACCESSIBILITY_EARNINGS.map((c) => ({
        ...count(c.id, minutes * 60),
        ...c,
        sourceCells: [c.id],
      })),
      industries: ACCESSIBILITY_INDUSTRIES.map((c) => ({
        ...count(c.id, minutes * 60),
        ...c,
        sourceCells: [c.id],
      })),
    })),
    uncertainty: {
      sampling: "not-provided",
      spatial: "block-representative-point",
      routing: "static-captured-network",
    },
    notes: [
      "Outbound accessibility from the explicitly selected origin to every retained native 2020 workplace block point. This is not an area-wide population average.",
      "LODES 2023 JT01 counts primary jobs at workplaces, not vacancies, available workers, observed journeys, or all jobs. Earnings and industry families are separate partitions; do not add them together.",
      "All jobs in a source block use its exact Census internal point. These points are not measured workplace entrances; within-block placement and network snapping remain spatial uncertainty.",
      "Static captured-network travel time excludes the off-network snap gap and does not incorporate authored planning-road/building edits, congestion, parking, or scheduled transit.",
      "A null native route is unresolved, not zero jobs. Only a successful route or a conservative time lower bound resolves reachability; bounds are evaluated separately for 15, 30, and 45 minutes.",
      "Known subtotals retain resolved contributions. Upper bounds add all unresolved jobs only when both source-region and graph coverage are complete; these are accounting bounds, not confidence intervals.",
      "LODES disclosure protection, source coverage and modeling uncertainty are not represented by ACS sampling margins. No sampling margin of error is supplied.",
      ...pack.notes,
    ],
  };
  accessibilityResolutionSchema.parse(result);
  return result;
}

function contourVertices(contour: AccessibilityContour): number {
  const thresholds = new Set<number>();
  let vertices = 0;
  if (
    contour.geometry.type !== "FeatureCollection" ||
    contour.geometry.features.length < 3 ||
    contour.geometry.features.length > 1000
  )
    throw new Error("Retain the bounded full outbound contour collection.");
  for (const f of contour.geometry.features) {
    if (
      f.type !== "Feature" ||
      !f.properties ||
      ![15, 30, 45].includes(f.properties.contour)
    )
      throw new Error("Contour threshold identity is missing.");
    thresholds.add(f.properties.contour);
    if (!f.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type))
      throw new Error("Contours must retain polygon geometry.");
    const parts =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates]
        : f.geometry.coordinates;
    if (!parts.length) throw new Error("Contour polygons cannot be empty.");
    for (const part of parts) {
      if (!part.length) throw new Error("Contour polygons cannot be empty.");
      for (const ring of part) {
        vertices += ring.length;
        if (
          vertices > 100000 ||
          ring.length < 4 ||
          JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1)) ||
          ring.some(
            (p) =>
              p.length !== 2 ||
              !Number.isFinite(p[0]) ||
              !Number.isFinite(p[1]) ||
              Math.abs(p[0]) > 180 ||
              Math.abs(p[1]) > 90,
          )
        )
          throw new Error(
            "Contour rings must be complete, valid and within the retained vertex bound.",
          );
      }
    }
  }
  if (thresholds.size !== 3)
    throw new Error("Retain all requested outbound contours.");
  return vertices;
}
export interface CreateAccessibilityModeEvidenceOptions {
  binding: AccessibilityModeEvidence["binding"];
  pack: AccessibilityDestinationPack;
  artifact: CapturedAccessibilityResult;
  receipt: AccessibilityModeEvidence["receipt"];
  extraSources?: Source[];
  extraFiles?: AccessibilitySourceFile[];
}
/** Recomputes captured numerical evidence. Server project ownership still requires an authoritative artifact lookup. */
export async function createAccessibilityModeEvidence(
  options: CreateAccessibilityModeEvidenceOptions,
): Promise<AccessibilityModeEvidence> {
  const artifact = structuredClone(options.artifact),
    pack = structuredClone(options.pack),
    binding = structuredClone(options.binding),
    receipt = structuredClone(options.receipt);
  const expected = await resolveAccessibility(pack, artifact.run);
  if (
    (await accessibilityContentHash(expected)) !==
    (await accessibilityContentHash(artifact.result))
  )
    throw new Error(
      "Accessibility result does not match its complete source and routing ledger.",
    );
  const result = artifact.result,
    contour = artifact.contour;
  if (
    artifact.version !== 1 ||
    contour.manifestId !== result.network.id ||
    artifact.provider.manifestId !== result.network.id ||
    contour.direction !== "outbound" ||
    contour.mode !== result.request.mode ||
    JSON.stringify(contour.site) !== JSON.stringify(result.request.site) ||
    JSON.stringify(contour.minutes) !==
      JSON.stringify(result.request.thresholdsMinutes)
  )
    throw new Error(
      "Contour, provider and numerical evidence must describe the same outbound query.",
    );
  const sources = new Map<string, Source>();
  for (const s of [
    ...pack.sources,
    ...structuredClone(options.extraSources ?? []),
  ]) {
    const old = sources.get(s.id);
    if (
      old &&
      (await accessibilityContentHash(old)) !==
        (await accessibilityContentHash(s))
    )
      throw new Error(`Conflicting accessibility source citation: ${s.id}`);
    sources.set(s.id, s);
  }
  const capture = {
    ...structuredClone(result),
    artifactHash: await accessibilityContentHash(artifact),
    resultHash: await accessibilityContentHash(result),
    siteSnapMeters: artifact.provider.siteSnapMeters,
    source: {
      id: pack.id,
      lodes: pack.lodes,
      region: pack.region,
      pointMethod: pack.pointMethod,
    },
    sources: [...sources.values()],
    files: [...pack.files, ...structuredClone(options.extraFiles ?? [])],
    contour: {
      sha256: await accessibilityContentHash(contour),
      inputHash: contour.inputHash,
      manifestId: contour.manifestId,
      minutes: [...contour.minutes] as [15, 30, 45],
      featureCount: contour.geometry.features.length,
      vertexCount: contourVertices(contour),
    },
  };
  const evidence: AccessibilityModeEvidence = {
    version: 1,
    origin: "server-run",
    binding,
    receipt,
    captureHash: await accessibilityContentHash(capture),
    capture,
  };
  await verifyAccessibilityModeEvidence(evidence);
  return evidence;
}

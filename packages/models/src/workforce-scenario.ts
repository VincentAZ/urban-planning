import {
  WORKFORCE_CAPTURE_METHOD_VERSION,
  assertWorkforceScenario,
  validateWorkforceScenario,
  verifyWorkforceScenario,
  workforceContentHash,
  type CensusValueStatus,
  type Place,
  type Scenario,
  type Source,
  type WorkforceCapture,
  type WorkforceCapturedCount,
  type WorkforceCohortPack,
  type WorkforceContour,
  type WorkforceRoutingRun,
  type WorkforceScenario,
  type WorkforceSourceFile,
} from "@urban/core";
import {
  resolveWorkforce,
  type WorkforceCount,
  type WorkforceResolution,
} from "./workforce";

export interface WorkforceArtifactCaptureInput {
  run: WorkforceRoutingRun;
  result: WorkforceResolution;
  contour: WorkforceContour;
  provider: { siteSnapMeters: number };
}
export type CreateWorkforceScenarioOptions = (
  | { place: Place; binding?: never }
  | { binding: WorkforceScenario["binding"]; place?: never }
) & {
  pack: WorkforceCohortPack;
  artifact: WorkforceArtifactCaptureInput;
  receipt: WorkforceScenario["receipt"];
  extraSources?: Source[];
  extraFiles?: WorkforceSourceFile[];
};
const issueStatuses: CensusValueStatus[] = [
  "available",
  "missing",
  "suppressed",
  "not-applicable",
  "uncomputable",
  "controlled",
  "bounded",
];
function compactCount(count: WorkforceCount): WorkforceCapturedCount {
  const sourceIssueCellCounts = Object.fromEntries(
    issueStatuses.map((s) => [s, 0]),
  ) as Record<CensusValueStatus, number>;
  for (const issue of count.sourceIssues) sourceIssueCellCounts[issue.status]++;
  return {
    estimate: count.estimate,
    knownSubtotal: count.knownSubtotal,
    marginOfError90: count.marginOfError90,
    knownSubtotalMarginOfError90: count.knownSubtotalMarginOfError90,
    status: count.status,
    missingUnitCount: count.missingUnitGeoids.length,
    suppressedUnitCount: count.suppressedUnitGeoids.length,
    unresolvedAllocationUnitCount: count.unresolvedAllocationUnitGeoids.length,
    unresolvedAllocationMoeUnitCount:
      count.unresolvedAllocationMoeUnitGeoids.length,
    missingMoeUnitCount: count.missingMoeUnitGeoids.length,
    geographicallyPartialUnitCount: count.geographicallyPartialUnitCount,
    sourceIssueCellCounts,
  };
}
/** Exact numerical projection only; no estimates, uncertainty or source categories are recomputed here. */
export function compactWorkforcePanels(
  result: WorkforceResolution,
): WorkforceCapture["panels"] {
  return result.panels.map((panel) => ({
    id: panel.id,
    label: panel.label,
    universe: panel.universe,
    table: panel.table,
    thresholds: panel.thresholds.map((t) => ({
      minutes: t.minutes,
      total: compactCount(t.total),
      categories: t.categories.map((c) => ({
        ...compactCount(c),
        id: c.id,
        label: c.label,
        sourceCells: [...c.sourceCells],
      })),
    })),
  }));
}
function contourVertices(contour: WorkforceContour): number {
  if (
    contour.geometry.type !== "FeatureCollection" ||
    contour.geometry.features.length < 3 ||
    contour.geometry.features.length > 1000
  )
    throw new Error("Retain the complete bounded contour feature collection.");
  let count = 0;
  const thresholds = new Set<number>();
  for (const feature of contour.geometry.features) {
    if (
      feature.type !== "Feature" ||
      !feature.properties ||
      ![15, 30, 45].includes(feature.properties.contour)
    )
      throw new Error(
        "Contour features must identify the captured 15/30/45-minute thresholds.",
      );
    thresholds.add(feature.properties.contour);
    const geometry = feature.geometry;
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
      throw new Error("Retain full polygon or multipolygon contour geometry.");
    const parts =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    if (!parts.length) throw new Error("Contour geometry cannot be empty.");
    for (const part of parts) {
      if (!part.length) throw new Error("Contour polygon cannot be empty.");
      for (const ring of part) {
        count += ring.length;
        if (
          count > 100000 ||
          ring.length < 4 ||
          ring.some(
            (p) =>
              p.length !== 2 ||
              !Number.isFinite(p[0]) ||
              !Number.isFinite(p[1]) ||
              Math.abs(p[0]) > 180 ||
              Math.abs(p[1]) > 90,
          ) ||
          JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))
        )
          throw new Error(
            "Contour geometry must retain valid closed rings within the 100,000-vertex limit.",
          );
      }
    }
  }
  if (thresholds.size !== 3)
    throw new Error("The contour is missing a requested threshold.");
  return count;
}
/** Rechecks the captured native calculation, then stores a compact projection without native rows or geometry.
 * This proves internal consistency, not project ownership or operator/source authenticity. */
export async function createWorkforceScenario(
  options: CreateWorkforceScenarioOptions,
): Promise<WorkforceScenario> {
  const artifact = structuredClone(options.artifact),
    receipt = structuredClone(options.receipt);
  const place = options.place ? structuredClone(options.place) : undefined;
  const binding = options.binding
    ? structuredClone(options.binding)
    : undefined;
  if ((place === undefined) === (binding === undefined))
    throw new Error(
      "Supply exactly one immutable place or captured baseline binding.",
    );
  const metadata = structuredClone({
    id: options.pack.id,
    acs: options.pack.acs,
    region: options.pack.region,
    allocation: options.pack.allocation,
  });
  const sources = structuredClone([
      ...options.pack.sources,
      ...(options.extraSources ?? []),
    ]),
    files = structuredClone([
      ...options.pack.files,
      ...(options.extraFiles ?? []),
    ]);
  // resolveWorkforce captures the raw pack and route rows before its first await.
  const expected = await resolveWorkforce(options.pack, artifact.run);
  if (
    (await workforceContentHash(expected)) !==
    (await workforceContentHash(artifact.result))
  )
    throw new Error(
      "The archived workforce result does not match its retained native evidence and current method.",
    );
  const result = artifact.result,
    contour = artifact.contour;
  if (
    result.methodVersion !== WORKFORCE_CAPTURE_METHOD_VERSION ||
    contour.manifestId !== result.network.id ||
    contour.mode !== result.request.mode ||
    contour.direction !== "inbound" ||
    JSON.stringify(contour.site) !== JSON.stringify(result.request.site) ||
    JSON.stringify(contour.minutes) !==
      JSON.stringify(result.request.thresholdsMinutes)
  )
    throw new Error(
      "The contour and numerical capture do not describe the same inbound query.",
    );
  const uniqueSources = new Map<string, Source>();
  for (const source of sources) {
    const existing = uniqueSources.get(source.id);
    if (
      existing &&
      (await workforceContentHash(existing)) !==
        (await workforceContentHash(source))
    )
      throw new Error(
        `Conflicting captured workforce source metadata for ${source.id}.`,
      );
    uniqueSources.set(source.id, source);
  }
  const capture: WorkforceCapture = {
    artifactHash: await workforceContentHash(artifact),
    resultHash: await workforceContentHash(result),
    routingRunHash: result.routingRunHash,
    inputHash: result.inputHash,
    cohortPackHash: result.cohortPackHash,
    capturedAt: result.capturedAt,
    siteSnapMeters: artifact.provider.siteSnapMeters,
    methodVersion: result.methodVersion,
    request: structuredClone(result.request),
    network: structuredClone(result.network),
    cohort: metadata,
    sources: [...uniqueSources.values()],
    files,
    coverage: structuredClone(result.coverage),
    uncertainty: structuredClone(result.uncertainty),
    notes: [...result.notes],
    panels: compactWorkforcePanels(result),
    contour: {
      sha256: await workforceContentHash(contour),
      inputHash: contour.inputHash,
      manifestId: contour.manifestId,
      minutes: [...contour.minutes],
      featureCount: contour.geometry.features.length,
      vertexCount: contourVertices(contour),
    },
  };
  const saved: WorkforceScenario = {
    version: 1,
    origin: "server-run",
    binding: binding ?? {
      placeId: place!.id,
      baselineHash: await workforceContentHash(place),
    },
    receipt,
    captureHash: await workforceContentHash(capture),
    capture,
  };
  assertWorkforceScenario(saved);
  if (place) await verifyWorkforceScenario(saved, place);
  return saved;
}
export interface ScenarioWorkforceResolution {
  origin: WorkforceScenario["origin"];
  capture: WorkforceCapture;
  receipt: WorkforceScenario["receipt"];
  captureHash: string;
  /** A caller-supplied receipt never establishes backend verification. */
  verification: "not-established";
  context: "captured-network";
  warnings: string[];
}
/** Read captured evidence without rescaling it by current buildings, assumptions, activity or horizon. */
export function resolveScenarioWorkforce(
  place: Place,
  scenario: Scenario,
): ScenarioWorkforceResolution | null {
  if (!scenario.workforce) return null;
  validateWorkforceScenario(scenario.workforce, place);
  const warnings = [
    "Captured inbound source-network context. This is separate from outbound jobs access and does not measure available applicants.",
    "Receipt and content hashes retain evidence identity; server verification is not established by a project file alone.",
  ];
  if (scenario.workforce.origin === "imported")
    warnings.push(
      "Imported workforce evidence is unverified. Its original receipt does not grant access to a private server artifact.",
    );
  if (Object.keys(scenario.roadEdits).length)
    warnings.push(
      "Authored street changes are not represented in this captured regional network.",
    );
  if (Object.keys(scenario.buildingEdits).length || scenario.activity)
    warnings.push(
      "Scenario buildings and population/employment controls do not change the captured Census workforce cohorts.",
    );
  if (scenario.horizon !== 0)
    warnings.push(
      "The current scenario horizon is not a workforce forecast. Counts retain the captured ACS source period and network.",
    );
  if (
    scenario.workforce.capture.panels.some((p) =>
      p.thresholds.some((t) => t.total.status !== "complete"),
    )
  )
    warnings.push(
      "Only known subtotals are available where source allocation or routing remains unresolved; do not describe them as complete commute-shed totals.",
    );
  return {
    origin: scenario.workforce.origin,
    capture: structuredClone(scenario.workforce.capture),
    receipt: structuredClone(scenario.workforce.receipt),
    captureHash: scenario.workforce.captureHash,
    verification: "not-established",
    context: "captured-network",
    warnings,
  };
}

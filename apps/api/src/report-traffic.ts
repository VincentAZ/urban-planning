import { createHash } from "node:crypto";
import {
  assertTrafficScenario,
  canonicalJSON,
  materializeRoads,
} from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { ApiError } from "./errors";

export const trafficReportDisclosure =
  "This saved traffic evidence is an explicit network experiment, not a simulation of the entire planning scenario. Entered vehicle demand and native directed-edge controls are independent of building, population, employment and horizon edits. Simulation time loss is not intersection control delay or a level-of-service grade. Count fit alone does not validate travel times, queues or future forecasts.";
export const trafficSubtotalDisclosure =
  "Full measures and paired changes are withheld when a run is incomplete or fails accounting checks. Completed-cohort values describe only vehicles that arrived. When a run is incomplete, these values are censored and must not be treated as full-run performance. Warm-up departures are excluded from the reported measurement cohort.";
export const trafficMeasures = [
  ["meanTravelTimeSeconds", "Mean travel time", "seconds"],
  ["meanTimeLossSeconds", "Mean simulation time loss", "seconds"],
  ["meanDepartureDelaySeconds", "Mean departure delay", "seconds"],
  ["vehicleKilometers", "Vehicle distance", "vehicle-km"],
  ["vehicleHours", "Vehicle travel time", "vehicle-hours"],
] as const;
export const trafficDisplay = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
const sha = (value: unknown) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");

/** Projection of the frozen capture only. No native execution, calibration or metric recalculation. */
export function trafficReportInventory(snapshot: ReportSnapshot) {
  const evidence = snapshot.scenario.traffic;
  if (!evidence) return null;
  assertTrafficScenario(evidence);
  if (
    evidence.binding.placeId !== snapshot.place.id ||
    evidence.binding.baselineHash !== sha(snapshot.place) ||
    evidence.captureHash !== sha(evidence.capture) ||
    evidence.capture.comparison.recipeHash !== sha(evidence.capture.recipe) ||
    (evidence.capture.originalDemand.commute &&
      sha(evidence.capture.originalDemand.commute.recipe.period) !==
        evidence.capture.originalDemand.commute.binding.periodHash) ||
    (evidence.capture.proposal.signalTimings ?? []).some(
      (timing) => sha(timing.baseline) !== timing.control.baselineProgramHash,
    )
  )
    throw new ApiError(
      422,
      "TRAFFIC_EVIDENCE_INVALID",
      "Saved traffic evidence does not match its captured content or this immutable planning baseline.",
    );
  const capture = evidence.capture;
  const roads = [...materializeRoads(snapshot.place, snapshot.scenario)].sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const stale = sha(roads) !== evidence.binding.roadEditsHash;
  const origin =
    evidence.origin === "imported"
      ? "Imported evidence — not verified by this server"
      : "Captured run — receipt retained";
  const freshness = stale
    ? "Stale for current planning roads: roads or controls changed after capture. Retained results describe the captured experiment."
    : "Planning road identity matches the capture. This does not establish that those roads or other planning edits were represented in the native experiment.";
  const period = capture.recipe.period;
  const commute = capture.originalDemand.commute;
  const clock = (seconds: number) =>
    `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const contextDescription = `${origin}. Captured ${capture.capturedAt}; standalone method ${capture.methodVersion}; SUMO ${capture.network.engine.version}. Local analysis window ${period.date}, ${clock(period.beginSeconds)}–${clock(period.endSeconds)} ${period.timeZone} (UTC offset ${period.utcOffsetMinutes} minutes); warm-up ${period.warmupSeconds} seconds; cooldown ${period.cooldownSeconds} seconds; seed ${capture.recipe.seed}. Retained alongside scenario revision ${snapshot.scenario.revision}, horizon ${snapshot.scenario.horizon} years; the horizon does not grow this demand.`;
  const resultRows = trafficMeasures.map(([key, label, unit]) => [
    label,
    unit,
    trafficDisplay(capture.comparison.baseline[key]),
    trafficDisplay(capture.comparison.proposal[key]),
    trafficDisplay(capture.comparison.delta[key]),
  ]);
  const subtotalRows = trafficMeasures.map(([key, label, unit]) => [
    label,
    unit,
    trafficDisplay(capture.comparison.baseline.completedSubtotal[key]),
    trafficDisplay(capture.comparison.proposal.completedSubtotal[key]),
  ]);
  const summaryLabels = {
    status: "Run status",
    requested: "Requested vehicles including warm-up",
    completed: "Arrived vehicles including warm-up",
    incomplete: "Vehicles not arrived",
    measurementRequested: "Requested measurement-cohort vehicles",
    measurementCompleted: "Arrived measurement-cohort vehicles",
    completionFraction: "Arrival fraction of requested vehicles",
  };
  const diagnosticLabels: Record<string, string> = {
    requested: "Requested vehicles",
    loaded: "Loaded vehicles",
    inserted: "Inserted into network",
    arrived: "Arrived at destination",
    running: "Still in network",
    waiting: "Waiting to enter network",
    discarded: "Discarded vehicles",
    teleports: "Teleports",
    collisions: "Collisions",
    routeErrors: "Route errors",
  };
  const summaryRows = (
    [
      "status",
      "requested",
      "completed",
      "incomplete",
      "measurementRequested",
      "measurementCompleted",
      "completionFraction",
    ] as const
  ).map((key) => [
    summaryLabels[key],
    ...(["baseline", "proposal"] as const).map((side) => {
      const value = capture.comparison[side][key];
      return typeof value === "string" ? value : trafficDisplay(value);
    }),
  ]);
  const diagnosticRows = Object.keys(capture.runs.baseline.diagnostics).map(
    (key) => [
      diagnosticLabels[key] ?? key,
      String(
        capture.runs.baseline.diagnostics[
          key as keyof typeof capture.runs.baseline.diagnostics
        ],
      ),
      String(
        capture.runs.proposal.diagnostics[
          key as keyof typeof capture.runs.proposal.diagnostics
        ],
      ),
    ],
  );
  const calibrationRows = capture.calibration
    ? (["calibration", "holdout"] as const).map((role) => {
        const row = capture.calibration![role];
        return [
          role === "holdout" ? "Declared holdout" : "Calibration set",
          row.status,
          String(row.requested),
          String(row.evaluated),
          String(row.unavailable),
          String(row.passed),
          trafficDisplay(row.passingFraction),
        ];
      })
    : [];
  const overlayRows = capture.proposal.overlays.map((o) => [
    o.edgeId,
    o.closed === undefined ? "Unchanged" : o.closed ? "Closed" : "Open",
    o.lanes === undefined ? "Unchanged" : String(o.lanes),
    o.speedMps === undefined ? "Unchanged" : String(o.speedMps),
  ]);
  const mapping = capture.proposal.planningRoadMapping;
  const signalTimingRows = (capture.proposal.signalTimings ?? []).flatMap(
    ({ baseline, proposal }) => [
      [
        baseline.id,
        `Program ${baseline.programId} · cycle`,
        String(
          baseline.phases.reduce(
            (total, phase) => total + phase.durationSeconds,
            0,
          ),
        ),
        String(
          proposal.phases.reduce(
            (total, phase) => total + phase.durationSeconds,
            0,
          ),
        ),
      ],
      [
        baseline.id,
        "Offset",
        String(baseline.offsetSeconds),
        String(proposal.offsetSeconds),
      ],
      ...baseline.phases.map((phase, index) => [
        baseline.id,
        `Phase ${index + 1} · ${phase.state}`,
        String(phase.durationSeconds),
        String(proposal.phases[index].durationSeconds),
      ]),
    ],
  );
  const notes = [
    ...(capture.proposal.signalTimings?.length
      ? [
          "Authored signal timing changes retain existing movement states, sequence and clearance phases. Baseline signal programs may be inferred; timing edits do not establish observed timing, engineering safety, traffic calibration or a mapping from planning-road signal edits.",
          ...capture.proposal.signalTimings.map(
            ({ control, baseline }) =>
              `Native signal ${control.signalId}, program ${control.programId}: ${control.rationale}. Baseline program SHA-256 ${control.baselineProgramHash}; baseline quality ${baseline.quality}; source IDs ${baseline.sourceIds.join("; ")}. All phase durations and offsets in the timing table are seconds.`,
          ),
        ]
      : []),
    capture.originalDemand.description,
    ...(commute
      ? [
          `Census commute subset: ${commute.coverage.status}. Source estimate ${trafficDisplay(commute.totals.sourceVehicles)} commuters; known source subtotal ${trafficDisplay(commute.totals.knownSourceVehicles)}; supported local demand ${trafficDisplay(commute.totals.admittedExpectedVehicles)} expected vehicles; deterministic rounded simulation count ${commute.totals.vehicles}. ${commute.coverage.routeStatusCounts.routed} of ${commute.coverage.selectedNativeFlows} selected native origin-destination pairs have a supported local route. This is not a whole-area or all-purpose traffic forecast.`,
          `Commute accounting before rounding: unresolved source/destination ${trafficDisplay(commute.totals.knownUnresolvedSourceVehicles)}; unresolved route ${trafficDisplay(commute.totals.unresolvedRouteVehicles)}; no local intersection ${trafficDisplay(commute.totals.noLocalIntersectionVehicles)}; before window ${trafficDisplay(commute.totals.beforeWindowVehicles)}; after window ${trafficDisplay(commute.totals.afterWindowVehicles)}; admitted warm-up ${trafficDisplay(commute.totals.warmupExpectedVehicles)}; admitted measurement ${trafficDisplay(commute.totals.measurementExpectedVehicles)}. Rounding adjustment ${trafficDisplay(commute.totals.roundingDelta)}; conservation residual ${trafficDisplay(commute.totals.conservationResidual)}. Missing trips were not redistributed.`,
          `Commute origins: ${commute.recipe.originTractGeoids.join(", ")}; home departure cells ${commute.recipe.departureCellIds.join(", ")}; uniform within source bins. The chosen simulation clock is not the source observation date. Conditional ACS sampling margin ${trafficDisplay(commute.conditionalAcsSampling.conditionalSamplingMoe)} vehicles excludes route, synthetic-source and model uncertainty.`,
          `Commute preparation SHA-256 ${commute.binding.compilationHash}; source pack ${commute.binding.sourcePackHash}; regional/local routes ${commute.binding.routesHash}; retained asset ${commute.binding.assetHash}. The complete normalized source recipe and flow/bin loss ledger remain in the private run archive.`,
          ...commute.notes,
          ...commute.conditionalAcsSampling.notes,
        ]
      : []),
    `Original demand: ${capture.originalDemand.vehicleCount} vehicles. Sources: ${capture.originalDemand.sourceIds.join("; ")}.`,
    `Count inventory: ${capture.countEvidence.mappedCountCount} mapped; ${capture.countEvidence.unmappedCountCount} unmapped. Mapping is not evidence of compatible vehicle classes or successful calibration. Sources: ${capture.countEvidence.sourceIds.join("; ")}.`,
    `Calibration: ${capture.calibration ? `${capture.calibration.status}; observed baseline interval-count fit only` : "Not assessed — no baseline count-check plan was supplied"}.`,
    ...(capture.calibration
      ? [
          `Criteria: GEH ≤ ${capture.calibration.criteria.gehMaximum}; absolute hourly error ≤ ${capture.calibration.criteria.absoluteHourlyErrorMaximum} OR relative error ≤ ${capture.calibration.criteria.relativeErrorMaximum}; required passing fraction ${capture.calibration.criteria.requiredPassingFraction}; minimum calibration / holdout counts ${capture.calibration.criteria.minimumCalibrationCounts} / ${capture.calibration.criteria.minimumHoldoutCounts}. ${capture.calibration.criteriaDescription} Criteria sources: ${capture.calibration.criteriaSourceIds.join("; ")}.`,
          ...capture.calibration.notes,
        ]
      : []),
    `Planning-road mapping: ${mapping.status}. Unrepresented edited road IDs: ${mapping.unrepresentedRoadIds.join("; ") || "None listed"}.`,
    ...mapping.reviewedLinks.map(
      (l) =>
        `Reviewed planning road ${l.roadId}, content SHA-256 ${l.roadEditHash}; native edges ${l.edgeIds.join("; ")}; properties ${l.representedProperties.join("; ")}; reviewer ${l.reviewedBy}, ${l.reviewedAt}.`,
    ),
    ...(mapping.correspondence
      ? [
          `Planning correspondence version ${mapping.correspondence.version}; baseline ${mapping.correspondence.baselineHash}; road-state ${mapping.correspondence.roadEditsHash}; native inventory ${mapping.correspondence.inventoryHash}. Direction and extent are human-reviewed. Whole selected native edges are controlled, including acknowledged extension beyond the planning centerline.`,
          ...mapping.correspondence.reviews.flatMap((review) => [
            `Road ${review.roadId}: ${review.extent}; ${review.rationale}. Baseline road hash ${review.baselineRoadHash}; proposed road hash ${review.roadEditHash}.`,
            ...review.directions.map(
              (direction) =>
                `Road ${review.roadId}, ${direction.direction}: ordered native edges ${direction.edgeIds.join("; ")}; directional lane target ${direction.lanes ?? "not changed"}. Serial edges repeat this target and are not added together.`,
            ),
            ...review.notes,
          ]),
          ...mapping.correspondence.exclusions.map(
            (exclusion) =>
              `Unrepresented planning property: road ${exclusion.roadId}, ${exclusion.property} (${exclusion.reason}). ${exclusion.detail}`,
          ),
          ...mapping.correspondence.sources.map((source) => {
            const declaration = mapping.correspondence!.sourceDeclarations.find(
              (value) => value.sourceId === source.id,
            );
            return `Planning-correspondence source [separate namespace] ${source.id}: ${source.name}; ${source.vintage}; ${source.license}; ${source.url || "No external URL"}. ${source.description ?? ""} Permission attestation: ${declaration ? `private processing confirmed; public redistribution ${declaration.publicRedistribution ? "permitted" : "not permitted"}; ${declaration.declaredBy}, ${declaration.declaredAt}` : "not declared"}. Original source metadata is retained unchanged.`;
          }),
        ]
      : []),
    ...mapping.notes,
    ...(["baseline", "proposal"] as const).flatMap((side) =>
      [
        ...capture.comparison[side].reasons,
        ...capture.comparison[side].notes,
      ].map((note) => `${side}: ${note}`),
    ),
    ...capture.comparison.notes,
    ...capture.network.notes,
    ...capture.network.conversion.warnings,
    `Network conversion ${capture.network.conversion.version}; options: ${capture.network.conversion.options.join("; ")}. Network ID ${capture.network.id}; bounds ${capture.network.bounds.join(", ")}; engine image ${capture.network.engine.imageDigest}.`,
    ...capture.notes,
    `Capture SHA-256: ${evidence.captureHash}. Recipe SHA-256: ${capture.comparison.recipeHash}.`,
    `Planning baseline SHA-256: ${evidence.binding.baselineHash}. Planning road-state SHA-256: ${evidence.binding.roadEditsHash}.`,
    `Baseline / proposal native network SHA-256: ${capture.network.baselineFileSha256} / ${capture.network.proposalFileSha256}.`,
    `Demand SHA-256: ${capture.originalDemand.hash}. Count pack SHA-256: ${capture.countEvidence.packHash}. Calibration selection SHA-256: ${capture.countEvidence.selectionHash ?? "Not assessed"}. Settings SHA-256: ${capture.recipe.settingsHash}.`,
    `Assigned route SHA-256: baseline ${capture.runs.baseline.assignedRoutesHash}; proposal ${capture.runs.proposal.assignedRoutesHash}.`,
    `Private archive manifest SHA-256: ${capture.privateArchive.sha256}; ${capture.privateArchive.bytes} bytes; ${capture.privateArchive.fileCount} files. Receipt: project ${evidence.receipt.projectId}; job ${evidence.receipt.jobId}; capture ${evidence.receipt.captureId}. No private archive URL or raw trip records are embedded in this report.`,
    "Hashes and a retained receipt identify evidence; an exported or imported document does not independently authenticate its origin. This export does not rerun the simulation or establish engineering validity.",
    ...[...capture.network.sourceFiles, ...capture.files].map(
      (file) =>
        `Evidence file (${file.sourceId}): ${file.url}. ${file.bytes} bytes; retrieved ${file.retrievedAt}; SHA-256 ${file.sha256}.`,
    ),
  ];
  return {
    evidence,
    capture,
    stale,
    origin,
    freshness,
    contextDescription,
    resultRows,
    subtotalRows,
    summaryRows,
    diagnosticRows,
    calibrationRows,
    overlayRows,
    signalTimingRows,
    notes,
  };
}
export function requireTrafficReport(snapshot: ReportSnapshot) {
  const inventory = trafficReportInventory(snapshot);
  if (!inventory)
    throw new ApiError(
      422,
      "TRAFFIC_ANALYSIS_REQUIRED",
      "This saved scenario has no traffic experiment capture.",
    );
  return inventory;
}
export function assertTrafficDocumentLimit(snapshot: ReportSnapshot) {
  if (
    snapshot.scenario.traffic &&
    (Buffer.byteLength(JSON.stringify(snapshot.scenario.traffic), "utf8") >
      120_000 ||
      snapshot.scenario.traffic.capture.proposal.overlays.length > 150 ||
      (snapshot.scenario.traffic.capture.proposal.signalTimings ?? []).reduce(
        (total, timing) => total + timing.baseline.phases.length + 2,
        0,
      ) > 150)
  )
    throw new ApiError(
      413,
      "TRAFFIC_REPORT_TOO_LARGE",
      "This traffic capture is too large for a PDF or Word appendix. Export CSV, XLSX or saved records; no evidence or controls have been omitted.",
    );
}

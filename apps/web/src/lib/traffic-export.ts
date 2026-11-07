import {
  assertTrafficScenario,
  trafficScenarioStatus,
  type Place,
  type Scenario,
  type TrafficScenario,
} from "@urban/core";

export type TrafficExportStatus = {
  stale: boolean;
  origin: TrafficScenario["origin"];
};
export async function trafficExportStatus(
  place: Place,
  scenario: Scenario,
): Promise<TrafficExportStatus | undefined> {
  return scenario.traffic
    ? trafficScenarioStatus(scenario.traffic, place, scenario)
    : undefined;
}
const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const number = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
const measures = [
  ["meanTravelTimeSeconds", "Mean travel time", "seconds"],
  ["meanTimeLossSeconds", "Mean simulation time loss", "seconds"],
  ["meanDepartureDelaySeconds", "Mean departure delay", "seconds"],
  ["vehicleKilometers", "Vehicle distance", "vehicle-km"],
  ["vehicleHours", "Vehicle travel time", "vehicle-hours"],
] as const;
export const trafficExportDisclosure =
  "Explicit network experiment, not a simulation of the entire planning scenario. Building, population, employment and horizon edits do not automatically change this captured demand. Native edge controls do not establish a reviewed mapping from planning roads. Simulation time loss is not intersection control delay or a level-of-service grade. Count fit alone does not validate travel times, queues or forecasts.";

/** Saved evidence only. The async print/export caller supplies its integrity and road-identity check. */
export function trafficHTML(scenario: Scenario, status?: TrafficExportStatus) {
  const evidence = scenario.traffic;
  if (!evidence) return "";
  assertTrafficScenario(evidence);
  const capture = evidence.capture;
  const freshness = status
    ? status.stale
      ? "Stale for current planning roads. Roads or controls changed after capture; these results describe the retained experiment."
      : "Planning road identity matches the capture. This does not establish that planning edits were represented in the native experiment."
    : "Planning-road freshness was not checked in this synchronous export. Compare the retained road-state hash before using these results for the current scenario.";
  const origin =
    evidence.origin === "imported"
      ? "Imported evidence — not verified by this server"
      : "Captured run — receipt retained";
  const table = (headings: string[], rows: (string | number)[][]) =>
    `<table><thead><tr>${headings.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const calibration = capture.calibration;
  const commute = capture.originalDemand.commute;
  const planning = capture.proposal.planningRoadMapping.correspondence;
  return `<h2>Captured traffic experiment</h2><p><strong>${esc(origin)}</strong> · Captured ${esc(capture.capturedAt)} · Standalone method ${esc(capture.methodVersion)} · SUMO ${esc(capture.network.engine.version)}.</p><p class="notice">${esc(trafficExportDisclosure)}</p><p class="notice">${esc(freshness)}</p><p>Analysis date ${esc(capture.recipe.period.date)}; seconds after local midnight ${capture.recipe.period.beginSeconds}–${capture.recipe.period.endSeconds}; ${esc(capture.recipe.period.timeZone)}, UTC offset ${capture.recipe.period.utcOffsetMinutes} minutes; warm-up ${capture.recipe.period.warmupSeconds} seconds; cooldown ${capture.recipe.period.cooldownSeconds} seconds; seed ${capture.recipe.seed}.</p>
${
  commute
    ? `<h3>Census commute subset</h3><p class="notice">${esc(commute.coverage.status)}. ${commute.coverage.routeStatusCounts.routed} of ${commute.coverage.selectedNativeFlows} source origin–destination pairs have a supported local path. This modeled drive-alone commute subset does not establish a whole-area or all-purpose traffic forecast. Unresolved trips are not redistributed onto supported routes.</p>${table(
        ["Source and route accounting", "Expected vehicles"],
        [
          ["Source estimate", number(commute.totals.sourceVehicles)],
          ["Known source subtotal", number(commute.totals.knownSourceVehicles)],
          [
            "Unresolved source or destination",
            number(commute.totals.knownUnresolvedSourceVehicles),
          ],
          [
            "Unresolved local route",
            number(commute.totals.unresolvedRouteVehicles),
          ],
          [
            "No local intersection",
            number(commute.totals.noLocalIntersectionVehicles),
          ],
          ["Before window", number(commute.totals.beforeWindowVehicles)],
          ["After window", number(commute.totals.afterWindowVehicles)],
          [
            "Supported local demand",
            number(commute.totals.admittedExpectedVehicles),
          ],
          [
            "Warm-up share of supported demand",
            number(commute.totals.warmupExpectedVehicles),
          ],
          [
            "Measurement share of supported demand",
            number(commute.totals.measurementExpectedVehicles),
          ],
          ["Rounded simulation vehicles", number(commute.totals.vehicles)],
          ["Rounding adjustment", number(commute.totals.roundingDelta)],
          [
            "Conservation residual before rounding",
            number(commute.totals.conservationResidual),
          ],
        ],
      )}<p>Origin tracts ${esc(commute.recipe.originTractGeoids.join(", "))}; home-departure cells ${esc(commute.recipe.departureCellIds.join(", "))}; uniform within each bin. The simulation date is not the source observation date. Conditional ACS sampling margin ${number(commute.conditionalAcsSampling.conditionalSamplingMoe)} vehicles excludes route, synthetic-source and model uncertainty. Preparation SHA-256 ${esc(commute.binding.compilationHash)}. Complete source recipe and flow/bin loss ledger are retained in the private run archive.</p>${[...commute.notes, ...commute.conditionalAcsSampling.notes].map((note) => `<p>${esc(note)}</p>`).join("")}`
    : ""
}
${table(
  ["Measure", "Unit", "Baseline", "Proposal", "Change"],
  measures.map(([key, label, unit]) => [
    label,
    unit,
    number(capture.comparison.baseline[key]),
    number(capture.comparison.proposal[key]),
    number(capture.comparison.delta[key]),
  ]),
)}
<p>Full measures and paired changes remain unavailable for incomplete or failed runs. Completed-cohort values describe only vehicles that arrived. When a run is incomplete, those values are censored, not full-run performance. Warm-up departures are excluded from the measurement cohort.</p>
${table(
  ["Completed-cohort subtotal", "Unit", "Baseline", "Proposal"],
  measures.map(([key, label, unit]) => [
    label,
    unit,
    number(capture.comparison.baseline.completedSubtotal[key]),
    number(capture.comparison.proposal.completedSubtotal[key]),
  ]),
)}
<h3>Completion and accounting</h3>${table(
    ["Native diagnostic", "Baseline", "Proposal"],
    Object.keys(capture.runs.baseline.diagnostics).map((key) => [
      key,
      capture.runs.baseline.diagnostics[
        key as keyof typeof capture.runs.baseline.diagnostics
      ],
      capture.runs.proposal.diagnostics[
        key as keyof typeof capture.runs.proposal.diagnostics
      ],
    ]),
  )}
<p>Baseline status ${esc(capture.comparison.baseline.status)}; proposal status ${esc(capture.comparison.proposal.status)}. Measurement cohort: baseline ${number(capture.comparison.baseline.measurementCompleted)} completed of ${number(capture.comparison.baseline.measurementRequested)}; proposal ${number(capture.comparison.proposal.measurementCompleted)} of ${number(capture.comparison.proposal.measurementRequested)}.</p>
<h3>Calibration and declared holdout</h3><p>${calibration ? `${esc(calibration.status)}; observed baseline interval-count fit only. ${esc(calibration.criteriaDescription)}` : "Not assessed. No baseline count-check plan was supplied."}</p>
${
  calibration
    ? table(
        [
          "Set",
          "Status",
          "Selected",
          "Evaluated",
          "Unknown",
          "Passed",
          "Passing fraction",
        ],
        (["calibration", "holdout"] as const).map((role) => {
          const row = calibration[role];
          return [
            role,
            row.status,
            row.requested,
            row.evaluated,
            row.unavailable,
            row.passed,
            number(row.passingFraction),
          ];
        }),
      )
    : ""
}
<p>Planning-road mapping: ${esc(capture.proposal.planningRoadMapping.status)}. Unrepresented edited road IDs: ${esc(capture.proposal.planningRoadMapping.unrepresentedRoadIds.join("; ") || "None listed")}.</p>
${
  planning
    ? `<h3>Reviewed planning-road correspondence</h3><p>Property-level coverage; a reviewed link does not mean all changes on that street were simulated. Full selected native edges are affected.</p>${table(
        [
          "Planning street",
          "Properties",
          "Extent",
          "Directions / lanes",
          "Rationale",
        ],
        planning.reviews.map((review) => [
          review.roadId,
          review.properties.join(", "),
          `${review.extent}; native extension ${review.nativeExtensionAcknowledged ? "acknowledged" : "not acknowledged"}`,
          review.directions
            .map(
              (direction) =>
                `${direction.direction}: ${direction.edgeIds.join(" → ")}${direction.lanes === undefined ? "" : ` (${direction.lanes} lanes per serial edge)`}`,
            )
            .join("; "),
          review.rationale,
        ]),
      )}${table(
        ["Omitted planning property", "Reason", "Explanation"],
        planning.exclusions.map((entry) => [
          `${entry.roadId}: ${entry.property}`,
          entry.reason,
          entry.detail,
        ]),
      )}<h3>Separate planning-road source inventory</h3><p>Original citations and permission declarations are separate from native and count sources; equal IDs do not merge their meaning.</p>${planning.sources.map((source) => `<section><h4>${esc(source.name)}</h4><p>${esc(source.id)} · ${esc(source.vintage)} · ${esc(source.license)}</p><p>${esc(source.url)}</p><p>${esc(source.description)}</p><p>Public redistribution declaration: ${planning.sourceDeclarations.find((d) => d.sourceId === source.id)?.publicRedistribution ? "Yes" : "Not recorded"}. User declaration, not independent license verification.</p></section>`).join("")}`
    : ""
}
${
  capture.proposal.signalTimings?.length
    ? `<h3>Authored signal timing</h3><p>Durations and offsets are seconds. Movement states, sequence and clearance phases are retained. Baseline programs may be inferred; these changes do not establish field-verified timings, engineering safety, calibration or a mapping from planning-road signal edits.</p>${capture.proposal.signalTimings
        .map(
          ({ control, baseline, proposal }) =>
            `<section><h4>Controller ${esc(control.signalId)} · program ${esc(control.programId)}</h4><p>${esc(control.rationale)}</p><p>Baseline quality: ${esc(baseline.quality)}. Baseline program SHA-256 ${esc(control.baselineProgramHash)}. Sources: ${esc(baseline.sourceIds.join("; "))}.</p>${table(
              ["Timing / phase state", "Baseline seconds", "Proposal seconds"],
              [
                [
                  "Cycle",
                  baseline.phases.reduce(
                    (sum, p) => sum + p.durationSeconds,
                    0,
                  ),
                  proposal.phases.reduce(
                    (sum, p) => sum + p.durationSeconds,
                    0,
                  ),
                ],
                ["Offset", baseline.offsetSeconds, proposal.offsetSeconds],
                ...baseline.phases.map((phase, index) => [
                  `Phase ${index + 1} · ${phase.state}`,
                  phase.durationSeconds,
                  proposal.phases[index].durationSeconds,
                ]),
              ],
            )}</section>`,
        )
        .join("")}`
    : ""
}
<h3>Traffic capture sources</h3><p>These citations are separate from planning and workforce source inventories.</p>${capture.sources.map((source) => `<section><h4>${esc(source.name)}</h4><p>Source ID ${esc(source.id)} · ${esc(source.vintage)} · ${esc(source.kind)} · ${esc(source.license)}</p>${source.url ? `<p>${esc(source.url)}</p>` : ""}${source.description ? `<p>${esc(source.description)}</p>` : ""}</section>`).join("")}
${[...capture.notes, ...capture.comparison.notes, ...capture.comparison.baseline.reasons, ...capture.comparison.proposal.reasons].map((note) => `<p>${esc(note)}</p>`).join("")}
<p>Capture SHA-256 ${esc(evidence.captureHash)}. Recipe SHA-256 ${esc(capture.comparison.recipeHash)}. Archive manifest SHA-256 ${esc(capture.privateArchive.sha256)} (${capture.privateArchive.bytes} bytes; ${capture.privateArchive.fileCount} files). Hashes and receipts identify evidence but do not independently authenticate an exported or imported file. This report contains no private native graph or per-vehicle trip records.</p>
<details><summary>Exact saved traffic evidence, controls and file hashes</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(evidence, null, 2))}</pre></details>`;
}

/** Standalone browser CSV retains the entire compact capture; never fetches private raw files. */
export async function exportTrafficCSV(place: Place, scenario: Scenario) {
  const evidence = scenario.traffic;
  if (!evidence) throw new Error("This scenario has no traffic capture.");
  const status = await trafficExportStatus(place, scenario);
  const cell = (value: unknown) => {
    let s = value === null || value === undefined ? "" : String(value);
    if (
      typeof value !== "number" &&
      (/^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(s) || /^[\t\r\n]/.test(s))
    )
      s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  const capture = evidence.capture;
  const rows: unknown[][] = [
    [
      "scenario_id",
      "revision",
      "origin",
      "road_identity_stale",
      "metric_id",
      "metric",
      "unit",
      "baseline_status",
      "baseline",
      "baseline_completed_subtotal",
      "proposal_status",
      "proposal",
      "proposal_completed_subtotal",
      "delta",
      "calibration_status",
      "capture_json",
      "interpretation",
    ],
    ...measures.map(([key, label, unit]) => [
      scenario.id,
      scenario.revision,
      evidence.origin,
      status!.stale,
      key,
      label,
      unit,
      capture.comparison.baseline.status,
      capture.comparison.baseline[key],
      capture.comparison.baseline.completedSubtotal[key],
      capture.comparison.proposal.status,
      capture.comparison.proposal[key],
      capture.comparison.proposal.completedSubtotal[key],
      capture.comparison.delta[key],
      capture.calibration?.status ?? "not-assessed",
      JSON.stringify(evidence),
      trafficExportDisclosure +
        (capture.originalDemand.commute
          ? ` Census commute subset: ${capture.originalDemand.commute.coverage.status}; source estimate ${number(capture.originalDemand.commute.totals.sourceVehicles)}; supported local demand ${number(capture.originalDemand.commute.totals.admittedExpectedVehicles)}; rounded simulation vehicles ${capture.originalDemand.commute.totals.vehicles}. Unresolved source/destination ${number(capture.originalDemand.commute.totals.knownUnresolvedSourceVehicles)}; unresolved local route ${number(capture.originalDemand.commute.totals.unresolvedRouteVehicles)}. Missing trips are not redistributed; not a whole-area or all-purpose forecast. Full accounting is in capture_json.`
          : ""),
    ]),
  ];
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}

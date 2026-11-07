import type { AccessibilityCount, AccessibilityThreshold } from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { ApiError } from "./errors";

export const accessibilityReportDisclosure =
  "Jobs accessibility describes travel from the recorded origin to Census workplace block points on the captured regional network. Counts are 2023 LODES primary jobs, not vacancies, distinct employers or future job creation. Proposed roads, buildings, growth and scenario horizons are not applied. Driving and walking may use different recorded origins; neither is a baseline-to-proposal change.";
export const accessibilityUncertaintyDisclosure =
  "Partial results show a known subtotal. An upper bound adds all unresolved jobs that could fall within that time budget; it is an accounting bound, not a statistical confidence interval. Missing regional coverage leaves the upper bound unavailable. Counts use individual routed workplace points, not contour area. Block points are not verified workplace entrances and off-network access time is excluded. Earnings and industry are separate breakdowns of the same primary jobs. Travel budgets are cumulative; do not add them together.";
const number = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString("en-US");
export function accessibilityDisplayCount(count: AccessibilityCount): string {
  if (count.estimate !== null) return number(count.estimate);
  if (count.knownSubtotal === null) return "Unavailable";
  return `Subtotal ${number(count.knownSubtotal)}; upper ${number(count.upperBound)}`;
}
export function accessibilityThresholdRows(threshold: AccessibilityThreshold) {
  return [
    {
      ...threshold.total,
      family: "total",
      id: "C000",
      label: "Primary jobs",
      sourceCells: ["C000"],
    },
    ...threshold.earnings.map((row) => ({ ...row, family: "earnings" })),
    ...threshold.industries.map((row) => ({ ...row, family: "industry" })),
  ];
}

/** Frozen captures only: publication/export does not reroute or manufacture a proposal delta. */
export function accessibilityReportInventory(snapshot: ReportSnapshot) {
  return (["car", "walk"] as const).flatMap((mode) => {
    const evidence = snapshot.scenario.accessibility?.captures[mode];
    if (!evidence) return [];
    const capture = evidence.capture;
    const contextDescription = `${evidence.origin === "imported" ? "Imported evidence; not verified by this server." : "Captured analysis; original run receipt retained."} ${capture.source.region.label}. Outbound ${mode === "car" ? "driving" : "walking"} from longitude ${capture.request.site[0]}, latitude ${capture.request.site[1]}. LODES ${capture.source.lodes.year}, ${capture.source.lodes.jobType} primary jobs, ${capture.source.lodes.segment}; native ${capture.source.lodes.blockGeographyVintage} workplace blocks. Captured ${capture.capturedAt}; method ${capture.methodVersion}. Retained alongside scenario revision ${snapshot.scenario.revision}; horizon ${snapshot.scenario.horizon} years is not applied to these counts.`;
    const panels = (
      [
        { id: "total", label: "Primary jobs within reach" },
        { id: "earnings", label: "Primary jobs by monthly earnings" },
        { id: "industry", label: "Primary jobs by industry" },
      ] as const
    ).map((panel) => ({
      ...panel,
      rows: accessibilityThresholdRows(capture.thresholds[0])
        .filter((row) => row.family === panel.id)
        .map((row) => [
          row.label,
          ...capture.thresholds.map((t) =>
            accessibilityDisplayCount(
              accessibilityThresholdRows(t).find(
                (candidate) => candidate.id === row.id,
              )!,
            ),
          ),
        ]),
    }));
    const diagnostics = [
      [
        "Origin to matched network",
        `${number(capture.siteSnapMeters)} m; not a verified entrance`,
      ],
      [
        "Source inventory",
        capture.coverage.regionDataComplete ? "Complete" : "Incomplete",
      ],
      [
        "Potential catchment source coverage",
        capture.coverage.destinations.status,
      ],
      ["Potential catchment network coverage", capture.coverage.network],
      ["Workplace blocks retained", number(capture.coverage.destinationCount)],
      [
        "Blocks with zero primary jobs",
        number(capture.coverage.zeroJobDestinationCount),
      ],
      ["Primary jobs in source region", number(capture.coverage.sourceJobs)],
      ...Object.entries(capture.coverage.routeStatusCounts).map(
        ([status, count]) => [
          `Destination route status: ${status}`,
          number(count),
        ],
      ),
      ...capture.thresholds.map((t) => [
        `${t.minutes} min unresolved coverage`,
        `${number(t.total.unresolvedDestinationCount)} workplace blocks; ${number(t.total.unresolvedJobs)} primary jobs`,
      ]),
    ];
    const notes = [
      ...capture.notes,
      ...capture.network.notes,
      ...capture.coverage.destinations.notes,
      "No sampling margin of error is supplied by this method. Native block aggregation, data processing and routing introduce uncertainty beyond the displayed accounting bounds.",
      `Capture SHA-256: ${evidence.captureHash}`,
      `Full analysis artifact SHA-256: ${capture.artifactHash}`,
      `Aggregate result SHA-256: ${capture.resultHash}`,
      `Routing run SHA-256: ${capture.routingRunHash}`,
      `Request input SHA-256: ${capture.inputHash}`,
      `Jobs destination pack SHA-256: ${capture.jobsPackHash}`,
      `Network graph SHA-256: ${capture.network.graphHash}; routing profile SHA-256: ${capture.network.profileHash}`,
      `Contour archive SHA-256: ${capture.contour.sha256}. Regional contours are retained separately; this appendix contains frozen numerical evidence.`,
      "Hashes identify captured content. Their presence in an exported file does not independently authenticate the server record.",
      ...capture.files.map(
        (file) =>
          `Source file ${file.sourceId}. ${file.url}. Retrieved ${file.retrievedAt}; SHA-256 ${file.sha256}.`,
      ),
    ];
    return [
      {
        mode,
        evidence,
        capture,
        contextDescription,
        panels,
        diagnostics,
        notes,
      },
    ];
  });
}

export function requireAccessibilityReport(snapshot: ReportSnapshot) {
  const inventory = accessibilityReportInventory(snapshot);
  if (!inventory.length)
    throw new ApiError(
      422,
      "ACCESSIBILITY_ANALYSIS_REQUIRED",
      "This saved scenario has no jobs accessibility capture. Run and save an analysis first.",
    );
  return inventory;
}
export function assertAccessibilityDocumentLimit(snapshot: ReportSnapshot) {
  if (
    snapshot.scenario.accessibility &&
    new TextEncoder().encode(JSON.stringify(snapshot.scenario.accessibility))
      .byteLength > 200_000
  )
    throw new ApiError(
      413,
      "ACCESSIBILITY_REPORT_TOO_LARGE",
      "This jobs accessibility evidence is too large for a PDF or Word appendix. Export CSV, XLSX or complete saved records; no result rows have been omitted.",
    );
}

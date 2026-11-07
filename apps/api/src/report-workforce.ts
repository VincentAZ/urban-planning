import type { WorkforceCapturedCount } from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { ApiError } from "./errors";

export const workforceReportDisclosure =
  "These frozen estimates describe residents who can reach the recorded site on the captured road network. Education covers adults aged 25 and over; occupation covers civilian employed residents aged 16 and over. The two populations overlap and must not be added together. These are not counts of available applicants, vacancies, or workers at workplaces. Proposed roads, buildings, growth and future scenario horizons are not applied to this capture.";
export const workforceUncertaintyDisclosure =
  "A known subtotal includes only the resolved contribution and is not a complete catchment estimate. A conditional 90% margin of error applies only to that known contribution. Approximate sampling margins exclude spatial allocation and routing error; they are not a complete accuracy range. Missing, suppressed and unresolved contributions remain unknown. Contours are a visual aid and are not used to calculate the totals.";

const number = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function workforceDisplayCount(row: WorkforceCapturedCount) {
  return row.estimate !== null
    ? number(row.estimate)
    : row.knownSubtotal !== null
      ? `Subtotal ${number(row.knownSubtotal)}`
      : "Unavailable";
}
export function workforceDisplayMargin(row: WorkforceCapturedCount) {
  return row.marginOfError90 !== null
    ? `±${number(row.marginOfError90)}`
    : row.knownSubtotalMarginOfError90 !== null
      ? `Conditional ±${number(row.knownSubtotalMarginOfError90)}`
      : "Unavailable";
}

/** Uses the saved capture only. Export never reroutes or recomputes a new model. */
export function workforceReportInventory(snapshot: ReportSnapshot) {
  const evidence = snapshot.scenario.workforce;
  if (!evidence) return null;
  const capture = evidence.capture;
  const contextDescription = `${evidence.origin === "imported" ? "Imported evidence — not verified by this server. " : "Captured analysis. "}${capture.cohort.region.label}; site longitude ${capture.request.site[0]}, latitude ${capture.request.site[1]}; inbound ${capture.request.mode === "car" ? "car" : "walking"} travel; static network. Captured ${capture.capturedAt}; method ${capture.methodVersion}; ACS ${capture.cohort.acs.vintage} five-year estimates (${capture.cohort.acs.period.start}–${capture.cohort.acs.period.end}); 2020 block-population allocation. This report retains the capture alongside scenario revision ${snapshot.scenario.revision}, horizon ${snapshot.scenario.horizon} years.`;
  const panels = capture.panels.map((panel) => ({
    id: panel.id,
    label: panel.label,
    universe: panel.universe,
    table: panel.table,
    rows: panel.thresholds.flatMap((threshold) =>
      [
        { ...threshold.total, label: "Total population in this universe" },
        ...threshold.categories,
      ].map((row) => [
        row.label,
        `${threshold.minutes} min`,
        workforceDisplayCount(row),
        workforceDisplayMargin(row),
        row.status,
      ]),
    ),
  }));
  const coverage = capture.coverage;
  const diagnostics = [
    [
      "Site to matched network distance",
      `${number(capture.siteSnapMeters)} m; not a verified site entrance`,
    ],
    [
      "Source-region inventory",
      coverage.regionDataComplete ? "Complete" : "Incomplete",
    ],
    ["Potential catchment source coverage", coverage.cohort.status],
    ["Potential catchment network coverage", coverage.network],
    ["Native block groups", number(coverage.nativeUnits)],
    [
      "Allocation unavailable / incomplete groups",
      `${number(coverage.allocationUnavailableUnits)} / ${number(coverage.allocationIncompleteUnits)}`,
    ],
    [
      "Retained regular / ambiguous origins",
      `${number(coverage.origins)} / ${number(coverage.unallocatedOriginCount)}`,
    ],
    [
      "Population in ambiguous original blocks (2020)",
      number(coverage.unallocatedPopulation2020),
    ],
    [
      "Unrouted regular-origin allocation population (2020)",
      number(coverage.unroutedAllocationPopulation2020),
    ],
    ...Object.entries(coverage.routeStatusCounts).map(([status, count]) => [
      `Regular origins: ${status}`,
      number(count),
    ]),
  ];
  const notes = [
    evidence.origin === "imported"
      ? "Imported evidence: this server has not verified the original run or its ownership. Imported numbers and source claims are retained for review, not presented as a server-produced analysis. Run a new analysis to obtain a capture from this project's configured sources."
      : "Captured analysis: the original run receipt is retained. An exported file alone does not independently authenticate the server record.",
    ...capture.notes,
    ...capture.network.notes,
    ...coverage.cohort.notes,
    `Sampling formula: ${capture.uncertainty.formula}`,
    `Capture SHA-256: ${evidence.captureHash}`,
    `Full analysis artifact SHA-256: ${capture.artifactHash}`,
    `Aggregate result SHA-256: ${capture.resultHash}`,
    `Routing run SHA-256: ${capture.routingRunHash}`,
    `Request input SHA-256: ${capture.inputHash}`,
    `Cohort pack SHA-256: ${capture.cohortPackHash}`,
    `Network graph SHA-256: ${capture.network.graphHash}; routing profile SHA-256: ${capture.network.profileHash}`,
    `Contour archive SHA-256: ${capture.contour.sha256}. Exact regional contours are retained separately from the scenario history; this appendix presents the saved numerical evidence.`,
    "Hashes and retained job receipts identify captured evidence; their presence in an exported or imported file does not independently authenticate its origin. This report does not rerun the analysis or establish empirical calibration.",
    ...capture.files.map(
      (file) =>
        `Source file ${file.sourceId}${file.table ? ` (${file.table})` : ""}. ${file.url}. Retrieved ${file.retrievedAt}; SHA-256 ${file.sha256}.`,
    ),
  ];
  return { evidence, capture, contextDescription, panels, diagnostics, notes };
}

export function requireWorkforceReport(snapshot: ReportSnapshot) {
  const inventory = workforceReportInventory(snapshot);
  if (!inventory)
    throw new ApiError(
      422,
      "WORKFORCE_ANALYSIS_REQUIRED",
      "This saved scenario has no workforce capture. Run and save an analysis first.",
    );
  return inventory;
}

/** Reject oversized appendices explicitly; exact JSON/CSV remain available. */
export function assertWorkforceDocumentLimit(snapshot: ReportSnapshot) {
  if (
    snapshot.scenario.workforce &&
    JSON.stringify(snapshot.scenario.workforce).length > 120_000
  )
    throw new ApiError(
      413,
      "WORKFORCE_REPORT_TOO_LARGE",
      "This workforce evidence pack is too large for a PDF or Word appendix. Export CSV, XLSX or complete saved records; no result rows have been omitted.",
    );
}

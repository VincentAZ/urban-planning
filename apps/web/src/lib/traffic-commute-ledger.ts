import {
  canonicalJSON,
  trafficContentHash,
  trafficCommuteSummarySchema,
  validateTrafficCommuteSourcePack,
  validateTrafficCommuteRecipe,
  type TrafficCommuteSummary,
  type TrafficCommuteSourcePack,
  type TrafficCommutePrior,
  type TrafficCommutePriorCell,
  type TrafficCommuteFlowMass,
  type TrafficCommuteRouteSet,
} from "@urban/core";
import type {
  TrafficCommuteCompilation,
  TrafficCommuteCompilationRow,
} from "@urban/models";

export interface TrafficCommuteLedgerRow extends TrafficCommuteCompilationRow {
  homeBlockGeoid: string;
  workBlockGeoid: string;
  primaryJobs: number;
  residentPrimaryJobs: number;
  destinationShare: number;
  homeBeginSeconds: number;
  homeEndSeconds: number;
  homeTimeZone: string;
  homeUtcOffsetMinutes: number;
  localClockShiftSeconds: number;
  routeReason: string;
  sourceFileSha256: string;
  sourceRow: number;
}
export interface TrafficCommuteLedgerCell extends TrafficCommutePriorCell {
  tractName: string;
  sourceFileSha256: string;
}
export interface TrafficCommuteLedgerView {
  binding: TrafficCommuteSummary["binding"];
  sourceScope: TrafficCommuteSummary["sourceScope"];
  period: TrafficCommuteSummary["recipe"]["period"];
  totals: TrafficCommuteSummary["totals"];
  coverage: TrafficCommuteSummary["coverage"];
  cells: TrafficCommuteLedgerCell[];
  rows: TrafficCommuteLedgerRow[];
}
function invalid(detail: string): never {
  throw new Error(
    `The retained commute ledger could not be verified: ${detail}. No partial table was displayed.`,
  );
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
function sum(values: number[]) {
  let total = 0,
    correction = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) invalid("an accounting value is not finite");
    const next = total + value;
    correction +=
      Math.abs(total) >= Math.abs(value)
        ? total - next + value
        : value - next + total;
    total = next;
  }
  return total + correction;
}
function near(actual: number, expected: number, description: string) {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) >
      128 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected))
  )
    invalid(description);
}
function unique<T>(
  rows: T[],
  id: (row: T) => string,
  description: string,
): Map<string, T> {
  if (!Array.isArray(rows) || rows.length > 250000)
    invalid(`${description} exceeds the bounded record limit`);
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = id(row);
    if (!key || result.has(key))
      invalid(`${description} contains a missing or duplicate identity`);
    result.set(key, row);
  }
  return result;
}

/** Client consistency checks against an already authorized, server-verified preparation.
 * This does not revalidate route choice, native geometry or the scientific method. */
export async function readTrafficCommuteLedger(
  bytes: ArrayBuffer,
  summaryValue: TrafficCommuteSummary,
  file: { sha256: string; bytes: number },
): Promise<TrafficCommuteLedgerView> {
  if (
    bytes.byteLength !== file.bytes ||
    bytes.byteLength > 16 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    invalid("the download has a different size or identity");
  const rawHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (rawHash !== file.sha256) invalid("the download checksum changed");
  const summary = trafficCommuteSummarySchema.parse(summaryValue);
  const data = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as {
    version: number;
    sourcePack: TrafficCommuteSourcePack;
    prior: TrafficCommutePrior;
    routes: TrafficCommuteRouteSet;
    compilation: TrafficCommuteCompilation;
    manifest: { presetId: string };
  };
  if (
    data.version !== 1 ||
    !data.sourcePack ||
    !data.prior ||
    !data.routes ||
    !data.compilation
  )
    invalid("the complete normalized bundle is missing");
  const { sourcePack, prior, routes, compilation } = data;
  const binding = summary.binding;
  if (data.manifest?.presetId !== binding.presetId)
    invalid("the retained preset identity differs");
  const hashes = await Promise.all(
    [
      sourcePack,
      prior,
      routes,
      compilation,
      compilation.demand,
      prior.recipe?.period,
    ].map(trafficContentHash),
  );
  if (
    !same(hashes, [
      binding.sourcePackHash,
      binding.priorHash,
      binding.routesHash,
      binding.compilationHash,
      binding.demandHash,
      binding.periodHash,
    ])
  )
    invalid(
      "source, recipe, routes, demand or ledger identity differs from the selected preparation",
    );
  validateTrafficCommuteSourcePack(sourcePack);
  validateTrafficCommuteRecipe(prior.recipe, sourcePack);
  if (
    !same(
      {
        lodes: sourcePack.lodes,
        acs: sourcePack.acs,
        coverage: sourcePack.coverage,
      },
      summary.sourceScope,
    ) ||
    routes.regionalGraphHash !== summary.routing.regionalGraphHash ||
    routes.regionalSettingsHash !== summary.routing.regionalSettingsHash
  )
    invalid(
      "the retained source universe or regional routing identity differs",
    );
  if (
    !same(prior.recipe, summary.recipe) ||
    !same(compilation.totals, summary.totals) ||
    !same(compilation.coverage, summary.coverage) ||
    !same(compilation.conditionalAcsSampling, summary.conditionalAcsSampling) ||
    routes.localNetworkHash !== binding.networkHash ||
    routes.localInventoryHash !== binding.inventoryHash ||
    routes.sourcePackHash !== binding.sourcePackHash ||
    routes.priorHash !== binding.priorHash
  )
    invalid("the selected summary or graph differs from the complete ledger");
  const sourceFlows = unique(
    sourcePack.flows,
    (row) => row.id,
    "Source flow inventory",
  );
  const priorFlows = unique(
    prior.flows,
    (row) => row.id,
    "Prior flow/bin inventory",
  );
  const attachments = unique(
    routes.attachments,
    (row) => row.flowId,
    "Route inventory",
  );
  const ledger = unique(
    compilation.ledger,
    (row) => row.id,
    "Compiled flow/bin inventory",
  );
  const tracts = new Map(
    sourcePack.tracts.map((tract) => [tract.geoid, tract]),
  );
  const cells = [
    ...unique(
      prior.cells,
      (row) => `${row.tractGeoid}:${row.cellId}`,
      "Source cell inventory",
    ).values(),
  ];
  if (ledger.size !== priorFlows.size)
    invalid("flow/bin records were omitted or added");
  const rows: TrafficCommuteLedgerRow[] = [];
  for (const row of compilation.ledger) {
    const mass: TrafficCommuteFlowMass | undefined = priorFlows.get(row.id);
    const source = sourceFlows.get(row.flowId),
      route = attachments.get(row.flowId);
    const clock = prior.recipe.homeClocks.find(
      (value) => value.tractGeoid === row.tractGeoid,
    );
    if (
      !mass ||
      !source ||
      !route ||
      !clock ||
      mass.flowId !== row.flowId ||
      mass.tractGeoid !== row.tractGeoid ||
      mass.cellId !== row.cellId ||
      mass.homeBlockGeoid !== source.homeBlockGeoid ||
      mass.workBlockGeoid !== source.workBlockGeoid ||
      mass.primaryJobs !== source.jobs ||
      row.routeStatus !== route.status ||
      row.regionalRouteHash !== route.regionalRouteHash ||
      row.localBindingHash !== (route.local?.bindingHash ?? null)
    )
      invalid("a flow, source cell or route join is inconsistent");
    near(
      row.expectedVehicles,
      mass.expectedVehicles,
      "a source flow quantity changed",
    );
    near(
      sum([
        row.admittedExpectedVehicles,
        row.unresolvedRouteVehicles,
        row.noLocalIntersectionVehicles,
        row.beforeWindowVehicles,
        row.afterWindowVehicles,
      ]),
      row.expectedVehicles,
      "a flow does not conserve its expected vehicles",
    );
    near(
      sum([row.warmupExpectedVehicles, row.measurementExpectedVehicles]),
      row.admittedExpectedVehicles,
      "the warm-up and measurement split is inconsistent",
    );
    near(
      row.roundedVehicles - row.admittedExpectedVehicles,
      row.roundingDelta,
      "a rounding adjustment is inconsistent",
    );
    if (!Number.isSafeInteger(row.roundedVehicles) || row.roundedVehicles < 0)
      invalid("a rounded vehicle count is invalid");
    rows.push({
      ...row,
      homeBlockGeoid: source.homeBlockGeoid,
      workBlockGeoid: source.workBlockGeoid,
      primaryJobs: mass.primaryJobs,
      residentPrimaryJobs: mass.residentPrimaryJobs,
      destinationShare: mass.destinationShare,
      homeBeginSeconds: mass.homeBeginSeconds,
      homeEndSeconds: mass.homeEndSeconds,
      homeTimeZone: clock.timeZone,
      homeUtcOffsetMinutes: clock.utcOffsetMinutes,
      localClockShiftSeconds: mass.localClockShiftSeconds,
      routeReason: route.notes.join(" "),
      sourceFileSha256: source.sourceFileSha256,
      sourceRow: source.sourceRow,
    });
  }
  for (const key of [
    "unresolvedRouteVehicles",
    "noLocalIntersectionVehicles",
    "beforeWindowVehicles",
    "afterWindowVehicles",
    "admittedExpectedVehicles",
    "warmupExpectedVehicles",
    "measurementExpectedVehicles",
    "roundingDelta",
  ] as const)
    near(
      sum(rows.map((row) => row[key])),
      summary.totals[key],
      `the full ${key} total is inconsistent`,
    );
  near(
    sum(rows.map((row) => row.roundedVehicles)),
    summary.totals.vehicles,
    "the full rounded vehicle total is inconsistent",
  );
  near(
    sum(rows.map((row) => row.expectedVehicles)),
    prior.totals.allocatedVehicles,
    "known-destination flow quantities differ from source allocations",
  );
  near(
    sum(cells.map((cell) => cell.unresolvedVehicles ?? 0)),
    summary.totals.knownUnresolvedSourceVehicles,
    "unresolved source allocations are missing",
  );
  const joinedCells = cells.map((cell) => {
    const tract = tracts.get(cell.tractGeoid);
    if (
      !tract ||
      !tract.cells[cell.cellId] ||
      !same(tract.cells[cell.cellId].estimate, cell.estimate) ||
      !same(tract.cells[cell.cellId].marginOfError, cell.marginOfError)
    )
      invalid("an original source estimate or sampling margin changed");
    return {
      ...cell,
      tractName: tract.name,
      sourceFileSha256: tract.sourceFileSha256,
    };
  });
  return {
    binding,
    sourceScope: summary.sourceScope,
    period: prior.recipe.period,
    totals: summary.totals,
    coverage: summary.coverage,
    cells: joinedCells.sort((a, b) =>
      `${a.tractGeoid}:${a.cellId}`.localeCompare(
        `${b.tractGeoid}:${b.cellId}`,
        "en",
      ),
    ),
    rows: rows.sort((a, b) => a.id.localeCompare(b.id, "en")),
  };
}

function csv(rows: (string | number | boolean | null)[][]): string {
  const cell = (value: string | number | boolean | null) => {
    let text = value === null ? "" : String(value);
    if (
      typeof value === "string" &&
      /^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(text)
    )
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const result =
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
  if (new TextEncoder().encode(result).length > 64 * 1024 ** 2)
    throw new Error(
      "The complete CSV exceeds its 64 MiB export bound. No rows were omitted.",
    );
  return result;
}
/** Export all retained records, independently of the current search/filter/page. */
export function trafficCommuteLedgerCSV(
  view: TrafficCommuteLedgerView,
  kind: "flows" | "source-cells",
): string {
  const identities = [
    view.binding.presetId,
    view.binding.assetHash,
    view.binding.periodHash,
    view.sourceScope.lodes.dataYear,
    view.sourceScope.lodes.jobType,
    view.sourceScope.acs.vintage,
    view.sourceScope.acs.table,
    view.sourceScope.acs.confidenceLevel,
    view.binding.sourcePackHash,
    view.binding.priorHash,
    view.binding.routesHash,
    view.binding.compilationHash,
    view.binding.demandHash,
    view.binding.networkHash,
    view.binding.inventoryHash,
  ];
  const identityHeaders = [
    "preset_id",
    "asset_sha256",
    "period_sha256",
    "lodes_year",
    "lodes_job_type",
    "acs_five_year_vintage",
    "acs_table",
    "acs_sampling_confidence_percent",
    "source_pack_sha256",
    "prior_sha256",
    "routes_sha256",
    "compilation_sha256",
    "demand_sha256",
    "native_network_sha256",
    "native_inventory_sha256",
  ];
  if (kind === "source-cells")
    return csv([
      [
        ...identityHeaders,
        "home_acs_tract",
        "tract_name",
        "acs_cell",
        "estimate_status",
        "estimate_value",
        "estimate_raw",
        "moe_status",
        "moe_value",
        "moe_raw",
        "allocation_status",
        "resident_primary_jobs_do_not_sum_across_bins",
        "known_destination_jobs_do_not_sum_across_bins",
        "unresolved_destination_jobs_do_not_sum_across_bins",
        "allocated_expected_vehicles",
        "unresolved_expected_vehicles",
        "reason",
        "source_file_sha256",
      ],
      ...view.cells.map((cell) => [
        ...identities,
        cell.tractGeoid,
        cell.tractName,
        cell.cellId,
        cell.estimate.status,
        cell.estimate.value,
        cell.estimate.raw,
        cell.marginOfError.status,
        cell.marginOfError.value,
        cell.marginOfError.raw,
        cell.status,
        cell.residentPrimaryJobs,
        cell.knownDestinationJobs,
        cell.unresolvedDestinationJobs,
        cell.allocatedVehicles,
        cell.unresolvedVehicles,
        cell.reason,
        cell.sourceFileSha256,
      ]),
    ]);
  return csv([
    [
      ...identityHeaders,
      "flow_bin_id",
      "source_flow_id",
      "home_2020_block",
      "work_2020_block",
      "home_acs_tract",
      "acs_cell",
      "primary_jobs_do_not_sum_across_bins",
      "resident_primary_jobs_denominator_do_not_sum",
      "destination_share",
      "home_begin_seconds",
      "home_end_seconds",
      "home_time_zone",
      "home_utc_offset_minutes",
      "simulation_date",
      "local_time_zone",
      "local_utc_offset_minutes",
      "local_clock_shift_seconds",
      "source_expected_vehicles",
      "route_status",
      "route_reason",
      "local_classification",
      "local_entry_begin_seconds",
      "local_entry_end_seconds",
      "admitted_begin_seconds",
      "admitted_end_seconds",
      "admitted_expected_vehicles",
      "warmup_expected_vehicles",
      "measurement_expected_vehicles",
      "before_window_vehicles",
      "after_window_vehicles",
      "no_local_intersection_vehicles",
      "unresolved_route_vehicles",
      "rounded_vehicles",
      "rounding_delta",
      "demand_row_id",
      "regional_route_sha256",
      "local_binding_sha256",
      "source_file_sha256",
      "source_physical_row",
    ],
    ...view.rows.map((row) => [
      ...identities,
      row.id,
      row.flowId,
      row.homeBlockGeoid,
      row.workBlockGeoid,
      row.tractGeoid,
      row.cellId,
      row.primaryJobs,
      row.residentPrimaryJobs,
      row.destinationShare,
      row.homeBeginSeconds,
      row.homeEndSeconds,
      row.homeTimeZone,
      row.homeUtcOffsetMinutes,
      view.period.date,
      view.period.timeZone,
      view.period.utcOffsetMinutes,
      row.localClockShiftSeconds,
      row.expectedVehicles,
      row.routeStatus,
      row.routeReason,
      row.classification,
      row.entryBeginSeconds,
      row.entryEndSeconds,
      row.admittedBeginSeconds,
      row.admittedEndSeconds,
      row.admittedExpectedVehicles,
      row.warmupExpectedVehicles,
      row.measurementExpectedVehicles,
      row.beforeWindowVehicles,
      row.afterWindowVehicles,
      row.noLocalIntersectionVehicles,
      row.unresolvedRouteVehicles,
      row.roundedVehicles,
      row.roundingDelta,
      row.demandRowId,
      row.regionalRouteHash,
      row.localBindingHash,
      row.sourceFileSha256,
      row.sourceRow,
    ]),
  ]);
}

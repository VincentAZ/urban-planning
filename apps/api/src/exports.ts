import {
  housingReportInventory,
  requireHousingReport,
  housingReportDisclosure,
} from "./report-housing";
import { assertHousingExport } from "./housing-validation";
import {
  housingAffordabilityCSV,
  housingCostLabels,
  housingLimitLabels,
  HOUSING_INCOME_LIMIT_KEYS,
} from "@urban/core";
import {
  requireTrafficReport,
  trafficReportInventory,
  trafficReportDisclosure,
  trafficSubtotalDisclosure,
  trafficMeasures,
} from "./report-traffic";
import { ApiError } from "./errors.js";
import {
  fiscalReportInventory,
  requireFiscalReport,
  fiscalAlternatives,
  fiscalReportDisclosure,
  fiscalClockDisclosure,
} from "./report-fiscal";
import { assertFiscalExport } from "./fiscal-rights";
import { retailReportInventory, retailReportDisclosure } from "./report-retail";
import {
  requireWorkforceReport,
  workforceReportInventory,
  workforceReportDisclosure,
  workforceUncertaintyDisclosure,
} from "./report-workforce";
import {
  activityReportDisclosure,
  activityReportInventory,
} from "./report-activity";
import { buildingReportItems } from "./report-buildings";
import {
  accessibilityReportInventory,
  requireAccessibilityReport,
  accessibilityThresholdRows,
  accessibilityReportDisclosure,
  accessibilityUncertaintyDisclosure,
} from "./report-accessibility";
import {
  floodReportInventory,
  requireFloodReport,
  floodGeoJsonFeatures,
  floodReportDisclosure,
  floodUncertaintyDisclosure,
} from "./report-flood";
import {
  presentationReportDisclosure,
  presentationReportOutline,
} from "./report-presentation";
import { renderStaffPdf } from "./report-pdf";
import { renderStaffDocx } from "./report-docx";
import type { ReportMapPair } from "./report-maps";
import {
  inputNotes,
  reportSources,
  reportPlanningSources,
  reportDigest as digest,
} from "./report-content";
import ExcelJS from "exceljs";
import {
  fiscalCashFlowCSV,
  materializeBuildings,
  buildingGeometry,
  buildingAreaSqm,
  materializeRoads,
  materializeParcels,
  parcelAreaSqm,
  studyAreaSqm,
  type ModelResults,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";

export interface ReportSnapshot {
  project: Project;
  place: Place;
  scenario: Scenario;
  results: ModelResults;
  generatedAt: string;
  projectVersion?: number;
  maps?: ReportMapPair;
}
const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet programs execute formulas even when a cell was correctly CSV-quoted.
  if (
    typeof value !== "number" &&
    (/^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
  )
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
export function exportHousingCsv(snapshot: ReportSnapshot) {
  const housing = requireHousingReport(snapshot);
  return housingAffordabilityCSV(
    snapshot.scenario,
    housing.resolution,
    housing.packs,
  );
}
export function exportFiscalCsv(snapshot: ReportSnapshot) {
  const fiscal = requireFiscalReport(snapshot);
  return fiscalCashFlowCSV(fiscal.study, snapshot.scenario, fiscal.resolution);
}
export function exportFloodCsv(snapshot: ReportSnapshot) {
  const { reference, dataset, resolution } = requireFloodReport(snapshot);
  const headers = [
    "scenario_id",
    "scenario_revision",
    "side",
    "building_id",
    "mapped_status",
    "recorded_homes",
    "exposed_homes_contribution",
    "sfha_footprint_intersection_m2",
    "unclassified_footprint_m2",
    "source_zone_ids_json",
    "notes_json",
    "dataset_sha256",
    "evidence_origin",
    "source_captured_at",
    "method_version",
    "interpretation",
    "uncertainty",
  ];
  const rows = (["baseline", "scenario"] as const).flatMap((side) =>
    resolution[side].buildings.map((building) => [
      snapshot.scenario.id,
      snapshot.scenario.revision,
      side,
      building.buildingId,
      building.status,
      building.units,
      building.exposedUnits,
      building.intersectionAreaSqm,
      building.unclassifiedAreaSqm,
      JSON.stringify(building.zoneIds),
      JSON.stringify(building.notes),
      reference.datasetHash,
      reference.origin,
      dataset.capturedAt,
      resolution.methodVersion,
      floodReportDisclosure,
      floodUncertaintyDisclosure,
    ]),
  );
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function exportAccessibilityCsv(snapshot: ReportSnapshot) {
  const inventory = requireAccessibilityReport(snapshot);
  const headers = [
    "scenario_id",
    "scenario_revision",
    "scenario_horizon_years",
    "captured_at",
    "evidence_origin",
    "method_version",
    "lodes_year",
    "job_type",
    "segment",
    "block_geography_vintage",
    "mode",
    "direction",
    "origin_longitude",
    "origin_latitude",
    "origin_network_snap_meters",
    "threshold_minutes",
    "category_family",
    "category_id",
    "category",
    "source_cells",
    "status",
    "complete_estimate_primary_jobs",
    "known_subtotal_primary_jobs",
    "unresolved_destination_count",
    "unresolved_primary_jobs",
    "upper_bound_primary_jobs",
    "capture_sha256",
    "artifact_sha256",
    "result_sha256",
    "routing_run_sha256",
    "input_sha256",
    "jobs_pack_sha256",
    "network_graph_sha256",
    "routing_profile_sha256",
    "contour_sha256",
    "coverage_json",
    "sources_json",
    "source_files_json",
    "limitations",
  ];
  const rows = inventory.flatMap(({ evidence, capture }) =>
    capture.thresholds.flatMap((threshold) =>
      accessibilityThresholdRows(threshold).map((row) => [
        snapshot.scenario.id,
        snapshot.scenario.revision,
        snapshot.scenario.horizon,
        capture.capturedAt,
        evidence.origin,
        capture.methodVersion,
        capture.source.lodes.year,
        capture.source.lodes.jobType,
        capture.source.lodes.segment,
        capture.source.lodes.blockGeographyVintage,
        capture.request.mode,
        capture.request.direction,
        ...capture.request.site,
        capture.siteSnapMeters,
        threshold.minutes,
        row.family,
        row.id,
        row.label,
        row.sourceCells.join(";"),
        row.status,
        row.estimate,
        row.knownSubtotal,
        row.unresolvedDestinationCount,
        row.unresolvedJobs,
        row.upperBound,
        evidence.captureHash,
        capture.artifactHash,
        capture.resultHash,
        capture.routingRunHash,
        capture.inputHash,
        capture.jobsPackHash,
        capture.network.graphHash,
        capture.network.profileHash,
        capture.contour.sha256,
        JSON.stringify(capture.coverage),
        JSON.stringify(capture.sources),
        JSON.stringify(capture.files),
        [
          accessibilityReportDisclosure,
          accessibilityUncertaintyDisclosure,
          ...capture.notes,
        ].join(" "),
      ]),
    ),
  );
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function exportCsv(snapshot: ReportSnapshot) {
  assertFiscalExport(snapshot.project);
  housingReportInventory(snapshot);
  const headings = [
    "metric_id",
    "domain",
    "metric",
    "unit",
    "baseline",
    "scenario",
    "delta",
    "low",
    "high",
    "status",
    "method",
    "method_version",
    "scenario_id",
    "revision",
    "geography",
    "formula",
    "caveat",
    "source_ids",
    "baseline_known_subtotal",
    "scenario_known_subtotal",
    "baseline_missing_building_ids",
    "scenario_missing_building_ids",
  ];
  const rows = snapshot.results.metrics.map((m) => [
    m.id,
    m.domain,
    m.label,
    m.unit,
    m.baseline,
    m.value,
    m.delta,
    m.low,
    m.high,
    m.status,
    m.method,
    m.methodVersion,
    snapshot.scenario.id,
    m.scenarioRevision,
    m.geography,
    m.formula,
    m.caveat ?? "",
    m.sourceIds.join(";"),
    m.coverage?.baseline.knownSubtotal,
    m.coverage?.scenario.knownSubtotal,
    JSON.stringify(m.coverage?.baseline.missingBuildingIds ?? []),
    JSON.stringify(m.coverage?.scenario.missingBuildingIds ?? []),
  ]);
  return (
    "\uFEFF" +
    [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function exportRetailCsv(snapshot: ReportSnapshot) {
  const inventory = retailReportInventory(snapshot);
  if (!inventory)
    throw new ApiError(
      422,
      "RETAIL_ANALYSIS_REQUIRED",
      "This saved scenario has no retail category analysis.",
    );
  const { retail, resolved } = inventory;
  const headers = [
    "scenario_id",
    "revision",
    "geography",
    "relationship_to_study_area",
    "reference_year",
    "dollar_year",
    "currency",
    "classification",
    "classification_version",
    "evidence_horizon",
    "scenario_horizon",
    "analysis_status",
    "model_version",
    "category_id",
    "category",
    "code",
    "demand_status",
    "entered_baseline_demand_usd_year",
    "demand_source",
    "demand_note",
    "sales_status",
    "entered_baseline_sales_usd_year",
    "sales_source",
    "sales_note",
    "benchmark_status",
    "benchmark_source",
    "benchmark_note",
    "benchmark_usd_per_establishment_year",
    "scenario_demand_override_usd_year",
    "additional_capacity_usd_year",
    "capture_fraction",
    "displacement_fraction",
    "assumption_source",
    "baseline_demand_usd_year",
    "scenario_demand_usd_year",
    "baseline_sales_usd_year",
    "baseline_gap_usd_year",
    "eligible_gap_usd_year",
    "gross_capture_usd_year",
    "displaced_sales_usd_year",
    "net_new_sales_usd_year",
    "scenario_sales_usd_year",
    "scenario_gap_usd_year",
    "baseline_establishment_equivalent",
    "scenario_establishment_equivalent",
    "category_status",
    "limitations",
    "source_rights_json",
    "sources_json",
  ];
  const rows = retail.categories.map((category, index) => {
    const row = resolved.categories[index];
    return [
      snapshot.scenario.id,
      snapshot.scenario.revision,
      retail.context.geography,
      retail.context.relationshipToStudyArea,
      retail.context.referenceYear,
      retail.context.dollarYear,
      retail.context.currency,
      retail.context.classification.system,
      retail.context.classification.version,
      retail.context.horizon,
      snapshot.scenario.horizon,
      resolved.status,
      snapshot.results.modelVersion,
      category.id,
      category.name,
      category.code,
      category.baselineDemand.status,
      category.baselineDemand.value,
      category.baselineDemand.sourceId,
      category.baselineDemand.note,
      category.baselineSales.status,
      category.baselineSales.value,
      category.baselineSales.sourceId,
      category.baselineSales.note,
      category.salesPerEstablishment.status,
      category.salesPerEstablishment.sourceId,
      category.salesPerEstablishment.note,
      category.salesPerEstablishment.value,
      category.scenarioDemand,
      category.annualSalesCapacity,
      category.captureShare,
      category.displacementShare,
      category.assumptionSourceId,
      row.baselineDemand,
      row.scenarioDemand,
      row.baselineSales,
      row.baselineGap,
      row.eligibleGap,
      row.grossCapturedSales,
      row.displacedSales,
      row.netNewSales,
      row.scenarioSales,
      row.scenarioGap,
      row.baselineEstablishmentEquivalent,
      row.scenarioEstablishmentEquivalent,
      row.status,
      [retailReportDisclosure, ...resolved.warnings, ...row.warnings].join(" "),
      JSON.stringify(retail.sourceRights),
      JSON.stringify(reportPlanningSources(snapshot)),
    ];
  });
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function exportWorkforceCsv(snapshot: ReportSnapshot) {
  const { evidence, capture } = requireWorkforceReport(snapshot);
  const headers = [
    "scenario_id",
    "scenario_revision",
    "scenario_horizon_years",
    "captured_at",
    "evidence_origin",
    "method_version",
    "panel",
    "universe",
    "table",
    "threshold_minutes",
    "category_id",
    "category",
    "source_cells",
    "status",
    "complete_estimate_people",
    "known_subtotal_people",
    "complete_moe90_people",
    "conditional_subtotal_moe90_people",
    "missing_native_units",
    "suppressed_native_units",
    "unresolved_allocation_units",
    "unresolved_allocation_moe_units",
    "missing_moe_units",
    "partially_reached_units",
    "source_issue_cell_counts_json",
    "site_longitude",
    "site_latitude",
    "site_network_snap_meters",
    "mode",
    "direction",
    "capture_sha256",
    "artifact_sha256",
    "result_sha256",
    "routing_run_sha256",
    "input_sha256",
    "cohort_pack_sha256",
    "network_graph_sha256",
    "routing_profile_sha256",
    "contour_sha256",
    "coverage_json",
    "sources_json",
    "source_files_json",
    "limitations",
  ];
  const rows = capture.panels.flatMap((panel) =>
    panel.thresholds.flatMap((threshold) =>
      [
        {
          ...threshold.total,
          id: "total",
          label: "Total population in this universe",
          sourceCells: [`${panel.table}_001`],
        },
        ...threshold.categories,
      ].map((row) => [
        snapshot.scenario.id,
        snapshot.scenario.revision,
        snapshot.scenario.horizon,
        capture.capturedAt,
        evidence.origin,
        capture.methodVersion,
        panel.id,
        panel.universe,
        panel.table,
        threshold.minutes,
        row.id,
        row.label,
        row.sourceCells.join(";"),
        row.status,
        row.estimate,
        row.knownSubtotal,
        row.marginOfError90,
        row.knownSubtotalMarginOfError90,
        row.missingUnitCount,
        row.suppressedUnitCount,
        row.unresolvedAllocationUnitCount,
        row.unresolvedAllocationMoeUnitCount,
        row.missingMoeUnitCount,
        row.geographicallyPartialUnitCount,
        JSON.stringify(row.sourceIssueCellCounts),
        ...capture.request.site,
        capture.siteSnapMeters,
        capture.request.mode,
        capture.request.direction,
        evidence.captureHash,
        capture.artifactHash,
        capture.resultHash,
        capture.routingRunHash,
        capture.inputHash,
        capture.cohortPackHash,
        capture.network.graphHash,
        capture.network.profileHash,
        capture.contour.sha256,
        JSON.stringify(capture.coverage),
        JSON.stringify(capture.sources),
        JSON.stringify(capture.files),
        [
          workforceReportDisclosure,
          workforceUncertaintyDisclosure,
          ...capture.notes,
        ].join(" "),
      ]),
    ),
  );
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
/** Exact saved values; a blank cell is unavailable, never zero. No raw trip/graph data. */
export function exportTrafficCsv(snapshot: ReportSnapshot) {
  const { evidence, capture, stale, origin } = requireTrafficReport(snapshot);
  const headings = [
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
    "calibration_json",
    "baseline_diagnostics_json",
    "proposal_diagnostics_json",
    "capture_sha256",
    "baseline_hash",
    "road_edits_hash",
    "recipe_json",
    "baseline_assigned_routes_hash",
    "proposal_assigned_routes_hash",
    "private_archive_json",
    "receipt_json",
    "network_json",
    "demand_json",
    "count_evidence_json",
    "proposal_controls_and_mapping_json",
    "planning_correspondence_json",
    "planning_sources_json",
    "planning_source_declarations_json",
    "sources_json",
    "source_files_json",
    "captured_at",
    "method_version",
    "analysis_scope",
    "notes_json",
    "baseline_summary_json",
    "proposal_summary_json",
    "signal_timings_json",
  ];
  const rows = trafficMeasures.map(([key, label, unit]) => [
    snapshot.scenario.id,
    snapshot.scenario.revision,
    evidence.origin,
    stale,
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
    JSON.stringify(capture.calibration),
    JSON.stringify(capture.runs.baseline.diagnostics),
    JSON.stringify(capture.runs.proposal.diagnostics),
    evidence.captureHash,
    evidence.binding.baselineHash,
    evidence.binding.roadEditsHash,
    JSON.stringify(capture.recipe),
    capture.runs.baseline.assignedRoutesHash,
    capture.runs.proposal.assignedRoutesHash,
    JSON.stringify(capture.privateArchive),
    JSON.stringify(evidence.receipt),
    JSON.stringify(capture.network),
    JSON.stringify(capture.originalDemand),
    JSON.stringify(capture.countEvidence),
    JSON.stringify(capture.proposal),
    JSON.stringify(capture.proposal.planningRoadMapping.correspondence ?? null),
    JSON.stringify(
      capture.proposal.planningRoadMapping.correspondence?.sources ?? [],
    ),
    JSON.stringify(
      capture.proposal.planningRoadMapping.correspondence?.sourceDeclarations ??
        [],
    ),
    JSON.stringify(capture.sources),
    JSON.stringify(capture.files),
    capture.capturedAt,
    capture.methodVersion,
    capture.analysisScope,
    JSON.stringify([
      origin,
      trafficReportDisclosure,
      trafficSubtotalDisclosure,
      ...capture.notes,
      ...capture.comparison.notes,
    ]),
    JSON.stringify(capture.comparison.baseline),
    JSON.stringify(capture.comparison.proposal),
    JSON.stringify(capture.proposal.signalTimings ?? []),
  ]);
  return (
    "\uFEFF" +
    [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function exportGeoJson(snapshot: ReportSnapshot) {
  const housing = housingReportInventory(snapshot);
  const fiscal = fiscalReportInventory(snapshot);
  const flood = floodReportInventory(snapshot);
  const buildings = materializeBuildings(snapshot.place, snapshot.scenario).map(
    (b) => ({
      type: "Feature",
      id: b.id,
      geometry: buildingGeometry(b),
      properties: {
        ...b,
        featureType: "building",
        footprint: undefined,
        geometry: undefined,
        areaSqm: buildingAreaSqm(b),
        scenarioId: snapshot.scenario.id,
        scenarioRevision: snapshot.scenario.revision,
        revision: snapshot.scenario.revision,
      },
    }),
  );
  const roads = materializeRoads(snapshot.place, snapshot.scenario).map(
    (r) => ({
      type: "Feature",
      id: r.id,
      geometry: { type: "LineString", coordinates: r.coordinates },
      properties: {
        ...r,
        featureType: "road",
        coordinates: undefined,
        scenarioId: snapshot.scenario.id,
        scenarioRevision: snapshot.scenario.revision,
        revision: snapshot.scenario.revision,
      },
    }),
  );
  return {
    type: "FeatureCollection",
    name: snapshot.project.name,
    metadata: {
      placeId: snapshot.place.id,
      scenario: snapshot.scenario.name,
      scenarioId: snapshot.scenario.id,
      revision: snapshot.scenario.revision,
      generatedAt: snapshot.generatedAt,
      inputHash: digest(snapshot),
      extent: snapshot.place.extentLabel,
      sources: reportPlanningSources(snapshot),
      ...(housing
        ? {
            housing: {
              controls: housing.controls,
              incomeLimits: housing.packs,
              results: housing.resolution,
              interpretation: housingReportDisclosure,
            },
          }
        : {}),
      ...(fiscal
        ? {
            fiscalStudy: fiscal.study,
            fiscalControls: snapshot.scenario.fiscal,
            fiscalResults: fiscal.resolution,
          }
        : {}),
      ...(flood
        ? {
            flood: {
              reference: flood.reference,
              resolution: flood.resolution,
              source: {
                ...flood.dataset,
                zones: undefined,
                availability: undefined,
                panels: undefined,
                revisions: undefined,
                seclusions: undefined,
              },
              interpretation: floodReportDisclosure,
              uncertainty: floodUncertaintyDisclosure,
              geometry:
                "Every retained flood-source feature is included below, separate from planning geometry. Original source attributes remain intact.",
            },
          }
        : {}),
      ...(snapshot.scenario.traffic
        ? {
            traffic: requireTrafficReport(snapshot).evidence,
            trafficRoadIdentityStale: requireTrafficReport(snapshot).stale,
            trafficScope: trafficReportDisclosure,
          }
        : {}),
      ...(snapshot.scenario.retail
        ? {
            retail: snapshot.scenario.retail,
            retailResults: retailReportInventory(snapshot)!.resolved,
          }
        : {}),
      ...(snapshot.scenario.workforce
        ? {
            workforce: snapshot.scenario.workforce,
            workforceGeometry:
              "Regional contours are archived separately by the retained contour hash; no contour geometry is inferred from this project geometry export.",
          }
        : {}),
      ...(snapshot.scenario.accessibility
        ? {
            accessibility: snapshot.scenario.accessibility,
            accessibilityGeometry:
              "Regional outbound contours are archived separately by the retained contour hashes; project geometry does not imply the jobs catchment.",
          }
        : {}),
      ...(snapshot.scenario.activity
        ? { activity: snapshot.scenario.activity }
        : {}),
      ...(snapshot.place.vehicleAvailability
        ? { vehicleAvailability: snapshot.place.vehicleAvailability }
        : {}),
    },
    features: [
      ...(flood
        ? floodGeoJsonFeatures(flood.dataset, flood.reference.datasetHash)
        : []),
      ...(snapshot.scenario.activity?.neighborhoods ?? []).map((area) => ({
        type: "Feature",
        id: area.id,
        geometry: area.geometry,
        properties: {
          ...area,
          geometry: undefined,
          featureType: "activity-neighborhood",
          areaSqm: studyAreaSqm(area.geometry),
          boundaryStatus:
            "Authored planning allocation; not an observed Census or legal neighborhood",
          scenarioId: snapshot.scenario.id,
          scenarioRevision: snapshot.scenario.revision,
          revision: snapshot.scenario.revision,
        },
      })),
      ...buildings,
      ...roads,
      ...materializeParcels(snapshot.place, snapshot.scenario).map(
        (parcel) => ({
          type: "Feature",
          id: parcel.id,
          geometry: parcel.geometry,
          properties: {
            ...parcel,
            geometry: undefined,
            featureType: parcel.kind,
            areaSqm: parcelAreaSqm(parcel),
            boundaryStatus:
              parcel.lineage?.operation === "import"
                ? "user-supplied boundary; legal status unverified"
                : parcel.lineage
                  ? "planning proposal; not a legal subdivision"
                  : "captured source boundary; legal status unverified",
            scenarioId: snapshot.scenario.id,
            scenarioRevision: snapshot.scenario.revision,
            revision: snapshot.scenario.revision,
          },
        }),
      ),
    ],
  };
}
export function exportRecords(
  snapshot: ReportSnapshot,
  audit: unknown[],
  comments: unknown[],
  publicFeedback: unknown[] = [],
  sharing?: unknown,
) {
  assertFiscalExport(snapshot.project);
  assertHousingExport(snapshot.project);
  housingReportInventory(snapshot);
  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    inputHash: digest(snapshot),
    project: snapshot.project,
    projectVersion: snapshot.projectVersion,
    baseline: snapshot.place,
    resultBundle: snapshot.results,
    audit,
    comments,
    publicFeedback,
    sharing,
  };
}

export const exportPdf = renderStaffPdf;
export const exportDocx = renderStaffDocx;

/** Static, typed result tables; users can inspect numeric cells without recomputing a different model in Excel. */
export async function exportXlsx(snapshot: ReportSnapshot): Promise<Buffer> {
  const housing = housingReportInventory(snapshot);
  const fiscal = fiscalReportInventory(snapshot);
  const buildingItems = buildingReportItems(snapshot, "workbook");
  const presentation = presentationReportOutline(snapshot);
  const activity = activityReportInventory(snapshot);
  const retail = retailReportInventory(snapshot);
  const workforce = workforceReportInventory(snapshot);
  const accessibility = accessibilityReportInventory(snapshot);
  const flood = floodReportInventory(snapshot);
  const traffic = trafficReportInventory(snapshot);
  const book = new ExcelJS.Workbook();
  book.creator = "Urban Planning";
  book.created = new Date(snapshot.generatedAt);
  book.title = snapshot.project.name;
  book.subject = `${snapshot.scenario.name} revision ${snapshot.scenario.revision}`;
  const summary = book.addWorksheet("Read me", {
    properties: { tabColor: { argb: "FF18594E" } },
  });
  summary.columns = [
    { header: "Item", key: "item", width: 29 },
    { header: "Value", key: "value", width: 105 },
  ];
  summary.addRows([
    { item: "Project", value: snapshot.project.name },
    { item: "Scenario", value: snapshot.scenario.name },
    { item: "Revision", value: snapshot.scenario.revision },
    { item: "Forecast horizon", value: snapshot.scenario.horizon },
    { item: "Geography", value: snapshot.place.extentLabel },
    { item: "Generated at", value: snapshot.generatedAt },
    { item: "Model version", value: snapshot.results.modelVersion },
    { item: "Input SHA-256", value: digest(snapshot) },
    {
      item: "Interpretation",
      value:
        "Planning estimates. Read status, methods, assumptions, and data limitations before use. Unavailable results remain blank, not zero.",
    },
    {
      item: "Calculation behavior",
      value:
        "This workbook exports a fixed model run. Changing a cell does not rerun the application. Recalculate scenarios in Urban Planning and export a new revision.",
    },
    ...snapshot.results.warnings.map((warning, index) => ({
      item: `Limitation ${index + 1}`,
      value: warning,
    })),
  ]);
  const metrics = book.addWorksheet("Scorecard");
  metrics.columns = [
    { header: "Domain", key: "domain", width: 20 },
    { header: "Metric", key: "label", width: 38 },
    { header: "Unit", key: "unit", width: 20 },
    { header: "Baseline", key: "baseline", width: 19 },
    { header: "Scenario", key: "value", width: 19 },
    { header: "Change", key: "delta", width: 19 },
    { header: "Low", key: "low", width: 19 },
    { header: "High", key: "high", width: 19 },
    { header: "Status", key: "status", width: 15 },
    { header: "Metric ID", key: "id", width: 32 },
    { header: "Geography", key: "geography", width: 45 },
    {
      header: "Baseline known subtotal",
      key: "baselineKnownSubtotal",
      width: 25,
    },
    {
      header: "Scenario known subtotal",
      key: "scenarioKnownSubtotal",
      width: 25,
    },
    {
      header: "Missing building IDs · baseline",
      key: "baselineMissingIds",
      width: 60,
    },
    {
      header: "Missing building IDs · proposal",
      key: "scenarioMissingIds",
      width: 60,
    },
  ];
  metrics.addRows(
    snapshot.results.metrics.map((m) => ({
      domain: m.domain,
      label: m.label,
      unit: m.unit,
      baseline: m.baseline,
      value: m.value,
      delta: m.delta,
      low: m.low ?? null,
      high: m.high ?? null,
      status: m.status,
      id: m.id,
      geography: m.geography,
      baselineKnownSubtotal: m.coverage?.baseline.knownSubtotal ?? null,
      scenarioKnownSubtotal: m.coverage?.scenario.knownSubtotal ?? null,
      baselineMissingIds: JSON.stringify(
        m.coverage?.baseline.missingBuildingIds ?? [],
      ),
      scenarioMissingIds: JSON.stringify(
        m.coverage?.scenario.missingBuildingIds ?? [],
      ),
    })),
  );
  metrics.autoFilter = {
    from: "A1",
    to: `O${snapshot.results.metrics.length + 1}`,
  };
  for (let rowIndex = 2; rowIndex <= metrics.rowCount; rowIndex++)
    for (let column = 4; column <= 8; column++)
      metrics.getCell(rowIndex, column).numFmt =
        "#,##0.00;[Red](#,##0.00);0.00";
  const methods = book.addWorksheet("Methods");
  methods.columns = [
    { header: "Metric", key: "label", width: 36 },
    { header: "Method", key: "method", width: 38 },
    { header: "Version", key: "version", width: 15 },
    { header: "Formula", key: "formula", width: 85 },
    { header: "Explanation", key: "explanation", width: 85 },
    { header: "Caveat", key: "caveat", width: 85 },
    { header: "Inputs and provenance", key: "inputs", width: 100 },
    { header: "Source IDs", key: "sources", width: 40 },
  ];
  methods.addRows(
    snapshot.results.metrics.map((m) => ({
      label: m.label,
      method: m.method,
      version: m.methodVersion,
      formula: m.formula,
      explanation: m.explanation,
      caveat: m.caveat ?? "",
      inputs: inputNotes(m).join("\n"),
      sources: m.sourceIds.join("\n"),
    })),
  );
  const assumptions = book.addWorksheet("Assumptions");
  assumptions.columns = [
    { header: "Assumption", key: "name", width: 46 },
    { header: "Value", key: "value", width: 38 },
  ];
  for (const [name, value] of Object.entries(snapshot.scenario.assumptions))
    if (typeof value === "object")
      for (const [key, nested] of Object.entries(value))
        assumptions.addRow({ name: `${name}.${key}`, value: nested });
    else assumptions.addRow({ name, value });
  if (buildingItems.length) {
    const buildings = book.addWorksheet("Building programs");
    buildings.columns = [
      { header: "Scenario side", key: "side", width: 20 },
      { header: "Building", key: "name", width: 32 },
      { header: "Building ID", key: "id", width: 42 },
      { header: "Type", key: "typology", width: 22 },
      { header: "Geometry", key: "geometryType", width: 20 },
      { header: "Parts", key: "parts", width: 12 },
      { header: "Holes", key: "holes", width: 12 },
      { header: "Footprint m²", key: "footprintSqm", width: 22 },
      { header: "Gross floor area m²", key: "grossFloorAreaSqm", width: 24 },
      { header: "Common area m²", key: "commonAreaSqm", width: 22 },
      { header: "Homes", key: "units", width: 15 },
      { header: "Jobs", key: "jobs", width: 15 },
      { header: "Parking supply", key: "parkingSupply", width: 20 },
      { header: "Source reference", key: "sourceFeatureId", width: 32 },
      { header: "Sources", key: "sources", width: 65 },
      { header: "Interpretation", key: "summary", width: 90 },
      { header: "Height m", key: "height", width: 18 },
      { header: "Floors", key: "floors", width: 15 },
      {
        header: "Attribute provenance JSON",
        key: "attributeProvenance",
        width: 100,
      },
    ];
    buildings.addRows(buildingItems);
    const components = book.addWorksheet("Building components");
    components.columns = [
      { header: "Scenario side", key: "side", width: 20 },
      { header: "Building", key: "building", width: 32 },
      { header: "Building ID", key: "buildingId", width: 42 },
      { header: "Component ID", key: "id", width: 40 },
      { header: "Component", key: "name", width: 30 },
      { header: "Use / subtype", key: "use", width: 30 },
      { header: "Floor area m²", key: "grossFloorAreaSqm", width: 22 },
      { header: "Homes", key: "units", width: 15 },
      { header: "Jobs", key: "jobs", width: 15 },
      { header: "Beds", key: "beds", width: 15 },
      { header: "Trip rate / basis / source", key: "tripRate", width: 65 },
      {
        header: "Parking rate / basis / source",
        key: "parkingRate",
        width: 65,
      },
      { header: "Source IDs", key: "sourceIds", width: 45 },
    ];
    for (const item of buildingItems)
      components.addRows(
        item.components.map((component) => ({
          ...component,
          side: item.side,
          building: item.name,
          buildingId: item.id,
          sourceIds: component.sourceIds.join("; "),
        })),
      );
  }
  if (presentation) {
    summary.addRows([
      { item: "Authored presentation", value: presentation.title },
      {
        item: "Presentation interpretation",
        value: presentationReportDisclosure,
      },
    ]);
    const stops = book.addWorksheet("Presentation");
    stops.columns = [
      { header: "Stop", key: "order", width: 10 },
      { header: "Stop ID", key: "id", width: 35 },
      { header: "Title", key: "title", width: 35 },
      { header: "Authored callout", key: "callout", width: 90 },
      { header: "Presenter narration text", key: "narration", width: 90 },
      { header: "Requested view", key: "view", width: 20 },
      { header: "Center longitude", key: "longitude", width: 22 },
      { header: "Center latitude", key: "latitude", width: 22 },
      { header: "Zoom", key: "zoom", width: 15 },
      { header: "Pitch degrees", key: "pitch", width: 18 },
      { header: "Bearing degrees", key: "bearing", width: 18 },
      { header: "Metric IDs", key: "metricIds", width: 45 },
      { header: "Metric references", key: "metricReferences", width: 70 },
      { header: "Scenario ID", key: "scenarioId", width: 40 },
      { header: "Scenario revision", key: "revision", width: 20 },
    ];
    stops.addRows(
      presentation.stops.map((stop) => ({
        ...stop,
        longitude: stop.camera.center[0],
        latitude: stop.camera.center[1],
        zoom: stop.camera.zoom,
        pitch: stop.camera.pitch,
        bearing: stop.camera.bearing,
        metricIds: stop.metricIds.join("; "),
        metricReferences: stop.metricReferences.join("; "),
        scenarioId: presentation.scenarioId,
        revision: presentation.revision,
      })),
    );
  }
  if (activity) {
    summary.addRow({
      item: "Activity controls",
      value: activityReportDisclosure,
    });
    const controls = book.addWorksheet("Activity controls");
    controls.columns = [
      { header: "Count", key: "dimension", width: 30 },
      { header: "Authored target", key: "target", width: 36 },
      { header: "Captured year-zero reference", key: "reference", width: 22 },
      { header: "Reference description", key: "referenceLabel", width: 65 },
      { header: "Horizon baseline", key: "baseline", width: 20 },
      { header: "Before area overrides", key: "beforeAreas", width: 23 },
      { header: "Scenario", key: "scenario", width: 20 },
      { header: "Change", key: "delta", width: 20 },
      { header: "Allocation", key: "allocation", width: 55 },
      { header: "Source IDs", key: "sourceIds", width: 70 },
      { header: "Limitations", key: "notes", width: 90 },
    ];
    controls.addRows(activity.controls);
    const areas = book.addWorksheet("Activity areas");
    areas.columns = [
      { header: "Area ID", key: "id", width: 36 },
      { header: "Area name", key: "name", width: 38 },
      { header: "Geometry", key: "geometryType", width: 18 },
      { header: "Area m²", key: "areaSqm", width: 22 },
      { header: "Bounds west,south,east,north", key: "bounds", width: 65 },
      { header: "Population target", key: "populationTarget", width: 38 },
      { header: "Population reference", key: "populationReference", width: 23 },
      { header: "Population result", key: "population", width: 22 },
      { header: "Employment target", key: "employmentTarget", width: 38 },
      { header: "Employment reference", key: "employmentReference", width: 23 },
      { header: "Employment result", key: "employment", width: 22 },
      { header: "Source ID", key: "sourceId", width: 45 },
      { header: "Interpretation", key: "description", width: 90 },
    ];
    areas.addRows(activity.areas);
    const notes = book.addWorksheet("Activity evidence");
    notes.columns = [
      { header: "Recorded evidence and limitations", key: "note", width: 120 },
    ];
    notes.addRows(
      [activityReportDisclosure, ...activity.notes].map((note) => ({ note })),
    );
  }
  if (retail) {
    summary.addRows([
      { item: "Retail analysis", value: retail.contextDescription },
      { item: "Retail interpretation", value: retailReportDisclosure },
    ]);
    const categories = book.addWorksheet("Retail categories");
    const resultKeys = [
      "baselineDemand",
      "scenarioDemand",
      "baselineSales",
      "baselineGap",
      "eligibleGap",
      "grossCapturedSales",
      "displacedSales",
      "netNewSales",
      "scenarioSales",
      "scenarioGap",
      "baselineEstablishmentEquivalent",
      "scenarioEstablishmentEquivalent",
    ] as const;
    categories.columns = [
      { header: "Category ID", key: "id", width: 38 },
      { header: "Category", key: "name", width: 35 },
      { header: "Code", key: "code", width: 20 },
      { header: "Status", key: "status", width: 20 },
      ...resultKeys.map((key) => ({
        header: {
          baselineDemand: "Reference annual demand USD",
          scenarioDemand: "Scenario annual demand USD",
          baselineSales: "Reference annual sales USD",
          baselineGap: "Reference demand–sales gap USD",
          eligibleGap: "Eligible annual gap USD",
          grossCapturedSales: "Gross captured sales USD/year",
          displacedSales: "Displaced sales USD/year",
          netNewSales: "Net new sales USD/year",
          scenarioSales: "Scenario sales USD/year",
          scenarioGap: "Scenario demand–sales gap USD",
          baselineEstablishmentEquivalent: "Reference establishment equivalent",
          scenarioEstablishmentEquivalent: "Remaining establishment equivalent",
        }[key],
        key,
        width: 28,
      })),
      { header: "Source IDs", key: "sourceIds", width: 60 },
      { header: "Limitations", key: "warnings", width: 90 },
    ];
    categories.addRows(
      retail.resolved.categories.map((row) => ({
        ...row,
        sourceIds: row.sourceIds.join("; "),
        warnings: row.warnings.join(" "),
      })),
    );
    const inputs = book.addWorksheet("Retail inputs");
    inputs.columns = [
      { header: "Category", key: "name", width: 32 },
      { header: "Code", key: "code", width: 18 },
      { header: "Demand status", key: "demandStatus", width: 22 },
      { header: "Reference annual demand USD", key: "demand", width: 28 },
      { header: "Demand source / note", key: "demandNote", width: 80 },
      { header: "Sales status", key: "salesStatus", width: 22 },
      { header: "Reference annual sales USD", key: "sales", width: 28 },
      { header: "Sales source / note", key: "salesNote", width: 80 },
      { header: "Benchmark status", key: "benchmarkStatus", width: 22 },
      {
        header: "Annual sales per establishment USD",
        key: "benchmark",
        width: 32,
      },
      { header: "Benchmark source / note", key: "benchmarkNote", width: 80 },
      {
        header: "Scenario annual demand USD (blank = keep reference)",
        key: "scenarioDemand",
        width: 36,
      },
      {
        header: "Additional annual capacity USD",
        key: "annualSalesCapacity",
        width: 30,
      },
      { header: "Capture fraction", key: "captureShare", width: 22 },
      { header: "Displacement fraction", key: "displacementShare", width: 23 },
      { header: "Assumption source", key: "assumptionSourceId", width: 40 },
    ];
    inputs.addRows(
      retail.retail.categories.map((row) => ({
        ...row,
        demandStatus: row.baselineDemand.status,
        demand: row.baselineDemand.value,
        demandNote: [row.baselineDemand.sourceId, row.baselineDemand.note]
          .filter(Boolean)
          .join("; "),
        salesStatus: row.baselineSales.status,
        sales: row.baselineSales.value,
        salesNote: [row.baselineSales.sourceId, row.baselineSales.note]
          .filter(Boolean)
          .join("; "),
        benchmarkStatus: row.salesPerEstablishment.status,
        benchmark: row.salesPerEstablishment.value,
        benchmarkNote: [
          row.salesPerEstablishment.sourceId,
          row.salesPerEstablishment.note,
        ]
          .filter(Boolean)
          .join("; "),
      })),
    );
    const notes = book.addWorksheet("Retail evidence");
    notes.columns = [
      { header: "Context, rights and limitations", key: "note", width: 120 },
    ];
    notes.addRows(
      [retailReportDisclosure, retail.contextDescription, ...retail.notes].map(
        (note) => ({ note }),
      ),
    );
  }
  if (workforce) {
    summary.addRows([
      { item: "Workforce capture", value: workforce.contextDescription },
      {
        item: "Workforce origin",
        value:
          workforce.evidence.origin === "imported"
            ? "Imported evidence; not verified by this server"
            : "Captured analysis; receipt retained",
      },
      { item: "Workforce interpretation", value: workforceReportDisclosure },
      { item: "Workforce uncertainty", value: workforceUncertaintyDisclosure },
    ]);
    const counts = book.addWorksheet("Workforce counts");
    counts.columns = [
      { header: "Panel", key: "panel", width: 22 },
      { header: "Population universe", key: "universe", width: 44 },
      { header: "Minutes inbound", key: "minutes", width: 18 },
      { header: "Category", key: "category", width: 45 },
      { header: "Status", key: "status", width: 16 },
      { header: "Complete estimate", key: "estimate", width: 21 },
      { header: "Known subtotal", key: "knownSubtotal", width: 21 },
      { header: "Complete 90% MOE", key: "marginOfError90", width: 22 },
      {
        header: "Conditional subtotal 90% MOE",
        key: "knownSubtotalMarginOfError90",
        width: 28,
      },
      { header: "Missing units", key: "missingUnitCount", width: 18 },
      { header: "Suppressed units", key: "suppressedUnitCount", width: 19 },
      {
        header: "Unresolved allocation units",
        key: "unresolvedAllocationUnitCount",
        width: 26,
      },
      {
        header: "Unresolved MOE allocation units",
        key: "unresolvedAllocationMoeUnitCount",
        width: 28,
      },
      { header: "Missing MOE units", key: "missingMoeUnitCount", width: 20 },
      {
        header: "Partially reached units",
        key: "geographicallyPartialUnitCount",
        width: 23,
      },
      { header: "Source cells", key: "sourceCells", width: 65 },
      {
        header: "Source issue cell counts",
        key: "sourceIssueCellCounts",
        width: 65,
      },
    ];
    for (const panel of workforce.capture.panels)
      for (const threshold of panel.thresholds)
        counts.addRows(
          [
            {
              ...threshold.total,
              label: "Total population in this universe",
              sourceCells: [`${panel.table}_001`],
            },
            ...threshold.categories,
          ].map((row) => ({
            ...row,
            panel: panel.label,
            universe: panel.universe,
            minutes: threshold.minutes,
            category: row.label,
            sourceCells: row.sourceCells.join(";"),
            sourceIssueCellCounts: JSON.stringify(row.sourceIssueCellCounts),
          })),
        );
    for (const key of [
      "estimate",
      "knownSubtotal",
      "marginOfError90",
      "knownSubtotalMarginOfError90",
    ])
      counts.getColumn(key).numFmt = "#,##0.0";
    const evidence = book.addWorksheet("Workforce evidence");
    evidence.columns = [
      { header: "Evidence", key: "item", width: 48 },
      { header: "Value or disclosure", key: "value", width: 120 },
    ];
    evidence.addRows([
      { item: "Capture context", value: workforce.contextDescription },
      ...workforce.diagnostics.map(([item, value]) => ({ item, value })),
      ...[
        workforceReportDisclosure,
        workforceUncertaintyDisclosure,
        ...workforce.notes,
      ].map((value) => ({ item: "Provenance and limitations", value })),
    ]);
  }
  if (accessibility.length) {
    const counts = book.addWorksheet("Jobs accessibility");
    counts.columns = [
      { header: "Mode", key: "mode", width: 12 },
      { header: "Minutes outbound", key: "minutes", width: 18 },
      { header: "Category family", key: "family", width: 18 },
      { header: "Category", key: "category", width: 55 },
      { header: "Status", key: "status", width: 16 },
      { header: "Complete primary jobs", key: "estimate", width: 24 },
      { header: "Known subtotal jobs", key: "knownSubtotal", width: 24 },
      {
        header: "Unresolved blocks",
        key: "unresolvedDestinationCount",
        width: 22,
      },
      { header: "Unresolved jobs", key: "unresolvedJobs", width: 21 },
      { header: "Upper bound jobs", key: "upperBound", width: 21 },
      { header: "Source cells", key: "sourceCells", width: 25 },
      { header: "Origin longitude", key: "longitude", width: 23 },
      { header: "Origin latitude", key: "latitude", width: 23 },
      { header: "Capture SHA-256", key: "captureHash", width: 72 },
    ];
    const evidenceSheet = book.addWorksheet("Jobs access evidence");
    evidenceSheet.columns = [
      { header: "Mode", key: "mode", width: 12 },
      { header: "Evidence", key: "item", width: 48 },
      { header: "Value or disclosure", key: "value", width: 120 },
    ];
    for (const item of accessibility) {
      summary.addRows([
        {
          item: `Jobs accessibility ${item.mode}`,
          value: item.contextDescription,
        },
        {
          item: "Jobs accessibility interpretation",
          value: accessibilityReportDisclosure,
        },
        {
          item: "Jobs accessibility uncertainty",
          value: accessibilityUncertaintyDisclosure,
        },
      ]);
      for (const threshold of item.capture.thresholds)
        counts.addRows(
          accessibilityThresholdRows(threshold).map((row) => ({
            ...row,
            mode: item.mode,
            minutes: threshold.minutes,
            category: row.label,
            sourceCells: row.sourceCells.join(";"),
            longitude: item.capture.request.site[0],
            latitude: item.capture.request.site[1],
            captureHash: item.evidence.captureHash,
          })),
        );
      evidenceSheet.addRows([
        {
          mode: item.mode,
          item: "Capture context",
          value: item.contextDescription,
        },
        ...item.diagnostics.map(([name, value]) => ({
          mode: item.mode,
          item: name,
          value,
        })),
        ...[
          accessibilityReportDisclosure,
          accessibilityUncertaintyDisclosure,
          ...item.notes,
        ].map((value) => ({
          mode: item.mode,
          item: "Provenance and limitations",
          value,
        })),
      ]);
    }
    for (const key of [
      "estimate",
      "knownSubtotal",
      "unresolvedDestinationCount",
      "unresolvedJobs",
      "upperBound",
    ])
      counts.getColumn(key).numFmt = "#,##0";
  }
  if (flood) {
    const evidenceJson = (value: unknown[]) => {
      const json = JSON.stringify(value);
      return json.length <= 16000
        ? json
        : `${value.length} entries; complete value is retained in the exact exposure resolution JSON on Flood evidence. This cell is a pointer, not a truncated list.`;
    };
    const counts = book.addWorksheet("Flood building ledger");
    counts.columns = [
      { header: "Side", key: "side", width: 12 },
      { header: "Building ID", key: "buildingId", width: 38 },
      { header: "Mapped status", key: "status", width: 28 },
      { header: "Recorded homes", key: "units", width: 20 },
      { header: "Exposed homes contribution", key: "exposedUnits", width: 28 },
      {
        header: "SFHA footprint intersection m²",
        key: "intersectionAreaSqm",
        width: 30,
      },
      {
        header: "Unclassified footprint m²",
        key: "unclassifiedAreaSqm",
        width: 27,
      },
      { header: "Source zone IDs · JSON", key: "zoneIds", width: 70 },
      { header: "Notes · JSON", key: "notes", width: 110 },
      { header: "Dataset SHA-256", key: "datasetHash", width: 72 },
    ];
    for (const side of ["baseline", "scenario"] as const)
      for (const row of flood.resolution[side].buildings)
        counts.addRow({
          ...row,
          side,
          zoneIds: evidenceJson(row.zoneIds),
          notes: evidenceJson(row.notes),
          datasetHash: flood.reference.datasetHash,
        });
    const totals = book.addWorksheet("Flood summary");
    totals.columns = [
      { header: "Side", key: "side", width: 14 },
      { header: "Complete exposed homes", key: "value", width: 27 },
      { header: "Known subtotal homes", key: "knownSubtotal", width: 26 },
      { header: "Missing-home IDs · JSON", key: "missing", width: 80 },
      { header: "Unclassified IDs · JSON", key: "unclassified", width: 80 },
    ];
    for (const side of ["baseline", "scenario"] as const) {
      const result = flood.resolution[side];
      totals.addRow({
        side,
        value: result.value,
        knownSubtotal: result.knownSubtotal,
        missing: evidenceJson(result.missingUnitBuildingIds),
        unclassified: evidenceJson(result.unclassifiedBuildingIds),
      });
    }
    const source = book.addWorksheet("Flood evidence");
    source.columns = [
      { header: "Section", key: "section", width: 40 },
      { header: "Part", key: "part", width: 9 },
      { header: "Text · concatenate parts in order", key: "text", width: 120 },
    ];
    const text = (section: string, value: string) => {
      // Split by Unicode code points so a source character is never corrupted at a cell boundary.
      const points = Array.from(value);
      for (
        let start = 0, part = 1;
        start < points.length;
        start += 8000, part++
      )
        source.addRow({
          section,
          part,
          text: points.slice(start, start + 8000).join(""),
        });
    };
    text("Capture context", flood.contextDescription);
    text("Interpretation", floodReportDisclosure);
    text("Uncertainty", floodUncertaintyDisclosure);
    text("Diagnostics", JSON.stringify(flood.diagnostics));
    text("Dates", JSON.stringify(flood.mapDates));
    text("Notes", JSON.stringify(flood.notes));
    text("Exact selected source dataset JSON", JSON.stringify(flood.dataset));
    text("Exact exposure resolution JSON", JSON.stringify(flood.resolution));
    summary.addRows([
      { item: "Flood source", value: flood.contextDescription },
      { item: "Flood interpretation", value: floodReportDisclosure },
      { item: "Flood uncertainty", value: floodUncertaintyDisclosure },
    ]);
  }
  if (traffic) {
    summary.addRows([
      { item: "Traffic capture", value: traffic.contextDescription },
      { item: "Traffic road identity", value: traffic.freshness },
      { item: "Traffic interpretation", value: trafficReportDisclosure },
    ]);
    const sheet = book.addWorksheet("Traffic outcomes");
    sheet.columns = [
      { header: "Metric", key: "metric", width: 36 },
      { header: "Unit", key: "unit", width: 20 },
      { header: "Baseline status", key: "baselineStatus", width: 18 },
      { header: "Baseline", key: "baseline", width: 20 },
      {
        header: "Baseline completed subtotal",
        key: "baselineSubtotal",
        width: 28,
      },
      { header: "Proposal status", key: "proposalStatus", width: 18 },
      { header: "Proposal", key: "proposal", width: 20 },
      {
        header: "Proposal completed subtotal",
        key: "proposalSubtotal",
        width: 28,
      },
      { header: "Change", key: "delta", width: 20 },
    ];
    sheet.addRows(
      trafficMeasures.map(([key, label, unit]) => ({
        metric: label,
        unit,
        baselineStatus: traffic.capture.comparison.baseline.status,
        baseline: traffic.capture.comparison.baseline[key],
        baselineSubtotal:
          traffic.capture.comparison.baseline.completedSubtotal[key],
        proposalStatus: traffic.capture.comparison.proposal.status,
        proposal: traffic.capture.comparison.proposal[key],
        proposalSubtotal:
          traffic.capture.comparison.proposal.completedSubtotal[key],
        delta: traffic.capture.comparison.delta[key],
      })),
    );
    if (traffic.signalTimingRows.length) {
      const timing = book.addWorksheet("Signal timing");
      timing.columns = [
        { header: "Controller", width: 35 },
        { header: "Program / phase", width: 55 },
        { header: "Baseline seconds", width: 22 },
        { header: "Proposal seconds", width: 22 },
      ];
      timing.addRows(
        traffic.signalTimingRows.map(([controller, phase, before, after]) => [
          controller,
          phase,
          Number(before),
          Number(after),
        ]),
      );
    }
    const notes = book.addWorksheet("Traffic evidence");
    notes.columns = [
      { header: "Section", key: "section", width: 36 },
      { header: "Part", key: "part", width: 10 },
      {
        header: "Recorded text · concatenate JSON parts in order",
        key: "text",
        width: 120,
      },
    ];
    [
      trafficReportDisclosure,
      trafficSubtotalDisclosure,
      traffic.contextDescription,
      traffic.freshness,
      ...traffic.notes,
    ].forEach((text) => {
      for (let start = 0, part = 1; start < text.length; start += 16000, part++)
        notes.addRow({
          section: "Context and provenance",
          part,
          text: text.slice(start, start + 16000),
        });
    });
    const json = JSON.stringify(traffic.evidence);
    for (let start = 0, part = 1; start < json.length; start += 16000, part++)
      notes.addRow({
        section: "Exact saved traffic JSON",
        part,
        text: json.slice(start, start + 16000),
      });
  }
  if (fiscal) {
    const summary = book.addWorksheet("Fiscal comparison");
    summary.columns = [
      { header: "Case", key: "case", width: 30 },
      { header: "Alternative", key: "alternative", width: 34 },
      { header: "20-year net incl time zero · USD", key: "net", width: 27 },
      { header: "NPV at horizon start · USD", key: "npv", width: 27 },
      { header: "Payback outcome", key: "payback", width: 22 },
      { header: "Payback year", key: "paybackYear", width: 18 },
      { header: "Case status", key: "status", width: 18 },
    ];
    const annual = book.addWorksheet("Fiscal annual flows");
    annual.columns = [
      { header: "Case ID", key: "caseId", width: 25 },
      { header: "Case", key: "case", width: 30 },
      { header: "Alternative", key: "alternative", width: 34 },
      { header: "Year · 0 = upfront", key: "year", width: 18 },
      { header: "Fiscal year", key: "fiscalYear", width: 16 },
      ...[
        "propertyRevenue",
        "salesRevenue",
        "serviceCost",
        "abatementCost",
        "grantCost",
        "netRevenue",
        "discountedNet",
      ].map((key) => ({ header: `${key} · USD`, key, width: 23 })),
    ];
    const inputs = book.addWorksheet("Fiscal case inputs");
    inputs.columns = [
      { header: "Case", key: "case", width: 30 },
      { header: "Parameter", key: "parameter", width: 40 },
      { header: "Baseline", key: "baseline", width: 24 },
      { header: "Proposal", key: "proposal", width: 24 },
    ];
    for (const c of fiscal.cases) {
      for (const [key, label] of fiscalAlternatives) {
        summary.addRow({
          case: c.name,
          alternative: label,
          net: c[key].totals.netRevenue,
          npv: c[key].totals.npv,
          status: c.status,
        });
        for (const row of c[key].rows)
          annual.addRow({
            caseId: c.id,
            case: c.name,
            alternative: label,
            ...row,
          });
      }
      for (const key of ["withoutOffer", "withOffer"] as const) {
        const label =
          key === "withOffer"
            ? "Incremental with offer"
            : "Incremental without offer";
        summary.addRow({
          case: c.name,
          alternative: label,
          net: c.incremental[key].netRevenue,
          npv: c.incremental[key].npv,
          payback: key === "withOffer" ? c.payback.status : null,
          paybackYear: key === "withOffer" ? c.payback.year : null,
          status: c.status,
        });
        for (const row of c.incremental[key].rows)
          annual.addRow({
            caseId: c.id,
            case: c.name,
            alternative: label,
            ...row,
          });
      }
      for (const key of Object.keys(
        c.assumptions.baseline,
      ) as (keyof typeof c.assumptions.baseline)[]) {
        const value = (v: unknown) =>
          typeof v === "object" ? JSON.stringify(v) : v;
        inputs.addRow({
          case: c.name,
          parameter: key,
          baseline: value(c.assumptions.baseline[key]),
          proposal: value(c.assumptions.proposal[key]),
        });
      }
    }
    const evidence = book.addWorksheet("Fiscal evidence");
    evidence.columns = [
      { header: "Section", key: "section", width: 32 },
      { header: "Part", key: "part", width: 9 },
      { header: "Text · join parts in order", key: "text", width: 110 },
    ];
    const addText = (section: string, text: string) => {
      for (let start = 0, part = 1; start < text.length; start += 16000, part++)
        evidence.addRow({
          section,
          part,
          text: text.slice(start, start + 16000),
        });
    };
    addText("Interpretation", fiscalReportDisclosure);
    addText("Cash-flow clock", fiscalClockDisclosure);
    fiscal.context.forEach((note, i) => addText(`Context ${i + 1}`, note));
    fiscal.parameterNotes.forEach((note, i) =>
      addText(`Coefficient ${i + 1}`, note),
    );
    addText("Exact fiscal study JSON", JSON.stringify(fiscal.study));
    addText(
      "Exact fiscal controls JSON",
      JSON.stringify(snapshot.scenario.fiscal ?? null),
    );
    addText(
      "Exact frozen fiscal results JSON",
      JSON.stringify(fiscal.resolution),
    );
    for (const column of [3, 4])
      summary.getColumn(column).numFmt = "#,##0.00;[Red]-#,##0.00";
    for (const column of [6, 7, 8, 9, 10, 11, 12])
      annual.getColumn(column).numFmt = "#,##0.00;[Red]-#,##0.00";
  }
  if (housing) {
    const comparison = book.addWorksheet("Housing comparison");
    comparison.columns = [
      { header: "Income ceiling", key: "ceiling", width: 32 },
      { header: "Baseline homes", key: "baseline", width: 20 },
      { header: "Proposal homes", key: "proposal", width: 20 },
      { header: "Change", key: "delta", width: 18 },
      { header: "Baseline known subtotal", key: "baselineKnown", width: 26 },
      { header: "Proposal known subtotal", key: "proposalKnown", width: 26 },
    ];
    for (const key of HOUSING_INCOME_LIMIT_KEYS)
      comparison.addRow({
        ceiling: housingLimitLabels[key],
        baseline: housing.resolution.baseline.cumulative[key].estimate,
        proposal: housing.resolution.proposal.cumulative[key].estimate,
        delta: housing.resolution.delta[key],
        baselineKnown:
          housing.resolution.baseline.cumulative[key].knownSubtotal,
        proposalKnown:
          housing.resolution.proposal.cumulative[key].knownSubtotal,
      });
    const bands = book.addWorksheet("Housing exclusive bands");
    bands.columns = comparison.columns.map((c) => ({
      header: c.header as string,
      key: c.key,
      width: c.width,
    }));
    for (const key of [...HOUSING_INCOME_LIMIT_KEYS, "above-low"] as const) {
      const b = housing.resolution.baseline.bands[key],
        p = housing.resolution.proposal.bands[key];
      bands.addRow({
        ceiling:
          key === "above-low"
            ? "Above the low income ceiling"
            : housingLimitLabels[key],
        baseline: b.estimate,
        proposal: p.estimate,
        delta:
          b.estimate === null || p.estimate === null
            ? null
            : p.estimate - b.estimate,
        baselineKnown: b.knownSubtotal,
        proposalKnown: p.knownSubtotal,
      });
    }
    const coverage = book.addWorksheet("Housing coverage");
    coverage.columns = [
      { header: "Side", key: "side", width: 18 },
      { header: "Total homes", key: "totalUnits", width: 18 },
      { header: "Known homes", key: "knownUnits", width: 18 },
      { header: "Assigned homes", key: "assignedUnits", width: 18 },
      { header: "Evaluated homes", key: "evaluatedUnits", width: 18 },
      { header: "Unassigned homes", key: "unassignedUnits", width: 22 },
      {
        header: "Unresolved assigned homes",
        key: "unresolvedAssignedUnits",
        width: 28,
      },
    ];
    for (const side of ["baseline", "proposal"] as const)
      coverage.addRow({ side, ...housing.resolution[side] });
    const groups = book.addWorksheet("Housing cost groups");
    groups.columns = [
      { header: "Side", key: "side", width: 16 },
      { header: "Group", key: "groupId", width: 30 },
      { header: "Building", key: "buildingId", width: 30 },
      { header: "Program component", key: "componentId", width: 28 },
      { header: "Homes", key: "units", width: 12 },
      { header: "Tenure", key: "tenure", width: 14 },
      { header: "Household size", key: "householdSize", width: 18 },
      { header: "Cost year", key: "costYear", width: 14 },
      { header: "Status", key: "status", width: 18 },
      { header: "Complete monthly cost · USD", key: "gross", width: 29 },
      { header: "Known monthly cost · USD", key: "known", width: 29 },
      { header: "Required annual income · USD", key: "income", width: 30 },
      { header: "HUD area", key: "areaName", width: 45 },
      { header: "HUD fiscal year", key: "fiscalYear", width: 18 },
      { header: "Area source origin", key: "origin", width: 24 },
      { header: "Income-limit pack SHA-256", key: "areaHash", width: 68 },
      { header: "Minimum ceiling band", key: "minimumBand", width: 25 },
    ];
    const costs = book.addWorksheet("Housing cost components");
    costs.columns = [
      { header: "Side", key: "side", width: 16 },
      { header: "Group", key: "group", width: 30 },
      { header: "Component ID", key: "id", width: 28 },
      { header: "Cost component", key: "label", width: 32 },
      { header: "State", key: "state", width: 20 },
      { header: "Separate monthly USD", key: "monthlyUsd", width: 25 },
      { header: "Included in component", key: "includedIn", width: 28 },
      { header: "Evidence type", key: "kind", width: 18 },
      { header: "Evidence description", key: "description", width: 75 },
      { header: "Source IDs", key: "sourceIds", width: 55 },
    ];
    for (const panel of housing.panels) {
      const r = panel.row;
      groups.addRow({
        ...r,
        side: panel.side,
        origin: panel.group.areaOrigin,
        gross: r.grossMonthlyCents === null ? null : r.grossMonthlyCents / 100,
        known: r.knownMonthlyCents / 100,
        income: r.requiredAnnualIncome,
      });
      for (const c of panel.group.costs)
        costs.addRow({
          side: panel.side,
          group: panel.group.id,
          id: c.id,
          label: housingCostLabels[c.kind],
          state: c.state,
          monthlyUsd: c.state === "separate" ? c.monthlyCents / 100 : null,
          includedIn: c.state === "included" ? c.includedIn : "",
          ...c.provenance,
          sourceIds: c.provenance.sourceIds.join(", "),
        });
    }
    const limits = book.addWorksheet("HUD household limits");
    limits.columns = [
      { header: "Area", key: "area", width: 45 },
      { header: "Fiscal year", key: "year", width: 14 },
      { header: "Effective date", key: "effective", width: 18 },
      { header: "Household size", key: "householdSize", width: 18 },
      { header: "Extremely low · annual USD", key: "extremelyLow", width: 29 },
      { header: "Very low · annual USD", key: "veryLow", width: 26 },
      { header: "Low · annual USD", key: "low", width: 24 },
      { header: "Pack SHA-256", key: "hash", width: 68 },
    ];
    for (const [hash, pack] of Object.entries(housing.packs))
      for (const limit of pack.limits)
        limits.addRow({
          area: pack.area.name,
          year: pack.fiscalYear,
          effective: pack.effectiveDate,
          ...limit,
          hash,
        });
    const evidence = book.addWorksheet("Housing evidence");
    evidence.columns = [
      { header: "Section", key: "section", width: 34 },
      { header: "Part", key: "part", width: 9 },
      { header: "Text · join parts in order", key: "text", width: 110 },
    ];
    const addText = (section: string, text: string) => {
      for (let start = 0, part = 1; start < text.length; start += 16000, part++)
        evidence.addRow({
          section,
          part,
          text: text.slice(start, start + 16000),
        });
    };
    addText("Interpretation", housingReportDisclosure);
    housing.context.forEach((note, i) => addText(`Context ${i + 1}`, note));
    addText("Exact housing controls JSON", JSON.stringify(housing.controls));
    addText("Exact income-limit packs JSON", JSON.stringify(housing.packs));
    addText(
      "Exact frozen housing results JSON",
      JSON.stringify(housing.resolution),
    );
    for (const col of [10, 11, 12])
      groups.getColumn(col).numFmt = "#,##0.00;[Red]-#,##0.00";
    costs.getColumn(6).numFmt = "#,##0.00;[Red]-#,##0.00";
    for (const col of [5, 6, 7])
      limits.getColumn(col).numFmt = "#,##0;[Red]-#,##0";
  }
  const sources = book.addWorksheet("Sources");
  sources.columns = [
    { header: "Source ID", key: "id", width: 38 },
    { header: "Publisher / source", key: "name", width: 40 },
    { header: "Vintage", key: "vintage", width: 20 },
    { header: "Evidence type", key: "kind", width: 20 },
    { header: "License", key: "license", width: 65 },
    { header: "URL", key: "url", width: 75 },
    { header: "Description", key: "description", width: 90 },
  ];
  sources.addRows(reportSources(snapshot));
  const importSources = reportSources(snapshot).filter(
    (source) => source.import || source.rights,
  );
  if (importSources.length) {
    const inventory = book.addWorksheet("Import provenance");
    inventory.columns = [
      { header: "Source ID", key: "sourceId", width: 38 },
      { header: "Section", key: "section", width: 24 },
      { header: "Part", key: "part", width: 10 },
      {
        header: "JSON text · concatenate parts in order",
        key: "text",
        width: 120,
      },
    ];
    for (const source of importSources)
      for (const section of ["import", "rights"] as const) {
        if (!source[section]) continue;
        const json = JSON.stringify(source[section]);
        for (
          let start = 0, part = 1;
          start < json.length;
          start += 16000, part++
        )
          inventory.addRow({
            sourceId: source.id,
            section,
            part,
            text: json.slice(start, start + 16000),
          });
      }
  }

  for (const sheet of book.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.pageSetup = {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
    sheet.properties.defaultRowHeight = 24;
    sheet.getRow(1).height = 30;
    sheet.getRow(1).eachCell((cell) => {
      cell.font = {
        name: "Arial",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF18594E" },
      };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      let lines = 1;
      row.eachCell((cell, column) => {
        cell.font = { name: "Arial", size: 10, color: { argb: "FF263F36" } };
        cell.alignment = { vertical: "top", wrapText: true };
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFDCE4DD" } },
        };
        if (index % 2 === 0)
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF2F5EF" },
          };
        const width = sheet.getColumn(column).width ?? 20;
        const count = String(cell.value ?? "")
          .split("\n")
          .reduce(
            (sum, line) =>
              sum + Math.max(1, Math.ceil(line.length / (width * 0.9))),
            0,
          );
        lines = Math.max(lines, count);
      });
      row.height = Math.min(409, Math.max(24, lines * 14 + 10));
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

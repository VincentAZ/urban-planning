import { createHash } from "node:crypto";
import {
  canonicalJSON,
  type FloodAttributes,
  type FloodDataset,
} from "@urban/core";
import { resolveFloodExposure } from "@urban/models";
import type { ReportSnapshot } from "./exports";
import { ApiError } from "./errors";

export const floodReportDisclosure =
  "Mapped flood exposure is a building-footprint screen using the same retained FEMA effective National Flood Hazard Layer for the baseline and proposal. A positive-area intersection with any Special Flood Hazard Area (SFHA) counts all known homes in that building once. Footprint overlap area does not locate individual homes or allocate a fraction of them. Boundary-only contact does not count. The result is not predicted flooding, damage, insurance eligibility or a regulatory determination.";
export const floodUncertaintyDisclosure =
  "A known subtotal excludes unresolved exposure or missing home counts and is not a complete total. Zone D, unclassified geometry and missing map coverage are not treated as safe. No SFHA intersection is a statement about the captured map, not an absence of flood risk. Buildings proven to have zero homes contribute zero; a building with unknown homes can also contribute zero when its entire footprint is classified and has no SFHA intersection. Scenario horizons do not update this map or multiply physical building home counts.";
const number = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString("en-US");
const date = (value: string | number | null | undefined) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return value === null || value === undefined ? "Not supplied" : String(value);
};
const field = (attributes: FloodAttributes, names: string[]) => {
  for (const key of names)
    if (attributes[key] !== undefined && attributes[key] !== null)
      return attributes[key];
  return null;
};

/** Recompute from the frozen source geometry and exact report buildings; never accept a supplied scalar. */
export function floodReportInventory(snapshot: ReportSnapshot) {
  const reference = snapshot.scenario.flood;
  if (!reference) return null;
  const dataset = snapshot.project.floodDatasets?.[reference.datasetHash];
  if (
    !dataset ||
    createHash("sha256").update(canonicalJSON(dataset)).digest("hex") !==
      reference.datasetHash
  )
    throw new ApiError(
      422,
      "FLOOD_DATASET_UNAVAILABLE",
      "The report's flood reference has no matching immutable dataset. Restore its complete saved records before exporting.",
    );
  const resolution = resolveFloodExposure(snapshot.place, snapshot.scenario, {
    floodDatasets: snapshot.project.floodDatasets,
  });
  const contextDescription = `${reference.origin === "imported" ? "Imported evidence; source claims are not verified by this server." : "Retained public source catalog capture; this is not an independent accuracy certification."} Captured ${dataset.capturedAt}. Dataset SHA-256 ${reference.datasetHash}. Method ${resolution.methodVersion}; scenario revision ${snapshot.scenario.revision}. Panel effective dates, map revisions and database revision dates are distinct and are retained below.`;
  const sides = [resolution.baseline, resolution.scenario];
  const summaryRows = [
    [
      "Homes in intersecting buildings · complete total",
      ...sides.map((s) => number(s.value)),
    ],
    [
      "Known subtotal · not a complete total where unresolved",
      ...sides.map((s) => number(s.knownSubtotal)),
    ],
    [
      "Buildings with positive-area SFHA intersection",
      ...sides.map((s) =>
        number(
          s.buildings.filter((b) => b.status === "intersects-sfha").length,
        ),
      ),
    ],
    [
      "Buildings with undetermined map intersection",
      ...sides.map((s) =>
        number(s.buildings.filter((b) => b.status === "undetermined").length),
      ),
    ],
    [
      "Buildings with unresolved home counts affecting total",
      ...sides.map((s) => number(s.missingUnitBuildingIds.length)),
    ],
    [
      "Buildings with unclassified coverage affecting total",
      ...sides.map((s) => number(s.unclassifiedBuildingIds.length)),
    ],
    [
      "All retained building rows",
      ...sides.map((s) => number(s.buildings.length)),
    ],
  ];
  const zoneRows = dataset.zones.map((zone) => [
    zone.id,
    `${zone.attributes.FLD_ZONE ?? "Not supplied"}${zone.attributes.ZONE_SUBTY ? ` · ${zone.attributes.ZONE_SUBTY}` : ""}`,
    zone.classification === "sfha"
      ? "SFHA"
      : zone.classification === "other-mapped"
        ? "Other mapped classification"
        : "Undetermined",
    zone.attributes.SOURCE_CIT ?? "Not supplied",
  ]);
  const mapDates = [
    ...dataset.panels.map((panel) => [
      "Effective panel",
      String(
        field(panel.attributes, ["FIRM_PAN", "PANEL", "PANEL_ID"]) ?? panel.id,
      ),
      date(field(panel.attributes, ["EFF_DATE", "EFFECTIVE"])),
    ]),
    ...dataset.revisions.map((revision) => [
      "Map revision",
      String(
        field(revision.attributes, ["CASE_NO", "CASE_NUM"]) ?? revision.id,
      ),
      date(field(revision.attributes, ["EFF_DATE", "EFFECTIVE"])),
    ]),
    ...dataset.capture.studyInfo.flatMap((study) => [
      [
        "Study database revision",
        String(study.DFIRM_ID ?? "Not supplied"),
        date(field(study, ["DBREV_DT", "DBREV_DATE"])),
      ],
      [
        "Study index effective date",
        String(study.DFIRM_ID ?? "Not supplied"),
        date(field(study, ["INDX_EFFDT", "EFF_DATE"])),
      ],
    ]),
  ];
  const diagnostics = [
    ["Resolution status", resolution.status],
    ["Retained classified-zone features", number(dataset.zones.length)],
    ["Availability polygons", number(dataset.availability.length)],
    ["Effective panel polygons", number(dataset.panels.length)],
    ["Map revision polygons", number(dataset.revisions.length)],
    ["Seclusion polygons", number(dataset.seclusions.length)],
    [
      "Captured source request completeness",
      dataset.capture.complete
        ? "Complete under retained checks; not a guarantee of classified geographic coverage"
        : "Incomplete",
    ],
    [
      "Normalization",
      `${dataset.capture.normalization.methodVersion}; ${dataset.capture.normalization.crs}; clipped to captured study boundary`,
    ],
    ["Study boundary SHA-256", dataset.studyAreaHash],
    ["Capture query geometry SHA-256", dataset.capture.queryGeometryHash],
  ];
  const notes = [
    ...(resolution.error
      ? [`Exposure calculation unavailable: ${resolution.error}`]
      : []),
    ...resolution.warnings,
    ...dataset.notes,
    "This document summarizes every retained building row and lists all retained zone features. The complete baseline/proposal building ledger remains in CSV/XLSX. Exact source attributes, geometry, request URLs and receipts remain in the workbook and complete project/records exports. Summary counts do not replace that ledger.",
    "Availability and panel footprints are source context; they do not by themselves classify every location or prove no SFHA intersection.",
    ...dataset.files.map(
      (file, i) =>
        `Source receipt ${i + 1}: ${file.sourceId}; ${file.bytes} bytes; retrieved ${file.retrievedAt}; SHA-256 ${file.sha256}. Exact request URL is retained in complete records.`,
    ),
    "Hashes identify retained content; their presence in an imported file does not independently authenticate its source claims.",
  ];
  return {
    reference,
    dataset,
    resolution,
    contextDescription,
    summaryRows,
    zoneRows,
    mapDates,
    diagnostics,
    notes,
  };
}

export function floodGeoJsonFeatures(
  dataset: FloodDataset,
  datasetHash: string,
): GeoJSON.Feature[] {
  return (
    ["zones", "availability", "panels", "revisions", "seclusions"] as const
  ).flatMap((kind) =>
    dataset[kind].map((feature) => ({
      type: "Feature" as const,
      id: `flood:${datasetHash}:${kind}:${feature.id}`,
      geometry: feature.geometry,
      properties: {
        featureType: `flood-${kind}`,
        datasetHash,
        sourceFeatureId: feature.id,
        sourceAttributes: feature.attributes,
        ...("classification" in feature
          ? { classification: feature.classification }
          : {}),
        capturedAt: dataset.capturedAt,
        geometryRole:
          "Retained source classification; not a proposed change or flood prediction",
      },
    })),
  );
}

export function requireFloodReport(snapshot: ReportSnapshot) {
  const inventory = floodReportInventory(snapshot);
  if (!inventory)
    throw new ApiError(
      422,
      "FLOOD_ANALYSIS_REQUIRED",
      "Attach flood evidence to this scenario before exporting its building ledger.",
    );
  return inventory;
}

/** Documents summarize building rows; they never silently shorten the source-zone inventory. */
export function assertFloodDocumentLimit(snapshot: ReportSnapshot) {
  const inventory = floodReportInventory(snapshot);
  if (!inventory) return;
  if (
    inventory.zoneRows.length > 500 ||
    new TextEncoder().encode(
      JSON.stringify({
        ...inventory,
        dataset: undefined,
        resolution: undefined,
      }),
    ).byteLength > 200_000
  )
    throw new ApiError(
      413,
      "FLOOD_REPORT_TOO_LARGE",
      "The flood source inventory exceeds the bounded PDF/Word appendix. Export CSV, XLSX or complete saved records; no source zones or building rows have been silently omitted.",
    );
}

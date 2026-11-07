import type { ModelResults } from "@urban/core";
import { calculateImpact } from "@urban/models";
import {
  exportAccessibilityCsv,
  exportCsv,
  exportDocx,
  exportFloodCsv,
  exportFiscalCsv,
  exportGeoJson,
  exportPdf,
  exportRecords,
  exportRetailCsv,
  exportTrafficCsv,
  exportWorkforceCsv,
  exportXlsx,
  type ReportSnapshot,
} from "./exports";
import { ApiError } from "./errors";
import { assertFloodExport, selectedFloodDataset } from "./flood-validation";
import { exportScenarioShapefile } from "./gis-shapefile";
import type { GisRuntime } from "./gis-runtime";
import { assertAccessibilityDocumentLimit } from "./report-accessibility";
import { assertFloodDocumentLimit } from "./report-flood";
import { renderReportMapPair } from "./report-maps";
import { assertRetailDocumentLimit } from "./report-retail";
import { assertTrafficDocumentLimit } from "./report-traffic";
import { assertWorkforceDocumentLimit } from "./report-workforce";
import { assertFiscalDocumentLimit } from "./report-fiscal";
import { assertFiscalExport } from "./fiscal-rights";

export type FloodExportFormat =
  | "csv"
  | "retail-csv"
  | "workforce-csv"
  | "accessibility-csv"
  | "flood-csv"
  | "fiscal-csv"
  | "traffic-csv"
  | "geojson"
  | "xlsx"
  | "pdf"
  | "docx"
  | "records";
export type FloodExportSnapshot = Omit<ReportSnapshot, "results"> & {
  results?: ModelResults;
};
export interface FloodExportRecords {
  audit: unknown[];
  comments: unknown[];
  publicFeedback?: unknown[];
  sharing?: unknown;
  engagement?: unknown;
}
export interface FloodExportResult {
  body: string | Uint8Array | object;
  contentType: string;
  /** File type only; the HTTP caller retains the existing descriptive filename. */
  extension: string;
  mapHeaders?: Record<string, string>;
}

/**
 * Run inside the bounded export worker after project authorization. This helper
 * neither starts a worker nor trusts a caller-supplied geometry-validation flag.
 * Native shapefile conversion is deliberately a separate parent-process step.
 */
export async function exportFloodTask(
  input: FloodExportSnapshot,
  format: FloodExportFormat,
  records?: FloodExportRecords,
): Promise<FloodExportResult> {
  assertFiscalExport(input.project);
  assertFloodExport(
    input.project,
    format === "records" ? undefined : input.scenario,
  );
  if (format === "records" && !records)
    throw new ApiError(
      422,
      "EXPORT_RECORDS_REQUIRED",
      "Complete saved-record exports require the authorized audit and discussion inventory.",
    );
  const snapshot: ReportSnapshot = {
    ...input,
    results:
      input.results ??
      calculateImpact(
        input.place,
        input.scenario,
        {},
        {
          floodDatasets: input.project.floodDatasets,
          fiscalStudy: input.project.fiscalStudy,
        },
      ),
  };
  let mapHeaders: Record<string, string> | undefined;
  if (format === "pdf" || format === "docx") {
    assertRetailDocumentLimit(snapshot);
    assertWorkforceDocumentLimit(snapshot);
    assertAccessibilityDocumentLimit(snapshot);
    assertTrafficDocumentLimit(snapshot);
    assertFloodDocumentLimit(snapshot);
    assertFiscalDocumentLimit(snapshot);
    const baselineScenario = snapshot.project.scenarios.find(
      (s) => s.id === "baseline",
    );
    if (!baselineScenario)
      throw new ApiError(
        422,
        "BASELINE_REQUIRED",
        "This project has no captured baseline scenario for a before-and-after report.",
      );
    snapshot.maps = await renderReportMapPair({
      place: snapshot.place,
      baselineScenario,
      proposalScenario: snapshot.scenario,
      ...(snapshot.scenario.flood
        ? {
            flood: {
              datasetHash: snapshot.scenario.flood.datasetHash,
              dataset: selectedFloodDataset(
                snapshot.project,
                snapshot.scenario,
              )!,
            },
          }
        : {}),
    });
    mapHeaders = {
      "X-Report-Renderer": snapshot.maps.metadata.rendererVersion,
      "X-Report-Map-Input": snapshot.maps.metadata.inputHash,
      "X-Report-Baseline-Image": snapshot.maps.baseline.sha256,
      "X-Report-Proposal-Image": snapshot.maps.proposal.sha256,
    };
  }
  const csv = (body: string): FloodExportResult => ({
    body,
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  });
  switch (format) {
    case "csv":
      return csv(exportCsv(snapshot));
    case "retail-csv":
      return csv(exportRetailCsv(snapshot));
    case "workforce-csv":
      return csv(exportWorkforceCsv(snapshot));
    case "accessibility-csv":
      return csv(exportAccessibilityCsv(snapshot));
    case "flood-csv":
      return csv(exportFloodCsv(snapshot));
    case "fiscal-csv":
      return csv(exportFiscalCsv(snapshot));
    case "traffic-csv":
      return csv(exportTrafficCsv(snapshot));
    case "geojson":
      return {
        body: exportGeoJson(snapshot),
        contentType: "application/geo+json",
        extension: "geojson",
      };
    case "xlsx":
      return {
        body: await exportXlsx(snapshot),
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
      };
    case "pdf":
      return {
        body: await exportPdf(snapshot),
        contentType: "application/pdf",
        extension: "pdf",
        mapHeaders,
      };
    case "docx":
      return {
        body: await exportDocx(snapshot),
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: "docx",
        mapHeaders,
      };
    case "records":
      return {
        body: {
          ...exportRecords(
            snapshot,
            records!.audit,
            records!.comments,
            records!.publicFeedback,
            records!.sharing,
          ),
          ...(records!.engagement === undefined
            ? {}
            : { engagement: records!.engagement }),
        },
        contentType: "application/json",
        extension: "json",
      };
    default:
      throw new ApiError(422, "EXPORT_FORMAT", "Unsupported export format.");
  }
}

export type FloodGisTaskInput = Omit<
  Parameters<typeof exportScenarioShapefile>[1],
  "signal"
>;
export type FloodGisPreparation = Pick<
  Parameters<GisRuntime["exportShapefile"]>[0],
  "layers" | "manifest"
>;

/** Capture exactly what the existing wrapper would send to GDAL, without invoking it. */
export async function prepareFloodGisTask(
  input: FloodGisTaskInput,
): Promise<FloodGisPreparation> {
  assertFloodExport(input, input.scenario);
  const captured = Symbol("shapefile preparation captured");
  let preparation: FloodGisPreparation | undefined;
  try {
    await exportScenarioShapefile(
      {
        exportShapefile: async ({ layers, manifest }) => {
          preparation = { layers, manifest };
          throw captured;
        },
      },
      input,
    );
  } catch (error) {
    if (error !== captured) throw error;
  }
  if (!preparation)
    throw new Error(
      "The shapefile wrapper did not produce its complete prepared input.",
    );
  return preparation;
}

import { afterEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  floodDatasetHash,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { floodFixture } from "../../../tests/fixtures/flood";
import {
  exportCsv,
  exportFloodCsv,
  exportGeoJson,
  exportRecords,
} from "./exports";
import {
  exportFloodTask,
  prepareFloodGisTask,
  type FloodExportSnapshot,
  type FloodExportFormat,
} from "./flood-export-task";
import * as maps from "./report-maps";

async function fixture() {
  const f = await floodFixture();
  const scenario = applyCommand(f.scenario, {
    type: "building.upsert",
    building: {
      ...f.place.buildings[0],
      units: null,
      attributeProvenance: {
        version: 1,
        fields: { units: { status: "missing", sourceId: "flood-fixture" } },
      },
    },
  });
  const project = {
    ...f.project,
    scenarios: f.project.scenarios.map((s) =>
      s.id === scenario.id ? scenario : s,
    ),
  };
  const snapshot: FloodExportSnapshot = {
    project,
    place: f.place,
    scenario,
    projectVersion: 2,
    generatedAt: "2026-11-06T00:00:00Z",
  };
  const results = calculateImpact(f.place, scenario, {}, f.context);
  const gis = {
    place: f.place,
    scenario,
    projectId: project.id,
    projectVersion: 2,
    baselineHash: (await baselineIdentity(f.place)).sha256,
    generatedAt: snapshot.generatedAt,
    floodDatasets: project.floodDatasets,
  };
  return { f, snapshot, complete: { ...snapshot, results }, gis };
}
afterEach(() => vi.restoreAllMocks());

describe("bounded-worker export task projection", () => {
  it("computes missing results in the task while preserving exact CSV/GeoJSON evidence and unknown-versus-zero", async () => {
    const { snapshot, complete } = await fixture(),
      before = canonicalJSON(snapshot);
    expect(await exportFloodTask(snapshot, "csv")).toEqual({
      body: exportCsv(complete),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    });
    const flood = await exportFloodTask(snapshot, "flood-csv");
    expect(flood.body).toBe(exportFloodCsv(complete));
    expect(flood.body).toContain('"scenario","wet","intersects-sfha","",""');
    expect(flood.body).toContain(
      '"scenario","clear","no-sfha-intersection","5","0"',
    );
    expect((flood.body as string).split("\r\n").filter(Boolean)).toHaveLength(
      5,
    );
    const geo = await exportFloodTask(complete, "geojson");
    expect(geo).toEqual({
      body: exportGeoJson(complete),
      contentType: "application/geo+json",
      extension: "geojson",
    });
    expect(canonicalJSON(snapshot)).toBe(before);
  });

  it("retains full record inventories and supplied frozen results without silently inventing absent audit rows", async () => {
    const { complete } = await fixture();
    const records = {
      audit: [{ id: "audit-1" }],
      comments: [{ id: "comment-1" }],
      publicFeedback: [{ id: "feedback-1" }],
      sharing: { role: "owner" },
      engagement: [{ id: "publication-1" }],
    };
    const result = await exportFloodTask(complete, "records", records);
    expect(result).toEqual({
      contentType: "application/json",
      extension: "json",
      body: {
        ...exportRecords(
          complete,
          records.audit,
          records.comments,
          records.publicFeedback,
          records.sharing,
        ),
        engagement: records.engagement,
      },
    });
    expect((result.body as ReturnType<typeof exportRecords>).resultBundle).toBe(
      complete.results,
    );
    await expect(exportFloodTask(complete, "records")).rejects.toMatchObject({
      code: "EXPORT_RECORDS_REQUIRED",
    });
  });

  it("keeps typed workbook nulls, all building rows and the complete selected source dataset", async () => {
    const { snapshot } = await fixture(),
      result = await exportFloodTask(snapshot, "xlsx");
    expect(result.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(result.body).toBeInstanceOf(Uint8Array);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(result.body as never);
    expect(book.getWorksheet("Flood building ledger")!.rowCount).toBe(5);
    const summary = book.getWorksheet("Flood summary")!;
    expect([
      summary.getCell("B2").value,
      summary.getCell("B3").value,
      summary.getCell("C3").value,
    ]).toEqual([10, null, 0]);
    const chunks: string[] = [];
    book.getWorksheet("Flood evidence")!.eachRow((row, index) => {
      if (
        index > 1 &&
        row.getCell(1).value === "Exact selected source dataset JSON"
      )
        chunks.push(String(row.getCell(3).value));
    });
    expect(JSON.parse(chunks.join(""))).toEqual(
      snapshot.project.floodDatasets![snapshot.scenario.flood!.datasetHash],
    );
  });

  it("renders selected-pack PDF and Word comparison maps and returns exact map identity headers", async () => {
    const { complete } = await fixture(),
      before = canonicalJSON(complete);
    const render = vi.spyOn(maps, "renderReportMapPair");
    const pdf = await exportFloodTask(complete, "pdf"),
      docx = await exportFloodTask(complete, "docx");
    expect(
      Buffer.from(pdf.body as Uint8Array)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(
      Buffer.from(docx.body as Uint8Array)
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
    expect([pdf.extension, docx.extension]).toEqual(["pdf", "docx"]);
    expect(pdf.mapHeaders).toEqual(docx.mapHeaders);
    expect(Object.keys(pdf.mapHeaders!)).toEqual([
      "X-Report-Renderer",
      "X-Report-Map-Input",
      "X-Report-Baseline-Image",
      "X-Report-Proposal-Image",
    ]);
    for (const [input] of render.mock.calls) {
      expect(input.flood?.datasetHash).toBe(
        complete.scenario.flood!.datasetHash,
      );
      expect(input.flood?.dataset).toBe(
        complete.project.floodDatasets![complete.scenario.flood!.datasetHash],
      );
      expect(input.baselineScenario.id).toBe("baseline");
    }
    expect(render).toHaveBeenCalledTimes(2);
    expect(canonicalJSON(complete)).toBe(before);
  });

  it("refuses missing baseline, corrupt evidence and oversized document inventory before rendering maps", async () => {
    const { snapshot } = await fixture(),
      render = vi.spyOn(maps, "renderReportMapPair");
    const noBaseline = {
      ...snapshot,
      project: { ...snapshot.project, scenarios: [snapshot.scenario] },
    };
    await expect(exportFloodTask(noBaseline, "pdf")).rejects.toMatchObject({
      code: "BASELINE_REQUIRED",
    });
    const corrupt = structuredClone(snapshot);
    corrupt.project.floodDatasets![
      snapshot.scenario.flood!.datasetHash
    ].notes.push("unauthorized mutation");
    await expect(exportFloodTask(corrupt, "docx")).rejects.toMatchObject({
      code: "FLOOD_DATASET_UNAVAILABLE",
    });
    const large = structuredClone(snapshot),
      dataset = structuredClone(
        snapshot.project.floodDatasets![snapshot.scenario.flood!.datasetHash],
      );
    dataset.notes = Array.from({ length: 30 }, () =>
      "Retained source note. ".repeat(450),
    );
    const hash = await floodDatasetHash(dataset);
    large.project.floodDatasets = { [hash]: dataset };
    large.scenario.flood!.datasetHash = hash;
    await expect(exportFloodTask(large, "pdf")).rejects.toMatchObject({
      code: "FLOOD_REPORT_TOO_LARGE",
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("prepares exact GIS layers and manifest with full unknown accounting and no native ZIP", async () => {
    const { gis, snapshot } = await fixture(),
      before = canonicalJSON(gis);
    const prepared = await prepareFloodGisTask(gis);
    expect(Object.keys(prepared).sort()).toEqual(["layers", "manifest"]);
    expect(prepared.manifest).toMatchObject({
      projectId: snapshot.project.id,
      projectVersion: 2,
      baselineHash: gis.baselineHash,
      scenarioId: snapshot.scenario.id,
      scenarioRevision: snapshot.scenario.revision,
    });
    const flood = prepared.manifest.flood as {
      dataset: unknown;
      resolution: {
        baseline: { value: number | null };
        scenario: {
          value: number | null;
          knownSubtotal: number | null;
          missingUnitBuildingIds: string[];
        };
      };
    };
    expect(flood.dataset).toEqual(
      snapshot.project.floodDatasets![snapshot.scenario.flood!.datasetHash],
    );
    expect(flood.resolution.baseline.value).toBe(10);
    expect(flood.resolution.scenario).toMatchObject({
      value: null,
      knownSubtotal: 0,
      missingUnitBuildingIds: ["wet"],
    });
    const buildings = prepared.layers.find((layer) => layer.id === "buildings")!
      .geojson.features;
    expect(buildings.find((b) => b.id === "wet")!.properties!.units).toBeNull();
    expect(buildings.find((b) => b.id === "clear")!.properties!.units).toBe(5);
    expect(
      prepared.layers.find((layer) => layer.id === "flood_zones")!.geojson
        .features,
    ).toHaveLength(2);
    expect(canonicalJSON(gis)).toBe(before);
    const corrupt = structuredClone(gis);
    corrupt.floodDatasets = {};
    await expect(prepareFloodGisTask(corrupt)).rejects.toMatchObject({
      code: "FLOOD_DATASET_UNAVAILABLE",
    });
  });

  it("keeps specialized missing-evidence failures and retained source export restrictions", async () => {
    const { snapshot, gis } = await fixture();
    for (const format of [
      "retail-csv",
      "workforce-csv",
      "accessibility-csv",
      "traffic-csv",
    ] as FloodExportFormat[])
      await expect(exportFloodTask(snapshot, format)).rejects.toThrow();
    const dataset =
      snapshot.project.floodDatasets![snapshot.scenario.flood!.datasetHash];
    dataset.sources[0].rights = {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: false,
      historicalRetention: true,
      publicRedistribution: false,
      declaredBy: "fixture",
      declaredAt: snapshot.generatedAt,
    };
    await expect(exportFloodTask(snapshot, "csv")).rejects.toMatchObject({
      code: "FLOOD_EXPORT_RESTRICTED",
    });
    await expect(
      exportFloodTask(snapshot, "records", { audit: [], comments: [] }),
    ).rejects.toMatchObject({ code: "FLOOD_EXPORT_RESTRICTED" });
    await expect(prepareFloodGisTask(gis)).rejects.toMatchObject({
      code: "FLOOD_EXPORT_RESTRICTED",
    });
  });
});

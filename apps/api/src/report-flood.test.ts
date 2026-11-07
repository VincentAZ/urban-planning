import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import { applyCommand, floodDatasetHash, type FloodDataset } from "@urban/core";
import { calculateImpact } from "@urban/models";
import { floodFixture } from "../../../tests/fixtures/flood";
import {
  exportFloodCsv,
  exportGeoJson,
  exportXlsx,
  exportPdf,
  exportDocx,
  type ReportSnapshot,
} from "./exports";
import { floodReportInventory } from "./report-flood";
import {
  assertReportSnapshot,
  reportDigest,
  reportPlanningSources,
  reportSources,
  sourceReferences,
} from "./report-content";
import { buildReportMapPairSvg, renderReportMapPair } from "./report-maps";
import { shapefileLayers } from "./gis-shapefile";

async function fixture(unknown = false): Promise<ReportSnapshot> {
  const f = await floodFixture();
  const scenario = applyCommand(f.scenario, {
    type: "building.upsert",
    building: {
      ...f.place.buildings[0],
      units: unknown ? null : 23,
      ...(unknown
        ? {
            attributeProvenance: {
              version: 1 as const,
              fields: {
                units: {
                  status: "missing" as const,
                  sourceId: "flood-fixture",
                },
              },
            },
          }
        : {}),
    },
  });
  const project = {
    ...f.project,
    scenarios: f.project.scenarios.map((s) =>
      s.id === scenario.id ? scenario : s,
    ),
  };
  return {
    project,
    place: f.place,
    scenario,
    results: calculateImpact(f.place, scenario, {}, f.context),
    generatedAt: "2026-11-06T00:00:00Z",
    projectVersion: 1,
  };
}

function documentText(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Word ZIP directory missing");
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const size = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + size).toString();
    if (name === "word/document.xml") {
      const local = buffer.readUInt32LE(offset + 42),
        start =
          local +
          30 +
          buffer.readUInt16LE(local + 26) +
          buffer.readUInt16LE(local + 28);
      const bytes = buffer.subarray(
        start,
        start + buffer.readUInt32LE(offset + 20),
      );
      return (
        buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(bytes) : bytes
      )
        .toString()
        .replaceAll("\u200b", "");
    }
    offset += 46 + size + extra + comment;
  }
  throw new Error("Word document missing");
}

describe("frozen source-map exposure reports", () => {
  it("reads the official study index date separately from database revision and panel dates", async () => {
    const snapshot = await fixture();
    const oldHash = snapshot.scenario.flood!.datasetHash;
    const dataset = structuredClone(snapshot.project.floodDatasets![oldHash]);
    dataset.capture.studyInfo = [
      {
        DFIRM_ID: "04013C",
        INDX_EFFDT: 1707350400000,
        DBREV_DT: 1790899200000,
      },
    ];
    const hash = await floodDatasetHash(dataset);
    snapshot.project.floodDatasets = { [hash]: dataset };
    snapshot.scenario = {
      ...snapshot.scenario,
      flood: { ...snapshot.scenario.flood!, datasetHash: hash },
    };
    const dates = floodReportInventory(snapshot)!.mapDates;
    expect(dates).toContainEqual([
      "Study index effective date",
      "04013C",
      "2024-02-08T00:00:00.000Z",
    ]);
    expect(dates).toContainEqual([
      "Study database revision",
      "04013C",
      "2026-10-02T00:00:00.000Z",
    ]);
  });
  it("reproduces baseline/proposal changes and every building row with unknown totals distinct from known zero", async () => {
    const snapshot = await fixture(true),
      inventory = floodReportInventory(snapshot)!;
    expect(inventory.resolution.baseline.value).toBe(10);
    expect(inventory.resolution.scenario.value).toBeNull();
    expect(inventory.resolution.scenario.knownSubtotal).toBe(0);
    expect(inventory.resolution.scenario.missingUnitBuildingIds).toEqual([
      "wet",
    ]);
    const csv = exportFloodCsv(snapshot);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(5);
    expect(csv).toContain('"scenario","wet","intersects-sfha","",""');
    expect(csv).toContain('"scenario","clear","no-sfha-intersection","5","0"');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportXlsx(snapshot)) as never);
    const ledger = book.getWorksheet("Flood building ledger")!;
    expect(ledger.rowCount).toBe(5);
    const summary = book.getWorksheet("Flood summary")!;
    expect(summary.getCell("B2").value).toBe(10);
    expect(summary.getCell("B3").value).toBeNull();
    expect(summary.getCell("C3").value).toBe(0);
    const exact = book.getWorksheet("Flood evidence")!;
    const chunks: string[] = [];
    exact.eachRow((row, index) => {
      if (
        index > 1 &&
        row.getCell(1).value === "Exact selected source dataset JSON"
      )
        chunks.push(String(row.getCell(3).value));
    });
    expect(JSON.parse(chunks.join(""))).toEqual(inventory.dataset);
  });

  it("exports all frozen source geometries, raw attributes, separate namespaces and no private catalog spill", async () => {
    const snapshot = await fixture();
    const selected =
      snapshot.project.floodDatasets![snapshot.scenario.flood!.datasetHash];
    const extra: FloodDataset = structuredClone(selected);
    extra.notes.push("UNSELECTED_PRIVATE_DATASET_MARKER");
    const extraHash = await floodDatasetHash(extra);
    snapshot.project.floodDatasets![extraHash] = extra;
    const geo = exportGeoJson(snapshot),
      serialized = JSON.stringify(geo);
    expect(geo.metadata.flood?.resolution.scenario.value).toBe(23);
    expect(
      geo.features.filter(
        (f) =>
          "featureType" in (f.properties ?? {}) &&
          f.properties!.featureType === "flood-zones",
      ),
    ).toHaveLength(2);
    expect(serialized).not.toContain("UNSELECTED_PRIVATE_DATASET_MARKER");
    expect(
      geo.features.find(
        (f) =>
          f.id === `flood:${snapshot.scenario.flood!.datasetHash}:zones:sfha`,
      )?.geometry,
    ).toEqual(selected.zones[0].geometry);
    expect(reportPlanningSources(snapshot)).toHaveLength(1);
    expect(
      reportSources(snapshot).filter((s) => s.id === "flood-fixture"),
    ).toHaveLength(2);
    const references = sourceReferences(
      snapshot,
      snapshot.results.metrics.find((m) => m.id === "environment.flood")!,
    );
    expect(references).toContain("flood map source flood-fixture");
    expect(references).toContain("planning inventory [1]");
    expect(references).not.toContain("source metadata unavailable");
    const layers = shapefileLayers(
      snapshot.place,
      snapshot.scenario,
      snapshot.project.floodDatasets,
    );
    expect(
      layers.find((l) => l.id === "flood_zones")?.geojson.features,
    ).toHaveLength(2);
    expect(
      layers.find((l) => l.id === "flood_panels")?.geojson.features[0]
        .properties?.sourceAttributes,
    ).toEqual(selected.panels[0].attributes);
  });

  it("renders a hash-bound identical source overlay in both maps and rejects missing or swapped map context", async () => {
    const snapshot = await fixture();
    const datasetHash = snapshot.scenario.flood!.datasetHash;
    const input = {
      place: snapshot.place,
      baselineScenario: snapshot.project.scenarios[0],
      proposalScenario: snapshot.scenario,
      flood: {
        datasetHash,
        dataset: snapshot.project.floodDatasets![datasetHash],
      },
    };
    const maps = buildReportMapPairSvg(input);
    for (const panel of [maps.baseline, maps.proposal]) {
      expect(panel.svg).toContain(`data-flood-dataset="${datasetHash}"`);
      expect(panel.svg).toContain('data-flood-zone="sfha"');
      expect(panel.svg).toContain('fill-rule="evenodd"');
      expect(panel.alt).toContain("not establish safety");
    }
    expect(maps.metadata.height).toBe(1000);
    expect(() => buildReportMapPairSvg({ ...input, flood: undefined })).toThrow(
      /exact retained flood/,
    );
    expect(() =>
      buildReportMapPairSvg({
        ...input,
        flood: { ...input.flood, datasetHash: "0".repeat(64) },
      }),
    ).toThrow(/exact retained flood/);
    snapshot.maps = await renderReportMapPair(input);
    expect(() => assertReportSnapshot(snapshot)).not.toThrow();
    snapshot.maps.metadata.floodDatasetHash = "0".repeat(64);
    expect(() => assertReportSnapshot(snapshot)).toThrow(
      /comparison map inputs/,
    );
  });

  it("rejects altered dataset bytes and stale scalar results instead of producing contradictory reports", async () => {
    const snapshot = await fixture();
    const hash = reportDigest(snapshot);
    expect(floodReportInventory(snapshot)!.resolution.scenario.value).toBe(23);
    snapshot.results.metrics.find((m) => m.id === "environment.flood")!.value =
      999;
    expect(() => assertReportSnapshot(snapshot)).toThrow(/does not reproduce/);
    snapshot.project.floodDatasets![
      snapshot.scenario.flood!.datasetHash
    ].notes.push("altered");
    expect(reportDigest(snapshot)).not.toBe(hash);
    expect(() => exportFloodCsv(snapshot)).toThrow(
      /matching immutable dataset/,
    );
    expect(() =>
      shapefileLayers(
        snapshot.place,
        snapshot.scenario,
        snapshot.project.floodDatasets,
      ),
    ).toThrow(/exact retained flood/);
  });

  it("puts the complete source-zone inventory, source dates and interpretation in PDF/Word", async () => {
    const snapshot = await fixture();
    const pdf = await exportPdf(snapshot),
      word = await exportDocx(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = documentText(word);
    for (const value of [
      "Mapped flood exposure",
      "Retained flood classifications",
      "2013-10-16",
      "SFHA",
      "Imported evidence",
      "not a complete total",
      snapshot.scenario.flood!.datasetHash,
    ])
      expect(text).toContain(value);
    expect(text).toContain("23");
    expect(text).toContain("10");
  });
});

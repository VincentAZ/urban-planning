import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import {
  applyCommand,
  projectWithWorkforceVersion,
  verifyWorkforceScenario,
  type Place,
  type Source,
} from "@urban/core";
import { createProject, calculateImpact } from "@urban/models";
import {
  workforceScenarioFixture,
  workforcePlaceFixture,
} from "../../../tests/fixtures/workforce";
import {
  reportSources,
  reportPlanningSources,
  sourceReferences,
} from "./report-content";
import {
  exportWorkforceCsv,
  exportXlsx,
  exportPdf,
  exportDocx,
  exportGeoJson,
  type ReportSnapshot,
} from "./exports";
import {
  assertWorkforceDocumentLimit,
  workforceReportInventory,
} from "./report-workforce";
import { workforceHTML } from "../../web/src/lib/workforce-export";

async function fixture(
  partial = true,
  placeOverride?: Place,
): Promise<ReportSnapshot> {
  const { place, workforce } = await workforceScenarioFixture({
    partial,
    place: placeOverride,
  });
  let project = createProject(place);
  const scenario = applyCommand(project.scenarios[1], {
    type: "scenario.workforce",
    workforce,
  });
  project.scenarios[1] = scenario;
  project = projectWithWorkforceVersion(project, place);
  return {
    project,
    place,
    scenario,
    results: calculateImpact(place, scenario),
    generatedAt: "2026-11-06T00:00:00Z",
    projectVersion: 2,
  };
}
function xmlOf(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Missing ZIP directory");
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const length = buffer.readUInt16LE(offset + 28),
      name = buffer.subarray(offset + 46, offset + 46 + length).toString(),
      local = buffer.readUInt32LE(offset + 42),
      size = buffer.readUInt32LE(offset + 20),
      method = buffer.readUInt16LE(offset + 10);
    if (name === "word/document.xml") {
      const start =
          local +
          30 +
          buffer.readUInt16LE(local + 26) +
          buffer.readUInt16LE(local + 28),
        data = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString();
    }
    offset +=
      46 +
      length +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
  throw new Error("Missing Word XML");
}
describe("frozen workforce report evidence", () => {
  it("preserves both citation namespaces and resolves planning references before colliding imported workforce IDs", async () => {
    const planning: Source = {
      id: "fixture",
      name: "Captured building survey",
      url: "https://example.org/buildings",
      vintage: "2025",
      license: "Fixture use",
      kind: "observed",
    };
    const snapshot = await fixture(true, {
      ...workforcePlaceFixture,
      sources: [planning],
    });
    snapshot.scenario.workforce!.origin = "imported";
    await verifyWorkforceScenario(snapshot.scenario.workforce!, snapshot.place);
    const before = JSON.stringify(snapshot.scenario.workforce);
    expect(reportPlanningSources(snapshot)).toEqual([planning]);
    const inventory = reportSources(snapshot);
    expect(inventory).toHaveLength(2);
    expect(inventory[0]).toEqual(planning);
    expect(inventory[1].name).toBe("Synthetic unit test (workforce capture)");
    expect(
      sourceReferences(snapshot, {
        ...snapshot.results.metrics[0],
        sourceIds: ["fixture"],
      }),
    ).toBe("Source references: [1].");
    const geo = exportGeoJson(snapshot);
    expect(geo.metadata.sources).toEqual([planning]);
    expect(geo.metadata.workforce!.capture.sources).toEqual(
      snapshot.scenario.workforce!.capture.sources,
    );
    const xml = xmlOf(await exportDocx(snapshot));
    expect(xml).toContain("Captured building survey");
    expect(xml).toContain("Synthetic unit test (workforce capture)");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const sources = workbook.getWorksheet("Sources")!;
    expect(sources.getRow(2).getCell(2).value).toBe("Captured building survey");
    expect(sources.getRow(3).getCell(2).value).toBe(
      "Synthetic unit test (workforce capture)",
    );
    expect(JSON.stringify(snapshot.scenario.workforce)).toBe(before);
  });

  it("retains all 39 rows, separate universes, conditional uncertainty and hashes across native documents, workbook and GIS metadata", async () => {
    const snapshot = await fixture(),
      inventory = workforceReportInventory(snapshot)!;
    expect(inventory.panels.map((panel) => panel.rows.length)).toEqual([
      21, 18,
    ]);
    expect(inventory.panels[0].rows[0]).toEqual([
      "Total population in this universe",
      "15 min",
      "Subtotal 20",
      "Conditional ±2",
      "partial",
    ]);
    const csv = exportWorkforceCsv(snapshot);
    expect(csv.trim().split("\r\n")).toHaveLength(40);
    expect(csv).toContain('"partial","","20","","2"');
    expect(csv).toContain('"Population 25 years and over"');
    expect(csv).toContain('"Civilian employed population 16 years and over"');
    expect(csv).toContain(snapshot.scenario.workforce!.captureHash);
    const csvRows = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    const decodeQuotedRow = (row: string) =>
      Array.from(row.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (match) =>
        match[1].replaceAll('""', '"'),
      );
    const csvHeaders = decodeQuotedRow(csvRows[0]);
    expect(csvHeaders).toContain("source_files_json");
    expect(csvHeaders).toContain("routing_run_sha256");
    for (const row of csvRows.slice(1)) {
      const values = decodeQuotedRow(row);
      expect(values).toHaveLength(csvHeaders.length);
      expect(
        JSON.parse(values[csvHeaders.indexOf("source_files_json")]),
      ).toEqual(snapshot.scenario.workforce!.capture.files);
      expect(values[csvHeaders.indexOf("routing_run_sha256")]).toBe(
        snapshot.scenario.workforce!.capture.routingRunHash,
      );
    }
    const xml = xmlOf(await exportDocx(snapshot)).replaceAll("\u200b", "");
    for (const phrase of [
      "Workforce within reach of the site",
      "Subtotal 20",
      "Conditional ±2",
      "Education covers adults aged 25",
      "occupation covers civilian employed",
      "not counts of available applicants",
      "Workforce coverage and provenance",
      snapshot.scenario.workforce!.capture.artifactHash,
    ])
      expect(xml.includes(phrase), `Word retains: ${phrase}`).toBe(true);
    expect((await exportPdf(snapshot)).subarray(0, 5).toString()).toBe("%PDF-");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const sheet = workbook.getWorksheet("Workforce counts")!;
    expect(sheet.rowCount).toBe(40);
    expect(sheet.getRow(2).getCell(6).value).toBeNull();
    expect(sheet.getRow(2).getCell(7).value).toBe(20);
    expect(sheet.getRow(2).getCell(8).value).toBeNull();
    expect(sheet.getRow(2).getCell(9).value).toBe(2);
    expect(workbook.getWorksheet("Workforce evidence")).toBeDefined();
    expect(exportGeoJson(snapshot).metadata.workforce).toEqual(
      snapshot.scenario.workforce,
    );
    expect(exportGeoJson(snapshot).metadata.workforceGeometry).toContain(
      "archived separately",
    );
  });
  it("preserves complete counts and captured methods after unrelated horizon and global model changes", async () => {
    const snapshot = await fixture(false),
      before = structuredClone(snapshot.scenario.workforce);
    snapshot.scenario.horizon = 20;
    snapshot.results.modelVersion = "future-global-model";
    expect(workforceReportInventory(snapshot)!.panels[0].rows[0]).toEqual([
      "Total population in this universe",
      "15 min",
      "20",
      "±2",
      "complete",
    ]);
    expect(exportWorkforceCsv(snapshot)).toContain("workforce-1.0.2");
    expect(workforceReportInventory(snapshot)!.contextDescription).toContain(
      "horizon 20 years",
    );
    expect(snapshot.scenario.workforce).toEqual(before);
  });
  it("labels imported evidence before its figures while retaining the exact capture", async () => {
    const snapshot = await fixture();
    const evidence = snapshot.scenario.workforce!;
    const before = JSON.stringify(evidence.capture);
    evidence.origin = "imported";
    expect(workforceReportInventory(snapshot)!.contextDescription).toMatch(
      /^Imported evidence/,
    );
    expect(workforceHTML(snapshot.scenario)).toContain(
      "not verified by this server",
    );
    expect(exportWorkforceCsv(snapshot)).toContain('"imported"');
    expect(JSON.stringify(evidence.capture)).toBe(before);
  });
  it("escapes untrusted text, neutralizes CSV formulas, and rejects oversized native appendices without truncation", async () => {
    const snapshot = await fixture();
    snapshot.scenario.id = "=untrusted-formula";
    snapshot.scenario.workforce!.capture.notes.push(
      '<script>alert("injected")</script>',
    );
    const html = workforceHTML(snapshot.scenario);
    expect(html).not.toContain('<script>alert("injected")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(exportWorkforceCsv(snapshot)).toContain('"\'=untrusted-formula"');
    snapshot.scenario.workforce!.capture.notes.push(
      "Long retained evidence. ".repeat(6000),
    );
    expect(() => assertWorkforceDocumentLimit(snapshot)).toThrow(/too large/);
    expect(exportWorkforceCsv(snapshot)).toContain("Long retained evidence.");
    delete snapshot.scenario.workforce;
    expect(() => exportWorkforceCsv(snapshot)).toThrow(/no workforce capture/);
  });
});

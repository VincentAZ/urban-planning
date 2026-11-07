import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import {
  applyCommand,
  projectWithAccessibilityVersion,
  type Source,
} from "@urban/core";
import {
  calculateImpact,
  createProject,
  createAccessibilityModeEvidence,
  resolveAccessibility,
} from "@urban/models";
import { accessibilityFixture } from "../../../tests/fixtures/accessibility";
import {
  accessibilityReportInventory,
  assertAccessibilityDocumentLimit,
} from "./report-accessibility";
import {
  exportAccessibilityCsv,
  exportDocx,
  exportGeoJson,
  exportPdf,
  exportXlsx,
  type ReportSnapshot,
} from "./exports";
import { reportPlanningSources, reportSources } from "./report-content";

async function fixture(partial = true): Promise<ReportSnapshot> {
  const car = await accessibilityFixture(),
    walk = await accessibilityFixture({ mode: "walk" });
  if (partial) {
    car.artifact.run.rows[1] = {
      ...car.artifact.run.rows[1],
      status: "unsnappable",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
    };
    car.artifact.result = await resolveAccessibility(
      car.pack,
      car.artifact.run,
    );
    car.evidence = await createAccessibilityModeEvidence({
      pack: car.pack,
      artifact: car.artifact,
      binding: car.evidence.binding,
      receipt: car.evidence.receipt,
    });
  }
  let project = createProject(car.place);
  let scenario = applyCommand(project.scenarios[1], {
    type: "scenario.accessibility",
    mode: "car",
    evidence: car.evidence,
  });
  scenario = applyCommand(scenario, {
    type: "scenario.accessibility",
    mode: "walk",
    evidence: walk.evidence,
  });
  project.scenarios[1] = scenario;
  project = projectWithAccessibilityVersion(project, car.place);
  return {
    project,
    place: car.place,
    scenario,
    results: calculateImpact(car.place, scenario),
    generatedAt: "2026-11-06T00:00:00Z",
    projectVersion: 3,
  };
}
function wordXml(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Missing Word ZIP directory");
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const nameLength = buffer.readUInt16LE(offset + 28),
      extraLength = buffer.readUInt16LE(offset + 30),
      commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString();
    if (name === "word/document.xml") {
      const local = buffer.readUInt32LE(offset + 42),
        start =
          local +
          30 +
          buffer.readUInt16LE(local + 26) +
          buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(
        start,
        start + buffer.readUInt32LE(offset + 20),
      );
      return (
        buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data
      )
        .toString()
        .replaceAll("\u200b", "");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("Missing Word XML");
}
describe("frozen jobs accessibility reports", () => {
  it("retains every mode/category/threshold with nullable estimates and exact bounds in CSV and workbook", async () => {
    const snapshot = await fixture();
    const csv = exportAccessibilityCsv(snapshot);
    const rows = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n")
      .map((row) =>
        Array.from(row.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (m) =>
          m[1].replaceAll('""', '"'),
        ),
      );
    expect(rows).toHaveLength(145);
    const index = (name: string) => rows[0].indexOf(name);
    for (const row of rows.slice(1)) expect(row).toHaveLength(rows[0].length);
    expect(rows[1][index("status")]).toBe("partial");
    expect(rows[1][index("complete_estimate_primary_jobs")]).toBe("");
    expect(rows[1][index("known_subtotal_primary_jobs")]).toBe("10");
    expect(rows[1][index("unresolved_primary_jobs")]).toBe("20");
    expect(rows[1][index("upper_bound_primary_jobs")]).toBe("30");
    expect(rows[73][index("mode")]).toBe("walk");
    expect(rows[73][index("complete_estimate_primary_jobs")]).toBe("10");
    expect(rows[3][index("complete_estimate_primary_jobs")]).toBe("0");
    expect(JSON.parse(rows[1][index("source_files_json")])).toEqual(
      snapshot.scenario.accessibility!.captures.car!.capture.files,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const sheet = workbook.getWorksheet("Jobs accessibility")!;
    expect(sheet.rowCount).toBe(145);
    expect(sheet.getRow(2).getCell(6).value).toBeNull();
    expect(sheet.getRow(2).getCell(7).value).toBe(10);
    expect(sheet.getRow(2).getCell(9).value).toBe(20);
    expect(sheet.getRow(2).getCell(10).value).toBe(30);
    expect(sheet.getRow(74).getCell(1).value).toBe("walk");
    expect(
      workbook.getWorksheet("Jobs access evidence")!.rowCount,
    ).toBeGreaterThan(30);
  });
  it("keeps captures frozen across horizon edits and never manufactures baseline/proposal impacts", async () => {
    const snapshot = await fixture();
    const original = JSON.stringify(snapshot.scenario.accessibility);
    snapshot.scenario.horizon = 20;
    snapshot.scenario.revision++;
    const result = calculateImpact(snapshot.place, snapshot.scenario);
    for (const metric of result.metrics.filter((m) =>
      /^access\.(car|walk)\d/.test(m.id),
    )) {
      expect([metric.baseline, metric.value, metric.delta]).toEqual([
        null,
        null,
        null,
      ]);
      expect(metric.explanation).toContain("captured-network summary");
      expect(metric.explanation).toContain("not the effects");
    }
    expect(
      result.metrics.find((m) => m.id === "access.lowIncome")!.value,
    ).toBeNull();
    expect(
      accessibilityReportInventory(snapshot)[0].contextDescription,
    ).toContain("horizon 20 years is not applied");
    expect(exportGeoJson(snapshot).metadata.accessibility).toEqual(
      snapshot.scenario.accessibility,
    );
    expect(JSON.stringify(snapshot.scenario.accessibility)).toBe(original);
  });
  it("includes both directions-of-travel labels, categories, bounds and provenance in native documents", async () => {
    const snapshot = await fixture();
    const inventory = accessibilityReportInventory(snapshot);
    expect(
      inventory.map((item) => item.panels.map((panel) => panel.rows.length)),
    ).toEqual([
      [1, 3, 20],
      [1, 3, 20],
    ]);
    expect(inventory[0].panels[0].rows[0]).toEqual([
      "Primary jobs",
      "Subtotal 10; upper 30",
      "Subtotal 10; upper 30",
      "Subtotal 10; upper 30",
    ]);
    const xml = wordXml(await exportDocx(snapshot));
    for (const phrase of [
      "Jobs accessibility by car",
      "Jobs accessibility by walking",
      "Subtotal 10; upper 30",
      "Jobs accessibility coverage and provenance",
      "not vacancies",
      "Primary jobs by industry",
      snapshot.scenario.accessibility!.captures.car!.captureHash,
    ])
      expect(xml).toContain(phrase);
    expect((await exportPdf(snapshot)).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("preserves separate source namespaces and explicit imported status", async () => {
    const snapshot = await fixture(false);
    const planning: Source = {
      id: "accessibility-fixture",
      name: "Local building survey",
      url: "",
      vintage: "2025",
      license: "Test",
      kind: "observed",
    };
    snapshot.place.sources.push(planning);
    snapshot.scenario.accessibility!.captures.car!.origin = "imported";
    expect(reportPlanningSources(snapshot)).toEqual([planning]);
    expect(reportSources(snapshot).map((s) => s.name)).toEqual([
      "Local building survey",
      "Synthetic test evidence (jobs accessibility car capture)",
      "Synthetic test evidence (jobs accessibility walk capture)",
    ]);
    expect(
      accessibilityReportInventory(snapshot)[0].contextDescription,
    ).toMatch(/^Imported evidence; not verified/);
    expect(exportAccessibilityCsv(snapshot)).toContain('"imported"');
  });
  it("neutralizes CSV formulas and rejects oversized appendices without dropping evidence", async () => {
    const snapshot = await fixture();
    snapshot.scenario.id = "=untrusted";
    expect(exportAccessibilityCsv(snapshot)).toContain('"\'=untrusted"');
    const evidence = snapshot.scenario.accessibility!;
    evidence.captures.car!.capture.notes.push("x".repeat(200_001));
    expect(() => assertAccessibilityDocumentLimit(snapshot)).toThrow(
      /too large/,
    );
    expect(evidence.captures.car!.capture.notes.at(-1)).toHaveLength(200_001);
    delete snapshot.scenario.accessibility;
    expect(() => exportAccessibilityCsv(snapshot)).toThrow(
      /no jobs accessibility capture/,
    );
  });
});

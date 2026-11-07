import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import {
  applyCommand,
  createRetailScenario,
  createRetailCategory,
  USER_RETAIL_SOURCE,
  projectWithRetailVersion,
  type Place,
} from "@urban/core";
import { calculateImpact, createProject } from "@urban/models";
import {
  exportRetailCsv,
  exportDocx,
  exportPdf,
  exportXlsx,
  exportGeoJson,
  type ReportSnapshot,
} from "./exports";
import {
  retailReportInventory,
  assertRetailDocumentLimit,
} from "./report-retail";

function fixture(): ReportSnapshot {
  const place: Place = {
    id: "retail-report",
    name: "Synthetic retail report",
    city: "QA",
    state: "AZ",
    zip: "85004",
    center: [-112, 33],
    bounds: [-112.01, 32.99, -111.99, 33.01],
    boundary: [
      [-112.01, 32.99],
      [-111.99, 32.99],
      [-111.99, 33.01],
      [-112.01, 33.01],
      [-112.01, 32.99],
    ],
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-05T00:00:00Z",
    extentLabel: "Synthetic retail report study",
  };
  let project = createProject(place);
  const retail = createRetailScenario(place, 0);
  retail.context = {
    ...retail.context,
    referenceYear: 2024,
    dollarYear: 2024,
    comparabilityConfirmed: true,
    disjointCategoriesConfirmed: true,
  };
  const measure = (value: number) => ({
    status: "available" as const,
    value,
    sourceId: USER_RETAIL_SOURCE.id,
  });
  retail.categories = [
    {
      ...createRetailCategory("Groceries"),
      code: "groceries",
      baselineDemand: measure(1000000),
      baselineSales: measure(800000),
      salesPerEstablishment: measure(500000),
      annualSalesCapacity: 200000,
      captureShare: 0.5,
      displacementShare: 0.2,
    },
    {
      ...createRetailCategory("Household goods"),
      code: "household",
      baselineDemand: measure(200000),
      baselineSales: {
        status: "suppressed",
        value: null,
        sourceId: USER_RETAIL_SOURCE.id,
        note: "Suppressed source cell retained",
      },
      salesPerEstablishment: { status: "missing", value: null },
      annualSalesCapacity: 50000,
      captureShare: 0.3,
      displacementShare: 0,
    },
  ];
  const scenario = applyCommand(project.scenarios[1], {
    type: "scenario.retail",
    retail,
    sources: [USER_RETAIL_SOURCE],
  });
  project.scenarios[1] = scenario;
  project = projectWithRetailVersion(project, place);
  return {
    project,
    place,
    scenario,
    results: calculateImpact(place, scenario),
    generatedAt: "2026-11-05T00:00:00Z",
    projectVersion: 2,
  };
}
function documentXml(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("No ZIP directory");
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
  throw new Error("Missing Word document");
}
describe("retail report evidence", () => {
  it("exports complete category values, suppressed states, assumptions and source rights in PDF/Word/XLSX/GIS", async () => {
    const snapshot = fixture(),
      inventory = retailReportInventory(snapshot)!;
    expect(inventory.resolved.categories[0]).toMatchObject({
      grossCapturedSales: 100000,
      displacedSales: 20000,
      netNewSales: 80000,
      scenarioGap: 120000,
    });
    expect(inventory.resolved.categories[1].baselineSales).toBeNull();
    expect(inventory.contextDescription).toContain("constant 2024 USD/year");
    const geo = exportGeoJson(snapshot);
    expect(geo.metadata.retail).toEqual(snapshot.scenario.retail);
    expect(geo.metadata.retailResults).toEqual(inventory.resolved);
    const xml = documentXml(await exportDocx(snapshot));
    for (const text of [
      "Retail category evidence and opportunity",
      "Groceries",
      "Household goods",
      "80,000",
      "Suppressed",
      "Annual capture calculation",
      "user-attested permitted",
      "not permitted",
      "Suppressed source cell retained",
    ])
      expect(xml).toContain(text);
    const pdf = await exportPdf(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const rows = workbook.getWorksheet("Retail categories")!;
    expect(rows.rowCount).toBe(3);
    expect(rows.getRow(2).getCell(12).value).toBe(80000);
    expect(rows.getRow(3).getCell(7).value).toBeNull();
    const inputs = workbook.getWorksheet("Retail inputs")!;
    expect(inputs.getRow(3).getCell(6).value).toBe("suppressed");
    expect(inputs.getRow(3).getCell(7).value).toBeNull();
    expect(
      JSON.stringify(
        workbook.getWorksheet("Retail evidence")!.getSheetValues(),
      ),
    ).toContain("not permitted");
  });
  it("retains raw values in stale/context-only exports while withholding stale proposal results and protects CSV text", () => {
    const snapshot = fixture();
    snapshot.scenario.retail!.context.relationshipToStudyArea = "context-only";
    snapshot.scenario.retail!.context.horizon = 10;
    snapshot.scenario.retail!.categories[0].name =
      '=HYPERLINK("https://example.test")';
    snapshot.results = calculateImpact(snapshot.place, snapshot.scenario);
    const inventory = retailReportInventory(snapshot)!;
    expect(inventory.resolved.status).toBe("stale");
    expect(inventory.resolved.categories[0].baselineSales).toBe(800000);
    expect(inventory.resolved.categories[0].scenarioSales).toBeNull();
    expect(inventory.contextDescription).toContain("context-only");
    expect(inventory.notes.join(" ")).toContain("No geographic scaling");
    const csv = exportRetailCsv(snapshot);
    expect(csv).toContain("\"'=HYPERLINK(");
    expect(csv).toContain('"800000"');
    expect(csv).toContain('"suppressed"');
    expect(csv).toContain('"stale"');
    expect(csv).toContain("source_rights_json");
  });
  it("bounds native appendices explicitly without truncating CSV or complete data", () => {
    const snapshot = fixture();
    for (let i = 0; i < 64; i++)
      snapshot.scenario.retail!.sourceRights.push({
        sourceId: `extra-${i}`,
        authorizedPrivateUse: true,
        publicRedistribution: false,
        statement: "x".repeat(2000),
      });
    expect(() => assertRetailDocumentLimit(snapshot)).toThrow(/too large/);
    expect(exportRetailCsv(snapshot)).toContain("extra-63");
  });
  it("neutralizes control-prefixed formulas and records the exact model version", () => {
    const snapshot = fixture();
    for (const value of [
      "\u0000=1+1",
      "\u0001+1",
      "\ttext",
      "\rtext",
      "\ntext",
      "\uFEFF@SUM(1)",
    ]) {
      snapshot.scenario.retail!.categories[0].name = value;
      const csv = exportRetailCsv(snapshot);
      expect(csv).toContain(`"'${value}"`);
      expect(csv).toContain('"model_version"');
      expect(csv).toContain(`"${snapshot.results.modelVersion}"`);
    }
  });
  it("rejects category recomputation against a different frozen model", async () => {
    const snapshot = fixture();
    snapshot.results.modelVersion = "0.5.0";
    expect(() => retailReportInventory(snapshot)).toThrow(
      /different model version/,
    );
    expect(() => exportRetailCsv(snapshot)).toThrow(/different model version/);
    expect(() => exportGeoJson(snapshot)).toThrow(/different model version/);
    await expect(exportDocx(snapshot)).rejects.toThrow(
      /different model version/,
    );
    await expect(exportPdf(snapshot)).rejects.toThrow(
      /different model version/,
    );
    await expect(exportXlsx(snapshot)).rejects.toThrow(
      /different model version/,
    );
  });
});

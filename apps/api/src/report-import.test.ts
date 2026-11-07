import { it, expect, vi } from "vitest";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import {
  exportCsv,
  exportGeoJson,
  exportPdf,
  exportDocx,
  exportXlsx,
} from "./exports";
import { buildingReportItems } from "./report-buildings";
import { importSourceNotes, inputNotes } from "./report-content";
import { importReportFixture } from "./test-fixtures/import-report";
function unzip(buffer: Buffer) {
  let end = buffer.length - 22;
  while (buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const result = new Map<string, string>();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const method = buffer.readUInt16LE(offset + 10),
      size = buffer.readUInt32LE(offset + 20),
      n = buffer.readUInt16LE(offset + 28),
      e = buffer.readUInt16LE(offset + 30),
      c = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42),
      name = buffer.subarray(offset + 46, offset + 46 + n).toString(),
      start =
        local +
        30 +
        buffer.readUInt16LE(local + 26) +
        buffer.readUInt16LE(local + 28),
      data = buffer.subarray(start, start + size);
    result.set(name, (method === 8 ? inflateRawSync(data) : data).toString());
    offset += 46 + n + e + c;
  }
  return result;
}
function csv(text: string) {
  return text
    .trim()
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .map((line) => {
      const row: string[] = [];
      let value = "",
        quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (quoted && line[i + 1] === '"') {
            value += '"';
            i++;
          } else quoted = !quoted;
        } else if (c === "," && !quoted) {
          row.push(value);
          value = "";
        } else value += c;
      }
      row.push(value);
      return row;
    });
}
it("retains unknowns, zeros, missing contributors and complete import provenance in structured exports", async () => {
  const s = importReportFixture(),
    json = exportGeoJson(s),
    items = buildingReportItems(s);
  expect(items.find((b) => b.id === "unknown-import")).toMatchObject({
    units: null,
    jobs: null,
    grossFloorAreaSqm: null,
    parkingSupply: null,
  });
  expect(items.find((b) => b.id === "unknown-import")!.summary).toContain(
    "Unknown homes",
  );
  expect(items.find((b) => b.id === "zero-import")!.summary).toContain(
    "0 homes",
  );
  const f = json.features.find((f) => f.id === "unknown-import")!;
  expect(f.properties).toMatchObject({
    units: null,
    height: null,
    attributeProvenance: { version: 1 },
  });
  expect(
    json.metadata.sources.find((x) => x.id === "mapped-upload")?.import,
  ).toEqual(s.scenario.sources![0].import);
  const [headers, ...rows] = csv(exportCsv(s)),
    row = rows.find((r) => r[0] === "housing.units")!;
  expect(row[headers.indexOf("scenario")]).toBe("");
  expect(row[headers.indexOf("scenario_known_subtotal")]).toBe("6");
  expect(
    JSON.parse(row[headers.indexOf("scenario_missing_building_ids")]),
  ).toEqual(["unknown-import"]);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await exportXlsx(s)) as never);
  const score = book.getWorksheet("Scorecard")!,
    sr = score.getRow(2);
  expect(sr.getCell(5).value).toBeNull();
  expect(sr.getCell(13).value).toBe(6);
  const inventory = book.getWorksheet("Import provenance")!,
    parts: string[] = [];
  inventory.eachRow((r, i) => {
    if (
      i > 1 &&
      r.getCell(1).value === "mapped-upload" &&
      r.getCell(2).value === "import"
    )
      parts.push(String(r.getCell(4).value));
  });
  expect(JSON.parse(parts.join(""))).toEqual(s.scenario.sources![0].import);
  const buildingSheet = book.getWorksheet("Building programs")!;
  const names = buildingSheet.getRow(1).values as string[];
  let unknownRow: ExcelJS.Row | undefined;
  buildingSheet.eachRow((r) => {
    if (r.getCell(names.indexOf("Building ID")).value === "unknown-import")
      unknownRow = r;
  });
  expect(unknownRow!.getCell(names.indexOf("Homes")).value).toBeNull();
});
it("prints Unknown and attribution in native PDF/Word and labels partial contributions without creating full totals", async () => {
  const s = importReportFixture(),
    text: string[] = [];
  const original = PDFDocument.prototype.text,
    spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: Parameters<typeof original>
    ) {
      text.push(String(args[0]));
      return original.apply(this, args);
    });
  try {
    await exportPdf(s);
  } finally {
    spy.mockRestore();
  }
  const pdf = text.join("\n");
  expect(pdf).toContain("Unknown homes");
  expect(pdf).toContain("0 homes");
  expect(pdf).not.toContain("null homes");
  expect(pdf).toContain("Known subtotal: 6");
  expect(pdf).toContain("Normalized GeoJSON SHA-256");
  expect(pdf).toContain("public redistribution");
  const word = unzip(await exportDocx(s)).get("word/document.xml")!;
  expect(word).toContain("Unknown homes");
  expect(word).toContain("Blank mapped cell remains unknown");
  expect(word).toContain("Mapped building inventory review");
  const source = s.scenario.sources![0];
  expect(importSourceNotes(source).join(" ")).toContain(
    source.import!.upload.sha256,
  );
  expect(inputNotes(s.results.metrics[0]).join(" ")).toContain(
    "not a complete total",
  );
});

it("keeps every scorecard domain heading with its table header for the nullable report fixture", async () => {
  const entries: { text: string; page: unknown }[] = [],
    s = importReportFixture(),
    original = PDFDocument.prototype.text;
  const spy = vi
    .spyOn(PDFDocument.prototype, "text")
    .mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: Parameters<typeof original>
    ) {
      entries.push({ text: String(args[0]), page: this.page });
      return original.apply(this, args);
    });
  try {
    await exportPdf(s);
  } finally {
    spy.mockRestore();
  }
  const start = entries.findIndex((e) => e.text === "Full scorecard"),
    end = entries.findIndex((e) => e.text === "Methods and limitations");
  for (const domain of new Set(s.results.metrics.map((m) => m.domain))) {
    const index = entries.findIndex(
      (e, i) => i > start && i < end && e.text === domain,
    );
    expect(index).toBeGreaterThan(start);
    expect(entries[index + 1].text).toBe("Measure");
    expect(entries[index + 1].page).toBe(entries[index].page);
  }
});

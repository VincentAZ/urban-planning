import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { fiscalContentHash, fiscalCashFlowCSV } from "@urban/core";
import { calculateImpact } from "@urban/models";
import {
  exportFiscalCsv,
  exportXlsx,
  exportGeoJson,
  exportRecords,
} from "./exports";
import { fiscalReportFixture } from "./fiscal-report-fixture";
import { fiscalReportInventory } from "./report-fiscal";
import {
  reportDigest,
  reportSources,
  sourceReferences,
} from "./report-content";
import { fiscalHTML } from "../../web/src/lib/fiscal-export";

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\uFEFF" && i === 0) continue;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (quoted || c !== "\r") field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

describe("frozen fiscal evidence exports", () => {
  it("matches hand-calculated time-zero, annual, offer and paired sensitivity outcomes", () => {
    const s = fiscalReportFixture();
    const r = s.results.fiscal!;
    const c = r.base!;
    expect(r.status).toBe("ready");
    // Existing: 100000 ×1% −10×20 =800/year; added: 50000×1% −5×20 =400/year.
    expect(c.baseline.totals.netRevenue).toBe(16000);
    expect(c.withoutOffer.totals.netRevenue).toBe(24000);
    expect(c.withOffer.totals.netRevenue).toBe(22500); // 24000 −1000 upfront −250×2.
    expect(c.incremental.withOffer.netRevenue).toBe(6500);
    expect(c.withOffer.rows[0].netRevenue).toBe(-1000);
    expect(c.withOffer.rows[1].netRevenue).toBe(950);
    expect(c.withOffer.rows[3].netRevenue).toBe(1200);
    expect(c.withOffer.rows[1].discountedNet).toBeCloseTo(950 / 1.1, 9);
    expect(c.offerCost.npv).toBeCloseTo(1000 + 250 / 1.1 + 250 / 1.21, 9);
    expect(c.payback).toEqual({ status: "reached", year: 4 });
    expect(r.cases[0].incremental.withOffer.netRevenue).toBe(1750); // 150×20−1000−125×2.
    expect(r.cases[0].payback).toEqual({ status: "reached", year: 9 });
    expect(r.cases[1].incremental.withOffer.netRevenue).toBe(5500); // 350×20−1500.
  });

  it("retains every row, numeric zero, full inputs and source evidence in CSV", () => {
    const s = fiscalReportFixture();
    const csv = exportFiscalCsv(s);
    const rows = csvRows(csv);
    expect(csv).toBe(
      fiscalCashFlowCSV(s.project.fiscalStudy!, s.scenario, s.results.fiscal!),
    );
    expect(rows).toHaveLength(335);
    expect(rows.every((row) => row.length === rows[0].length)).toBe(true);
    const columns = Object.fromEntries(rows[0].map((key, i) => [key, i]));
    const first = rows.find(
      (row) =>
        row[0] === "annual" &&
        row[columns.case_id] === "reference" &&
        row[columns.alternative] === "Development with offer" &&
        row[columns.year_zero_is_upfront] === "0",
    )!;
    expect(first[columns.net_revenue_usd]).toBe("-1000");
    expect(first[columns.property_revenue_usd]).toBe("0");
    expect(first[columns.fiscal_year]).toBe("");
    expect(JSON.parse(rows[1][columns.details_json]).study).toEqual(
      s.project.fiscalStudy,
    );
    const input = rows.find((row) => row[0] === "case")!;
    expect(
      JSON.parse(input[columns.details_json]).assumptions.proposal,
    ).toEqual(s.scenario.assumptions);
  });

  it("preserves unknown values as blanks and spreadsheet-formula-like names as text", () => {
    const s = fiscalReportFixture();
    s.place.buildings[0].jobs = null;
    s.place.buildings[0].attributeProvenance = {
      version: 1,
      fields: { jobs: { status: "missing", sourceId: "qa-planning" } },
    };
    s.project.fiscalStudy!.placeHash = fiscalContentHash(s.place);
    s.scenario.fiscal!.cases[0].name = "=1+1";
    s.results = calculateImpact(
      s.place,
      s.scenario,
      {},
      { fiscalStudy: s.project.fiscalStudy },
    );
    const rows = csvRows(exportFiscalCsv(s));
    const h = Object.fromEntries(rows[0].map((key, i) => [key, i]));
    expect(rows.some((row) => row[h.case_name] === "'=1+1")).toBe(true);
    const annual = rows.find(
      (row) =>
        row[0] === "annual" &&
        row[h.alternative] === "Frozen baseline" &&
        row[h.year_zero_is_upfront] === "1",
    )!;
    expect(annual[h.service_cost_usd]).toBe("");
    expect(annual[h.net_revenue_usd]).toBe("");
    expect(annual[h.sales_revenue_usd]).toBe("0");
  });

  it("uses exact frozen results in native workbook and retained record exports", async () => {
    const s = fiscalReportFixture();
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Uint8Array.from(await exportXlsx(s)).buffer);
    expect(book.getWorksheet("Fiscal annual flows")!.rowCount).toBe(316); // 3 cases ×5 alternatives ×21 rows + header.
    expect(book.getWorksheet("Fiscal comparison")!.rowCount).toBe(16);
    const evidence = book.getWorksheet("Fiscal evidence")!;
    const parts: string[] = [];
    evidence.eachRow((row) => {
      if (row.getCell(1).value === "Exact frozen fiscal results JSON")
        parts.push(String(row.getCell(3).value));
    });
    expect(JSON.parse(parts.join(""))).toEqual(s.results.fiscal);
    expect(exportGeoJson(s).metadata.fiscalResults).toEqual(s.results.fiscal);
    expect(exportRecords(s, [], []).project.fiscalStudy).toEqual(
      s.project.fiscalStudy,
    );
    expect(reportSources(s).some((source) => source.id === "qa-fiscal")).toBe(
      true,
    );
  });

  it("refuses stale identities and denied source exports without recomputing", async () => {
    const s = fiscalReportFixture();
    const hash = reportDigest(s);
    s.project.fiscalStudy!.applicability.applicabilityNotes += " Changed.";
    expect(reportDigest(s)).not.toBe(hash);
    expect(() => fiscalReportInventory(s)).toThrow(/matching frozen/i);
    expect(() =>
      fiscalHTML(s.place, s.scenario, s.results, s.project.fiscalStudy),
    ).toThrow(/matching frozen/i);
    const restricted = fiscalReportFixture();
    restricted.project.fiscalStudy!.profile.sources[0].rights!.export = false;
    expect(() => exportFiscalCsv(restricted)).toThrow(/permissions/i);
    await expect(exportXlsx(restricted)).rejects.toThrow(/permissions/i);
  });

  it("escapes authored HTML and carries the clock, all annual net rows and citations", () => {
    const s = fiscalReportFixture();
    s.scenario.fiscal!.cases[0].description =
      '<script>alert("x")</script> review';
    s.results = calculateImpact(
      s.place,
      s.scenario,
      {},
      { fiscalStudy: s.project.fiscalStudy },
    );
    const html = fiscalHTML(
      s.place,
      s.scenario,
      s.results,
      s.project.fiscalStudy,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/Time zero/g)).toHaveLength(4); // one clock explanation and three case tables.
    expect(html).toContain("FY 2046");
    expect(html).toContain("Authored fiscal arithmetic worksheet");
    expect(html).toContain("same development");
  });

  it("keeps fiscal citations separate from colliding planning-source identifiers", () => {
    const s = fiscalReportFixture();
    const metric = s.results.metrics.find((row) => row.domain === "Fiscal")!;
    expect(sourceReferences(s, metric)).toContain(
      "Authored fiscal arithmetic worksheet (fiscal profile source qa-fiscal",
    );
    expect(sourceReferences(s, metric)).not.toContain(
      "qa-fiscal (source metadata unavailable)",
    );
    s.project.fiscalStudy!.profile.sources[0].id = "qa-planning";
    const references = sourceReferences(s, {
      ...metric,
      sourceIds: ["qa-planning"],
    });
    expect(references).toContain("fiscal profile source qa-planning");
    expect(references).toContain(
      "planning inventory [1] has the same source ID",
    );
    expect(reportSources(s)).toHaveLength(2);
  });
});

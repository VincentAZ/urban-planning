import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  createHousingAffordabilityScenario,
  housingAffordabilityCSV,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { housingReportFixture } from "./housing-report-fixture";
import {
  housingReportInventory,
  assertHousingDocumentLimit,
} from "./report-housing";
import {
  exportHousingCsv,
  exportCsv,
  exportXlsx,
  exportGeoJson,
  exportRecords,
} from "./exports";
import { housingHTML } from "../../web/src/lib/housing-export";
import { reportDigest, reportSources } from "./report-content";
const recalculate = (s: ReturnType<typeof housingReportFixture>) => {
  s.results = calculateImpact(
    s.place,
    s.scenario,
    {},
    { housingIncomeLimits: s.project.housingIncomeLimits },
  );
};

describe("housing exports preserve frozen unit-level evidence", () => {
  it("reproduces exact monthly costs, escrow inclusions and overlapping ceiling counts", () => {
    const s = housingReportFixture(),
      h = housingReportInventory(s)!;
    expect(h.resolution.status).toBe("ready");
    expect(
      h.resolution.baseline.rows.map((r) => [
        r.grossMonthlyCents,
        r.requiredAnnualIncome,
      ]),
    ).toEqual([
      [50000, 20000],
      [100000, 40000],
    ]);
    expect(
      h.resolution.proposal.rows.map((r) => [
        r.grossMonthlyCents,
        r.requiredAnnualIncome,
      ]),
    ).toEqual([
      [80000, 32000],
      [170000, 68000],
    ]);
    expect(h.resolution.baseline.cumulative).toEqual({
      extremelyLow: { estimate: 6, knownSubtotal: 6 },
      veryLow: { estimate: 10, knownSubtotal: 10 },
      low: { estimate: 10, knownSubtotal: 10 },
    });
    expect(h.resolution.proposal.cumulative.low.estimate).toBe(6);
    expect(h.resolution.delta).toEqual({
      extremelyLow: -6,
      veryLow: -4,
      low: -4,
    });
    expect(exportHousingCsv(s)).toBe(
      housingAffordabilityCSV(s.scenario, s.results.affordability!, h.packs),
    );
    expect(exportHousingCsv(s)).toContain('"68000"');
    expect(exportHousingCsv(s)).toContain('"false"');
    expect(exportHousingCsv(s)).toContain('"reconciliation"');
    expect(h.resolution.proposal.bands["above-low"].estimate).toBe(4);
  });
  it("keeps complete records and typed workbook values without inflation or formulas", async () => {
    const s = housingReportFixture();
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Uint8Array.from(await exportXlsx(s)).buffer);
    expect(book.getWorksheet("Housing cost groups")!.getCell("J5").value).toBe(
      1700,
    );
    expect(book.getWorksheet("Housing comparison")!.getCell("D2").value).toBe(
      -6,
    );
    expect(book.getWorksheet("HUD household limits")!.rowCount).toBe(9);
    const parts: string[] = [];
    book.getWorksheet("Housing evidence")!.eachRow((row) => {
      if (row.getCell(1).value === "Exact frozen housing results JSON")
        parts.push(String(row.getCell(3).value));
    });
    expect(JSON.parse(parts.join(""))).toEqual(s.results.affordability);
    expect(exportGeoJson(s).metadata.housing?.incomeLimits).toEqual(
      s.project.housingIncomeLimits,
    );
    expect(exportRecords(s, [], []).resultBundle.affordability).toEqual(
      s.results.affordability,
    );
    expect(
      reportSources(s).filter((source) => source.id === "housing-synthetic"),
    ).toHaveLength(2);
  });
  it("refuses changed frozen identities and mismatched source-pack bytes", () => {
    const s = housingReportFixture();
    const before = reportDigest(s);
    s.scenario.affordability!.proposalGroups[0].notes += " changed";
    expect(reportDigest(s)).not.toBe(before);
    expect(() => exportHousingCsv(s)).toThrow(/matching frozen/);
    expect(() =>
      housingHTML(s.place, s.project, s.scenario, s.results),
    ).toThrow(/matching frozen/);
    const other = housingReportFixture();
    Object.values(other.project.housingIncomeLimits!)[0].notes.push("tampered");
    expect(() => exportGeoJson(other)).toThrow(/matching retained/);
  });
  it("honors missing and denied permissions across ordinary and specialized exports", async () => {
    const s = housingReportFixture();
    s.scenario.affordability!.sources[0].rights!.export = false;
    recalculate(s);
    for (const exportFn of [
      exportCsv,
      exportHousingCsv,
      exportGeoJson,
      (snap: typeof s) => exportRecords(snap, [], []),
    ])
      expect(() => exportFn(s)).toThrow(/disclosure|permission|export/i);
    await expect(exportXlsx(s)).rejects.toThrow(
      /disclosure|permission|export/i,
    );
    expect(() =>
      housingHTML(s.place, s.project, s.scenario, s.results),
    ).toThrow(/permit export/);
    delete s.scenario.affordability!.sources[0].rights;
    expect(() => exportHousingCsv(s)).toThrow(/disclosure|permission|export/i);
  });
  it("does not turn unknown costs or stale geometry into zero affordability", () => {
    const s = housingReportFixture();
    const a = s.scenario.affordability!;
    a.proposalGroups[0].costs[1] = {
      ...a.proposalGroups[0].costs[1],
      state: "unknown",
    } as (typeof a.proposalGroups)[0]["costs"][number];
    // Rebuild the item without a forbidden known-value field.
    const c = a.proposalGroups[0].costs[1];
    a.proposalGroups[0].costs[1] = {
      id: c.id,
      kind: c.kind,
      provenance: c.provenance,
      state: "unknown",
    };
    s.scenario.affordability = createHousingAffordabilityScenario(
      s.place,
      s.scenario,
      a,
      a.review,
    );
    recalculate(s);
    expect(
      housingReportInventory(s)!.resolution.proposal.cumulative.low.estimate,
    ).toBeNull();
    expect(
      housingReportInventory(s)!.resolution.proposal.rows[0].grossMonthlyCents,
    ).toBeNull();
    expect(housingHTML(s.place, s.project, s.scenario, s.results)).toContain(
      "Unavailable",
    );
    s.place.buildings[0].units = 8;
    recalculate(s);
    expect(housingReportInventory(s)!.resolution.status).toBe("stale");
  });
  it("escapes HTML and spreadsheet-like identifiers while retaining full source rows", () => {
    const s = housingReportFixture();
    const a = s.scenario.affordability!;
    a.proposalGroups[0].id = "=1+1";
    a.proposalGroups[0].notes = '<script>alert("x")</script>';
    s.scenario.affordability = createHousingAffordabilityScenario(
      s.place,
      s.scenario,
      a,
      a.review,
    );
    recalculate(s);
    const html = housingHTML(s.place, s.project, s.scenario, s.results);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Imported income limits");
    expect(html).toContain("retained source rows");
    expect(exportHousingCsv(s)).toContain('"\'=1+1"');
  });
  it("rejects oversized documents while leaving complete machine-readable exports available", () => {
    const s = housingReportFixture();
    const a = s.scenario.affordability!;
    a.proposalGroups = Array.from({ length: 61 }, (_, i) => ({
      ...a.proposalGroups[0],
      id: `group-${i}`,
      units: 1,
    }));
    s.scenario.affordability = createHousingAffordabilityScenario(
      s.place,
      s.scenario,
      a,
      a.review,
    );
    recalculate(s);
    expect(() => assertHousingDocumentLimit(s)).toThrow(/appendix limit/);
    expect(exportHousingCsv(s)).toContain('"group-60"');
  });
});

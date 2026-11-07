import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createScenario, resolveRetail } from "@urban/models";
import { USER_RETAIL_SOURCE, type Place } from "@urban/core";
import { createRetailDraft, newRetailSource, readRetailDraft } from "./draft";
import { RetailEvidence, retailCSV, retailCSVCell } from "./RetailOverview";

const place: Place = {
  id: "retail-ui-fixture",
  name: "Fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0.005, 0.005],
  bounds: [0, 0, 0.01, 0.01],
  boundary: [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
    [0, 0],
  ],
  buildings: [],
  roads: [],
  sources: [USER_RETAIL_SOURCE],
  coverage: [],
  extentLabel: "Synthetic retail study",
  loadedAt: "2026-11-05T00:00:00Z",
};
function fixture() {
  const scenario = createScenario("Retail UI");
  const draft = createRetailDraft(place, scenario);
  const category = draft.categories[0];
  category.name = "Groceries";
  category.code = "food";
  category.baselineDemand = {
    status: "available",
    value: "1000000",
    sourceId: USER_RETAIL_SOURCE.id,
    note: "Entered annual demand",
  };
  category.baselineSales = {
    status: "available",
    value: "600000",
    sourceId: USER_RETAIL_SOURCE.id,
    note: "",
  };
  category.salesPerEstablishment = {
    status: "missing",
    value: "",
    sourceId: "",
    note: "No benchmark supplied",
  };
  draft.context.comparabilityConfirmed = true;
  draft.context.disjointCategoriesConfirmed = true;
  return { scenario, draft, category };
}
describe("retail draft integrity", () => {
  it("distinguishes zero, unknown and an optional keep-reference override", () => {
    const { draft, category } = fixture();
    category.baselineSales.value = "0";
    const parsed = readRetailDraft(draft).retail!;
    expect(parsed.categories[0].baselineSales.value).toBe(0);
    expect(parsed.categories[0].salesPerEstablishment.value).toBeNull();
    expect(parsed.categories[0].scenarioDemand).toBeNull();
    category.scenarioDemand = "0";
    expect(readRetailDraft(draft).retail!.categories[0].scenarioDemand).toBe(0);
  });
  it("retains invalid numeric buffers through unrelated edits and never falls back to the last valid number", () => {
    const { draft, category } = fixture();
    category.baselineDemand.value = "";
    const switched = {
      ...draft,
      context: { ...draft.context, geography: "Another declared area" },
    };
    expect(readRetailDraft(switched)).toMatchObject({
      retail: null,
      issues: [{ field: `${category.id}.baselineDemand` }],
    });
    expect(switched.categories[0].baselineDemand.value).toBe("");
    category.baselineDemand.value = "-10";
    expect(readRetailDraft(draft).retail).toBeNull();
    category.baselineDemand.value = "1000000000001";
    expect(readRetailDraft(draft).retail).toBeNull();
    category.baselineDemand.value = "0";
    expect(
      readRetailDraft(draft).retail!.categories[0].baselineDemand.value,
    ).toBe(0);
  });
  it("requires a source for suppressed values without converting their retained buffer to a number", () => {
    const { draft, category } = fixture();
    category.baselineSales = {
      status: "suppressed",
      value: "650000",
      sourceId: "",
      note: "Suppressed by supplier",
    };
    expect(readRetailDraft(draft).retail).toBeNull();
    category.baselineSales.sourceId = USER_RETAIL_SOURCE.id;
    expect(
      readRetailDraft(draft).retail!.categories[0].baselineSales,
    ).toMatchObject({ status: "suppressed", value: null });
    expect(category.baselineSales.value).toBe("650000");
  });
  it("does not retain an unused unfinished source or remove rights for used sources", () => {
    const { draft } = fixture();
    const unused = newRetailSource();
    draft.sources.push(unused);
    draft.sourceRights.push({
      sourceId: unused.id,
      authorizedPrivateUse: false,
      publicRedistribution: false,
      statement: "",
    });
    const parsed = readRetailDraft(draft).retail!;
    expect(parsed.sourceRights.map((right) => right.sourceId)).toEqual([
      USER_RETAIL_SOURCE.id,
    ]);
    expect(draft.sourceRights).toHaveLength(2);
  });
  it("edits do not mutate the captured study or its numeric source values", () => {
    const { scenario, draft } = fixture();
    scenario.retail = readRetailDraft(draft).retail!;
    const captured = JSON.stringify(scenario.retail);
    const reopened = createRetailDraft(place, scenario);
    reopened.categories[0].baselineDemand.value = "20";
    reopened.context.classification.version = "New revision";
    reopened.sourceRights[0].statement = "Changed draft statement";
    expect(JSON.stringify(scenario.retail)).toBe(captured);
  });
});
describe("retail category CSV", () => {
  it("resolves the permitted implicit authored source for imported studies without rewriting the snapshot", () => {
    const { scenario, draft } = fixture();
    scenario.retail = readRetailDraft(draft).retail!;
    scenario.sources = [];
    const importedPlace = { ...place, sources: [] };
    const before = JSON.stringify({ scenario, place: importedPlace });
    const resolution = resolveRetail(importedPlace, scenario)!;
    const csv = retailCSV(importedPlace, scenario, resolution);
    expect(csv).toContain('""name"":""User retail analysis""');
    const html = renderToStaticMarkup(
      createElement(RetailEvidence, {
        place: importedPlace,
        scenario,
        resolution,
      }),
    );
    expect(html).toContain("User retail analysis");
    expect(html).not.toContain("Source record unavailable");
    expect(JSON.stringify({ scenario, place: importedPlace })).toBe(before);
  });
  it("neutralizes spreadsheet formulas and control prefixes while keeping numbers numeric", () => {
    for (const text of [
      "=1+1",
      "+SUM(A1)",
      "-1+2",
      "@SUM(A1)",
      "  =1",
      "\ttext",
      "\rtext",
      "\ntext",
    ])
      expect(retailCSVCell(text)).toBe(`"'${text}"`);
    expect(retailCSVCell(-12)).toBe('"-12"');
    expect(retailCSVCell(0)).toBe('"0"');
    expect(retailCSVCell(null)).toBe('""');
    expect(retailCSVCell('A "quoted" category')).toBe(
      '"A ""quoted"" category"',
    );
  });
  it("retains source rights, statuses and the same resolver values without inventing missing benchmarks", () => {
    const { scenario, draft, category } = fixture();
    category.name = "=Untrusted category";
    category.annualSalesCapacity = "200000";
    category.captureShare = "50";
    category.displacementShare = "20";
    scenario.retail = readRetailDraft(draft).retail!;
    scenario.sources = [USER_RETAIL_SOURCE];
    const resolution = resolveRetail(place, scenario)!;
    expect(resolution.categories[0].netNewSales).toBe(160000);
    const csv = retailCSV(place, scenario, resolution);
    expect(csv).toContain('"\'=Untrusted category"');
    expect(csv).toContain('"160000"');
    expect(csv).toContain('"missing"');
    expect(csv).toContain('"Assumption citation"');
    expect(csv).toContain('"Resolved scenario demand"');
    expect(csv).toContain('"Baseline establishment equivalents"');
    expect(csv).toContain('""publicRedistribution"":false');
    expect(csv).toContain('"No benchmark supplied"');
  });
});

import { describe, it, expect } from "vitest";
import {
  createRetailScenario,
  createRetailCategory,
  USER_RETAIL_SOURCE,
  canonicalJSON,
  type Place,
  type RetailMeasure,
} from "@urban/core";
import {
  createScenario,
  resolveRetail,
  calculateImpact,
  buildingPreset,
} from "./index";
const place: Place = {
  id: "retail-model-fixture",
  name: "Fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0, 0],
  bounds: [-0.01, -0.01, 0.01, 0.01],
  boundary: [
    [-0.01, -0.01],
    [0.01, -0.01],
    [0.01, 0.01],
    [-0.01, 0.01],
    [-0.01, -0.01],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Synthetic retail area",
};
const value = (n: number): RetailMeasure => ({
  status: "available",
  value: n,
  sourceId: USER_RETAIL_SOURCE.id,
});
function prepared() {
  const s = createScenario("Retail");
  s.retail = createRetailScenario(place, 0);
  s.retail.context.comparabilityConfirmed = true;
  s.retail.context.disjointCategoriesConfirmed = true;
  s.sources = [USER_RETAIL_SOURCE];
  const c = s.retail.categories[0];
  c.baselineDemand = value(1000);
  c.baselineSales = value(400);
  c.salesPerEstablishment = value(200);
  c.annualSalesCapacity = 500;
  c.captureShare = 0.5;
  c.displacementShare = 0.2;
  return { s, r: s.retail, c };
}
const metric = (s: ReturnType<typeof createScenario>, id: string) =>
  calculateImpact(place, s).metrics.find((m) => m.id === id)!;
describe("category retail accounting", () => {
  it("labels absent and stale scorecard values unavailable while retaining known authored zeros", () => {
    const { s, c } = prepared();
    const ids = [
      "economy.retailCaptured",
      "economy.retailGap",
      "economy.businessPotential",
    ];
    c.baselineSales = {
      status: "suppressed",
      value: null,
      sourceId: USER_RETAIL_SOURCE.id,
    };
    for (const id of ids)
      expect(metric(s, id)).toMatchObject({
        value: null,
        status: "unavailable",
      });
    c.baselineSales = value(0);
    c.baselineDemand = value(0);
    for (const id of ids)
      expect(metric(s, id)).toMatchObject({ value: 0, status: "incomplete" });
    s.horizon = 10;
    for (const id of ids)
      expect(metric(s, id)).toMatchObject({
        baseline: 0,
        value: null,
        status: "unavailable",
      });
    s.horizon = 0;
    c.salesPerEstablishment = { status: "missing", value: null };
    expect(metric(s, "economy.retailGap")).toMatchObject({
      value: 0,
      status: "incomplete",
    });
    expect(metric(s, "economy.businessPotential")).toMatchObject({
      value: null,
      status: "unavailable",
    });
  });
  it("preserves small signed gaps when large category surpluses and deficits cancel", () => {
    const { s, r } = prepared();
    r.categories = [
      {
        ...createRetailCategory("Large gap"),
        baselineDemand: value(1e12),
        baselineSales: value(0),
      },
      {
        ...createRetailCategory("Small gap"),
        baselineDemand: value(1e-9),
        baselineSales: value(0),
      },
      {
        ...createRetailCategory("Large surplus"),
        baselineDemand: value(0),
        baselineSales: value(1e12),
      },
    ];
    expect(resolveRetail(place, s)!.totals.baselineGap).toBe(1e-9);
    r.categories.reverse();
    expect(resolveRetail(place, s)!.totals.baselineGap).toBe(1e-9);
  });
  it("does not treat fully displaced sales as new local revenue", () => {
    const { s, c } = prepared();
    c.displacementShare = 1;
    expect(resolveRetail(place, s)!.totals).toMatchObject({
      grossCapturedSales: 300,
      displacedSales: 300,
      netNewSales: 0,
      scenarioSales: 400,
      scenarioGap: 600,
    });
    c.scenarioDemand = 0;
    expect(resolveRetail(place, s)!.totals).toMatchObject({
      scenarioDemand: 0,
      scenarioSales: 400,
      scenarioGap: -400,
    });
  });
  it("computes capped capture, displacement and signed gap with no double application of capacity", () => {
    const { s, r, c } = prepared(),
      before = canonicalJSON(r);
    let result = resolveRetail(place, s)!;
    expect(result.categories[0]).toMatchObject({
      baselineGap: 600,
      eligibleGap: 600,
      grossCapturedSales: 300,
      displacedSales: 60,
      netNewSales: 240,
      scenarioSales: 640,
      scenarioGap: 360,
      baselineEstablishmentEquivalent: 3,
      scenarioEstablishmentEquivalent: 1.8,
    });
    c.annualSalesCapacity = 100;
    result = resolveRetail(place, s)!;
    expect(result.totals.netNewSales).toBe(80);
    expect(result.totals.scenarioSales).toBe(480);
    expect(JSON.parse(before).categories[0].annualSalesCapacity).toBe(500);
    expect(c.baselineSales.value).toBe(400);
  });
  it("handles surplus without inventing leakage, inbound capture or business openings", () => {
    const { s, c } = prepared();
    c.baselineDemand = value(100);
    c.baselineSales = value(200);
    c.annualSalesCapacity = 999;
    c.captureShare = 1;
    expect(resolveRetail(place, s)!.totals).toMatchObject({
      baselineGap: -100,
      scenarioGap: -100,
      eligibleGap: 0,
      grossCapturedSales: 0,
      netNewSales: 0,
      scenarioSales: 200,
      baselineEstablishmentEquivalent: 0,
      scenarioEstablishmentEquivalent: 0,
    });
  });
  it("retains category-specific inputs and sums only studied disjoint categories", () => {
    const { s, r } = prepared();
    const other = {
      ...createRetailCategory("Other"),
      baselineDemand: value(100),
      baselineSales: value(200),
      salesPerEstablishment: value(500),
      annualSalesCapacity: 999,
      captureShare: 1,
    };
    r.categories.push(other);
    let result = resolveRetail(place, s)!;
    expect(result.totals).toMatchObject({
      baselineDemand: 1100,
      baselineSales: 600,
      scenarioSales: 840,
      scenarioGap: 260,
      netNewSales: 240,
    });
    r.categories.reverse();
    expect(resolveRetail(place, s)!.totals).toEqual(result.totals);
    const gap = metric(s, "economy.retailGap");
    expect(gap.label).toMatch(/Studied-category/);
    expect(gap.caveat).toMatch(/not observed/);
  });
  it("preserves partial and suppressed evidence, optional benchmarks, and null known-subtotals", () => {
    const { s, r, c } = prepared();
    c.salesPerEstablishment = { status: "missing", value: null };
    let result = resolveRetail(place, s)!;
    expect(result.coverage.completeCategories).toBe(1);
    expect(result.totals.scenarioSales).toBe(640);
    expect(result.totals.scenarioEstablishmentEquivalent).toBeNull();
    r.categories.push({
      ...createRetailCategory("Suppressed"),
      baselineDemand: value(500),
      baselineSales: {
        status: "suppressed",
        value: null,
        sourceId: USER_RETAIL_SOURCE.id,
      },
    });
    result = resolveRetail(place, s)!;
    expect(result.totals.baselineSales).toBeNull();
    expect(result.knownSubtotal.baselineSales).toBe(400);
    expect(result.coverage).toEqual({ categories: 2, completeCategories: 1 });
    expect(metric(s, "economy.retailCaptured").value).toBeNull();
    c.baselineSales = { status: "missing", value: null };
    result = resolveRetail(place, s)!;
    expect(result.knownSubtotal.baselineSales).toBeNull();
    expect(result.categories[1].warnings.join(" ")).toMatch(/suppressed/);
  });
  it("keeps true zeros known while a positive capacity with missing demand stays unknown", () => {
    const { s, c } = prepared();
    c.baselineDemand = value(0);
    c.baselineSales = value(0);
    expect(resolveRetail(place, s)!.totals).toMatchObject({
      baselineGap: 0,
      scenarioSales: 0,
      grossCapturedSales: 0,
    });
    c.baselineDemand = { status: "missing", value: null };
    expect(resolveRetail(place, s)!.totals.grossCapturedSales).toBeNull();
    c.annualSalesCapacity = 0;
    expect(resolveRetail(place, s)!.totals).toMatchObject({
      grossCapturedSales: 0,
      netNewSales: 0,
      scenarioSales: 0,
      scenarioGap: null,
    });
  });
  it("uses explicit annual demand without growth and withholds stale horizon proposal results", () => {
    const { s, r, c } = prepared();
    c.scenarioDemand = 2000;
    s.assumptions.annualGrowthRate = 0.2;
    s.assumptions.populationMultiplier = 2;
    s.horizon = 10;
    let result = resolveRetail(place, s)!;
    expect(result.status).toBe("stale");
    expect(result.totals).toMatchObject({
      baselineDemand: 1000,
      baselineSales: 400,
      baselineGap: 600,
      scenarioDemand: null,
      scenarioSales: null,
      netNewSales: null,
    });
    r.context.horizon = 10;
    result = resolveRetail(place, s)!;
    expect(result.totals).toMatchObject({
      scenarioDemand: 2000,
      grossCapturedSales: 500,
      netNewSales: 400,
      scenarioSales: 800,
      scenarioGap: 1200,
    });
  });
  it("retains context geography and never silently links capacity, building area or fiscal tax", () => {
    const { s, r } = prepared();
    r.context.relationshipToStudyArea = "context-only";
    r.context.geography = "Entered regional trade area";
    const before = calculateImpact(place, s);
    s.buildingEdits.added = {
      ...buildingPreset("retail", place.center),
      id: "added",
    };
    expect(resolveRetail(place, s)!.totals.scenarioSales).toBe(640);
    expect(metric(s, "economy.retailGap").geography).toBe(
      "Entered regional trade area",
    );
    const changed = calculateImpact(place, s),
      without = calculateImpact(place, { ...s, retail: undefined });
    for (const id of [
      "fiscal.salesTax",
      "fiscal.netAnnual",
      "mobility.dailyTrips",
      "economy.jobs",
    ]) {
      expect(changed.metrics.find((m) => m.id === id)!.value).toBe(
        without.metrics.find((m) => m.id === id)!.value,
      );
    }
    expect(
      before.metrics.find((m) => m.id === "economy.retailGap")!.value,
    ).toBe(360);
  });
  it("does not replace the legacy evidence path when a persisted retail workbench is absent", () => {
    const { s } = prepared();
    delete s.retail;
    expect(resolveRetail(place, s)).toBeNull();
    expect(metric(s, "economy.retailGap").value).toBeNull();
    const result = calculateImpact(place, s, {
      retail: {
        sourceId: "legacy",
        geography: "Legacy area",
        vintage: "2026",
        residentAnnualDemand: 1000,
        baselineAnnualSales: 400,
        annualSalesPerEstablishment: 200,
        displacedLocalSalesFraction: 0,
      },
    });
    expect(
      result.metrics.find((m) => m.id === "economy.retailGap")!.value,
    ).toBe(600);
  });
});

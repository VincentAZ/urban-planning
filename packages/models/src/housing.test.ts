import { describe, it, expect } from "vitest";
import {
  applyCommand,
  createHousingAffordabilityScenario,
  housingIncomeLimitPackHash,
  housingAffordabilityResolutionSchema,
  projectWithImportedHousing,
  type HousingCostItem,
} from "@urban/core";
import { housingFixture } from "./housing-fixture";
import { calculateImpact } from "./engine";
import { resolveHousingAffordability } from "./housing";
import { createFiscalStudy } from "./fiscal";
import { fiscalFixture } from "./fiscal-fixture";

const resolve = (f: ReturnType<typeof housingFixture>) =>
  resolveHousingAffordability(f.place, f.scenario, f.project);
const review = (f: ReturnType<typeof housingFixture>) => {
  f.scenario.affordability = createHousingAffordabilityScenario(
    f.place,
    f.scenario,
    f.scenario.affordability!,
    f.review,
  );
};
describe("complete housing-cost screening", () => {
  it("enforces component capacity and prohibits overlapping whole-building/component scopes", () => {
    const f = housingFixture(),
      building = f.place.buildings[0];
    building.program = {
      version: 1,
      grossFloorAreaSqm: 1000,
      commonAreaSqm: 0,
      components: [
        {
          id: "homes-a",
          use: "multifamily",
          grossFloorAreaSqm: 600,
          units: 6,
          jobs: 0,
        },
        {
          id: "homes-b",
          use: "multifamily",
          grossFloorAreaSqm: 400,
          units: 4,
          jobs: 0,
        },
      ],
    };
    for (const key of ["baselineGroups", "proposalGroups"] as const)
      f.scenario.affordability![key] = [
        { ...f.group("a", 6), componentId: "homes-a" },
        { ...f.group("b", 4), componentId: "homes-b" },
      ];
    review(f);
    expect(resolve(f).status).toBe("ready");
    f.scenario.affordability!.proposalGroups[0].units = 7;
    f.scenario.affordability!.proposalGroups[1].units = 3;
    review(f);
    expect(resolve(f).proposal.rows[0].reasons.join(" ")).toContain(
      "component",
    );
    expect(resolve(f).proposal.cumulative.low).toEqual({
      estimate: null,
      knownSubtotal: 3,
    });
    f.scenario.affordability!.proposalGroups[0].units = 6;
    f.scenario.affordability!.proposalGroups[1].units = 4;
    delete f.scenario.affordability!.proposalGroups[1].componentId;
    review(f);
    expect(resolve(f).proposal.rows.every((r) => r.status === "stale")).toBe(
      true,
    );
  });
  it("requires a new geography review after moving a building without changing costs or units", () => {
    const f = housingFixture(),
      moved = structuredClone(f.place.buildings[0]);
    if (moved.footprint)
      moved.footprint = moved.footprint.map(([x, y]) => [x + 0.00001, y]);
    f.scenario = applyCommand(f.scenario, {
      type: "building.upsert",
      building: moved,
    });
    const r = resolve(f);
    expect(r.reviewState).toBe("stale");
    expect(r.proposal.rows[0].grossMonthlyCents).toBe(50000);
    expect(r.proposal.cumulative.low.estimate).toBeNull();
    review(f);
    expect(resolve(f).status).toBe("ready");
  });
  it("retains all unassigned units and a genuine empty inventory is a known zero", () => {
    const f = housingFixture();
    f.scenario.affordability!.baselineGroups = [];
    f.scenario.affordability!.proposalGroups = [];
    review(f);
    expect(resolve(f).proposal).toMatchObject({
      totalUnits: 10,
      knownUnits: 10,
      assignedUnits: 0,
      unassignedUnits: 10,
    });
    expect(resolve(f).proposal.cumulative.low).toEqual({
      estimate: null,
      knownSubtotal: 0,
    });
    f.place.buildings = [];
    review(f);
    expect(resolve(f).proposal.cumulative.low).toEqual({
      estimate: 0,
      knownSubtotal: 0,
    });
  });
  it("counts homes at exact published thresholds, with exclusive bands and cumulative counts", () => {
    const f = housingFixture(),
      a = f.scenario.affordability!;
    a.proposalGroups = [
      f.group("eli", 3),
      f.group("vli", 2),
      f.group("li", 1),
      f.group("above", 4),
    ];
    [45000, 95000, 145000, 145001].forEach((value, i) => {
      (
        a.proposalGroups[i].costs[0] as Extract<
          HousingCostItem,
          { state: "separate" }
        >
      ).monthlyCents = value;
    });
    review(f);
    const r = resolve(f);
    expect(r.status).toBe("ready");
    expect(r.proposal.bands).toEqual({
      extremelyLow: { estimate: 3, knownSubtotal: 3 },
      veryLow: { estimate: 2, knownSubtotal: 2 },
      low: { estimate: 1, knownSubtotal: 1 },
      "above-low": { estimate: 4, knownSubtotal: 4 },
    });
    expect(r.proposal.cumulative.low.estimate).toBe(6);
    expect(r.proposal.cumulative.veryLow.estimate).toBe(5);
    expect(r.delta).toEqual({ extremelyLow: -7, veryLow: -5, low: -4 });
    expect(r.proposal.rows[0].requiredAnnualIncome).toBe(20000);
    expect(r.proposal.rows[3].requiredAnnualIncome).toBe(60000.4);
    expect(housingAffordabilityResolutionSchema.parse(r)).toEqual(r);
  });
  it("does not treat missing costs as zero or classify by average rent", () => {
    const f = housingFixture(),
      a = f.scenario.affordability!;
    a.proposalGroups = [f.group("complete", 4), f.group("unknown", 3)];
    const old = a.proposalGroups[1].costs[1];
    a.proposalGroups[1].costs[1] = {
      id: old.id,
      kind: old.kind,
      provenance: old.provenance,
      state: "unknown",
    };
    review(f);
    const r = resolve(f);
    expect(r.status).toBe("incomplete");
    expect(r.proposal.cumulative.low).toEqual({
      estimate: null,
      knownSubtotal: 4,
    });
    expect(r.proposal).toMatchObject({
      knownUnits: 10,
      assignedUnits: 7,
      evaluatedUnits: 4,
      unassignedUnits: 3,
      unresolvedAssignedUnits: 3,
    });
    expect(r.proposal.rows[1]).toMatchObject({
      grossMonthlyCents: null,
      knownMonthlyCents: 45000,
      requiredAnnualIncome: null,
      minimumBand: null,
    });
  });
  it("counts bundled rent/utilities and owner escrow exactly once, with debt-free and explicit zero cases", () => {
    const f = housingFixture(),
      a = f.scenario.affordability!;
    const owner = f.group("owner", 5, "own"),
      rent = f.group("rent", 5);
    owner.costs = owner.costs.map((c) =>
      c.kind === "property-tax" || c.kind === "property-insurance"
        ? {
            id: c.id,
            kind: c.kind,
            provenance: c.provenance,
            state: "included",
            includedIn: "loan-payment",
          }
        : c,
    );
    rent.costs[1] = {
      id: "utilities",
      kind: "utilities",
      state: "included",
      includedIn: "rent",
      provenance: rent.costs[1].provenance,
    };
    a.proposalGroups = [owner, rent];
    review(f);
    expect(resolve(f).proposal.rows.map((r) => r.grossMonthlyCents)).toEqual([
      50000, 45000,
    ]);
    for (const g of f.scenario.affordability!.proposalGroups)
      g.costs = g.costs.map((c) => ({
        id: c.id,
        kind: c.kind,
        provenance: c.provenance,
        state: "not-applicable",
      }));
    review(f);
    expect(
      resolve(f).proposal.rows.every((r) => r.requiredAnnualIncome === 0),
    ).toBe(true);
  });
  it("keeps unknown dwelling inventory separate from known unassigned and classified homes", () => {
    const f = housingFixture();
    f.place.buildings.push({
      ...f.place.buildings[0],
      id: "unknown",
      units: null,
    });
    review(f);
    const r = resolve(f);
    expect(r.proposal).toMatchObject({
      totalUnits: null,
      knownUnits: 10,
      evaluatedUnits: 10,
      unknownUnitBuildingIds: ["unknown"],
    });
    expect(r.proposal.cumulative.low).toEqual({
      estimate: null,
      knownSubtotal: 10,
    });
  });
  it("allows ordinary building edits but withholds stale review and over-capacity/deleted assignments", () => {
    const f = housingFixture();
    f.scenario = applyCommand(f.scenario, {
      type: "building.upsert",
      building: { ...f.place.buildings[0], units: 9 },
    });
    expect(resolve(f)).toMatchObject({ status: "stale", reviewState: "stale" });
    review(f);
    expect(resolve(f).proposal.rows[0].reasons.join(" ")).toContain("exceed");
    f.scenario = applyCommand(f.scenario, {
      type: "building.remove",
      id: "home",
    });
    review(f);
    expect(resolve(f).proposal).toMatchObject({
      knownUnits: 0,
      assignedUnits: 0,
      evaluatedUnits: 0,
      staleGroupIds: ["proposal"],
    });
    expect(resolve(f).proposal.cumulative.low.estimate).toBeNull();
  });
  it("does not stale a review for a display rename or inferred household assumption; imported copies retain numbers", () => {
    const f = housingFixture();
    const before = resolve(f);
    f.scenario = applyCommand(f.scenario, {
      type: "scenario.rename",
      name: "Renamed",
    });
    f.scenario.assumptions.householdSize = 7;
    expect(resolve(f).reviewState).toBe("current");
    f.scenario.affordability!.proposalGroups[0].areaOrigin = "server-catalog";
    f.project.scenarios[1] = f.scenario;
    f.project = projectWithImportedHousing(f.project);
    f.scenario = f.project.scenarios[1];
    expect(resolve(f).proposal.cumulative).toEqual(before.proposal.cumulative);
    expect(resolve(f).proposal.rows[0].areaOrigin).toBe("imported");
  });
  it("withholds mismatched dollar clocks and mutated hash-keyed packs", () => {
    const f = housingFixture();
    f.scenario.affordability!.proposalGroups[0].costYear = 2025;
    review(f);
    expect(resolve(f).proposal.rows[0].minimumBand).toBeNull();
    f.scenario.affordability!.proposalGroups[0].costYear = 2026;
    review(f);
    f.project.housingIncomeLimits![f.areaHash].limits[0].low++;
    expect(resolve(f).proposal.rows[0].limits).toBeNull();
  });
  it("uses household-size rows exactly and refuses duplicated component inventory", () => {
    const f = housingFixture();
    const g = f.scenario.affordability!.proposalGroups[0];
    g.householdSize = 2;
    g.bedrooms = 0;
    review(f);
    expect(resolve(f).proposal.rows[0].limits?.extremelyLow).toBe(30000);
    f.scenario.affordability!.proposalGroups[0].componentId = "missing";
    review(f);
    expect(resolve(f).proposal.rows[0].status).toBe("stale");
  });
  it("preserves all legacy metric values and only adds separately named housing evidence", () => {
    const f = housingFixture(),
      without = structuredClone(f.scenario);
    delete without.affordability;
    const legacy = calculateImpact(f.place, without),
      current = calculateImpact(f.place, f.scenario, {}, f.project);
    expect(
      current.metrics.filter((m) => !m.id.startsWith("housing.affordable")),
    ).toEqual(legacy.metrics);
    expect(legacy).not.toHaveProperty("affordability");
    expect(
      current.metrics.find((m) => m.id === "housing.affordableLow"),
    ).toMatchObject({ baseline: 10, value: 10, delta: 0 });
    expect(current.affordability).toEqual(resolve(f));
  });
  it("copies planning housing evidence to new fiscal studies with exact packs and imported authority", () => {
    const f = housingFixture(),
      fiscal = fiscalFixture();
    f.scenario.affordability!.proposalGroups[0].areaOrigin = "server-catalog";
    const copied = createFiscalStudy({
      place: f.place,
      project: f.project,
      scenarioId: f.scenario.id,
      profile: fiscal.profile,
      review: fiscal.review,
    });
    expect(copied.schemaVersion).toBe(13);
    expect(copied.housingIncomeLimits).toEqual(f.project.housingIncomeLimits);
    expect(
      copied.scenarios[1].affordability?.proposalGroups[0].areaOrigin,
    ).toBe("imported");
    expect(
      housingIncomeLimitPackHash(copied.housingIncomeLimits![f.areaHash]),
    ).toBe(f.areaHash);
  });
});

import { describe, it, expect } from "vitest";
import {
  applyCommand,
  BUILDING_QUANTITY_FIELDS,
  buildingProgramTotals,
  parcelPreset,
  quantityProduct,
  aggregateBuildingQuantity,
  USER_ACTIVITY_SOURCE,
  type Building,
  type Place,
} from "@urban/core";
import {
  buildingPreset,
  calculateImpact,
  createScenario,
  fiscalCashFlows,
  adoptActivityScenario,
  resolveActivity,
  typedBuildingPreset,
  previewBuildingConversion,
  adoptBuildingProgram,
  calculateParcelContext,
} from "./index";
function fixture() {
  const building = buildingPreset("office", [0.005, 0.005]);
  building.id = "known";
  const place: Place = {
    id: "nullable-fixture",
    name: "Fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.005, 0.005],
    bounds: [0, 0, 0.02, 0.02],
    boundary: [
      [0, 0],
      [0.02, 0],
      [0.02, 0.02],
      [0, 0.02],
      [0, 0],
    ],
    buildings: [building],
    roads: [],
    sources: [USER_ACTIVITY_SOURCE],
    coverage: [],
    extentLabel: "Synthetic fixture",
    loadedAt: "2026-11-06T00:00:00Z",
  };
  return { place, building, scenario: createScenario("Option") };
}
function unknown(
  building: Building,
  fields: (typeof BUILDING_QUANTITY_FIELDS)[number][] = [
    ...BUILDING_QUANTITY_FIELDS,
  ],
): Building {
  const next = structuredClone(building);
  next.attributeProvenance = {
    version: 1,
    fields: { ...next.attributeProvenance?.fields },
  };
  for (const field of fields) {
    next[field] = null;
    next.attributeProvenance.fields[field] = {
      status: "missing",
      sourceId: "upload",
      rawValue: null,
    };
  }
  return next;
}
const metrics = (p: Place, s: ReturnType<typeof createScenario>) =>
  new Map(calculateImpact(p, s).metrics.map((m) => [m.id, m]));
describe("unknown building quantities", () => {
  it("withholds dependent totals and comparisons while preserving geometry and honest known subtotals", () => {
    const { place, building, scenario } = fixture();
    place.buildings.push({ ...unknown(building), id: "missing" });
    const result = metrics(place, scenario);
    for (const id of [
      "housing.units",
      "housing.residents",
      "economy.jobs",
      "economy.payroll",
      "mobility.dailyTrips",
      "mobility.parkingSupply",
      "land.floorArea",
      "fiscal.propertyTax",
      "fiscal.serviceCost",
      "fiscal.netAnnual",
    ]) {
      const m = result.get(id)!;
      expect(m.value, id).toBeNull();
      expect(m.baseline, id).toBeNull();
      expect(m.delta, id).toBeNull();
      expect(m.status, id).toBe("unavailable");
      expect(m.coverage?.scenario.missingBuildingIds, id).toContain("missing");
    }
    expect(result.get("land.footprint")!.value).toBe(building.areaSqm * 2);
    expect(result.get("economy.jobs")!.coverage?.scenario.knownSubtotal).toBe(
      building.jobs,
    );
    expect(
      result.get("fiscal.netAnnual")!.coverage?.scenario,
    ).not.toHaveProperty("knownSubtotal");
    const removed = applyCommand(scenario, {
        type: "building.remove",
        id: "missing",
      }),
      after = metrics(place, removed).get("economy.jobs")!;
    expect(after.value).toBe(building.jobs);
    expect(after.baseline).toBeNull();
    expect(after.delta).toBeNull();
  });
  it("does not fabricate zero for an entirely unknown contributor and preserves explicit zeros", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [unknown(building)];
    const m = metrics(place, scenario).get("economy.jobs")!;
    expect(m.value).toBeNull();
    expect(m.coverage?.scenario.knownSubtotal).toBeNull();
    place.buildings = [{ ...building, jobs: 0, units: 0, parkingSpaces: 0 }];
    expect(metrics(place, scenario).get("economy.jobs")!.value).toBe(0);
    expect(aggregateBuildingQuantity([], (b) => b.jobs)).toEqual({
      value: 0,
      knownSubtotal: 0,
      missingBuildingIds: [],
    });
    expect(quantityProduct(null, 0)).toBeNull();
  });
  it("uses explicit component quantities and assessed value independently of unknown massing", () => {
    const { place, scenario } = fixture();
    const b = unknown(typedBuildingPreset("office", [0.005, 0.005]), [
      "height",
      "floors",
      "parkingSpaces",
    ]);
    b.assessedValue = 100000;
    place.buildings = [b];
    const m = metrics(place, scenario);
    expect(m.get("economy.jobs")!.value).toBe(
      b.program!.components.reduce((s, c) => s + c.jobs, 0),
    );
    expect(m.get("land.floorArea")!.value).toBeGreaterThan(0);
    expect(m.get("mobility.dailyTrips")!.value).toBeGreaterThan(0);
    expect(m.get("fiscal.propertyTax")!.value).toBe(
      100000 * scenario.assumptions.effectivePropertyTaxRate,
    );
    expect(m.get("mobility.parkingSupply")!.value).toBeNull();
  });
  it("keeps field dependency precise: unknown floors do not hide homes or geometry and unknown height only limits height checks", () => {
    const { place, building, scenario } = fixture();
    const b = unknown(
      { ...building, use: "multifamily", units: 10, jobs: 0, maxHeight: 15 },
      ["floors", "height"],
    );
    place.buildings = [b];
    const m = metrics(place, scenario);
    expect(m.get("housing.units")!.value).toBe(10);
    expect(m.get("mobility.dailyTrips")!.value).not.toBeNull();
    expect(m.get("land.floorArea")!.value).toBeNull();
    expect(m.get("land.heightConflicts")!.value).toBeNull();
    expect(m.get("land.footprint")!.value).toBe(building.areaSqm);
  });
  it("propagates unknowns in public fiscal flows including incentive valuation and distinguishes zero rates", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [unknown(building)];
    let [flow] = fiscalCashFlows(place, scenario);
    expect(flow.propertyRevenue).toBeNull();
    expect(flow.serviceCost).toBeNull();
    expect(flow.netRevenue).toBeNull();
    expect(flow.discountedNet).toBeNull();
    expect(flow.grantCost).toBe(0);
    scenario.assumptions.effectivePropertyTaxRate = 0;
    scenario.assumptions.annualServiceCostPerResident = 0;
    scenario.assumptions.annualServiceCostPerJob = 0;
    scenario.assumptions.localSalesTaxRate = 0;
    [flow] = fiscalCashFlows(place, scenario);
    expect(flow).toMatchObject({
      propertyRevenue: 0,
      salesRevenue: 0,
      serviceCost: 0,
      netRevenue: 0,
    });
  });
  it("preserves declared zero retail separately from unknown mixed-use floor area", () => {
    const { building } = fixture();
    expect(
      buildingProgramTotals(
        unknown({ ...building, use: "mixed-use" }, ["floors"]),
      ).retailFloorAreaSqm,
    ).toBeNull();
    expect(
      buildingProgramTotals(
        unknown({ ...building, use: "multifamily" }, ["floors"]),
      ).retailFloorAreaSqm,
    ).toBe(0);
  });
  it("leaves incomplete activity allocation unknown instead of renormalizing known building weights", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [
      { ...building, units: 10 },
      { ...unknown(building, ["units", "jobs"]), id: "unknown-count" },
    ];
    const activity = adoptActivityScenario(place, scenario);
    expect(activity.global.population).toBeUndefined();
    expect(activity.global.employment).toBeUndefined();
    activity.reference.population = {
      kind: "entered",
      value: 100,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2024,
      universe: "Entered residents",
    };
    activity.global.population = { mode: "absolute", value: 120 };
    activity.demandResponse.population = "proportional-residential";
    activity.demandResponse.reviewed = true;
    scenario.activity = activity;
    const r = resolveActivity(place, scenario);
    expect(r.population.value).toBe(120);
    expect(r.unmappedDemand.population).toBe(true);
    expect(
      metrics(place, scenario).get("mobility.dailyTrips")!.value,
    ).toBeNull();
  });
  it("keeps footprint union coverage known while withholding incomplete parcel GFA/home/job counts", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [unknown(building)];
    const parcel = parcelPreset({
      type: "Polygon",
      coordinates: [place.boundary],
    });
    place.parcels = [parcel];
    const context = calculateParcelContext(place, scenario, parcel.id);
    expect(context.proposal.lotCoveragePercent).toBeGreaterThan(0);
    expect(context.proposal.far).toBeNull();
    expect(context.proposal.units).toBeNull();
    expect(
      context.proposal.quantityCoverage.floorArea.missingBuildingIds,
    ).toEqual([building.id]);
  });
  it("requires explicit replacement of unknown inputs when adopting a component program", () => {
    const { building } = fixture(),
      b = unknown(building);
    expect(() => adoptBuildingProgram(b)).toThrow(/unknown/);
    expect(() =>
      previewBuildingConversion(b, "office", "preserve-program"),
    ).toThrow(/unknown/);
    const converted = previewBuildingConversion(
      b,
      "office",
      "typed-defaults",
    ).building;
    expect(converted.jobs).not.toBeNull();
    expect(converted.attributeProvenance?.fields.jobs?.status).toBe("assumed");
    expect(b.jobs).toBeNull();
  });
  it("does not renormalize a neighborhood around unknown building weights", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [
      { ...building, units: 10 },
      { ...unknown(building, ["units"]), id: "unknown" },
    ];
    const activity = adoptActivityScenario(place, scenario);
    activity.reference.population = {
      kind: "entered",
      value: 100,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2024,
      universe: "Synthetic entered residents",
    };
    activity.global.population = { mode: "absolute", value: 120 };
    activity.neighborhoods = [
      {
        id: "area",
        name: "All known geography",
        geometry: { type: "Polygon", coordinates: [place.boundary] },
        sourceId: USER_ACTIVITY_SOURCE.id,
        population: { mode: "absolute", value: 50 },
      },
    ];
    scenario.activity = activity;
    const r = resolveActivity(place, scenario);
    expect(r.population.value).toBeNull();
    expect(r.neighborhoods[0].population.beforeAreas).toBeNull();
    expect(r.neighborhoods[0].population.value).toBe(50);
  });
  it("retains a reviewed zero-activity response without interpreting unknown physical quantities as zero", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [unknown({ ...building, use: "multifamily" }, ["units"])];
    const activity = adoptActivityScenario(place, scenario);
    activity.global.population = { mode: "absolute", value: 0 };
    activity.demandResponse.population = "proportional-residential";
    activity.demandResponse.reviewed = true;
    scenario.activity = activity;
    const m = metrics(place, scenario);
    expect(m.get("mobility.dailyTrips")!.value).toBe(0);
    expect(m.get("housing.units")!.value).toBeNull();
    expect(m.get("mobility.parkingDemand")!.value).toBeNull();
  });
  it("retains an independent population reference for unchanged unknown housing but not an unknown removal", () => {
    const { place, building, scenario } = fixture();
    place.buildings = [unknown({ ...building, jobs: 0 }, ["units"])];
    const measure: import("@urban/core").CommunityMeasure = {
      label: "Synthetic population reference",
      unit: "people",
      universe: "Synthetic fixture population",
      estimate: {
        value: 100,
        raw: "100",
        annotation: null,
        status: "available",
      },
      marginOfError: {
        value: 5,
        raw: "5",
        annotation: null,
        status: "available",
      },
      variables: {
        estimate: "B01003_001E",
        marginOfError: "B01003_001M",
        estimateAnnotation: "B01003_001EA",
        marginOfErrorAnnotation: "B01003_001MA",
      },
    };
    place.geography = { type: "zcta", code: "85004", boundaryVintage: "2020" };
    place.demographics = {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      geography: {
        kind: "zcta",
        id: "85004",
        name: "Synthetic matching geometry",
        relationshipToStudyArea: "same-area",
      },
      retrievedAt: "2026-11-06T00:00:00Z",
      confidenceLevel: 90,
      source: USER_ACTIVITY_SOURCE,
      measures: {
        population: measure,
        households: measure,
        housingUnits: measure,
        medianHouseholdIncome: measure,
        povertyPercent: measure,
        bachelorsOrHigherPercent: measure,
      },
      notes: ["Synthetic test only"],
    };
    scenario.assumptions.annualServiceCostPerJob = 0;
    scenario.baselineAssumptions.annualServiceCostPerJob = 0;
    expect(metrics(place, scenario).get("fiscal.serviceCost")!.value).toBe(
      100 * scenario.assumptions.annualServiceCostPerResident,
    );
    const activity = adoptActivityScenario(place, scenario);
    scenario.activity = activity;
    expect(resolveActivity(place, scenario).population.value).toBe(100);
    const renamed = applyCommand(scenario, {
      type: "building.upsert",
      building: { ...place.buildings[0], name: "Renamed only" },
    });
    expect(resolveActivity(place, renamed).population.value).toBe(100);
    const removed = applyCommand(scenario, {
      type: "building.remove",
      id: building.id,
    });
    expect(resolveActivity(place, removed).population.value).toBe(100);
    delete removed.activity;
    expect(metrics(place, removed).get("fiscal.serviceCost")!.value).toBeNull();
  });
});

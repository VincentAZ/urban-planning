import { describe, expect, it } from "vitest";
import type {
  Building,
  CommunityDemographics,
  CommunityMeasure,
  MetricResult,
  Place,
  Scenario,
} from "@urban/core";
import {
  applyCommand,
  materializeBuildings,
  roadPreset,
  USER_ROAD_SOURCE,
} from "@urban/core";
import {
  buildingPreset,
  calculateImpact,
  createProject,
  createScenario,
  defaultAssumptions,
  distanceMeters,
  lineLengthMeters,
  fiscalCashFlows,
  formatMetric,
  polygonAreaSqm,
  SQFT_PER_SQM,
  SQM_PER_ACRE,
  validateAssumptions,
} from "./index";

function fixture(): Place {
  const building: Building = {
    id: "home",
    name: "Existing homes",
    use: "multifamily",
    footprint: [
      [-112.075, 33.45],
      [-112.074, 33.45],
      [-112.074, 33.451],
      [-112.075, 33.451],
      [-112.075, 33.45],
    ],
    height: 12,
    floors: 4,
    areaSqm: 1000,
    units: 40,
    jobs: 0,
    parkingSpaces: 45,
    sourceId: "local-survey",
    estimated: false,
    rentMonthly: 1500,
    assessedValue: 1000000,
  };
  return {
    id: "test",
    name: "Test area",
    city: "Phoenix",
    state: "AZ",
    zip: "85003",
    center: [-112.075, 33.45],
    bounds: [-112.08, 33.44, -112.07, 33.46],
    boundary: [
      [-112.08, 33.44],
      [-112.07, 33.44],
      [-112.07, 33.46],
      [-112.08, 33.46],
      [-112.08, 33.44],
    ],
    buildings: [building],
    roads: [
      {
        id: "road",
        name: "Test street",
        coordinates: [
          [-112.075, 33.45],
          [-112.075, 33.46],
        ],
        lanes: 2,
        speedMph: 25,
        oneWay: false,
        kind: "residential",
        sourceId: "local-survey",
      },
    ],
    sources: [
      {
        id: "local-survey",
        name: "Test survey",
        url: "https://example.org/survey",
        vintage: "2026",
        license: "Test fixture",
        kind: "observed",
      },
    ],
    coverage: [],
    loadedAt: "2026-11-05T00:00:00Z",
    extentLabel: "Explicit test boundary",
  };
}
function metric(
  place: Place,
  scenario: Scenario,
  id: string,
  evidence?: Parameters<typeof calculateImpact>[2],
): MetricResult {
  const result = calculateImpact(place, scenario, evidence).metrics.find(
    (m) => m.id === id,
  );
  if (!result) throw new Error(`Missing metric ${id}`);
  return result;
}

function withPublishedPopulation(place: Place, value: number | null): Place {
  const measure: CommunityMeasure = {
    label: "Synthetic population fixture",
    unit: "people",
    universe: "Total population",
    estimate: {
      value,
      raw: value === null ? null : String(value),
      annotation: null,
      status: value === null ? "missing" : "available",
    },
    marginOfError: {
      value: 20,
      raw: "20",
      annotation: null,
      status: "available",
    },
    variables: {
      estimate: "DP05_0001E",
      marginOfError: "DP05_0001M",
      estimateAnnotation: "DP05_0001EA",
      marginOfErrorAnnotation: "DP05_0001MA",
    },
  };
  const demographics: CommunityDemographics = {
    dataset: "acs/acs5/profile",
    vintage: 2024,
    period: { start: 2020, end: 2024 },
    confidenceLevel: 90,
    geography: {
      kind: "zcta",
      id: place.zip,
      name: `ZCTA5 ${place.zip}`,
      relationshipToStudyArea: "same-area",
    },
    retrievedAt: "2026-11-05T00:00:00Z",
    source: {
      id: "synthetic-census-fixture",
      name: "Synthetic ACS test fixture",
      url: "https://example.org/fixture",
      vintage: "2020–2024",
      license: "Test fixture",
      kind: "published-estimate",
    },
    measures: {
      population: measure,
      households: measure,
      housingUnits: measure,
      medianHouseholdIncome: measure,
      povertyPercent: measure,
      bachelorsOrHigherPercent: measure,
    },
    notes: ["Synthetic test values, not published data."],
  };
  return {
    ...place,
    geography: { type: "zcta", code: place.zip, boundaryVintage: "2020" },
    demographics,
    sources: [...place.sources, demographics.source],
  };
}

describe("Census community population in fiscal estimates", () => {
  it("uses the matching whole-ZCTA population for existing service costs without replacing mapped homes or resident capacity", () => {
    const place = withPublishedPopulation(fixture(), 1000);
    const scenario = createScenario("ACS fiscal base");
    scenario.assumptions.annualServiceCostPerResident = 100;
    scenario.baselineAssumptions.annualServiceCostPerResident = 100;
    const service = metric(place, scenario, "fiscal.serviceCost");
    expect(service.baseline).toBe(100000);
    expect(service.value).toBe(100000);
    expect(service.delta).toBe(0);
    expect(service.sourceIds).toContain("synthetic-census-fixture");
    expect(
      service.inputs.some(
        (input) =>
          input.name === "Existing community population" &&
          input.value === 1000,
      ),
    ).toBe(true);
    expect(metric(place, scenario, "housing.units").value).toBe(40);
    expect(metric(place, scenario, "housing.residents").value).toBeCloseTo(
      40 *
        (1 - scenario.assumptions.vacancyRate) *
        scenario.assumptions.householdSize,
    );
  });
  it("models changed dwelling capacity as an explicit incremental resident scenario", () => {
    const place = withPublishedPopulation(fixture(), 1000);
    const scenario = createScenario("More homes");
    scenario.buildingEdits.home = { ...place.buildings[0], units: 50 };
    const expectedAdded =
      10 *
      (1 - scenario.assumptions.vacancyRate) *
      scenario.assumptions.householdSize;
    const service = metric(place, scenario, "fiscal.serviceCost");
    expect(service.delta).toBeCloseTo(
      expectedAdded * scenario.assumptions.annualServiceCostPerResident,
    );
    expect(place.demographics?.measures.population.estimate.value).toBe(1000);
    expect(service.explanation).toContain("not Census forecasts");
  });
  it("does not use an unmatched or wider ZCTA as the population of a partial study area", () => {
    const plain = fixture();
    const scenario = createScenario("Partial area");
    const expected = metric(plain, scenario, "fiscal.serviceCost").value;
    const partial = withPublishedPopulation(plain, 1000);
    partial.demographics!.geography.relationshipToStudyArea = "context-only";
    expect(metric(partial, scenario, "fiscal.serviceCost").value).toBe(
      expected,
    );
    partial.demographics!.geography.relationshipToStudyArea = "same-area";
    partial.geography!.code = "11201";
    expect(metric(partial, scenario, "fiscal.serviceCost").value).toBe(
      expected,
    );
    delete partial.geography;
    expect(metric(partial, scenario, "fiscal.serviceCost").value).toBe(
      expected,
    );
  });
  it("preserves a published zero and uses the disclosed housing-based fallback when the Census estimate is absent", () => {
    const scenario = createScenario("Missing and zero");
    expect(
      metric(
        withPublishedPopulation(fixture(), 0),
        scenario,
        "fiscal.serviceCost",
      ).value,
    ).toBe(0);
    const missing = withPublishedPopulation(fixture(), null);
    expect(metric(missing, scenario, "fiscal.serviceCost").value).toBe(
      metric(fixture(), scenario, "fiscal.serviceCost").value,
    );
    expect(
      metric(missing, scenario, "fiscal.serviceCost").explanation,
    ).toContain("housing-derived");
  });
});

describe("scenario helpers and reversible commands", () => {
  it("starts with a genuinely unchanged baseline and editable alternative", () => {
    const project = createProject(fixture());
    expect(project.scenarios).toHaveLength(2);
    expect(project.scenarios[0].id).toBe("baseline");
    expect(project.scenarios[1].parentId).toBe("baseline");
    expect(project.activeScenarioId).toBe(project.scenarios[1].id);
    expect(
      calculateImpact(fixture(), project.scenarios[1]).metrics.every(
        (m) => m.delta === null || m.delta === 0,
      ),
    ).toBe(true);
  });
  it("deep-copies edits and baseline profiles when branching", () => {
    const original = createScenario("Original");
    original.buildingEdits.new = buildingPreset("office", [-112, 33]);
    original.sources = [
      {
        id: "import",
        name: "Local import",
        url: "https://example.org/import",
        vintage: "2026",
        license: "User-supplied",
        kind: "user-supplied",
      },
    ];
    const branch = createScenario("Branch", original);
    branch.assumptions.tripRates.office = 100;
    branch.baselineAssumptions.tripRates.office = 101;
    branch.buildingEdits.new!.footprint![0][0] = 0;
    branch.sources![0].name = "Changed in branch";
    expect(original.assumptions.tripRates.office).toBe(10);
    expect(original.baselineAssumptions.tripRates.office).toBe(10);
    expect(original.buildingEdits.new!.footprint![0][0]).not.toBe(0);
    expect(original.sources[0].name).toBe("Local import");
  });
  it("returns to exact geometry-derived baseline totals after restoration", () => {
    const place = fixture(),
      original = createScenario("Option");
    const edited = applyCommand(original, {
      type: "building.remove",
      id: "home",
    });
    expect(metric(place, edited, "housing.units").value).toBe(0);
    const restored = applyCommand(edited, { type: "scenario.restore" });
    expect(metric(place, restored, "housing.units").delta).toBe(0);
    expect(materializeBuildings(place, restored)).toEqual(place.buildings);
    expect(place.buildings).toHaveLength(1);
  });
});

describe("geographic units and physical quantities", () => {
  it("converts footprint area and floors to square feet exactly once", () => {
    const floor = metric(fixture(), createScenario("Test"), "land.floorArea");
    expect(floor.value).toBeCloseTo(1000 * 4 * SQFT_PER_SQM, 6);
  });
  it("uses geographic boundary acres for gross density", () => {
    const place = fixture();
    const expectedAcres = polygonAreaSqm(place.boundary) / SQM_PER_ACRE;
    expect(
      metric(place, createScenario("Test"), "housing.density").value,
    ).toBeCloseTo(40 / expectedAcres, 8);
    expect(expectedAcres).toBeGreaterThan(400);
  });
  it("handles ring direction, unclosed rings, and dateline crossing", () => {
    const ring: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
    ];
    expect(polygonAreaSqm(ring)).toBeCloseTo(12364.3459, 1);
    expect(polygonAreaSqm([...ring].reverse())).toBeCloseTo(
      polygonAreaSqm(ring),
      6,
    );
    expect(polygonAreaSqm([...ring, ring[0]])).toBeCloseTo(
      polygonAreaSqm(ring),
      6,
    );
    const crossing: [number, number][] = [
      [179.999, 0],
      [-179.999, 0],
      [-179.999, 0.001],
      [179.999, 0.001],
    ];
    expect(polygonAreaSqm(crossing)).toBeCloseTo(polygonAreaSqm(ring) * 2, 1);
  });
  it("does not fabricate parcel FAR from a building footprint", () => {
    expect(
      metric(fixture(), createScenario("Test"), "land.far").value,
    ).toBeNull();
    const place = fixture();
    place.buildings[0].parcelId = "parcel";
    const far = metric(place, createScenario("Test"), "land.far", {
      parcels: {
        sourceId: "assessor",
        vintage: "2026",
        geography: "Actual parcel",
        parcels: [{ id: "parcel", areaSqm: 5000 }],
      },
    });
    expect(far.value).toBeCloseTo(0.8);
    expect(far.geography).toBe("Actual parcel");
  });
  it("produces geographically plausible preset area and closed rings", () => {
    for (const use of [
      "residential",
      "office",
      "park",
      "warehouse",
      "mixed-use",
    ] as const) {
      const preset = buildingPreset(use, [-112.075, 33.45]);
      expect(preset.footprint[0]).toEqual(preset.footprint.at(-1));
      expect(polygonAreaSqm(preset.footprint) / preset.areaSqm).toBeCloseTo(
        1,
        2,
      );
    }
    expect(distanceMeters([0, 0], [0, 1])).toBeCloseTo(111195.08, 0);
  });
});

describe("housing, employment, and mobility", () => {
  it("keeps physical homes independent from population and growth controls", () => {
    const place = fixture();
    const scenario = createScenario("Growth");
    scenario.assumptions.populationMultiplier = 2;
    scenario.horizon = 10;
    expect(metric(place, scenario, "housing.units").delta).toBe(0);
    expect(metric(place, scenario, "housing.residents").value).toBeCloseTo(
      40 * 0.92 * 2.4 * 2 * 1.01 ** 10,
    );
  });
  it("preserves a frozen baseline when an assumption changes", () => {
    const scenario = createScenario("Higher wage");
    const place = fixture();
    place.buildings[0].jobs = 10;
    scenario.assumptions.annualWage = 80000;
    const payroll = metric(place, scenario, "economy.payroll");
    expect(payroll.baseline).toBe(600000);
    expect(payroll.value).toBe(800000);
    expect(payroll.delta).toBe(200000);
  });
  it("respects explicitly entered zero jobs even with nonzero density defaults", () => {
    const place = fixture();
    place.buildings[0].use = "office";
    place.buildings[0].estimated = true;
    expect(metric(place, createScenario("Test"), "economy.jobs").value).toBe(0);
  });
  it("adds parking supply without counting garage floor area as parking demand", () => {
    const place = fixture();
    const scenario = createScenario("Parking");
    const garage = buildingPreset("parking", place.center);
    scenario.buildingEdits[garage.id] = garage;
    expect(metric(place, scenario, "mobility.parkingDemand").value).toBe(50);
    expect(metric(place, scenario, "mobility.parkingSupply").value).toBe(165);
    expect(metric(place, scenario, "mobility.parkingBalance").value).toBe(115);
  });
  it("counts mixed-use residential and ground-floor commercial demand separately", () => {
    const place = fixture();
    place.buildings = [];
    const scenario = createScenario("Mixed");
    const mixed = buildingPreset("mixed-use", place.center);
    scenario.buildingEdits[mixed.id] = mixed;
    const a = scenario.assumptions;
    const expected =
      mixed.units! * (1 - a.vacancyRate) * a.tripRates["mixed-use"] +
      ((mixed.areaSqm * SQFT_PER_SQM) / 1000) * a.tripRates.retail;
    expect(metric(place, scenario, "mobility.dailyTrips").value).toBeCloseTo(
      expected,
      6,
    );
    expect(metric(place, scenario, "mobility.parkingDemand").value).toBeCloseTo(
      mixed.units! * a.parkingPerUnit +
        ((mixed.areaSqm * SQFT_PER_SQM) / 1000) * a.parkingPer1000Sqft,
      6,
    );
  });
  it("makes travel-demand changes explicit without pretending to calculate LOS", () => {
    const place = fixture(),
      scenario = createScenario("Mode shift");
    scenario.assumptions.driveShare = 0.4;
    scenario.assumptions.transitShare = 0.48;
    const trips = metric(place, scenario, "mobility.dailyTrips");
    expect(trips.value).toBeCloseTo(trips.baseline! / 2);
    expect(trips.status).toBe("incomplete");
    expect(metric(place, scenario, "mobility.los").status).toBe("unavailable");
  });
  it("updates network length for closures and exposes a rerun warning", () => {
    const place = fixture();
    const scenario = applyCommand(createScenario("Closure"), {
      type: "road.upsert",
      road: { ...place.roads[0], closed: true },
    });
    expect(metric(place, scenario, "mobility.roadMiles").value).toBe(0);
    expect(metric(place, scenario, "mobility.laneMiles").value).toBe(0);
    expect(
      calculateImpact(place, scenario).warnings.some((w) =>
        w.includes("network assignment"),
      ),
    ).toBe(true);
  });
  it("updates authored and removed road measures, preserves baseline totals, and invalidates prior routing evidence", () => {
    const place = fixture(),
      initial = createScenario("Street changes");
    const evidence = {
      access: {
        sourceId: "routing",
        vintage: "2026",
        geography: "Test network",
        scenarioRevision: initial.revision,
        baselineJobs: { car: [100, 200, 300] as [number, number, number] },
        scenarioJobs: { car: [100, 200, 300] as [number, number, number] },
      },
    };
    expect(metric(place, initial, "access.car30", evidence).value).toBe(200);
    const road = roadPreset([
      [-112.075, 33.45],
      [-112.074, 33.451],
    ]);
    road.bikeLane = true;
    const added = applyCommand(initial, {
      type: "road.upsert",
      road,
      source: USER_ROAD_SOURCE,
    });
    const original = metric(place, initial, "mobility.roadMiles"),
      next = metric(place, added, "mobility.roadMiles");
    expect(next.baseline).toBe(original.baseline);
    expect(next.value).toBeGreaterThan(original.value!);
    expect(metric(place, added, "mobility.bikeMiles").delta).toBeGreaterThan(0);
    expect(metric(place, added, "mobility.laneMiles")).toMatchObject({
      status: "incomplete",
      sourceIds: expect.arrayContaining([
        USER_ROAD_SOURCE.id,
        place.roads[0].sourceId,
      ]),
    });
    expect(metric(place, added, "access.car30", evidence).value).toBeNull();
    const removed = applyCommand(added, {
      type: "road.remove",
      id: place.roads[0].id,
    });
    const retainedLength = lineLengthMeters(road.coordinates) / 1609.344;
    expect(metric(place, removed, "mobility.roadMiles").value).toBeCloseTo(
      retainedLength,
    );
    expect(metric(place, removed, "mobility.laneMiles").value).toBeCloseTo(
      retainedLength * road.lanes,
    );
    expect(metric(place, removed, "mobility.roadMiles").baseline).toBe(
      original.baseline,
    );
    const restored = applyCommand(removed, { type: "scenario.restore" });
    expect(metric(place, restored, "mobility.roadMiles").delta).toBe(0);
    expect(metric(place, restored, "access.car30", evidence).value).toBeNull(); // Restore is a new revision; an old routing run is not silently reused.
    expect(metric(place, removed, "mobility.dailyTrips").value).toBe(
      metric(place, initial, "mobility.dailyTrips").value,
    );
  });
  it("never divides by zero when there are no homes", () => {
    const place = fixture();
    place.buildings = [];
    expect(
      metric(place, createScenario("Empty"), "housing.jobsHousingBalance")
        .value,
    ).toBeNull();
    expect(
      calculateImpact(place, createScenario("Empty")).metrics.every(
        (m) => m.value === null || Number.isFinite(m.value),
      ),
    ).toBe(true);
  });
});

describe("fiscal cash flow and incentive accounting", () => {
  function fiscalFixture() {
    const place = fixture(),
      scenario = createScenario("Fiscal");
    const a = scenario.assumptions;
    a.annualGrowthRate = 0;
    a.vacancyRate = 0;
    a.householdSize = 2;
    a.annualServiceCostPerResident = 10;
    a.annualServiceCostPerJob = 0;
    a.effectivePropertyTaxRate = 0.01;
    a.discountRate = 0.1;
    a.fiscalInputsConfirmed = true;
    scenario.baselineAssumptions = structuredClone(a);
    return { place, scenario };
  }
  it("computes transparent yearly revenues, costs, and NPV with no growth double count", () => {
    const { place, scenario } = fiscalFixture();
    const flows = fiscalCashFlows(place, scenario, 2);
    expect(flows[0].propertyRevenue).toBe(10000);
    expect(flows[0].serviceCost).toBe(800);
    expect(flows[0].netRevenue).toBe(9200);
    expect(flows[0].discountedNet).toBeCloseTo(9200 / 1.1);
    expect(flows[1].discountedNet).toBeCloseTo(9200 / 1.1 ** 2);
  });
  it("charges a grant once, applies abatements only for their configured duration, and retains baseline", () => {
    const { place, scenario } = fiscalFixture();
    scenario.assumptions.incentiveGrant = 1000;
    scenario.assumptions.abatementPercent = 0.5;
    scenario.assumptions.abatementYears = 2;
    scenario.buildingEdits.home = {
      ...place.buildings[0],
      assessedValue: 2000000,
    };
    const flows = fiscalCashFlows(place, scenario, 3);
    expect(flows.map((f) => f.grantCost)).toEqual([1000, 0, 0]);
    expect(flows.map((f) => f.abatementCost)).toEqual([5000, 5000, 0]);
    expect(fiscalCashFlows(place, scenario, 1, true)[0].netRevenue).toBe(9200);
    expect(metric(place, scenario, "fiscal.netAnnual").delta).toBe(4000);
  });
  it("does not abate the existing tax base and discounts the up-front grant at time zero", () => {
    const { place, scenario } = fiscalFixture();
    const initialNpv = metric(place, scenario, "fiscal.npv").value!;
    scenario.assumptions.abatementPercent = 0.5;
    scenario.assumptions.abatementYears = 20;
    scenario.assumptions.incentiveGrant = 1000;
    expect(fiscalCashFlows(place, scenario)[0].abatementCost).toBe(0);
    expect(metric(place, scenario, "fiscal.npv").value).toBeCloseTo(
      initialNpv - 1000,
      6,
    );
  });
  it("reports not-reached payback as null without inventing recovery", () => {
    const { place, scenario } = fiscalFixture();
    scenario.assumptions.incentiveGrant = 1000000;
    const payback = metric(place, scenario, "fiscal.incentivePayback");
    expect(payback.value).toBeNull();
    expect(payback.explanation).toContain("not reached");
  });
  it("calculates incremental incentive payback against baseline, not all existing taxes", () => {
    const { place, scenario } = fiscalFixture();
    scenario.assumptions.incentiveGrant = 15000;
    scenario.buildingEdits.home = {
      ...place.buildings[0],
      assessedValue: 2000000,
    };
    expect(metric(place, scenario, "fiscal.incentivePayback").value).toBe(2);
  });
  it("does not claim fiscal readiness until both profiles are confirmed", () => {
    const scenario = createScenario("Unconfirmed");
    scenario.assumptions.fiscalInputsConfirmed = true;
    expect(metric(fixture(), scenario, "fiscal.netAnnual").status).toBe(
      "incomplete",
    );
  });
});

describe("evidence-driven extensions and missing data", () => {
  it("separates direct, indirect, and induced jobs without counting direct twice", () => {
    const place = fixture();
    place.buildings[0].jobs = 100;
    const scenario = createScenario("Jobs");
    const evidence = {
      economicMultipliers: {
        sourceId: "rims-pack",
        vintage: "2025",
        geography: "Maricopa County",
        typeIEmployment: 1.5,
        typeIIEmployment: 1.8,
        annualOutputPerDirectJob: 200000,
      },
    };
    expect(metric(place, scenario, "economy.jobs", evidence).value).toBe(100);
    expect(
      metric(place, scenario, "economy.indirectJobs", evidence).value,
    ).toBe(50);
    expect(
      metric(place, scenario, "economy.inducedJobs", evidence).value,
    ).toBeCloseTo(30);
    expect(
      metric(place, scenario, "economy.indirectJobs", evidence).geography,
    ).toBe("Maricopa County");
  });
  it("caps retail capture by eligible demand and applies displacement", () => {
    const place = fixture(),
      scenario = createScenario("Retail");
    const retailBuilding = buildingPreset("retail", place.center);
    scenario.buildingEdits[retailBuilding.id] = retailBuilding;
    const evidence = {
      retail: {
        sourceId: "retail-study",
        vintage: "2026",
        geography: "Trade area",
        residentAnnualDemand: 1000000,
        baselineAnnualSales: 800000,
        displacedLocalSalesFraction: 0.2,
        annualSalesPerEstablishment: 500000,
      },
    };
    expect(
      metric(place, scenario, "economy.retailCaptured", evidence).value,
    ).toBe(880000);
    expect(metric(place, scenario, "economy.retailGap", evidence).value).toBe(
      120000,
    );
  });
  it("does not invent retail leakage or multiplier effects from buildings alone", () => {
    for (const id of [
      "economy.retailGap",
      "economy.indirectJobs",
      "environment.flood",
      "safety.conflicts",
      "access.car30",
    ]) {
      const value = metric(fixture(), createScenario("No evidence"), id);
      expect(value.value).toBeNull();
      expect(value.baseline).toBeNull();
      expect(value.delta).toBeNull();
      expect(value.status).toBe("unavailable");
    }
  });
  it("rejects stale routing evidence and accepts matching regional results", () => {
    const scenario = createScenario("Access");
    scenario.revision = 2;
    const evidence = {
      access: {
        sourceId: "routing",
        vintage: "2026",
        geography: "Phoenix region",
        scenarioRevision: 1,
        baselineJobs: { car: [100, 200, 300] as [number, number, number] },
        scenarioJobs: { car: [100, 250, 350] as [number, number, number] },
      },
    };
    expect(
      metric(fixture(), scenario, "access.car30", evidence).value,
    ).toBeNull();
    evidence.access.scenarioRevision = 2;
    expect(metric(fixture(), scenario, "access.car30", evidence).delta).toBe(
      50,
    );
    expect(
      metric(fixture(), scenario, "access.car30", evidence).geography,
    ).toBe("Phoenix region");
  });
  it("computes curve-number runoff with the abstraction threshold", () => {
    const place = fixture(),
      scenario = createScenario("Rain");
    const environment = {
      sourceId: "soils",
      vintage: "2026",
      geography: "Test boundary",
      scenarioRevision: 0,
      stormDepthMm: 50,
      baselineCurveNumber: 80,
      scenarioCurveNumber: 70,
    };
    const runoff = metric(place, scenario, "environment.runoff", {
      environment,
    });
    expect(runoff.value).toBeLessThan(runoff.baseline!);
    environment.stormDepthMm = 1;
    expect(
      metric(place, scenario, "environment.runoff", { environment }).value,
    ).toBe(0);
  });
  it("keeps known zero flood exposure distinct from an unavailable flood layer", () => {
    const scenario = createScenario("Flood");
    const environment = {
      sourceId: "fema",
      vintage: "2026",
      geography: "Test boundary",
      scenarioRevision: 0,
      baselineFloodExposedUnits: 0,
      scenarioFloodExposedUnits: 0,
    };
    expect(
      metric(fixture(), scenario, "environment.flood", { environment }).value,
    ).toBe(0);
    expect(
      metric(fixture(), scenario, "environment.flood", { environment }).status,
    ).toBe("ready");
    expect(metric(fixture(), scenario, "environment.flood").value).toBeNull();
  });
});

describe("validation, consistency, and display", () => {
  it("does not label inferred housing totals as observed and preserves attribute provenance", () => {
    const place = fixture();
    place.buildings[0].estimated = true;
    place.buildings[0].attributeSourceId = "inferred-program";
    const scenario = createScenario("Inferred");
    for (const id of [
      "housing.units",
      "housing.density",
      "housing.multifamily",
      "land.floorArea",
    ]) {
      const result = metric(place, scenario, id);
      expect(result.status).toBe("incomplete");
      expect(result.caveat).toMatch(/inferred/);
      expect(result.sourceIds).toContain("inferred-program");
    }
    const observed = metric(fixture(), scenario, "housing.units");
    expect(observed.status).toBe("ready");
  });
  it("derives sensitivity bands from supplied input alternatives, not invented confidence intervals", () => {
    const place = fixture();
    place.buildings[0].jobs = 10;
    const scenario = createScenario("Wage sensitivity");
    const evidence = {
      sensitivity: {
        low: { annualWage: 50000 },
        high: { annualWage: 70000 },
        source: "User sensitivity assumptions",
        description: "Annual wage from $50k to $70k",
      },
    };
    const payroll = metric(place, scenario, "economy.payroll", evidence);
    expect(payroll.value).toBe(600000);
    expect(payroll.low).toBe(500000);
    expect(payroll.high).toBe(700000);
    expect(payroll.caveat).toContain("not statistical confidence intervals");
    expect(
      metric(place, scenario, "environment.flood", evidence).low,
    ).toBeUndefined();
  });
  it("produces deterministic numeric results and method provenance", () => {
    const place = fixture(),
      scenario = createScenario("Repeat");
    const first = calculateImpact(place, scenario),
      second = calculateImpact(place, scenario);
    expect(first.metrics).toEqual(second.metrics);
    expect(
      first.metrics.every(
        (m) =>
          m.methodVersion &&
          m.formula &&
          m.explanation &&
          m.scenarioRevision === scenario.revision,
      ),
    ).toBe(true);
    expect(new Set(first.metrics.map((m) => m.id)).size).toBe(
      first.metrics.length,
    );
    expect(new Set(first.metrics.map((m) => m.domain)).size).toBe(8);
  });
  it("rejects impossible inputs instead of silently clamping them", () => {
    const a = defaultAssumptions();
    expect(validateAssumptions(a)).toEqual([]);
    a.driveShare = 0.5;
    expect(validateAssumptions(a).some((i) => i.includes("sum to 1"))).toBe(
      true,
    );
    const scenario = createScenario("Invalid");
    scenario.assumptions.vacancyRate = 2;
    expect(() => calculateImpact(fixture(), scenario)).toThrow(/vacancyRate/);
    const place = fixture();
    place.buildings[0].units = Number.NaN;
    expect(() => calculateImpact(place, createScenario("Bad input"))).toThrow(
      /units/,
    );
  });
  it("formats zero distinctly from unknown and suppresses nonfinite display", () => {
    expect(formatMetric(null, "jobs")).toBe("—");
    expect(formatMetric(0, "jobs")).toBe("0");
    expect(formatMetric(Number.NaN, "jobs")).toBe("—");
    expect(formatMetric(1500000, "$/year")).toBe("$1.5M");
    expect(formatMetric(12.5, "%")).toBe("12.5%");
  });
});

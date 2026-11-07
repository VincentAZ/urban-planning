import { describe, it, expect } from "vitest";
import {
  USER_ACTIVITY_SOURCE,
  canonicalJSON,
  buildingProgramTotals,
  applyCommand,
  studyAreaSqm,
  type Place,
  type Building,
  type StudyAreaGeometry,
  type ActivityScenario,
  type VehicleAvailability,
  type BuildingProgramComponent,
} from "@urban/core";
import {
  adoptActivityScenario,
  resolveActivity,
  applyActivityPreset,
  calculateImpact,
  createScenario,
  fiscalCashFlows,
  ActivityResolutionError,
} from "./index";
const rect = (
  w: number,
  s: number,
  e: number,
  n: number,
): StudyAreaGeometry => ({
  type: "Polygon",
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});
function place(): Place {
  const b = (
    id: string,
    x: number,
    use: Building["use"],
    units: number,
    jobs: number,
  ): Building => ({
    id,
    name: id,
    use,
    geometry: rect(x, 0.001, x + 0.001, 0.002),
    areaSqm: studyAreaSqm(rect(x, 0.001, x + 0.001, 0.002)),
    height: 10,
    floors: 2,
    units,
    jobs,
    parkingSpaces: 10,
    estimated: false,
    sourceId: USER_ACTIVITY_SOURCE.id,
  });
  return {
    id: "activity-fixture",
    name: "Activity fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.005, 0.005],
    bounds: [0, 0, 0.01, 0.01],
    boundary: (
      rect(0, 0, 0.01, 0.01) as {
        type: "Polygon";
        coordinates: [number, number][][];
      }
    ).coordinates[0],
    buildings: [
      b("west-home", 0.001, "multifamily", 10, 0),
      b("east-home", 0.007, "multifamily", 10, 0),
      b("west-plant", 0.002, "industrial", 0, 50),
      b("east-office", 0.008, "office", 0, 50),
    ],
    roads: [],
    sources: [USER_ACTIVITY_SOURCE],
    coverage: [],
    extentLabel: "Synthetic activity boundary",
    loadedAt: "2026-11-05T00:00:00Z",
  };
}
function prepared() {
  const p = place(),
    s = createScenario("Activity");
  s.assumptions.annualGrowthRate = 0;
  s.baselineAssumptions.annualGrowthRate = 0;
  s.assumptions.householdSize = 2;
  s.baselineAssumptions.householdSize = 2;
  s.assumptions.vacancyRate = 0;
  s.baselineAssumptions.vacancyRate = 0;
  s.activity = adoptActivityScenario(p, s);
  s.sources = [USER_ACTIVITY_SOURCE];
  return { p, s, a: s.activity };
}
const metric = (p: Place, s: ReturnType<typeof createScenario>, id: string) =>
  calculateImpact(p, s).metrics.find((m) => m.id === id)!;
const west = (a: ActivityScenario) =>
  a.neighborhoods.push({
    id: "west",
    name: "West neighborhood",
    geometry: rect(0, 0, 0.005, 0.01),
    sourceId: USER_ACTIVITY_SOURCE.id,
  });
describe("explicit activity accounting", () => {
  it.each(["population", "employment", "vehicles"] as const)(
    "treats a known zero %s target as zero eligible response with positive physical capacity",
    (dimension) => {
      const { p, s, a } = prepared();
      p.buildings = p.buildings.filter((b) =>
        dimension === "employment" ? b.jobs! > 0 : b.units! > 0,
      );
      const before = canonicalJSON(p);
      const entered = {
        kind: "entered" as const,
        value: 0,
        sourceId: USER_ACTIVITY_SOURCE.id,
        asOfYear: 2026,
        universe: dimension,
      };
      a.reference[dimension] = entered;
      const key = dimension === "vehicles" ? "householdVehicles" : dimension;
      a.global[key] = { mode: "absolute", value: 0 };
      const originalTrips = metric(p, s, "mobility.dailyTrips").value;
      expect(originalTrips).toBeGreaterThan(0);
      a.demandResponse.reviewed = true;
      if (dimension === "population")
        a.demandResponse.population = "proportional-residential";
      else if (dimension === "employment")
        a.demandResponse.employment = "proportional-employment";
      else a.demandResponse.vehicles = "replace-residential-with-stock";
      expect(metric(p, s, "mobility.dailyTrips").value).toBe(0);
      if (dimension === "employment")
        expect(metric(p, s, "mobility.parkingDemand").value).toBe(0);
      a.global[key] = { mode: "absolute", value: 1 };
      expect(metric(p, s, "mobility.dailyTrips")).toMatchObject({
        value: null,
        status: "unavailable",
      });
      a.global[key] = { mode: "baseline-percent", percent: 125 };
      expect(metric(p, s, "mobility.dailyTrips").value).toBe(0);
      expect(canonicalJSON(p)).toBe(before);
      if (dimension !== "employment") {
        a.reference[dimension] = { kind: "published" };
        a.global[key] = { mode: "absolute", value: 0 };
        expect(metric(p, s, "mobility.dailyTrips").value).toBe(0);
        a.global[key] = { mode: "absolute", value: 1 };
        expect(metric(p, s, "mobility.dailyTrips").value).toBeNull();
      }
    },
  );
  it.each([3, 1e9, 1e-9])(
    "conserves a fully overridden global count of %s without cancellation or order-dependent unknowns",
    (count) => {
      const { p, s, a } = prepared();
      p.buildings = Array.from({ length: 5 }, (_, i) => ({
        ...p.buildings[0],
        id: `home-${i}`,
        footprint: undefined,
        geometry: rect(i * 0.002 + 0.0001, 0.001, i * 0.002 + 0.0011, 0.002),
        units: 10,
      }));
      a.global.population = { mode: "absolute", value: count };
      a.global.employment = { mode: "absolute", value: 0 };
      a.neighborhoods = Array.from({ length: 5 }, (_, i) => ({
        id: `area-${i}`,
        name: `Area ${i}`,
        geometry: rect(i * 0.002, 0, (i + 1) * 0.002, 0.01),
        population: { mode: "absolute" as const, value: 0 },
        sourceId: USER_ACTIVITY_SOURCE.id,
      }));
      s.assumptions.annualServiceCostPerResident = 1;
      s.assumptions.annualServiceCostPerJob = 0;
      for (let order = 0; order < 2; order++) {
        expect(resolveActivity(p, s).population).toMatchObject({
          value: 0,
          status: "ready",
        });
        expect(metric(p, s, "fiscal.serviceCost").value).toBe(0);
        a.neighborhoods.reverse();
      }
      // One genuinely uncovered fifth keeps its positive count, even at tiny scales.
      delete a.neighborhoods[4].population;
      const remaining = resolveActivity(p, s).population.value!;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining / (count / 5)).toBeCloseTo(1, 12);
    },
  );
  it("cancels horizon growth exactly once for eligible employment parking while keeping trips consistent", () => {
    const { p, s, a } = prepared();
    const component: BuildingProgramComponent = {
      id: "office",
      use: "office",
      grossFloorAreaSqm: 1000,
      units: 0,
      jobs: 100,
      tripRate: { basis: "job", value: 2, sourceId: USER_ACTIVITY_SOURCE.id },
      parkingRate: {
        basis: "job",
        value: 1,
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
    };
    p.buildings = [
      {
        ...p.buildings[2],
        use: "office",
        jobs: 100,
        program: {
          version: 1,
          grossFloorAreaSqm: 1000,
          commonAreaSqm: 0,
          components: [component],
        },
      },
    ];
    a.global.employment = { mode: "absolute", value: 100 };
    a.demandResponse = {
      ...a.demandResponse,
      employment: "proportional-employment",
      reviewed: true,
    };
    s.assumptions.annualGrowthRate = 0.1;
    for (const horizon of [0, 10] as const) {
      s.horizon = horizon;
      expect(metric(p, s, "mobility.parkingDemand").value).toBeCloseTo(100, 9);
      expect(metric(p, s, "mobility.dailyTrips").value).toBeCloseTo(200, 9);
    }
    // Default workplace floor-area parking uses the same employment sensitivity.
    delete component.parkingRate;
    const floorBased = metric(
      p,
      { ...s, horizon: 0 },
      "mobility.parkingDemand",
    ).value!;
    expect(metric(p, s, "mobility.parkingDemand").value).toBeCloseTo(
      floorBased,
      9,
    );
    a.demandResponse.employment = "none";
    expect(metric(p, s, "mobility.parkingDemand").value).toBeCloseTo(
      floorBased,
      9,
    );
  });
  it("honors each parking denominator in a mixed program, including an explicit residential job rate", () => {
    const { p, s, a } = prepared();
    const component = (
      id: string,
      use: BuildingProgramComponent["use"],
      basis: NonNullable<BuildingProgramComponent["parkingRate"]>["basis"],
      units: number,
      jobs: number,
      beds?: number,
    ): BuildingProgramComponent => ({
      id,
      use,
      grossFloorAreaSqm: 1000,
      units,
      jobs,
      ...(beds === undefined ? {} : { beds }),
      parkingRate: { basis, value: 1, sourceId: USER_ACTIVITY_SOURCE.id },
    });
    const components = [
      component("homes", "multifamily", "dwelling", 10, 0),
      component("occupied", "multifamily", "occupied-dwelling", 10, 0),
      component("res-staff", "multifamily", "job", 0, 10),
      component("care", "healthcare", "bed", 0, 20, 5),
      component("shops", "retail", "1000-sqft", 0, 30),
      component("office", "office", "job", 0, 40),
    ];
    p.buildings = [
      {
        ...p.buildings[0],
        use: "mixed-use",
        units: 20,
        jobs: 100,
        program: {
          version: 1,
          grossFloorAreaSqm: 6000,
          commonAreaSqm: 0,
          components,
        },
      },
    ];
    a.global.employment = { mode: "absolute", value: 50 };
    a.demandResponse = {
      ...a.demandResponse,
      employment: "proportional-employment",
      reviewed: true,
    };
    s.horizon = 10;
    s.assumptions.annualGrowthRate = 0.1;
    const fixed = 10 + 10 + 5 + (1000 * 10.7639104167) / 1000;
    expect(metric(p, s, "mobility.parkingDemand").value).toBeCloseTo(
      fixed + (10 + 40) * 0.5,
      7,
    );
    expect(p.buildings[0].units).toBe(20);
    expect(p.buildings[0].jobs).toBe(100);
  });
  it("supports exact absolute and baseline percentage targets without creating buildings or changing capacity", () => {
    const { p, s, a } = prepared(),
      original = canonicalJSON(p);
    a.global.population = { mode: "absolute", value: 50 };
    expect(resolveActivity(p, s).population).toMatchObject({
      reference: 40,
      beforeAreas: 50,
      value: 50,
      delta: 10,
      status: "ready",
    });
    expect(metric(p, s, "housing.units").value).toBe(20);
    expect(metric(p, s, "housing.residents").value).toBe(40);
    a.global.population = { mode: "baseline-percent", percent: 125 };
    expect(resolveActivity(p, s).population.value).toBe(50);
    expect(canonicalJSON(p)).toBe(original);
  });
  it("requires no spatial allocation when there are no neighborhoods, but distinguishes missing comparisons", () => {
    const { p, s, a } = prepared();
    p.buildings = [];
    a.reference.population = {
      kind: "entered",
      value: 100,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2026,
      universe: "Residents",
    };
    a.global.population = { mode: "absolute", value: 125 };
    let r = resolveActivity(p, s);
    expect(r.population.status).toBe("ready");
    expect(r.unallocated.population).toBe(0);
    expect(r.population.notes.join(" ")).not.toContain(
      "No usable spatial weights",
    );
    a.reference.population = { kind: "published" };
    r = resolveActivity(p, s);
    expect(r.population).toMatchObject({
      value: 125,
      reference: null,
      delta: null,
      status: "incomplete",
    });
  });
  it("replaces only the painted count and leaves outside activity unchanged, regardless of array order", () => {
    const { p, s, a } = prepared();
    west(a);
    a.global.population = { mode: "absolute", value: 80 };
    a.neighborhoods[0].population = { mode: "absolute", value: 30 };
    let r = resolveActivity(p, s);
    expect(r.population.beforeAreas).toBe(80);
    expect(r.neighborhoods[0].population.beforeAreas).toBeCloseTo(40);
    expect(r.population.value).toBeCloseTo(70);
    expect(r.buildingFactors["east-home"].population).toBe(2);
    expect(r.buildingFactors["west-home"].population).toBeCloseTo(1.5);
    a.neighborhoods.push({
      id: "east",
      name: "East",
      geometry: rect(0.005, 0, 0.01, 0.01),
      population: { mode: "absolute", value: 25 },
      sourceId: USER_ACTIVITY_SOURCE.id,
    });
    const first = resolveActivity(p, s);
    a.neighborhoods.reverse();
    r = resolveActivity(p, s);
    expect(r.population.value).toBeCloseTo(55);
    expect(r.population.value).toBeCloseTo(first.population.value!);
  });
  it("does not apply horizon growth twice to an absolute target or to fiscal costs", () => {
    const { p, s, a } = prepared();
    s.horizon = 10;
    s.assumptions.annualGrowthRate = 0.1;
    s.baselineAssumptions.annualGrowthRate = 0.1;
    a.global.population = { mode: "absolute", value: 100 };
    a.global.employment = { mode: "absolute", value: 20 };
    s.assumptions.annualServiceCostPerResident = 10;
    s.assumptions.annualServiceCostPerJob = 5;
    expect(resolveActivity(p, s).population.value).toBe(100);
    const flows = fiscalCashFlows(p, s, 2);
    expect(flows[0].serviceCost).toBe(1100);
    expect(flows[1].serviceCost).toBeCloseTo(1210);
  });
  it("closure changes effective jobs, payroll, cost and eligible workplace demand while keeping the building program", () => {
    const { p, s, a } = prepared();
    west(a);
    a.demandResponse = {
      ...a.demandResponse,
      employment: "proportional-employment",
      reviewed: true,
    };
    const before = calculateImpact(p, s);
    s.activity = applyActivityPreset(a, {
      kind: "plant-closure",
      neighborhoodId: "west",
      jobsRemoved: 50,
      currentEmployment: 50,
    });
    const after = calculateImpact(p, s),
      get = (results: typeof after, id: string) =>
        results.metrics.find((m) => m.id === id)!.value!;
    expect(get(after, "economy.jobs")).toBe(50);
    expect(get(after, "economy.programJobs")).toBe(100);
    expect(get(after, "economy.payroll")).toBe(50 * s.assumptions.annualWage);
    expect(get(after, "mobility.dailyTrips")).toBeLessThan(
      get(before, "mobility.dailyTrips"),
    );
    expect(get(after, "fiscal.serviceCost")).toBeLessThan(
      get(before, "fiscal.serviceCost"),
    );
    expect(get(after, "fiscal.propertyTax")).toBe(
      get(before, "fiscal.propertyTax"),
    );
    expect(p.buildings.find((b) => b.id === "west-plant")!.jobs).toBe(50);
  });
  it("preserves customer and bed demand when employment changes", () => {
    const { p, s, a } = prepared();
    p.buildings = p.buildings.filter((b) => b.units! > 0);
    const b = {
      ...p.buildings[0],
      id: "clinic",
      use: "healthcare" as const,
      units: 0,
      jobs: 10,
      program: {
        version: 1 as const,
        grossFloorAreaSqm: 1000,
        commonAreaSqm: 0,
        components: [
          {
            id: "care",
            use: "healthcare" as const,
            grossFloorAreaSqm: 1000,
            units: 0,
            jobs: 10,
            beds: 20,
            tripRate: {
              basis: "bed" as const,
              value: 3,
              sourceId: USER_ACTIVITY_SOURCE.id,
            },
          },
        ],
      },
    };
    p.buildings.push(b);
    a.global.employment = { mode: "absolute", value: 0 };
    a.demandResponse = {
      ...a.demandResponse,
      employment: "proportional-employment",
      reviewed: true,
    };
    const unchanged = {
      ...s,
      activity: {
        ...a,
        demandResponse: { ...a.demandResponse, employment: "none" as const },
      },
    };
    expect(metric(p, s, "mobility.dailyTrips").value).toBe(
      metric(p, unchanged, "mobility.dailyTrips").value,
    );
    expect(metric(p, s, "economy.jobs").value).toBe(0);
    p.buildings[p.buildings.length - 1] = {
      ...b,
      use: "retail",
      program: {
        ...b.program,
        components: [
          {
            ...b.program.components[0],
            use: "retail",
            tripRate: {
              basis: "1000-sqft",
              value: 3,
              sourceId: USER_ACTIVITY_SOURCE.id,
            },
          },
        ],
      },
    };
    expect(metric(p, s, "mobility.dailyTrips").value).toBe(
      metric(p, unchanged, "mobility.dailyTrips").value,
    );
  });
  it("keeps stock separate and replaces rather than multiplies residential population and vehicle ratios", () => {
    const { p, s, a } = prepared();
    p.buildings = p.buildings.filter((b) => b.units! > 0);
    a.reference.vehicles = {
      kind: "entered",
      value: 20,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2026,
      universe: "Household vehicles available",
    };
    a.global.householdVehicles = { mode: "absolute", value: 25 };
    a.global.population = { mode: "baseline-percent", percent: 125 };
    a.demandResponse = {
      ...a.demandResponse,
      population: "proportional-residential",
      reviewed: true,
    };
    const baseline = calculateImpact(p, {
      ...s,
      activity: undefined,
    }).metrics.find((m) => m.id === "mobility.dailyTrips")!.value!;
    expect(metric(p, s, "mobility.dailyTrips").value).toBeCloseTo(
      baseline * 1.25,
    );
    a.demandResponse.vehicles = "replace-residential-with-stock";
    expect(metric(p, s, "mobility.dailyTrips").value).toBeCloseTo(
      baseline * 1.25,
    );
    expect(metric(p, s, "activity.householdVehicles").value).toBe(25);
  });
  it("retains known absolute stock with unknown reference but does not invent a trip denominator", () => {
    const { p, s, a } = prepared();
    a.global.householdVehicles = { mode: "absolute", value: 100 };
    expect(resolveActivity(p, s).vehicles).toMatchObject({
      reference: null,
      value: 100,
      delta: null,
    });
    a.demandResponse = {
      ...a.demandResponse,
      vehicles: "replace-residential-with-stock",
      reviewed: true,
    };
    expect(metric(p, s, "mobility.dailyTrips")).toMatchObject({
      value: null,
      status: "unavailable",
    });
    expect(metric(p, s, "activity.householdVehicles").value).toBe(100);
  });
  it("preserves zero versus missing and leaves zero-weight populations explicitly unallocated", () => {
    const { p, s, a } = prepared();
    p.buildings = [];
    a.reference.population = {
      kind: "entered",
      value: 100,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2026,
      universe: "Residents",
    };
    a.global.population = { mode: "absolute", value: 100 };
    west(a);
    let r = resolveActivity(p, s);
    expect(r.unallocated.population).toBe(100);
    expect(r.neighborhoods[0].population.reference).toBeNull();
    a.neighborhoods[0].population = { mode: "absolute", value: 20 };
    r = resolveActivity(p, s);
    expect(r.neighborhoods[0].population.value).toBe(20);
    expect(r.population.value).toBeNull();
    a.allocation.population = "uniform-area";
    r = resolveActivity(p, s);
    expect(r.population.value).toBeCloseTo(70);
    expect(r.unallocated.population).toBe(0);
    a.reference.population = {
      kind: "entered",
      value: 0,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2026,
      universe: "Residents",
    };
    a.neighborhoods = [];
    a.global.population = { mode: "baseline-percent", percent: 125 };
    expect(resolveActivity(p, s).population.value).toBe(0);
  });
  it("does not fabricate zero trips for positive activity with no mapped demand denominator", () => {
    const { p, s, a } = prepared();
    p.buildings = [];
    a.reference.population = {
      kind: "entered",
      value: 100,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2026,
      universe: "Residents",
    };
    a.global.population = { mode: "absolute", value: 125 };
    a.demandResponse = {
      ...a.demandResponse,
      population: "proportional-residential",
      reviewed: true,
    };
    expect(metric(p, s, "activity.population").value).toBe(125);
    expect(metric(p, s, "mobility.dailyTrips")).toMatchObject({
      value: null,
      status: "unavailable",
    });
    a.global.population = { mode: "absolute", value: 0 };
    expect(metric(p, s, "mobility.dailyTrips").value).toBe(0);
    a.demandResponse.population = "none";
    a.demandResponse.employment = "proportional-employment";
    a.global.employment = { mode: "absolute", value: 25 };
    expect(metric(p, s, "mobility.dailyTrips").value).toBeNull();
    a.global.employment = { mode: "absolute", value: 0 };
    expect(metric(p, s, "mobility.dailyTrips").value).toBe(0);
  });
  it("keeps uniform-area counts known but demand unavailable where a new local population has no homes", () => {
    const { p, s, a } = prepared();
    p.buildings = p.buildings.filter((b) => b.id !== "west-home");
    west(a);
    a.allocation.population = "uniform-area";
    a.neighborhoods[0].population = { mode: "absolute", value: 30 };
    a.demandResponse = {
      ...a.demandResponse,
      population: "proportional-residential",
      reviewed: true,
    };
    expect(resolveActivity(p, s).population.value).not.toBeNull();
    expect(metric(p, s, "mobility.dailyTrips").value).toBeNull();
    expect(metric(p, s, "housing.units").value).toBe(10);
  });
  it("combines a global horizon target and local exception once, preserving entered units", () => {
    const { p, s, a } = prepared();
    s.horizon = 10;
    s.assumptions.annualGrowthRate = 0.1;
    s.baselineAssumptions.annualGrowthRate = 0.1;
    west(a);
    a.global.population = { mode: "absolute", value: 100 };
    a.neighborhoods[0].population = { mode: "absolute", value: 30 };
    expect(resolveActivity(p, s).population.value).toBeCloseTo(80);
    expect(metric(p, s, "housing.residents").value).toBe(40);
    s.buildingEdits["east-home"] = { ...p.buildings[1], units: 20 };
    delete a.global.population;
    delete a.neighborhoods[0].population;
    expect(resolveActivity(p, s).population.value).toBeCloseTo(60 * 1.1 ** 10);
    expect(metric(p, s, "housing.residents").value).toBe(60);
  });
  it("uses clipped straddler weights and holes without altering whole-building parcel rules", () => {
    const { p, s, a } = prepared();
    p.buildings = [
      {
        ...p.buildings[0],
        geometry: rect(0.002, 0.002, 0.008, 0.004),
        footprint: undefined,
        units: 10,
      },
    ];
    a.global.population = { mode: "absolute", value: 20 };
    west(a);
    expect(
      resolveActivity(p, s).neighborhoods[0].population.reference,
    ).toBeCloseTo(10);
    a.neighborhoods[0].geometry = {
      type: "Polygon",
      coordinates: [
        (rect(0, 0, 0.005, 0.01) as any).coordinates[0],
        (rect(0.003, 0.002, 0.004, 0.004) as any).coordinates[0],
      ],
    };
    expect(
      resolveActivity(p, s).neighborhoods[0].population.reference,
    ).toBeCloseTo(20 / 3, 5);
  });
  it("requires a real forecast input and records exact preset sources without fabricating rates", () => {
    const { a } = prepared();
    expect(() =>
      applyActivityPreset(a, { kind: "regional-forecast-10" }),
    ).toThrow(/forecast/);
    a.forecast = {
      sourceId: USER_ACTIVITY_SOURCE.id,
      geography: "Entered region",
      baseYear: 2026,
      targetYear: 2036,
      application: "regional-ratio",
      population: { baseline: 1000, target: 1200 },
    };
    const next = applyActivityPreset(a, { kind: "regional-forecast-10" });
    expect(next.global.population).toEqual({
      mode: "baseline-percent",
      percent: 120,
    });
    expect(next.preset?.sourceId).toBe(USER_ACTIVITY_SOURCE.id);
    expect(a.global.population).not.toEqual(next.global.population);
  });
  it("activity edits stale revision-bound evidence and retain legacy results when removed", () => {
    const { p, s, a } = prepared();
    delete s.activity;
    const original = calculateImpact(p, s);
    const next = applyCommand(s, {
      type: "scenario.activity",
      activity: a,
      sources: [USER_ACTIVITY_SOURCE],
    });
    const results = calculateImpact(p, next, {
      safety: {
        sourceId: USER_ACTIVITY_SOURCE.id,
        vintage: "2026",
        geography: p.extentLabel,
        scenarioRevision: s.revision,
        baselineConflictPoints: 1,
        scenarioConflictPoints: 2,
      },
    });
    expect(results.warnings.some((w) => w.includes("earlier revision"))).toBe(
      true,
    );
    const restored = calculateImpact(
      p,
      applyCommand(next, { type: "scenario.activity", activity: null }),
    );
    expect(restored.metrics.map(({ scenarioRevision, ...m }) => m)).toEqual(
      original.metrics.map(({ scenarioRevision, ...m }) => m),
    );
    expect(
      p.buildings.reduce((sum, b) => sum + buildingProgramTotals(b).units!, 0),
    ).toBe(20);
  });
  it("matches whole-ZCTA population and direct vehicle evidence while rejecting wider or suppressed references", () => {
    const { p, s, a } = prepared();
    const value = (n: number) => ({
      value: n,
      raw: String(n),
      annotation: null,
      status: "available" as const,
    });
    const measure = {
      label: "Residents",
      unit: "people" as const,
      universe: "Total population",
      estimate: value(1000),
      marginOfError: value(50),
      variables: {
        estimate: "B01003_001E",
        marginOfError: "B01003_001M",
        estimateAnnotation: "B01003_001EA",
        marginOfErrorAnnotation: "B01003_001MA",
      },
    };
    const source = {
      ...USER_ACTIVITY_SOURCE,
      id: "published-fixture",
      kind: "published-estimate" as const,
    };
    p.geography = { type: "zcta", code: p.zip, boundaryVintage: "2020" };
    p.demographics = {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      geography: {
        kind: "zcta",
        id: p.zip,
        name: "TestZCTA",
        relationshipToStudyArea: "same-area",
      },
      retrievedAt: "2026-11-05T00:00:00Z",
      confidenceLevel: 90,
      source,
      measures: {
        population: measure,
        households: { ...measure, estimate: value(400) },
        housingUnits: measure,
        medianHouseholdIncome: measure,
        povertyPercent: measure,
        bachelorsOrHigherPercent: measure,
      },
      notes: [],
    };
    p.vehicleAvailability = {
      version: 1,
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      geography: { ...p.demographics.geography, boundaryVintage: "2020" },
      retrievedAt: "2026-11-05T00:00:00Z",
      confidenceLevel: 90,
      source,
      measure: {
        ...measure,
        label: "Household vehicles available",
        unit: "vehicles",
        universe: "Occupied housing units",
        estimate: value(600),
        variables: {
          estimate: "B25046_001E",
          marginOfError: "B25046_001M",
          estimateAnnotation: "B25046_001EA",
          marginOfErrorAnnotation: "B25046_001MA",
        },
      },
      notes: [],
    };
    a.reference.population = { kind: "published" };
    a.reference.vehicles = { kind: "published" };
    a.global = {
      population: { mode: "baseline-percent", percent: 125 },
      householdVehicles: { mode: "baseline-percent", percent: 125 },
    };
    expect(resolveActivity(p, s).population).toMatchObject({
      reference: 1000,
      value: 1250,
    });
    expect(resolveActivity(p, s).vehicles).toMatchObject({
      reference: 600,
      value: 750,
    });
    expect(metric(p, s, "housing.residents").value).toBe(40);
    p.demographics.geography.relationshipToStudyArea = "context-only";
    p.vehicleAvailability.geography.relationshipToStudyArea = "context-only";
    expect(resolveActivity(p, s).population.reference).toBeNull();
    expect(resolveActivity(p, s).vehicles.reference).toBeNull();
    p.vehicleAvailability.geography.relationshipToStudyArea = "same-area";
    p.vehicleAvailability.measure.estimate = {
      value: null,
      raw: "-666666666",
      annotation: "-",
      status: "suppressed",
    };
    expect(resolveActivity(p, s).vehicles.reference).toBeNull();
    p.vehicleAvailability.measure.estimate = value(0);
    expect(resolveActivity(p, s).vehicles).toMatchObject({
      reference: 0,
      value: 0,
    });
  });
  it("rejects spatial complexity before clipping on every repeated attempt, independent of cache warmth", () => {
    const { p, s, a } = prepared();
    p.buildings = Array.from({ length: 501 }, (_, i) => ({
      ...p.buildings[0],
      id: `b-${i}`,
      footprint: undefined,
      geometry: rect(0, 0, 0.01, 0.01),
      areaSqm: studyAreaSqm(rect(0, 0, 0.01, 0.01)),
    }));
    a.neighborhoods = Array.from({ length: 100 }, (_, i) => ({
      id: `n-${i}`,
      name: `N${i}`,
      geometry: rect(i * 0.0001, 0, (i + 1) * 0.0001, 0.01),
      sourceId: USER_ACTIVITY_SOURCE.id,
    }));
    for (let attempt = 0; attempt < 3; attempt++)
      expect(() => resolveActivity(p, s)).toThrow(ActivityResolutionError);
  });
});

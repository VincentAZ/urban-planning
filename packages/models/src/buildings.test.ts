import { describe, it, expect } from "vitest";
import {
  applyBuildingGeometry,
  buildingGeometry,
  buildingProgramTotals,
  buildingGeometryAreaSqm,
  parcelPreset,
  canonicalJSON,
  transformBuildingGeometry,
  USER_BUILDING_SOURCE,
  type Building,
  type Place,
  type Position,
} from "@urban/core";
import {
  adoptBuildingProgram,
  buildingPreset,
  calculateImpact,
  calculateParcelContext,
  createScenario,
  defaultAssumptions,
  previewBuildingConversion,
  SQFT_PER_SQM,
  typedBuildingPreset,
} from "./index";
const box = (x: number, y: number, w: number): Position[] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
  [x, y],
];
const place = (): Place => ({
  id: "program-fixture",
  name: "Program fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0.005, 0.005],
  bounds: [0, 0, 0.02, 0.02],
  boundary: box(0, 0, 0.02),
  buildings: [],
  roads: [],
  sources: [USER_BUILDING_SOURCE],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic building program",
});
function mixed(): Building {
  const b = typedBuildingPreset("mixed-use", [0.005, 0.005]);
  return {
    ...b,
    units: 10,
    jobs: 30,
    parkingSpaces: 40,
    program: {
      version: 1,
      grossFloorAreaSqm: 1750,
      commonAreaSqm: 100,
      components: [
        {
          id: "homes",
          use: "multifamily",
          residentialSubtype: "apartment",
          grossFloorAreaSqm: 1000,
          units: 10,
          jobs: 0,
          tripRate: {
            basis: "occupied-dwelling",
            value: 4,
            sourceId: "home-rate",
          },
        },
        {
          id: "shops",
          use: "retail",
          grossFloorAreaSqm: 200,
          units: 0,
          jobs: 10,
        },
        {
          id: "office",
          use: "office",
          grossFloorAreaSqm: 300,
          units: 0,
          jobs: 20,
          tripRate: { basis: "job", value: 3, sourceId: "office-rate" },
          parkingRate: { basis: "job", value: 1, sourceId: "parking-rate" },
        },
        {
          id: "garage",
          use: "parking",
          grossFloorAreaSqm: 150,
          units: 0,
          jobs: 0,
        },
      ],
    },
  };
}
function results(b: Building) {
  const p = place(),
    s = createScenario("Explicit program");
  s.buildingEdits[b.id] = b;
  s.assumptions.fiscalInputsConfirmed = true;
  s.assumptions.jurisdictionName = "Synthetic rules";
  return calculateImpact(p, s);
}
const metric = (b: Building, id: string) =>
  results(b).metrics.find((m) => m.id === id)!;
describe("explicit building programs and conversions", () => {
  it("uses component floor areas, homes/jobs and rate denominators without duplicate garage demand or retail floor assumptions", () => {
    const b = mixed(),
      a = defaultAssumptions();
    const trips =
      10 * (1 - a.vacancyRate) * 4 +
      ((200 * SQFT_PER_SQM) / 1000) * a.tripRates.retail +
      20 * 3;
    expect(metric(b, "mobility.dailyTrips").value).toBeCloseTo(trips, 8);
    expect(metric(b, "mobility.parkingDemand").value).toBeCloseTo(
      10 * a.parkingPerUnit +
        ((200 * SQFT_PER_SQM) / 1000) * a.parkingPer1000Sqft +
        20,
      8,
    );
    expect(metric(b, "mobility.parkingSupply").value).toBe(40);
    expect(metric(b, "land.floorArea").value).toBeCloseTo(
      1750 * SQFT_PER_SQM,
      8,
    );
    expect(metric(b, "economy.jobs").value).toBe(30);
    expect(metric(b, "housing.units").value).toBe(10);
    expect(metric(b, "fiscal.salesTax").value).toBeCloseTo(
      200 *
        SQFT_PER_SQM *
        a.salesPerSqft *
        a.retailCaptureRate *
        a.localSalesTaxRate,
      6,
    );
    expect(metric(b, "mobility.dailyTrips").inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Proposal office: quantity × 3 per job",
          value: 20,
          source: "office-rate",
        }),
      ]),
    );
    expect(metric(b, "mobility.dailyTrips").sourceIds).toEqual(
      expect.arrayContaining(["home-rate", "office-rate", "parking-rate"]),
    );
    expect(results(b).warnings.join(" ")).toMatch(/uniform-height massing/);
  });
  it("honors all five explicit rate bases, including real zero beds and nonresidential jobs", () => {
    const a = defaultAssumptions();
    for (const [basis, expected] of [
      ["dwelling", 20],
      ["occupied-dwelling", 20 * (1 - a.vacancyRate)],
      ["1000-sqft", ((1000 * SQFT_PER_SQM) / 1000) * 2],
      ["job", 14],
      ["bed", 10],
    ] as const) {
      const b = typedBuildingPreset("apartments", [0.005, 0.005]);
      b.units = 10;
      b.jobs = 7;
      b.program = {
        version: 1,
        grossFloorAreaSqm: 1000,
        commonAreaSqm: 0,
        components: [
          {
            id: "only",
            use: "multifamily",
            grossFloorAreaSqm: 1000,
            units: 10,
            jobs: 7,
            beds: 5,
            tripRate: { basis, value: 2, sourceId: "fixture" },
          },
        ],
      };
      expect(metric(b, "mobility.dailyTrips").value, basis).toBeCloseTo(
        expected,
        8,
      );
    }
    const hospital = typedBuildingPreset("hospital", [0.005, 0.005]);
    hospital.program!.components[0].beds = 0;
    hospital.program!.components[0].tripRate = {
      basis: "bed",
      value: 10,
      sourceId: "fixture",
    };
    expect(metric(hospital, "mobility.dailyTrips").value).toBe(0);
  });
  it("provides distinct townhome/hospital defaults while preserving all legacy presets", () => {
    const old = buildingPreset("residential", [0.005, 0.005]);
    expect(old).not.toHaveProperty("program");
    expect(old).not.toHaveProperty("geometry");
    const town = typedBuildingPreset("townhome", [0.005, 0.005]),
      hospital = typedBuildingPreset("hospital", [0.005, 0.005]);
    expect(town.typology).toBe("townhome");
    expect(town.program!.components[0].residentialSubtype).toBe("townhome");
    expect(metric(town, "housing.townhome").value).toBe(6);
    expect(hospital.typology).toBe("hospital");
    expect(hospital.program!.components[0].beds).toBe(120);
    expect(results(hospital).warnings.join(" ")).toMatch(
      /medical-service capacity/,
    );
  });
  it("retains legacy mixed-use calculations and explicitly adopts custom legacy trip assumptions without changing the source", () => {
    const b = buildingPreset("mixed-use", [0.005, 0.005]),
      p = place(),
      s = createScenario("Legacy custom rate");
    s.assumptions.tripRates["mixed-use"] = 9;
    s.buildingEdits[b.id] = b;
    const original = canonicalJSON(b),
      before = calculateImpact(p, s),
      adopted = adoptBuildingProgram(b, s.assumptions);
    const after = calculateImpact(p, {
      ...s,
      buildingEdits: { [b.id]: adopted },
    });
    for (const id of [
      "mobility.dailyTrips",
      "mobility.parkingDemand",
      "housing.units",
      "economy.jobs",
      "land.floorArea",
    ])
      expect(after.metrics.find((m) => m.id === id)!.value, id).toBeCloseTo(
        before.metrics.find((m) => m.id === id)!.value!,
        8,
      );
    expect(canonicalJSON(b)).toBe(original);
  });
  it("preserves entered counts/program when reshaping or choosing preserve-program conversion; defaults replacement is explicit", () => {
    const b = {
        ...mixed(),
        assessedValue: 123456,
        parcelId: "retained-parcel",
        maxHeight: 18,
        address: "Source address",
      },
      original = canonicalJSON(b),
      larger = applyBuildingGeometry(
        b,
        transformBuildingGeometry(buildingGeometry(b), { scale: 1.5 }),
      );
    expect(buildingProgramTotals(larger)).toEqual(buildingProgramTotals(b));
    expect(metric(larger, "mobility.dailyTrips").value).toBe(
      metric(b, "mobility.dailyTrips").value,
    );
    const retained = previewBuildingConversion(
      b,
      "hospital",
      "preserve-program",
    );
    expect(retained.building.program).toEqual(b.program);
    expect(retained.building.jobs).toBe(30);
    const changed = previewBuildingConversion(b, "hospital", "typed-defaults");
    expect(changed.building.jobs).toBe(450);
    expect(changed.building).toMatchObject({
      assessedValue: 123456,
      parcelId: "retained-parcel",
      maxHeight: 18,
      address: "Source address",
    });
    expect(changed.building.id).toBe(b.id);
    expect(buildingGeometry(changed.building)).toEqual(buildingGeometry(b));
    expect(changed.warnings.join(" ")).toContain("replace floors");
    expect(canonicalJSON(b)).toBe(original);
  });
  it("rejects contradictory program quantities in calculations rather than choosing a convenient mirror", () => {
    const b = mixed();
    b.jobs = 31;
    expect(() => results(b)).toThrow(/authoritative program/);
  });
  it("uses all courtyard/island geometry and explicit GFA in parcel context without allocating a straddling campus", () => {
    const source = place(),
      proposal = createScenario("Campus");
    const building = applyBuildingGeometry(mixed(), {
      type: "MultiPolygon",
      coordinates: [
        [box(0.003, 0.003, 0.003), box(0.004, 0.004, 0.001)],
        [box(0.009, 0.003, 0.001)],
      ],
    });
    proposal.buildingEdits[building.id] = building;
    const whole = parcelPreset({
        type: "Polygon",
        coordinates: [box(0.002, 0.002, 0.01)],
      }),
      partial = parcelPreset({
        type: "Polygon",
        coordinates: [box(0.002, 0.002, 0.005)],
      });
    source.parcels = [whole];
    const profile = calculateParcelContext(source, proposal, whole.id)!;
    expect(profile.proposal.grossFloorAreaSqm).toBe(1750);
    expect(profile.proposal.units).toBe(10);
    expect(profile.proposal.footprintUnionSqm).toBeCloseTo(
      buildingGeometryAreaSqm(building),
      6,
    );
    source.parcels = [partial];
    const unresolved = calculateParcelContext(source, proposal, partial.id)!;
    expect(unresolved.proposal.straddlingBuildingIds).toEqual([building.id]);
    expect(unresolved.proposal.far).toBeNull();
    expect(unresolved.proposal.units).toBeNull();
  });
  it("classifies an adopted legacy nonresidential building with homes as mixed-use while retaining every entered quantity", () => {
    const legacy = {
      ...buildingPreset("office", [0.005, 0.005]),
      units: 12,
      jobs: 55,
    };
    const adopted = adoptBuildingProgram(legacy);
    expect(adopted.use).toBe("mixed-use");
    expect(adopted.units).toBe(12);
    expect(adopted.jobs).toBe(55);
    expect(
      previewBuildingConversion(legacy, "hospital", "preserve-program").building
        .use,
    ).toBe("mixed-use");
    const bad = { ...mixed(), use: "office" as const };
    expect(() => results(bad)).toThrow(/land use must match/);
  });
  it("isolates explanatory inputs across metrics and labels legacy-only housing buckets accurately", () => {
    const report = results(mixed()),
      relevant = new Set([
        "land.floorArea",
        "land.far",
        "mobility.dailyTrips",
        "mobility.parkingDemand",
        "economy.payroll",
        "fiscal.propertyTax",
        "fiscal.salesTax",
      ]);
    for (const metric of report.metrics)
      expect(
        metric.inputs.filter((i) => i.name === "Explicit program buildings"),
        metric.id,
      ).toHaveLength(relevant.has(metric.id) ? 1 : 0);
    expect(
      report.metrics.find((m) => m.id === "housing.mixed-use"),
    ).toMatchObject({ label: "Unclassified mixed-use homes", value: 0 });
    expect(
      report.metrics.find((m) => m.id === "housing.mixed-use")!.explanation,
    ).toContain("not the total number");
    expect(
      report.metrics
        .find((m) => m.id === "fiscal.serviceCost")!
        .inputs.some((i) => i.name.startsWith("Proposal ")),
    ).toBe(false);
  });
});

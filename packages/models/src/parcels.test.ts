import { describe, expect, it } from "vitest";
import {
  applyCommand,
  materializeParcels,
  parcelAreaSqm,
  parcelPreset,
  splitParcel,
  USER_PARCEL_SOURCE,
  type Building,
  type Place,
  type Position,
} from "@urban/core";
import {
  calculateImpact,
  calculateParcelContext,
  createScenario,
} from "./index";
const box = (x: number, y: number, w: number, h = w): Position[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];
const lot = (x: number, y: number, w: number, h = w) =>
  parcelPreset({ type: "Polygon", coordinates: [box(x, y, w, h)] });
const structure = (
  id: string,
  x: number,
  y: number,
  w: number,
  floors = 2,
): Building => ({
  id,
  name: id,
  use: "multifamily",
  footprint: box(x, y, w),
  areaSqm: parcelAreaSqm({ type: "Polygon", coordinates: [box(x, y, w)] }),
  floors,
  height: floors * 3,
  units: 4,
  jobs: 2,
  parkingSpaces: 0,
  sourceId: "survey",
  estimated: false,
});
function fixture(): Place {
  return {
    id: "parcel-metrics",
    name: "Parcel metrics",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.005, 0.005],
    bounds: [0, 0, 0.02, 0.02],
    boundary: box(0, 0, 0.02),
    buildings: [structure("one", 0.002, 0.002, 0.001)],
    roads: [],
    sources: [
      {
        id: "survey",
        name: "Fixture geometry",
        url: "",
        kind: "observed",
        vintage: "fixture",
        license: "test",
      },
    ],
    coverage: [],
    loadedAt: "2026-11-05",
    extentLabel: "Synthetic geometry",
  };
}
const result = (
  place: Place,
  scenario: ReturnType<typeof createScenario>,
  id: string,
) => calculateImpact(place, scenario).metrics.find((m) => m.id === id)!;
describe("parcel development context and scorecard", () => {
  it("derives full-footprint association, floor area, union coverage, units and jobs without mutating reported parcel IDs", () => {
    const place = fixture(),
      parcel = lot(0.001, 0.001, 0.005);
    place.parcels = [parcel];
    place.buildings[0].parcelId = "external-recorded-id";
    const before = structuredClone(place),
      context = calculateParcelContext(
        place,
        createScenario("Option"),
        parcel.id,
      );
    expect(context.proposal.containedBuildingIds).toEqual(["one"]);
    expect(context.proposal.straddlingBuildingIds).toEqual([]);
    expect(context.proposal.declaredLinkMismatchIds).toEqual(["one"]);
    expect(context.proposal.grossFloorAreaSqm).toBe(
      place.buildings[0].areaSqm * 2,
    );
    expect(context.proposal.far).toBeCloseTo(
      (place.buildings[0].areaSqm * 2) / parcelAreaSqm(parcel),
      10,
    );
    expect(context.proposal.lotCoveragePercent).toBeCloseTo(
      (place.buildings[0].areaSqm / parcelAreaSqm(parcel)) * 100,
      8,
    );
    expect(context.proposal.units).toBe(4);
    expect(context.proposal.jobs).toBe(2);
    expect(place).toEqual(before);
    expect(context.warnings[0]).toContain("same selected boundary");
  });
  it("discloses reported assignments east of the parcel even when spatial candidate traversal has stopped", () => {
    const place = fixture(),
      parcel = lot(0.001, 0.001, 0.004);
    place.parcels = [parcel];
    place.buildings.push({
      ...structure("outside-east", 0.012, 0.002, 0.001),
      parcelId: parcel.id,
    });
    const profile = calculateParcelContext(
      place,
      createScenario("Option"),
      parcel.id,
    ).proposal;
    expect(profile.declaredLinkMismatchIds).toEqual(["outside-east"]);
    expect(profile.containedBuildingIds).toEqual(["one"]);
    expect(profile.status).toBe("incomplete");
  });
  it("reports straddling buildings explicitly and withholds program allocation while retaining exact clipped coverage", () => {
    const place = fixture(),
      parcel = lot(0.0025, 0.001, 0.003);
    place.parcels = [parcel];
    const profile = calculateParcelContext(
      place,
      createScenario("Option"),
      parcel.id,
    ).proposal;
    expect(profile.containedBuildingIds).toEqual([]);
    expect(profile.straddlingBuildingIds).toEqual(["one"]);
    expect(profile.grossFloorAreaSqm).toBeNull();
    expect(profile.far).toBeNull();
    expect(profile.units).toBeNull();
    expect(profile.jobs).toBeNull();
    expect(profile.lotCoveragePercent).toBeGreaterThan(0);
    expect(profile.status).toBe("incomplete");
    expect(
      result(place, createScenario("Option"), "land.far").value,
    ).toBeNull();
  });
  it("unions overlapping structural footprints once, excludes parks, and labels inferred floor counts", () => {
    const place = fixture(),
      parcel = lot(0.001, 0.001, 0.005);
    place.parcels = [parcel];
    place.buildings.push(
      {
        ...structuredClone(place.buildings[0]),
        id: "stacked",
        estimated: true,
      },
      { ...structure("park", 0.001, 0.001, 0.004), use: "park" },
    );
    const profile = calculateParcelContext(
      place,
      createScenario("Option"),
      parcel.id,
    ).proposal;
    expect(profile.buildingCount).toBe(2);
    expect(profile.footprintUnionSqm).toBeCloseTo(
      place.buildings[0].areaSqm,
      6,
    );
    expect(profile.grossFloorAreaSqm).toBe(place.buildings[0].areaSqm * 4);
    expect(profile.status).toBe("incomplete");
    expect(profile.caveats.join(" ")).toContain("inferred");
  });
  it("does not invent baseline parcels for a user-drawn proposal and excludes block outlines from aggregate denominators", () => {
    const place = fixture(),
      parcel = lot(0.001, 0.001, 0.005),
      block = { ...lot(0, 0, 0.01), kind: "block" as const };
    let scenario = applyCommand(createScenario("Lots"), {
      type: "parcels.import",
      parcels: [parcel, block],
      source: USER_PARCEL_SOURCE,
    });
    const far = result(place, scenario, "land.far");
    expect(far.baseline).toBeNull();
    expect(far.delta).toBeNull();
    expect(far.value).toBeCloseTo(
      (place.buildings[0].areaSqm * 2) / parcelAreaSqm(parcel),
      10,
    );
    expect(far.sourceIds).toContain(USER_PARCEL_SOURCE.id);
    const context = calculateParcelContext(place, scenario, parcel.id);
    expect(context.baseline.far).toBe(context.proposal.far); // same proposed site boundary, clearly contextual
    scenario = applyCommand(scenario, { type: "parcel.remove", id: parcel.id });
    expect(result(place, scenario, "land.far").value).toBeNull();
    expect(
      calculateParcelContext(place, scenario, block.id).warnings.join(" "),
    ).toContain("excluded");
  });
  it("keeps aggregate FAR unchanged by subdivision while exposing per-lot straddlers, and recomputes after building removal", () => {
    const place = fixture(),
      parcel = lot(0.001, 0.001, 0.005);
    place.parcels = [parcel];
    const baseline = createScenario("Subdivision"),
      children = splitParcel(parcel, [
        [0.0025, 0],
        [0.0025, 0.01],
      ]);
    const scenario = applyCommand(baseline, {
      type: "parcels.replace",
      operation: "split",
      removeIds: [parcel.id],
      parcels: children,
      source: USER_PARCEL_SOURCE,
    });
    expect(materializeParcels(place, scenario)).toHaveLength(2);
    expect(result(place, scenario, "land.far").delta).toBeCloseTo(0, 10);
    for (const child of children)
      expect(
        calculateParcelContext(place, scenario, child.id).proposal.far,
      ).toBeNull();
    const removed = applyCommand(scenario, {
      type: "building.remove",
      id: "one",
    });
    expect(result(place, removed, "land.far").value).toBe(0);
    expect(result(place, removed, "land.far").baseline).toBeGreaterThan(0);
    expect(
      calculateParcelContext(place, removed, children[0].id).proposal
        .buildingCount,
    ).toBe(0);
    expect(place.buildings).toHaveLength(1);
    expect(place.parcels).toEqual([parcel]);
  });
  it("retains holes in association and area, and retains legacy external evidence when geometry is absent", () => {
    const place = fixture(),
      parcel = parcelPreset({
        type: "Polygon",
        coordinates: [box(0.001, 0.001, 0.008), box(0.0015, 0.0015, 0.002)],
      });
    place.parcels = [parcel];
    const profile = calculateParcelContext(
      place,
      createScenario("Option"),
      parcel.id,
    ).proposal;
    expect(profile.buildingCount).toBe(0);
    expect(profile.footprintUnionSqm).toBe(0);
    delete place.parcels;
    place.buildings[0].parcelId = "legacy";
    const evidence = {
      parcels: {
        sourceId: "survey",
        vintage: "Fixture",
        method: "Supplied parcel register",
        geography: "Recorded legacy lot",
        parcels: [{ id: "legacy", areaSqm: 5000 }],
      },
    };
    const far = calculateImpact(
      place,
      createScenario("Legacy"),
      evidence,
    ).metrics.find((m) => m.id === "land.far")!;
    expect(far.value).toBeCloseTo((place.buildings[0].areaSqm * 2) / 5000, 12);
    expect(far.geography).toBe("Recorded legacy lot");
  });
});

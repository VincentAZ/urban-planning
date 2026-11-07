import { describe, it, expect } from "vitest";
import {
  createProject,
  createScenario,
  adoptActivityScenario,
} from "@urban/models";
import {
  applyCommand,
  canonicalJSON,
  baselineIdentity,
  validateProjectSnapshot,
  validateActivityScenario,
  projectWithActivityVersion,
  projectWithPresentationVersion,
  USER_ACTIVITY_SOURCE,
  vehicleAvailabilitySchema,
  type Place,
  type VehicleAvailability,
  type HistoryEntry,
  type ActivityScenario,
} from "./index";
import {
  commandSchema,
  projectSchema,
  activityScenarioSchema,
} from "./validation";
const place: Place = {
  id: "activity-test",
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
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic test area",
};
const area = (w = 0, e = 0.005) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [w, 0],
      [e, 0],
      [e, 0.01],
      [w, 0.01],
      [w, 0],
    ] as [number, number][],
  ],
});
function scenario() {
  const s = createScenario("Activity");
  return { s, a: adoptActivityScenario(place, s) };
}
function vehicle(): VehicleAvailability {
  const available = {
    value: 10,
    raw: "10",
    annotation: null,
    status: "available" as const,
  };
  return {
    version: 1,
    dataset: "acs/acs5",
    vintage: 2024,
    period: { start: 2020, end: 2024 },
    geography: {
      kind: "zcta",
      id: "85004",
      name: "ZCTA85004",
      boundaryVintage: "2020",
      relationshipToStudyArea: "same-area",
    },
    retrievedAt: "2026-11-05T00:00:00Z",
    confidenceLevel: 90,
    source: {
      ...USER_ACTIVITY_SOURCE,
      id: "vehicle-source",
      url: "https://api.census.gov/data/2024/acs/acs5/groups/B25046.html",
      kind: "published-estimate",
    },
    measure: {
      label: "Household vehicles available",
      unit: "vehicles",
      universe: "Occupied housing units",
      estimate: available,
      marginOfError: { ...available, value: 2, raw: "2" },
      variables: {
        estimate: "B25046_001E",
        marginOfError: "B25046_001M",
        estimateAnnotation: "B25046_001EA",
        marginOfErrorAnnotation: "B25046_001MA",
      },
    },
    notes: [],
  };
}
describe("activity controls persisted contract", () => {
  it("applies one deep-copied revision, optional horizon and complete source provenance without modifying geometry", () => {
    const { s, a } = scenario();
    const before = canonicalJSON(place);
    const next = applyCommand(s, {
      type: "scenario.activity",
      activity: a,
      horizon: 10,
    });
    a.global.population = { mode: "absolute", value: 900 };
    expect(next.activity?.global.population).not.toEqual(a.global.population);
    expect(next.revision).toBe(1);
    expect(next.horizon).toBe(10);
    expect(next.sources?.some((s) => s.id === USER_ACTIVITY_SOURCE.id)).toBe(
      true,
    );
    expect(canonicalJSON(place)).toBe(before);
    const child = createScenario("Branch", next);
    child.activity!.global.population = { mode: "absolute", value: 200 };
    expect(next.activity?.global.population).not.toEqual(
      child.activity?.global.population,
    );
    const cleared = applyCommand(next, {
      type: "scenario.activity",
      activity: null,
    });
    expect(Object.hasOwn(cleared, "activity")).toBe(false);
  });
  it("rejects invalid targets, unsafe IDs, unknown fields and unreviewed responses even via direct helpers", () => {
    const { s, a } = scenario();
    for (const value of [-1, Infinity, NaN])
      expect(
        activityScenarioSchema.safeParse({
          ...a,
          global: { population: { mode: "absolute", value } },
        }).success,
      ).toBe(false);
    expect(
      activityScenarioSchema.safeParse({
        ...a,
        demandResponse: {
          ...a.demandResponse,
          population: "proportional-residential",
        },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        type: "scenario.activity",
        activity: { ...a, computedPopulation: 99 },
      }).success,
    ).toBe(false);
    for (const id of ["__proto__", "constructor", "toString"]) {
      const bad = {
        ...a,
        neighborhoods: [
          {
            id,
            name: "Area",
            geometry: area(),
            sourceId: USER_ACTIVITY_SOURCE.id,
          },
        ],
      };
      expect(() =>
        applyCommand(s, { type: "scenario.activity", activity: bad }),
      ).toThrow();
    }
    expect(() =>
      applyCommand(
        { ...s, id: "baseline" },
        { type: "scenario.activity", activity: a },
      ),
    ).toThrow(/baseline/);
  });
  it("rejects overlapping and outside neighborhoods with no source mutation", () => {
    const { a } = scenario();
    a.neighborhoods = [
      {
        id: "a",
        name: "A",
        geometry: area(),
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
      {
        id: "b",
        name: "B",
        geometry: area(0.004, 0.009),
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
    ];
    expect(() => validateActivityScenario(a, place)).toThrow(/overlap/);
    a.neighborhoods = [
      { ...a.neighborhoods[0], geometry: area(-0.001, 0.005) },
    ];
    expect(() => validateActivityScenario(a, place)).toThrow();
  });
  it("requires format5 across current/history/undone and preserves all prior formats and baseline hashes", async () => {
    const original = createProject(place),
      identity = await baselineIdentity(place);
    for (const version of [1, 2, 3, 4] as const) {
      const p = { ...original, schemaVersion: version };
      expect(canonicalJSON(projectWithActivityVersion(p, place))).toBe(
        canonicalJSON(p),
      );
    }
    const before = original.scenarios[1],
      after = applyCommand(before, {
        type: "scenario.activity",
        activity: adoptActivityScenario(place, before),
      });
    const entry: HistoryEntry = {
      id: "h",
      at: new Date().toISOString(),
      actor: "Test",
      label: "Activity",
      command: { type: "scenario.activity", activity: after.activity! },
      before,
      after,
    };
    const p = projectWithActivityVersion(
      {
        ...original,
        scenarios: [original.scenarios[0], after],
        history: [entry],
      },
      place,
    );
    expect(p.schemaVersion).toBe(5);
    expect(projectWithPresentationVersion(p).schemaVersion).toBe(5);
    expect(projectSchema.safeParse({ ...p, schemaVersion: 4 }).success).toBe(
      false,
    );
    const restored = {
      ...p,
      scenarios: original.scenarios,
      history: [],
      undone: [entry],
    };
    expect(
      projectSchema.safeParse({ ...restored, schemaVersion: 4 }).success,
    ).toBe(false);
    const roundtrip = await validateProjectSnapshot({
      project: restored,
      place,
      baselineIdentity: identity,
    });
    expect(roundtrip.baselineIdentity).toEqual(identity);
    expect(canonicalJSON(roundtrip.place)).toBe(canonicalJSON(place));
    const bad = structuredClone(restored);
    bad.undone[0].after.activity!.global.population = {
      mode: "absolute",
      value: -1,
    };
    await expect(
      validateProjectSnapshot({ project: bad, place }),
    ).rejects.toThrow();
    const badCommand = structuredClone(restored);
    if (badCommand.undone[0].command.type === "scenario.activity")
      badCommand.undone[0].command.activity!.neighborhoods = [
        {
          id: "outside",
          name: "Outside",
          geometry: area(-0.001, 0.005),
          sourceId: USER_ACTIVITY_SOURCE.id,
        },
      ];
    await expect(
      validateProjectSnapshot({ project: badCommand, place }),
    ).rejects.toThrow();
  });
  it("retains exact vehicle supplement semantics and only adopts matching complete geography", async () => {
    const v = vehicle();
    expect(vehicleAvailabilitySchema.safeParse(v).success).toBe(true);
    expect(
      vehicleAvailabilitySchema.safeParse({
        ...v,
        measure: { ...v.measure, unit: "people" },
      }).success,
    ).toBe(false);
    const exact = {
      ...place,
      geography: {
        type: "zcta" as const,
        code: "85004",
        boundaryVintage: "2020" as const,
      },
    };
    const { a } = scenario();
    a.vehicleReference = v;
    expect(() => validateActivityScenario(a, exact)).not.toThrow();
    expect(() => validateActivityScenario(a, place)).toThrow(
      /complete captured/,
    );
    const p = createProject({ ...exact, vehicleAvailability: v });
    expect(p.schemaVersion).toBe(5);
    await expect(
      validateProjectSnapshot({
        project: { ...p, schemaVersion: 4 },
        place: { ...exact, vehicleAvailability: v },
      }),
    ).rejects.toThrow(/version 5/);
    const suppressed = structuredClone(v);
    suppressed.measure.estimate = {
      value: null,
      raw: "-666666666",
      annotation: "-",
      status: "suppressed",
    };
    expect(vehicleAvailabilitySchema.safeParse(suppressed).success).toBe(true);
    suppressed.measure.estimate.value = 0;
    expect(vehicleAvailabilitySchema.safeParse(suppressed).success).toBe(false);
  });
});

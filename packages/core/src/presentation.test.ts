import { describe, expect, it } from "vitest";
import {
  calculateImpact,
  createProject,
  createScenario,
  typedBuildingPreset,
} from "@urban/models";
import {
  applyCommand,
  assertScenarioPresentation,
  baselineIdentity,
  canonicalJSON,
  projectWithBuildingVersion,
  projectWithPresentationVersion,
  validateProjectSnapshot,
  type Command,
  type HistoryEntry,
  type Place,
  type ScenarioPresentation,
} from "./index";
import {
  commandSchema,
  projectSchema,
  scenarioPresentationSchema,
} from "./validation";

const place: Place = {
  id: "tour-fixture",
  name: "Tour fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.45],
  bounds: [-112.08, 33.44, -112.06, 33.46],
  boundary: [
    [-112.08, 33.44],
    [-112.06, 33.44],
    [-112.06, 33.46],
    [-112.08, 33.46],
    [-112.08, 33.44],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic tour fixture",
};
function presentation(): ScenarioPresentation {
  return {
    version: 1,
    title: "A clearer decision",
    stops: [
      {
        id: "stop-overview",
        title: "The whole area",
        callout: "User-authored context; inspect the stated assumptions.",
        camera: { center: [-112.1, 33.5], zoom: 12, pitch: 45, bearing: -27 },
        view: "3d",
        metricIds: ["housing.units", "mobility.los"],
        narration: "This is an authored narrative, not an observed forecast.",
      },
      {
        id: "stop-plan",
        title: "A plan view",
        callout: "",
        camera: { center: [...place.center], zoom: 18, pitch: 0, bearing: 0 },
        view: "2d",
      },
    ],
  };
}
function authoredProject() {
  const project = createProject(place),
    before = project.scenarios[1];
  const command: Command = {
    type: "scenario.presentation",
    presentation: presentation(),
  };
  const after = applyCommand(before, command);
  const entry: HistoryEntry = {
    id: "tour-history",
    at: after.updatedAt,
    actor: "Fixture",
    label: "Save presentation",
    command,
    before,
    after,
  };
  project.scenarios[1] = after;
  project.history = [entry];
  return projectWithPresentationVersion(project, place);
}

describe("saved presentation contract", () => {
  it("preserves an ordered authored tour without modifying source, geometry, quantities or calculated values", () => {
    const before = createScenario("Option A"),
      original = canonicalJSON(before),
      source = canonicalJSON(place),
      tour = presentation();
    const oldResults = calculateImpact(place, before);
    const after = applyCommand(before, {
      type: "scenario.presentation",
      presentation: tour,
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.presentation).toEqual(tour);
    expect(after.presentation).not.toBe(tour);
    tour.stops[0].title = "Changed input object";
    expect(after.presentation!.stops[0].title).toBe("The whole area");
    expect(after.buildingEdits).toEqual(before.buildingEdits);
    expect(after.assumptions).toEqual(before.assumptions);
    expect(canonicalJSON(before)).toBe(original);
    expect(canonicalJSON(place)).toBe(source);
    const results = calculateImpact(place, after);
    expect(results.revision).toBe(after.revision);
    expect(
      results.metrics.map(({ id, value, baseline, delta, status }) => ({
        id,
        value,
        baseline,
        delta,
        status,
      })),
    ).toEqual(
      oldResults.metrics.map(({ id, value, baseline, delta, status }) => ({
        id,
        value,
        baseline,
        delta,
        status,
      })),
    );
  });

  it("accepts surrounding-context viewpoints and safe unresolved metric references without inventing values", () => {
    const tour = presentation();
    tour.stops[0].metricIds = [
      "future.metric",
      "housing.townhome",
      "mobility.los",
    ];
    expect(scenarioPresentationSchema.parse(tour)).toEqual(tour);
    expect(tour.stops[0].camera.center[0]).toBeLessThan(place.bounds[0]);
    expect(() => assertScenarioPresentation(tour)).not.toThrow();
  });

  it("rejects unsafe IDs, duplicate stops or metrics, non-finite and out-of-range cameras, excess text and stored result values", () => {
    const invalid: ((value: ScenarioPresentation) => void)[] = [
      (x) => {
        x.stops[0].id = "__proto__";
      },
      (x) => {
        x.stops[1].id = x.stops[0].id;
      },
      (x) => {
        x.stops[0].metricIds = ["constructor"];
      },
      (x) => {
        x.stops[0].metricIds = ["housing.units", "housing.units"];
      },
      (x) => {
        x.stops[0].metricIds = Array.from(
          { length: 7 },
          (_, i) => `metric.${i}`,
        );
      },
      (x) => {
        x.stops[0].camera.zoom = NaN;
      },
      (x) => {
        x.stops[0].camera.center[0] = Infinity;
      },
      (x) => {
        x.stops[0].camera.center[1] = 85.01;
      },
      (x) => {
        x.stops[0].camera.zoom = 21.01;
      },
      (x) => {
        x.stops[0].camera.zoom = 1.99;
      },
      (x) => {
        x.stops[0].camera.pitch = 60.01;
      },
      (x) => {
        x.stops[0].camera.bearing = 180.01;
      },
      (x) => {
        x.title = " ";
      },
      (x) => {
        x.stops[0].title = "t".repeat(161);
      },
      (x) => {
        x.stops[0].callout = "c".repeat(2001);
      },
      (x) => {
        x.stops[0].narration = "n".repeat(4001);
      },
      (x) => {
        x.stops = [];
      },
      (x) => {
        x.stops = Array.from({ length: 25 }, (_, i) => ({
          ...x.stops[0],
          id: `stop-${i}`,
        }));
      },
      (x) => {
        Object.assign(x.stops[0], {
          metrics: [{ id: "housing.units", value: 999 }],
        });
      },
    ];
    const scenario = createScenario("Invalid inputs"),
      original = canonicalJSON(scenario);
    for (const mutate of invalid) {
      const tour = presentation();
      mutate(tour);
      const command: Command = {
        type: "scenario.presentation",
        presentation: tour,
      };
      expect(commandSchema.safeParse(command).success).toBe(false);
      expect(() => applyCommand(scenario, command)).toThrow(/presentation/i);
    }
    expect(canonicalJSON(scenario)).toBe(original);
  });

  it("removes the optional field exactly and clones tours independently when branching", () => {
    const before = applyCommand(createScenario("Parent"), {
      type: "scenario.presentation",
      presentation: presentation(),
    });
    const child = createScenario("Child", before);
    expect(child.presentation).toEqual(before.presentation);
    child.presentation!.stops.reverse();
    child.presentation!.stops[0].camera.center[0] = 0;
    expect(before.presentation!.stops[0].id).toBe("stop-overview");
    expect(before.presentation!.stops[1].camera.center).toEqual(place.center);
    const removed = applyCommand(before, {
      type: "scenario.presentation",
      presentation: null,
    });
    expect(Object.hasOwn(removed, "presentation")).toBe(false);
    expect(removed.revision).toBe(before.revision + 1);
    expect(createScenario("No tour")).not.toHaveProperty("presentation");
  });

  it("retains legacy formats and source hashes, upgrades history/undone-only tours, and never downgrades format4", async () => {
    const identity = await baselineIdentity(place);
    for (const version of [1, 2, 3] as const) {
      const old = { ...createProject(place), schemaVersion: version },
        original = canonicalJSON(old);
      expect(projectWithPresentationVersion(old, place)).toBe(old);
      const restored = await validateProjectSnapshot({
        project: old,
        place,
        baselineIdentity: identity,
      });
      expect(canonicalJSON(restored.project)).toBe(original);
      expect(restored.baselineIdentity).toEqual(identity);
    }
    const project = authoredProject();
    expect(project.schemaVersion).toBe(4);
    expect(
      projectSchema.safeParse({ ...project, schemaVersion: 3 }).success,
    ).toBe(false);
    const restored = await validateProjectSnapshot(
      JSON.parse(
        JSON.stringify({ project, place, baselineIdentity: identity }),
      ),
    );
    expect(restored.project).toEqual(project);
    expect(restored.baselineIdentity).toEqual(identity);
    const historical = structuredClone(project);
    delete historical.scenarios[1].presentation;
    historical.undone = historical.history;
    historical.history = [];
    expect(
      projectWithPresentationVersion({ ...historical, schemaVersion: 1 }, place)
        .schemaVersion,
    ).toBe(4);
    historical.undone = [];
    expect(
      projectWithPresentationVersion(historical, place).schemaVersion,
    ).toBe(4);
    const modernPlace = {
      ...place,
      buildings: [typedBuildingPreset("townhome", place.center)],
    };
    expect(
      projectWithBuildingVersion(historical, modernPlace).schemaVersion,
    ).toBe(4);
    expect(await baselineIdentity(place)).toEqual(identity);
  });

  it("rejects baseline authoring and invalid current, historical, undone and command-only tours on import", async () => {
    const project = authoredProject();
    expect(() =>
      applyCommand(project.scenarios[0], {
        type: "scenario.presentation",
        presentation: presentation(),
      }),
    ).toThrow(/baseline/);
    expect(() =>
      applyCommand(project.scenarios[0], {
        type: "scenario.presentation",
        presentation: null,
      }),
    ).toThrow(/baseline/);
    const baseline = structuredClone(project);
    baseline.scenarios[0].presentation = presentation();
    expect(projectSchema.safeParse(baseline).success).toBe(false);
    for (const field of ["current", "history", "undone", "command"] as const) {
      const bad = structuredClone(project);
      if (field === "current")
        bad.scenarios[1].presentation!.stops[0].camera.pitch = 61;
      if (field === "history")
        bad.history[0].before.presentation = { ...presentation(), stops: [] };
      if (field === "undone") {
        bad.undone = structuredClone(bad.history);
        bad.undone[0].after.presentation!.stops[0].camera.zoom = 99;
      }
      if (
        field === "command" &&
        bad.history[0].command.type === "scenario.presentation"
      )
        bad.history[0].command.presentation!.stops[0].title = "";
      await expect(
        validateProjectSnapshot({ project: bad, place }),
      ).rejects.toThrow(/project is invalid/);
    }
  });
});

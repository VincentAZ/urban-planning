import { describe, expect, it } from "vitest";
import { validateScenarioExtent } from "./geography.js";
import { createScenario, buildingPreset } from "@urban/models";
import type { Place, Road } from "@urban/core";

const place: Place = {
  id: "concave",
  name: "Concave fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0.5, 0.5],
  bounds: [0, 0, 3, 3],
  buildings: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  roads: [],
  boundary: [
    [0, 0],
    [3, 0],
    [3, 3],
    [2, 3],
    [2, 1],
    [1, 1],
    [1, 3],
    [0, 3],
    [0, 0],
  ],
  extentLabel: "Concave test area",
};
const road = (coordinates: Road["coordinates"]): Road => ({
  id: "road",
  name: "Test",
  coordinates,
  lanes: 2,
  speedMph: 25,
  oneWay: false,
  kind: "residential",
  sourceId: "test",
});
describe("edit geography boundary", () => {
  it("enforces multipolygon islands and holes for both roads and imported buildings", () => {
    const exact = {
      ...place,
      boundary: [
        [0, 0],
        [8, 0],
        [8, 4],
        [0, 4],
        [0, 0],
      ],
      studyArea: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
              [0, 0],
            ],
            [
              [1, 1],
              [3, 1],
              [3, 3],
              [1, 3],
              [1, 1],
            ],
          ],
          [
            [
              [6, 0],
              [8, 0],
              [8, 2],
              [6, 2],
              [6, 0],
            ],
          ],
        ],
      },
    } as Place;
    const scenario = createScenario("Exact");
    scenario.roadEdits.road = road([
      [0.5, 2],
      [3.5, 2],
    ]);
    expect(() => validateScenarioExtent(scenario, exact)).toThrow("outside");
    scenario.roadEdits.road = road([
      [6.1, 1],
      [7.9, 1],
    ]);
    expect(() => validateScenarioExtent(scenario, exact)).not.toThrow();
    scenario.buildingEdits.hole = {
      ...buildingPreset("office", [2, 2]),
      id: "hole",
    };
    expect(() => validateScenarioExtent(scenario, exact)).toThrowError(
      expect.objectContaining({ code: "OUTSIDE_STUDY_AREA" }),
    );
    scenario.buildingEdits.hole = null;
    scenario.buildingEdits.island = {
      ...buildingPreset("office", [7, 1]),
      id: "island",
    };
    expect(() => validateScenarioExtent(scenario, exact)).not.toThrow();
  });
  it("rejects a road that exits a concave area even when both endpoints are inside", () => {
    const scenario = createScenario("Test");
    scenario.roadEdits.road = road([
      [0.5, 2],
      [2.5, 2],
    ]);
    expect(() => validateScenarioExtent(scenario, place)).toThrow(
      "outside the editable study area",
    );
  });
  it("allows roads along the boundary and rejects geometry clearly outside", () => {
    const scenario = createScenario("Test");
    scenario.roadEdits.road = road([
      [0, 0],
      [3, 0],
    ]);
    expect(() => validateScenarioExtent(scenario, place)).not.toThrow();
    scenario.roadEdits.road = road([
      [0, 0],
      [-1, 0],
    ]);
    expect(() => validateScenarioExtent(scenario, place)).toThrow("outside");
  });
  it("checks added building geometry and ignores deletions", () => {
    const scenario = createScenario("Test");
    scenario.buildingEdits.outside = buildingPreset("office", [6, 6]);
    expect(() => validateScenarioExtent(scenario, place)).toThrowError(
      expect.objectContaining({ code: "OUTSIDE_STUDY_AREA" }),
    );
    scenario.buildingEdits.outside = null;
    expect(() => validateScenarioExtent(scenario, place)).not.toThrow();
  });
  it("preserves unchanged captured source paths for settings-only edits but validates every reshape", () => {
    const captured = road([
      [0.5, 2],
      [2.5, 2],
    ]);
    const sourcePlace = { ...place, roads: [captured] };
    const scenario = createScenario("Captured source compatibility");
    scenario.roadEdits[captured.id] = {
      ...captured,
      speedMph: 20,
      bikeLane: true,
    };
    expect(() => validateScenarioExtent(scenario, sourcePlace)).not.toThrow();
    scenario.roadEdits[captured.id] = {
      ...captured,
      coordinates: [
        [0.6, 2],
        [2.5, 2],
      ],
    };
    expect(() => validateScenarioExtent(scenario, sourcePlace)).toThrow(
      "outside",
    );
    scenario.roadEdits[captured.id] = null;
    expect(() => validateScenarioExtent(scenario, sourcePlace)).not.toThrow();
    expect(sourcePlace.roads[0]).toEqual(captured);
  });
});

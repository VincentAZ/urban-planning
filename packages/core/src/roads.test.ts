import { describe, expect, it } from "vitest";
import { createProject, createScenario } from "@urban/models";
import {
  applyCommand,
  baselineIdentity,
  materializeRoads,
  roadPreset,
  USER_ROAD_SOURCE,
  validateProjectSnapshot,
  validateRoadEdit,
  validateRoadPath,
  type Place,
  type Position,
} from "./index";
import { commandSchema, roadSchema } from "./validation";

const ring = (x1: number, y1: number, x2: number, y2: number): Position[] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
  [x1, y1],
];
function fixture(): Place {
  const outer = ring(0, 0, 0.01, 0.01),
    hole = ring(0.004, 0.004, 0.006, 0.006);
  return {
    id: "road-geometry-fixture",
    name: "Street study",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.001, 0.001],
    bounds: [0, 0, 0.03, 0.01],
    boundary: outer,
    studyArea: {
      type: "MultiPolygon",
      coordinates: [[outer, hole], [ring(0.02, 0, 0.03, 0.01)]],
    },
    buildings: [],
    roads: [
      {
        ...roadPreset([
          [0.001, 0.001],
          [0.003, 0.001],
        ]),
        id: "existing",
        sourceId: "source-map",
        geometrySourceId: undefined,
        attributeSourceId: "source-estimates",
      },
    ],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-05T00:00:00.000Z",
    extentLabel: "Two islands with an excluded interior",
  };
}
describe("authored street geometry", () => {
  it("measures centerline length and allows simple closed loops without inventing a traffic count", () => {
    const points: Position[] = [
      [0, 0],
      [0.001, 0],
    ];
    const check = validateRoadPath(points);
    expect(check.valid).toBe(true);
    expect(check.lengthMeters).toBeCloseTo(111.19508, 3);
    expect(
      validateRoadPath(ring(0.001, 0.001, 0.003, 0.003), fixture()).valid,
    ).toBe(true);
    const road = roadPreset(points);
    expect(road).toMatchObject({
      lanes: 2,
      speedMph: 25,
      oneWay: false,
      estimated: true,
      sourceId: USER_ROAD_SOURCE.id,
      geometrySourceId: USER_ROAD_SOURCE.id,
    });
    expect(road).not.toHaveProperty("aadt");
    road.coordinates[0][0] = 0.5;
    expect(points[0][0]).toBe(0);
  });
  it("rejects invalid coordinates, duplicate points, sub-meter paths, backtracking and self-crossings", () => {
    for (const path of [
      [[0, 0]],
      [
        [0, 0],
        [NaN, 0],
      ],
      [
        [0, 0],
        [181, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0.0000001, 0],
      ],
      [
        [0, 0],
        [0.003, 0],
        [0.001, 0],
      ],
      [
        [0, 0],
        [0.003, 0.003],
        [0, 0.003],
        [0.003, 0],
      ],
      [
        [0, 0],
        [0.002, 0],
        [0.002, 0.002],
        [0.001, 0],
        [0.003, 0],
      ],
    ] as Position[][])
      expect(validateRoadPath(path).valid, JSON.stringify(path)).toBe(false);
  });
  it("checks entire segments against holes, concave edges, and disconnected islands", () => {
    const place = fixture();
    expect(
      validateRoadPath(
        [
          [0.003, 0.005],
          [0.007, 0.005],
        ],
        place,
      ),
    ).toMatchObject({ valid: false });
    expect(
      validateRoadPath(
        [
          [0.009, 0.001],
          [0.021, 0.001],
        ],
        place,
      ),
    ).toMatchObject({ valid: false });
    expect(
      validateRoadPath(
        [
          [0.003, 0.005],
          [0.003, 0.003],
          [0.007, 0.003],
          [0.007, 0.005],
        ],
        place,
      ).valid,
    ).toBe(true);
    expect(
      validateRoadPath(
        [
          [0.02, 0],
          [0.03, 0],
        ],
        place,
      ).valid,
    ).toBe(true);
    const concave: Position[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.003],
      [0.003, 0.003],
      [0.003, 0.01],
      [0, 0.01],
      [0, 0],
    ];
    expect(
      validateRoadPath(
        [
          [0.002, 0.009],
          [0.009, 0.002],
        ],
        { type: "Polygon", coordinates: [concave] },
      ).valid,
    ).toBe(false);
  });
  it("grandfathers unchanged complex source geometry, while new and reshaped paths use authoring limits", () => {
    const place = fixture();
    place.roads[0].coordinates = [
      [0.001, 0.001],
      [0.003, 0.003],
      [0.001, 0.003],
      [0.003, 0.001],
    ];
    expect(validateRoadEdit({ ...place.roads[0], lanes: 3 }, place).valid).toBe(
      true,
    );
    expect(
      validateRoadEdit(
        {
          ...place.roads[0],
          coordinates: [
            [0.0005, 0.001],
            ...place.roads[0].coordinates.slice(1),
          ],
        },
        place,
      ).valid,
    ).toBe(false);
    const detailed = Array.from(
      { length: 501 },
      (_, index): Position => [0.001 + index / 100000, 0.001],
    );
    place.roads[0].coordinates = detailed;
    expect(roadSchema.safeParse(place.roads[0]).success).toBe(true);
    expect(
      validateRoadEdit({ ...place.roads[0], speedMph: 20 }, place).valid,
    ).toBe(true);
    expect(
      validateRoadEdit({ ...place.roads[0], id: "new-road" }, place).error,
    ).toContain("500");
  });
  it("adds, reshapes, removes and restores scenario roads while preserving the captured baseline", async () => {
    const place = fixture(),
      original = structuredClone(place),
      identity = await baselineIdentity(place);
    const before = createScenario("Street option"),
      proposed = roadPreset(
        [
          [0.002, 0.002],
          [0.003, 0.002],
        ],
        "New connection",
      );
    const command = commandSchema.parse({
      type: "road.upsert",
      road: proposed,
      source: USER_ROAD_SOURCE,
    });
    const added = applyCommand(before, command);
    expect(added.sources).toEqual([USER_ROAD_SOURCE]);
    expect(materializeRoads(place, added).map((road) => road.id)).toEqual([
      "existing",
      proposed.id,
    ]);
    const reshape = {
      ...place.roads[0],
      coordinates: [
        [0.001, 0.001],
        [0.002, 0.002],
        [0.003, 0.001],
      ] as Position[],
      geometrySourceId: USER_ROAD_SOURCE.id,
    };
    const changed = applyCommand(added, {
      type: "road.upsert",
      road: reshape,
      source: USER_ROAD_SOURCE,
    });
    expect(changed.sources).toHaveLength(1);
    expect(materializeRoads(place, changed)[0].sourceId).toBe("source-map");
    expect(materializeRoads(place, changed)[0].attributeSourceId).toBe(
      "source-estimates",
    );
    expect(materializeRoads(place, changed)[0].geometrySourceId).toBe(
      USER_ROAD_SOURCE.id,
    );
    const removed = applyCommand(changed, {
      type: "road.remove",
      id: "existing",
    });
    expect(removed.revision).toBe(3);
    expect(materializeRoads(place, removed).map((road) => road.id)).toEqual([
      proposed.id,
    ]);
    expect(materializeRoads(place, changed)).toHaveLength(2); // A captured history state still restores the prior geometry.
    const restored = applyCommand(removed, { type: "scenario.restore" });
    expect(materializeRoads(place, restored)).toEqual(place.roads);
    expect(place).toEqual(original);
    expect(await baselineIdentity(place)).toEqual(identity);
  });
  it("preserves authored-road provenance in snapshots and validates hidden undo/redo history geometry", async () => {
    const place = fixture(),
      project = createProject(place),
      before = project.scenarios[1];
    const road = roadPreset([
      [0.001, 0.002],
      [0.003, 0.002],
    ]);
    const command = {
      type: "road.upsert" as const,
      road,
      source: USER_ROAD_SOURCE,
    };
    const after = applyCommand(before, command);
    project.scenarios[1] = after;
    const entry = {
      id: "road-history",
      at: after.updatedAt,
      actor: "Planner",
      label: "Draw a street",
      command,
      before,
      after,
    };
    project.history.push(entry);
    const exported = await validateProjectSnapshot({
      project: JSON.parse(JSON.stringify(project)),
      place,
    });
    expect(exported.project.history[0].command).toEqual(command);
    expect(
      exported.project.scenarios[1].roadEdits[road.id]?.geometrySourceId,
    ).toBe(USER_ROAD_SOURCE.id);
    const invalid = structuredClone(project);
    invalid.history = [];
    invalid.undone.push(structuredClone(entry));
    invalid.undone[0].after.roadEdits[road.id]!.coordinates = [
      [0.003, 0.005],
      [0.007, 0.005],
    ];
    await expect(
      validateProjectSnapshot({ project: invalid, place }),
    ).rejects.toThrow("inside the study area");
  });
});

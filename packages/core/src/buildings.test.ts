import { describe, it, expect } from "vitest";
import {
  createProject,
  createScenario,
  buildingPreset,
  typedBuildingPreset,
} from "@urban/models";
import {
  applyBuildingGeometry,
  applyCommand,
  assertBuildingProgram,
  baselineIdentity,
  buildingAnchor,
  buildingAreaSqm,
  buildingGeometry,
  buildingProgramTotals,
  buildingSpatialWarnings,
  canonicalJSON,
  projectWithBuildingVersion,
  transformBuildingGeometry,
  validateBuildingEdit,
  validateBuildingGeometry,
  validateProjectSnapshot,
  USER_BUILDING_SOURCE,
  type Building,
  type Command,
  type Place,
  type Position,
  type StudyAreaGeometry,
} from "./index";
import {
  buildingSchema,
  commandSchema,
  projectSchema,
  scenarioSchema,
} from "./validation";
const box = (x: number, y: number, w: number, h = w): Position[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];
function place(): Place {
  return {
    id: "building-fixture",
    name: "Building fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.005, 0.005],
    bounds: [0, 0, 0.02, 0.02],
    boundary: box(0, 0, 0.02),
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-05",
    extentLabel: "Synthetic building geometry",
  };
}
function courtyard(): StudyAreaGeometry {
  return {
    type: "MultiPolygon",
    coordinates: [
      [box(0.003, 0.003, 0.003), box(0.004, 0.004, 0.001)],
      [box(0.008, 0.003, 0.001)],
    ],
  };
}
describe("complete building geometry and project format", () => {
  it("retains holes and parts, derives area, anchors in land, and preserves program through geometry transforms", () => {
    const b = applyBuildingGeometry(
        typedBuildingPreset("apartments", [0.005, 0.005]),
        courtyard(),
      ),
      program = canonicalJSON(b.program),
      start = canonicalJSON(b);
    expect(b).not.toHaveProperty("footprint");
    expect(buildingAreaSqm(b)).toBeCloseTo(
      111195.0802335329 ** 2 * 0.000009,
      0,
    );
    const moved = transformBuildingGeometry(buildingGeometry(b), {
      translateMeters: [30, 50],
      rotationDegrees: 37,
      anchor: buildingAnchor(b),
    });
    const changed = applyBuildingGeometry(b, moved);
    expect(changed.units).toBe(b.units);
    expect(changed.jobs).toBe(b.jobs);
    expect(canonicalJSON(changed.program)).toBe(program);
    expect(canonicalJSON(b)).toBe(start);
    expect(moved.type).toBe("MultiPolygon");
    if (moved.type === "MultiPolygon") {
      expect(moved.coordinates).toHaveLength(2);
      expect(moved.coordinates[0]).toHaveLength(2);
    }
    expect(validateBuildingEdit(changed, place()).valid).toBe(true);
  });
  it("uses clockwise rigid transforms, reversible translation/rotation, and rejects invalid scale or geometry", () => {
    const geometry: StudyAreaGeometry = {
        type: "Polygon",
        coordinates: [box(0.005, 0.005, 0.001)],
      },
      anchor: Position = [0.005, 0.005];
    expect(canonicalJSON(transformBuildingGeometry(geometry, {}))).toBe(
      canonicalJSON(geometry),
    );
    const rotated = transformBuildingGeometry(geometry, {
      rotationDegrees: 90,
      anchor,
    });
    if (rotated.type === "Polygon") {
      expect(rotated.coordinates[0][1][0]).toBeCloseTo(0.005, 12);
      expect(rotated.coordinates[0][1][1]).toBeLessThan(0.005);
    }
    const restored = transformBuildingGeometry(rotated, {
      rotationDegrees: -90,
      anchor,
    });
    if (restored.type === "Polygon")
      restored.coordinates[0].forEach((p, i) =>
        p.forEach((n, j) =>
          expect(n).toBeCloseTo(geometry.coordinates[0][i][j], 12),
        ),
      );
    expect(() => transformBuildingGeometry(geometry, { scale: 0 })).toThrow();
    expect(
      validateBuildingGeometry({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0.01, 0.01],
            [0, 0.01],
            [0.01, 0],
            [0, 0],
          ],
        ],
      }).valid,
    ).toBe(false);
  });
  it("validates full boundary holes/parts and area mirrors, while grandfathering unchanged captured source detail", () => {
    const source = place(),
      b = typedBuildingPreset("office", source.center);
    source.studyArea = {
      type: "Polygon",
      coordinates: [source.boundary, box(0.004, 0.004, 0.002)],
    };
    expect(validateBuildingEdit(b, source).valid).toBe(false);
    expect(buildingSchema.safeParse({ ...b, areaSqm: 1 }).success).toBe(false);
    expect(
      buildingSchema.safeParse({ ...b, footprint: source.boundary }).success,
    ).toBe(false);
    const ring = Array.from(
      { length: 600 },
      (_, i): Position => [
        0.005 + Math.cos((i / 600) * Math.PI * 2) * 0.001,
        0.005 + Math.sin((i / 600) * Math.PI * 2) * 0.001,
      ],
    );
    ring.push([...ring[0]]);
    const legacy = {
      ...buildingPreset("office", source.center),
      footprint: ring,
    };
    source.studyArea = undefined;
    source.buildings = [legacy];
    expect(
      validateBuildingEdit({ ...legacy, name: "Settings only" }, source).valid,
    ).toBe(true);
    expect(() =>
      applyBuildingGeometry(legacy, { type: "Polygon", coordinates: [ring] }),
    ).toThrow(/500/);
  });
  it("upgrades only extended projects and history to format3 without changing captured baseline bytes or undo version", async () => {
    const source = place();
    source.buildings = [buildingPreset("office", source.center)];
    const old = createProject(source),
      identity = await baselineIdentity(source),
      original = canonicalJSON(source);
    expect(old.schemaVersion).toBe(1);
    expect(projectWithBuildingVersion(old, source).schemaVersion).toBe(1);
    const before = old.scenarios[1],
      building = typedBuildingPreset("townhome", source.center),
      command: Command = {
        type: "building.upsert",
        building,
        sources: [USER_BUILDING_SOURCE],
      },
      after = applyCommand(before, command);
    old.scenarios[1] = after;
    old.history.push({
      id: "building-history",
      at: new Date().toISOString(),
      actor: "Fixture",
      label: "Townhomes",
      command,
      before,
      after,
    });
    expect(projectSchema.safeParse(old).success).toBe(false);
    const upgraded = projectWithBuildingVersion(old, source);
    expect(upgraded.schemaVersion).toBe(3);
    expect(
      (
        await validateProjectSnapshot({
          project: upgraded,
          place: source,
          baselineIdentity: identity,
        })
      ).baselineIdentity,
    ).toEqual(identity);
    expect(canonicalJSON(source)).toBe(original);
    const badHistory = structuredClone(upgraded);
    const outside = applyBuildingGeometry(building, {
      type: "Polygon",
      coordinates: [box(0.03, 0.03, 0.001)],
    });
    badHistory.history[0].before.buildingEdits[outside.id] = outside;
    await expect(
      validateProjectSnapshot({
        project: badHistory,
        place: source,
        baselineIdentity: identity,
      }),
    ).rejects.toThrow(/outside the captured study area/);
    expect(
      projectWithBuildingVersion(
        {
          ...old,
          scenarios: [old.scenarios[0], before],
          history: [],
          undone: [old.history[0]],
        },
        source,
      ).schemaVersion,
    ).toBe(3);
    expect(
      projectWithBuildingVersion(
        {
          ...upgraded,
          history: [],
          undone: [],
          scenarios: [old.scenarios[0], before],
        },
        source,
      ).schemaVersion,
    ).toBe(3);
    const modern = { ...source, buildings: [building] };
    expect(createProject(modern).schemaVersion).toBe(3);
    await expect(
      validateProjectSnapshot({
        project: createProject(source),
        place: modern,
      }),
    ).rejects.toThrow(/version 3/);
  });
  it("warns rather than rejects overlapping source buildings and unresolved parcel matches", () => {
    const source = place(),
      b = typedBuildingPreset("office", source.center),
      other = { ...b, id: "other" };
    source.buildings = [b, other];
    expect(validateBuildingEdit(b, source).valid).toBe(true);
    expect(
      buildingSpatialWarnings(b, source, createScenario("Warnings")).join(" "),
    ).toMatch(/Programs are counted for each feature/);
  });
});
describe("feature dictionary and explicit program integrity", () => {
  it("rejects reserved building/road IDs and raw edit keys before parser stripping or prototype mutation", () => {
    const b = buildingPreset("office", [0.005, 0.005]),
      scenario = createScenario("Safe"),
      prior = canonicalJSON(scenario);
    const road = {
      id: "road",
      name: "Road",
      coordinates: [
        [0, 0],
        [0.001, 0.001],
      ] as Position[],
      lanes: 2,
      speedMph: 25,
      oneWay: false,
      kind: "street",
      sourceId: "fixture",
    };
    for (const id of new Set([
      ...Object.getOwnPropertyNames(Object.prototype),
      "prototype",
    ])) {
      for (const command of [
        { type: "building.upsert", building: { ...b, id } },
        { type: "road.upsert", road: { ...road, id } },
        { type: "building.remove", id },
        { type: "road.remove", id },
      ] as Command[]) {
        expect(commandSchema.safeParse(command).success, id).toBe(false);
        expect(() => applyCommand(scenario, command), id).toThrow(/reserved/);
      }
      for (const field of ["buildingEdits", "roadEdits"])
        expect(
          scenarioSchema.safeParse({
            ...scenario,
            [field]: Object.fromEntries([[id, null]]),
          }).success,
          id,
        ).toBe(false);
    }
    expect(canonicalJSON(scenario)).toBe(prior);
    expect(
      buildingSchema.safeParse({ ...b, sourceFeatureId: "__proto__" }).success,
    ).toBe(true);
  });
  it("rejects missing allocation, duplicate components, inconsistent mirrors and undefined bed denominators", () => {
    const b = typedBuildingPreset("hospital", [0.005, 0.005]);
    expect(buildingProgramTotals(b).explicit).toBe(true);
    for (const change of [
      (x: Building) => x.program!.commonAreaSqm++,
      (x: Building) => {
        x.units = x.units! + 1;
      },
      (x: Building) => {
        x.use = "office";
      },
      (x: Building) =>
        x.program!.components.push({ ...x.program!.components[0] }),
      (x: Building) => {
        delete x.program!.components[0].beds;
        x.program!.components[0].tripRate = {
          basis: "bed",
          value: 2,
          sourceId: "fixture",
        };
      },
    ]) {
      const bad = structuredClone(b);
      change(bad);
      expect(() => assertBuildingProgram(bad)).toThrow();
      expect(buildingSchema.safeParse(bad).success).toBe(false);
      expect(() =>
        applyCommand(createScenario("Invalid"), {
          type: "building.upsert",
          building: bad,
        }),
      ).toThrow();
    }
  });
});

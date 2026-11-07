import { describe, expect, it } from "vitest";
import { createProject, createScenario } from "@urban/models";
import {
  applyCommand,
  assembleParcels,
  baselineIdentity,
  canonicalJSON,
  materializeParcels,
  parcelAreaSqm,
  parcelPreset,
  pointInStudyArea,
  projectWithParcelVersion,
  splitParcel,
  USER_PARCEL_SOURCE,
  validateParcelCommand,
  validateParcelEdits,
  validateParcelGeometry,
  validateProjectSnapshot,
  type Command,
  type Parcel,
  type Place,
  type Position,
  type StudyAreaGeometry,
} from "./index";
import {
  commandSchema,
  parcelSchema,
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
const geometry = (
  x: number,
  y: number,
  w: number,
  h = w,
): StudyAreaGeometry => ({ type: "Polygon", coordinates: [box(x, y, w, h)] });
function fixture(): Place {
  return {
    id: "parcel-fixture",
    name: "Parcel fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.002, 0.002],
    bounds: [0, 0, 0.03, 0.02],
    boundary: box(0, 0, 0.03, 0.02),
    studyArea: {
      type: "MultiPolygon",
      coordinates: [
        [box(0, 0, 0.01, 0.01), box(0.004, 0.004, 0.002)],
        [box(0.02, 0, 0.01, 0.01)],
      ],
    },
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-05",
    extentLabel: "Synthetic exact study area",
  };
}
const replace = (
  old: Parcel[],
  next: Parcel[],
  operation: "split" | "assemble",
): Command => ({
  type: "parcels.replace",
  operation,
  removeIds: old.map((p) => p.id),
  parcels: next,
  source: USER_PARCEL_SOURCE,
});
describe("parcel geometry, partitions, and versioned history", () => {
  it("rejects reserved parcel keys through schemas and direct helpers without changing state, while retaining raw source references", () => {
    const place = fixture(),
      scenario = createScenario("Reserved keys"),
      parcel = parcelPreset(geometry(0.001, 0.001, 0.002)),
      original = canonicalJSON(scenario);
    for (const id of new Set([
      ...Object.getOwnPropertyNames(Object.prototype),
      "prototype",
    ])) {
      const unsafe = { ...parcel, id };
      const command: Command = { type: "parcel.upsert", parcel: unsafe };
      expect(commandSchema.safeParse(command).success, id).toBe(false);
      expect(
        commandSchema.safeParse({ type: "parcel.remove", id }).success,
        id,
      ).toBe(false);
      expect(
        commandSchema.safeParse({
          type: "parcels.replace",
          operation: "assemble",
          removeIds: [id, parcel.id],
          parcels: [parcel],
          source: USER_PARCEL_SOURCE,
        }).success,
        id,
      ).toBe(false);
      expect(() => validateParcelCommand(place, scenario, command), id).toThrow(
        /reserved/,
      );
      expect(() => applyCommand(scenario, command), id).toThrow(/reserved/);
      const edited = {
        ...scenario,
        parcelEdits: Object.fromEntries([[id, null]]),
      };
      expect(scenarioSchema.safeParse(edited).success, id).toBe(false);
      expect(() => validateParcelEdits(place, edited), id).toThrow(/reserved/);
      expect(canonicalJSON(scenario)).toBe(original);
    }
    const safe = { ...parcel, sourceFeatureId: "__proto__" };
    expect(parcelSchema.safeParse(safe).success).toBe(true);
    const applied = applyCommand(scenario, {
      type: "parcel.upsert",
      parcel: safe,
      source: USER_PARCEL_SOURCE,
    });
    expect(Object.getPrototypeOf(applied.parcelEdits)).toBe(Object.prototype);
    expect(applied.parcelEdits![parcel.id]!.sourceFeatureId).toBe("__proto__");
  });

  it("retains holes and multipart geometry, derives area, and never labels proposals as a survey", () => {
    const p = parcelPreset({
      type: "MultiPolygon",
      coordinates: [
        [box(0, 0, 0.01), box(0.004, 0.004, 0.002)],
        [box(0.02, 0, 0.005)],
      ],
    });
    expect(validateParcelGeometry(p.geometry).valid).toBe(true);
    expect(parcelAreaSqm(p)).toBe(parcelAreaSqm(p.geometry));
    expect(parcelAreaSqm(p)).toBeCloseTo(
      parcelAreaSqm(geometry(0, 0, 0.01)) -
        parcelAreaSqm(geometry(0.004, 0.004, 0.002)) +
        parcelAreaSqm(geometry(0.02, 0, 0.005)),
      5,
    );
    expect(p).toMatchObject({
      sourceId: USER_PARCEL_SOURCE.id,
      geometrySourceId: USER_PARCEL_SOURCE.id,
      lineage: { operation: "draw", parentIds: [] },
    });
    expect(p).not.toHaveProperty("areaSqm");
    expect(USER_PARCEL_SOURCE.description).toContain("not a cadastral survey");
  });
  it("rejects self-crossing, invalid holes, duplicates, slivers, oversize rings, and full-area escapes", () => {
    const invalid: StudyAreaGeometry[] = [
      {
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
      },
      {
        type: "Polygon",
        coordinates: [box(0, 0, 0.01), box(0.02, 0.02, 0.001)],
      },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0.01, 0],
            [0.01, 0],
            [0, 0.01],
            [0, 0],
          ],
        ],
      },
      geometry(0, 0, 0.0000001),
      {
        type: "Polygon",
        coordinates: [
          [
            ...Array.from(
              { length: 501 },
              (_, i): Position => [
                0.002 + Math.cos((i / 501) * Math.PI * 2) * 0.001,
                0.002 + Math.sin((i / 501) * Math.PI * 2) * 0.001,
              ],
            ),
            [0.003, 0.002],
          ],
        ],
      },
    ];
    for (const g of invalid)
      expect(validateParcelGeometry(g).valid).toBe(false);
    expect(
      validateParcelGeometry(geometry(0.003, 0.003, 0.004), fixture()).valid,
    ).toBe(false); // encloses excluded hole
    expect(
      validateParcelGeometry(geometry(0.008, 0.001, 0.014, 0.001), fixture())
        .valid,
    ).toBe(false); // bridges islands
    expect(
      validateParcelGeometry(geometry(0.001, 0.001, 0.002), fixture()).valid,
    ).toBe(true);
  });
  it("splits with complementary halfplanes, retains holes, and rejects tangencies or vanishing pieces", () => {
    const original = parcelPreset({
      type: "Polygon",
      coordinates: [box(0, 0, 0.01), box(0.004, 0.004, 0.002)],
    });
    const before = canonicalJSON(original),
      output = splitParcel(original, [
        [0.005, -0.01],
        [0.005, 0.02],
      ]);
    expect(output).toHaveLength(2);
    expect(
      output.every(
        (p) =>
          p.lineage?.operation === "split" &&
          p.lineage.parentIds[0] === original.id,
      ),
    ).toBe(true);
    expect(
      output.some((p) => pointInStudyArea([0.005, 0.005], p.geometry)),
    ).toBe(false);
    expect(output.reduce((sum, p) => sum + parcelAreaSqm(p), 0)).toBeCloseTo(
      parcelAreaSqm(original),
      4,
    );
    expect(canonicalJSON(original)).toBe(before);
    expect(() =>
      splitParcel(original, [
        [0, -0.01],
        [0, 0.02],
      ]),
    ).toThrow(/interior/);
    expect(() =>
      splitParcel(original, [
        [0.00000000001, -0.01],
        [0.00000000001, 0.02],
      ]),
    ).toThrow(/1 m²|slivers/);
    const slanted = parcelPreset({
      type: "Polygon",
      coordinates: [
        [
          [-112.07, 33.45],
          [-112.068, 33.4504],
          [-112.068, 33.452],
          [-112.07, 33.452],
          [-112.07, 33.45],
        ],
      ],
    });
    expect(
      splitParcel(slanted, [
        [-112.069, 33.449],
        [-112.069, 33.453],
      ]),
    ).toHaveLength(2); // added collinear vertices cause tiny spherical area differences
  });
  it("assembles same-kind lots without filling holes or disconnected gaps", () => {
    const a = parcelPreset(geometry(0, 0, 0.002)),
      b = parcelPreset(geometry(0.002, 0, 0.002)),
      c = parcelPreset(geometry(0.01, 0, 0.002));
    expect(assembleParcels([a, b]).geometry.type).toBe("Polygon");
    const combined = assembleParcels([a, c]);
    expect(combined.geometry.type).toBe("MultiPolygon");
    expect(pointInStudyArea([0.005, 0.001], combined.geometry)).toBe(false);
    expect(() => assembleParcels([a, { ...b, kind: "block" }])).toThrow(
      /parcels with parcels/,
    );
    expect(() =>
      assembleParcels([a, parcelPreset(geometry(0.001, 0, 0.002))]),
    ).toThrow(/overlaps/);
    expect(() =>
      splitParcel(combined, [
        [0.006, -0.01],
        [0.006, 0.02],
      ]),
    ).toThrow(/between islands/);
  });
  it("preserves a map-drawn tilted boundary through split, command validation, and reassembly", async () => {
    // Regression from the browser's rotated map and dragged second vertex.
    // Clipping inserts points on sloped lon/lat edges. Spherical area reports
    // nonzero area for its almost-collinear floating-point residual triangles.
    const ring: Position[] = [
      [-112.072556, 33.454759],
      [-112.070183, 33.455652],
      [-112.069446, 33.453992],
      [-112.071543, 33.453101],
      [-112.072556, 33.454759],
    ];
    const original = parcelPreset({ type: "Polygon", coordinates: [ring] });
    const place: Place = {
      ...fixture(),
      center: [-112.071, 33.454],
      bounds: [-112.072556, 33.453101, -112.069446, 33.455652],
      boundary: ring,
      studyArea: original.geometry,
      parcels: [original],
    };
    const originalJSON = canonicalJSON(place),
      originalIdentity = await baselineIdentity(place),
      scenario = createScenario("Tilted boundary"),
      cut: [Position, Position] = [
        [-112.07100101958153, 33.45300051501073],
        [-112.07100101958153, 33.45575213131629],
      ],
      children = splitParcel(original, cut);
    expect(children).toHaveLength(2);
    for (const child of children)
      expect(validateParcelGeometry(child.geometry, place).valid).toBe(true);
    const command = replace([original], children, "split");
    validateParcelCommand(place, scenario, command);
    const divided = applyCommand(scenario, command),
      assembled = assembleParcels(children),
      merge = replace(children, [assembled], "assemble");
    validateParcelCommand(place, divided, merge);
    expect(materializeParcels(place, applyCommand(divided, merge))).toEqual([
      assembled,
    ]);
    expect(canonicalJSON(place)).toBe(originalJSON);
    expect(await baselineIdentity(place)).toEqual(originalIdentity);

    // This is a real 0.02 m²-scale strip, far above clipping roundoff but
    // small enough that widening a percentage-area allowance would miss it.
    const shiftCutEdge = (parcel: Parcel, dx: number): Parcel => {
      const changed = structuredClone(parcel);
      if (changed.geometry.type !== "Polygon") throw new Error("Expected lot");
      for (const point of changed.geometry.coordinates[0])
        if (Math.abs(point[0] - cut[0][0]) < 1e-12) point[0] += dx;
      return changed;
    };
    const gap = [shiftCutEdge(children[0], -1e-9), children[1]],
      overlap = [children[0], shiftCutEdge(children[1], -1e-9)];
    expect(() =>
      validateParcelCommand(place, scenario, replace([original], gap, "split")),
    ).toThrow(/preserve all original land/);
    expect(() =>
      validateParcelCommand(
        place,
        scenario,
        replace([original], overlap, "split"),
      ),
    ).toThrow(/overlaps/);
  });
  it("atomically validates replacement conservation, unique lineage and same-kind nonoverlap while allowing blocks over lots", () => {
    const place = fixture(),
      scenario = createScenario("Lots"),
      a = parcelPreset(geometry(0.001, 0.001, 0.002)),
      b = parcelPreset(geometry(0.003, 0.001, 0.0005));
    let next = applyCommand(scenario, {
      type: "parcels.import",
      parcels: [a, b],
      source: USER_PARCEL_SOURCE,
    });
    validateParcelEdits(place, next);
    expect(() =>
      validateParcelCommand(place, next, {
        type: "parcel.upsert",
        parcel: parcelPreset(geometry(0.0015, 0.001, 0.001)),
      }),
    ).toThrow(/overlaps/);
    validateParcelCommand(place, next, {
      type: "parcel.upsert",
      parcel: parcelPreset(geometry(0.001, 0.001, 0.002), "Block", "block"),
    });
    const children = splitParcel(a, [
        [0.002, 0],
        [0.002, 0.01],
      ]),
      command = replace([a], children, "split");
    validateParcelCommand(place, next, command);
    const wrong = structuredClone(command) as Extract<
      Command,
      { type: "parcels.replace" }
    >;
    wrong.parcels[0].geometry = geometry(0.001, 0.001, 0.0005);
    expect(() => validateParcelCommand(place, next, wrong)).toThrow(/preserve/);
    const missing = structuredClone(command) as Extract<
      Command,
      { type: "parcels.replace" }
    >;
    missing.parcels[0].lineage!.parentIds = [];
    expect(() => validateParcelCommand(place, next, missing)).toThrow(
      /provenance/,
    );
    next = applyCommand(next, command);
    expect(materializeParcels(place, next).map((p) => p.id)).not.toContain(
      a.id,
    );
    const merged = assembleParcels(children);
    validateParcelCommand(place, next, replace(children, [merged], "assemble"));
    expect(() =>
      validateParcelCommand(place, next, {
        type: "parcel.remove",
        id: "missing",
      }),
    ).toThrow(/no longer exists/);
  });
  it("preserves legacy hashes and optional absence, upgrades parcel history to v2, and validates historical geometry", async () => {
    const place = fixture(),
      identity = await baselineIdentity(place),
      project = createProject(place);
    expect(project.schemaVersion).toBe(1);
    const restored = await validateProjectSnapshot({
      project,
      place,
      baselineIdentity: identity,
    });
    expect(await baselineIdentity(restored.place)).toEqual(identity);
    expect(restored.place).not.toHaveProperty("parcels");
    expect(restored.project.scenarios[0]).not.toHaveProperty("parcelEdits");
    const before = project.scenarios[1],
      parcel = parcelPreset(geometry(0.001, 0.001, 0.002)),
      command: Command = {
        type: "parcel.upsert",
        parcel,
        source: USER_PARCEL_SOURCE,
      },
      after = applyCommand(before, command);
    project.scenarios[1] = after;
    project.history.push({
      id: "parcel-history",
      at: new Date().toISOString(),
      actor: "Fixture",
      label: "Draw lot",
      command,
      before,
      after,
    });
    expect(projectSchema.safeParse(project).success).toBe(false);
    const upgraded = projectWithParcelVersion(project, place);
    expect(upgraded.schemaVersion).toBe(2);
    expect(
      (
        await validateProjectSnapshot({
          project: upgraded,
          place,
          baselineIdentity: identity,
        })
      ).baselineIdentity,
    ).toEqual(identity);
    const bad = structuredClone(upgraded);
    bad.history[0].before.parcelEdits = {
      bad: { ...parcel, id: "bad", geometry: geometry(0.003, 0.003, 0.004) },
    };
    await expect(
      validateProjectSnapshot({ project: bad, place }),
    ).rejects.toThrow(/inside the study area/);
    const branch = createScenario("Branch", after);
    branch.parcelEdits![parcel.id]!.name = "Branch lot";
    expect(after.parcelEdits![parcel.id]!.name).not.toBe("Branch lot");
    expect(
      applyCommand(after, { type: "scenario.restore" }).parcelEdits,
    ).toEqual({});
    expect(
      projectWithParcelVersion({
        ...upgraded,
        scenarios: [project.scenarios[0], before],
        history: [],
        undone: [],
      }).schemaVersion,
    ).toBe(2);
    expect(createProject({ ...place, parcels: [] }).schemaVersion).toBe(2);
    await expect(
      validateProjectSnapshot({
        project: createProject(place),
        place: { ...place, parcels: [] },
      }),
    ).rejects.toThrow(/schema version 2/);
  });
});

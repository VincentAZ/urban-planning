import { z } from "zod";
import { describe, it, expect } from "vitest";
import { buildingPreset, createProject, createScenario } from "@urban/models";
import {
  applyCommand,
  baselineIdentity,
  BUILDING_QUANTITY_FIELDS,
  canonicalJSON,
  projectWithImportVersion,
  validateBuildingCommand,
  validateParcelCommand,
  validateProjectSnapshot,
  parcelPreset,
  type Building,
  type Place,
  type Source,
  type SourceImportMetadata,
  type SourceRights,
} from "./index";
import {
  buildingSchema,
  commandSchema,
  projectSchema,
  sourceSchema,
} from "./validation";
const stamp = "2026-11-06T00:00:00Z";
function fixture() {
  const b = buildingPreset("office", [0.005, 0.005]);
  const p: Place = {
    id: "nullable-fixture",
    name: "Fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.005, 0.005],
    bounds: [0, 0, 0.02, 0.02],
    boundary: [
      [0, 0],
      [0.02, 0],
      [0.02, 0.02],
      [0, 0.02],
      [0, 0],
    ],
    buildings: [b],
    roads: [],
    sources: [],
    coverage: [],
    extentLabel: "Synthetic fixture",
    loadedAt: stamp,
  };
  return { p, b };
}
function unknown(b: Building): Building {
  return {
    ...b,
    height: null,
    floors: null,
    units: null,
    jobs: null,
    parkingSpaces: null,
    attributeProvenance: {
      version: 1,
      fields: Object.fromEntries(
        BUILDING_QUANTITY_FIELDS.map((k) => [
          k,
          {
            status: "missing",
            sourceId: "upload",
            sourceField: k,
            rawValue: null,
          },
        ]),
      ),
    },
  };
}
const rights: SourceRights = {
  version: 1,
  privateUse: true,
  cache: true,
  analyze: true,
  privateDisplay: true,
  export: true,
  historicalRetention: true,
  publicRedistribution: false,
  declaredBy: "fixture-user",
  declaredAt: stamp,
};
const metadata: SourceImportMetadata = {
  version: 1,
  format: "shapefile",
  upload: {
    name: "building.zip",
    sha256: "a".repeat(64),
    bytes: 100,
    members: [{ name: "building.shp", sha256: "b".repeat(64), bytes: 60 }],
  },
  selection: { layer: "building" },
  crs: {
    source: "EPSG:26912",
    axisOrder: "xy",
    coordinateUnit: "metre",
    target: "OGC:CRS84",
  },
  operation: {
    name: "Reviewed coordinate transformation",
    accuracyMeters: null,
  },
  converter: { name: "GDAL", version: "3.test" },
  normalizedSha256: "c".repeat(64),
  recipe: {
    mapping: { units: { field: "HOMES", unit: "count" } },
    excluded: ["unsupported layer"],
  },
  exclusions: [{ count: 1, reason: "Explicitly excluded non-polygon layer" }],
};
const source: Source = {
  id: "upload",
  name: "Uploaded fixture",
  url: "",
  license: "User-authorized private data",
  vintage: "2026",
  description: "Synthetic import fixture",
  kind: "user-supplied",
  import: metadata,
  rights,
};
describe("format8 quantities and source manifest", () => {
  it("distinguishes missing, zero and supplied attributes without backfilling legacy bytes", () => {
    const { b } = fixture();
    expect(buildingSchema.parse(b)).not.toHaveProperty("attributeProvenance");
    const u = unknown(b);
    expect(buildingSchema.safeParse(u).success).toBe(true);
    expect(buildingSchema.safeParse({ ...b, units: null }).success).toBe(false);
    expect(buildingSchema.safeParse({ ...u, units: 0 }).success).toBe(false);
    const zero = {
      ...u,
      units: 0,
      attributeProvenance: {
        ...u.attributeProvenance!,
        fields: {
          ...u.attributeProvenance!.fields,
          units: { status: "supplied", sourceId: "upload", rawValue: 0 },
        },
      },
    };
    expect(buildingSchema.safeParse(zero).success).toBe(true);
    expect(
      buildingSchema.safeParse({
        ...zero,
        attributeProvenance: {
          ...zero.attributeProvenance,
          use: { status: "missing", sourceId: "upload" },
        },
      }).success,
    ).toBe(false);
  });
  it("requires complete private rights for imports and bounds manifests without private paths", () => {
    expect(sourceSchema.safeParse(source).success).toBe(true);
    expect(() => z.toJSONSchema(projectSchema, { io: "input" })).not.toThrow();
    expect(
      sourceSchema.safeParse({ ...source, rights: undefined }).success,
    ).toBe(false);
    for (const field of [
      "privateUse",
      "cache",
      "analyze",
      "privateDisplay",
      "export",
      "historicalRetention",
    ])
      expect(
        sourceSchema.safeParse({
          ...source,
          rights: { ...rights, [field]: false },
        }).success,
      ).toBe(false);
    expect(
      sourceSchema.safeParse({
        ...source,
        import: {
          ...metadata,
          upload: { ...metadata.upload, name: "/private/secret.zip" },
        },
      }).success,
    ).toBe(false);
    expect(
      sourceSchema.safeParse({
        ...source,
        import: { ...metadata, normalizedSha256: "not-a-hash" },
      }).success,
    ).toBe(false);
    expect(
      sourceSchema.safeParse({
        ...source,
        import: { ...metadata, recipe: { nested: "x".repeat(4001) } },
      }).success,
    ).toBe(false);
    expect(sourceSchema.parse(source).rights?.publicRedistribution).toBe(false);
  });
  it("upgrades current, baseline, historical, undone and command evidence monotonically", async () => {
    const { p, b } = fixture(),
      original = canonicalJSON(p),
      hash = await baselineIdentity(p);
    const project = createProject(p),
      s = project.scenarios[1],
      cmd = {
        type: "building.upsert" as const,
        building: unknown(b),
        sources: [source],
      },
      after = applyCommand(s, cmd);
    const entry = {
      id: "history-fixture",
      at: stamp,
      actor: "fixture",
      label: "Import",
      command: cmd,
      before: s,
      after,
    };
    const changed = {
      ...project,
      scenarios: project.scenarios.map((x) => (x.id === s.id ? after : x)),
      history: [entry],
    };
    const upgraded = projectWithImportVersion(changed, p);
    expect(upgraded.schemaVersion).toBe(8);
    expect(
      projectSchema.safeParse({ ...upgraded, schemaVersion: 7 }).success,
    ).toBe(false);
    expect(
      projectWithImportVersion({ ...project, undone: [entry] }, p)
        .schemaVersion,
    ).toBe(8);
    expect(
      projectWithImportVersion(
        { ...project, history: [{ ...entry, before: s, after: s }] },
        p,
      ).schemaVersion,
    ).toBe(8);
    expect(
      projectWithImportVersion({ ...project, schemaVersion: 8 }, p)
        .schemaVersion,
    ).toBe(8);
    expect(
      createProject({ ...p, buildings: [unknown(b)], sources: [source] })
        .schemaVersion,
    ).toBe(8);
    expect(canonicalJSON(p)).toBe(original);
    expect(await baselineIdentity(p)).toEqual(hash);
    expect(projectWithImportVersion(project, p)).toEqual(project);
    expect(
      await validateProjectSnapshot({ project: upgraded, place: p }),
    ).toBeTruthy();
  });
  it("keeps explicit programs numeric even when massing is unknown", () => {
    const { b } = fixture(),
      u = unknown(b);
    expect(
      buildingSchema.safeParse({
        ...u,
        program: {
          version: 1,
          grossFloorAreaSqm: 100,
          commonAreaSqm: 0,
          components: [
            {
              id: "office",
              use: "office",
              grossFloorAreaSqm: 100,
              units: 0,
              jobs: 10,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it("validates explicit append/match imports while preserving omitted legacy building upserts", () => {
    const { p, b } = fixture(),
      s = createScenario("Option");
    const cmd = { type: "buildings.import" as const, buildings: [b], source };
    expect(() => validateBuildingCommand(p, s, cmd)).not.toThrow();
    expect(() =>
      validateBuildingCommand(p, s, { ...cmd, mode: "append" }),
    ).toThrow(/new identifiers/);
    expect(() =>
      validateBuildingCommand(p, s, { ...cmd, mode: "match" }),
    ).not.toThrow();
    expect(() =>
      validateBuildingCommand(p, s, {
        ...cmd,
        mode: "match",
        buildings: [{ ...b, id: "absent" }],
      }),
    ).toThrow(/already exist/);
    expect(commandSchema.parse({ ...cmd, mode: "match" })).toHaveProperty(
      "mode",
      "match",
    );
    const parcel = parcelPreset({
      type: "Polygon",
      coordinates: [
        [
          [0.001, 0.001],
          [0.002, 0.001],
          [0.002, 0.002],
          [0.001, 0.002],
          [0.001, 0.001],
        ],
      ],
    });
    const pp = { ...p, parcels: [parcel] };
    const pc = { type: "parcels.import" as const, parcels: [parcel], source };
    expect(() =>
      validateParcelCommand(pp, s, { ...pc, mode: "match" }),
    ).not.toThrow();
    expect(() => validateParcelCommand(pp, s, pc)).toThrow(/new identifiers/);
    expect(() =>
      validateParcelCommand(pp, s, {
        ...pc,
        mode: "match",
        parcels: [{ ...parcel, kind: "block" }],
      }),
    ).toThrow(/same parcel\/block kind/);
  });
  it("retains up to 5000 selected entity IDs in wrapped recipes within the manifest byte limit", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `entity-${i}`);
    expect(
      sourceSchema.safeParse({
        ...source,
        import: {
          ...metadata,
          selection: { layer: "entities", entityIds: ids },
          recipe: {
            conversion: { dxf: { entityIds: ids } },
            mapping: {},
            normalization: {
              controlTransformResult: {
                pairs: [{ source: [0, 0], target: [-112, 33] }],
              },
            },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      sourceSchema.safeParse({
        ...source,
        import: {
          ...metadata,
          recipe: {
            values: Array.from({ length: 5000 }, () => "x".repeat(100)),
          },
        },
      }).success,
    ).toBe(false);
  });
});

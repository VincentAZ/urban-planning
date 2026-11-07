import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { difference, feature, featureCollection } from "@turf/turf";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  classifyFloodZone,
  floodDatasetHash,
  floodDatasetHashSync,
  floodDatasetSchema,
  floodGeometrySchema,
  floodReferenceSchema,
  floodHasArealComponent,
  floodResidualWithinCoordinateCells,
  floodStudyAreaHash,
  floodMethodVersion,
  FLOOD_METHOD_VERSION,
  FLOOD_LEGACY_METHOD_VERSION,
  projectWithFloodDataset,
  projectWithFloodVersion,
  projectWithImportedFlood,
  validateFloodCatalogTransition,
  validateFloodDataset,
  validateProjectFlood,
  validateProjectSnapshot,
  type HistoryEntry,
  type Position,
  type StudyAreaGeometry,
} from "./index";
import { commandSchema, projectSchema } from "./validation";
import { createProject, createScenario } from "@urban/models";
import { floodFixture, floodRectangle } from "../../../tests/fixtures/flood";
describe("content-addressed flood references and immutable project catalog", () => {
  it("preserves absent legacy method bytes and changes calculation method only through an explicit reversible reference", async () => {
    const f = await floodFixture(),
      before = f.scenario;
    const original = canonicalJSON(before),
      sourceHash = await floodDatasetHash(f.dataset);
    expect(floodMethodVersion(before.flood)).toBe(FLOOD_LEGACY_METHOD_VERSION);
    expect(floodReferenceSchema.parse(before.flood)).not.toHaveProperty(
      "methodVersion",
    );
    const command = commandSchema.parse({
      type: "scenario.flood",
      flood: { ...before.flood, methodVersion: FLOOD_METHOD_VERSION },
    });
    const after = applyCommand(before, command);
    expect(after.flood).toEqual({
      ...before.flood,
      methodVersion: FLOOD_METHOD_VERSION,
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(canonicalJSON(before)).toBe(original);
    expect(await floodDatasetHash(f.dataset)).toBe(sourceHash);
    const entry: HistoryEntry = {
      id: "method-upgrade",
      at: after.updatedAt,
      actor: "fixture",
      label: "Use method 1.1",
      command,
      before,
      after,
    };
    const p = {
      ...f.project,
      scenarios: [f.project.scenarios[0], after],
      history: [entry],
      undone: [entry],
    };
    await validateProjectFlood(p, f.place);
    const parsed = projectSchema.parse(p),
      restored = projectWithImportedFlood(parsed);
    expect(restored.history[0].before.flood).not.toHaveProperty(
      "methodVersion",
    );
    expect(restored.history[0].after.flood?.methodVersion).toBe(
      FLOOD_METHOD_VERSION,
    );
    expect(restored.undone[0].command).toMatchObject({
      flood: { methodVersion: FLOOD_METHOD_VERSION },
    });
    expect(createScenario("Copy", after).flood).toEqual(after.flood);
    for (const methodVersion of [null, 1.1, "flood-footprint-9.0.0"])
      expect(
        floodReferenceSchema.safeParse({ ...before.flood, methodVersion })
          .success,
      ).toBe(false);
    expect(
      floodReferenceSchema.safeParse({
        ...before.flood,
        methodVersion: FLOOD_LEGACY_METHOD_VERSION,
      }).success,
    ).toBe(true);
  });
  it("keeps request parsing structural while explicit validation rejects crossing source polygons", async () => {
    const f = await floodFixture();
    const crossing: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-112.079, 33.441],
          [-112.077, 33.443],
          [-112.079, 33.443],
          [-112.077, 33.441],
          [-112.079, 33.441],
        ],
      ],
    };
    expect(floodGeometrySchema.safeParse(crossing).success).toBe(true);
    for (const field of [
      "zones",
      "availability",
      "panels",
      "revisions",
      "seclusions",
    ] as const) {
      const dataset = structuredClone(f.dataset);
      if (field === "zones")
        dataset.zones = [{ ...dataset.zones[0], geometry: crossing }];
      else
        dataset[field] = [
          {
            id: "crossing-feature",
            geometry: crossing,
            attributes: dataset.zones[0].attributes,
          },
        ];
      expect(floodDatasetSchema.safeParse(dataset).success).toBe(true);
      expect(() => validateFloodDataset(dataset, f.place)).toThrow("topology");
    }
    const study = {
      ...f.dataset,
      studyArea: crossing,
      studyAreaHash: await floodStudyAreaHash(crossing),
    };
    expect(() => validateFloodDataset(study)).toThrow(
      "study-area polygon topology",
    );
    const open = structuredClone(crossing);
    open.coordinates[0].pop();
    expect(floodGeometrySchema.safeParse(open).success).toBe(false);
    const tooMany = floodRectangle(-112.08, 33.44, -112.07, 33.45);
    if (tooMany.type !== "Polygon")
      throw new Error("Fixture must be a polygon");
    tooMany.coordinates[0] = Array.from(
      { length: 50_001 },
      (_, i) => tooMany.coordinates[0][i % 4],
    );
    expect(floodGeometrySchema.safeParse(tooMany).success).toBe(false);
  });
  it("certifies Chicago clip residues only within adjacent binary64 cells on one exact source segment", () => {
    const a: Position = [-87.61272599972511, 41.88438000030153],
      b: Position = [-87.61272499990021, 41.88514099983226];
    const boundary: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [[a, b, [-87.62, b[1]], [-87.62, a[1]], a]],
    };
    const residual: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-87.61272574206133, 41.8845761166617],
          [-87.61272545348103, 41.884795764587885],
          [-87.61272545348103, 41.88479576458784],
          [-87.61272574206133, 41.8845761166617],
        ],
      ],
    };
    expect(floodHasArealComponent(residual)).toBe(true);
    expect(floodResidualWithinCoordinateCells(residual, boundary)).toBe(true);
    const breach = structuredClone(residual);
    breach.coordinates[0][1][0] += 1e-10;
    expect(floodResidualWithinCoordinateCells(breach, boundary)).toBe(false);
    const beyond = structuredClone(residual);
    beyond.coordinates[0][1][1] = b[1] + 1e-10;
    expect(floodResidualWithinCoordinateCells(beyond, boundary)).toBe(false);
    // Vertices individually on different original edges cannot certify an areal shortcut.
    expect(
      floodResidualWithinCoordinateCells(
        { type: "Polygon", coordinates: [[a, b, [-87.62, b[1]], a]] },
        boundary,
      ),
    ).toBe(false);
    expect(
      floodResidualWithinCoordinateCells(residual, {
        type: "Polygon",
        coordinates: [boundary.coordinates[0].slice().reverse()],
      }),
    ).toBe(true);
    // The numerical certificate is intentionally NOT used to fill model coverage gaps.
    expect(floodHasArealComponent(residual)).toBe(true);
  });
  it("accepts only exactly collapsed real-source residuals, without an area tolerance for a genuine tiny breach", async () => {
    // Reduced from actual85004 NFHL feature28313502 against the retained TIGER boundary.
    const a: Position = [-112.06489400016008, 33.421290000350915],
      b: Position = [-112.06490800040379, 33.42173499986128],
      p: Position = [-112.06490311540449, 33.42157972954317],
      q: Position = [-112.06490291982412, 33.421573512996325];
    const study: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [[a, b, [-112.066, b[1]], [-112.066, a[1]], a]],
    };
    const clipped: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [[q, p, [-112.0655, p[1]], [-112.0655, q[1]], q]],
    };
    const residual = difference(
      featureCollection([feature(clipped), feature(study)]),
    );
    expect(residual).not.toBeNull();
    expect(floodHasArealComponent(residual!.geometry)).toBe(false);
    const f = await floodFixture();
    f.dataset.studyArea = study;
    f.dataset.studyAreaHash = await floodStudyAreaHash(study);
    f.dataset.zones = [{ ...f.dataset.zones[0], geometry: clipped }];
    f.dataset.availability = [];
    f.dataset.panels = [];
    expect(() => validateFloodDataset(f.dataset)).not.toThrow();
    const breached = structuredClone(clipped);
    breached.coordinates[0][1][0] += 1e-10;
    const positive = difference(
      featureCollection([feature(breached), feature(study)]),
    );
    expect(floodHasArealComponent(positive!.geometry)).toBe(true);
    f.dataset.zones[0].geometry = breached;
    expect(() => validateFloodDataset(f.dataset)).toThrow("outside");
  });
  it("keeps legacy bytes/identity and changes format only for the new catalog/reference", async () => {
    const f = await floodFixture(),
      legacy = createProject(f.place),
      before = canonicalJSON(legacy),
      baseline = await baselineIdentity(f.place);
    expect(projectWithFloodVersion(legacy)).toBe(legacy);
    expect(canonicalJSON(legacy)).toBe(before);
    expect(f.project.schemaVersion).toBe(11);
    expect(await baselineIdentity(f.place)).toEqual(baseline);
    expect(await floodDatasetHash(f.dataset)).toBe(
      createHash("sha256").update(canonicalJSON(f.dataset)).digest("hex"),
    );
    expect(floodDatasetHashSync(f.dataset)).toBe(f.datasetHash);
    await expect(
      validateProjectSnapshot({
        place: f.place,
        project: f.project,
        baselineIdentity: baseline,
      }),
    ).resolves.toBeDefined();
  });
  it("keeps full geometry once while attach/remove/clone and restored history preserve exact evidence", async () => {
    const f = await floodFixture(),
      before = createScenario("Before"),
      after = applyCommand(before, {
        type: "scenario.flood",
        flood: f.scenario.flood!,
      });
    const entry: HistoryEntry = {
      id: "flood-entry",
      at: after.updatedAt,
      actor: "fixture",
      label: "Select flood map",
      command: { type: "scenario.flood", flood: after.flood! },
      before,
      after,
    };
    const project = {
      ...f.project,
      scenarios: [
        f.project.scenarios[0],
        applyCommand(after, { type: "scenario.flood", flood: null }),
      ],
      history: [entry],
      undone: [{ ...entry, id: "undone" }],
    };
    project.history[0].after.flood!.origin = "server-catalog";
    project.history[0].command = {
      type: "scenario.flood",
      flood: { ...after.flood!, origin: "server-catalog" },
    };
    await validateProjectFlood(project, f.place);
    const restored = projectWithImportedFlood(project);
    expect(restored.history[0].after.flood?.origin).toBe("imported");
    expect(restored.history[0].command).toMatchObject({
      flood: { origin: "imported" },
    });
    expect(project.history[0].after.flood?.origin).toBe("server-catalog");
    expect(restored.floodDatasets).toEqual(project.floodDatasets);
    expect(canonicalJSON(restored.history)).not.toContain('"coordinates"');
    expect(createScenario("Clone", after).flood).toEqual(after.flood);
    expect(
      projectWithFloodVersion({
        ...project,
        history: [],
        undone: [],
        floodDatasets: undefined,
      } as typeof project).schemaVersion,
    ).toBe(11);
  });
  it("rejects dangling references even only in undone command payloads and rejects historical dataset tampering", async () => {
    const f = await floodFixture(),
      after = f.scenario,
      before = createScenario("Before");
    const e: HistoryEntry = {
      id: "entry",
      at: after.updatedAt,
      actor: "fixture",
      label: "Flood",
      command: {
        type: "scenario.flood",
        flood: { version: 1, datasetHash: "f".repeat(64), origin: "imported" },
      },
      before,
      after,
    };
    const p = { ...f.project, undone: [e] };
    await expect(validateProjectFlood(p, f.place)).rejects.toThrow(
      "no retained dataset",
    );
    expect(projectSchema.safeParse(p).success).toBe(false);
    const corrupt = structuredClone(f.project);
    corrupt.floodDatasets![f.datasetHash].notes.push("changed");
    await expect(validateProjectFlood(corrupt, f.place)).rejects.toThrow(
      "content",
    );
    expect(() =>
      validateFloodCatalogTransition(f.project, {
        ...f.project,
        floodDatasets: {},
      }),
    ).toThrow("Retain immutable");
  });
  it("rejects baseline adoption, format downgrade, out-of-study geometry and mismatched raw classifications", async () => {
    const f = await floodFixture();
    expect(() =>
      applyCommand(f.project.scenarios[0], {
        type: "scenario.flood",
        flood: f.scenario.flood!,
      }),
    ).toThrow("baseline");
    expect(
      projectSchema.safeParse({ ...f.project, schemaVersion: 10 }).success,
    ).toBe(false);
    const d = structuredClone(f.dataset);
    d.zones[0].classification = "other-mapped";
    expect(() => validateFloodDataset(d, f.place)).toThrow("classification");
    d.zones[0].classification = "sfha";
    d.zones[0].geometry = floodRectangle(-112.09, 33.44, -112.07, 33.46);
    expect(() => validateFloodDataset(d, f.place)).toThrow("outside");
    const other = {
      ...f.place,
      studyArea: floodRectangle(-112.08, 33.44, -112.06, 33.459),
    };
    await expect(validateProjectFlood(f.project, other)).rejects.toThrow(
      "study-area",
    );
  });
  it("fences every required layer and protects source/status distinctions", async () => {
    const f = await floodFixture(),
      bad = structuredClone(f.dataset);
    bad.capture.layerReceipts[0].afterRecordsHash = "b".repeat(64);
    expect(floodDatasetSchema.safeParse(bad).success).toBe(false);
    bad.capture.layerReceipts = f.dataset.capture.layerReceipts.filter(
      (r) => r.layerId !== 41,
    );
    expect(floodDatasetSchema.safeParse(bad).success).toBe(false);
    const attrs = f.dataset.zones[1].attributes;
    expect(classifyFloodZone({ ...attrs, FLD_ZONE: "D" })).toBe("undetermined");
    expect(classifyFloodZone({ ...attrs, ZONE_SUBTY: null })).toBe(
      "undetermined",
    );
    expect(classifyFloodZone({ ...attrs, ZONE_SUBTY: "OPEN WATER" })).toBe(
      "undetermined",
    );
    expect(
      classifyFloodZone({ ...attrs, ZONE_SUBTY: "AREA NOT INCLUDED" }),
    ).toBe("undetermined");
    expect(
      classifyFloodZone({
        ...attrs,
        ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
      }),
    ).toBe("other-mapped");
    expect(
      classifyFloodZone({
        ...attrs,
        ZONE_SUBTY: "AREA WITH REDUCED FLOOD RISK DUE TO LEVEE",
      }),
    ).toBe("other-mapped");
  });
  it("installs a cloned catalog pack, reuses identical content, and refuses catalog/command payload expansion", async () => {
    const f = await floodFixture(),
      before = canonicalJSON(f.project),
      installed = await projectWithFloodDataset(f.project, f.dataset, f.place);
    expect(Object.keys(installed.floodDatasets!)).toEqual([f.datasetHash]);
    f.dataset.notes.push("caller changed after installation");
    expect(canonicalJSON(installed)).toBe(before);
    const entries = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        String(i).repeat(64),
        f.project.floodDatasets![f.datasetHash],
      ]),
    );
    expect(
      projectSchema.safeParse({ ...f.project, floodDatasets: entries }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        type: "scenario.flood",
        flood: f.scenario.flood,
        dataset: f.dataset,
      }).success,
    ).toBe(false);
    expect(
      floodReferenceSchema.safeParse({
        ...f.scenario.flood,
        dataset: f.dataset,
      }).success,
    ).toBe(false);
    expect(() => z.toJSONSchema(projectSchema, { io: "input" })).not.toThrow();
  });
});

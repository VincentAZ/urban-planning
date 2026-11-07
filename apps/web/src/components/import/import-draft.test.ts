import { describe, expect, it } from "vitest";
import type { GisInspection, GisLayer } from "../../../../api/src/gis-types";
import { initialSpatialDraft, spatialRecipe } from "./spatial-draft";
import { initialMapping, mappingRecipe } from "./mapping-draft";
import {
  ImportAttempts,
  assertImportCommitReceipt,
} from "../../lib/import-api";
import type { Project } from "@urban/core";
const layer: GisLayer = {
  id: "footprints",
  name: "Footprints",
  featureCount: 2,
  geometryTypes: { Polygon: 2 },
  entityTypes: {},
  fields: [
    { name: "name", type: "String", nullable: true, samples: ["A", null] },
    { name: "H_FT", type: "String", nullable: true, samples: ["12.5", null] },
    { name: "use", type: "String", nullable: false, samples: ["OFF", "RES"] },
  ],
  bounds: [0, 0, 100, 100],
  crs: null,
  supportedFootprints: 2,
  unsupportedEntities: 0,
  hasZ: false,
};
const inspection: GisInspection = {
  version: 1,
  format: "dxf",
  input: { sha256: "a".repeat(64), bytes: 1, members: [] },
  converter: {
    name: "GDAL",
    version: "pinned",
    projVersion: "pinned",
    imageDigest: "b".repeat(64),
  },
  layers: [layer],
  warnings: [],
};
describe("reviewed import recipes", () => {
  it("accepts only the exact committed successor, never a newer server project from idempotent recovery", () => {
    const preview = {
      projectId: "project-a",
      scenarioId: "proposal",
      expectedRevision: 4,
      expectedVersion: 7,
    };
    const result = {
      project: {
        id: "project-a",
        scenarios: [{ id: "proposal", revision: 5 }],
      } as Project,
      version: 8,
    };
    expect(() => assertImportCommitReceipt(preview, result)).not.toThrow();
    expect(() =>
      assertImportCommitReceipt(preview, { ...result, version: 9 }),
    ).toThrow("local draft was preserved");
    expect(() =>
      assertImportCommitReceipt(preview, {
        ...result,
        project: { ...result.project, id: "other-project" },
      }),
    ).toThrow();
    expect(() =>
      assertImportCommitReceipt({ ...preview, expectedRevision: 5 }, result),
    ).toThrow();
  });
  it("never guesses CRS or drawing units and retains control/check points and curve tolerance", () => {
    const draft = initialSpatialDraft(inspection);
    expect(() => spatialRecipe(draft, inspection)).toThrow("EPSG");
    draft.epsg = "26912";
    expect(() => spatialRecipe(draft, inspection)).toThrow("units");
    draft.units = "feet";
    draft.reference = "local";
    draft.controls = [
      { id: "a", x: "0", y: "0", longitude: "-112.07", latitude: "33.45" },
      { id: "b", x: "100", y: "0", longitude: "-112.069", latitude: "33.45" },
    ];
    draft.checkpoints = [
      {
        id: "check",
        x: "50",
        y: "50",
        longitude: "-112.0695",
        latitude: "33.4505",
      },
    ];
    const result = spatialRecipe(draft, inspection);
    expect(result.sourceCrs).toBeUndefined();
    expect(result.dxf).toMatchObject({
      units: "feet",
      curveToleranceMeters: 0.05,
      localTransform: {
        controls: [
          { source: [0, 0], target: [-112.07, 33.45] },
          { source: [100, 0], target: [-112.069, 33.45] },
        ],
        checkpoints: [{ source: [50, 50], target: [-112.0695, 33.4505] }],
        maximumResidualMeters: 5,
      },
    });
    draft.controls[0].x = "";
    expect(() => spatialRecipe(draft, inspection)).toThrow(
      "Control 1 source X",
    );
  });
  it("blocks unacknowledged flattening and unsupported-entity exclusions", () => {
    const input = {
        ...inspection,
        format: "geojson" as const,
        layers: [
          { ...layer, hasZ: true, featureCount: 3, unsupportedEntities: 1 },
        ],
      },
      draft = initialSpatialDraft(input);
    expect(() => spatialRecipe(draft, input)).toThrow("unsupported");
    draft.acknowledgeExcluded = true;
    expect(() => spatialRecipe(draft, input)).toThrow("flattening");
    draft.flattenZ = true;
    expect(spatialRecipe(draft, input)).toMatchObject({
      sourceCrs: { kind: "file" },
      flattenZ: true,
      acknowledgeExcluded: true,
    });
  });
  it("requires explicit exclusion review for entities in unselected layers even when the chosen layer is entirely supported", () => {
    const input: GisInspection = {
      ...inspection,
      layers: [
        layer,
        {
          ...layer,
          id: "notes",
          name: "Notes",
          featureCount: 3,
          supportedFootprints: 0,
          unsupportedEntities: 3,
        },
      ],
    };
    const draft = initialSpatialDraft(input);
    draft.reference = "epsg";
    draft.epsg = "26912";
    draft.units = "meters";
    expect(() => spatialRecipe(draft, input)).toThrow("unselected layers");
    draft.acknowledgeExcluded = true;
    expect(spatialRecipe(draft, input).acknowledgeExcluded).toBe(true);
  });
  it("keeps blank quantities missing, distinguishes explicit zero, and preserves declared units and decimal parsing", () => {
    const draft = initialMapping("buildings", layer);
    expect(() => mappingRecipe(draft, layer)).toThrow("land use");
    draft.use = "office";
    expect(Object.values(mappingRecipe(draft, layer).quantities!)).toEqual(
      Array(5).fill({ kind: "missing" }),
    );
    draft.quantities.jobs = {
      ...draft.quantities.jobs,
      mode: "constant",
      value: "",
    };
    expect(() => mappingRecipe(draft, layer)).toThrow("assumption");
    draft.quantities.jobs.value = "0";
    draft.quantities.height = {
      ...draft.quantities.height,
      mode: "field",
      field: "H_FT",
      unit: "us-survey-feet",
      decimal: "comma",
    };
    expect(mappingRecipe(draft, layer).quantities).toMatchObject({
      jobs: { kind: "constant", value: 0 },
      height: {
        kind: "field",
        field: "H_FT",
        unit: "us-survey-feet",
        decimal: "comma",
      },
      floors: { kind: "missing" },
    });
  });
  it("requires explicit source namespace for replacement and preserves top-level feature IDs", () => {
    const draft = initialMapping("parcels", layer);
    draft.targetMode = "match";
    draft.matchBy = "sourceFeatureId";
    draft.matchField = "$featureId";
    expect(() => mappingRecipe(draft, layer)).toThrow("namespace");
    draft.sourceId = "official-lots";
    draft.referenceField = "$featureId";
    expect(mappingRecipe(draft, layer)).toMatchObject({
      target: {
        mode: "match",
        by: "sourceFeatureId",
        field: "$featureId",
        sourceId: "official-lots",
      },
      sourceFeatureId: { kind: "field", field: "$featureId" },
    });
  });
  it("rejects incomplete and duplicate land-use mappings instead of silently classifying missing codes", () => {
    const draft = initialMapping("buildings", layer);
    draft.useMode = "field";
    draft.useField = "use";
    draft.useValues = [
      { id: "a", raw: "OFF", use: "office" },
      { id: "b", raw: "RES", use: "" },
    ];
    expect(() => mappingRecipe(draft, layer)).toThrow("Complete");
    draft.useValues[1] = { id: "b", raw: "OFF", use: "residential" };
    expect(() => mappingRecipe(draft, layer)).toThrow("only once");
  });
  it("retains exact retry identity and original version after an uncertain response", () => {
    const attempts = new ImportAttempts<{ version: number; key: string }>();
    const first = attempts.for("same source and recipe", () => ({
      version: 2,
      key: "first",
    }));
    expect(
      attempts.for("same source and recipe", () => ({
        version: 3,
        key: "duplicate",
      })),
    ).toBe(first);
    attempts.clear();
    expect(
      attempts.for("same source and recipe", () => ({
        version: 3,
        key: "after rejection",
      })),
    ).toEqual({ version: 3, key: "after rejection" });
  });
});

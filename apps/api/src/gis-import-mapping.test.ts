import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  canonicalJSON,
  buildingGeometry,
  type Building,
  type StudyAreaGeometry,
} from "@urban/core";
import { createScenario, calculateImpact } from "@urban/models";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { prepareGisPreview } from "./gis-import-mapping.js";
import { prepareGisPreviewInWorker } from "./gis-mapping-worker.js";
import type { GisNormalized } from "./gis-types.js";
import type { GisPreviewRequest } from "./gis-jobs-types.js";

export const gisGeometry: StudyAreaGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-112.001, 32.999],
      [-111.999, 32.999],
      [-111.999, 33.001],
      [-112.001, 33.001],
      [-112.001, 32.999],
    ],
    [
      [-112.0004, 32.9996],
      [-112.0004, 33.0004],
      [-111.9996, 33.0004],
      [-111.9996, 32.9996],
      [-112.0004, 32.9996],
    ],
  ],
};
export function normalizedFixture(
  properties: Record<string, unknown> = {},
): GisNormalized {
  const geojson: GisNormalized["geojson"] = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "source-1",
        properties,
        geometry: structuredClone(gisGeometry),
      },
    ],
  };
  return {
    version: 1,
    geojson,
    provenance: {
      version: 1,
      format: "geojson",
      upload: {
        name: "fixture.geojson",
        sha256: "a".repeat(64),
        bytes: 100,
        members: [],
      },
      selection: { layer: "fixture" },
      crs: { source: "EPSG:4326", axisOrder: "xy", target: "OGC:CRS84" },
      operation: { name: "Synthetic identity operation", accuracyMeters: 0 },
      converter: { name: "Synthetic test converter", version: "1" },
      normalizedSha256: createHash("sha256")
        .update(canonicalJSON(geojson))
        .digest("hex"),
      recipe: {},
      exclusions: [],
    },
    diagnostics: {
      inputFeatures: 1,
      selectedFeatures: 1,
      outputFeatures: 1,
      excludedFeatures: 0,
      vertices: 10,
      warnings: [],
    },
  };
}
const rehash = (n: GisNormalized) => {
  n.provenance.normalizedSha256 = createHash("sha256")
    .update(canonicalJSON(n.geojson))
    .digest("hex");
  return n;
};
function fixture() {
  const place = structuredClone(workforcePlaceFixture),
    scenario = createScenario("GIS proposal");
  const request: GisPreviewRequest = {
    scenarioId: scenario.id,
    expectedVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "fixture-request-1",
    conversion: { layerId: "fixture", sourceCrs: { kind: "file" } },
    mapping: {
      layer: "buildings",
      target: { mode: "append" },
      use: { kind: "constant", value: "office" },
    },
    source: {
      name: "Synthetic GIS test",
      license: "Test data; private use",
      privateUseConfirmed: true,
      publicRedistribution: false,
    },
  };
  return {
    normalized: normalizedFixture(),
    request,
    place,
    scenario,
    projectId: "project-fixture",
    jobId: "job-fixture",
    uploadId: "upload-fixture",
    importId: "preview-fixture",
    userId: "user-fixture",
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-07T00:00:00Z",
  };
}
describe("GIS field mapping and immutable preview", () => {
  it("rejects same-kind parcel overlaps before preview while allowing exact matched replacement and block overlays", async () => {
    const input = fixture();
    input.request.mapping = { layer: "parcels", target: { mode: "append" } };
    const first = await prepareGisPreview(input);
    if (first.layer === "buildings") throw new Error("fixture layer");
    input.scenario = applyCommand(input.scenario, {
      type: "parcels.import",
      parcels: first.parcels,
      source: first.source,
      mode: "append",
    });
    input.importId = "preview-second";
    input.jobId = "job-second";
    await expect(prepareGisPreviewInWorker(input)).rejects.toMatchObject({
      code: "GIS_PARCEL_TOPOLOGY",
      message: expect.stringMatching(/overlaps/),
    });
    input.request.mapping.target = {
      mode: "match",
      by: "id",
      field: "$featureId",
    };
    input.normalized.geojson.features[0].id = first.parcels[0].id;
    rehash(input.normalized);
    expect((await prepareGisPreview(input)).changes.updated).toBe(1);
    input.request.mapping = { layer: "blocks", target: { mode: "append" } };
    expect((await prepareGisPreview(input)).featureCount).toBe(1);
    input.scenario = createScenario("Empty parcel proposal");
    input.request.mapping.layer = "parcels";
    input.normalized.geojson.features.push({
      ...structuredClone(input.normalized.geojson.features[0]),
      id: "second-reference",
    });
    rehash(input.normalized);
    await expect(prepareGisPreview(input)).rejects.toMatchObject({
      code: "GIS_PARCEL_TOPOLOGY",
      message: expect.stringMatching(/overlaps/),
    });
  });
  it("runs mapping in a terminable bounded worker and rejects an aborted or expired operation", async () => {
    const input = fixture();
    input.request.source.vintage = "";
    expect((await prepareGisPreviewInWorker(input)).featureCount).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareGisPreviewInWorker(input, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "GIS_CANCELLED" });
    await expect(
      prepareGisPreviewInWorker(input, { milliseconds: 1 }),
    ).rejects.toMatchObject({ code: "GIS_MAPPING_TIMEOUT" });
  });
  it("preserves holes, true unknowns, explicit zero, and private source rights", async () => {
    const input = fixture();
    input.normalized = normalizedFixture({ homes: 0 });
    input.request.mapping.quantities = {
      units: { kind: "field", field: "homes" },
    };
    const result = await prepareGisPreview(input);
    if (result.layer !== "buildings") throw new Error("fixture layer");
    const building = result.buildings[0];
    expect(buildingGeometry(building)).toEqual(gisGeometry);
    expect(building).toMatchObject({
      height: null,
      floors: null,
      units: 0,
      jobs: null,
      parkingSpaces: null,
    });
    expect(building.attributeProvenance?.fields.units).toMatchObject({
      status: "supplied",
      rawValue: 0,
      sourceField: "homes",
    });
    expect(building.attributeProvenance?.fields.jobs?.status).toBe("missing");
    expect(result.source.vintage).toBe("Unknown");
    expect(result.source.rights?.publicRedistribution).toBe(false);
    const { previewHash, ...content } = result;
    expect(previewHash).toBe(
      createHash("sha256").update(canonicalJSON(content)).digest("hex"),
    );
    const changed = applyCommand(input.scenario, {
      type: "buildings.import",
      buildings: result.buildings,
      source: result.source,
      mode: "append",
    });
    const metrics = calculateImpact(input.place, changed).metrics;
    expect(
      metrics.filter((m) =>
        m.coverage?.scenario.missingBuildingIds.includes(building.id),
      ).length,
    ).toBeGreaterThan(0);
  });
  it("accepts only explicit decimal conventions and converts reviewed height units", async () => {
    const input = fixture();
    input.normalized = normalizedFixture({ roof: "10,5", storeys: "0" });
    input.request.mapping.quantities = {
      height: { kind: "field", field: "roof", unit: "feet", decimal: "comma" },
      floors: { kind: "field", field: "storeys" },
    };
    const result = await prepareGisPreview(input);
    if (result.layer !== "buildings") throw new Error("fixture layer");
    expect(result.buildings[0].height).toBeCloseTo(3.2004, 10);
    expect(result.buildings[0].floors).toBe(0);
    expect(
      result.buildings[0].attributeProvenance?.fields.height?.sourceUnit,
    ).toBe("feet");
    input.request.mapping.quantities!.height = {
      kind: "field",
      field: "roof",
      decimal: "dot",
    };
    await expect(prepareGisPreview(input)).rejects.toThrow(/unambiguous dot/);
    input.normalized = normalizedFixture({ roof: true });
    await expect(prepareGisPreview(input)).rejects.toThrow(/booleans/);
  });
  it("requires recognized reviewed uses, no Vacant fallback or executable mapping", async () => {
    const input = fixture();
    delete input.request.mapping.use;
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /explicit reviewed use/,
    );
    input.request.mapping.use = {
      kind: "field",
      field: "use_code",
      values: { O: "office" },
    };
    input.normalized = normalizedFixture({ use_code: "MISSING" });
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /no reviewed mapping/,
    );
    input.request.mapping.use = { kind: "constant", value: "office" };
    Object.assign(input.request.mapping, { expression: "process.env" });
    await expect(prepareGisPreview(input)).rejects.toThrow(/expression/);
  });
  it("matches source IDs only inside the selected namespace and rejects ambiguous, duplicate or missing targets", async () => {
    const input = fixture(),
      initial = await prepareGisPreview(input);
    if (initial.layer !== "buildings") throw new Error("fixture layer");
    const building: Building = {
      ...initial.buildings[0],
      id: "existing",
      sourceId: "survey-a",
      attributeSourceId: "survey-a",
      geometrySourceId: "survey-a",
      address: "Retained street address",
      zoning: "Recorded local designation",
      maxHeight: 24,
      typology: "office",
    };
    input.place.buildings = [
      building,
      {
        ...building,
        id: "other-namespace",
        sourceId: "survey-b",
        geometrySourceId: "survey-b",
      },
    ];
    input.request.mapping.target = {
      mode: "match",
      field: "$featureId",
      by: "sourceFeatureId",
      sourceId: "survey-a",
    };
    const match = await prepareGisPreview(input);
    if (match.layer !== "buildings") throw new Error("fixture layer");
    expect(match.buildings[0]).toMatchObject({
      id: "existing",
      address: building.address,
      zoning: building.zoning,
      maxHeight: 24,
      attributeSourceId: "survey-a",
    });
    expect(match.buildings[0].typology).toBeUndefined();
    expect(match.warnings.join(" ")).toContain(
      "existing typology will be removed",
    );
    expect(match.changes).toMatchObject({ added: 0, updated: 1 });
    input.place.buildings.push({ ...building, id: "ambiguous" });
    await expect(prepareGisPreview(input)).rejects.toThrow(/ambiguous/);
    input.place.buildings.pop();
    input.normalized.geojson.features.push(
      structuredClone(input.normalized.geojson.features[0]),
    );
    rehash(input.normalized);
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /same existing feature/,
    );
    input.normalized = normalizedFixture();
    input.normalized.geojson.features[0].id = "unmatched";
    rehash(input.normalized);
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /no feature will be silently appended/,
    );
  });
  it("reports appended duplicate space and blocks changed bytes or geometry outside the actual boundary", async () => {
    const input = fixture(),
      first = await prepareGisPreview(input);
    if (first.layer !== "buildings") throw new Error("fixture layer");
    input.place.buildings = [{ ...first.buildings[0], id: "old-building" }];
    const overlap = await prepareGisPreview(input);
    expect(overlap.changes.overlaps).toEqual([
      {
        importedId: "import-job-fixture-1",
        existingId: "old-building",
        name: first.buildings[0].name,
      },
    ]);
    input.normalized.geojson.features[0].properties = { injected: "changed" };
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /changed after conversion/,
    );
    input.normalized = normalizedFixture();
    input.normalized.geojson.features[0].geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0.01],
          [0, 0],
        ],
      ],
    };
    rehash(input.normalized);
    await expect(prepareGisPreview(input)).rejects.toThrow(
      /study area|boundary/i,
    );
  });
});

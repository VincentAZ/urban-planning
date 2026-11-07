import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyBuildingGeometry,
  baselineIdentity,
  buildingGeometry,
  materializeBuildings,
  pointInStudyArea,
  type Building,
  type BuildingProgram,
  type Command,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type StudyAreaGeometry,
} from "@urban/core";
import { buildingPreset } from "@urban/models";
import { buildApp } from "./app";
import { FileStore } from "./store";
import { previewGeoJson } from "./imports";

const ring = (w: number, s: number, e: number, n: number): Position[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const geometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      ring(-112.078, 33.452, -112.073, 33.458),
      ring(-112.077, 33.454, -112.075, 33.456),
    ],
    [ring(-112.07, 33.452, -112.068, 33.454)],
  ],
};
const program: BuildingProgram = {
  version: 1,
  grossFloorAreaSqm: 15000,
  commonAreaSqm: 1000,
  components: [
    {
      id: "homes",
      use: "multifamily",
      residentialSubtype: "apartment",
      grossFloorAreaSqm: 10000,
      units: 80,
      jobs: 2,
      tripRate: {
        value: 6,
        basis: "occupied-dwelling",
        sourceId: "untrusted-claim",
      },
    },
    {
      id: "shops",
      name: "Ground-floor shops",
      use: "retail",
      grossFloorAreaSqm: 4000,
      units: 0,
      jobs: 40,
      parkingRate: {
        value: 2.5,
        basis: "1000-sqft",
        sourceId: "untrusted-claim",
      },
    },
  ],
};
const place: Place = {
  id: "building-fixture",
  name: "Building study",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.46],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: ring(-112.08, 33.45, -112.06, 33.47),
  buildings: [
    {
      ...buildingPreset("office", [-112.063, 33.465]),
      id: "captured",
      sourceId: "source",
    },
  ],
  roads: [],
  sources: [
    {
      id: "source",
      name: "Captured test source",
      url: "",
      vintage: "2025",
      license: "Fixture",
      kind: "user-supplied",
    },
  ],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Synthetic building fixture",
};
type Saved = {
  project: Project;
  version: number;
  baseline: Place;
  baselineIdentity: { sha256: string };
};
const active = (saved: Saved): Scenario =>
  saved.project.scenarios.find((s) => s.id === saved.project.activeScenarioId)!;
const apps = new Set<FastifyInstance>();
const dirs: string[] = [];
async function setup(file?: string) {
  const identityMail = new FixtureIdentityMail();
  const app = await buildApp({
    identityMail,
    store: new FileStore(file),
    catalog: {
      list: async () => [place],
      get: async () => structuredClone(place),
    },
    nationalPreparationEnabled: false,
  });
  attachIdentityTestMail(app, identityMail);
  apps.add(app);
  return app;
}
async function register(app: FastifyInstance, name = "owner") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${name}@buildings.test`,
      name,
      password: "long building test password",
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    id: response.json().user.id as string,
    organizationId: response.json().organization.id as string,
    email: `${name}@buildings.test`,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}
async function fixture(file?: string) {
  const app = await setup(file),
    user = await register(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: { placeId: place.id },
  });
  expect(response.statusCode, response.body).toBe(201);
  const detail = await app.inject({
    url: `/api/v1/projects/${response.json().project.id}`,
    headers: user.headers,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  return { app, user, saved: detail.json<Saved>() };
}
function upload() {
  return {
    layer: "buildings",
    sourceName: "Local building program",
    sourceUrl: "https://example.test/building-data",
    sourceVintage: "2026 local plan",
    sourceLicense: "Synthetic test use",
    publicRedistribution: true,
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "__proto__",
          geometry: structuredClone(geometry),
          properties: {
            name: "Courtyard mixed use",
            use: "mixed-use",
            typology: "mixed-use",
            height: 18,
            floors: 5,
            parkingSpaces: 60,
            program: structuredClone(program),
            areaSqm: 1,
            owner: "not imported",
            zoning: "not imported",
          },
        },
      ],
    },
  };
}
async function preview(
  app: FastifyInstance,
  headers: Record<string, string>,
  saved: Saved,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/imports/geojson/preview",
    headers,
    payload: {
      ...upload(),
      projectId: saved.project.id,
      scenarioId: active(saved).id,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ importId: string; buildings: Building[] }>();
}
async function commit(
  app: FastifyInstance,
  headers: Record<string, string>,
  saved: Saved,
  importId: string,
  overrides = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/imports/${importId}/commit`,
    headers,
    payload: {
      scenarioId: active(saved).id,
      expectedVersion: saved.version,
      expectedRevision: active(saved).revision,
      acknowledgeWarnings: true,
      ...overrides,
    },
  });
}
async function command(
  app: FastifyInstance,
  headers: Record<string, string>,
  saved: Saved,
  command: Command,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/scenarios/${active(saved).id}/commands`,
    headers,
    payload: {
      command,
      expectedVersion: saved.version,
      expectedRevision: active(saved).revision,
    },
  });
}
afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("complete building geometry and programs", () => {
  it("imports complete geometry, explicit programs and provenance without guessed ownership or double-counted mirrors", () => {
    const parsed = previewGeoJson(upload());
    if (parsed.layer !== "buildings") throw new Error("Wrong layer");
    const b = parsed.buildings[0];
    expect(buildingGeometry(b)).toEqual(geometry);
    expect(b).not.toHaveProperty("footprint");
    expect(b.areaSqm).toBeGreaterThan(1);
    expect(b).toMatchObject({
      units: 80,
      jobs: 42,
      sourceFeatureId: "__proto__",
      geometrySourceId: parsed.source.id,
      programSourceId: parsed.source.id,
    });
    expect(b).not.toHaveProperty("owner");
    expect(b).not.toHaveProperty("zoning");
    expect(b.program?.components[0].tripRate?.sourceId).toBe(parsed.source.id);
    expect(b.program?.components[1].parkingRate?.sourceId).toBe(
      parsed.source.id,
    );
    expect(parsed.source).toMatchObject({
      url: "https://example.test/building-data",
      vintage: "2026 local plan",
      license: "Synthetic test use",
      kind: "user-supplied",
    });
    expect(parsed.warnings.join(" ")).toContain("uniform-height massing");
    const invalid = upload();
    invalid.geojson.features[0].properties.program.commonAreaSqm = 0;
    expect(() => previewGeoJson(invalid)).toThrow(
      /floor areas plus common area/,
    );
    const mirrors = upload();
    Object.assign(mirrors.geojson.features[0].properties, { units: 1 });
    expect(() => previewGeoJson(mirrors)).toThrow(/homes and jobs must match/);
    const derivedUse = upload();
    Reflect.deleteProperty(derivedUse.geojson.features[0].properties, "use");
    const derived = previewGeoJson(derivedUse);
    expect(derived.layer === "buildings" && derived.buildings[0].use).toBe(
      "mixed-use",
    );
    const wrongUse = upload();
    wrongUse.geojson.features[0].properties.use = "office";
    expect(() => previewGeoJson(wrongUse)).toThrow(/use must/);
    wrongUse.geojson.features[0].properties.use = "unrecognized-use";
    expect(() => previewGeoJson(wrongUse)).toThrow(
      /supplied use must be recognized/,
    );
    const crs = upload();
    Object.assign(crs.geojson, {
      crs: { type: "name", properties: { name: "EPSG:3857" } },
    });
    expect(() => previewGeoJson(crs)).toThrow(/Reproject/);
  });

  it("durably saves format 3, retries import once, reopens, publishes and exports the exact geometry/program with the untouched legacy baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-buildings-"));
    dirs.push(directory);
    const file = join(directory, "state.json");
    let { app, user, saved } = await fixture(file);
    const original = structuredClone(saved.baseline),
      identity = await baselineIdentity(original);
    expect(saved.project.schemaVersion).toBe(1);
    const staged = await preview(app, user.headers, saved);
    const noReview = await commit(app, user.headers, saved, staged.importId, {
      acknowledgeWarnings: false,
    });
    expect(noReview.statusCode).toBe(422);
    const response = await commit(app, user.headers, saved, staged.importId);
    expect(response.statusCode, response.body).toBe(200);
    const retry = await commit(app, user.headers, saved, staged.importId);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().version).toBe(response.json().version);
    saved = response.json<Saved>();
    expect(saved.project.schemaVersion).toBe(8);
    expect(saved.project.history).toHaveLength(1);
    const imported = materializeBuildings(place, active(saved)).find(
      (b) => b.id !== "captured",
    )!;
    expect(imported.geometry).toEqual(geometry);
    expect(imported.program?.components).toHaveLength(2);
    await app.close();
    apps.delete(app);
    app = await setup(file);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: user.headers,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    saved = detail.json<Saved>();
    expect(saved.baseline).toEqual(original);
    expect(saved.baselineIdentity.sha256).toBe(identity.sha256);
    expect(
      materializeBuildings(saved.baseline, active(saved)).find(
        (b) => b.id === imported.id,
      ),
    ).toEqual(imported);
    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: user.headers,
      payload: {
        scenarioId: active(saved).id,
        expectedVersion: saved.version,
        expectedRevision: active(saved).revision,
        text: "Review this courtyard entrance",
        target: { kind: "building", id: imported.id },
        idempotencyKey: "courtyard-building-review",
      },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(
      pointInStudyArea(comment.json().comment.targetPosition, geometry),
    ).toBe(true);
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers: user.headers,
      payload: {
        scenarioId: active(saved).id,
        expectedRevision: active(saved).revision,
        expectedVersion: saved.version,
        acknowledgeDataRights: true,
        feedbackEnabled: false,
      },
    });
    expect(published.statusCode, published.body).toBe(201);
    const publicResult = await app.inject({
      method: "GET",
      url: `/api/v1/published/${published.json().id}`,
    });
    expect(publicResult.statusCode, publicResult.body).toBe(200);
    expect(publicResult.json().scenario.buildingEdits[imported.id]).toEqual(
      imported,
    );
    const geo = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${saved.project.id}/exports?format=geojson&scenarioId=${active(saved).id}&revision=${active(saved).revision}&version=${saved.version}`,
      headers: user.headers,
    });
    expect(geo.statusCode, geo.body).toBe(200);
    const feature = geo
      .json()
      .features.find((f: { id: string }) => f.id === imported.id);
    expect(feature.geometry).toEqual(geometry);
    expect(feature.properties.program).toEqual(imported.program);
    expect(feature.properties).not.toHaveProperty("geometry");
    expect(feature.properties).not.toHaveProperty("footprint");
    expect(feature.properties.scenarioRevision).toBe(active(saved).revision);
    const downgrade = structuredClone(saved.project);
    downgrade.schemaVersion = 2;
    const lostFields = structuredClone(downgrade);
    for (const state of [
      ...lostFields.scenarios,
      ...lostFields.history.flatMap((h) => [h.before, h.after]),
    ]) {
      state.buildingEdits = {};
      state.sources = state.sources?.map(
        ({ rights: _rights, import: _import, ...source }) => source,
      );
    }
    lostFields.history = [];
    const rejected = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: user.headers,
      payload: {
        project: lostFields,
        expectedVersion: saved.version,
        baselineHash: identity.sha256,
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json().error.code).toBe("PROJECT_VERSION_DOWNGRADE");
  });

  it("rejects invalid current and historical geometry/programs without advancing saved content", async () => {
    const { app, user, saved: initial } = await fixture();
    const staged = await preview(app, user.headers, initial),
      response = await commit(app, user.headers, initial, staged.importId);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<Saved>(),
      b = Object.values(active(saved).buildingEdits)[0]!;
    const invalidProgram = structuredClone(b);
    invalidProgram.program!.components[0].units++;
    expect(
      (
        await command(app, user.headers, saved, {
          type: "building.upsert",
          building: invalidProgram,
        })
      ).statusCode,
    ).toBe(400);
    const outside = applyBuildingGeometry(b, {
      type: "Polygon",
      coordinates: [ring(-111, 34, -110.999, 34.001)],
    });
    expect(
      (
        await command(app, user.headers, saved, {
          type: "building.upsert",
          building: outside,
        })
      ).statusCode,
    ).toBe(422);
    const badHistory = structuredClone(saved.project);
    badHistory.history[0].before.buildingEdits.outside = {
      ...outside,
      id: "outside",
    };
    const historical = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: user.headers,
      payload: { project: badHistory, expectedVersion: saved.version },
    });
    expect(historical.statusCode, historical.body).toBe(422);
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: user.headers,
    });
    expect(got.json().version).toBe(saved.version);
    expect(got.json().project).toEqual(saved.project);
  });

  it("rejects reserved building/road keys in commands and raw whole-save JSON while retaining arbitrary external references", async () => {
    const { app, user, saved } = await fixture();
    for (const id of ["__proto__", "constructor", "toString"]) {
      const b = { ...buildingPreset("office", place.center), id };
      expect(
        (
          await command(app, user.headers, saved, {
            type: "building.upsert",
            building: b,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const key of ["buildingEdits", "roadEdits"] as const) {
      const project = structuredClone(saved.project);
      project.scenarios[1][key] = Object.fromEntries([["__proto__", null]]);
      const result = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: { ...user.headers, "content-type": "application/json" },
        payload: JSON.stringify({ project, expectedVersion: saved.version }),
      });
      expect(result.statusCode, result.body).toBe(400);
    }
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: user.headers,
    });
    expect(got.json().project).toEqual(saved.project);
    expect(got.json().version).toBe(saved.version);
  });

  it("binds staged building data to uploader and live project permission, including CSRF", async () => {
    const { app, user, saved } = await fixture();
    const peer = await register(app, "peer");
    const staged = await preview(app, user.headers, saved);
    expect(
      (await commit(app, peer.headers, saved, staged.importId)).statusCode,
    ).toBe(404);
    expect(
      (
        await commit(
          app,
          { cookie: user.headers.cookie },
          saved,
          staged.importId,
        )
      ).statusCode,
    ).toBe(403);
    const accepted = await acceptIdentityTestInvitation(
      app,
      user,
      peer,
      "editor",
      saved.project.id,
    );
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: peer.headers,
      payload: { organizationId: user.organizationId },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const peerStaged = await preview(app, peer.headers, saved);
    const downgrade = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${saved.project.id}/members/${peer.id}`,
      headers: user.headers,
      payload: {
        role: "viewer",
        expectedAclVersion: accepted.aclVersion,
      },
    });
    expect(downgrade.statusCode, downgrade.body).toBe(200);
    expect(
      (await commit(app, peer.headers, saved, peerStaged.importId)).statusCode,
    ).toBe(403);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${saved.project.id}/members/${peer.id}`,
      headers: user.headers,
      payload: { expectedAclVersion: downgrade.json().access.aclVersion },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (await commit(app, peer.headers, saved, peerStaged.importId)).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${saved.project.id}`,
          headers: user.headers,
        })
      ).json().version,
    ).toBe(saved.version);
  });
});

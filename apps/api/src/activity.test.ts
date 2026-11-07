import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineIdentity,
  USER_ACTIVITY_SOURCE,
  validateProjectSnapshot,
  type ActivityScenario,
  type Place,
  type Project,
} from "@urban/core";
import { buildApp } from "./app";
import { buildingPreset } from "@urban/models";
import { FileStore } from "./store";
import { VEHICLE_SOURCE_URL } from "./data/acs-vehicles";

const place: Place = {
  id: "activity-fixture",
  name: "Activity fixture",
  city: "QA",
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
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Synthetic activity study",
  geography: { type: "zcta", code: "85004", boundaryVintage: "2020" },
};
const activity = (): ActivityScenario => ({
  version: 1,
  reference: {
    population: {
      kind: "entered",
      value: 1000,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2024,
      universe: "Synthetic residents",
    },
    employment: {
      kind: "entered",
      value: 200,
      sourceId: USER_ACTIVITY_SOURCE.id,
      asOfYear: 2024,
      universe: "Synthetic workplace jobs",
    },
  },
  allocation: { population: "uniform-area", employment: "uniform-area" },
  global: {
    population: { mode: "baseline-percent", percent: 125 },
    employment: { mode: "absolute", value: 220 },
    householdVehicles: { mode: "absolute", value: 300 },
  },
  neighborhoods: [
    {
      id: "west",
      name: "West courtyard area",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-112.079, 33.441],
            [-112.071, 33.441],
            [-112.071, 33.449],
            [-112.079, 33.449],
            [-112.079, 33.441],
          ],
          [
            [-112.077, 33.443],
            [-112.073, 33.443],
            [-112.073, 33.447],
            [-112.077, 33.447],
            [-112.077, 33.443],
          ],
        ],
      },
      population: { mode: "absolute", value: 60 },
      employment: { mode: "baseline-percent", percent: 80 },
      sourceId: USER_ACTIVITY_SOURCE.id,
    },
  ],
  demandResponse: {
    population: "none",
    employment: "none",
    vehicles: "none",
    reviewed: false,
    sourceId: USER_ACTIVITY_SOURCE.id,
  },
});
type Saved = {
  project: Project;
  version: number;
  baseline: Place;
  baselineIdentity: { sha256: string };
};
type User = {
  id: string;
  email: string;
  organizationId: string;
  headers: Record<string, string>;
};
const apps = new Set<FastifyInstance>(),
  dirs: string[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup(file?: string, cachePath?: string, study = place) {
  const identityMail = new FixtureIdentityMail();
  const app = await buildApp({
    identityMail,
    store: new FileStore(file),
    catalog: {
      list: async () => [study],
      get: async () => structuredClone(study),
    },
    nationalPreparationEnabled: false,
    vehicleCachePath: cachePath,
  });
  attachIdentityTestMail(app, identityMail);
  apps.add(app);
  return app;
}
async function account(app: FastifyInstance, name: string): Promise<User> {
  const email = `${name}@activity.test`,
    r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { name, email, password: "a long isolated activity password" },
    });
  expect(r.statusCode, r.body).toBe(201);
  return {
    id: r.json().user.id,
    email,
    organizationId: r.json().organization.id,
    headers: {
      cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
      "x-csrf-token": r.json().csrfToken,
    },
  };
}
async function create(app: FastifyInstance, user: User) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: { placeId: place.id },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<Saved>();
}
const scenario = (saved: Saved) =>
  saved.project.scenarios.find((s) => s.id === saved.project.activeScenarioId)!;
async function edit(
  app: FastifyInstance,
  user: User,
  saved: Saved,
  value: unknown = activity(),
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/scenarios/${scenario(saved).id}/commands`,
    headers: user.headers,
    payload: {
      expectedVersion: saved.version,
      expectedRevision: scenario(saved).revision,
      command: { type: "scenario.activity", activity: value },
    },
  });
}
async function cache() {
  const dir = await mkdtemp(join(tmpdir(), "urban-activity-"));
  dirs.push(dir);
  const path = join(dir, "vehicles.json"),
    now = "2026-11-05T00:00:00.000Z";
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      retrievedAt: now,
      sourceFile: {
        table: "B25046",
        url: VEHICLE_SOURCE_URL,
        sha256: "b".repeat(64),
        retrievedAt: now,
        bytes: 500,
      },
      columns: ["B25046_E001", "B25046_M001"],
      rows: { "85004": ["120", "19"] },
    }),
  );
  return { dir, path };
}
async function save(
  app: FastifyInstance,
  user: User,
  saved: Saved,
  project: Project,
) {
  return app.inject({
    method: "PUT",
    url: `/api/v1/projects/${saved.project.id}`,
    headers: user.headers,
    payload: { project, expectedVersion: saved.version },
  });
}

describe("saved activity controls and official household-vehicle evidence", () => {
  it("reads actual HTTP reference metadata without mutating baseline/version, verifies adoption, and survives cache loss/restart/publication/JSON restore", async () => {
    const files = await cache(),
      file = join(files.dir, "store.json");
    let app = await setup(file, files.path);
    const owner = await account(app, "owner");
    let saved = await create(app, owner);
    const base = `/api/v1/projects/${saved.project.id}`,
      identity = await baselineIdentity(place);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    const http = await fetch(
      `http://127.0.0.1:${address.port}${base}/vehicle-reference`,
      { headers: owner.headers },
    );
    expect(http.status).toBe(200);
    const reference = await http.json();
    expect(reference).toMatchObject({
      projectVersion: 1,
      baselineHash: identity.sha256,
      status: "available",
      reference: {
        measure: { estimate: { value: 120 }, marginOfError: { value: 19 } },
      },
    });
    const a = activity();
    a.reference.vehicles = { kind: "published" };
    a.vehicleReference = reference.reference;
    const forged = structuredClone(a);
    forged.vehicleReference!.measure.estimate.value = 121;
    expect((await edit(app, owner, saved, forged)).statusCode).toBe(422);
    let r = await edit(app, owner, saved, a);
    expect(r.statusCode, r.body).toBe(200);
    saved = r.json();
    expect(saved.project.schemaVersion).toBe(5);
    expect(scenario(saved).activity).toEqual(a);
    expect(saved.project.scenarios[0]).not.toHaveProperty("activity");
    const gis = await app.inject({
      url: `${base}/exports?format=geojson&version=2&revision=1`,
      headers: owner.headers,
    });
    expect(gis.statusCode, gis.body).toBe(200);
    expect(gis.json().metadata.activity.vehicleReference).toEqual(
      reference.reference,
    );
    expect(
      gis
        .json()
        .metadata.sources.some(
          (source: { id: string }) =>
            source.id === reference.reference.source.id,
        ),
    ).toBe(true);
    const publication = await app.inject({
      method: "POST",
      url: `${base}/publish`,
      headers: owner.headers,
      payload: { scenarioId: scenario(saved).id, expectedRevision: 1 },
    });
    expect(publication.statusCode, publication.body).toBe(201);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: { project: saved.project, baselineHash: identity.sha256 },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().project.scenarios[1].activity).toEqual(a);
    const restored = await validateProjectSnapshot({
      project: saved.project,
      place,
      baselineIdentity: identity,
    });
    expect(restored.project.scenarios[1].activity).toEqual(a);
    await rm(files.path);
    await app.close();
    apps.delete(app);
    app = await setup(file, files.path);
    const reopened = await app.inject({ url: base, headers: owner.headers });
    expect(reopened.json().project).toEqual(saved.project);
    expect(reopened.json().baseline).toEqual(place);
    expect(reopened.json().baselineIdentity.sha256).toBe(identity.sha256);
    r = await save(app, owner, saved, {
      ...saved.project,
      name: "Renamed without refetching source",
    });
    expect(r.statusCode, r.body).toBe(200);
    saved = r.json();
    r = await edit(app, owner, saved, null);
    expect(r.statusCode, r.body).toBe(200);
    saved = r.json();
    expect(saved.project.schemaVersion).toBe(5);
    expect(scenario(saved)).not.toHaveProperty("activity");
    const frozen = await app.inject(
      `/api/v1/published/${publication.json().id}`,
    );
    expect(frozen.json().scenario.activity).toEqual(a);
    expect(frozen.json().place).toEqual(place);
    const records = await app.inject({
      url: `${base}/exports?format=records&revision=2&version=4`,
      headers: owner.headers,
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json().project.history[0].command.activity).toEqual(a);
    expect(
      records
        .json()
        .audit.some(
          (x: { action: string }) => x.action === "scenario.activity",
        ),
    ).toBe(true);
    const undo = structuredClone(saved.project);
    undo.scenarios[1] = { ...undo.history[1].before, revision: 3 };
    undo.undone.push(undo.history[1]);
    r = await save(app, owner, saved, undo);
    expect(r.statusCode, r.body).toBe(200);
    saved = r.json();
    expect(scenario(saved).activity).toEqual(a);
    const downgrade = structuredClone(saved.project);
    downgrade.schemaVersion = 4;
    delete downgrade.scenarios[1].activity;
    downgrade.scenarios[1].revision++;
    downgrade.history = [];
    downgrade.undone = [];
    r = await save(app, owner, saved, downgrade);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("PROJECT_VERSION_DOWNGRADE");
  });
  it("rejects invalid targets, overlapping/outside areas, unknown sources and reserved IDs without a revision or history change", async () => {
    const app = await setup(),
      owner = await account(app, "invalid");
    const saved = await create(app, owner);
    const bads: ActivityScenario[] = [];
    let a = activity();
    a.global.population = { mode: "absolute", value: -1 };
    bads.push(a);
    a = activity();
    a.neighborhoods[0].id = "constructor";
    bads.push(a);
    a = activity();
    a.neighborhoods.push({
      ...structuredClone(a.neighborhoods[0]),
      id: "overlap",
    });
    bads.push(a);
    a = activity();
    a.neighborhoods[0].geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-113, 33],
          [-112.9, 33],
          [-112.9, 33.1],
          [-113, 33.1],
          [-113, 33],
        ],
      ],
    };
    bads.push(a);
    a = activity();
    a.neighborhoods[0].sourceId = "missing-source";
    bads.push(a);
    a = activity();
    a.demandResponse.vehicles = "replace-residential-with-stock";
    bads.push(a);
    for (const value of bads) {
      const r = await edit(app, owner, saved, value);
      expect([400, 422], r.body).toContain(r.statusCode);
    }
    const detail = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
    });
    expect(detail.json().project).toEqual(saved.project);
    expect(detail.json().version).toBe(1);
  });
  it("validates current, historical and command-only restored area geometry and evidence, not just the visible proposal", async () => {
    const app = await setup(),
      owner = await account(app, "history");
    let saved = await create(app, owner);
    const r = await edit(app, owner, saved);
    expect(r.statusCode, r.body).toBe(200);
    saved = r.json();
    for (const location of [
      "current",
      "before",
      "after",
      "command",
      "undone",
    ]) {
      const project = structuredClone(saved.project),
        bad = activity();
      bad.neighborhoods[0].geometry = {
        type: "Polygon",
        coordinates: [
          [
            [-113, 33],
            [-112.9, 33],
            [-112.9, 33.1],
            [-113, 33.1],
            [-113, 33],
          ],
        ],
      };
      if (location === "current") {
        project.scenarios[1].activity = bad;
        project.scenarios[1].revision++;
      } else if (location === "command") {
        project.history[0].command = {
          type: "scenario.activity",
          activity: bad,
        };
      } else if (location === "undone") {
        const entry = structuredClone(project.history[0]);
        entry.before.activity = bad;
        project.undone = [entry];
      } else project.history[0][location as "before" | "after"].activity = bad;
      const denied = await save(app, owner, saved, project);
      expect(denied.statusCode, denied.body).toBe(422);
    }
    const unchanged = structuredClone(saved.project);
    unchanged.scenarios[1].activity!.global.population = {
      mode: "absolute",
      value: 100,
    };
    expect((await save(app, owner, saved, unchanged)).statusCode).toBe(409);
  });
  it("rejects a repeatedly submitted over-budget allocation before committing any history", async () => {
    const template = buildingPreset("multifamily", place.center);
    const study = {
      ...structuredClone(place),
      buildings: Array.from({ length: 1001 }, (_, i) => ({
        ...structuredClone(template),
        id: `wide-${i}`,
        footprint: place.boundary,
      })),
    };
    const app = await setup(undefined, undefined, study),
      owner = await account(app, "complexity"),
      saved = await create(app, owner),
      value = activity();
    value.neighborhoods = Array.from({ length: 50 }, (_, i) => {
      const west = -112.079 + i * 0.00036,
        east = west + 0.0003;
      return {
        id: `stripe-${i}`,
        name: `Stripe ${i}`,
        sourceId: USER_ACTIVITY_SOURCE.id,
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [west, 33.441],
              [east, 33.441],
              [east, 33.459],
              [west, 33.459],
              [west, 33.441],
            ] as [number, number][],
          ],
        },
        population: { mode: "absolute" as const, value: 10 },
      };
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await edit(app, owner, saved, value);
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json().error.code).toBe("ACTIVITY_COMPLEXITY");
    }
    const detail = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
    });
    expect(detail.json().version).toBe(1);
    expect(detail.json().project.history).toEqual([]);
  });
  it("keeps public reads private to project membership and applies live role downgrades, CSRF and stale versions to edits", async () => {
    const app = await setup(),
      owner = await account(app, "acl-owner"),
      reader = await account(app, "reader"),
      outsider = await account(app, "outsider");
    let saved = await create(app, owner);
    const base = `/api/v1/projects/${saved.project.id}`;
    expect((await app.inject(`${base}/vehicle-reference`)).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: `${base}/vehicle-reference`,
          headers: outsider.headers,
        })
      ).statusCode,
    ).toBe(404);
    const accepted = await acceptIdentityTestInvitation(
      app,
      owner,
      reader,
      "editor",
      saved.project.id,
    );
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: reader.headers,
      payload: { organizationId: owner.organizationId },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const noCsrf = { ...reader, headers: { cookie: reader.headers.cookie } };
    expect((await edit(app, noCsrf, saved)).statusCode).toBe(403);
    const edited = await edit(app, reader, saved);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await edit(app, owner, saved)).statusCode).toBe(409);
    saved = edited.json();
    const grant = await app.inject({
      method: "PATCH",
      url: `${base}/members/${reader.id}`,
      headers: owner.headers,
      payload: {
        role: "viewer",
        expectedAclVersion: accepted.aclVersion,
      },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    expect((await edit(app, reader, saved)).statusCode).toBe(403);
    expect((await save(app, reader, saved, saved.project)).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          url: `${base}/vehicle-reference`,
          headers: reader.headers,
        })
      ).statusCode,
    ).toBe(200);
  });
});

import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineIdentity,
  createRetailScenario,
  createRetailCategory,
  USER_RETAIL_SOURCE,
  validateProjectSnapshot,
  type Place,
  type Project,
  type RetailScenario,
  type Source,
} from "@urban/core";
import { buildApp } from "./app";
import { FileStore } from "./store";
import { scenarioForPublication } from "./retail-publication";
import { buildingPreset, createProject } from "@urban/models";

const place: Place = {
  id: "retail-fixture",
  name: "Retail fixture",
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
  extentLabel: "Synthetic retail study",
};
const privateSource: Source = {
  id: "private-study",
  name: "Local study",
  url: "",
  vintage: "2024",
  license: "Authorized project use only",
  kind: "user-supplied",
  description:
    "Private study demand = 1000000; do not publish this description.",
};
const pack = (publicRedistribution = false): RetailScenario => {
  const retail = createRetailScenario(place, 0),
    category = createRetailCategory("Groceries");
  retail.context = {
    ...retail.context,
    referenceYear: 2024,
    dollarYear: 2024,
    comparabilityConfirmed: true,
    disjointCategoriesConfirmed: true,
  };
  const measure = (value: number) => ({
    status: "available" as const,
    value,
    sourceId: privateSource.id,
  });
  retail.categories = [
    {
      ...category,
      code: "grocery",
      baselineDemand: measure(1000000),
      baselineSales: measure(800000),
      salesPerEstablishment: measure(500000),
      annualSalesCapacity: 200000,
      captureShare: 0.5,
      displacementShare: 0.2,
    },
  ];
  retail.sourceRights = [
    {
      sourceId: privateSource.id,
      authorizedPrivateUse: true,
      publicRedistribution,
      statement:
        "Fixture attestation for private use and separately declared public reuse.",
    },
    {
      sourceId: USER_RETAIL_SOURCE.id,
      authorizedPrivateUse: true,
      publicRedistribution,
      statement: "Authored assumptions.",
    },
  ];
  return retail;
};
const apps = new Set<FastifyInstance>(),
  dirs: string[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
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
async function account(app: FastifyInstance, name: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email: `${name}@retail.test`,
      password: "isolated long retail test password",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return {
    id: r.json().user.id,
    organizationId: r.json().organization.id,
    email: `${name}@retail.test`,
    headers: {
      cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
      "x-csrf-token": r.json().csrfToken,
    },
  };
}
type Saved = { project: Project; version: number };
async function create(
  app: FastifyInstance,
  user: Awaited<ReturnType<typeof account>>,
) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: { placeId: place.id },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<Saved>();
}
const current = (s: Saved) =>
  s.project.scenarios.find(
    (scenario) => scenario.id === s.project.activeScenarioId,
  )!;
async function edit(
  app: FastifyInstance,
  user: Awaited<ReturnType<typeof account>>,
  s: Saved,
  retail: RetailScenario | null,
  sources: Source[] = [privateSource],
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${s.project.id}/scenarios/${current(s).id}/commands`,
    headers: user.headers,
    payload: {
      expectedVersion: s.version,
      expectedRevision: current(s).revision,
      command: { type: "scenario.retail", retail, sources },
    },
  });
}
async function publish(
  app: FastifyInstance,
  user: Awaited<ReturnType<typeof account>>,
  s: Saved,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${s.project.id}/publish`,
    headers: user.headers,
    payload: {
      scenarioId: current(s).id,
      expectedRevision: current(s).revision,
    },
  });
}

describe("persisted retail category workbench", () => {
  it("retains private evidence through restart and exact records, exports it privately, and freezes explicitly public publication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "urban-retail-"));
    dirs.push(dir);
    const file = join(dir, "store.json");
    let app = await setup(file);
    const owner = await account(app, "owner");
    let saved = await create(app, owner);
    const originalBaseline = await baselineIdentity(place),
      retail = pack();
    const applied = await edit(app, owner, saved, retail);
    expect(applied.statusCode, applied.body).toBe(200);
    saved = applied.json();
    expect(saved.project.schemaVersion).toBe(6);
    expect(saved.project.scenarios[0]).not.toHaveProperty("retail");
    const blocked = await publish(app, owner, saved);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("RETAIL_PUBLICATION_RESTRICTED");
    const records = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=records&version=${saved.version}&revision=1`,
      headers: owner.headers,
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json().project.history[0].command.retail).toEqual(retail);
    expect(JSON.stringify(records.json().audit)).not.toContain(
      "snapshot.published",
    );
    const csv = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=retail-csv`,
      headers: owner.headers,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain('"80000"');
    expect(csv.body).toContain("Private study demand");
    await app.close();
    apps.delete(app);
    app = await setup(file);
    const loaded = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json().baselineIdentity).toEqual(originalBaseline);
    expect(current(loaded.json()).retail).toEqual(retail);
    await expect(
      validateProjectSnapshot({
        project: loaded.json().project,
        place: loaded.json().baseline,
        baselineIdentity: loaded.json().baselineIdentity,
      }),
    ).resolves.toBeTruthy();
    const shared = structuredClone(retail);
    shared.sourceRights.forEach((right) => (right.publicRedistribution = true));
    const changed = await edit(app, owner, saved, shared);
    expect(changed.statusCode, changed.body).toBe(200);
    saved = changed.json();
    const publication = await publish(app, owner, saved);
    expect(publication.statusCode, publication.body).toBe(201);
    const url = `/api/v1/published/${publication.json().id}`,
      before = await app.inject({ url });
    expect(before.json().scenario.retail).toEqual(shared);
    const removed = await edit(app, owner, saved, null, []);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().project.schemaVersion).toBe(6);
    expect((await app.inject({ url })).json()).toEqual(before.json());
  });
  it("rejects invalid current/history evidence, stale writes, format downgrade and CSRF without advancing state", async () => {
    const app = await setup(),
      owner = await account(app, "validation");
    let saved = await create(app, owner);
    const input = pack();
    const bad = structuredClone(input);
    bad.sourceRights[0].authorizedPrivateUse = false;
    expect((await edit(app, owner, saved, bad)).statusCode).toBe(422);
    const missing = structuredClone(input);
    missing.categories[0].baselineDemand.sourceId = "missing";
    expect((await edit(app, owner, saved, missing)).statusCode).toBe(422);
    const applied = await edit(app, owner, saved, input);
    expect(applied.statusCode, applied.body).toBe(200);
    const old = saved;
    saved = applied.json();
    expect((await edit(app, owner, old, input)).statusCode).toBe(409);
    const relabeled = await edit(app, owner, saved, input, [
      { ...privateSource, name: "Conflicting replacement source" },
    ]);
    expect(relabeled.statusCode, relabeled.body).toBe(422);
    const badHistory = structuredClone(saved.project);
    badHistory.history[0].before.retail = structuredClone(input);
    badHistory.history[0].before.retail.categories[0].baselineSales.sourceId =
      "lost-source";
    const save = (project: Project) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
        payload: { project, expectedVersion: saved.version },
      });
    expect((await save(badHistory)).statusCode).toBe(422);
    const conflictingHistory = structuredClone(saved.project);
    conflictingHistory.history[0].before.sources = [
      { ...privateSource, name: "Older source metadata under the same ID" },
    ];
    expect((await save(conflictingHistory)).statusCode).toBe(422);
    await expect(
      validateProjectSnapshot({ project: conflictingHistory, place }),
    ).rejects.toThrow(/Conflicting metadata/);
    const downgrade = structuredClone(saved.project);
    downgrade.schemaVersion = 5;
    delete downgrade.scenarios[1].retail;
    downgrade.history = [];
    downgrade.undone = [];
    downgrade.scenarios[1].revision++;
    expect((await save(downgrade)).statusCode).toBe(409);
    expect(
      (
        await edit(
          app,
          {
            ...owner,
            headers: { cookie: owner.headers.cookie } as typeof owner.headers,
          },
          saved,
          input,
        )
      ).statusCode,
    ).toBe(403);
    const loaded = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
    });
    expect(loaded.json().version).toBe(saved.version);
    expect(loaded.json().project).toEqual(saved.project);
  });
  it("rejects outside tenants and downgraded project editors while preserving private viewer export", async () => {
    const app = await setup(),
      owner = await account(app, "acl-owner"),
      other = await account(app, "acl-other");
    let saved = await create(app, owner);
    const applied = await edit(app, owner, saved, pack());
    expect(applied.statusCode).toBe(200);
    saved = applied.json();
    expect((await edit(app, other, saved, pack())).statusCode).toBe(404);
    const accepted = await acceptIdentityTestInvitation(
      app,
      owner,
      other,
      "editor",
      saved.project.id,
    );
    const switchOrg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: other.headers,
      payload: { organizationId: owner.organizationId },
    });
    expect(switchOrg.statusCode, switchOrg.body).toBe(200);
    const downgraded = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${saved.project.id}/members/${other.id}`,
      headers: owner.headers,
      payload: {
        role: "viewer",
        expectedAclVersion: accepted.aclVersion,
      },
    });
    expect(downgraded.statusCode, downgraded.body).toBe(200);
    const denied = await edit(app, other, saved, pack());
    expect(denied.statusCode).toBe(403);
    const csv = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=retail-csv`,
      headers: other.headers,
    });
    expect(csv.statusCode, csv.body).toBe(200);
  });
  it("removes discarded private source descriptions only from public copy and blocks still-referenced sources", () => {
    const project = createProject(place),
      scenario = project.scenarios[1],
      retail = pack();
    scenario.sources = [privateSource];
    const before = { ...structuredClone(scenario), retail };
    project.history = [
      {
        id: "edit",
        actor: "QA",
        at: new Date().toISOString(),
        label: "Remove retail",
        command: { type: "scenario.retail", retail: null },
        before,
        after: structuredClone(scenario),
      },
    ];
    const published = scenarioForPublication(project, place, scenario);
    expect(published.sources).toEqual([]);
    expect(scenario.sources).toEqual([privateSource]);
    const building = buildingPreset("retail", place.center);
    building.sourceId = privateSource.id;
    scenario.buildingEdits[building.id] = building;
    expect(() => scenarioForPublication(project, place, scenario)).toThrow(
      /still referenced/,
    );
    expect(() =>
      scenarioForPublication(
        project,
        { ...place, sources: [privateSource] },
        project.scenarios[1],
      ),
    ).toThrow(/frozen baseline/);
    scenario.retail = pack(true);
    expect(scenarioForPublication(project, place, scenario).sources).toEqual([
      privateSource,
    ]);
  });
  it("does not publish unreferenced private declaration text in an otherwise public pack", () => {
    const project = createProject(place),
      scenario = project.scenarios[1];
    scenario.retail = pack(true);
    scenario.retail.sourceRights.push({
      sourceId: "unused-secret",
      authorizedPrivateUse: true,
      publicRedistribution: false,
      statement: "Secret raw study amount = 999",
    });
    expect(() => scenarioForPublication(project, place, scenario)).toThrow(
      /private project use/,
    );
  });
});

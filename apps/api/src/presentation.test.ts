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
  validateProjectSnapshot,
  type Place,
  type Project,
  type ScenarioPresentation,
} from "@urban/core";
import { buildApp } from "./app";
import { FileStore } from "./store";
const place: Place = {
  id: "tour-study",
  name: "Tour fixture",
  city: "Phoenix",
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
  extentLabel: "Synthetic tour study",
};
const tour: ScenarioPresentation = {
  version: 1,
  title: "A place to gather",
  stops: [
    {
      id: "overview",
      title: "The whole area",
      callout: "An authored starting point <not verified evidence>.",
      camera: { center: [-112.07, 33.45], zoom: 14, pitch: 50, bearing: -27 },
      view: "3d",
      metricIds: ["housing.units", "future.unavailable"],
      narration: "Invite the audience to consider the tradeoffs.",
    },
    {
      id: "context",
      title: "Surrounding context",
      callout: "A viewpoint may sit outside the study boundary.",
      camera: { center: [-112.1, 33.5], zoom: 12, pitch: 0, bearing: 0 },
      view: "2d",
    },
  ],
};
type Saved = {
  project: Project;
  version: number;
  baseline: Place;
  baselineIdentity: { sha256: string };
  access: { aclVersion: number };
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
async function account(app: FastifyInstance, name: string): Promise<User> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email: `${name}@tour.test`,
      password: "a long isolated presentation password",
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    id: response.json().user.id,
    email: `${name}@tour.test`,
    organizationId: response.json().organization.id,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken,
    },
  };
}
async function create(app: FastifyInstance, user: User) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: { placeId: place.id },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Saved>();
}
const scenario = (saved: Saved) =>
  saved.project.scenarios.find((s) => s.id === saved.project.activeScenarioId)!;
async function edit(
  app: FastifyInstance,
  user: User,
  saved: Saved,
  presentation: unknown = tour,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/scenarios/${scenario(saved).id}/commands`,
    headers: user.headers,
    payload: {
      expectedVersion: saved.version,
      expectedRevision: scenario(saved).revision,
      command: { type: "scenario.presentation", presentation },
    },
  });
}
async function grant(
  app: FastifyInstance,
  owner: User,
  recipient: User,
  saved: Saved,
  role: string,
) {
  const base = `/api/v1/projects/${saved.project.id}/members`,
    roster = await app.inject({ url: base, headers: owner.headers });
  const exists = roster
    .json()
    .members.some((m: { userId: string }) => m.userId === recipient.id);
  if (!exists) {
    await acceptIdentityTestInvitation(
      app,
      owner,
      recipient,
      role,
      saved.project.id,
    );
    return app.inject({ url: base, headers: owner.headers });
  }
  const response = await app.inject({
    method: "PATCH",
    url: `${base}/${recipient.id}`,
    headers: owner.headers,
    payload: { role, expectedAclVersion: roster.json().access.aclVersion },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

describe("revision-bound saved presentation tours", () => {
  it("survives durable save/restart, complete JSON restore and public freezing without changing source or calculations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "urban-tours-"));
    dirs.push(dir);
    const file = join(dir, "store.json");
    let app = await setup(file);
    const owner = await account(app, "owner");
    let saved = await create(app, owner);
    const base = `/api/v1/projects/${saved.project.id}`,
      baseline = structuredClone(saved.project.scenarios[0]);
    expect(saved.project.schemaVersion).toBe(1);
    expect(scenario(saved)).not.toHaveProperty("presentation");
    const beforeMetrics = await app.inject({
      url: `${base}/metrics`,
      headers: owner.headers,
    });
    const edited = await edit(app, owner, saved);
    expect(edited.statusCode, edited.body).toBe(200);
    saved = edited.json();
    expect(saved.project.schemaVersion).toBe(4);
    expect(scenario(saved).presentation).toEqual(tour);
    expect(saved.project.history).toHaveLength(1);
    expect(saved.project.scenarios[0]).toEqual(baseline);
    const afterMetrics = await app.inject({
      url: `${base}/metrics`,
      headers: owner.headers,
    });
    expect(beforeMetrics.statusCode, beforeMetrics.body).toBe(200);
    expect(afterMetrics.statusCode, afterMetrics.body).toBe(200);
    const values = (response: typeof beforeMetrics) =>
      response
        .json()
        .metrics.map(
          (m: {
            id: string;
            value: number | null;
            baseline: number | null;
          }) => ({ id: m.id, value: m.value, baseline: m.baseline }),
        );
    expect(values(afterMetrics)).toEqual(values(beforeMetrics));
    const published = await app.inject({
      method: "POST",
      url: `${base}/publish`,
      headers: owner.headers,
      payload: { scenarioId: scenario(saved).id, expectedRevision: 1 },
    });
    expect(published.statusCode, published.body).toBe(201);
    const publicPath = `/api/v1/published/${published.json().id}`;
    const records = await app.inject({
      url: `${base}/exports?format=records&revision=1&version=2`,
      headers: owner.headers,
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json().project.scenarios[1].presentation).toEqual(tour);
    expect(
      records
        .json()
        .audit.some(
          (entry: { action: string }) =>
            entry.action === "scenario.presentation",
        ),
    ).toBe(true);
    const detail = await app.inject({ url: base, headers: owner.headers });
    expect(detail.json().baseline).toEqual(place);
    expect(detail.json().baselineIdentity.sha256).toBe(
      (await baselineIdentity(place)).sha256,
    );
    const restored = await validateProjectSnapshot({
      project: saved.project,
      place,
      baselineIdentity: detail.json().baselineIdentity,
    });
    expect(restored.project.scenarios[1].presentation).toEqual(tour);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: {
        project: restored.project,
        baselineHash: restored.baselineIdentity.sha256,
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().project.id).not.toBe(saved.project.id);
    expect(imported.json().project.scenarios[1].presentation).toEqual(tour);
    await app.close();
    apps.delete(app);
    app = await setup(file);
    const reopened = await app.inject({ url: base, headers: owner.headers });
    expect(reopened.json().project).toEqual(saved.project);
    const changed = structuredClone(tour);
    changed.stops[0].callout = "Later private edits";
    const changedResponse = await edit(app, owner, saved, changed);
    expect(changedResponse.statusCode, changedResponse.body).toBe(200);
    saved = changedResponse.json();
    const frozen = await app.inject(publicPath);
    expect(frozen.statusCode, frozen.body).toBe(200);
    expect(frozen.json().scenario.presentation).toEqual(tour);
    expect(frozen.json()).not.toHaveProperty("audit");
    const cleared = await edit(app, owner, saved, null);
    expect(cleared.statusCode, cleared.body).toBe(200);
    saved = cleared.json();
    expect(scenario(saved)).not.toHaveProperty("presentation");
    expect(saved.project.schemaVersion).toBe(4);
    expect(saved.project.history).toHaveLength(3);
    // The browser's reversible restore is a full save at a new content revision.
    const undo = structuredClone(saved.project),
      entry = undo.history.at(-1)!;
    undo.scenarios = undo.scenarios.map((s) =>
      s.id === entry.after.id
        ? {
            ...structuredClone(entry.before),
            revision: s.revision + 1,
            updatedAt: new Date().toISOString(),
          }
        : s,
    );
    undo.undone.push(structuredClone(entry));
    const undoSave = await app.inject({
      method: "PUT",
      url: base,
      headers: owner.headers,
      payload: { project: undo, expectedVersion: saved.version },
    });
    expect(undoSave.statusCode, undoSave.body).toBe(200);
    saved = undoSave.json();
    expect(scenario(saved).presentation).toEqual(changed);
    expect(scenario(saved).revision).toBe(4);
    expect(saved.project.schemaVersion).toBe(4);
    expect(saved.project.undone[0].command).toEqual({
      type: "scenario.presentation",
      presentation: null,
    });
    const redo = structuredClone(saved.project);
    redo.scenarios = redo.scenarios.map((s) =>
      s.id === entry.after.id
        ? {
            ...structuredClone(entry.after),
            revision: s.revision + 1,
            updatedAt: new Date().toISOString(),
          }
        : s,
    );
    redo.undone = [];
    const redoSave = await app.inject({
      method: "PUT",
      url: base,
      headers: owner.headers,
      payload: { project: redo, expectedVersion: saved.version },
    });
    expect(redoSave.statusCode, redoSave.body).toBe(200);
    saved = redoSave.json();
    expect(scenario(saved)).not.toHaveProperty("presentation");
    expect(scenario(saved).revision).toBe(5);
    expect(saved.project.scenarios[0]).toEqual(baseline);
    const downgrade = structuredClone(saved.project);
    downgrade.schemaVersion = 3;
    downgrade.history = [];
    downgrade.undone = [];
    const denied = await app.inject({
      method: "PUT",
      url: base,
      headers: owner.headers,
      payload: { project: downgrade, expectedVersion: saved.version },
    });
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json().error.code).toBe("PROJECT_VERSION_DOWNGRADE");
  });
  it("rejects invalid current/history payloads, baseline edits and unchanged-revision replacement atomically", async () => {
    const app = await setup(),
      owner = await account(app, "invalid-owner");
    let saved = await create(app, owner);
    const base = `/api/v1/projects/${saved.project.id}`;
    const bads: unknown[] = [
      { ...tour, stops: [tour.stops[0], tour.stops[0]] },
      { ...tour, version: 2 },
      {
        ...tour,
        stops: [
          { ...tour.stops[0], camera: { ...tour.stops[0].camera, pitch: 61 } },
        ],
      },
      {
        ...tour,
        stops: [
          { ...tour.stops[0], metricIds: ["housing.units", "housing.units"] },
        ],
      },
      { ...tour, stops: [{ ...tour.stops[0], id: "__proto__" }] },
      { ...tour, stops: [{ ...tour.stops[0], narration: "x".repeat(4001) }] },
      {
        ...tour,
        stops: [
          { ...tour.stops[0], audioUrl: "https://example.invalid/audio" },
        ],
      },
    ];
    for (const bad of bads) {
      const response = await edit(app, owner, saved, bad);
      expect(response.statusCode, response.body).toBe(400);
    }
    const baselineEdit = await app.inject({
      method: "POST",
      url: `${base}/scenarios/baseline/commands`,
      headers: owner.headers,
      payload: {
        expectedVersion: 1,
        expectedRevision: 0,
        command: { type: "scenario.presentation", presentation: tour },
      },
    });
    expect(baselineEdit.statusCode, baselineEdit.body).toBe(400);
    const valid = await edit(app, owner, saved);
    expect(valid.statusCode, valid.body).toBe(200);
    saved = valid.json();
    const changed = structuredClone(saved.project);
    changed.scenarios[1].presentation!.title =
      "Changed without advancing revision";
    expect(
      (
        await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: { project: changed, expectedVersion: saved.version },
        })
      ).statusCode,
    ).toBe(409);
    for (const part of ["before", "after"] as const) {
      const historical = structuredClone(saved.project);
      historical.history[0][part].presentation = {
        ...structuredClone(tour),
        stops: [
          {
            ...tour.stops[0],
            camera: { ...tour.stops[0].camera, center: [0, 86] },
          },
        ],
      };
      const denied = await app.inject({
        method: "PUT",
        url: base,
        headers: owner.headers,
        payload: { project: historical, expectedVersion: saved.version },
      });
      expect(denied.statusCode, denied.body).toBe(400);
    }
    const older = structuredClone(saved.project);
    older.schemaVersion = 3;
    const deniedFormat = await app.inject({
      method: "PUT",
      url: base,
      headers: owner.headers,
      payload: { project: older, expectedVersion: saved.version },
    });
    expect(deniedFormat.statusCode, deniedFormat.body).toBe(400);
    const after = await app.inject({ url: base, headers: owner.headers });
    expect(after.json().project).toEqual(saved.project);
    expect(after.json().version).toBe(saved.version);
  });
  it("uses existing project roles, live downgrades and CSRF for presentation commands and full saves", async () => {
    const app = await setup(),
      owner = await account(app, "sharing-owner"),
      peer = await account(app, "peer");
    let saved = await create(app, owner);
    const base = `/api/v1/projects/${saved.project.id}`;
    expect((await edit(app, peer, saved)).statusCode).toBe(404);
    expect(
      (
        await edit(
          app,
          { ...owner, headers: { cookie: owner.headers.cookie } },
          saved,
        )
      ).statusCode,
    ).toBe(403);
    await grant(app, owner, peer, saved, "commenter");
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: peer.headers,
      payload: { organizationId: owner.organizationId },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect((await edit(app, peer, saved)).statusCode).toBe(403);
    await grant(app, owner, peer, saved, "editor");
    const edited = await edit(app, peer, saved);
    expect(edited.statusCode, edited.body).toBe(200);
    saved = edited.json();
    await grant(app, owner, peer, saved, "viewer");
    expect((await edit(app, peer, saved, null)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: base,
          headers: peer.headers,
          payload: { project: saved.project, expectedVersion: saved.version },
        })
      ).statusCode,
    ).toBe(403);
    const read = await app.inject({ url: base, headers: peer.headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().project.scenarios[1].presentation).toEqual(tour);
  });
});

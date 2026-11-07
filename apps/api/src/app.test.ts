import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Place } from "@urban/core";
import { buildingPreset, createProject } from "@urban/models";
import { buildApp } from "./app.js";
import { FileStore } from "./store.js";
import { readPersistedState } from "./file-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";

const place: Place = {
  id: "test-phoenix",
  name: "Reference area",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.069, 33.459],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: [
    [-112.08, 33.45],
    [-112.06, 33.45],
    [-112.06, 33.47],
    [-112.08, 33.47],
    [-112.08, 33.45],
  ],
  buildings: [
    {
      ...buildingPreset("multifamily", [-112.069, 33.459]),
      id: "existing-building",
    },
  ],
  roads: [],
  sources: [
    {
      id: "test",
      name: "Test source",
      url: "https://example.com",
      vintage: "2026",
      license: "Fixture only",
      kind: "user-supplied",
    },
  ],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Test fixture, not observed city data",
};
const instances: FastifyInstance[] = [];
async function setup(store = new FileStore()) {
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    catalog: {
      list: async () => [place],
      get: async (id) => {
        if (id !== place.id) throw new Error("Unexpected fixture ID");
        return place;
      },
    },
  });
  instances.push(app);
  attachIdentityTestMail(app, mail);
  return app;
}
async function register(app: FastifyInstance, email = "planner@example.com") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: "correct horse battery staple",
      name: email.split("@")[0],
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    cookie: response.cookies[0].name + "=" + response.cookies[0].value,
    "x-csrf-token": response.json().csrfToken,
  };
}
async function create(app: FastifyInstance, headers: Record<string, string>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: { placeId: place.id },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}
afterEach(async () => {
  for (const app of instances.splice(0)) await app.close();
});

describe("free account and protected workspace API", () => {
  it("provides public real-data metadata but requires a session for saved projects", async () => {
    const app = await setup();
    expect(
      (await app.inject("/api/v1/places")).json().places[0].buildingCount,
    ).toBe(1);
    expect((await app.inject("/api/v1/health")).json().free).toBe(true);
    expect((await app.inject("/api/v1/projects")).statusCode).toBe(401);
    expect((await app.inject("/api/v1/auth/session")).json()).toEqual({
      user: null,
    });
  });
  it("stores password hashes, sets HttpOnly sessions, and enforces CSRF and origin", async () => {
    const store = new FileStore();
    const app = await setup(store);
    const headers = await register(app);
    const state = await store.read((s) => s);
    expect(state.users[0].passwordHash).toMatch(/^scrypt:/);
    expect(state.users[0].passwordHash).not.toContain("correct horse");
    expect(state.sessions[0].hash).not.toBe(headers.cookie.split("=")[1]);
    const session = await app.inject({ url: "/api/v1/auth/session", headers });
    expect(session.json().user.email).toBe("planner@example.com");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: { cookie: headers.cookie },
          payload: { placeId: place.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { origin: "https://untrusted.example" },
          payload: {
            email: "planner@example.com",
            password: "correct horse battery staple",
          },
        })
      ).statusCode,
    ).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "planner@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
  });
  it("isolates projects, metrics, comments, and exports across organizations", async () => {
    const app = await setup();
    const owner = await register(app);
    const outsider = await register(app, "outsider@example.com");
    const saved = await create(app, owner);
    for (const suffix of [
      "",
      "/metrics",
      "/comments",
      "/audit",
      "/exports?format=csv",
    ])
      expect(
        (
          await app.inject({
            url: `/api/v1/projects/${saved.project.id}${suffix}`,
            headers: outsider,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (await app.inject({ url: "/api/v1/projects", headers: outsider })).json()
        .projects,
    ).toHaveLength(0);
  });
  it("atomically rejects stale writes and keeps the real-world baseline immutable", async () => {
    const app = await setup();
    const headers = await register(app);
    const saved = await create(app, headers);
    const changed = { ...saved.project, name: "Updated name" };
    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${changed.id}`,
      headers,
      payload: { project: changed, expectedVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(2);
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${changed.id}`,
      headers,
      payload: {
        project: { ...changed, name: "Overwritten" },
        expectedVersion: 1,
      },
    });
    expect(stale.statusCode).toBe(409);
    const invalid = structuredClone(first.json().project);
    invalid.scenarios.find(
      (s: ScenarioLike) => s.id === "baseline",
    ).assumptions.annualWage = 7;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/projects/${changed.id}`,
          headers,
          payload: { project: invalid, expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({ url: `/api/v1/projects/${changed.id}`, headers })
      ).json().project.name,
    ).toBe("Updated name");
  });
  it("saves commands and exports the requested revision rather than a stale result", async () => {
    const app = await setup();
    const headers = await register(app);
    const saved = await create(app, headers);
    const scenario = saved.project.scenarios.find(
      (s: ScenarioLike) => s.id === saved.project.activeScenarioId,
    );
    const edit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/scenarios/${scenario.id}/commands`,
      headers,
      payload: {
        command: {
          type: "building.upsert",
          building: buildingPreset("multifamily", place.center),
        },
        expectedRevision: scenario.revision,
        expectedVersion: 1,
      },
    });
    expect(edit.statusCode).toBe(200);
    const revision = edit
      .json()
      .project.scenarios.find(
        (s: ScenarioLike) => s.id === scenario.id,
      ).revision;
    const metrics = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/metrics?scenarioId=${scenario.id}&revision=${revision}`,
      headers,
    });
    expect(metrics.json().revision).toBe(revision);
    expect(
      metrics
        .json()
        .metrics.find((m: { id: string }) => m.id === "housing.units").delta,
    ).toBeGreaterThan(0);
    const csv = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=csv&revision=${revision}`,
      headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["x-scenario-revision"]).toBe(String(revision));
    expect(csv.body).toContain("scenario_id");
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/exports?format=csv&revision=${scenario.revision}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    const geojson = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=geojson`,
      headers,
    });
    expect(geojson.json().features).toHaveLength(2);
  });
  it("produces actual PDF and DOCX documents from a settled revision", async () => {
    const app = await setup();
    const headers = await register(app);
    const saved = await create(app, headers);
    const pdf = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=pdf`,
      headers,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.rawPayload.length).toBeGreaterThan(3000);
    expect(pdf.headers["x-report-renderer"]).toBe("urban-plan-3");
    expect(pdf.headers["x-report-map-input"]).toMatch(/^[a-f0-9]{64}$/);
    expect(pdf.headers["x-report-baseline-image"]).toMatch(/^[a-f0-9]{64}$/);
    expect(pdf.headers["x-report-proposal-image"]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      pdf.rawPayload.toString("latin1").match(/\/Subtype\s*\/Image/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    const docx = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=docx`,
      headers,
    });
    expect(docx.statusCode).toBe(200);
    expect(docx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    // Separate format requests reproduce the same frozen geometry images.
    expect(docx.headers["x-report-map-input"]).toBe(
      pdf.headers["x-report-map-input"],
    );
    expect(docx.headers["x-report-baseline-image"]).toBe(
      pdf.headers["x-report-baseline-image"],
    );
    expect(docx.headers["x-report-proposal-image"]).toBe(
      pdf.headers["x-report-proposal-image"],
    );
    expect(docx.rawPayload.includes(Buffer.from("word/media/"))).toBe(true);
    const stale = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=pdf&version=${saved.version + 1}`,
      headers,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers["x-report-map-input"]).toBeUndefined();
    const xlsx = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=xlsx`,
      headers,
    });
    expect(xlsx.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(xlsx.rawPayload).buffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      "Read me",
      "Scorecard",
      "Methods",
      "Assumptions",
      "Sources",
    ]);
    expect(workbook.getWorksheet("Scorecard")!.getCell("D2").type).toBe(
      ExcelJS.ValueType.Number,
    );
    expect(workbook.getWorksheet("Read me")!.getCell("B4").value).toBe(0);
  });
  it("publishes an immutable public snapshot without internal history and revokes it", async () => {
    const app = await setup();
    const headers = await register(app);
    const saved = await create(app, headers);
    const scenario = saved.project.scenarios.find(
      (s: ScenarioLike) => s.id === saved.project.activeScenarioId,
    );
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers,
      payload: { scenarioId: scenario.id, expectedRevision: scenario.revision },
    });
    expect(published.statusCode).toBe(201);
    const id = published.json().id;
    const publicView = (await app.inject(`/api/v1/published/${id}`)).json();
    expect(publicView.scenario.revision).toBe(scenario.revision);
    expect(publicView.organizationId).toBeUndefined();
    expect(publicView.history).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/published/${id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(`/api/v1/published/${id}`)).statusCode).toBe(404);
  });
  it("enforces viewer roles even when a collaborator crafts write requests", async () => {
    const app = await setup();
    const owner = await register(app);
    const viewer = await register(app, "viewer@example.com");
    const saved = await create(app, owner);
    await acceptIdentityTestInvitation(
      app,
      { headers: owner, email: "planner@example.com" },
      { headers: viewer, email: "viewer@example.com" },
      "viewer",
      saved.project.id,
    );
    const org = (
      await app.inject({ url: "/api/v1/auth/session", headers: owner })
    ).json().organization.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/organization",
          headers: viewer,
          payload: { organizationId: org },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}`,
          headers: viewer,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/projects/${saved.project.id}`,
          headers: viewer,
          payload: { project: saved.project, expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/comments`,
          headers: viewer,
          payload: {
            text: "Attempted comment",
            scenarioId: saved.project.activeScenarioId,
          },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("validates imported coordinates and rejects geometry holes rather than discarding them", async () => {
    const app = await setup();
    const headers = await register(app);
    const feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [place.boundary] },
      properties: {
        name: "Local footprint",
        use: "office",
        height: 12,
        floors: 3,
        units: 0,
        jobs: 40,
      },
    };
    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/imports/geojson/preview",
      headers,
      payload: {
        sourceName: "City GIS",
        geojson: { type: "FeatureCollection", features: [feature] },
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().committed).toBe(false);
    expect(valid.json().buildings[0].areaSqm).toBeGreaterThan(0);
    const invalid = {
      ...feature,
      geometry: {
        type: "Polygon",
        coordinates: [place.boundary, place.boundary],
      },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers,
          payload: {
            sourceName: "City GIS",
            geojson: { type: "FeatureCollection", features: [invalid] },
          },
        })
      ).statusCode,
    ).toBe(422);
  });
  it("stages and commits a geographically checked import once with provenance and a reversible command", async () => {
    const app = await setup();
    const headers = await register(app);
    const saved = await create(app, headers);
    const scenario = saved.project.scenarios.find(
      (s: ScenarioLike) => s.id === saved.project.activeScenarioId,
    );
    const building = buildingPreset("office", place.center);
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [building.footprint] },
          properties: {
            name: "Customer office",
            use: "office",
            height: 12,
            floors: 3,
            units: 0,
            jobs: 120,
            parkingSpaces: 40,
          },
        },
      ],
    };
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/geojson/preview",
      headers,
      payload: {
        projectId: saved.project.id,
        sourceName: "Local authoritative plan",
        geojson,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().extentChecked).toBe(true);
    const importId = preview.json().importId;
    const payload = {
      scenarioId: scenario.id,
      expectedRevision: scenario.revision,
      expectedVersion: 1,
      acknowledgeWarnings: true,
    };
    const committed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/imports/${importId}/commit`,
      headers,
      payload,
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().version).toBe(2);
    const updated = committed
      .json()
      .project.scenarios.find((s: ScenarioLike) => s.id === scenario.id);
    expect(updated.sources[0].name).toBe("Local authoritative plan");
    expect(Object.values(updated.buildingEdits)).toHaveLength(1);
    expect(committed.json().project.history.at(-1).command.type).toBe(
      "buildings.import",
    );
    expect(
      Object.keys(committed.json().project.history.at(-1).before.buildingEdits),
    ).toHaveLength(0);
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/imports/${importId}/commit`,
      headers,
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyCommitted).toBe(true);
    expect(retry.json().version).toBe(2);
    const exported = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=geojson`,
        headers,
      })
    ).json();
    expect(
      exported.metadata.sources.some(
        (s: { name: string }) => s.name === "Local authoritative plan",
      ),
    ).toBe(true);
    const outside = structuredClone(geojson);
    outside.features[0].geometry.coordinates = [
      buildingPreset("office", [-110, 35]).footprint,
    ];
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers,
          payload: {
            projectId: saved.project.id,
            sourceName: "Wrong area",
            geojson: outside,
          },
        })
      ).statusCode,
    ).toBe(422);
  });
  it("keeps public feedback separate, limits voting to one current vote, and exports its history", async () => {
    const app = await setup();
    const headers = await register(app);
    const resident = await register(app, "resident@example.com");
    const saved = await create(app, headers);
    const scenario = saved.project.scenarios.find(
      (s: ScenarioLike) => s.id === saved.project.activeScenarioId,
    );
    const published = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${saved.project.id}/publish`,
        headers,
        payload: {
          scenarioId: scenario.id,
          expectedRevision: scenario.revision,
          feedbackEnabled: true,
        },
      })
    ).json();
    for (const vote of ["support", "concern"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/published/${published.id}/feedback`,
            headers: resident,
            payload: { kind: "vote", vote },
          })
        ).statusCode,
      ).toBe(201);
    const feedback = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/feedback`,
        headers,
      })
    ).json().feedback;
    expect(feedback).toHaveLength(2);
    expect(
      feedback.filter((f: { supersededAt?: string }) => !f.supersededAt),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/feedback`,
          headers: resident,
        })
      ).statusCode,
    ).toBe(404);
    const records = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=records`,
        headers,
      })
    ).json();
    expect(records.publicFeedback).toHaveLength(2);
    const publicView = (
      await app.inject(`/api/v1/published/${published.id}`)
    ).json();
    expect(publicView.place.id).toBe(place.id);
    expect(publicView.publicFeedback).toBeUndefined();
  });
  it("persists a development workspace across process restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-store-"));
    const file = join(directory, "state.json");
    try {
      const first = await setup(new FileStore(file));
      const headers = await register(first);
      const saved = await create(first, headers);
      await first.close();
      instances.splice(instances.indexOf(first), 1);
      const second = await setup(new FileStore(file));
      const loaded = await second.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers,
      });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.json().project.id).toBe(saved.project.id);
      const content = await readPersistedState(file);
      expect(
        content.audit.some(
          (a: { action: string }) => a.action === "project.created",
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
interface ScenarioLike {
  id: string;
  revision: number;
}

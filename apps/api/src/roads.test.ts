import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  materializeRoads,
  roadPreset,
  USER_ROAD_SOURCE,
  type Command,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";
import { buildApp } from "./app.js";
import { FileStore } from "./store.js";
import { buildReportMapPairSvg } from "./report-maps.js";

const observed = {
  id: "surveyed-centerlines",
  name: "Captured centerline survey",
  url: "https://example.test/streets",
  vintage: "2025",
  license: "Fixture attribution",
  kind: "observed" as const,
};
const place: Place = {
  id: "road-fixture",
  name: "Street study",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.46],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: [
    [-112.08, 33.45],
    [-112.06, 33.45],
    [-112.06, 33.47],
    [-112.08, 33.47],
    [-112.08, 33.45],
  ],
  buildings: [],
  roads: [
    {
      id: "reshape",
      name: "Surveyed street",
      coordinates: [
        [-112.075, 33.46],
        [-112.07, 33.46],
      ],
      lanes: 2,
      speedMph: 25,
      oneWay: false,
      kind: "residential",
      sourceId: observed.id,
      aadt: 1000,
    },
    {
      id: "remove",
      name: "Removed street",
      coordinates: [
        [-112.075, 33.465],
        [-112.07, 33.465],
      ],
      lanes: 1,
      speedMph: 20,
      oneWay: false,
      kind: "residential",
      sourceId: observed.id,
    },
  ],
  sources: [observed],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Fixture boundary",
};
interface Saved {
  project: Project;
  version: number;
  baseline: Place;
}
const apps = new Set<FastifyInstance>();
const directories: string[] = [];
async function setup(file?: string) {
  const app = await buildApp({
    store: new FileStore(file),
    catalog: {
      list: async () => [place],
      get: async () => structuredClone(place),
    },
  });
  apps.add(app);
  return app;
}
async function fixture(file?: string) {
  const app = await setup(file);
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: "roads@example.test",
      password: "correct horse battery staple",
      name: "Road planner",
    },
  });
  expect(registered.statusCode).toBe(201);
  const headers = {
    cookie: `${registered.cookies[0].name}=${registered.cookies[0].value}`,
    "x-csrf-token": registered.json().csrfToken,
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: { placeId: place.id },
  });
  expect(created.statusCode).toBe(201);
  return { app, headers, saved: created.json<Saved>() };
}
const active = (saved: Saved) =>
  saved.project.scenarios.find(
    (scenario) => scenario.id === saved.project.activeScenarioId,
  )!;
async function command(
  app: FastifyInstance,
  headers: Record<string, string>,
  saved: Saved,
  value: Command,
  scenarioId = saved.project.activeScenarioId,
) {
  const current = saved.project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  )!;
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/scenarios/${scenarioId}/commands`,
    headers,
    payload: {
      command: value,
      expectedVersion: saved.version,
      expectedRevision: current.revision,
    },
  });
}
afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("saved street geometry", () => {
  it("persists added, reshaped and removed streets, publishes exact revisions and exports proposal geometry with frozen baseline evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-roads-"));
    directories.push(directory);
    const file = join(directory, "state.json");
    const fixtureState = await fixture(file);
    let { app, saved } = fixtureState;
    const { headers } = fixtureState;
    const baselineBefore = structuredClone(place);
    const added = {
      ...roadPreset(
        [
          [-112.075, 33.455],
          [-112.07, 33.455],
        ],
        "Proposed street",
      ),
      id: "added",
    };
    const reshaped = {
      ...place.roads[0],
      coordinates: [
        [-112.075, 33.46],
        [-112.073, 33.461],
        [-112.07, 33.46],
      ] as [number, number][],
      geometrySourceId: USER_ROAD_SOURCE.id,
    };
    for (const edit of [
      { type: "road.upsert", road: added, source: USER_ROAD_SOURCE },
      { type: "road.upsert", road: reshaped, source: USER_ROAD_SOURCE },
      { type: "road.remove", id: "remove" },
    ] satisfies Command[]) {
      const response = await command(app, headers, saved, edit);
      expect(response.statusCode, response.body).toBe(200);
      saved = response.json<Saved>();
    }
    const scenario = active(saved);
    expect(scenario.roadEdits.remove).toBeNull();
    expect(scenario.roadEdits.reshape).toEqual(reshaped);
    expect(scenario.sources).toEqual([USER_ROAD_SOURCE]);
    expect(saved.project.history.at(-1)).toMatchObject({
      command: { type: "road.remove", id: "remove" },
      before: { revision: 2 },
      after: { roadEdits: { remove: null }, revision: 3 },
    });
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers,
      payload: {
        scenarioId: scenario.id,
        expectedRevision: scenario.revision,
        expectedVersion: saved.version,
      },
    });
    expect(published.statusCode, published.body).toBe(201);
    const publicId = published.json().id;
    await app.close();
    apps.delete(app);
    app = await setup(file);
    const reopened = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers,
    });
    expect(reopened.statusCode).toBe(200);
    saved = reopened.json<Saved>();
    expect(active(saved)).toEqual(scenario);
    expect(saved.baseline).toEqual(baselineBefore);
    const frozen = (await app.inject(`/api/v1/published/${publicId}`)).json();
    expect(frozen.place).toEqual(baselineBefore);
    expect(frozen.scenario).toEqual(scenario);
    expect(
      materializeRoads(frozen.place, frozen.scenario)
        .map((road) => road.id)
        .sort(),
    ).toEqual(["added", "reshape"]);
    const query = `scenarioId=${scenario.id}&revision=${scenario.revision}&version=${saved.version}`;
    const geojson = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=geojson&${query}`,
      headers,
    });
    expect(geojson.statusCode).toBe(200);
    const geo = geojson.json();
    expect(geo.metadata.sources).toEqual([observed, USER_ROAD_SOURCE]);
    expect(
      geo.features.map((feature: { id: string }) => feature.id).sort(),
    ).toEqual(["added", "reshape"]);
    expect(
      geo.features.find((feature: { id: string }) => feature.id === "reshape"),
    ).toMatchObject({
      geometry: { type: "LineString", coordinates: reshaped.coordinates },
      properties: {
        featureType: "road",
        scenarioRevision: scenario.revision,
        sourceId: observed.id,
        geometrySourceId: USER_ROAD_SOURCE.id,
        aadt: 1000,
      },
    });
    const metrics = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/metrics?${query}`,
        headers,
      })
    ).json();
    expect(
      metrics.metrics.find(
        (metric: { id: string }) => metric.id === "mobility.roadMiles",
      ).delta,
    ).toBeGreaterThan(0);
    const records = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=records&${query}`,
        headers,
      })
    ).json();
    expect(records.baseline.roads).toEqual(baselineBefore.roads);
    expect(records.project.history.at(-1).command).toEqual({
      type: "road.remove",
      id: "remove",
    });
    expect(
      records.audit.some(
        (entry: { action: string }) => entry.action === "road.remove",
      ),
    ).toBe(true);
    const maps = buildReportMapPairSvg({
      place: saved.baseline,
      baselineScenario: saved.project.scenarios.find(
        (s) => s.id === "baseline",
      )!,
      proposalScenario: scenario,
    });
    expect(maps.metadata.changes.roads).toEqual({
      added: 1,
      modified: 1,
      removed: 1,
    });
    expect(maps.metadata.credits).toEqual([observed, USER_ROAD_SOURCE]);
    expect(maps.proposal.alt).toContain("reference-only");
    const restored = await command(app, headers, saved, {
      type: "road.upsert",
      road: place.roads[1],
    });
    expect(restored.statusCode).toBe(200);
    expect(
      materializeRoads(saved.baseline, active(restored.json<Saved>())),
    ).toHaveLength(3);
    expect((await app.inject(`/api/v1/published/${publicId}`)).json()).toEqual(
      frozen,
    );
    const staleExport = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=geojson&${query}`,
      headers,
    });
    expect(staleExport.statusCode).toBe(409);
    expect(place).toEqual(baselineBefore);
  });

  it("rejects invalid authored paths atomically through both commands and whole-project saves", async () => {
    const { app, headers, saved } = await fixture();
    const starter = roadPreset([
      [-112.075, 33.46],
      [-112.07, 33.46],
    ]);
    const paths: Scenario["roadEdits"][string][] = [
      {
        ...starter,
        coordinates: [
          [-112.075, 33.46],
          [-112.075, 33.46],
        ],
      },
      {
        ...starter,
        coordinates: [
          [-112.079, 33.451],
          [-112.07, 33.461],
          [-112.079, 33.461],
          [-112.07, 33.451],
        ],
      },
      {
        ...starter,
        coordinates: [
          [-112.075, 33.46],
          [-112.05, 33.46],
        ],
      },
    ];
    for (const road of paths) {
      const response = await command(app, headers, saved, {
        type: "road.upsert",
        road: road!,
        source: USER_ROAD_SOURCE,
      });
      expect(response.statusCode, response.body).toBe(422);
      const project = structuredClone(saved.project);
      const scenario = project.scenarios.find(
        (s) => s.id === project.activeScenarioId,
      )!;
      scenario.roadEdits[road!.id] = road;
      scenario.revision++;
      const save = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${project.id}`,
        headers,
        payload: { project, expectedVersion: saved.version },
      });
      expect(save.statusCode, save.body).toBe(422);
    }
    const baselineEdit = await command(
      app,
      headers,
      saved,
      { type: "road.remove", id: "remove" },
      "baseline",
    );
    expect(baselineEdit.statusCode).toBe(400);
    expect(baselineEdit.json().error.code).toBe("BASELINE_IMMUTABLE");
    const reopened = (
      await app.inject({ url: `/api/v1/projects/${saved.project.id}`, headers })
    ).json<Saved>();
    expect(reopened.version).toBe(1);
    expect(reopened.project).toEqual(saved.project);
    expect(reopened.baseline.roads).toEqual(place.roads);
  });

  it("persists road undo/redo and abandons redo only in the scenario receiving a new command", async () => {
    const { app, headers, saved: initial } = await fixture();
    let saved = initial;
    const firstScenarioId = saved.project.activeScenarioId;
    const removed = await command(app, headers, saved, {
      type: "road.remove",
      id: "remove",
    });
    expect(removed.statusCode).toBe(200);
    saved = removed.json<Saved>();
    const firstEntry = saved.project.history.at(-1)!;
    const branch = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/scenarios`,
      headers,
      payload: {
        name: "Independent option",
        parentId: "baseline",
        expectedVersion: saved.version,
      },
    });
    expect(branch.statusCode).toBe(200);
    saved = branch.json<Saved>();
    const secondScenarioId = saved.project.activeScenarioId;
    saved = (
      await command(app, headers, saved, { type: "road.remove", id: "reshape" })
    ).json<Saved>();
    const secondEntry = saved.project.history.at(-1)!;
    const undo = structuredClone(saved.project);
    undo.undone = [firstEntry, secondEntry];
    undo.scenarios = undo.scenarios.map((scenario) => {
      const entry = [firstEntry, secondEntry].find(
        (item) => item.after.id === scenario.id,
      );
      return entry
        ? {
            ...entry.before,
            revision: scenario.revision + 1,
            updatedAt: new Date().toISOString(),
          }
        : scenario;
    });
    undo.activeScenarioId = firstScenarioId;
    const saveUndo = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers,
      payload: { project: undo, expectedVersion: saved.version },
    });
    expect(saveUndo.statusCode, saveUndo.body).toBe(200);
    saved = saveUndo.json<Saved>();
    expect(materializeRoads(place, active(saved))).toEqual(place.roads);
    // Redo advances the revision while restoring the exact prior road tombstone.
    const redo = structuredClone(saved.project);
    redo.scenarios = redo.scenarios.map((scenario) =>
      scenario.id === firstScenarioId
        ? {
            ...firstEntry.after,
            revision: scenario.revision + 1,
            updatedAt: new Date().toISOString(),
          }
        : scenario,
    );
    redo.undone = [secondEntry];
    const saveRedo = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers,
      payload: { project: redo, expectedVersion: saved.version },
    });
    expect(saveRedo.statusCode, saveRedo.body).toBe(200);
    saved = saveRedo.json<Saved>();
    expect(
      materializeRoads(place, active(saved)).map((road) => road.id),
    ).toEqual(["reshape"]);
    const undoAgain = structuredClone(saved.project);
    undoAgain.scenarios = undoAgain.scenarios.map((scenario) =>
      scenario.id === firstScenarioId
        ? {
            ...firstEntry.before,
            revision: scenario.revision + 1,
            updatedAt: new Date().toISOString(),
          }
        : scenario,
    );
    undoAgain.undone = [firstEntry, secondEntry];
    saved = (
      await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers,
        payload: { project: undoAgain, expectedVersion: saved.version },
      })
    ).json<Saved>();
    const after = await command(app, headers, saved, {
      type: "road.upsert",
      road: { ...place.roads[0], bikeLane: true },
    });
    expect(after.statusCode, after.body).toBe(200);
    const next = after.json<Saved>();
    expect(next.project.undone.map((entry) => entry.id)).toEqual([
      secondEntry.id,
    ]);
    expect(
      next.project.history.find((entry) => entry.id === firstEntry.id)
        ?.superseded,
    ).toBe(true);
    expect(
      next.project.history.find((entry) => entry.id === secondEntry.id)
        ?.superseded,
    ).toBeUndefined();
    expect(
      next.project.scenarios.find(
        (scenario) => scenario.id === secondScenarioId,
      )?.roadEdits,
    ).toEqual({});
    expect(
      materializeRoads(place, active(next)).map((road) => road.id),
    ).toEqual(["reshape", "remove"]);
    const reopened = (
      await app.inject({ url: `/api/v1/projects/${next.project.id}`, headers })
    ).json<Saved>();
    expect(reopened.project).toEqual(next.project);
  });
});

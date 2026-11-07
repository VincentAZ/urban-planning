import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { baselineIdentity, type Place } from "@urban/core";
import { buildingPreset, calculateImpact, createProject } from "@urban/models";
import { archivePlace } from "../../../scripts/snapshot-archive";
import { buildApp } from "./app";
import { PlaceCatalog } from "./places";
import { FileStore } from "./store";

const a: Place = {
  id: "source-a",
  name: "Captured reference",
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
  buildings: [
    { ...buildingPreset("multifamily", [-112.07, 33.45]), id: "existing" },
  ],
  roads: [],
  sources: [
    {
      id: "old-source",
      name: "Original source",
      url: "https://example.test",
      vintage: "2020",
      license: "Test",
      kind: "observed",
    },
  ],
  coverage: [],
  loadedAt: "2020-01-01",
  extentLabel: "Synthetic baseline integrity fixture",
};
const instances: FastifyInstance[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const app of instances.splice(0)) await app.close();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "urban-baselines-"));
  directories.push(directory);
  const archive = await archivePlace(a, directory);
  const b = structuredClone(a);
  b.buildings[0].units = 999;
  b.loadedAt = "2030-01-01";
  b.sources[0].vintage = "2030";
  await writeFile(join(directory, "current.json"), JSON.stringify(b));
  const store = new FileStore(),
    catalog = new PlaceCatalog(directory),
    app = await buildApp({ store, catalog });
  instances.push(app);
  const register = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: "snapshot@example.test",
      name: "Snapshot test",
      password: "a long test-only password",
    },
  });
  const headers = {
    cookie: `${register.cookies[0].name}=${register.cookies[0].value}`,
    "x-csrf-token": register.json().csrfToken,
  };
  return { directory, archive, b, app, catalog, headers, store };
}
describe("immutable source snapshots across catalog refresh", () => {
  it("resolves archived A for the first save after refresh to B, reopens A, and keeps lists light", async () => {
    const { app, headers, archive, b } = await setup();
    const project = createProject(a);
    const save = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { project, baselineHash: archive.identity.sha256 },
    });
    expect(save.statusCode).toBe(201);
    project.id = save.json().project.id;
    const detail = (
      await app.inject({ url: `/api/v1/projects/${project.id}`, headers })
    ).json();
    expect(detail.baseline).toEqual(a);
    expect(detail.baselineIdentity).toEqual(archive.identity);
    const metrics = (
      await app.inject({
        url: `/api/v1/projects/${project.id}/metrics`,
        headers,
      })
    ).json();
    expect(
      metrics.metrics.find((m: { id: string }) => m.id === "housing.units")
        .value,
    ).toBe(48);
    expect(
      calculateImpact(b, project.scenarios[1]).metrics.find(
        (m) => m.id === "housing.units",
      )?.value,
    ).toBe(999);
    const summary = (
      await app.inject({ url: "/api/v1/projects", headers })
    ).json().projects[0];
    expect(summary.project.scenarioCount).toBe(2);
    expect(summary.project.scenarios).toBeUndefined();
    expect(summary.baseline).toBeUndefined();
    const snapshot = (
      await app.inject(
        `/api/v1/places/${a.id}/snapshots/${archive.identity.sha256}`,
      )
    ).json();
    expect(snapshot.place).toEqual(a);
    const fresh = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { placeId: a.id },
    });
    const freshDetail = (
      await app.inject({
        url: `/api/v1/projects/${fresh.json().project.id}`,
        headers,
      })
    ).json();
    expect(freshDetail.baseline).toEqual(b);
  });
  it("rejects missing or unknown draft hashes and a mismatched baseline on save", async () => {
    const { app, headers, archive, b } = await setup();
    const project = createProject(a);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { project },
    });
    expect(missing.json().error.code).toBe("BASELINE_REQUIRED");
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { project, baselineHash: "0".repeat(64) },
    });
    expect(unknown.statusCode).toBe(409);
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { project, baselineHash: archive.identity.sha256 },
    });
    expect(saved.statusCode).toBe(201);
    project.id = saved.json().project.id;
    const mismatch = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}`,
      headers,
      payload: {
        project,
        expectedVersion: 1,
        baselineHash: (await baselineIdentity(b)).sha256,
      },
    });
    expect(mismatch.json().error.code).toBe("BASELINE_MISMATCH");
    expect(
      (
        await app.inject({ url: `/api/v1/projects/${project.id}`, headers })
      ).json().version,
    ).toBe(1);
  });
  it("returns the original baseline for legacy stored projects that had no hash field", async () => {
    const { app, headers, store } = await setup();
    const project = createProject(a);
    await store.transaction((state) => {
      state.projects.push({
        organizationId: state.organizations[0].id,
        createdBy: state.users[0].id,
        createdAt: "2020-01-01",
        project,
        version: 7,
        baseline: structuredClone(a),
      });
    });
    const detail = (
      await app.inject({ url: `/api/v1/projects/${project.id}`, headers })
    ).json();
    expect(detail.baseline).toEqual(a);
    expect(detail.baselineIdentity).toEqual(await baselineIdentity(a));
    expect(detail.version).toBe(7);
  });
  it("never overwrites an archive and rejects corrupted content under a valid hash", async () => {
    const { directory, archive, catalog } = await setup();
    const file = join(
      directory,
      "snapshots",
      `${archive.identity.sha256}.json`,
    );
    const original = await readFile(file, "utf8");
    await archivePlace(a, directory);
    expect(await readFile(file, "utf8")).toBe(original);
    const changed = structuredClone(a);
    expect(changed.buildings[0].units).not.toBeNull();
    changed.buildings[0].units = changed.buildings[0].units! + 1;
    await writeFile(file, JSON.stringify(changed));
    await expect(
      catalog.getSnapshot(a.id, archive.identity.sha256),
    ).rejects.toThrow("does not match");
    await expect(archivePlace(a, directory)).rejects.toThrow("corrupt");
  });
});

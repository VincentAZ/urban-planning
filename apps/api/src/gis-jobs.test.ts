import { recordBudgetAdjustment } from "./budget.js";
import {
  enableReviewedBudgetForFixture,
  reviewBudgetForFixture,
} from "./budget-test-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { Project } from "@urban/core";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { FileStore } from "./store.js";
import { buildApp } from "./app.js";
import { GisJobService } from "./gis-jobs.js";
import { FixtureGisRuntime } from "./gis-jobs-fixture.js";
import type {
  GisJob,
  GisPreview,
  GisPreviewRequest,
} from "./gis-jobs-types.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const geojson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "local-1",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-112.001, 32.999],
            [-111.999, 32.999],
            [-111.999, 33.001],
            [-112.001, 33.001],
            [-112.001, 32.999],
          ],
        ],
      },
      properties: { name: "Local office", height: 0 },
    },
  ],
};
async function account(app: FastifyInstance, name: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${name}@gis.example.test`,
      name,
      password: "synthetic GIS test long password",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return {
    id: r.json().user.id,
    organizationId: r.json().organization.id,
    headers: {
      cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
      "x-csrf-token": r.json().csrfToken as string,
    },
  };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gis-jobs-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"),
    store = new FileStore(file),
    runtime = new FixtureGisRuntime();
  await store.transaction((s) => {
    enableReviewedBudgetForFixture(s.budget);
  });
  const service = new GisJobService(store, {
    enabled: true,
    runtime,
    archiveDirectory: join(dir, "archive"),
    automaticWorker: false,
    capacity: {
      mode: "fixed-capacity",
      environment: "local-development",
      statement:
        "Existing isolated synthetic GIS test capacity; no production cost claim.",
    },
  });
  const app = await buildApp({
    store,
    gisService: service,
    nationalPreparationEnabled: false,
    catalog: {
      list: async () => [workforcePlaceFixture],
      get: async () => structuredClone(workforcePlaceFixture),
    },
  });
  cleanup.push(() => app.close());
  const owner = await account(app, "owner");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: workforcePlaceFixture.id },
  });
  expect(created.statusCode, created.body).toBe(201);
  const saved = created.json<{ project: Project; version: number }>(),
    base = `/api/v1/projects/${saved.project.id}`,
    imports = `${base}/imports`;
  const input = {
    scenarioId: saved.project.activeScenarioId,
    expectedVersion: saved.version,
    expectedRevision: 0,
    idempotencyKey: "gis-upload-request-1",
  };
  const recipe: GisPreviewRequest = {
    ...input,
    idempotencyKey: "gis-preview-request-1",
    conversion: { layerId: "fixture", sourceCrs: { kind: "file" } },
    mapping: {
      layer: "buildings",
      target: { mode: "append" },
      use: { kind: "constant", value: "office" },
      quantities: { height: { kind: "field", field: "height" } },
      name: { kind: "field", field: "name" },
    },
    source: {
      name: "Synthetic local GIS",
      license: "Private test data",
      privateUseConfirmed: true,
      publicRedistribution: false,
    },
  };
  return {
    dir,
    file,
    store,
    runtime,
    service,
    app,
    owner,
    saved,
    base,
    imports,
    input,
    recipe,
  };
}
type Context = Awaited<ReturnType<typeof setup>>;
function multipart(metadata: unknown, file = geojson) {
  const boundary = "urban-gis-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="local.geojson"\r\nContent-Type: application/geo+json\r\n\r\n${JSON.stringify(file)}\r\n--${boundary}--\r\n`,
    ),
  };
}
async function upload(c: Context) {
  const form = multipart(c.input),
    r = await c.app.inject({
      method: "POST",
      url: `${c.imports}/uploads`,
      payload: form.payload,
      headers: { ...c.owner.headers, ...form.headers },
    });
  expect(r.statusCode, r.body).toBe(202);
  return r.json<{ job: GisJob }>().job;
}
async function job(c: Context, id: string) {
  const r = await c.app.inject({
    url: `${c.imports}/jobs/${id}`,
    headers: c.owner.headers,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ job: GisJob }>().job;
}
async function prepare(c: Context) {
  const inspected = await upload(c);
  await c.service.runOne();
  expect((await job(c, inspected.id)).status).toBe("completed");
  const r = await c.app.inject({
    method: "POST",
    url: `${c.imports}/uploads/${inspected.id}/preview`,
    headers: c.owner.headers,
    payload: c.recipe,
  });
  expect(r.statusCode, r.body).toBe(202);
  const queued = r.json<{ job: GisJob }>().job;
  await c.service.runOne();
  const finished = await job(c, queued.id);
  expect(finished.status, JSON.stringify(finished)).toBe("completed");
  const p = await c.app.inject({
    url: `${c.imports}/jobs/${queued.id}/preview`,
    headers: c.owner.headers,
  });
  expect(p.statusCode, p.body).toBe(200);
  return p.json<GisPreview>();
}
const commit = (c: Context, p: GisPreview, overrides = {}) =>
  c.app.inject({
    method: "POST",
    url: `${c.imports}/${p.importId}/commit`,
    headers: c.owner.headers,
    payload: {
      scenarioId: p.scenarioId,
      expectedVersion: p.expectedVersion,
      expectedRevision: p.expectedRevision,
      previewHash: p.previewHash,
      acknowledgeWarnings: true,
      ...overrides,
    },
  });
describe("durable private GIS processing", () => {
  it("rejects stale, pending and conflicting admissions without retaining unreferenced upload bytes", async () => {
    const c = await setup();
    const files = async () =>
      (await readdir(join(c.dir, "archive")).catch(() => [])).sort();
    const send = async (metadata: unknown, value = geojson) => {
      const form = multipart(metadata, value);
      return c.app.inject({
        method: "POST",
        url: `${c.imports}/uploads`,
        headers: { ...c.owner.headers, ...form.headers },
        payload: form.payload,
      });
    };
    const stale = await send({ ...c.input, expectedVersion: 999 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await files()).toEqual([]);
    await upload(c);
    const retained = await files();
    expect(retained).toHaveLength(1);
    const pending = await send({
      ...c.input,
      idempotencyKey: "second-pending-request",
    });
    expect(pending.statusCode, pending.body).toBe(429);
    expect(await files()).toEqual(retained);
    const different = {
      ...geojson,
      features: [
        {
          ...geojson.features[0],
          properties: {
            ...geojson.features[0].properties,
            name: "Conflicting upload body",
          },
        },
      ],
    };
    const conflict = await send(c.input, different);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(await files()).toEqual(retained);
    const exported = await c.app.inject({
      method: "POST",
      url: `${c.imports}/exports/shapefile`,
      headers: c.owner.headers,
      payload: { ...c.input, idempotencyKey: "pending-export-request" },
    });
    expect(exported.statusCode, exported.body).toBe(429);
    expect(await files()).toEqual(retained);
  });
  it("rolls back a newly received source if the project changes during upload, but retains an uncertain committed admission", async () => {
    const c = await setup(),
      receive = c.service.archive.receiveTemporary.bind(c.service.archive);
    const change = vi
      .spyOn(c.service.archive, "receiveTemporary")
      .mockImplementationOnce(async (...args) => {
        const staged = await receive(...args);
        await c.store.transaction((s) => {
          s.projects[0].version++;
        });
        return staged;
      });
    const form = multipart(c.input),
      rejected = await c.app.inject({
        method: "POST",
        url: `${c.imports}/uploads`,
        headers: { ...c.owner.headers, ...form.headers },
        payload: form.payload,
      });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(await readdir(join(c.dir, "archive"))).toEqual([]);
    change.mockRestore();
    c.input.expectedVersion = 2;
    const enqueue = c.service.enqueue.bind(c.service);
    vi.spyOn(c.service, "enqueue").mockImplementationOnce(async (...args) => {
      await enqueue(...args);
      throw new Error("Synthetic lost admission acknowledgment");
    });
    const retryForm = multipart(c.input),
      uncertain = await c.app.inject({
        method: "POST",
        url: `${c.imports}/uploads`,
        headers: { ...c.owner.headers, ...retryForm.headers },
        payload: retryForm.payload,
      });
    expect(uncertain.statusCode).toBe(500);
    expect(await readdir(join(c.dir, "archive"))).toHaveLength(1);
    const retained = await c.store.read((s) => s.gisJobs[0]);
    await expect(
      c.service.archive.path(
        retained.organizationId,
        retained.projectId,
        retained.upload!,
      ),
    ).resolves.toBeTruthy();
    await c.service.runOne();
    expect((await job(c, retained.id)).status).toBe("completed");
  });
  it("streams and inspects a real multipart upload, binds exact preview, applies once, and retains unknown values", async () => {
    const c = await setup(),
      preview = await prepare(c);
    expect(preview.source.rights?.publicRedistribution).toBe(false);
    expect(preview.layer === "buildings" && preview.buildings[0]).toMatchObject(
      { height: 0, floors: null, units: null, jobs: null, parkingSpaces: null },
    );
    const wrong = await commit(c, preview, { previewHash: "b".repeat(64) });
    expect(wrong.statusCode).toBe(409);
    const applied = await commit(c, preview);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().project.schemaVersion).toBe(8);
    expect(applied.json().project.history).toHaveLength(1);
    expect(applied.json().version).toBe(2);
    const again = await commit(c, preview);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().alreadyCommitted).toBe(true);
    expect(again.json().project.history).toHaveLength(1);
    const published = await c.app.inject({
      method: "POST",
      url: `${c.base}/publish`,
      headers: c.owner.headers,
      payload: {
        scenarioId: preview.scenarioId,
        expectedVersion: 2,
        expectedRevision: 1,
      },
    });
    expect(published.statusCode, published.body).toBe(422);
    expect(published.json().error.code).toBe("SOURCE_PUBLICATION_RESTRICTED");
    const raw = await c.app.inject({
      url: `${c.imports}/uploads/${preview.uploadId}/file`,
      headers: c.owner.headers,
    });
    expect(raw.statusCode).toBe(200);
    expect(JSON.parse(raw.body)).toEqual(geojson);
  });
  it("deduplicates uncertain upload requests and keeps inspection/project identity private", async () => {
    const c = await setup(),
      first = await upload(c),
      again = await upload(c);
    expect(again.id).toBe(first.id);
    expect(c.runtime.calls).toBe(0);
    const list = await c.app.inject({
      url: `${c.imports}/jobs`,
      headers: c.owner.headers,
    });
    expect(list.json().jobs).toHaveLength(1);
    expect(list.body).not.toContain("requestHash");
    expect(list.body).not.toContain(c.owner.id);
    const other = await account(c.app, "other");
    for (const path of [
      `${c.imports}/jobs/${first.id}`,
      `${c.imports}/uploads/${first.id}`,
      `${c.imports}/uploads/${first.id}/file`,
    ]) {
      const r = await c.app.inject({ url: path, headers: other.headers });
      expect([403, 404]).toContain(r.statusCode);
    }
    const form = multipart({ ...c.input, idempotencyKey: "guest-upload" });
    const guest = await c.app.inject({
      method: "POST",
      url: `${c.imports}/uploads`,
      ...form,
    });
    expect(guest.statusCode).toBe(401);
    const changed = multipart(c.input, { ...geojson, features: [] });
    const conflict = await c.app.inject({
      method: "POST",
      url: `${c.imports}/uploads`,
      payload: changed.payload,
      headers: { ...c.owner.headers, ...changed.headers },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
  });
  it("rejects stale and corrupted prepared previews without applying any features", async () => {
    const c = await setup(),
      p = await prepare(c);
    await c.store.transaction((s) => {
      s.projects[0].version++;
    });
    const stale = await commit(c, p);
    expect(stale.statusCode).toBe(409);
    expect(
      await c.store.read((s) => s.projects[0].project.history.length),
    ).toBe(0);
    await expect(
      c.store.transaction((s) => {
        const item = s.imports[0];
        if ("buildings" in item) item.buildings[0].name = "Tampered";
      }),
    ).rejects.toThrow(/immutable|preview|staged/i);
    const preserved = await c.app.inject({
      url: `${c.imports}/jobs/${p.jobId}/preview`,
      headers: c.owner.headers,
    });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().previewHash).toBe(p.previewHash);
  });
  it("pauses queued work under the admin budget and preserves attempt accounting on explicit retry", async () => {
    const c = await setup(),
      queued = await upload(c);
    await c.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await c.service.runOne();
    expect((await job(c, queued.id)).attempt).toBe(0);
    expect(c.runtime.calls).toBe(0);
    await c.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
    });
    c.runtime.fail = true;
    await c.service.runOne();
    let failed = await job(c, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.attempt).toBe(1);
    c.runtime.fail = false;
    const retryInput = {
        expectedJobVersion: failed.version,
        idempotencyKey: "retry-gis-request",
      },
      retry = await c.app.inject({
        method: "POST",
        url: `${c.imports}/jobs/${failed.id}/retry`,
        headers: c.owner.headers,
        payload: retryInput,
      });
    expect(retry.statusCode, retry.body).toBe(200);
    await c.service.runOne();
    failed = await job(c, queued.id);
    expect(failed.status).toBe("completed");
    expect(failed.attempts.map((a) => a.outcome)).toEqual([
      "failed",
      "completed",
    ]);
    const duplicate = await c.app.inject({
      method: "POST",
      url: `${c.imports}/jobs/${failed.id}/retry`,
      headers: c.owner.headers,
      payload: retryInput,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().job.attempt).toBe(2);
  });
  it("cancels a queued job without consuming an attempt and prevents partial staged layers", async () => {
    const c = await setup(),
      queued = await upload(c);
    const cancelled = await c.app.inject({
      method: "POST",
      url: `${c.imports}/jobs/${queued.id}/cancel`,
      headers: c.owner.headers,
      payload: { expectedJobVersion: queued.version },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await c.service.runOne();
    expect(c.runtime.calls).toBe(0);
    expect(await c.store.read((s) => s.imports.length)).toBe(0);
    expect((await job(c, queued.id)).status).toBe("cancelled");
  });
  it("cancels an active attempt, retains consumed time, and permits an explicit retry", async () => {
    const c = await setup(),
      queued = await upload(c);
    let release!: () => void;
    c.runtime.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = c.service.runOne();
    for (let i = 0; c.runtime.calls === 0 && i < 100; i++) await delay(10);
    expect(c.runtime.calls).toBe(1);
    const active = await job(c, queued.id),
      cancelled = await c.app.inject({
        method: "POST",
        url: `${c.imports}/jobs/${queued.id}/cancel`,
        headers: c.owner.headers,
        payload: { expectedJobVersion: active.version },
      });
    expect(cancelled.statusCode).toBe(200);
    await running;
    release();
    c.runtime.gate = undefined;
    const stopped = await job(c, queued.id);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.attempt).toBe(1);
    expect(stopped.attempts[0].outcome).toBe("cancelled");
    expect(stopped.attempts[0].elapsedMilliseconds).toBeGreaterThan(0);
    expect(await c.store.read((s) => s.imports.length)).toBe(0);
    const retry = await c.app.inject({
      method: "POST",
      url: `${c.imports}/jobs/${queued.id}/retry`,
      headers: c.owner.headers,
      payload: {
        expectedJobVersion: stopped.version,
        idempotencyKey: "active-cancel-retry",
      },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    await c.service.runOne();
    expect((await job(c, queued.id)).attempt).toBe(2);
  });
  it("reopens queued jobs from a fresh storage connection and prevents a revoked requester from starting", async () => {
    const c = await setup(),
      queued = await upload(c),
      reopened = new FileStore(c.file);
    cleanup.push(() => reopened.close());
    const second = new GisJobService(reopened, {
      ...c.service.options,
      runtime: c.runtime,
    });
    cleanup.push(() => second.close());
    await second.runOne();
    expect((await job(c, queued.id)).status).toBe("completed");
    expect(c.runtime.calls).toBe(1);
    c.input.idempotencyKey = "revoked-second-upload";
    const later = await upload(c);
    await c.store.transaction((s) => {
      s.memberships = s.memberships.filter((m) => m.userId !== c.owner.id);
    });
    await second.runOne();
    const failed = await reopened.read((s) =>
      s.gisJobs.find((j) => j.id === later.id),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.error?.code).toBe("GIS_REQUESTER_REVOKED");
    expect(c.runtime.calls).toBe(1);
  });
  it("archives a frozen export and checks access again before downloading", async () => {
    const c = await setup(),
      p = await prepare(c);
    await commit(c, p);
    const r = await c.app.inject({
      method: "POST",
      url: `${c.imports}/exports/shapefile`,
      headers: c.owner.headers,
      payload: {
        ...c.input,
        expectedVersion: 2,
        expectedRevision: 1,
        idempotencyKey: "export-gis-request",
      },
    });
    expect(r.statusCode, r.body).toBe(202);
    const queued = r.json().job as GisJob;
    await c.store.transaction((s) => {
      s.projects[0].project.name = "Changed after queue";
      s.projects[0].version++;
    });
    await c.service.runOne();
    const result = await job(c, queued.id);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const download = await c.app.inject({
      url: `${c.imports}/jobs/${result.id}/download`,
      headers: c.owner.headers,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers.etag).toBe(`"${result.result?.downloadHash}"`);
    expect(JSON.parse(download.body).manifest.projectVersion).toBe(2);
    expect(
      JSON.parse(download.body).layers[0].geojson.features[0].properties.jobs,
    ).toBeNull();
    await c.store.transaction((s) => {
      s.memberships = s.memberships.filter((m) => m.userId !== c.owner.id);
    });
    const revoked = await c.app.inject({
      url: `${c.imports}/jobs/${result.id}/download`,
      headers: c.owner.headers,
    });
    expect([401, 403, 404]).toContain(revoked.statusCode);
  });
  it("detects changed private source bytes and never passes them to the converter", async () => {
    const c = await setup(),
      queued = await upload(c),
      record = await c.store.read((s) => s.gisJobs[0]);
    const path = await c.service.archive.path(
      record.organizationId,
      record.projectId,
      record.upload!,
    );
    const bytes = await readFile(path);
    bytes[0] = 32;
    await writeFile(path, bytes);
    await c.service.runOne();
    const failed = await job(c, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("GIS_ARCHIVE_UNAVAILABLE");
    expect(c.runtime.calls).toBe(0);
  });
});

describe("cost evidence before native dispatch", () => {
  it("keeps queued work idle after a manual cost change until an explicit fresh review", async () => {
    const f = await setup();
    await upload(f);
    await f.store.transaction((s) =>
      recordBudgetAdjustment(
        s.budget,
        {
          idempotencyKey: "unreviewed-fixture-charge",
          amountCents: 100,
          category: "variable",
          reason: "New external fixture cost requires an explicit cost review",
        },
        "fixture-budget-admin",
      ),
    );
    await f.service.runOne();
    expect(f.runtime.calls).toBe(0);
    expect(
      await f.store.read((s) => ({
        status: s.gisJobs[0].status,
        attempt: s.gisJobs[0].attempt,
        slot: s.nativeCapacity.slot,
      })),
    ).toEqual({ status: "queued", attempt: 0, slot: null });
    await f.store.transaction((s) => reviewBudgetForFixture(s.budget));
    await f.service.runOne();
    expect(f.runtime.calls).toBe(1);
  });
});

import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./store.js";
import { buildApp } from "./app.js";
import { MediaJobService } from "./media-jobs.js";
import { FixtureMediaExecutor } from "./media-test-fixture.js";
import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { workforcePlaceFixture as place } from "../../../tests/fixtures/workforce.js";
import { ApiError } from "./errors.js";
import { seedMediaHistoryFixture } from "./media-history-fixture.js";
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "media-jobs-"));
  clean.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStore(join(directory, "state.json"));
  await store.transaction((s) => enableReviewedBudgetForFixture(s.budget));
  const executor = new FixtureMediaExecutor();
  const service = new MediaJobService(store, {
    enabled: true,
    executor,
    archiveDirectory: join(directory, "archive"),
    automaticWorker: false,
    capacity: {
      mode: "fixed-capacity",
      environment: "local-development",
      statement: "Explicit isolated synthetic test capacity.",
    },
  });
  const app = await buildApp({
    store,
    mediaService: service,
    nationalPreparationEnabled: false,
    catalog: { list: async () => [place], get: async () => place },
  });
  clean.push(() => app.close());
  const register = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: "media@example.test",
      name: "Media owner",
      password: "isolated media test password",
    },
  });
  expect(register.statusCode, register.body).toBe(201);
  const headers = {
    cookie: `${register.cookies[0].name}=${register.cookies[0].value}`,
    "x-csrf-token": register.json().csrfToken,
  };
  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: { placeId: place.id },
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const project = saved.json().project,
    base = `/api/v1/projects/${project.id}/media`;
  const context = await app.inject({
    url: `${base}/context?scenarioId=${project.activeScenarioId}`,
    headers,
  });
  expect(context.statusCode, context.body).toBe(200);
  const c = context.json();
  const input = {
    scenarioId: project.activeScenarioId,
    expectedVersion: 1,
    expectedRevision: 0,
    sceneHash: c.sceneHash,
    recipe: c.defaultRecipe,
    idempotencyKey: "media-request-first",
  };
  return {
    store,
    executor,
    service,
    app,
    headers,
    project,
    base,
    input,
    directory,
    context: c,
  };
}
async function enqueue(f: Awaited<ReturnType<typeof setup>>) {
  const r = await f.app.inject({
    method: "POST",
    url: `${f.base}/jobs`,
    headers: f.headers,
    payload: f.input,
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().job;
}
describe("private durable media exports", () => {
  it("supports isolated historical metadata pagination without fabricating extra native executions", async () => {
    const f = await setup();
    const job = await enqueue(f);
    await f.service.runOne();
    await seedMediaHistoryFixture(f.store, job.id);
    const first = await f.app.inject({
      url: `${f.base}/jobs?scenarioId=${job.scenarioId}`,
      headers: f.headers,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().jobs).toHaveLength(100);
    const second = await f.app.inject({
      url: `${f.base}/jobs?scenarioId=${job.scenarioId}&cursor=${first.json().nextCursor}`,
      headers: f.headers,
    });
    expect(second.json().jobs).toHaveLength(6);
    expect(second.json().nextCursor).toBeNull();
    const older = second.json().jobs[0];
    const download = await f.app.inject({
      url: `${f.base}/jobs/${older.id}/artifacts/output.png`,
      headers: f.headers,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers["x-content-sha256"]).toBe(
      older.result.files.find((x: { name: string }) => x.name === "output.png")
        .sha256,
    );
    expect(f.executor.calls).toBe(1);
  });
  it("pages all retained scenario exports with stable timestamp ties and rechecks access on every page", async () => {
    const f = await setup();
    await enqueue(f);
    const secondScenario = f.project.scenarios.find(
      (s: { id: string }) => s.id !== f.project.activeScenarioId,
    )!.id;
    const ids = await f.store.transaction((s) => {
      const original = s.mediaJobs[0];
      s.mediaJobs = Array.from({ length: 113 }, (_, index) => ({
        ...structuredClone(original),
        id:
          index === 0
            ? original.id
            : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        scenarioId: index < 103 ? f.project.activeScenarioId : secondScenario,
        status: "cancelled" as const,
        cancelRequested: true,
        idempotencyKey: `history-fixture-${index}`,
        requestKeys: [`history-fixture-${index}`],
        createdAt: "2026-11-06T00:00:00.000Z",
      }));
      return s.mediaJobs
        .slice(0, 103)
        .map((j) => j.id)
        .sort()
        .reverse();
    });
    const q = `?scenarioId=${f.project.activeScenarioId}`;
    const first = await f.app.inject({
      url: `${f.base}/jobs${q}`,
      headers: f.headers,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().jobs.map((j: { id: string }) => j.id)).toEqual(
      ids.slice(0, 100),
    );
    expect(typeof first.json().nextCursor).toBe("string");
    const second = await f.app.inject({
      url: `${f.base}/jobs${q}&cursor=${first.json().nextCursor}`,
      headers: f.headers,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().jobs.map((j: { id: string }) => j.id)).toEqual(
      ids.slice(100),
    );
    expect(second.json().nextCursor).toBeNull();
    for (const query of [
      "?cursor=not-json",
      `${q}&cursor=${first.json().nextCursor}%3D`,
      `?scenarioId=${secondScenario}&cursor=${first.json().nextCursor}`,
      `${q}&limit=1000`,
    ]) {
      const invalid = await f.app.inject({
        url: `${f.base}/jobs${query}`,
        headers: f.headers,
      });
      expect(invalid.statusCode, invalid.body).toBe(422);
      expect(invalid.json().error.code).toBe("MEDIA_CURSOR_INVALID");
    }
    const other = await f.app.inject({
      url: `${f.base}/jobs?scenarioId=${secondScenario}`,
      headers: f.headers,
    });
    expect(other.json().jobs).toHaveLength(10);
    expect(other.json().nextCursor).toBeNull();
    await f.store.transaction((s) => {
      s.memberships = [];
    });
    const denied = await f.app.inject({
      url: `${f.base}/jobs${q}&cursor=${first.json().nextCursor}`,
      headers: f.headers,
    });
    expect([401, 403, 404]).toContain(denied.statusCode);
    expect(denied.json().jobs).toBeUndefined();
  });
  it("freezes exact saved scene, completes immutable output, permits idempotent replay and verifies private download", async () => {
    const f = await setup(),
      job = await enqueue(f);
    expect((await enqueue(f)).id).toBe(job.id);
    await f.service.runOne();
    const status = await f.app.inject({
      url: `${f.base}/jobs/${job.id}`,
      headers: f.headers,
    });
    expect(status.json().job.status, status.body).toBe("completed");
    expect(f.executor.calls).toBe(1);
    const file = await f.app.inject({
      url: `${f.base}/jobs/${job.id}/artifacts/output.png`,
      headers: f.headers,
    });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers["x-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(file.headers["cache-control"]).toContain("no-store");
    expect(
      (
        await f.app.inject({
          url: `${f.base}/jobs/${job.id}/artifacts/scene.json`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.app.inject({ url: `${f.base}/jobs/${job.id}` })).statusCode,
    ).toBe(401);
    const state = await f.store.read((s) => ({
      j: s.mediaJobs[0],
      a: s.mediaArtifacts[0],
      slot: s.nativeCapacity.slot,
    }));
    expect(state.slot).toBeNull();
    expect(state.a.sceneHash).toBe(f.context.sceneHash);
    await expect(
      f.store.transaction(
        (s) => {
          s.mediaArtifacts[0].sceneHash = "f".repeat(64);
        },
        { mediaArtifacts: { all: true } },
      ),
    ).rejects.toThrow(/immutable/);
  });
  it("rejects stale version, expired unknown context and changed idempotency inputs before rendering", async () => {
    const f = await setup();
    let r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: { ...f.input, expectedVersion: 2 },
    });
    expect(r.statusCode).toBe(409);
    r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: { ...f.input, sceneHash: "d".repeat(64) },
    });
    expect(r.json().error.code).toBe("MEDIA_CONTEXT_EXPIRED");
    await enqueue(f);
    r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: {
        ...f.input,
        recipe: { ...f.input.recipe, caption: "different" },
      },
    });
    expect(r.statusCode).toBe(409);
    expect(f.executor.calls).toBe(0);
  });
  it("keeps cached downloads available but denies new admission under stale cost review", async () => {
    const f = await setup();
    await f.store.transaction((s) => {
      s.budget.costReviews!.at(-1)!.expiresAt = new Date(
        Date.now() - 1000,
      ).toISOString();
    });
    const r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: f.input,
    });
    expect(r.statusCode).toBe(503);
    expect(f.executor.calls).toBe(0);
  });
  it("cancels queued jobs, retains attempts across retry and fences changed runtime", async () => {
    const f = await setup(),
      job = await enqueue(f);
    let r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs/${job.id}/cancel`,
      headers: f.headers,
      payload: { expectedJobVersion: job.version },
    });
    expect(r.json().job.status, r.body).toBe("cancelled");
    r = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs/${job.id}/retry`,
      headers: f.headers,
      payload: {
        expectedJobVersion: r.json().job.version,
        idempotencyKey: "media-retry-first",
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    f.executor.changed = true;
    await f.service.runOne();
    const state = await f.store.read((s) => ({
      j: s.mediaJobs[0],
      slot: s.nativeCapacity.slot,
    }));
    expect(state.j.status).toBe("failed");
    expect(state.j.error?.code).toBe("MEDIA_RUNTIME_CHANGED");
    expect(state.j.attempt).toBe(1);
    expect(state.slot).toBeNull();
    expect(f.executor.calls).toBe(0);
  });
  it("quarantines uncertain native cleanup and publishes no partial artifact", async () => {
    const f = await setup();
    await enqueue(f);
    f.executor.fail = new ApiError(
      503,
      "NATIVE_CLEANUP_UNCONFIRMED",
      "Fixture uncertain process termination.",
    );
    await f.service.runOne();
    const s = await f.store.read((s) => ({
      j: s.mediaJobs[0],
      slot: s.nativeCapacity.slot,
      artifacts: s.mediaArtifacts.length,
    }));
    expect(s.j.status).toBe("failed");
    expect(s.slot?.status).toBe("quarantined");
    expect(s.artifacts).toBe(0);
  });
  it("fails closed on revocation during rendering and never promotes returned bytes", async () => {
    const f = await setup();
    await enqueue(f);
    f.executor.beforeExecute = async () => {
      await f.store.transaction((s) => {
        s.memberships = [];
      });
    };
    await f.service.runOne();
    const s = await f.store.read((s) => ({
      job: s.mediaJobs[0],
      artifacts: s.mediaArtifacts.length,
      slot: s.nativeCapacity.slot,
    }));
    expect(s.job.status).toBe("failed");
    expect(s.artifacts).toBe(0);
    expect(s.slot).toBeNull();
  });
  it("detects changed retained bytes and refuses renderer substitution without dropping output evidence", async () => {
    const f = await setup();
    const j = await enqueue(f);
    await f.service.runOne();
    const a = await f.store.read((s) => s.mediaArtifacts[0]);
    const path = join(
      f.directory,
      "archive",
      `bundle-${a.archive.sha256}`,
      "output.png",
    );
    await writeFile(path, "tampered exact artifact");
    const r = await f.app.inject({
      url: `${f.base}/jobs/${j.id}/artifacts/output.png`,
      headers: f.headers,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("MEDIA_ARCHIVE_UNAVAILABLE");
  });
  it("retains interrupted attempts and quarantines a stale running renderer instead of taking over", async () => {
    const f = await setup();
    await enqueue(f);
    await f.store.transaction((s) => {
      const j = s.mediaJobs[0],
        at = new Date(Date.now() - 300000).toISOString();
      j.status = "running";
      j.stage = "rendering";
      j.version++;
      j.attempt = 1;
      j.workerId = "departed-worker";
      j.capacityToken = "interrupted-token";
      j.leaseExpiresAt = at;
      j.attempts = [
        {
          number: 1,
          startedAt: at,
          admission: {
            budgetPolicyVersion: s.budget.policy.version,
            period: at.slice(0, 7),
            incrementalExternalCents: 0,
            costModel: f.service.options.capacity!,
          },
        },
      ];
      s.nativeCapacity.slot = {
        token: j.capacityToken,
        kind: "media",
        jobId: j.id,
        workerId: j.workerId,
        acquiredAt: at,
        heartbeatAt: at,
        hardDeadlineAt: new Date(Date.now() + 600000).toISOString(),
        status: "running",
      };
    });
    await f.service.runOne();
    const after = await f.store.read((s) => ({
      j: s.mediaJobs[0],
      slot: s.nativeCapacity.slot,
    }));
    expect(after.j.status).toBe("failed");
    expect(after.j.attempts[0].outcome).toBe("interrupted");
    expect(after.slot?.status).toBe("quarantined");
    expect(f.executor.calls).toBe(0);
  });
  it("does not admit two pending renders for one account and preserves pause at claim", async () => {
    const f = await setup();
    await enqueue(f);
    const second = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: { ...f.input, idempotencyKey: "media-second-request" },
    });
    expect(second.statusCode).toBe(429);
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await f.service.runOne();
    const j = await f.store.read((s) => s.mediaJobs[0]);
    expect(j.status).toBe("queued");
    expect(j.attempt).toBe(0);
    expect(j.error?.code).toBe("MEDIA_CAPACITY_PAUSED");
    expect(f.executor.calls).toBe(0);
  });
  it("honors cancellation after renderer entry, with no partial artifact", async () => {
    const f = await setup();
    const j = await enqueue(f);
    f.executor.beforeExecute = async () => {
      const live = await f.store.read((s) => s.mediaJobs[0]);
      const cancelled = await f.app.inject({
        method: "POST",
        url: `${f.base}/jobs/${j.id}/cancel`,
        headers: f.headers,
        payload: { expectedJobVersion: live.version },
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    };
    await f.service.runOne();
    const s = await f.store.read((s) => ({
      j: s.mediaJobs[0],
      artifacts: s.mediaArtifacts.length,
      slot: s.nativeCapacity.slot,
    }));
    expect(s.j.status).toBe("cancelled");
    expect(s.j.attempt).toBe(1);
    expect(s.artifacts).toBe(0);
    expect(s.slot).toBeNull();
  });
  it("rejects slot-only release or malformed replacement of existing media capacity", async () => {
    const f = await setup();
    const j = await enqueue(f);
    await f.store.transaction((s) => {
      s.mediaJobs[0].status = "running";
      s.mediaJobs[0].workerId = "raw-worker";
      s.mediaJobs[0].capacityToken = "raw-slot-token";
      s.nativeCapacity.slot = {
        token: "raw-slot-token",
        kind: "media",
        jobId: j.id,
        workerId: "raw-worker",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        hardDeadlineAt: new Date(Date.now() + 60000).toISOString(),
        status: "running",
      };
    });
    await expect(
      f.store.transaction(
        (s) => {
          s.nativeCapacity.slot = null;
          s.nativeCapacity.revision++;
        },
        {
          security: { mode: "worker", purpose: "media" },
          nativeCapacity: true,
        },
      ),
    ).rejects.toThrow(/running or quarantined/);
    await expect(
      f.store.transaction(
        (s) => {
          s.nativeCapacity.slot!.hardDeadlineAt = "not-a-date";
          s.nativeCapacity.revision++;
        },
        {
          security: { mode: "worker", purpose: "media" },
          nativeCapacity: true,
        },
      ),
    ).rejects.toThrow(/finite/);
    await expect(
      f.store.transaction(
        (s) => {
          s.nativeCapacity.slot = null;
          s.nativeCapacity.revision++;
        },
        { security: { mode: "worker", purpose: "gis" }, nativeCapacity: true },
      ),
    ).rejects.toThrow(/owning media/);
  });
  it("rejects invalid recipe before new native work", async () => {
    const f = await setup();
    const bad = await f.app.inject({
      method: "POST",
      url: `${f.base}/jobs`,
      headers: f.headers,
      payload: { ...f.input, recipe: { ...f.input.recipe, width: 50000 } },
    });
    expect(bad.statusCode).toBe(422);
    expect(f.executor.calls).toBe(0);
  });
});

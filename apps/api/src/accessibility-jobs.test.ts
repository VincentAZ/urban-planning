import { recordBudgetAdjustment } from "./budget.js";
import {
  enableReviewedBudgetForFixture,
  reviewBudgetForFixture,
} from "./budget-test-fixture.js";
import { DatabaseSync } from "node:sqlite";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { recoverNativeCapacity } from "./native-capacity.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  baselineIdentity,
  projectWithImportedAccessibility,
  type Project,
} from "@urban/core";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { FileStore, type Store } from "./store.js";
import { buildApp } from "./app.js";
import {
  AccessibilityJobService,
  ACCESSIBILITY_JOB_LIMITS,
} from "./accessibility-jobs.js";
import { FixtureAccessibilityExecutor } from "./accessibility-jobs-fixture.js";
import type {
  AccessibilityJobResult,
  AccessibilityAdoptResponse,
} from "./accessibility-jobs-types.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const place = workforcePlaceFixture;
export async function account(app: FastifyInstance, name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${name}@accessibility.example.test`,
      name,
      password: "isolated accessibility fixture password",
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    id: response.json().user.id,
    organizationId: response.json().organization.id,
    email: `${name}@accessibility.example.test`,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "accessibility-jobs-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"),
    store = new FileStore(file),
    executor = new FixtureAccessibilityExecutor();
  await store.transaction((s) => {
    enableReviewedBudgetForFixture(s.budget);
  });
  const service = new AccessibilityJobService(store, {
    enabled: true,
    executor,
    archiveDirectory: join(dir, "archive"),
    automaticWorker: false,
    capacity: {
      mode: "fixed-capacity",
      environment: "local-development",
      statement:
        "Existing isolated local fixture capacity, not production cost validation.",
    },
  });
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    accessibilityService: service,
    nationalPreparationEnabled: false,
    catalog: { list: async () => [place], get: async () => place },
  });
  attachIdentityTestMail(app, mail);
  cleanup.push(() => app.close());
  const owner = await account(app, "owner");
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: place.id },
  });
  expect(create.statusCode, create.body).toBe(201);
  const saved = create.json<{ project: Project; version: number }>(),
    base = `/api/v1/projects/${saved.project.id}`,
    jobs = `${base}/accessibility/jobs`;
  const input = {
    scenarioId: saved.project.activeScenarioId,
    expectedVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "accessibility-request-1",
    request: {
      site: [...place.center],
      mode: "car",
      direction: "outbound",
      thresholdsMinutes: [15, 30, 45],
    },
  };
  return {
    dir,
    file,
    app,
    store,
    service,
    executor,
    owner,
    saved,
    base,
    jobs,
    input,
  };
}
async function postJob(f: Awaited<ReturnType<typeof setup>>, input = f.input) {
  return f.app.inject({
    method: "POST",
    url: f.jobs,
    headers: f.owner.headers,
    payload: input,
  });
}
async function completed(f: Awaited<ReturnType<typeof setup>>) {
  const posted = await postJob(f);
  expect(posted.statusCode, posted.body).toBe(201);
  const id = posted.json().job.id as string;
  await f.service.runOne();
  const response = await f.app.inject({
    url: `${f.jobs}/${id}/result`,
    headers: f.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { id, result: response.json<AccessibilityJobResult>() };
}

describe("durable project-owned accessibility jobs", () => {
  it("reopens legacy artifacts using only the completed producer job and preserves verified same-project scenario clones", async () => {
    const f = await setup(),
      done = await completed(f);
    await f.app.close();
    const db = new DatabaseSync(`${f.file}.sqlite`);
    db.prepare(
      "UPDATE records SET header=json_remove(header,'$.scenarioId') WHERE collection='accessibilityArtifacts'",
    ).run();
    const original = (
      db
        .prepare(
          "SELECT header FROM records WHERE collection='accessibilityArtifacts'",
        )
        .get() as { header: string }
    ).header;
    db.close();
    const reopened = new FileStore(f.file),
      app = await buildApp({
        store: reopened,
        accessibilityService: new AccessibilityJobService(reopened, {
          ...f.service.options,
          automaticWorker: false,
        }),
        nationalPreparationEnabled: false,
        catalog: { list: async () => [place], get: async () => place },
      });
    cleanup.push(() => app.close());
    const adopted = await app.inject({
      method: "POST",
      url: `${f.jobs}/${done.id}/adopt`,
      headers: f.owner.headers,
      payload: {
        scenarioId: f.input.scenarioId,
        expectedVersion: 1,
        expectedRevision: 0,
        inputHash: done.result.accessibility.capture.inputHash,
        resultHash: done.result.accessibility.capture.resultHash,
      },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const saved = adopted.json<AccessibilityAdoptResponse>();
    const copied = structuredClone(saved.project.scenarios[1]);
    copied.id = "other-scenario";
    copied.name = "Another scenario";
    saved.project.scenarios.push(copied);
    const cloned = await app.inject({
      method: "PUT",
      url: f.base,
      headers: f.owner.headers,
      payload: { project: saved.project, expectedVersion: 2 },
    });
    expect(cloned.statusCode, cloned.body).toBe(200);
    const publish = await app.inject({
      method: "POST",
      url: `${f.base}/publish`,
      headers: f.owner.headers,
      payload: { scenarioId: copied.id, expectedRevision: copied.revision },
    });
    expect(publish.statusCode, publish.body).toBe(201);
    const frozen = (
      await app.inject({ url: `/api/v1/published/${publish.json().id}` })
    ).json();
    expect(frozen.scenario.accessibility.captures.car).toEqual(
      done.result.accessibility,
    );
    const inspect = new DatabaseSync(`${f.file}.sqlite`, { readOnly: true });
    expect(
      (
        inspect
          .prepare(
            "SELECT header FROM records WHERE collection='accessibilityArtifacts'",
          )
          .get() as { header: string }
      ).header,
    ).toBe(original);
    inspect.close();
  });

  it("preserves the other captured mode across adoption, removal, publication and optimistic conflicts", async () => {
    const f = await setup(),
      first = await completed(f);
    const adopt = async (
      id: string,
      result: AccessibilityJobResult,
      version: number,
      revision: number,
    ) =>
      f.app.inject({
        method: "POST",
        url: `${f.jobs}/${id}/adopt`,
        headers: f.owner.headers,
        payload: {
          scenarioId: f.input.scenarioId,
          expectedVersion: version,
          expectedRevision: revision,
          inputHash: result.accessibility.capture.inputHash,
          resultHash: result.accessibility.capture.resultHash,
        },
      });
    const car = await adopt(first.id, first.result, 1, 0);
    expect(car.statusCode, car.body).toBe(200);
    const queued = await postJob(f, {
      ...f.input,
      expectedVersion: 2,
      expectedRevision: 1,
      idempotencyKey: "outbound-walk-second",
      request: { ...f.input.request, mode: "walk" },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    await f.service.runOne();
    const result = (
      await f.app.inject({
        url: `${f.jobs}/${queued.json().job.id}/result`,
        headers: f.owner.headers,
      })
    ).json<AccessibilityJobResult>();
    const stale = await adopt(queued.json().job.id, result, 1, 0);
    expect(stale.statusCode).toBe(409);
    const walk = await adopt(queued.json().job.id, result, 2, 1);
    expect(walk.statusCode, walk.body).toBe(200);
    const both =
      walk.json<AccessibilityAdoptResponse>().project.scenarios[1]
        .accessibility!;
    expect(both.captures.car).toEqual(first.result.accessibility);
    expect(both.captures.walk).toEqual(result.accessibility);
    const remove = await f.app.inject({
      method: "POST",
      url: `${f.base}/scenarios/${f.input.scenarioId}/commands`,
      headers: f.owner.headers,
      payload: {
        expectedVersion: 3,
        expectedRevision: 2,
        command: {
          type: "scenario.accessibility",
          mode: "car",
          evidence: null,
        },
      },
    });
    expect(remove.statusCode, remove.body).toBe(200);
    const saved = (
      await f.app.inject({ url: f.base, headers: f.owner.headers })
    ).json<AccessibilityAdoptResponse>();
    expect(
      saved.project.scenarios[1].accessibility?.captures.car,
    ).toBeUndefined();
    expect(saved.project.scenarios[1].accessibility?.captures.walk).toEqual(
      result.accessibility,
    );
    const pub = await f.app.inject({
      method: "POST",
      url: `${f.base}/publish`,
      headers: f.owner.headers,
      payload: { scenarioId: f.input.scenarioId, expectedRevision: 3 },
    });
    expect(pub.statusCode, pub.body).toBe(201);
    const publicValue = (
      await f.app.inject({ url: `/api/v1/published/${pub.json().id}` })
    ).json();
    expect(publicValue.scenario.accessibility.captures.walk.captureHash).toBe(
      result.accessibility.captureHash,
    );
    expect(JSON.stringify(publicValue)).not.toContain('"rows"');
  });

  it("runs once for an idempotent saved request and persists compact evidence, raw archive and exact adoption through restart", async () => {
    const f = await setup();
    const first = await postJob(f),
      duplicate = await postJob(f);
    expect(first.statusCode, first.body).toBe(201);
    expect(duplicate.json().job.id).toBe(first.json().job.id);
    expect(f.executor.calls).toBe(0);
    const id = first.json().job.id;
    await f.service.runOne();
    expect(f.executor.calls).toBe(1);
    const response = await f.app.inject({
      url: `${f.jobs}/${id}/result`,
      headers: f.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<AccessibilityJobResult>();
    expect(result.job.attempts).toHaveLength(1);
    expect(result.job.attempts[0].outcome).toBe("completed");
    expect(JSON.stringify(result.job)).not.toContain("availableCents");
    expect(result.siteSnapMeters).toBe(12.5);
    expect(result.accessibility.capture.thresholds[2].total.estimate).toBe(100);
    expect(JSON.stringify(result.accessibility)).not.toContain('"coordinates"');
    expect(JSON.stringify(result)).not.toContain('"rows"');
    expect(JSON.stringify(result)).not.toContain('"units"');
    const downloaded = await f.app.inject({
      url: `${f.jobs}/${id}/artifact`,
      headers: f.owner.headers,
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.headers["x-content-sha256"]).toBe(
      result.accessibility.capture.artifactHash,
    );
    expect(downloaded.json().run.rows).toHaveLength(2);
    const raw = await readFile(
      join(
        f.dir,
        "archive",
        `${result.accessibility.capture.artifactHash}.json`,
      ),
      "utf8",
    );
    expect(JSON.parse(raw).run.rows).toHaveLength(2);
    const adopted = await f.app.inject({
      method: "POST",
      url: `${f.jobs}/${id}/adopt`,
      headers: f.owner.headers,
      payload: {
        scenarioId: f.input.scenarioId,
        expectedVersion: 1,
        expectedRevision: 0,
        inputHash: result.accessibility.capture.inputHash,
        resultHash: result.accessibility.capture.resultHash,
      },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const saved = adopted.json<AccessibilityAdoptResponse>();
    expect(saved.project.schemaVersion).toBe(10);
    expect(saved.version).toBe(2);
    expect(saved.project.history.at(-1)?.command.type).toBe(
      "scenario.accessibility",
    );
    expect(saved.project.scenarios[1].accessibility!.captures.car).toEqual(
      result.accessibility,
    );
    expect(saved.baselineIdentity.sha256).toBe(
      (await baselineIdentity(place)).sha256,
    );
    const exported = await f.app.inject({
      url: `${f.base}/exports?format=records&scenarioId=${f.input.scenarioId}&revision=1&version=2`,
      headers: f.owner.headers,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain(result.accessibility.captureHash);
    const pub = await f.app.inject({
      method: "POST",
      url: `${f.base}/publish`,
      headers: f.owner.headers,
      payload: { scenarioId: f.input.scenarioId, expectedRevision: 1 },
    });
    expect(pub.statusCode, pub.body).toBe(201);
    await f.app.close();
    const reopened = new FileStore(f.file);
    const app = await buildApp({
      store: reopened,
      nationalPreparationEnabled: false,
      catalog: { list: async () => [place], get: async () => place },
    });
    cleanup.push(() => app.close());
    const read = await app.inject({ url: f.base, headers: f.owner.headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(
      read.json().project.scenarios[1].accessibility!.captures.car,
    ).toEqual(result.accessibility);
    expect(await reopened.read((s) => s.accessibilityJobs[0].status)).toBe(
      "completed",
    );
    await expect(
      reopened.transaction((s) => {
        s.accessibilityArtifacts[0].siteSnapMeters = 0;
      }),
    ).rejects.toThrow(/immutable/);
  });
  it("rejects tampered current, command and historical evidence, foreign project receipts and new-cloud copies without mutating saved versions", async () => {
    const f = await setup(),
      { id, result } = await completed(f);
    const command = {
      type: "scenario.accessibility",
      mode: "car",
      evidence: structuredClone(result.accessibility),
    };
    command.evidence.capture.notes.push("forged note");
    const bad = await f.app.inject({
      method: "POST",
      url: `${f.base}/scenarios/${f.input.scenarioId}/commands`,
      headers: f.owner.headers,
      payload: { command, expectedVersion: 1, expectedRevision: 0 },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    const good = await f.app.inject({
      method: "POST",
      url: `${f.jobs}/${id}/adopt`,
      headers: f.owner.headers,
      payload: {
        scenarioId: f.input.scenarioId,
        expectedVersion: 1,
        expectedRevision: 0,
        inputHash: result.accessibility.capture.inputHash,
        resultHash: result.accessibility.capture.resultHash,
      },
    });
    expect(good.statusCode, good.body).toBe(200);
    const saved = good.json<AccessibilityAdoptResponse>(),
      edited = structuredClone(saved.project);
    edited.history[0].after.accessibility!.captures.car!.capture.notes.push(
      "forged history",
    );
    const save = await f.app.inject({
      method: "PUT",
      url: f.base,
      headers: f.owner.headers,
      payload: { project: edited, expectedVersion: 2 },
    });
    expect(save.statusCode, save.body).toBe(422);
    const copy = await f.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: f.owner.headers,
      payload: {
        project: saved.project,
        baselineHash: saved.baselineIdentity.sha256,
      },
    });
    expect(copy.statusCode, copy.body).toBe(422);
    const imported = projectWithImportedAccessibility(
      structuredClone(saved.project),
    );
    const copyWithDisclosure = await f.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: f.owner.headers,
      payload: {
        project: imported,
        baselineHash: saved.baselineIdentity.sha256,
      },
    });
    expect(copyWithDisclosure.statusCode, copyWithDisclosure.body).toBe(201);
    expect(
      copyWithDisclosure.json().project.history[0].after.accessibility.captures
        .car.origin,
    ).toBe("imported");
    expect(
      copyWithDisclosure.json().project.scenarios[1].accessibility!.captures.car
        .captureHash,
    ).toBe(result.accessibility.captureHash);
    const second = await f.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: f.owner.headers,
      payload: { placeId: place.id },
    });
    const other = second.json();
    const foreign = await f.app.inject({
      method: "POST",
      url: `/api/v1/projects/${other.project.id}/scenarios/${other.project.activeScenarioId}/commands`,
      headers: f.owner.headers,
      payload: {
        command: {
          type: "scenario.accessibility",
          mode: "car",
          evidence: result.accessibility,
        },
        expectedVersion: 1,
        expectedRevision: 0,
      },
    });
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(
      (await f.app.inject({ url: f.base, headers: f.owner.headers })).json()
        .version,
    ).toBe(2);
  });
  it("enforces project-only viewer access, CSRF, cross-project isolation and later revocation", async () => {
    const f = await setup(),
      guest = await account(f.app, "viewer"),
      { id } = await completed(f);
    expect(
      (await f.app.inject({ url: `${f.jobs}/${id}`, headers: guest.headers }))
        .statusCode,
    ).toBe(404);
    const grant = await acceptIdentityTestInvitation(
      f.app,
      f.owner,
      guest,
      "viewer",
      f.saved.project.id,
    );
    expect(grant.aclVersion).toBe(2);
    const change = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: guest.headers,
      payload: { organizationId: f.owner.organizationId },
    });
    expect(change.statusCode, change.body).toBe(200);
    expect(
      (
        await f.app.inject({
          url: `${f.jobs}/${id}/result`,
          headers: guest.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: f.jobs,
          headers: guest.headers,
          payload: f.input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: f.jobs,
          headers: { cookie: f.owner.headers.cookie },
          payload: f.input,
        })
      ).statusCode,
    ).toBe(403);
    const revoke = await f.app.inject({
      method: "DELETE",
      url: `${f.base}/members/${guest.id}`,
      headers: f.owner.headers,
      payload: { expectedAclVersion: 2 },
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(
      (
        await f.app.inject({
          url: `${f.jobs}/${id}/result`,
          headers: guest.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rejects stale versions, different idempotent inputs and unsupported region before native execution", async () => {
    const f = await setup();
    expect(
      (await postJob(f, { ...f.input, expectedVersion: 9 })).statusCode,
    ).toBe(409);
    const outside = await postJob(f, {
      ...f.input,
      request: { ...f.input.request, site: [0, 33] },
    });
    expect(outside.statusCode).toBe(422);
    const first = await postJob(f);
    expect(first.statusCode).toBe(201);
    const conflict = await postJob(f, {
      ...f.input,
      request: { ...f.input.request, site: [-112.001, 33] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(f.executor.calls).toBe(0);
  });
  it("serializes concurrent workers and cancels an active attempt without publishing partial evidence", async () => {
    const f = await setup();
    let release!: () => void;
    f.executor.blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = await postJob(f);
    const id = posted.json().job.id;
    const running = f.service.runOne();
    await expect.poll(() => f.executor.calls).toBe(1);
    const other = new AccessibilityJobService(f.store, f.service.options);
    await other.runOne();
    expect(f.executor.calls).toBe(1);
    const status = await f.app.inject({
      url: `${f.jobs}/${id}`,
      headers: f.owner.headers,
    });
    const cancel = await f.app.inject({
      method: "POST",
      url: `${f.jobs}/${id}/cancel`,
      headers: f.owner.headers,
      payload: { expectedJobVersion: status.json().job.version },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    release();
    await running;
    expect(await f.store.read((s) => s.accessibilityArtifacts.length)).toBe(0);
    const job = await f.store.read((s) => s.accessibilityJobs[0]);
    expect(job.status).toBe("cancelled");
    expect(job.attempts[0].outcome).toBe("cancelled");
    expect(job.attempt).toBe(1);
  });
  it("retains failed/cancelled attempt consumption, idempotently retries and enforces per-day starts", async () => {
    const f = await setup();
    f.executor.fail = true;
    const posted = await postJob(f);
    const id = posted.json().job.id;
    for (let i = 1; i <= 3; i++) {
      await f.service.runOne();
      const job = await f.store.read((s) => s.accessibilityJobs[0]);
      expect(job.attempt).toBe(i);
      expect(job.attempts).toHaveLength(i);
      // A rejected executor cannot prove native termination; explicit operator recovery is required.
      await f.store.transaction(
        (s) => {
          expect(s.nativeCapacity.slot?.status).toBe("quarantined");
          recoverNativeCapacity(s, {
            token: s.nativeCapacity.slot!.token,
            expectedRevision: s.nativeCapacity.revision,
            operator: "isolated-test",
            confirmation:
              "The synthetic fixture has no running native process; termination is confirmed.",
          });
        },
        { nativeCapacity: true },
      );
      const retryBody = {
        expectedJobVersion: job.version,
        idempotencyKey: `retry-attempt-${i}`,
      };
      const retry = await f.app.inject({
        method: "POST",
        url: `${f.jobs}/${id}/retry`,
        headers: f.owner.headers,
        payload: retryBody,
      });
      if (i < 3) {
        expect(retry.statusCode, retry.body).toBe(200);
        const duplicate = await f.app.inject({
          method: "POST",
          url: `${f.jobs}/${id}/retry`,
          headers: f.owner.headers,
          payload: retryBody,
        });
        expect(duplicate.json().job.version).toBe(retry.json().job.version);
      } else expect(retry.statusCode).toBe(409);
    }
    expect(
      (
        await postJob(f, {
          ...f.input,
          idempotencyKey: "new-after-daily-limit",
        })
      ).statusCode,
    ).toBe(429);
  });
  it("does not dispatch queued work after budget pause and records no invented dollar settlement", async () => {
    const f = await setup();
    await postJob(f);
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await f.service.runOne();
    expect(f.executor.calls).toBe(0);
    expect(await f.store.read((s) => s.accessibilityJobs[0].status)).toBe(
      "queued",
    );
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
    });
    await f.service.runOne();
    expect(f.executor.calls).toBe(1);
    expect(await f.store.read((s) => s.budget.reservations)).toEqual([]);
    expect(await f.store.read((s) => s.budget.adjustments)).toEqual([]);
    expect(
      await f.store.read(
        (s) =>
          s.accessibilityJobs[0].attempts[0].admission.incrementalExternalCents,
      ),
    ).toBe(0);
  });
  it("preserves expired leases as consumed failures, requiring explicit retry after worker interruption", async () => {
    const f = await setup();
    await postJob(f);
    await f.store.transaction((s) => {
      const j = s.accessibilityJobs[0];
      j.status = "running";
      j.attempt = 1;
      j.workerId = "dead-worker";
      j.leaseExpiresAt = "2000-01-01T00:00:00Z";
      j.attempts.push({
        number: 1,
        startedAt: new Date().toISOString(),
        admission: {
          budgetPolicyVersion: 1,
          period: new Date().toISOString().slice(0, 7),
          incrementalExternalCents: 0,
          costModel: f.service.options.capacity!,
        },
      });
    });
    await f.service.runOne();
    const j = await f.store.read((s) => s.accessibilityJobs[0]);
    expect(j.status).toBe("failed");
    expect(j.attempts[0].outcome).toBe("interrupted");
    expect(j.error?.retryable).toBe(true);
    expect(f.executor.calls).toBe(0);
  });
  it("fails safely when archived raw evidence changes and keeps adopted tables available", async () => {
    const f = await setup(),
      { id, result } = await completed(f);
    const path = join(
      f.dir,
      "archive",
      `${result.accessibility.capture.artifactHash}.json`,
    );
    await writeFile(path, "corrupt");
    const response = await f.app.inject({
      url: `${f.jobs}/${id}/result`,
      headers: f.owner.headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe(
      "ACCESSIBILITY_ARTIFACT_UNAVAILABLE",
    );
    expect(
      await f.store.read(
        (s) => s.accessibilityArtifacts[0].accessibility.captureHash,
      ),
    ).toBe(result.accessibility.captureHash);
  });
  it("rejects an unconfigured cost model or unrecorded deployment hosting commitment", async () => {
    const f = await setup();
    const opts = f.service.options;
    const original = opts.capacity;
    opts.capacity = undefined;
    const noModel = await postJob(f);
    expect(noModel.statusCode, noModel.body).toBe(503);
    expect(noModel.json().error.code).toBe(
      "ACCESSIBILITY_COST_MODEL_UNCONFIGURED",
    );
    opts.capacity = { ...original!, environment: "deployment" };
    const hosting = await postJob(f);
    expect(hosting.statusCode).toBe(503);
    expect(hosting.json().error.code).toBe(
      "ACCESSIBILITY_FIXED_COST_UNRECORDED",
    );
    expect(f.executor.calls).toBe(0);
  });
  it("atomically admits only one pending request per account during concurrent submission", async () => {
    const f = await setup();
    const responses = await Promise.all([
      postJob(f),
      postJob(f, { ...f.input, idempotencyKey: "concurrent-other-key" }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 429]);
    expect(await f.store.read((s) => s.accessibilityJobs.length)).toBe(1);
    expect(f.executor.calls).toBe(0);
  });
  it("requires a new request after the configured source identity changes, without dispatching the old query", async () => {
    const f = await setup();
    await postJob(f);
    const original = f.executor.preflight.bind(f.executor);
    f.executor.preflight = async (request) => ({
      ...(await original(request)),
      profileHash: "9".repeat(64),
    });
    await f.service.runOne();
    const job = await f.store.read((state) => state.accessibilityJobs[0]);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("ACCESSIBILITY_SOURCE_CHANGED");
    expect(job.error?.retryable).toBe(false);
    expect(f.executor.calls).toBe(0);
  });
  it("rechecks a project-only editor's downgraded permission before dispatch", async () => {
    const f = await setup(),
      editor = await account(f.app, "queued-editor");
    const grant = await acceptIdentityTestInvitation(
      f.app,
      f.owner,
      editor,
      "editor",
      f.saved.project.id,
    );
    expect(grant.aclVersion).toBe(2);
    await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: editor.headers,
      payload: { organizationId: f.owner.organizationId },
    });
    const queued = await f.app.inject({
      method: "POST",
      url: f.jobs,
      headers: editor.headers,
      payload: f.input,
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const downgrade = await f.app.inject({
      method: "PATCH",
      url: `${f.base}/members/${editor.id}`,
      headers: f.owner.headers,
      payload: { role: "viewer", expectedAclVersion: 2 },
    });
    expect(downgrade.statusCode, downgrade.body).toBe(200);
    await f.service.runOne();
    expect(f.executor.calls).toBe(0);
    const job = await f.store.read((s) => s.accessibilityJobs[0]);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("ACCESSIBILITY_REQUESTER_REVOKED");
    expect(job.attempts).toHaveLength(0);
  });
});

describe("cost evidence before native dispatch", () => {
  it("keeps queued work idle after a manual cost change until an explicit fresh review", async () => {
    const f = await setup();
    await postJob(f);
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
    expect(f.executor.calls).toBe(0);
    expect(
      await f.store.read((s) => ({
        status: s.accessibilityJobs[0].status,
        attempt: s.accessibilityJobs[0].attempt,
        slot: s.nativeCapacity.slot,
      })),
    ).toEqual({ status: "queued", attempt: 0, slot: null });
    await f.store.transaction((s) => reviewBudgetForFixture(s.budget));
    await f.service.runOne();
    expect(f.executor.calls).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce";
import { createProject } from "@urban/models";
import {
  applyCommand,
  projectWithWorkforceVersion,
  workforceContentHash,
  type WorkforceScenario,
} from "@urban/core";
import { emptyState, type ProjectRecord } from "./store";
import { encodeRecord } from "./storage-core";
import { tokenHash } from "./security";
import { createPostgresSecurityFixture } from "./postgres-security-fixture";
import { assertPostgresRuntimeRole } from "./postgres-security";
import type {
  WorkforceJobRecord,
  WorkforceArtifactRecord,
} from "./workforce-jobs-types";
const connection = process.env.TEST_DATABASE_URL;
const at = "2026-11-06T00:00:00.000Z";
const session = (id: string) => tokenHash(`workforce-security:${id}`);
describe.skipIf(!connection)("project workforce SQL boundary", () => {
  let fixture: Awaited<ReturnType<typeof createPostgresSecurityFixture>>,
    web: pg.Pool,
    worker: pg.Pool,
    auth: pg.Pool;
  let record: ProjectRecord,
    job: WorkforceJobRecord,
    artifact: WorkforceArtifactRecord,
    completed: WorkforceArtifactRecord;
  beforeAll(async () => {
    const f = await workforceScenarioFixture({
        projectId: "project-a",
        jobId: "job-a",
      }),
      done = await workforceScenarioFixture({
        projectId: "project-a",
        jobId: "job-complete",
      });
    const state = emptyState();
    for (const [id, org, role] of [
      ["owner", "org-a", "owner"],
      ["editor", "org-a", "editor"],
      ["viewer", "org-a", "viewer"],
      ["other", "org-b", "owner"],
    ] as const) {
      state.users.push({
        id,
        name: id,
        email: id + "@fixture.test",
        passwordHash: "fixture-only",
        createdAt: at,
      });
      state.memberships.push({
        userId: id,
        organizationId: org,
        role,
        scope: "workspace",
      });
      state.sessions.push({
        hash: session(id),
        userId: id,
        organizationId: org,
        csrfToken: "fixture",
        expiresAt: "2099-01-01T00:00:00Z",
      });
    }
    state.organizations.push(
      { id: "org-a", name: "A", createdAt: at },
      { id: "org-b", name: "B", createdAt: at },
    );
    const project = createProject(f.place);
    project.id = "project-a";
    record = {
      project,
      baseline: f.place,
      organizationId: "org-a",
      version: 1,
      createdBy: "owner",
      createdAt: at,
    };
    state.projects.push(record);
    state.projects.push({
      ...structuredClone(record),
      organizationId: "org-b",
      createdBy: "other",
      project: { ...structuredClone(project), id: "project-b" },
    });
    job = {
      id: "job-a",
      projectId: "project-a",
      organizationId: "org-a",
      userId: "owner",
      scenarioId: project.scenarios[1].id,
      projectVersion: 1,
      scenarioRevision: 0,
      placeId: f.place.id,
      baselineHash: f.workforce.binding.baselineHash,
      request: f.run.request,
      sourceIdentity: {
        cohortPackHash: f.run.cohortPackHash,
        boundaryHash: f.run.cohortCoverage.boundaryHash!,
        manifestId: f.run.network.id,
        graphHash: f.run.network.graphHash,
        profileHash: f.run.network.profileHash,
        methodVersion: "workforce-1.0.2",
      },
      queryHash: "a".repeat(64),
      idempotencyKey: "initial-key",
      requestKeys: ["initial-key"],
      version: 1,
      status: "queued",
      stage: "queued",
      progress: 0,
      attempt: 0,
      attempts: [],
      cancelRequested: false,
      createdAt: at,
      updatedAt: at,
    };
    artifact = {
      id: "artifact-a",
      projectId: "project-a",
      organizationId: "org-a",
      jobId: job.id,
      createdAt: at,
      workforce: f.workforce,
      contour: f.artifact.contour,
      siteSnapMeters: 12.5,
      rawFileHash: f.workforce.capture.artifactHash,
      rawFileBytes: 1000,
    };
    completed = {
      ...structuredClone(artifact),
      id: "artifact-complete",
      jobId: "job-complete",
      workforce: done.workforce,
    };
    state.workforceJobs.push(job, {
      ...structuredClone(job),
      id: "job-complete",
      idempotencyKey: "completed-key",
      requestKeys: ["completed-key"],
      status: "completed",
      stage: "complete",
      progress: 100,
      version: 3,
      attempt: 1,
      attempts: [attempt()],
      result: {
        artifactId: completed.id,
        captureHash: completed.workforce.captureHash,
        resultHash: completed.workforce.capture.resultHash,
        inputHash: completed.workforce.capture.inputHash,
      },
    });
    state.workforceArtifacts.push(completed);
    fixture = await createPostgresSecurityFixture(connection!, { state });
    web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
    worker = new pg.Pool({ connectionString: fixture.workerURL, max: 1 });
    auth = new pg.Pool({ connectionString: fixture.authURL, max: 1 });
  }, 30000);
  afterAll(async () => {
    await Promise.all([web?.end(), worker?.end(), auth?.end()]);
    await fixture?.close();
  }, 30000);
  function attempt() {
    return {
      number: 1,
      startedAt: at,
      admission: {
        budgetPolicyVersion: 1,
        period: "2026-11",
        incrementalExternalCents: 0 as const,
        costModel: {
          mode: "fixed-capacity" as const,
          environment: "local-development" as const,
          statement: "Synthetic fixed-capacity fixture.",
        },
      },
    };
  }
  async function as<T>(
    pool: pg.Pool,
    actor: string | undefined,
    purpose: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const [k, v] of Object.entries({
        "urban.session_hash": actor ? session(actor) : "",
        "urban.purpose": purpose,
        "urban.project_id": "project-a",
        "urban.public_snapshot_id": "",
      }))
        await c.query("SELECT set_config($1,$2,true)", [k, v]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }
  async function denied(c: pg.PoolClient, fn: () => Promise<unknown>) {
    await c.query("SAVEPOINT blocked");
    let error: any;
    try {
      await fn();
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (e) {
      error = e;
    }
    await c.query("ROLLBACK TO SAVEPOINT blocked");
    await c.query("RELEASE SAVEPOINT blocked");
    expect(error).toBeDefined();
    expect(["42501", "23514", "23505", "55000"]).toContain(error.code);
  }
  async function insert(
    c: pg.PoolClient,
    table: string,
    collection: "workforceJobs" | "workforceArtifacts",
    value: WorkforceJobRecord | WorkforceArtifactRecord,
  ) {
    const r = encodeRecord(collection, value as never).row;
    return c.query(
      `INSERT INTO ${table}(id,organization_id,user_id,project_id,header,payload) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        r.id,
        r.indexes.organizationId ?? null,
        r.indexes.userId ?? null,
        r.indexes.projectId ?? null,
        JSON.stringify(r.header),
        JSON.stringify(r.payload),
      ],
    );
  }
  async function updateJob(c: pg.PoolClient, value: WorkforceJobRecord) {
    return c.query(
      "UPDATE app_workforce_jobs SET header=$2::jsonb WHERE id=$1",
      [value.id, JSON.stringify(value)],
    );
  }
  async function save(
    c: pg.PoolClient,
    w: WorkforceScenario,
    historyOnly = false,
  ) {
    const next = structuredClone(record);
    next.version = 2;
    const before = next.project.scenarios[1],
      after = applyCommand(before, {
        type: "scenario.workforce",
        workforce: w,
      });
    if (historyOnly)
      next.project.history = [
        {
          id: "entry",
          at,
          actor: "owner",
          label: "Imported history",
          command: { type: "scenario.workforce", workforce: w },
          before,
          after,
        },
      ];
    else next.project.scenarios[1] = after;
    next.project = projectWithWorkforceVersion(next.project, next.baseline);
    const row = encodeRecord("projects", next).row;
    return c.query(
      "UPDATE app_projects SET header=$2::jsonb,payload=$3::jsonb WHERE id=$1",
      [row.id, JSON.stringify(row.header), JSON.stringify(row.payload)],
    );
  }
  it("requires version 21 FORCE RLS and keeps auth/prep/budget out of workforce records", async () => {
    const c = await web.connect();
    try {
      expect((await assertPostgresRuntimeRole(c, "web")).securityVersion).toBe(
        21,
      );
    } finally {
      c.release();
    }
    await as(auth, undefined, "auth.lookup", (c) =>
      denied(c, () => c.query("SELECT id FROM app_workforce_jobs")),
    );
    for (const purpose of ["worker.prep", "worker.budget"])
      await as(worker, undefined, purpose, async (c) =>
        expect(
          (await c.query("SELECT id FROM app_workforce_jobs")).rows,
        ).toEqual([]),
      );
  });
  it("enforces project ACL for unfiltered reads and cannot elevate web by purpose spoofing", async () => {
    await as(web, "viewer", "", async (c) =>
      expect(
        (await c.query("SELECT id FROM app_workforce_jobs")).rowCount,
      ).toBe(2),
    );
    await as(web, "other", "", async (c) =>
      expect(
        (await c.query("SELECT id FROM app_workforce_jobs")).rowCount,
      ).toBe(0),
    );
    await as(web, "owner", "worker.workforce", (c) =>
      denied(c, () =>
        insert(c, "app_workforce_jobs", "workforceJobs", {
          ...job,
          id: "new",
          idempotencyKey: "new",
          requestKeys: ["new"],
        }),
      ),
    );
  });
  it("permits authenticated editor admission only for a matching saved baseline/revision", async () => {
    await as(worker, "owner", "worker.workforce", async (c) => {
      const next = {
        ...job,
        id: "new",
        idempotencyKey: "new",
        requestKeys: ["new"],
      };
      expect(
        (await insert(c, "app_workforce_jobs", "workforceJobs", next)).rowCount,
      ).toBe(1);
      await denied(c, () =>
        insert(c, "app_workforce_jobs", "workforceJobs", {
          ...next,
          id: "foreign",
          projectId: "project-b",
          organizationId: "org-b",
        }),
      );
      await denied(c, () =>
        insert(c, "app_workforce_jobs", "workforceJobs", {
          ...next,
          id: "stale",
          projectVersion: 99,
        }),
      );
    });
    await as(worker, "viewer", "worker.workforce", (c) =>
      denied(c, () =>
        insert(c, "app_workforce_jobs", "workforceJobs", {
          ...job,
          id: "viewer-job",
          idempotencyKey: "viewer",
          requestKeys: ["viewer"],
        }),
      ),
    );
  });
  it("allows exact cancellation, forbids fabricated completion/progress/retry and hides foreign updates", async () => {
    await as(web, "editor", "", async (c) => {
      await denied(c, () =>
        updateJob(c, {
          ...job,
          status: "completed",
          version: 2,
          progress: 100,
          stage: "complete",
        }),
      );
      await denied(c, () => updateJob(c, { ...job, progress: 75 }));
      expect(
        (
          await updateJob(c, {
            ...job,
            status: "cancelled",
            cancelRequested: true,
            version: 2,
          })
        ).rowCount,
      ).toBe(1);
      await denied(c, () =>
        updateJob(c, { ...job, status: "queued", version: 3 }),
      );
    });
    await as(web, "viewer", "", async (c) =>
      expect(
        (
          await updateJob(c, {
            ...job,
            status: "cancelled",
            cancelRequested: true,
            version: 2,
          })
        ).rowCount,
      ).toBe(0),
    );
  });
  it("limits worker access to job headers, creator memberships and read-only budget", async () => {
    await as(worker, undefined, "worker.workforce", async (c) => {
      expect(
        (await c.query("SELECT id,header FROM app_projects")).rows.map(
          (r) => r.id,
        ),
      ).toEqual(["project-a"]);
      await denied(c, () => c.query("SELECT payload FROM app_projects"));
      expect(
        (await c.query("SELECT user_id FROM app_memberships")).rows.map(
          (r) => r.user_id,
        ),
      ).toEqual(["owner"]);
      expect((await c.query("SELECT id FROM app_budget")).rowCount).toBe(1);
      expect(
        (await c.query("UPDATE app_budget SET updated_at=now()")).rowCount,
      ).toBe(0);
      expect(
        (await c.query("UPDATE app_projects SET updated_at=now()")).rowCount,
      ).toBe(0);
      expect(
        (await c.query("SELECT id FROM app_preparation_jobs")).rowCount,
      ).toBe(0);
    });
  });
  it("atomically completes a worker job and its exact artifact, retaining append-only history", async () => {
    await as(worker, undefined, "worker.workforce", async (c) => {
      const running: WorkforceJobRecord = {
        ...job,
        status: "running",
        version: 2,
        stage: "routing",
        progress: 10,
        attempt: 1,
        attempts: [attempt()],
        workerId: "worker",
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      };
      await updateJob(c, running);
      const finished: WorkforceJobRecord = {
        ...running,
        status: "completed",
        version: 3,
        stage: "complete",
        progress: 100,
        result: {
          artifactId: artifact.id,
          captureHash: artifact.workforce.captureHash,
          resultHash: artifact.workforce.capture.resultHash,
          inputHash: artifact.workforce.capture.inputHash,
        },
      };
      delete finished.workerId;
      delete finished.leaseExpiresAt;
      await updateJob(c, finished);
      await insert(
        c,
        "app_workforce_artifacts",
        "workforceArtifacts",
        artifact,
      );
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      await denied(c, () =>
        c.query(
          "UPDATE app_workforce_artifacts SET header=header||'{\"rawFileBytes\":1}'::jsonb WHERE id='artifact-a'",
        ),
      );
      await denied(c, () =>
        c.query("DELETE FROM app_workforce_artifacts WHERE id='artifact-a'"),
      );
      await denied(c, () =>
        insert(c, "app_workforce_artifacts", "workforceArtifacts", {
          ...artifact,
          id: "unreferenced-second-artifact",
        }),
      );
    });
  });
  it("consumes a claim attempt and preserves the captured admission ledger", async () => {
    await as(worker, undefined, "worker.workforce", async (c) => {
      const running: WorkforceJobRecord = {
        ...job,
        status: "running",
        version: 2,
        stage: "routing",
        progress: 10,
        attempt: 1,
        attempts: [attempt()],
        workerId: "worker",
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      };
      await denied(c, () =>
        updateJob(c, { ...running, attempt: 0, attempts: [] }),
      );
      await updateJob(c, running);
      const rewritten = structuredClone(running);
      rewritten.attempts[0].admission.budgetPolicyVersion = 999999;
      await denied(c, () => updateJob(c, rewritten));
      const failed: WorkforceJobRecord = {
        ...running,
        status: "failed",
        version: 3,
        error: {
          code: "TEST_FAILURE",
          message: "Synthetic retryable failure.",
          retryable: true,
        },
      };
      delete failed.workerId;
      delete failed.leaseExpiresAt;
      await updateJob(c, failed);
      await c.query("SELECT set_config('urban.session_hash',$1,true)", [
        session("owner"),
      ]);
      const retry: WorkforceJobRecord = {
        ...failed,
        status: "queued",
        version: 4,
        stage: "queued",
        progress: 0,
        requestKeys: [...failed.requestKeys, "retry-key"],
      };
      delete retry.error;
      await denied(c, () =>
        updateJob(c, { ...retry, attempt: 0, attempts: [] }),
      );
      await denied(c, () =>
        updateJob(c, {
          ...retry,
          requestKeys: ["replacement-key", "retry-key"],
        }),
      );
      expect((await updateJob(c, retry)).rowCount).toBe(1);
    });
  });
  it("rejects orphan results and artifact/query/source substitution at commit", async () => {
    await as(worker, undefined, "worker.workforce", async (c) => {
      const running: WorkforceJobRecord = {
        ...job,
        status: "running",
        version: 2,
        stage: "routing",
        progress: 10,
        attempt: 1,
        attempts: [attempt()],
        workerId: "worker",
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      };
      await updateJob(c, running);
      await denied(c, () =>
        insert(c, "app_workforce_artifacts", "workforceArtifacts", artifact),
      );
      const fake = structuredClone(artifact);
      fake.workforce.receipt.projectId = "project-b";
      await denied(c, () =>
        insert(c, "app_workforce_artifacts", "workforceArtifacts", fake),
      );
      const finished = {
        ...running,
        status: "completed" as const,
        version: 3,
        stage: "complete" as const,
        progress: 100,
        result: {
          artifactId: "missing",
          captureHash: artifact.workforce.captureHash,
          resultHash: artifact.workforce.capture.resultHash,
          inputHash: artifact.workforce.capture.inputHash,
        },
      };
      await denied(c, () => updateJob(c, finished));
    });
  });
  it("blocks forged server evidence in current and historical project payloads, while retaining explicitly imported copies", async () => {
    await as(web, "owner", "", async (c) => {
      const fake = structuredClone(completed.workforce);
      fake.capture.panels[0].thresholds[0].total.estimate = 999;
      fake.capture.panels[0].thresholds[0].total.knownSubtotal = 999;
      fake.captureHash = await workforceContentHash(fake.capture);
      await denied(c, () => save(c, fake));
      await denied(c, () => save(c, fake, true));
      expect((await save(c, completed.workforce)).rowCount).toBe(1);
    });
    await as(web, "owner", "", async (c) => {
      const imported = {
        ...structuredClone(completed.workforce),
        origin: "imported" as const,
        receipt: { ...completed.workforce.receipt, projectId: "old-project" },
      };
      expect((await save(c, imported, true)).rowCount).toBe(1);
    });
  });
});

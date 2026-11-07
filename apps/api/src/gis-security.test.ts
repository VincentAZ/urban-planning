import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { baselineIdentity } from "@urban/core";
import { createProject } from "@urban/models";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { emptyState, type ImportRecord } from "./store.js";
import { encodeRecord } from "./storage-core.js";
import { tokenHash } from "./security.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { assertPostgresRuntimeRole } from "./postgres-security.js";
import type { GisJobRecord, GisPreviewRequest } from "./gis-jobs-types.js";
const at = "2026-11-06T00:00:00.000Z",
  session = (id: string) => tokenHash(`gis-security:${id}`);
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "private GIS SQL boundary",
  () => {
    let fixture: Awaited<ReturnType<typeof createPostgresSecurityFixture>>,
      web: pg.Pool,
      worker: pg.Pool,
      auth: pg.Pool,
      queued: GisJobRecord,
      prepared: GisJobRecord,
      baselineHash: string;
    beforeAll(async () => {
      const state = emptyState();
      state.budget.policy.paidOperationsPaused = false;
      for (const [id, org, role] of [
        ["owner", "org-a", "owner"],
        ["peer", "org-a", "owner"],
        ["viewer", "org-a", "viewer"],
        ["other", "org-b", "owner"],
      ] as const) {
        state.users.push({
          id,
          email: `${id}@gis.test`,
          name: id,
          createdAt: at,
          passwordHash: "fixture",
        });
        state.memberships.push({ userId: id, organizationId: org, role });
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
      const project = createProject(workforcePlaceFixture);
      project.id = "project-a";
      baselineHash = (await baselineIdentity(workforcePlaceFixture)).sha256;
      state.projects.push(
        {
          project,
          baseline: workforcePlaceFixture,
          organizationId: "org-a",
          version: 1,
          createdBy: "owner",
          createdAt: at,
        },
        {
          project: { ...structuredClone(project), id: "project-b" },
          baseline: workforcePlaceFixture,
          organizationId: "org-b",
          version: 1,
          createdBy: "other",
          createdAt: at,
        },
      );
      queued = {
        id: "inspect-queued",
        kind: "inspect",
        projectId: project.id,
        organizationId: "org-a",
        userId: "owner",
        scenarioId: project.activeScenarioId,
        projectVersion: 1,
        scenarioRevision: 0,
        baselineHash,
        version: 1,
        status: "queued",
        stage: "queued",
        attempt: 0,
        attempts: [],
        cancelRequested: false,
        createdAt: at,
        updatedAt: at,
        idempotencyKey: "initial-key",
        requestKeys: ["initial-key"],
        requestHash: "a".repeat(64),
        upload: {
          filename: "sample.geojson",
          format: "geojson",
          bytes: 100,
          sha256: "b".repeat(64),
        },
      };
      const completed = {
        ...structuredClone(queued),
        id: "inspect-complete",
        idempotencyKey: "complete-key",
        requestKeys: ["complete-key"],
        status: "completed" as const,
        stage: "complete" as const,
        version: 3,
        attempt: 1,
        attempts: [
          { ...attempt(), endedAt: at, outcome: "completed" as const },
        ],
        inspection: {
          version: 1 as const,
          format: "geojson" as const,
          input: { sha256: "b".repeat(64), bytes: 100, members: [] },
          converter: {
            name: "GDAL",
            version: "3.13.3",
            projVersion: "9.8",
            imageDigest: "sha256:" + "a".repeat(64),
          },
          layers: [],
          warnings: [],
        },
      };
      const recipe: Omit<GisPreviewRequest, "idempotencyKey"> = {
        scenarioId: project.activeScenarioId,
        expectedVersion: 1,
        expectedRevision: 0,
        conversion: { layerId: "geojson" },
        mapping: { layer: "buildings", target: { mode: "append" } },
        source: {
          name: "Fixture",
          license: "Test",
          privateUseConfirmed: true,
          publicRedistribution: false,
        },
      };
      prepared = {
        ...structuredClone(queued),
        id: "prepare-new",
        kind: "prepare",
        idempotencyKey: "prepare-key",
        requestKeys: ["prepare-key"],
        uploadId: completed.id,
        recipe,
      };
      delete prepared.upload;
      state.gisJobs.push(queued, completed);
      fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
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
            statement: "Isolated SQL fixture; no external cost.",
          },
        },
      };
    }
    function running(job: GisJobRecord): GisJobRecord {
      return {
        ...structuredClone(job),
        status: "running" as const,
        stage: "validating" as const,
        version: 2,
        attempt: 1,
        attempts: [attempt()],
        workerId: "gis-test-worker",
        leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
      };
    }
    async function as<T>(
      pool: pg.Pool,
      actor: string | undefined,
      purpose: string,
      fn: (c: pg.PoolClient) => Promise<T>,
    ) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const [k, v] of Object.entries({
          "urban.session_hash": actor ? session(actor) : "",
          "urban.purpose": purpose,
          "urban.project_id": "project-a",
        }))
          await c.query("SELECT set_config($1,$2,true)", [k, v]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    async function denied(c: pg.PoolClient, fn: () => Promise<unknown>) {
      await c.query("SAVEPOINT denied");
      let error: any;
      try {
        await fn();
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (e) {
        error = e;
      }
      await c.query("ROLLBACK TO SAVEPOINT denied");
      await c.query("RELEASE SAVEPOINT denied");
      expect(error).toBeDefined();
      expect(["42501", "23514", "23505", "55000"]).toContain(error.code);
    }
    async function insert(
      c: pg.PoolClient,
      collection: "gisJobs" | "imports",
      value: GisJobRecord | ImportRecord,
    ) {
      const r = encodeRecord(collection, value).row;
      return c.query(
        `INSERT INTO ${collection === "gisJobs" ? "app_gis_jobs" : "app_imports"}(id,organization_id,user_id,project_id,header,payload) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          r.id,
          r.indexes.organizationId,
          r.indexes.userId ?? null,
          r.indexes.projectId,
          JSON.stringify(r.header),
          JSON.stringify(r.payload),
        ],
      );
    }
    const update = (c: pg.PoolClient, j: GisJobRecord) => {
      const row = encodeRecord("gisJobs", j).row;
      return c.query(
        "UPDATE app_gis_jobs SET header=$2::jsonb,payload=$3::jsonb WHERE id=$1",
        [j.id, JSON.stringify(row.header), JSON.stringify(row.payload)],
      );
    };
    async function freeQueue(c: pg.PoolClient) {
      const cancelled = {
        ...structuredClone(queued),
        status: "cancelled" as const,
        cancelRequested: true,
        version: 2,
      };
      await update(c, cancelled);
    }
    it("upgrades the prior security policy without changing saved projects, sources or job records", async () => {
      const before = await fixture.operatorStore.read((state) => ({
        projects: state.projects,
        gisJobs: state.gisJobs,
      }));
      for (const migration of [
        "003-row-security.sql",
        "005-workforce-security.sql",
      ]) {
        const sql = (
          await readFile(
            new URL(`../migrations/${migration}`, import.meta.url),
            "utf8",
          )
        ).replaceAll("__SCHEMA__", `"${fixture.schema}"`);
        await fixture.admin.query(sql);
      }
      const c = await web.connect();
      try {
        await expect(assertPostgresRuntimeRole(c, "web")).rejects.toThrow(
          "migration",
        );
      } finally {
        c.release();
      }
      await fixture.operatorStore.migrate({
        ...fixture.roles,
        platformAdminUserIds: [],
      });
      expect(
        await fixture.operatorStore.read((state) => ({
          projects: state.projects,
          gisJobs: state.gisJobs,
        })),
      ).toEqual(before);
    });
    it("installs version17 and restricts job records to creator with current edit access", async () => {
      const c = await web.connect();
      try {
        expect(
          (await assertPostgresRuntimeRole(c, "web")).securityVersion,
        ).toBe(21);
      } finally {
        c.release();
      }
      await as(web, "owner", "", async (c) =>
        expect((await c.query("SELECT id FROM app_gis_jobs")).rowCount).toBe(2),
      );
      for (const id of ["peer", "viewer", "other"])
        await as(web, id, "worker.gis", async (c) =>
          expect((await c.query("SELECT id FROM app_gis_jobs")).rowCount).toBe(
            0,
          ),
        );
      for (const purpose of [
        "worker.prep",
        "worker.workforce",
        "worker.budget",
      ])
        await as(worker, undefined, purpose, async (c) =>
          expect((await c.query("SELECT id FROM app_gis_jobs")).rowCount).toBe(
            0,
          ),
        );
      await as(auth, "owner", "auth.login", (c) =>
        denied(c, () => c.query("SELECT id FROM app_gis_jobs")),
      );
    });
    it("rejects fabricated GIS audit entries and accepts an exact cancellation audit atomically", async () => {
      await as(web, "owner", "", async (c) => {
        const writeAudit = () =>
          c.query(
            "INSERT INTO app_audit(id,organization_id,project_id,header) VALUES('gis-audit','org-a','project-a',$1::jsonb)",
            [
              JSON.stringify({
                id: "gis-audit",
                organizationId: "org-a",
                projectId: "project-a",
                actorId: "owner",
                at,
                action: "gis.cancelled",
                details: { jobId: queued.id },
              }),
            ],
          );
        await denied(c, writeAudit);
        await update(c, {
          ...queued,
          status: "cancelled",
          cancelRequested: true,
          version: 2,
        });
        await writeAudit();
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      });
    });
    it("requires exact saved baseline, upload ownership and project revision on admission", async () => {
      await as(worker, "owner", "worker.gis", async (c) => {
        await freeQueue(c);
        expect((await insert(c, "gisJobs", prepared)).rowCount).toBe(1);
      });
      for (const patch of [
        { projectVersion: 2 },
        { baselineHash: "f".repeat(64) },
        { userId: "peer" },
        { uploadId: "inspect-queued" },
        { organizationId: "org-b" },
      ])
        await as(worker, "owner", "worker.gis", async (c) => {
          await freeQueue(c);
          await denied(c, () =>
            insert(c, "gisJobs", { ...prepared, ...patch }),
          );
        });
      await as(web, "owner", "worker.gis", (c) =>
        denied(c, () => insert(c, "gisJobs", prepared)),
      );
    });
    it("permits exact cancellation but rejects client completion, changed recipes and foreign cancellation", async () => {
      await as(web, "owner", "", async (c) => {
        expect(
          (
            await update(c, {
              ...queued,
              status: "cancelled",
              cancelRequested: true,
              version: 2,
            })
          ).rowCount,
        ).toBe(1);
      });
      await as(web, "peer", "", async (c) =>
        expect(
          (
            await update(c, {
              ...queued,
              status: "cancelled",
              cancelRequested: true,
              version: 2,
            })
          ).rowCount,
        ).toBe(0),
      );
      await as(web, "owner", "", async (c) => {
        await denied(c, () => update(c, running(queued)));
        await denied(c, () =>
          update(c, {
            ...queued,
            status: "cancelled",
            cancelRequested: true,
            version: 2,
            upload: { ...queued.upload!, sha256: "f".repeat(64) },
          }),
        );
      });
    });
    it("grants full project/baseline only to an active uncancelled prepare job and segregates other worker purposes", async () => {
      await as(worker, "owner", "worker.gis", async (c) => {
        await denied(c, () =>
          c.query("SELECT app_security_gis_project_payload('project-a')"),
        );
        await freeQueue(c);
        await insert(c, "gisJobs", prepared);
        const current = running(prepared);
        await update(c, current);
        expect(
          (
            await c.query(
              "SELECT app_security_gis_project_payload('project-a') AS payload",
            )
          ).rows[0].payload.project.id,
        ).toBe("project-a");
        expect(
          (
            await c.query("SELECT app_security_gis_baseline($1) AS payload", [
              baselineHash,
            ])
          ).rows[0].payload.id,
        ).toBe(workforcePlaceFixture.id);
        await denied(c, () => c.query("SELECT payload FROM app_projects"));
        await denied(c, () =>
          c.query("SELECT app_security_gis_project_payload('project-b')"),
        );
        expect(
          (await c.query("UPDATE app_budget SET header=header")).rowCount,
        ).toBe(0);
        await c.query(
          "SELECT set_config('urban.purpose','worker.workforce',true)",
        );
        await denied(c, () =>
          c.query("SELECT app_security_gis_project_payload('project-a')"),
        );
        await c.query("SELECT set_config('urban.purpose','worker.gis',true)");
        await update(c, { ...current, cancelRequested: true, version: 3 });
        await denied(c, () =>
          c.query("SELECT app_security_gis_baseline($1)", [baselineHash]),
        );
      });
    });
    it("rejects orphan completion and immutable input/attempt substitutions", async () => {
      await as(worker, "owner", "worker.gis", async (c) => {
        await freeQueue(c);
        await insert(c, "gisJobs", prepared);
        const current = running(prepared);
        await update(c, current);
        await denied(c, () =>
          update(c, {
            ...current,
            recipe: { ...current.recipe!, expectedVersion: 99 },
          }),
        );
        const changed = structuredClone(current);
        changed.attempts[0].admission.budgetPolicyVersion = 99;
        await denied(c, () => update(c, changed));
        const done: GisJobRecord = {
          ...current,
          status: "completed" as const,
          stage: "complete" as const,
          version: 3,
          result: { importId: "missing", previewHash: "d".repeat(64) },
        };
        delete done.workerId;
        delete done.leaseExpiresAt;
        done.attempts[0].endedAt = at;
        done.attempts[0].outcome = "completed";
        await denied(c, () => update(c, done));
      });
    });
    it("requires atomic matching preview completion and preserves all staged geometry and provenance", async () => {
      await as(worker, "owner", "worker.gis", async (c) => {
        await freeQueue(c);
        await insert(c, "gisJobs", prepared);
        const current = running(prepared);
        await update(c, current);
        const staged: ImportRecord = {
          id: "preview-1",
          organizationId: "org-a",
          projectId: "project-a",
          createdBy: "owner",
          createdAt: at,
          expiresAt: "2099-01-01T00:00:00Z",
          source: workforcePlaceFixture.sources[0],
          warnings: [],
          buildings: [],
          prepared: {
            mode: "append",
            preview: {
              jobId: prepared.id,
              uploadId: prepared.uploadId!,
              projectId: prepared.projectId,
              scenarioId: prepared.scenarioId,
              expectedVersion: 1,
              expectedRevision: 0,
              baselineIdentity: {
                version: 1,
                sha256: baselineHash,
                placeId: workforcePlaceFixture.id,
              },
              previewHash: "d".repeat(64),
              featureCount: 0,
              extentChecked: true,
              expiresAt: "2099-01-01T00:00:00Z",
              changes: { added: 0, updated: 0, overlaps: [] },
              diagnostics: {
                inputFeatures: 0,
                selectedFeatures: 0,
                outputFeatures: 0,
                excludedFeatures: 0,
                vertices: 0,
                warnings: [],
              },
            },
          },
        };
        await denied(c, () =>
          insert(c, "imports", { ...staged, createdBy: "peer" }),
        );
        await insert(c, "imports", staged);
        const done: GisJobRecord = {
          ...current,
          status: "completed" as const,
          stage: "complete" as const,
          version: 3,
          result: { importId: staged.id, previewHash: "d".repeat(64) },
        };
        delete done.workerId;
        delete done.leaseExpiresAt;
        done.attempts[0].endedAt = at;
        done.attempts[0].outcome = "completed";
        await update(c, done);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await c.query(
              "UPDATE app_imports SET header=jsonb_set(header,'{warnings}','[\"forged\"]') WHERE id='preview-1'",
            )
          ).rowCount,
        ).toBe(0);
        await denied(c, () => update(c, { ...done, inspection: {} as never }));
      });
    });
  },
);

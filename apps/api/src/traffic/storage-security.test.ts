import { enableReviewedBudgetForFixture } from "../budget-test-fixture.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { trafficScenarioFixture } from "../../../../tests/fixtures/traffic";
import {
  trafficCountFixture,
  trafficDemandFixture,
} from "../../../../packages/core/src/traffic-fixture";
import {
  trafficContentHash,
  applyCommand,
  projectWithTrafficVersion,
} from "@urban/core";
import { emptyState } from "../store";
import { encodeRecord } from "../storage-core";
import { tokenHash } from "../security";
import { createPostgresSecurityFixture } from "../postgres-security-fixture";
import type {
  TrafficConfigurationRecord,
  TrafficJobRecord,
  TrafficArtifactRecord,
} from "./jobs-types";
import {
  acquireNativeCapacity,
  releaseNativeCapacity,
} from "../native-capacity";
import { PostgresStore } from "../postgres-store";

const at = "2026-11-06T00:00:00Z",
  session = (id: string) => tokenHash(`traffic-authority:${id}`);
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "traffic authority and shared native SQL slot",
  () => {
    let fixture: Awaited<ReturnType<typeof createPostgresSecurityFixture>>,
      sample: Awaited<ReturnType<typeof trafficScenarioFixture>>,
      config: TrafficConfigurationRecord,
      queued: TrafficJobRecord,
      web: pg.Pool,
      worker: pg.Pool;
    beforeAll(async () => {
      sample = await trafficScenarioFixture();
      const state = emptyState();
      enableReviewedBudgetForFixture(state.budget);
      for (const [id, org, role] of [
        ["owner", "org-a", "owner"],
        ["viewer", "org-a", "viewer"],
        ["other", "org-b", "owner"],
      ] as const) {
        state.users.push({
          id,
          email: `${id}@traffic-authority.test`,
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
      state.projects.push({
        project: sample.project,
        baseline: sample.place,
        organizationId: "org-a",
        version: 1,
        createdBy: "owner",
        createdAt: at,
      });
      const request = {
        version: 1 as const,
        networkHash: sample.capture.network.baselineFileSha256,
        countPack: trafficCountFixture(),
        demand: trafficDemandFixture(),
        period: sample.capture.recipe.period,
        seed: 1,
        overlays: [],
        calibrationPlan: null,
        unsupportedChanges: [],
      };
      config = {
        id: "config",
        organizationId: "org-a",
        projectId: sample.project.id,
        scenarioId: sample.scenario.id,
        userId: "owner",
        createdAt: at,
        projectVersion: 1,
        scenarioRevision: 0,
        baselineHash: sample.traffic.binding.baselineHash,
        roadEditsHash: sample.traffic.binding.roadEditsHash,
        prepared: {
          id: "prepared",
          placeId: sample.place.id,
          studyAreaHash: "1".repeat(64),
          networkHash: sample.capture.network.baselineFileSha256,
          inventoryHash: "2".repeat(64),
          sourceEnvelope: sample.capture.network.bounds,
          bufferMeters: 1000,
          methodVersion: "1.0.0",
          workerHash: "3".repeat(64),
        },
        request,
        requestHash: await trafficContentHash(request),
        submissionHash: await trafficContentHash(request),
        uploadIds: [],
        uploadBindings: [],
        idempotencyKey: "config-key",
        scopeAcknowledged: true,
      };
      queued = {
        id: "fixture-job",
        organizationId: "org-a",
        projectId: sample.project.id,
        scenarioId: sample.scenario.id,
        userId: "owner",
        configurationId: config.id,
        projectVersion: 1,
        scenarioRevision: 0,
        baselineHash: config.baselineHash,
        roadEditsHash: config.roadEditsHash,
        requestHash: config.requestHash,
        prepared: config.prepared,
        version: 1,
        status: "queued",
        stage: "queued",
        progress: 0,
        attempt: 0,
        attempts: [],
        createdAt: at,
        updatedAt: at,
        cancelRequested: false,
        idempotencyKey: "job-key",
        requestKeys: ["job-key"],
      };
      state.trafficConfigs.push(config);
      state.trafficJobs.push(queued);
      fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
      web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
      worker = new pg.Pool({ connectionString: fixture.workerURL, max: 1 });
    }, 30000);
    afterAll(async () => {
      await Promise.all([web?.end(), worker?.end()]);
      await fixture?.close();
    }, 30000);
    async function as<T>(
      pool: pg.Pool,
      actor: string | undefined,
      purpose: string,
      fn: (c: pg.PoolClient) => Promise<T>,
      commit = false,
    ) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('urban.session_hash',$1,true),set_config('urban.purpose',$2,true),set_config('urban.project_id',$3,true)",
          [actor ? session(actor) : "", purpose, sample.project.id],
        );
        const result = await fn(c);
        if (commit) await c.query("COMMIT");
        return result;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    async function denied(c: pg.PoolClient, fn: () => Promise<unknown>) {
      await c.query("SAVEPOINT denied");
      let error: unknown;
      try {
        await fn();
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (e) {
        error = e;
      }
      await c.query("ROLLBACK TO SAVEPOINT denied");
      await c.query("RELEASE SAVEPOINT denied");
      expect(error).toBeDefined();
    }
    async function write(
      c: pg.PoolClient,
      collection: "trafficArtifacts" | "trafficConfigs",
      value: unknown,
    ) {
      const row = encodeRecord(collection, value).row;
      return c.query(
        `INSERT INTO ${collection === "trafficArtifacts" ? "app_traffic_artifacts" : "app_traffic_configs"}(id,organization_id,user_id,project_id,header,payload) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          row.id,
          row.indexes.organizationId,
          row.indexes.userId ?? null,
          row.indexes.projectId,
          JSON.stringify(row.header),
          JSON.stringify(row.payload),
        ],
      );
    }
    function running(): TrafficJobRecord {
      return {
        ...structuredClone(queued),
        status: "running",
        stage: "validating",
        progress: 5,
        version: 2,
        attempt: 1,
        attempts: [
          {
            number: 1,
            startedAt: new Date().toISOString(),
            admission: {
              budgetPolicyVersion: 1,
              period: "2026-11",
              incrementalExternalCents: 0,
              costModel: {
                mode: "fixed-capacity",
                environment: "local-development",
                statement: "Isolated authority fixture only.",
              },
            },
          },
        ],
        workerId: "native-test",
        capacityToken: "capacity-test-token",
        leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
    async function claim(c: pg.PoolClient) {
      const job = running();
      const now = new Date().toISOString();
      await c.query(
        "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','1'),'{slot}',$1::jsonb)",
        [
          JSON.stringify({
            token: job.capacityToken,
            kind: "traffic",
            jobId: job.id,
            workerId: job.workerId,
            acquiredAt: now,
            heartbeatAt: now,
            hardDeadlineAt: new Date(Date.now() + 180000).toISOString(),
            status: "running",
          }),
        ],
      );
      await c.query(
        "UPDATE app_traffic_jobs SET header=$1::jsonb WHERE id=$2",
        [JSON.stringify(job), job.id],
      );
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      await c.query("SET CONSTRAINTS ALL DEFERRED");
      return job;
    }
    it("denies cross-project reads and capability spoofing without hydrating configuration payloads", async () => {
      await as(web, "other", "", async (c) =>
        expect(
          (await c.query("SELECT id FROM app_traffic_configs")).rows,
        ).toEqual([]),
      );
      await as(web, "owner", "worker.traffic", async (c) => {
        expect(
          (await c.query("SELECT id FROM app_traffic_jobs")).rows,
        ).toHaveLength(1);
        await denied(c, () =>
          c.query(
            "UPDATE app_traffic_jobs SET header=jsonb_set(header,'{status}','\"completed\"')",
          ),
        );
      });
      await as(web, "owner", "", async (c) =>
        denied(c, () =>
          write(c, "trafficConfigs", {
            ...config,
            id: "web-forged",
            idempotencyKey: "web-forged",
          }),
        ),
      );
      for (const purpose of [
        "worker.gis",
        "worker.workforce",
        "worker.prep",
        "worker.budget",
      ])
        await as(worker, undefined, purpose, async (c) =>
          expect(
            (await c.query("SELECT id FROM app_traffic_jobs")).rows,
          ).toEqual([]),
        );
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
      });
      try {
        await store.initialize();
        store.diagnostics(true);
        const headers = await store.read((s) => s.trafficConfigHeaders, {
          auth: { sessionHash: session("owner") },
          trafficConfigHeaders: { where: [{ projectId: sample.project.id }] },
        });
        expect(headers[0]).not.toHaveProperty("request");
        expect(store.diagnostics().payloadBytes).toBeLessThan(5000);
      } finally {
        await store.close();
      }
    });
    it("requires an exact shared slot before a native claim; another purpose cannot release it", async () => {
      await as(worker, undefined, "worker.traffic", async (c) => {
        await denied(c, () =>
          c.query("UPDATE app_traffic_jobs SET header=$1::jsonb WHERE id=$2", [
            JSON.stringify(running()),
            queued.id,
          ]),
        );
        await claim(c);
        await denied(c, () =>
          c.query(
            "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','2'),'{slot}','null')",
          ),
        );
        await c.query("SELECT set_config('urban.purpose','worker.gis',true)");
        await denied(c, () =>
          c.query(
            "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','2'),'{slot}','null')",
          ),
        );
      });
    });
    it("keeps reviewed configuration immutable and rejects an upload from another project", async () => {
      await as(worker, "owner", "worker.traffic", async (c) => {
        await denied(c, () =>
          c
            .query(
              "UPDATE app_traffic_configs SET payload=jsonb_set(payload,'{request,seed}','2') WHERE id='config'",
            )
            .then((r) => {
              if (!r.rowCount) throw new Error("denied");
            }),
        );
        await denied(c, () =>
          write(c, "trafficConfigs", {
            ...config,
            id: "foreign-upload",
            idempotencyKey: "foreign-upload",
            uploadIds: ["not-this-project"],
          }),
        );
        await write(c, "trafficConfigs", {
          ...config,
          id: "new-config",
          idempotencyKey: "new-config",
        });
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      });
    });
    it("rejects missing slot status and preserves quarantine against a late owning worker", async () => {
      await as(worker, undefined, "worker.traffic", async (c) => {
        await claim(c);
        await denied(c, () =>
          c.query(
            "UPDATE app_native_capacity SET header=jsonb_set(header,'{revision}','2') #- '{slot,status}'",
          ),
        );
        await c.query(
          "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','2'),'{slot,status}','\"quarantined\"')",
        );
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        await denied(c, () =>
          c.query(
            "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','3'),'{slot}','null')",
          ),
        );
        expect(
          (
            await c.query(
              "SELECT header->'slot'->>'status' AS status FROM app_native_capacity",
            )
          ).rows[0].status,
        ).toBe("quarantined");
      });
    });
    it("atomically completes an authoritative artifact and permits only its exact compact evidence in saved content", async () => {
      await as(
        worker,
        undefined,
        "worker.traffic",
        async (c) => {
          const job = await claim(c);
          const traffic = structuredClone(sample.traffic);
          const artifact: TrafficArtifactRecord = {
            id: "fixture-capture",
            organizationId: "org-a",
            projectId: sample.project.id,
            scenarioId: sample.scenario.id,
            jobId: job.id,
            configurationId: config.id,
            createdAt: at,
            traffic,
          };
          await denied(c, () =>
            write(c, "trafficArtifacts", {
              ...artifact,
              id: "wrong",
              traffic: {
                ...traffic,
                receipt: { ...traffic.receipt, captureId: "wrong" },
              },
            }),
          );
          const completed = {
            ...job,
            status: "completed",
            stage: "complete",
            progress: 100,
            version: 3,
            result: {
              artifactId: artifact.id,
              captureHash: traffic.captureHash,
              archive: traffic.capture.privateArchive,
            },
            attempts: job.attempts.map((a) => ({
              ...a,
              endedAt: new Date().toISOString(),
              outcome: "completed",
            })),
          };
          delete (completed as Partial<TrafficJobRecord>).workerId;
          delete (completed as Partial<TrafficJobRecord>).leaseExpiresAt;
          await c.query(
            "UPDATE app_traffic_jobs SET header=$1::jsonb WHERE id=$2",
            [JSON.stringify(completed), job.id],
          );
          await write(c, "trafficArtifacts", artifact);
          await c.query(
            "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{revision}','2'),'{slot}','null')",
          );
          await c.query("SET CONSTRAINTS ALL IMMEDIATE");
          await c.query(
            "SELECT set_config('urban.session_hash',$1,true),set_config('urban.purpose','',true)",
            [session("owner")],
          );
          // The worker credential cannot become the web role by clearing its purpose.
          await denied(c, () =>
            c
              .query("UPDATE app_projects SET payload=payload WHERE id=$1", [
                sample.project.id,
              ])
              .then((r) => {
                if (!r.rowCount) throw new Error("denied");
              }),
          );
        },
        true,
      );
      await as(web, "owner", "", async (c) => {
        const project = projectWithTrafficVersion({
          ...structuredClone(sample.project),
          scenarios: sample.project.scenarios.map((s) =>
            s.id === sample.scenario.id
              ? applyCommand(s, {
                  type: "scenario.traffic",
                  traffic: sample.traffic,
                })
              : s,
          ),
        });
        const row = encodeRecord("projects", {
          project,
          baseline: sample.place,
          organizationId: "org-a",
          version: 2,
          createdBy: "owner",
          createdAt: at,
        }).row;
        await c.query(
          "UPDATE app_projects SET header=$1::jsonb,payload=$2::jsonb WHERE id=$3",
          [
            JSON.stringify(row.header),
            JSON.stringify(row.payload),
            sample.project.id,
          ],
        );
        expect(
          (
            await c.query(
              "SELECT payload->'project'->'scenarios'->1->'traffic' AS traffic FROM app_projects WHERE id=$1",
              [sample.project.id],
            )
          ).rows[0].traffic,
        ).toEqual(sample.traffic);
        const forged = structuredClone(project);
        forged.scenarios[1].traffic!.capture.comparison.baseline.meanTravelTimeSeconds = 9999;
        const bad = encodeRecord("projects", {
          project: forged,
          baseline: sample.place,
          organizationId: "org-a",
          version: 3,
          createdBy: "owner",
          createdAt: at,
        }).row;
        await denied(c, () =>
          c.query(
            "UPDATE app_projects SET header=$1::jsonb,payload=$2::jsonb WHERE id=$3",
            [
              JSON.stringify(bad.header),
              JSON.stringify(bad.payload),
              sample.project.id,
            ],
          ),
        );
      });
    });
  },
);

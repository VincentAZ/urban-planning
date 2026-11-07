import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { projectWithImportedWorkforce } from "@urban/core";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import { emptyState } from "./store.js";
import { buildApp } from "./app.js";
import { WorkforceJobService } from "./workforce-jobs.js";
import { FixtureWorkforceExecutor } from "./workforce-jobs-fixture.js";
import type {
  WorkforceJobResult,
  WorkforceAdoptResponse,
} from "./workforce-jobs-types.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "workforce jobs through restricted PostgreSQL API roles",
  () => {
    it("admits, runs, adopts and publishes owned evidence while rejecting foreign receipts and preserving imported copies", async () => {
      const state = emptyState();
      enableReviewedBudgetForFixture(state.budget);
      const fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
      const directory = await mkdtemp(join(tmpdir(), "workforce-pg-"));
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 2,
      });
      let app: FastifyInstance | undefined;
      try {
        await store.initialize();
        const service = new WorkforceJobService(store, {
          enabled: true,
          executor: new FixtureWorkforceExecutor(),
          automaticWorker: false,
          archiveDirectory: join(directory, "archive"),
          capacity: {
            mode: "fixed-capacity",
            environment: "local-development",
            statement:
              "Existing isolated local test capacity, not production validation.",
          },
        });
        app = await buildApp({
          store,
          workforceService: service,
          nationalPreparationEnabled: false,
          catalog: {
            list: async () => [workforcePlaceFixture],
            get: async () => workforcePlaceFixture,
          },
        });
        async function register(name: string) {
          const response = await app!.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              name,
              email: `${name}@workforce-pg.test`,
              password: "restricted workforce test password",
            },
          });
          expect(response.statusCode, response.body).toBe(201);
          return {
            cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
            "x-csrf-token": response.json().csrfToken as string,
          };
        }
        const owner = await register("owner"),
          outsider = await register("outsider");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner,
          payload: { placeId: workforcePlaceFixture.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        const initial = created.json(),
          base = `/api/v1/projects/${initial.project.id}`,
          jobs = `${base}/workforce/jobs`;
        const input = {
          scenarioId: initial.project.activeScenarioId,
          expectedVersion: 1,
          expectedRevision: 0,
          idempotencyKey: "pg-workforce-request-1",
          request: {
            site: workforcePlaceFixture.center,
            mode: "car",
            direction: "inbound",
            thresholdsMinutes: [15, 30, 45],
          },
        };
        const posted = await app.inject({
          method: "POST",
          url: jobs,
          headers: owner,
          payload: input,
        });
        expect(posted.statusCode, posted.body).toBe(201);
        const id = posted.json().job.id;
        await service.runOne();
        const status = await app.inject({
          url: `${jobs}/${id}`,
          headers: owner,
        });
        expect(status.json().job.status, status.body).toBe("completed");
        const resultResponse = await app.inject({
          url: `${jobs}/${id}/result`,
          headers: owner,
        });
        expect(resultResponse.statusCode, resultResponse.body).toBe(200);
        const result = resultResponse.json<WorkforceJobResult>();
        expect(
          (await app.inject({ url: `${jobs}/${id}/result`, headers: outsider }))
            .statusCode,
        ).toBe(404);
        const adopted = await app.inject({
          method: "POST",
          url: `${jobs}/${id}/adopt`,
          headers: owner,
          payload: {
            scenarioId: input.scenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            inputHash: result.workforce.capture.inputHash,
            resultHash: result.workforce.capture.resultHash,
          },
        });
        expect(adopted.statusCode, adopted.body).toBe(200);
        const saved = adopted.json<WorkforceAdoptResponse>();
        expect(saved.project.schemaVersion).toBe(7);
        expect(saved.project.scenarios[1].workforce?.origin).toBe("server-run");
        const changed = structuredClone(saved.project);
        changed.history[0].after.workforce!.capture.notes.push("forged");
        const rejected = await app.inject({
          method: "PUT",
          url: base,
          headers: owner,
          payload: { expectedVersion: 2, project: changed },
        });
        expect(rejected.statusCode, rejected.body).toBe(422);
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner,
          payload: { scenarioId: input.scenarioId, expectedRevision: 1 },
        });
        expect(published.statusCode, published.body).toBe(201);
        const imported = projectWithImportedWorkforce(
          structuredClone(saved.project),
        );
        const copied = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner,
          payload: {
            project: imported,
            baselineHash: saved.baselineIdentity.sha256,
          },
        });
        expect(copied.statusCode, copied.body).toBe(201);
        expect(copied.json().project.scenarios[1].workforce.origin).toBe(
          "imported",
        );
        const foreign = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${copied.json().project.id}/scenarios/${input.scenarioId}/commands`,
          headers: owner,
          payload: {
            expectedVersion: 1,
            expectedRevision: 1,
            command: {
              type: "scenario.workforce",
              workforce: result.workforce,
            },
          },
        });
        expect(foreign.statusCode, foreign.body).toBe(422);
        const counts = await fixture.admin.query(
          "SELECT (SELECT count(*) FROM app_workforce_jobs)::int jobs,(SELECT count(*) FROM app_workforce_artifacts)::int artifacts",
        );
        expect(counts.rows[0]).toEqual({ jobs: 1, artifacts: 1 });
        const full = await app.inject({
          url: `${jobs}/${id}/artifact`,
          headers: owner,
        });
        expect(full.statusCode).toBe(200);
        expect(full.json().run.rows).toHaveLength(2);
        await expect(
          fixture.admin.query(
            "UPDATE app_workforce_artifacts SET header=header||'{\"siteSnapMeters\":0}'",
          ),
        ).rejects.toThrow(/Immutable/);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

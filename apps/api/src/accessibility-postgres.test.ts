import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { projectWithImportedAccessibility } from "@urban/core";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import { emptyState } from "./store.js";
import { buildApp } from "./app.js";
import { AccessibilityJobService } from "./accessibility-jobs.js";
import { FixtureAccessibilityExecutor } from "./accessibility-jobs-fixture.js";
import type {
  AccessibilityJobResult,
  AccessibilityAdoptResponse,
} from "./accessibility-jobs-types.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "accessibility jobs through restricted PostgreSQL API roles",
  () => {
    it("admits, runs, adopts and publishes owned evidence while rejecting foreign receipts and preserving imported copies", async () => {
      const state = emptyState();
      enableReviewedBudgetForFixture(state.budget);
      const fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
      const directory = await mkdtemp(join(tmpdir(), "accessibility-pg-"));
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 2,
      });
      let app: FastifyInstance | undefined;
      try {
        await store.initialize();
        const service = new AccessibilityJobService(store, {
          enabled: true,
          executor: new FixtureAccessibilityExecutor(),
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
          accessibilityService: service,
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
              email: `${name}@accessibility-pg.test`,
              password: "restricted accessibility test password",
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
          jobs = `${base}/accessibility/jobs`;
        const input = {
          scenarioId: initial.project.activeScenarioId,
          expectedVersion: 1,
          expectedRevision: 0,
          idempotencyKey: "pg-accessibility-request-1",
          request: {
            site: workforcePlaceFixture.center,
            mode: "car",
            direction: "outbound",
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
        const result = resultResponse.json<AccessibilityJobResult>();
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
            inputHash: result.accessibility.capture.inputHash,
            resultHash: result.accessibility.capture.resultHash,
          },
        });
        expect(adopted.statusCode, adopted.body).toBe(200);
        const saved = adopted.json<AccessibilityAdoptResponse>();
        expect(saved.project.schemaVersion).toBe(10);
        expect(
          saved.project.scenarios[1].accessibility!.captures.car?.origin,
        ).toBe("server-run");
        const changed = structuredClone(saved.project);
        changed.history[0].after.accessibility!.captures.car!.capture.notes.push(
          "forged",
        );
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
        const clonedProject = structuredClone(saved.project),
          clone = structuredClone(saved.project.scenarios[1]);
        clone.id = "same-project-context-copy";
        clone.name = "Captured context copy";
        clonedProject.scenarios.push(clone);
        const cloneSave = await app.inject({
          method: "PUT",
          url: base,
          headers: owner,
          payload: { expectedVersion: 2, project: clonedProject },
        });
        expect(cloneSave.statusCode, cloneSave.body).toBe(200);
        const clonePublish = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner,
          payload: { scenarioId: clone.id, expectedRevision: clone.revision },
        });
        expect(clonePublish.statusCode, clonePublish.body).toBe(201);
        const imported = projectWithImportedAccessibility(
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
        expect(
          copied.json().project.scenarios[1].accessibility!.captures.car.origin,
        ).toBe("imported");
        const foreign = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${copied.json().project.id}/scenarios/${input.scenarioId}/commands`,
          headers: owner,
          payload: {
            expectedVersion: 1,
            expectedRevision: 1,
            command: {
              type: "scenario.accessibility",
              mode: "car",
              evidence: result.accessibility,
            },
          },
        });
        expect(foreign.statusCode, foreign.body).toBe(422);
        const counts = await fixture.admin.query(
          "SELECT (SELECT count(*) FROM app_accessibility_jobs)::int jobs,(SELECT count(*) FROM app_accessibility_artifacts)::int artifacts",
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
            "UPDATE app_accessibility_artifacts SET header=header||'{\"siteSnapMeters\":0}'",
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

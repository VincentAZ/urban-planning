import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import { emptyState } from "./store.js";
import { buildApp } from "./app.js";
import { GisJobService } from "./gis-jobs.js";
import { FixtureGisRuntime } from "./gis-jobs-fixture.js";
import type { GisPreview } from "./gis-jobs-types.js";
import { tokenHash } from "./security.js";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "GIS through restricted PostgreSQL API roles",
  () => {
    it("inspects, prepares, commits and exports privately with exact frozen preview and current access checks", async () => {
      const state = emptyState();
      enableReviewedBudgetForFixture(state.budget);
      const fixture = await createPostgresSecurityFixture(
          process.env.TEST_DATABASE_URL!,
          { state },
        ),
        directory = await mkdtemp(join(tmpdir(), "gis-pg-"));
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 2,
      });
      let app: FastifyInstance | undefined;
      try {
        await store.initialize();
        const service = new GisJobService(store, {
          enabled: true,
          runtime: new FixtureGisRuntime(),
          archiveDirectory: join(directory, "archive"),
          automaticWorker: false,
          capacity: {
            mode: "fixed-capacity",
            environment: "local-development",
            statement:
              "Isolated existing local test capacity; no production cost claim.",
          },
        });
        app = await buildApp({
          store,
          gisService: service,
          nationalPreparationEnabled: false,
          catalog: {
            list: async () => [workforcePlaceFixture],
            get: async () => workforcePlaceFixture,
          },
        });
        async function register(name: string) {
          const r = await app!.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              name,
              email: `${name}@gis-pg.test`,
              password: "GIS PostgreSQL isolated test password",
            },
          });
          expect(r.statusCode, r.body).toBe(201);
          return {
            id: r.json().user.id,
            headers: {
              cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
              "x-csrf-token": r.json().csrfToken as string,
            },
            sessionHash: tokenHash(r.cookies[0].value),
          };
        }
        const owner = await register("owner"),
          other = await register("other");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: workforcePlaceFixture.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        const saved = created.json(),
          base = `/api/v1/projects/${saved.project.id}`,
          imports = `${base}/imports`,
          submission = {
            scenarioId: saved.project.activeScenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            idempotencyKey: "gis-pg-upload",
          };
        const data = {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "local",
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
              properties: { height: 0, name: "Imported office" },
            },
          ],
        };
        const boundary = "gis-pg-multipart",
          payload = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(submission)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="local.geojson"\r\nContent-Type: application/geo+json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--\r\n`,
          );
        const uploaded = await app.inject({
          method: "POST",
          url: `${imports}/uploads`,
          headers: {
            ...owner.headers,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload,
        });
        expect(uploaded.statusCode, uploaded.body).toBe(202);
        const uploadId = uploaded.json().job.id;
        await service.runOne();
        let result = await app.inject({
          url: `${imports}/jobs/${uploadId}`,
          headers: owner.headers,
        });
        expect(result.json().job.status, result.body).toBe("completed");
        const queued = await app.inject({
          method: "POST",
          url: `${imports}/uploads/${uploadId}/preview`,
          headers: owner.headers,
          payload: {
            ...submission,
            idempotencyKey: "gis-pg-prepare",
            conversion: { layerId: "fixture" },
            mapping: {
              layer: "buildings",
              target: { mode: "append" },
              use: { kind: "constant", value: "office" },
              name: { kind: "field", field: "name" },
              quantities: { height: { kind: "field", field: "height" } },
            },
            source: {
              name: "Private synthetic source",
              license: "Fixture only",
              privateUseConfirmed: true,
              publicRedistribution: false,
            },
          },
        });
        expect(queued.statusCode, queued.body).toBe(202);
        const jobId = queued.json().job.id;
        await service.runOne();
        result = await app.inject({
          url: `${imports}/jobs/${jobId}`,
          headers: owner.headers,
        });
        expect(result.json().job.status, result.body).toBe("completed");
        const response = await app.inject({
          url: `${imports}/jobs/${jobId}/preview`,
          headers: owner.headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        const preview = response.json<GisPreview>();
        expect(
          preview.layer === "buildings" && preview.buildings[0].jobs,
        ).toBeNull();
        for (const path of [
          `${imports}/jobs/${jobId}`,
          `${imports}/jobs/${jobId}/preview`,
          `${imports}/uploads/${uploadId}/file`,
        ])
          expect(
            (await app.inject({ url: path, headers: other.headers }))
              .statusCode,
          ).toBe(404);
        const web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
        const c = await web.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('urban.session_hash',$1,true)", [
            owner.sessionHash,
          ]);
          await expect(
            c.query(
              "UPDATE app_imports SET header=jsonb_set(header,'{warnings}','[\"forged\"]') WHERE id=$1",
              [preview.importId],
            ),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await c.query("ROLLBACK");
          c.release();
          await web.end();
        }
        const commit = await app.inject({
          method: "POST",
          url: `${imports}/${preview.importId}/commit`,
          headers: owner.headers,
          payload: {
            scenarioId: preview.scenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            previewHash: preview.previewHash,
            acknowledgeWarnings: true,
          },
        });
        expect(commit.statusCode, commit.body).toBe(200);
        expect(commit.json().project.schemaVersion).toBe(8);
        expect(commit.json().version).toBe(2);
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project.history).toHaveLength(1);
        const pub = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: {
            scenarioId: preview.scenarioId,
            expectedVersion: 2,
            expectedRevision: 1,
          },
        });
        expect(pub.statusCode, pub.body).toBe(422);
        const exported = await app.inject({
          method: "POST",
          url: `${imports}/exports/shapefile`,
          headers: owner.headers,
          payload: {
            ...submission,
            expectedVersion: 2,
            expectedRevision: 1,
            idempotencyKey: "gis-pg-export",
          },
        });
        expect(exported.statusCode, exported.body).toBe(202);
        await service.runOne();
        const exportId = exported.json().job.id;
        result = await app.inject({
          url: `${imports}/jobs/${exportId}`,
          headers: owner.headers,
        });
        expect(result.json().job.status, result.body).toBe("completed");
        const download = await app.inject({
          url: `${imports}/jobs/${exportId}/download`,
          headers: owner.headers,
        });
        expect(download.statusCode, download.body).toBe(200);
        expect(JSON.parse(download.body).manifest.projectVersion).toBe(2);
        await fixture.operatorStore.transaction((s) => {
          s.memberships = s.memberships.filter((m) => m.userId !== owner.id);
        });
        expect([401, 403, 404]).toContain(
          (
            await app.inject({
              url: `${imports}/jobs/${exportId}/download`,
              headers: owner.headers,
            })
          ).statusCode,
        );
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import { emptyState } from "./store.js";
import { buildApp } from "./app.js";
import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { MediaJobService } from "./media-jobs.js";
import { FixtureMediaExecutor } from "./media-test-fixture.js";
import { workforcePlaceFixture as place } from "../../../tests/fixtures/workforce.js";
import { tokenHash } from "./security.js";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "media restricted PostgreSQL lifecycle",
  () => {
    it("freezes saved scene, enforces raw role boundaries and atomically retains downloadable output", async () => {
      const state = emptyState();
      enableReviewedBudgetForFixture(state.budget);
      const fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
      const directory = await mkdtemp(join(tmpdir(), "media-pg-"));
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
      });
      let app: Awaited<ReturnType<typeof buildApp>> | undefined;
      const worker = new pg.Pool({
          connectionString: fixture.workerURL,
          max: 1,
        }),
        web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
      try {
        await store.initialize();
        const executor = new FixtureMediaExecutor(),
          service = new MediaJobService(store, {
            enabled: true,
            executor,
            archiveDirectory: join(directory, "archive"),
            automaticWorker: false,
            capacity: {
              mode: "fixed-capacity",
              environment: "local-development",
              statement: "Explicit synthetic restricted-role fixture capacity.",
            },
          });
        app = await buildApp({
          store,
          mediaService: service,
          nationalPreparationEnabled: false,
          catalog: { list: async () => [place], get: async () => place },
        });
        const accounts = [];
        for (const name of ["owner", "outsider"]) {
          const r = await app.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              name,
              email: name + "@media-pg.test",
              password: "isolated media password fixture",
            },
          });
          expect(r.statusCode, r.body).toBe(201);
          accounts.push({
            id: r.json().user.id,
            session: tokenHash(r.cookies[0].value),
            headers: {
              cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
              "x-csrf-token": r.json().csrfToken,
            },
          });
        }
        const [owner, outsider] = accounts;
        const saved = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(saved.statusCode, saved.body).toBe(201);
        const p = saved.json().project,
          base = `/api/v1/projects/${p.id}/media`;
        const context = await app.inject({
          url: `${base}/context?scenarioId=${p.activeScenarioId}`,
          headers: owner.headers,
        });
        expect(context.statusCode, context.body).toBe(200);
        const c = context.json();
        const posted = await app.inject({
          method: "POST",
          url: `${base}/jobs`,
          headers: owner.headers,
          payload: {
            scenarioId: p.activeScenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            sceneHash: c.sceneHash,
            recipe: c.defaultRecipe,
            idempotencyKey: "media-pg-first-request",
          },
        });
        expect(posted.statusCode, posted.body).toBe(202);
        const job = posted.json().job;
        async function raw(
          pool: pg.Pool,
          purpose: string,
          session: string,
          operation: (client: pg.PoolClient) => Promise<void>,
        ) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              "SELECT set_config('urban.purpose',$1,true),set_config('urban.session_hash',$2,true)",
              [purpose, session],
            );
            await operation(client);
            await client.query("ROLLBACK");
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        }
        await raw(worker, "worker.gis", "", async (client) => {
          expect(
            (await client.query("SELECT id FROM app_media_jobs")).rowCount,
          ).toBe(0);
        });
        await raw(worker, "worker.media", "", async (client) => {
          expect(
            (await client.query("SELECT id FROM app_media_jobs")).rowCount,
          ).toBe(1);
          await expect(
            client.query("SELECT payload FROM app_projects"),
          ).rejects.toThrow(/permission/);
        });
        await raw(web, "web", owner.session, async (client) => {
          await expect(
            client.query(
              "UPDATE app_media_jobs SET header=jsonb_set(header,'{sceneHash}',to_jsonb($1::text)) WHERE id=$2",
              ["e".repeat(64), job.id],
            ),
          ).rejects.toThrow(/immutable|cancellation/);
        });
        await raw(web, "web", outsider.session, async (client) => {
          expect(
            (await client.query("SELECT id FROM app_media_jobs")).rowCount,
          ).toBe(0);
        });
        executor.beforeExecute = async () => {
          await raw(worker, "worker.media", "", async (client) => {
            await expect(
              client.query(
                "UPDATE app_media_jobs SET header=header #- '{input,bytes}' WHERE id=$1",
                [job.id],
              ),
            ).rejects.toThrow(/explicit complete bounded identity/);
          });
          await raw(worker, "worker.media", "", async (client) => {
            await client.query(
              "UPDATE app_native_capacity SET header=jsonb_set(jsonb_set(header,'{slot,status}','\"quarantined\"'),'{revision}',to_jsonb((header->>'revision')::int+1)) WHERE id='nativeCapacity'",
            );
            await expect(
              client.query(
                "UPDATE app_media_jobs SET header=jsonb_set(jsonb_set(header,'{status}','\"completed\"'),'{version}',to_jsonb((header->>'version')::int+1)) WHERE id=$1",
                [job.id],
              ),
            ).rejects.toThrow(/live originally running/);
          });
        };
        await service.runOne();
        const status = await app.inject({
          url: `${base}/jobs/${job.id}`,
          headers: owner.headers,
        });
        expect(status.json().job.status, status.body).toBe("completed");
        const result = await app.inject({
          url: `${base}/jobs/${job.id}/artifacts/output.png`,
          headers: owner.headers,
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(
          (
            await app.inject({
              url: `${base}/jobs/${job.id}/artifacts/output.png`,
              headers: outsider.headers,
            })
          ).statusCode,
        ).toBe(404);
        expect(executor.calls).toBe(1);
        await raw(worker, "worker.media", "", async (client) => {
          await expect(
            client.query(
              "UPDATE app_media_jobs SET header=jsonb_set(header,'{status}','\"queued\"') WHERE id=$1",
              [job.id],
            ),
          ).rejects.toThrow(/immutable|transition/);
        });
        const config = await web.query(
          "SELECT app_security_runtime_configuration() AS c",
        );
        expect(config.rows[0].c.securityVersion).toBe(21);
      } finally {
        await app?.close();
        if (!app) await store.close();
        await worker.end();
        await web.end();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);

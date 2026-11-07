import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import { buildApp } from "./app.js";
import { tokenHash } from "./security.js";
import { fiscalApiFixture } from "./fiscal-test-fixture.js";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "restricted PostgreSQL fiscal authority",
  () => {
    it("retains immutable library/study/public context and denies raw cross-role/version/capture changes", async () => {
      const fixture = await createPostgresSecurityFixture(
          process.env.TEST_DATABASE_URL!,
        ),
        f = fiscalApiFixture();
      const store = new PostgresStore(fixture.webURL, {
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
      });
      await store.initialize();
      const web = new pg.Pool({ connectionString: fixture.webURL, max: 1 }),
        worker = new pg.Pool({ connectionString: fixture.workerURL, max: 1 }),
        authPool = new pg.Pool({ connectionString: fixture.authURL, max: 1 });
      const app = await buildApp({
        store,
        nationalPreparationEnabled: false,
        catalog: { list: async () => [f.place], get: async () => f.place },
      });
      try {
        async function register(email: string) {
          const r = await app.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              name: "Fiscal PG",
              email,
              password: "isolated fiscal test password",
            },
          });
          expect(r.statusCode, r.body).toBe(201);
          return {
            session: tokenHash(r.cookies[0].value),
            headers: {
              cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
              "x-csrf-token": r.json().csrfToken,
            },
          };
        }
        const owner = await register("owner@fiscal-pg.test"),
          outsider = await register("outsider@fiscal-pg.test");
        const saved = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: f.place.id },
        });
        expect(saved.statusCode, saved.body).toBe(201);
        const source = saved.json().project;
        const p = await app.inject({
          method: "POST",
          url: "/api/v1/fiscal-profiles",
          headers: owner.headers,
          payload: {
            profile: f.profile,
            idempotencyKey: "pg-fiscal-profile-first",
          },
        });
        expect(p.statusCode, p.body).toBe(201);
        const request = {
          scenarioId: source.activeScenarioId,
          expectedVersion: 1,
          expectedRevision: 0,
          name: "PG fiscal new study",
          libraryVersionId: p.json().version.id,
          applicabilityNotes:
            "Explicit synthetic profile and source boundary review.",
          idempotencyKey: "pg-fiscal-study-first",
        };
        const created = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${source.id}/fiscal-studies`,
          headers: owner.headers,
          payload: request,
        });
        expect(created.statusCode, created.body).toBe(201);
        const study = created.json().project;
        const replay = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${source.id}/fiscal-studies`,
          headers: owner.headers,
          payload: request,
        });
        expect(replay.statusCode, replay.body).toBe(201);
        expect(replay.json().project.id).toBe(study.id);
        const publish = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${study.id}/publish`,
          headers: owner.headers,
          payload: { scenarioId: study.activeScenarioId, expectedRevision: 0 },
        });
        expect(publish.statusCode, publish.body).toBe(201);
        const pub = await app.inject({
          url: `/api/v1/published/${publish.json().id}`,
        });
        expect(pub.statusCode, pub.body).toBe(200);
        expect(pub.json().fiscalStudy).toEqual(study.fiscalStudy);
        const exported = await app.inject({
          url: `/api/v1/projects/${study.id}/exports?scenarioId=${study.activeScenarioId}&format=fiscal-csv`,
          headers: owner.headers,
        });
        expect(exported.statusCode, exported.body).toBe(200);
        expect(exported.body).toContain(study.fiscalStudy.profileHash);
        async function raw(
          pool: pg.Pool,
          purpose: string,
          session: string,
          fn: (c: pg.PoolClient) => Promise<void>,
        ) {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query(
              "SELECT set_config('urban.purpose',$1,true),set_config('urban.session_hash',$2,true)",
              [purpose, session],
            );
            await fn(c);
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        }
        for (const pool of [worker, authPool])
          await raw(
            pool,
            pool === worker ? "worker.media" : "auth.lookup",
            "",
            async (c) => {
              await expect(
                c.query("SELECT * FROM app_fiscal_profiles"),
              ).rejects.toThrow(/permission/);
            },
          );
        await raw(web, "web", outsider.session, async (c) => {
          expect(
            (await c.query("SELECT id FROM app_fiscal_profiles")).rowCount,
          ).toBe(0);
          expect(
            (await c.query("SELECT id FROM app_fiscal_study_creations"))
              .rowCount,
          ).toBe(0);
        });
        await raw(web, "web", owner.session, async (c) => {
          await expect(
            c.query(
              "UPDATE app_fiscal_profiles SET header=jsonb_set(header,'{name}','\"forged\"')",
            ),
          ).rejects.toThrow(/permission|immutable/);
        });
        await raw(web, "web", owner.session, async (c) => {
          await expect(
            c.query("DELETE FROM app_fiscal_profiles"),
          ).rejects.toThrow(/permission|immutable/);
        });
        await raw(web, "web", owner.session, async (c) => {
          await expect(
            c.query(
              "UPDATE app_projects SET header=jsonb_set(header,'{version}',to_jsonb((header->>'version')::integer+1)),payload=jsonb_set(payload,'{project,fiscalStudy,profile,name}','\"forged\"') WHERE id=$1",
              [study.id],
            ),
          ).rejects.toThrow(/immutable/);
        });
        await raw(web, "web", owner.session, async (c) => {
          await expect(
            c.query(
              "UPDATE app_published SET payload=payload-'fiscalStudy' WHERE id=$1",
              [publish.json().id],
            ),
          ).rejects.toThrow(/immutable|exact/);
        });
        await raw(web, "web", owner.session, async (c) => {
          await expect(
            c.query(
              "INSERT INTO app_fiscal_profiles(id,organization_id,user_id,header,payload) SELECT $1,organization_id,user_id,header||jsonb_build_object('id',$1::text,'idempotencyKey','forged-profile-version','version',9),payload FROM app_fiscal_profiles LIMIT 1",
              [randomUUID()],
            ),
          ).rejects.toThrow(/append|current/);
        });
        await raw(web, "web", owner.session, async (c) => {
          const metadata = {
            version: 1,
            format: "geojson",
            upload: {
              name: "fixture.geojson",
              sha256: "a".repeat(64),
              bytes: 1,
              members: [],
            },
            selection: { layer: "fixture" },
            crs: { source: "OGC:CRS84", axisOrder: "xy", target: "OGC:CRS84" },
            operation: { name: "identity", accuracyMeters: 0 },
            converter: { name: "fixture", version: "1" },
            normalizedSha256: "b".repeat(64),
            recipe: { fiscal: { category: "unrelated source metadata" } },
            exclusions: [],
          };
          const { sourceImportMetadataSchema } = await import(
            "../../../packages/core/src/import-metadata.js"
          );
          sourceImportMetadataSchema.parse(metadata);
          const result = await c.query(
            "UPDATE app_projects SET header=jsonb_set(header,'{version}',to_jsonb((header->>'version')::integer+1)),payload=jsonb_set(payload,'{project,scenarios,1,sources}',(payload->'project'->'scenarios'->1->'sources')||jsonb_build_array($2::jsonb)) WHERE id=$1",
            [
              source.id,
              JSON.stringify({
                id: "unrelated-source",
                name: "Unrelated imported metadata",
                url: "",
                vintage: "test",
                license: "test",
                kind: "user-supplied",
                import: metadata,
              }),
            ],
          );
          expect(result.rowCount).toBe(1);
        });
        for (const path of [
          ["project", "scenarios", "1", "fiscal"],
          ["project", "history"],
          ["project", "undone"],
        ])
          await raw(web, "web", owner.session, async (c) => {
            const fiscal = { version: 1, profileHash: "0".repeat(64) };
            const value =
              path.at(-1) === "fiscal"
                ? fiscal
                : [
                    {
                      before: { fiscal },
                      after: {},
                      command: { type: "scenario.fiscal", fiscal },
                    },
                  ];
            await expect(
              c.query(
                "UPDATE app_projects SET header=jsonb_set(header,'{version}',to_jsonb((header->>'version')::integer+1)),payload=jsonb_set(payload,$2::text[],$3::jsonb) WHERE id=$1",
                [source.id, path, JSON.stringify(value)],
              ),
            ).rejects.toThrow(/Fiscal review belongs/);
          });
        expect(
          (
            await fixture.admin.query(
              "SELECT app_security_runtime_configuration() c",
            )
          ).rows[0].c.securityVersion,
        ).toBe(20);
      } finally {
        await app.close();
        await web.end();
        await worker.end();
        await authPool.end();
        await fixture.close();
      }
    }, 30000);
  },
);

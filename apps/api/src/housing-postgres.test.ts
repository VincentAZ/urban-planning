import { describe, it, expect } from "vitest";
import pg from "pg";
import { createPostgresSecurityFixture } from "./postgres-security-fixture";
import { PostgresStore } from "./postgres-store";
import { housingApiFixture, exerciseHousingApi } from "./housing-test-fixture";
import { housingIncomeLimitPackHash } from "@urban/core";
import { tokenHash } from "./security";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "housing authority under restricted PostgreSQL roles",
  () => {
    it("preserves full HTTP lifecycle and rejects forged sources, history and rights using raw web SQL", async () => {
      const fixture = await createPostgresSecurityFixture(
          process.env.TEST_DATABASE_URL!,
        ),
        store = new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 2,
        });
      let app: Awaited<ReturnType<typeof housingApiFixture>>["app"] | undefined;
      try {
        await store.initialize();
        const f = await housingApiFixture(store, fixture.operatorStore);
        app = f.app;
        const out = await exerciseHousingApi(f);
        expect(
          (
            await fixture.admin.query(
              "SELECT app_security_runtime_configuration() c",
            )
          ).rows[0].c.securityVersion,
        ).toBe(21);
        const web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
        try {
          expect(
            (await web.query("SELECT count(*)::int n FROM app_housing_sources"))
              .rows[0].n,
          ).toBe(1);
          await expect(
            web.query(
              "INSERT INTO app_housing_sources(id,header,payload) VALUES($1,'{}','{}')",
              ["b".repeat(64)],
            ),
          ).rejects.toThrow(/permission|operator/);
          await expect(
            fixture.admin.query("DELETE FROM app_housing_sources"),
          ).rejects.toThrow(/Immutable/);
          const c = await web.connect();
          try {
            await c.query("BEGIN");
            await c.query("SELECT set_config('urban.session_hash',$1,true)", [
              tokenHash(out.owner.cookie.split("=").slice(1).join("=")),
            ]);
            const row = (
              await c.query(
                "SELECT header,payload FROM app_projects WHERE id=$1",
                [out.saved.project.id],
              )
            ).rows[0];
            const altered = structuredClone(f.pack);
            altered.notes.push("Unregistered edited limits source");
            const key = housingIncomeLimitPackHash(altered);
            for (const location of [
              "current",
              "history-before",
              "history-after",
              "history-command",
              "undone-command",
            ]) {
              const payload = structuredClone(row.payload),
                p = payload.project;
              p.housingIncomeLimits[key] = altered;
              let a = p.scenarios[1].affordability;
              if (location !== "current") {
                const [collection, part] = location.split("-");
                if (collection === "undone")
                  p.undone = [structuredClone(p.history[0])];
                if (part === "before")
                  p[collection][0].before.affordability = structuredClone(a);
                a = p[collection][0][part].affordability;
              }
              a.proposalGroups[0].areaHash = key;
              await c.query("SAVEPOINT rejected");
              await expect(
                c.query(
                  "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                  [
                    p.id,
                    { ...row.header, version: row.header.version + 1 },
                    payload,
                  ],
                ),
              ).rejects.toThrow(/operator-registered/);
              await c.query("ROLLBACK TO SAVEPOINT rejected");
            }
            for (const variant of [
              "pack-private",
              "cost-missing",
              "unknown-origin",
              "null-method",
            ]) {
              const payload = structuredClone(row.payload),
                p = payload.project;
              if (variant === "pack-private")
                delete p.housingIncomeLimits[f.areaHash].sources[0].rights;
              if (variant === "cost-missing")
                delete p.scenarios[1].affordability.sources[0].rights;
              if (variant === "unknown-origin")
                p.scenarios[1].affordability.proposalGroups[0].areaOrigin =
                  "verified";
              if (variant === "null-method")
                p.scenarios[1].affordability.methodVersion = null;
              await c.query("SAVEPOINT invalid");
              await expect(
                c.query(
                  "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                  [
                    p.id,
                    { ...row.header, version: row.header.version + 1 },
                    payload,
                  ],
                ),
              ).rejects.toThrow(/housing|Housing/);
              await c.query("ROLLBACK TO SAVEPOINT invalid");
            }
            await c.query("ROLLBACK");
          } finally {
            c.release();
          }
        } finally {
          await web.end();
        }
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    }, 60000);
  },
);

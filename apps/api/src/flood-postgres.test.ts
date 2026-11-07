import { describe, it, expect } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { floodDatasetHash } from "@urban/core";
import { tokenHash } from "./security";
import { createPostgresSecurityFixture } from "./postgres-security-fixture";
import { PostgresStore } from "./postgres-store";
import {
  exerciseFloodApi,
  exerciseFloodMethodApi,
  floodApiFixture,
} from "./flood-test-fixture";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "flood authority with actual restricted PostgreSQL roles",
  () => {
    it("installs immutable operator sources and exercises full saved/public API under restricted roles", async () => {
      const fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
      );
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 2,
      });
      let app: Awaited<ReturnType<typeof floodApiFixture>>["app"] | undefined;
      try {
        await store.initialize();
        const f = await floodApiFixture(store, fixture.operatorStore);
        app = f.app;
        expect(
          (
            await fixture.admin.query(
              "SELECT app_security_runtime_configuration() c",
            )
          ).rows[0].c.securityVersion,
        ).toBe(20);
        const outcome = await exerciseFloodApi(f);
        await exerciseFloodMethodApi(f);
        const web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
        try {
          expect(
            (await web.query("SELECT count(*)::int n FROM app_flood_sources"))
              .rows[0].n,
          ).toBe(1);
          await expect(
            web.query(
              "INSERT INTO app_flood_sources(id,header,payload) VALUES($1,'{}','{}')",
              ["b".repeat(64)],
            ),
          ).rejects.toThrow(/permission|operator/);
          await expect(
            fixture.admin.query(
              'UPDATE app_flood_sources SET header=header||\'{"sourceManifestHash":"bad"}\'',
            ),
          ).rejects.toThrow(/Immutable/);
          const c = await web.connect();
          try {
            await c.query("BEGIN");
            await c.query("SELECT set_config('urban.session_hash',$1,true)", [
              tokenHash(outcome.owner.cookie.split("=").slice(1).join("=")),
            ]);
            const row = (
              await c.query(
                "SELECT header,payload FROM app_projects WHERE id=$1",
                [outcome.saved.project.id],
              )
            ).rows[0];
            expect(row).toBeDefined();
            for (const location of [
              "current",
              "history-before",
              "history-after",
              "history-command",
              "undone-before",
              "undone-after",
              "undone-command",
            ])
              for (const methodVersion of [
                "flood-footprint-999.0.0",
                null,
                17,
              ]) {
                const payload = structuredClone(row.payload),
                  p = payload.project;
                if (location === "current")
                  p.scenarios[1].flood.methodVersion = methodVersion;
                else {
                  const [collection, part] = location.split("-");
                  if (collection === "undone")
                    p.undone = [structuredClone(p.history[0])];
                  const entry = p[collection][0];
                  entry[part].flood = {
                    version: 1,
                    datasetHash: f.datasetHash,
                    origin: "imported",
                    methodVersion,
                  };
                }
                await c.query("SAVEPOINT method");
                await expect(
                  c.query(
                    "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                    [
                      p.id,
                      { ...row.header, version: row.header.version + 1 },
                      payload,
                    ],
                  ),
                ).rejects.toThrow(/Unsupported flood calculation method/);
                await c.query("ROLLBACK TO SAVEPOINT method");
              }
            const altered = structuredClone(f.dataset);
            altered.notes.push("Unregistered caller-authored metadata");
            const forgedHash = await floodDatasetHash(altered);
            for (const location of [
              "current",
              "history-before",
              "history-after",
              "history-command",
              "undone-command",
            ]) {
              const payload = structuredClone(row.payload),
                p = payload.project;
              p.floodDatasets[forgedHash] = altered;
              const ref = {
                version: 1,
                datasetHash: forgedHash,
                origin: "server-catalog",
              };
              if (location === "current") p.scenarios[1].flood = ref;
              if (location === "history-before")
                p.history[0].before.flood = ref;
              if (location === "history-after") p.history[0].after.flood = ref;
              if (location === "history-command")
                p.history[0].command.flood = ref;
              if (location === "undone-command") {
                p.undone = [structuredClone(p.history[0])];
                p.undone[0].command.flood = ref;
              }
              await c.query("SAVEPOINT proof");
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
              await c.query("ROLLBACK TO SAVEPOINT proof");
            }
            const privateRow = (
              await c.query(
                "SELECT header,payload FROM app_projects WHERE id=$1",
                [outcome.privateSaved.project.id],
              )
            ).rows[0];
            const restrictedPack = Object.values(
              privateRow.payload.project.floodDatasets,
            ).find(
              (d: any) => d.sources[0].rights?.publicRedistribution === false,
            ) as import("@urban/core").FloodDataset;
            const stripped = structuredClone(restrictedPack);
            delete stripped.sources[0].rights;
            stripped.sources[0].id = "renamed-raw-source";
            stripped.files.forEach((f) => (f.sourceId = "renamed-raw-source"));
            const strippedHash = await floodDatasetHash(stripped),
              laundered = structuredClone(privateRow.payload);
            laundered.project.floodDatasets[strippedHash] = stripped;
            laundered.project.scenarios[1].flood = {
              version: 1,
              datasetHash: strippedHash,
              origin: "imported",
            };
            laundered.project.scenarios[1].revision++;
            await c.query("SAVEPOINT rights");
            await expect(
              c.query(
                "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                [
                  outcome.privateSaved.project.id,
                  {
                    ...privateRow.header,
                    version: privateRow.header.version + 1,
                    project: {
                      ...privateRow.header.project,
                      scenarios: laundered.project.scenarios.map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        revision: s.revision,
                      })),
                    },
                  },
                  laundered,
                ],
              ),
            ).rejects.toThrow(/permissions cannot be erased/);
            await c.query("ROLLBACK TO SAVEPOINT rights");
            const changed = structuredClone(row.payload);
            changed.project.floodDatasets[f.datasetHash].notes.push(
              "rewritten",
            );
            await c.query("SAVEPOINT immutable");
            await expect(
              c.query(
                "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                [
                  outcome.saved.project.id,
                  { ...row.header, version: row.header.version + 1 },
                  changed,
                ],
              ),
            ).rejects.toThrow(/immutable/);
            await c.query("ROLLBACK TO SAVEPOINT immutable");
            const imported = structuredClone(row.payload);
            imported.project.floodDatasets[forgedHash] = altered;
            imported.project.scenarios[1].flood = {
              version: 1,
              datasetHash: forgedHash,
              origin: "imported",
            };
            expect(
              (
                await c.query(
                  "UPDATE app_projects SET header=$2,payload=$3 WHERE id=$1",
                  [
                    outcome.saved.project.id,
                    { ...row.header, version: row.header.version + 1 },
                    imported,
                  ],
                )
              ).rowCount,
            ).toBe(1);
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        } finally {
          await web.end();
        }
        // Replay the appended migration over an isolated version16 schema containing
        // both legacy/current snapshots. No source or snapshot payload is rewritten.
        const upgrade = await fixture.admin.connect();
        try {
          await upgrade.query("BEGIN");
          const before = (
            await upgrade.query(
              "SELECT (SELECT jsonb_agg(payload ORDER BY id) FROM app_projects) projects,(SELECT jsonb_agg(payload ORDER BY id) FROM app_published) published,(SELECT jsonb_agg(payload ORDER BY id) FROM app_flood_sources) sources",
            )
          ).rows[0];
          await upgrade.query(
            "DROP TRIGGER security_flood_method ON app_projects; DROP TRIGGER security_flood_method ON app_published; DROP FUNCTION app_security_flood_method_capture(); DROP FUNCTION app_security_flood_method_reference(jsonb); DELETE FROM app_schema_migrations WHERE version=17",
          );
          const quote = `"${fixture.schema.replaceAll('"', '""')}"`;
          await upgrade.query(
            (
              await readFile(
                new URL(
                  "../migrations/016-flood-security.sql",
                  import.meta.url,
                ),
                "utf8",
              )
            ).replaceAll("__SCHEMA__", quote),
          );
          expect(
            (
              await upgrade.query(
                "SELECT app_security_runtime_configuration() c",
              )
            ).rows[0].c.securityVersion,
          ).toBe(16);
          await upgrade.query(
            (
              await readFile(
                new URL(
                  "../migrations/017-flood-method-security.sql",
                  import.meta.url,
                ),
                "utf8",
              )
            ).replaceAll("__SCHEMA__", quote),
          );
          expect(
            (
              await upgrade.query(
                "SELECT app_security_runtime_configuration() c",
              )
            ).rows[0].c.securityVersion,
          ).toBe(17);
          for (const ref of [
            {},
            { methodVersion: "flood-footprint-1.0.0" },
            { methodVersion: "flood-footprint-1.1.0" },
          ])
            expect(
              (
                await upgrade.query(
                  "SELECT app_security_flood_method_reference($1::jsonb) valid",
                  [ref],
                )
              ).rows[0].valid,
            ).toBe(true);
          for (const methodVersion of [null, 17, {}, "unsupported"])
            expect(
              (
                await upgrade.query(
                  "SELECT app_security_flood_method_reference($1::jsonb) IS TRUE valid",
                  [{ methodVersion }],
                )
              ).rows[0].valid,
            ).toBe(false);
          const after = (
            await upgrade.query(
              "SELECT (SELECT jsonb_agg(payload ORDER BY id) FROM app_projects) projects,(SELECT jsonb_agg(payload ORDER BY id) FROM app_published) published,(SELECT jsonb_agg(payload ORDER BY id) FROM app_flood_sources) sources",
            )
          ).rows[0];
          expect(after).toEqual(before);
        } finally {
          await upgrade.query("ROLLBACK");
          upgrade.release();
        }
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    }, 60000);
  },
);

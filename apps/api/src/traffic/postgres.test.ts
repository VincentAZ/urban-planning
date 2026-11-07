import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  trafficContentHash,
  type Project,
  type TrafficScenario,
} from "@urban/core";
import { trafficScenarioFixture } from "../../../../tests/fixtures/traffic";
import { createPostgresSecurityFixture } from "../postgres-security-fixture";
import { PostgresStore } from "../postgres-store";
import { emptyState } from "../store";
import { buildApp } from "../app";
import pg from "pg";
import { tokenHash } from "../security";

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)(
  "format9 traffic through restricted PostgreSQL roles",
  () => {
    it("retains imported summaries, command history and undo across a new connection; denies private publication and preserves explicit public capture", async () => {
      const sample = await trafficScenarioFixture(),
        fixture = await createPostgresSecurityFixture(connection!, {
          state: emptyState(),
        }),
        runtime = () =>
          new PostgresStore(fixture.webURL, {
            mode: "runtime",
            authConnectionString: fixture.authURL,
            workerConnectionString: fixture.workerURL,
            poolMax: 1,
          });
      let store = runtime(),
        app: FastifyInstance | undefined;
      const options = {
        catalog: {
          list: async () => [sample.place],
          get: async () => structuredClone(sample.place),
        },
        nationalPreparationEnabled: false,
      };
      try {
        await store.initialize();
        app = await buildApp({ ...options, store });
        const registration = await app.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          payload: {
            name: "Traffic PG fixture",
            email: "traffic-pg@example.test",
            password: "isolated traffic postgres fixture password",
          },
        });
        expect(registration.statusCode, registration.body).toBe(201);
        const headers = {
          cookie: `${registration.cookies[0].name}=${registration.cookies[0].value}`,
          "x-csrf-token": registration.json().csrfToken,
        };
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers,
          payload: { placeId: sample.place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const path = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const imported: TrafficScenario = structuredClone(sample.traffic);
        imported.origin = "imported";
        imported.capture.sources.forEach(
          (source) =>
            (source.rights = {
              version: 1,
              privateUse: true,
              cache: true,
              analyze: true,
              privateDisplay: true,
              export: true,
              historicalRetention: true,
              publicRedistribution: false,
              declaredBy: "fixture-owner",
              declaredAt: "2026-11-06T00:00:00Z",
            }),
        );
        imported.captureHash = await trafficContentHash(imported.capture);
        const command = async (traffic: TrafficScenario | null) =>
          app!.inject({
            method: "POST",
            url: `${path}/scenarios/${scenarioId}/commands`,
            headers,
            payload: {
              expectedVersion: saved.version,
              expectedRevision: saved.project.scenarios.find(
                (s) => s.id === scenarioId,
              )!.revision,
              command: { type: "scenario.traffic", traffic },
            },
          });
        const adopted = await command(imported);
        expect(adopted.statusCode, adopted.body).toBe(200);
        saved = adopted.json();
        expect(saved.project.schemaVersion).toBe(9);
        expect(saved.project.scenarios[1].traffic).toEqual(imported);
        expect(saved.project.history[0].command.type).toBe("scenario.traffic");
        const stored = await fixture.admin.query(
          "SELECT payload->'project' AS project FROM app_projects WHERE id=$1",
          [saved.project.id],
        );
        expect(stored.rows[0].project.scenarios[1].traffic).toEqual(imported);
        expect(stored.rows[0].project.schemaVersion).toBe(9);
        const archived = await fixture.admin.query(
          "SELECT payload->'project' AS project FROM app_project_versions WHERE project_id=$1 AND version=2",
          [saved.project.id],
        );
        expect(archived.rows).toHaveLength(1);
        expect(archived.rows[0].project.history[0].command.traffic).toEqual(
          imported,
        );
        const removal = await command(null);
        expect(removal.statusCode, removal.body).toBe(200);
        saved = removal.json();
        expect(saved.project.scenarios[1].traffic).toBeUndefined();
        expect(saved.project.schemaVersion).toBe(9);
        // Persist a genuine undo state: prior content restored, monotonic revision, removal retained in undone.
        const undo = structuredClone(saved.project),
          last = undo.history.pop()!,
          current = undo.scenarios.find((s) => s.id === scenarioId)!;
        undo.undone = [last];
        undo.scenarios = undo.scenarios.map((s) =>
          s.id === scenarioId
            ? {
                ...structuredClone(last.before),
                revision: current.revision + 1,
                updatedAt: new Date().toISOString(),
              }
            : s,
        );
        const put = await app.inject({
          method: "PUT",
          url: path,
          headers,
          payload: {
            expectedVersion: saved.version,
            project: undo,
            baselineHash: imported.binding.baselineHash,
          },
        });
        expect(put.statusCode, put.body).toBe(200);
        saved = put.json();
        const beforeRestart = structuredClone(saved);
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({ url: path, headers });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(beforeRestart.project);
        expect(reopened.json().version).toBe(beforeRestart.version);
        saved = reopened.json();
        expect(saved.project.undone[0].before.traffic).toEqual(imported);
        expect(saved.project.history[0].command.type).toBe("scenario.traffic");
        const publish = () =>
          app!.inject({
            method: "POST",
            url: `${path}/publish`,
            headers,
            payload: {
              scenarioId,
              expectedVersion: saved.version,
              expectedRevision: saved.project.scenarios.find(
                (s) => s.id === scenarioId,
              )!.revision,
            },
          });
        const denied = await publish();
        expect(denied.statusCode, denied.body).toBe(422);
        expect(denied.json().error.code).toBe("TRAFFIC_PUBLICATION_RESTRICTED");
        expect(
          (
            await fixture.admin.query(
              "SELECT count(*)::int count FROM app_published WHERE project_id=$1",
              [saved.project.id],
            )
          ).rows[0].count,
        ).toBe(0);
        const allowed = structuredClone(imported);
        allowed.capture.sources.forEach((s) => {
          s.rights!.publicRedistribution = true;
        });
        allowed.captureHash = await trafficContentHash(allowed.capture);
        const permission = await command(allowed);
        expect(permission.statusCode, permission.body).toBe(200);
        saved = permission.json();
        const published = await publish();
        expect(published.statusCode, published.body).toBe(201);
        const publicResult = await app.inject({
          url: `/api/v1/published/${published.json().id}`,
        });
        expect(publicResult.statusCode, publicResult.body).toBe(200);
        expect(publicResult.json().scenario.traffic).toEqual(allowed);
        expect(
          publicResult.json().scenario.traffic.capture.comparison.baseline
            .meanTravelTimeSeconds,
        ).toBe(40);
        expect(publicResult.json().scenario.traffic.origin).toBe("imported");
        const publication = await fixture.admin.query(
          "SELECT payload->'scenario'->'traffic' AS traffic FROM app_published WHERE id=$1",
          [published.json().id],
        );
        expect(publication.rows[0].traffic).toEqual(allowed);
        // Bypass the HTTP/core validators using the actual restricted LOGIN: SQL must still fail closed.
        const raw = await fixture.admin.query(
          "SELECT header,payload FROM app_projects WHERE id=$1",
          [saved.project.id],
        );
        const client = new pg.Client({ connectionString: fixture.webURL });
        await client.connect();
        try {
          for (const location of [
            "current",
            "history-before",
            "history-after",
            "history-command",
            "undone-before",
            "undone-after",
            "undone-command",
          ]) {
            const row = structuredClone(raw.rows[0]),
              p = row.payload.project as Project,
              forged = {
                ...structuredClone(allowed),
                origin: "server-run" as const,
              };
            if (location === "current") p.scenarios[1].traffic = forged;
            else {
              const [collection, part] = location.split("-") as [
                "history" | "undone",
                "before" | "after" | "command",
              ];
              if (!p[collection].length)
                p[collection] = [structuredClone(p.history[0])];
              if (part === "command")
                p[collection][0].command = {
                  type: "scenario.traffic",
                  traffic: forged,
                };
              else p[collection][0][part].traffic = forged;
            }
            row.header.version++;
            p.scenarios[1].revision++;
            row.header.project.scenarios[1].revision = p.scenarios[1].revision;
            await client.query("BEGIN");
            try {
              await client.query(
                "SELECT set_config('urban.session_hash',$1,true),set_config('urban.owner','true',true),set_config('urban.purpose','operator',true)",
                [tokenHash(registration.cookies[0].value)],
              );
              await expect(
                client.query(
                  "UPDATE app_projects SET header=$1::jsonb,payload=$2::jsonb WHERE id=$3",
                  [
                    JSON.stringify(row.header),
                    JSON.stringify(row.payload),
                    saved.project.id,
                  ],
                ),
              ).rejects.toMatchObject({
                code: "42501",
                message: expect.stringContaining(
                  "Traffic server-run admission",
                ),
              });
            } finally {
              await client.query("ROLLBACK");
            }
          }
          await client.query("BEGIN");
          try {
            await client.query(
              "SELECT set_config('urban.session_hash',$1,true)",
              [tokenHash(registration.cookies[0].value)],
            );
            await expect(
              client.query(
                "INSERT INTO app_published(id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,payload,baseline_hash) SELECT $1,ordinal+1000,organization_id,user_id,project_id,$1,email,jsonb_set(header,'{id}',to_jsonb($1::text)),jsonb_set(payload,'{scenario,traffic,origin}','\"server-run\"'::jsonb),baseline_hash FROM app_published WHERE id=$2",
                ["forged-traffic-publication", published.json().id],
              ),
            ).rejects.toMatchObject({
              code: "42501",
              message: expect.stringContaining("Traffic server-run admission"),
            });
          } finally {
            await client.query("ROLLBACK");
          }
        } finally {
          await client.end();
        }
        // Only the real operator can preserve a trusted migration payload; roll back this proof.
        await fixture.admin.query("BEGIN");
        try {
          await expect(
            fixture.admin.query(
              "UPDATE app_projects SET payload=jsonb_set(payload,'{project,scenarios,1,traffic,origin}','\"server-run\"'::jsonb) WHERE id=$1",
              [saved.project.id],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });
        } finally {
          await fixture.admin.query("ROLLBACK");
        }
        const stillSaved = await app.inject({ url: path, headers });
        expect(stillSaved.json().project).toEqual(saved.project);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    }, 30000);
  },
);
